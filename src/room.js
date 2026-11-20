'use strict';

const { WORDS, HOLIDAY_WORDS } = require('./words');

// Seasonal theme switch. 'christmas' (default) adds the festive look and puts
// at least one holiday word in every word choice; 'off' turns both off.
const THEME = (process.env.HOLIDAY_THEME || 'christmas').toLowerCase() === 'off' ? 'off' : 'christmas';

const PHASE = Object.freeze({
  LOBBY: 'lobby',
  CHOOSING: 'choosing',
  DRAWING: 'drawing',
  TURN_END: 'turnEnd',
  GAME_OVER: 'gameOver',
});

const TIMING = {
  choose: 15000,
  turnEnd: 6000,
  gameOver: 15000,
  autoStart: 15000,
};

const MAX_OPS = 25000; // per turn, protects server memory
const MAX_OPS_PER_BATCH = 500;
const CHAT_WINDOW_MS = 3000;
const CHAT_MAX_IN_WINDOW = 6;
const DRAWER_POINTS_PER_GUESS = 60;
// TOA Amplify (chaos mode): after a turn everyone guessed, the first
// AMPLIFY_SLOTS correct guessers next turn score AMPLIFY_MULTIPLIER x points.
const VOICE_STATUSES = ['unknown', 'checking', 'ready', 'blocked', 'unsupported'];
const AMPLIFY_SLOTS = 3;
const AMPLIFY_MULTIPLIER = 2;

const AVATAR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#8b5cf6', '#ec4899', '#64748b', '#0ea5e9',
];

const DRAW_TIMES = [30, 45, 60]; // seconds; the only draw times hosts can pick
const UNLIMITED = 0; // maxPlayers value meaning "no player cap"

const EVERYONE = 0; // drawersPerRound value meaning "every player draws each round"

const SETTING_LIMITS = {
  rounds: [1, 10],
  drawTime: [30, 60],
  maxPlayers: [2, 16],
  wordCount: [1, 5],
  hints: [0, 5],
};

const DEFAULT_SETTINGS = {
  rounds: 3,
  drawTime: 60,
  maxPlayers: 10,
  wordCount: 3,
  hints: 2,
  customWords: [],
  customOnly: false,
  chaos: false, // voice-only answers
  drawersPerRound: 0, // 0 = everyone draws each round; N = N random drawers per round
};

const HEX = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Edit distance where swapping two neighbouring letters counts as one edit.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function isClose(guess, target) {
  if (target.length < 4 || Math.abs(guess.length - target.length) > 1) return false;
  return editDistance(guess, target) === 1;
}

// True when a message gives away the answer: the word itself, the word with
// spaces removed, or a one-letter-off spelling of it anywhere in the text.
function revealsWord(text, word) {
  const msg = normalize(text);
  const target = normalize(word);
  if (!msg || !target) return false;
  if (msg.includes(target) || msg.replace(/ /g, '').includes(target.replace(/ /g, ''))) return true;
  const tokens = msg.split(' ');
  const size = target.split(' ').length;
  for (let i = 0; i + size <= tokens.length; i++) {
    if (isClose(tokens.slice(i, i + size).join(' '), target)) return true;
  }
  return false;
}

// True when any spoken alternative contains the answer as whole words, so
// "is it a hot dog" and "hotdog" match "hot dog" but "pineapple" does not
// match "apple". A trailing "s" (plural) is accepted.
function voiceMatches(alternatives, word) {
  const target = normalize(word);
  if (!target) return false;
  const joined = target.replace(/ /g, '');
  const span = target.split(' ').length + 1;
  return alternatives.some((alt) => {
    const tokens = normalize(alt).split(' ').filter(Boolean);
    for (let size = 1; size <= span; size++) {
      for (let i = 0; i + size <= tokens.length; i++) {
        const words = tokens.slice(i, i + size);
        const phrase = words.join(' ');
        const glued = words.join('');
        if (phrase === target || glued === joined || phrase === `${target}s` || glued === `${joined}s`) return true;
      }
    }
    return false;
  });
}

function clampInt(value, [min, max], fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const isUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -0.1 && v <= 1.1;
const round4 = (v) => Math.round(v * 10000) / 10000;

// Validates a single drawing operation sent by the drawer.
function cleanOp(op) {
  if (!op || typeof op !== 'object') return null;
  const g = Number(op.g);
  if (!Number.isInteger(g) || g < 0 || !HEX.test(op.c)) return null;
  if (op.t === 'l') {
    if (![op.x0, op.y0, op.x1, op.y1].every(isUnit)) return null;
    return {
      t: 'l', g, c: op.c, w: clampInt(op.w, [1, 80], 6),
      x0: round4(op.x0), y0: round4(op.y0), x1: round4(op.x1), y1: round4(op.y1),
    };
  }
  if (op.t === 'f') {
    if (![op.x, op.y].every(isUnit)) return null;
    return { t: 'f', g, c: op.c, x: round4(op.x), y: round4(op.y) };
  }
  return null;
}

function cleanText(raw, max) {
  return String(raw ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
}

class Room {
  constructor(io, code, { isPublic = false, onEmpty = () => {} } = {}) {
    this.io = io;
    this.code = code;
    this.isPublic = isPublic;
    this.onEmpty = onEmpty;

    this.players = new Map();
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS, customWords: [] };
    this.colorIndex = 0;

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.queue = [];
    this.drawerId = null;
    this.word = null;
    this.choices = [];
    this.ops = [];
    this.revealed = new Set();
    this.hintTimes = [];
    this.phaseEndsAt = 0;
    this.turnGains = {};
    this.turnBoosted = new Set();
    this.guessOrder = 0;
    this.drawCounts = new Map(); // id -> turns drawn this game
    this.turnInRound = 0;
    this.turnsThisRound = 0;
    this.amplify = false; // this turn is a TOA Amplify turn
    this.amplifyNext = false; // the next turn will be one
    this.usedWords = new Set();
    this.lastResult = null;
    this.ranking = null;

    this.timer = null;
    this.ticker = null;
  }

  // ---------- helpers ----------

  emitAll(event, payload) {
    this.io.to(this.code).emit(event, payload);
  }

  system(text, kind = 'system') {
    this.emitAll('chat:msg', { kind, text });
  }

  clearTimers() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
  }

  schedule(ms, fn) {
    clearTimeout(this.timer);
    this.phaseEndsAt = Date.now() + ms;
    this.timer = setTimeout(fn, ms);
  }

  isFull() {
    const max = this.settings.maxPlayers;
    return max !== UNLIMITED && this.players.size >= max;
  }

  isPlaying() {
    return this.phase === PHASE.CHOOSING || this.phase === PHASE.DRAWING || this.phase === PHASE.TURN_END;
  }

  // ---------- membership ----------

  addPlayer(socket, name) {
    if (this.isFull()) {
      return { ok: false, error: 'That room is full.' };
    }
    const player = {
      id: socket.id,
      name,
      score: 0,
      color: AVATAR_COLORS[this.colorIndex++ % AVATAR_COLORS.length],
      guessed: false,
      chatTimes: [],
      voice: 'unknown', // lobby mic check result, see setVoiceStatus
    };
    this.players.set(socket.id, player);
    socket.join(this.code);
    if (!this.hostId) this.hostId = socket.id;

    // Late joiners still get a turn this round.
    // With a drawer limit, they wait to be picked in a later round instead.
    if (this.isPlaying() && this.settings.drawersPerRound === EVERYONE) this.queue.push(socket.id);

    this.system(`${name} joined the room.`);
    if (this.phase === PHASE.DRAWING) socket.emit('canvas:sync', this.ops);
    this.maybeAutoStart();
    this.broadcastState();
    return { ok: true };
  }

  removePlayer(id, { silent = false } = {}) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.queue = this.queue.filter((q) => q !== id);

    if (this.players.size === 0) {
      this.clearTimers();
      this.onEmpty(this);
      return;
    }

    if (!silent) this.system(`${player.name} left the room.`, 'danger');
    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value;
      this.system(`${this.players.get(this.hostId).name} is now the host.`);
    }

    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.GAME_OVER && this.players.size < 2) {
      this.system('Not enough players to continue. Back to the lobby.', 'danger');
      this.toLobby();
      return;
    }
    if (this.phase === PHASE.LOBBY && this.players.size < 2) this.cancelAutoStart();

    if (this.drawerId === id && (this.phase === PHASE.CHOOSING || this.phase === PHASE.DRAWING)) {
      this.endTurn('drawerLeft');
      return;
    }
    if (this.phase === PHASE.DRAWING && this.everyoneGuessed()) {
      this.endTurn();
      return;
    }
    this.broadcastState();
  }

  kick(byId, targetId) {
    if (byId !== this.hostId || byId === targetId || !this.players.has(targetId)) return;
    const target = this.io.sockets.sockets.get(targetId);
    const name = this.players.get(targetId).name;
    if (target) {
      target.data.roomCode = null;
      target.leave(this.code);
      target.emit('kicked');
    }
    this.system(`${name} was removed by the host.`, 'danger');
    this.removePlayer(targetId, { silent: true });
  }

  // ---------- settings / lifecycle ----------

  updateSettings(byId, input) {
    if (byId !== this.hostId || this.phase !== PHASE.LOBBY || !input || typeof input !== 'object') return;
    const s = this.settings;
    const wantsUnlimited = 'maxPlayers' in input
      && (input.maxPlayers === UNLIMITED || String(input.maxPlayers).toLowerCase() === 'unlimited' || Number(input.maxPlayers) === UNLIMITED);
    for (const key of Object.keys(SETTING_LIMITS)) {
      if (key === 'maxPlayers' && wantsUnlimited) continue;
      if (key in input) s[key] = clampInt(input[key], SETTING_LIMITS[key], s[key]);
    }
    s.drawTime = DRAW_TIMES.reduce((best, t) => (Math.abs(t - s.drawTime) < Math.abs(best - s.drawTime) ? t : best));
    if ('drawersPerRound' in input) {
      const n = Math.round(Number(input.drawersPerRound));
      // 0 = everyone draws each round; otherwise 1-50 randomly picked drawers.
      s.drawersPerRound = n === EVERYONE ? EVERYONE : clampInt(n, [1, 50], s.drawersPerRound);
    }
    if (wantsUnlimited) s.maxPlayers = UNLIMITED;
    // A cap can never go below the number of players already in the room.
    else if (s.maxPlayers !== UNLIMITED) s.maxPlayers = Math.max(s.maxPlayers, this.players.size);
    if ('customWords' in input) {
      const raw = Array.isArray(input.customWords) ? input.customWords.join(',') : String(input.customWords ?? '');
      s.customWords = [...new Set(
        raw.split(/[,\n]/).map((w) => cleanText(w, 30).replace(/\s+/g, ' ')).filter((w) => normalize(w).length > 0),
      )].slice(0, 500);
    }
    if ('customOnly' in input) s.customOnly = Boolean(input.customOnly);
    if ('chaos' in input && !this.isPublic) s.chaos = Boolean(input.chaos);
    this.broadcastState();
  }

  maybeAutoStart() {
    if (!this.isPublic || this.phase !== PHASE.LOBBY || this.players.size < 2 || this.timer) return;
    this.schedule(TIMING.autoStart, () => {
      this.timer = null;
      if (this.phase === PHASE.LOBBY && this.players.size >= 2) this.startGame(this.hostId);
    });
  }

  cancelAutoStart() {
    if (this.phase !== PHASE.LOBBY) return;
    this.clearTimers();
    this.phaseEndsAt = 0;
  }

  startGame(byId) {
    if (byId !== this.hostId) return;
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.GAME_OVER) return;
    if (this.players.size < 2) return;
    this.clearTimers();
    for (const p of this.players.values()) p.score = 0;
    this.round = 0;
    this.usedWords.clear();
    this.ranking = null;
    this.amplify = false;
    this.amplifyNext = false;
    this.drawCounts = new Map();
    this.system('Game started. Good luck!', 'success');
    this.nextRound();
  }

  nextRound() {
    this.round++;
    if (this.round > this.settings.rounds) {
      this.gameOver();
      return;
    }
    this.queue = this.pickDrawers();
    this.turnsThisRound = this.queue.length;
    this.turnInRound = 0;
    const limited = this.settings.drawersPerRound !== EVERYONE && this.queue.length < this.players.size;
    const names = this.queue.map((id) => this.players.get(id).name);
    this.system(limited
      ? `Round ${this.round} of ${this.settings.rounds}. Drawing this round: ${names.join(', ')}.`
      : `Round ${this.round} of ${this.settings.rounds}`, 'info');
    this.nextTurn();
  }

  // Random drawer order for a round. With a drawer limit, players who have
  // drawn the fewest times this game go first, so everyone gets a turn before
  // anyone draws twice; ties are broken at random.
  pickDrawers() {
    const ids = shuffle([...this.players.keys()]);
    const limit = this.settings.drawersPerRound;
    if (limit === EVERYONE || limit >= ids.length) return ids;
    const count = (id) => this.drawCounts.get(id) || 0;
    const chosen = ids.sort((a, b) => count(a) - count(b)).slice(0, limit);
    return shuffle(chosen);
  }

  nextTurn() {
    this.clearTimers();
    while (this.queue.length) {
      const id = this.queue.shift();
      if (this.players.has(id)) {
        this.startChoosing(id);
        return;
      }
    }
    this.nextRound();
  }

  pickChoices() {
    const { customWords, customOnly, wordCount } = this.settings;
    const onlyCustom = customOnly && customWords.length >= wordCount;
    const unused = (list) => list.filter((w) => !this.usedWords.has(w.toLowerCase()));
    const seasonal = THEME === 'christmas' ? HOLIDAY_WORDS : [];
    let pool = onlyCustom ? customWords : [...WORDS, ...seasonal, ...customWords];
    if (unused(pool).length >= wordCount) pool = unused(pool);
    if (THEME !== 'christmas' || onlyCustom) return shuffle(pool).slice(0, wordCount);

    // Holiday theme: guarantee one festive word in every set of choices.
    const festive = unused(HOLIDAY_WORDS).length ? unused(HOLIDAY_WORDS) : HOLIDAY_WORDS;
    const pick = festive[Math.floor(Math.random() * festive.length)];
    const rest = shuffle(pool.filter((w) => w !== pick)).slice(0, wordCount - 1);
    return shuffle([pick, ...rest]);
  }

  startChoosing(drawerId) {
    this.phase = PHASE.CHOOSING;
    this.drawerId = drawerId;
    this.drawCounts.set(drawerId, (this.drawCounts.get(drawerId) || 0) + 1);
    this.turnInRound++;
    this.word = null;
    this.ops = [];
    this.turnGains = {};
    this.turnBoosted = new Set();
    this.guessOrder = 0;
    this.revealed = new Set();
    this.lastResult = null;
    for (const p of this.players.values()) p.guessed = false;
    // TOA Amplify (chaos mode only): earned by a turn everyone guessed.
    this.amplify = Boolean(this.settings.chaos && this.amplifyNext);
    this.amplifyNext = false;
    if (this.amplify) {
      this.system(`TOA Amplify turn! The first ${AMPLIFY_SLOTS} correct guesses score ${AMPLIFY_MULTIPLIER}x points.`, 'amplify');
    }
    this.choices = this.pickChoices();
    this.emitAll('canvas:sync', []);
    this.schedule(TIMING.choose, () => this.chooseWord(drawerId, Math.floor(Math.random() * this.choices.length)));
    this.broadcastState();
  }

  chooseWord(byId, index) {
    if (this.phase !== PHASE.CHOOSING || byId !== this.drawerId) return;
    const i = Number.isInteger(index) && index >= 0 && index < this.choices.length ? index : 0;
    this.word = this.choices[i];
    this.usedWords.add(this.word.toLowerCase());
    this.phase = PHASE.DRAWING;

    const total = this.settings.drawTime * 1000;
    const start = Date.now();
    const letters = this.letterIndexes().length;
    const hints = Math.min(this.settings.hints, Math.max(0, letters - 1));
    this.hintTimes = Array.from({ length: hints }, (_, k) => start + (total * (k + 1)) / (hints + 1));

    this.schedule(total, () => this.endTurn());
    this.ticker = setInterval(() => this.tick(), 1000);
    this.system(`${this.players.get(byId).name} is drawing now!`, 'info');
    this.broadcastState();
  }

  letterIndexes() {
    const out = [];
    [...(this.word || '')].forEach((ch, i) => {
      if (/[a-z0-9]/i.test(ch)) out.push(i);
    });
    return out;
  }

  tick() {
    let changed = false;
    while (this.hintTimes.length && this.hintTimes[0] <= Date.now()) {
      this.hintTimes.shift();
      const hidden = this.letterIndexes().filter((i) => !this.revealed.has(i));
      if (hidden.length > 1) {
        this.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
        changed = true;
      }
    }
    if (changed) this.broadcastState();
  }

  maskedWord() {
    if (!this.word) return null;
    return [...this.word].map((ch, i) => (/[a-z0-9]/i.test(ch) && !this.revealed.has(i) ? '_' : ch));
  }

  everyoneGuessed() {
    const guessers = [...this.players.values()].filter((p) => p.id !== this.drawerId);
    return guessers.length > 0 && guessers.every((p) => p.guessed);
  }

  endTurn(reason = 'time') {
    if (this.phase !== PHASE.CHOOSING && this.phase !== PHASE.DRAWING) return;
    this.clearTimers();
    const drawer = this.players.get(this.drawerId);
    const allGuessed = this.phase === PHASE.DRAWING && this.everyoneGuessed();
    const finalReason = reason === 'drawerLeft' ? 'drawerLeft' : allGuessed ? 'allGuessed' : 'time';
    // Everyone guessed this turn in a chaos room: the next turn is a TOA Amplify turn.
    this.amplifyNext = Boolean(this.settings.chaos && finalReason === 'allGuessed');
    this.lastResult = {
      word: this.word,
      drawerName: drawer ? drawer.name : 'The drawer',
      reason: finalReason,
      amplified: this.amplify,
      amplifyNext: this.amplifyNext,
      gains: [...this.players.values()]
        .map((p) => ({
          id: p.id, name: p.name, color: p.color, gain: this.turnGains[p.id] || 0, boosted: this.turnBoosted.has(p.id),
        }))
        .sort((a, b) => b.gain - a.gain),
    };
    if (this.word) this.system(`The word was "${this.word}".`, 'info');
    if (this.amplifyNext) this.system('Everyone got it! Next turn is a TOA Amplify turn.', 'amplify');
    this.phase = PHASE.TURN_END;
    this.schedule(TIMING.turnEnd, () => this.nextTurn());
    this.broadcastState();
  }

  gameOver() {
    this.clearTimers();
    this.phase = PHASE.GAME_OVER;
    this.drawerId = null;
    this.word = null;
    // Standard competition ranking: equal scores share a rank (1, 1, 3, ...).
    this.ranking = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score)
      .map((p, i, list) => ({ ...p, rank: i > 0 && p.score === list[i - 1].score ? null : i + 1 }));
    this.ranking.forEach((p, i) => { if (p.rank === null) p.rank = this.ranking[i - 1].rank; });
    if (this.ranking[0]) this.system(`${this.ranking[0].name} wins with ${this.ranking[0].score} points!`, 'success');
    this.schedule(TIMING.gameOver, () => this.toLobby());
    this.broadcastState();
  }

  toLobby() {
    this.clearTimers();
    this.phase = PHASE.LOBBY;
    this.phaseEndsAt = 0;
    this.round = 0;
    this.queue = [];
    this.drawerId = null;
    this.word = null;
    this.ops = [];
    this.lastResult = null;
    this.amplify = false;
    this.amplifyNext = false;
    for (const p of this.players.values()) p.guessed = false;
    this.emitAll('canvas:sync', []);
    this.maybeAutoStart();
    this.broadcastState();
  }

  // ---------- drawing ----------

  handleDraw(socket, ops) {
    if (this.phase !== PHASE.DRAWING || socket.id !== this.drawerId || !Array.isArray(ops)) return;
    const clean = ops.slice(0, MAX_OPS_PER_BATCH).map(cleanOp).filter(Boolean);
    if (!clean.length || this.ops.length + clean.length > MAX_OPS) return;
    this.ops.push(...clean);
    socket.to(this.code).emit('draw', clean);
  }

  undo(byId) {
    if (this.phase !== PHASE.DRAWING || byId !== this.drawerId || !this.ops.length) return;
    const lastGroup = this.ops[this.ops.length - 1].g;
    this.ops = this.ops.filter((op) => op.g !== lastGroup);
    this.emitAll('canvas:sync', this.ops);
  }

  clearCanvas(byId) {
    if (this.phase !== PHASE.DRAWING || byId !== this.drawerId) return;
    this.ops = [];
    this.emitAll('canvas:sync', []);
  }

  // ---------- chat & guessing ----------

  // A player's own report of their lobby mic check, shown to everyone so the
  // host can see who is ready to answer by voice before starting.
  setVoiceStatus(id, status) {
    const p = this.players.get(id);
    if (!p || !VOICE_STATUSES.includes(status) || p.voice === status) return;
    p.voice = status;
    this.broadcastState();
  }

  // Returns the player if they may send a message now, otherwise null.
  allowMessage(socket) {
    const p = this.players.get(socket.id);
    if (!p) return null;
    const now = Date.now();
    p.chatTimes = p.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (p.chatTimes.length >= CHAT_MAX_IN_WINDOW) {
      socket.emit('chat:msg', { kind: 'danger', text: 'Slow down a little.' });
      return null;
    }
    p.chatTimes.push(now);
    return p;
  }

  // An active guesser is a non-drawer who has not guessed yet, mid-turn.
  isActiveGuesser(p) {
    return this.phase === PHASE.DRAWING && Boolean(this.word) && p.id !== this.drawerId && !p.guessed;
  }

  handleChat(socket, raw) {
    const p = this.allowMessage(socket);
    if (!p) return;

    const text = cleanText(raw, 120);
    if (!text) return;
    const msg = { kind: 'chat', id: p.id, name: p.name, color: p.color, text };

    if (this.phase === PHASE.DRAWING && this.word) {
      // The drawer and players who already guessed chat publicly, unless the
      // message gives away the answer. Those stay with people who know the word.
      if (p.id === this.drawerId || p.guessed) {
        if (!revealsWord(text, this.word)) {
          this.emitAll('chat:msg', msg);
          return;
        }
        msg.kind = 'insider';
        for (const q of this.players.values()) {
          if (q.id === this.drawerId || q.guessed) this.io.to(q.id).emit('chat:msg', msg);
        }
        socket.emit('chat:msg', { kind: 'info', text: 'That message contains the answer, so only players who know the word can see it.' });
        return;
      }
      // Chaos mode: typed messages never count as answers, and typed messages
      // that contain the answer are not shown to anyone.
      if (this.settings.chaos) {
        if (revealsWord(text, this.word)) {
          socket.emit('chat:msg', { kind: 'danger', text: 'Chaos mode: typed answers do not count. Say it out loud!' });
          return;
        }
        this.emitAll('chat:msg', msg);
        return;
      }
      const guess = normalize(text);
      const target = normalize(this.word);
      if (guess === target) {
        this.correctGuess(p);
        return;
      }
      this.emitAll('chat:msg', msg);
      if (isClose(guess, target)) socket.emit('chat:msg', { kind: 'info', text: `"${text}" is close!` });
      return;
    }
    this.emitAll('chat:msg', msg);
  }

  // Chaos mode guess from the browser's speech recognition. `payload.alternatives`
  // holds the recogniser's candidate transcripts, best first.
  handleVoice(socket, payload) {
    if (!this.settings.chaos) return;
    const p = this.players.get(socket.id);
    if (!p || !this.isActiveGuesser(p) || !payload || !Array.isArray(payload.alternatives)) return;
    const alternatives = payload.alternatives.slice(0, 5).map((a) => cleanText(a, 120)).filter(Boolean);
    if (!alternatives.length || !this.allowMessage(socket)) return;

    if (voiceMatches(alternatives, this.word)) {
      this.correctGuess(p);
      return;
    }
    const heard = alternatives[0];
    if (alternatives.some((a) => revealsWord(a, this.word))) {
      socket.emit('chat:msg', { kind: 'info', text: `"${heard}" is close!` });
      return;
    }
    this.emitAll('chat:msg', { kind: 'chat', voice: true, id: p.id, name: p.name, color: p.color, text: heard });
  }

  correctGuess(player) {
    player.guessed = true;
    const total = this.settings.drawTime * 1000;
    const remaining = Math.max(0, this.phaseEndsAt - Date.now()) / total;
    let points = Math.round(50 + 350 * remaining) + Math.max(0, 100 - 25 * this.guessOrder);
    const boosted = this.amplify && this.guessOrder < AMPLIFY_SLOTS;
    if (boosted) {
      points *= AMPLIFY_MULTIPLIER;
      this.turnBoosted.add(player.id);
    }
    this.guessOrder++;
    player.score += points;
    this.turnGains[player.id] = (this.turnGains[player.id] || 0) + points;

    const drawer = this.players.get(this.drawerId);
    if (drawer) {
      drawer.score += DRAWER_POINTS_PER_GUESS;
      this.turnGains[drawer.id] = (this.turnGains[drawer.id] || 0) + DRAWER_POINTS_PER_GUESS;
    }
    this.system(boosted
      ? `${player.name} guessed the word! TOA Amplify ${AMPLIFY_MULTIPLIER}x: +${points}`
      : `${player.name} guessed the word!`, boosted ? 'amplify' : 'success');
    if (this.everyoneGuessed()) this.endTurn();
    else this.broadcastState();
  }

  // ---------- state ----------

  // Only the host receives the custom word list; everyone else gets a count,
  // so the words cannot be read from the page or its network traffic.
  settingsFor(id) {
    const { customWords, ...rest } = this.settings;
    return {
      ...rest,
      customWords: id === this.hostId ? customWords : [],
      customWordCount: customWords.length,
    };
  }

  stateFor(id) {
    const me = this.players.get(id);
    const canSeeWord = this.phase === PHASE.DRAWING && (id === this.drawerId || (me && me.guessed));
    return {
      code: this.code,
      isPublic: this.isPublic,
      you: id,
      hostId: this.hostId,
      settings: this.settingsFor(id),
      phase: this.phase,
      round: this.round,
      turnInRound: this.turnInRound,
      turnsThisRound: this.turnsThisRound,
      drawerId: this.drawerId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, score: p.score, color: p.color, guessed: p.guessed, voice: p.voice || 'unknown',
      })),
      hint: this.phase === PHASE.DRAWING ? this.maskedWord() : null,
      word: canSeeWord ? this.word : null,
      timeLeft: this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - Date.now()) : 0,
      choices: this.phase === PHASE.CHOOSING && id === this.drawerId ? this.choices : null,
      result: this.phase === PHASE.TURN_END ? this.lastResult : null,
      ranking: this.phase === PHASE.GAME_OVER ? this.ranking : null,
      amplify: Boolean(this.amplify) && (this.phase === PHASE.CHOOSING || this.phase === PHASE.DRAWING),
      amplifySlotsLeft: this.amplify && this.phase === PHASE.DRAWING ? Math.max(0, AMPLIFY_SLOTS - this.guessOrder) : 0,
    };
  }

  broadcastState() {
    for (const id of this.players.keys()) this.io.to(id).emit('room:state', this.stateFor(id));
  }
}

module.exports = { Room, PHASE, THEME, UNLIMITED, EVERYONE, AMPLIFY_SLOTS, AMPLIFY_MULTIPLIER, normalize, isClose, revealsWord, voiceMatches, cleanOp };
