(() => {
  'use strict';

  const socket = io({ transports: ['websocket', 'polling'] });
  const $ = (id) => document.getElementById(id);

  const COLORS = [
    '#111827', '#ffffff', '#9ca3af', '#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
    '#4b5563', '#78350f', '#a16207', '#b91c1c', '#c2410c', '#ca8a04', '#15803d', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d',
  ];
  const SIZES = [4, 10, 20, 36];
  const UNLIMITED_PLAYERS = 0;
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const SETTING_OPTIONS = {
    rounds: [1, 2, 3, 4, 5, 6, 8, 10],
    drawersPerRound: [0, 1, 2, 3, 4, 5, 6, 8, 10], // 0 = Everyone
    drawTime: [30, 45, 60],
    maxPlayers: [2, 3, 4, 5, 6, 8, 10, 12, 16, 0], // 0 = Unlimited
    wordCount: [1, 2, 3, 4, 5],
    hints: [0, 1, 2, 3, 4, 5],
  };

  let state = null;
  let deadline = 0;
  let lastCode = null;
  let lastName = '';
  let tool = 'brush';
  let color = COLORS[0];
  let size = SIZES[1];
  let drawing = false;
  let lastPoint = null;
  let groupId = 0;
  let pending = [];

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;

  // ---------- storage (best effort) ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  // ---------- UI helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function showScreen(name) {
    for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    const slot = name === 'lobby' ? $('lobby-chat-slot') : name === 'game' ? $('game-chat-slot') : null;
    const chat = $('chat');
    if (slot && chat.parentElement !== slot) slot.append(chat);
    chat.classList.toggle('hidden', !slot);
  }

  function me() { return state && state.players.find((p) => p.id === state.you); }
  function isHost() { return state && state.hostId === state.you; }
  function canDraw() { return state && state.phase === 'drawing' && state.drawerId === state.you; }
  function playerName(id) { const p = state && state.players.find((x) => x.id === id); return p ? p.name : 'Someone'; }

  // ---------- home ----------
  const nameInput = $('name-input');
  nameInput.value = store.get('toa-draw-name') || '';
  const inviteCode = (new URLSearchParams(location.search).get('r') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

  function readName(input, errorEl) {
    const name = input.value.trim().slice(0, 20);
    if (!name) {
      errorEl.textContent = 'Enter a name first.';
      input.focus();
      return null;
    }
    store.set('toa-draw-name', name);
    errorEl.textContent = '';
    return name;
  }

  function handleJoinResult(res, errorEl = $('home-error')) {
    if (!res || !res.ok) {
      errorEl.textContent = (res && res.error) || 'Could not join the room.';
      lastCode = null;
      return;
    }
    closeInvite();
    lastCode = res.code;
    history.replaceState(null, '', `/?r=${res.code}`);
  }

  function join(event, payload, input = nameInput, errorEl = $('home-error')) {
    const name = readName(input, errorEl);
    if (!name) return;
    lastName = name;
    nameInput.value = name;
    socket.emit(event, { name, ...payload }, (res) => handleJoinResult(res, errorEl));
  }

  $('btn-quick').addEventListener('click', () => join('room:quick'));
  $('btn-create').addEventListener('click', () => join('room:create', { isPublic: false, chaos: $('chaos-input').checked }));
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 5) { $('home-error').textContent = 'Room codes are 5 characters.'; return; }
    join('room:join', { code });
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); join('room:quick'); }
  });

  // ---------- invite modal ----------
  const inviteModal = $('invite-modal');
  const backgroundRegions = () => [document.querySelector('.brand-bar'), $('screen-home')];

  function openInvite(code) {
    $('invite-code').textContent = code;
    $('code-input').value = code;
    $('invite-error').textContent = '';
    const input = $('invite-name');
    input.value = nameInput.value;
    inviteModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    // Keep keyboard and screen-reader focus inside the dialog.
    backgroundRegions().forEach((el) => el && el.setAttribute('inert', ''));
    setTimeout(() => {
      if (input.value) $('btn-join-invite').focus();
      else input.focus();
    }, 0);
  }

  function closeInvite() {
    if (inviteModal.classList.contains('hidden')) return;
    inviteModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    backgroundRegions().forEach((el) => el && el.removeAttribute('inert'));
  }

  function dismissInvite() {
    closeInvite();
    if (!state) history.replaceState(null, '', '/');
    nameInput.focus();
  }

  $('invite-form').addEventListener('submit', (e) => {
    e.preventDefault();
    join('room:join', { code: $('invite-code').textContent }, $('invite-name'), $('invite-error'));
  });
  $('btn-invite-dismiss').addEventListener('click', dismissInvite);
  inviteModal.addEventListener('click', (e) => { if (e.target === inviteModal) dismissInvite(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !inviteModal.classList.contains('hidden')) dismissInvite();
  });

  if (inviteCode.length === 5) openInvite(inviteCode);

  function leave() {
    micOn = false;
    stopListening();
    voiceStatus('');
    resetMicCheck();
    socket.emit('room:leave');
    state = null;
    lastCode = null;
    history.replaceState(null, '', '/');
    $('chat-log').replaceChildren();
    closeInvite();
    showScreen('home');
  }
  document.querySelectorAll('.js-leave').forEach((b) => b.addEventListener('click', leave));

  // ---------- lobby ----------
  const form = $('settings-form');
  for (const [key, values] of Object.entries(SETTING_OPTIONS)) {
    const select = form.elements[key];
    for (const v of values) select.append(el('option', { value: v }, optionLabel(key, v)));
  }

  // maxPlayers 0 means no cap.
  function optionLabel(key, value) {
    if (key === 'maxPlayers' && Number(value) === UNLIMITED_PLAYERS) return 'Unlimited';
    if (key === 'drawersPerRound' && Number(value) === 0) return 'Everyone';
    return String(value);
  }

  function sendSettings() {
    if (!isHost()) return;
    socket.emit('room:settings', {
      rounds: form.elements.rounds.value,
      drawersPerRound: form.elements.drawersPerRound.value,
      drawTime: form.elements.drawTime.value,
      maxPlayers: form.elements.maxPlayers.value,
      wordCount: form.elements.wordCount.value,
      hints: form.elements.hints.value,
      customWords: form.elements.customWords.value,
      customOnly: form.elements.customOnly.checked,
      chaos: form.elements.chaos.checked,
    });
  }
  form.addEventListener('change', sendSettings);

  function ensureOption(select, value) {
    if (![...select.options].some((o) => Number(o.value) === value)) {
      select.append(el('option', { value }, optionLabel(select.name, value)));
    }
  }

  function renderLobby() {
    const s = state.settings;
    const host = isHost();
    for (const key of Object.keys(SETTING_OPTIONS)) {
      const select = form.elements[key];
      ensureOption(select, s[key]);
      if (document.activeElement !== select) select.value = String(s[key]);
      select.disabled = !host;
    }
    // Non-hosts never receive the custom words, only how many there are.
    $('custom-words-field').classList.toggle('hidden', !host);
    $('custom-words-hidden').classList.toggle('hidden', host);
    const count = s.customWordCount || 0;
    $('custom-words-hidden').querySelector('.hidden-words').textContent = count
      ? `The host added ${count} custom word${count === 1 ? '' : 's'}. They stay secret until they come up.`
      : 'No custom words added.';
    const words = form.elements.customWords;
    if (host && document.activeElement !== words) words.value = s.customWords.join(', ');
    words.disabled = !host;
    form.elements.customOnly.checked = s.customOnly;
    form.elements.customOnly.disabled = !host;
    form.elements.chaos.checked = s.chaos;
    form.elements.chaos.disabled = !host;
    $('chaos-setting').classList.toggle('hidden', state.isPublic);
    const chaosNote = $('chaos-note');
    chaosNote.classList.toggle('hidden', !s.chaos);
    chaosNote.textContent = !SpeechRecognitionImpl
      ? 'Chaos mode is on, but this browser has no voice input. Switch to Chrome to answer.'
      : 'Chaos mode is on: guesses only count when you say them. If everyone gets a drawing, the next one is a TOA Amplify turn (first 3 correct guesses score 2x). Your browser will ask for microphone access. Chrome and Edge send speech to their online speech service to turn it into text.';

    $('room-code').textContent = state.code;
    $('lobby-count').textContent = s.maxPlayers === UNLIMITED_PLAYERS
      ? String(state.players.length)
      : `${state.players.length}/${s.maxPlayers}`;
    renderPlayers($('lobby-players'), false);
    renderMicCheck();

    const start = $('btn-start');
    const enough = state.players.length >= 2;
    start.classList.toggle('hidden', !host);
    start.disabled = !enough;
    // Game length: rounds x drawers per round (capped by how many players there are).
    const playersNow = state.players.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const minutesFor = (t) => Math.max(1, Math.round((t * (s.drawTime + 15)) / 60));
    if (s.drawersPerRound === 0) {
      const turns = s.rounds * playersNow;
      $('game-length').textContent = `Everyone draws once per round: ${plural(turns, 'turn')} with ${plural(playersNow, 'player')}, `
        + `up to about ${minutesFor(turns)} min. Grows as people join.`;
    } else {
      const maxTurns = s.rounds * s.drawersPerRound;
      const small = playersNow < s.drawersPerRound ? ` Fewer while there ${playersNow === 1 ? 'is' : 'are'} only ${plural(playersNow, 'player')}.` : '';
      $('game-length').textContent = `${plural(s.drawersPerRound, 'random drawer')} per round: at most ${plural(maxTurns, 'turn')}, `
        + `about ${minutesFor(maxTurns)} min, however many join.${small}`;
    }

    const notReady = s.chaos ? state.players.filter((p) => p.voice !== 'ready') : [];
    let note;
    if (!enough) note = 'Waiting for at least one more player. Share the invite link.';
    else if (state.isPublic && state.timeLeft > 0) note = 'Public room: the game starts automatically in a few seconds.';
    else if (!host) note = `Waiting for ${playerName(state.hostId)} to start the game.`;
    else if (notReady.length) {
      note = `Mic check not passed yet: ${notReady.map((p) => p.name).join(', ')}. They can draw and chat, but cannot answer.`;
    } else note = s.chaos ? 'Everyone passed the mic check. Ready when you are.' : 'Ready when you are.';
    $('lobby-note').textContent = note;
  }

  $('btn-start').addEventListener('click', () => socket.emit('game:start'));
  $('btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}/?r=${state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied.');
    } catch {
      toast(link);
    }
  });

  // ---------- players ----------
  function renderPlayers(list, ranked) {
    const players = ranked ? [...state.players].sort((a, b) => b.score - a.score) : state.players;
    // Equal scores share a rank (1, 2, 2, 4), matching the final standings.
    const ranks = [];
    players.forEach((p, i) => { ranks[i] = i > 0 && p.score === players[i - 1].score ? ranks[i - 1] : i + 1; });
    list.replaceChildren(...players.map((p, i) => {
      const isDrawer = p.id === state.drawerId && (state.phase === 'drawing' || state.phase === 'choosing');
      const cls = ['player', p.id === state.you && 'me', p.guessed && 'guessed', isDrawer && 'drawing'].filter(Boolean).join(' ');
      const badges = el('div', { class: 'badges' },
        p.id === state.hostId && el('span', { class: 'badge host' }, 'HOST'),
        isDrawer && el('span', { class: 'badge draw' }, 'DRAWING'),
        p.guessed && el('span', { class: 'badge' }, 'GUESSED'),
        !ranked && state.settings.chaos && micBadge(p.voice),
      );
      const kick = isHost() && p.id !== state.you && el('button', {
        class: 'kick', title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`,
        onclick: () => { if (confirm(`Remove ${p.name} from the room?`)) socket.emit('player:kick', p.id); },
      }, '×');
      // In the narrow in-game list, badges sit under the name so it is not squeezed.
      return el('li', { class: cls },
        el('span', { class: 'rank' }, ranked ? `#${ranks[i]}` : ''),
        el('span', { class: 'avatar', style: `background:${p.color}` }, p.name.charAt(0)),
        el('div', { class: 'info' },
          el('div', { class: 'pname' }, p.name, p.id === state.you ? ' (you)' : ''),
          el('div', { class: 'pscore' }, `${p.score} pts`),
          ranked && badges),
        el('div', { class: 'badges' }, !ranked && badges, kick));
    }));
  }

  // ---------- game ----------
  function renderGame() {
    $('round-label').textContent = state.round
      ? `Round ${state.round} of ${state.settings.rounds}${state.turnsThisRound ? ` · Turn ${state.turnInRound} of ${state.turnsThisRound}` : ''}`
      : '';
    renderPlayers($('game-players'), true);
    renderWord();
    renderOverlay();

    const drawer = canDraw();
    $('toolbar').classList.toggle('hidden', !drawer);
    canvas.classList.toggle('can-draw', drawer);
    if (!drawer) drawing = false;

    const input = $('chat-input');
    const self = me();
    const chaos = state.settings.chaos;
    $('chaos-badge').classList.toggle('hidden', !chaos);
    const amp = $('amplify-badge');
    amp.classList.toggle('hidden', !state.amplify);
    amp.textContent = state.phase === 'drawing'
      ? `TOA AMPLIFY 2x · ${state.amplifySlotsLeft} left`
      : 'TOA AMPLIFY 2x';
    $('canvas').parentElement.classList.toggle('amplify', Boolean(state.amplify));
    if (state.phase === 'drawing' && (state.drawerId === state.you || (self && self.guessed))) {
      input.placeholder = 'Chat (anything with the answer stays hidden)...';
    } else if (chaos) {
      input.placeholder = 'Chat (answers by voice)';
    } else {
      input.placeholder = 'Type your guess here...';
    }
    updateVoice();
  }

  function renderWord() {
    const box = $('word-display');
    box.classList.remove('reveal');
    if (state.phase === 'drawing') {
      if (state.word) {
        box.classList.add('reveal');
        const label = state.drawerId === state.you ? 'Draw this' : 'You guessed it';
        box.replaceChildren(el('span', { class: 'sub' }, label), state.word);
      } else {
        const hint = state.hint || [];
        const groups = hint.join('').split(/[\s-]+/).map((w) => w.length);
        box.replaceChildren(
          el('span', { class: 'sub' }, `Guess the word (${groups.join(', ')} letters)`),
          hint.map((c) => (c === ' ' ? '  ' : c)).join(''),
        );
      }
    } else if (state.phase === 'choosing') {
      box.replaceChildren(el('span', { class: 'sub' }, `${playerName(state.drawerId)} is choosing a word`));
    } else if (state.phase === 'turnEnd' && state.result && state.result.word) {
      box.classList.add('reveal');
      box.replaceChildren(el('span', { class: 'sub' }, 'The word was'), state.result.word);
    } else if (state.phase === 'gameOver') {
      box.replaceChildren(el('span', { class: 'sub' }, 'Game over'));
    } else {
      box.replaceChildren();
    }
  }

  function renderOverlay() {
    const o = $('overlay');
    const phase = state.phase;
    o.classList.toggle('final', phase === 'gameOver');
    if (phase === 'drawing') { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');

    const amplifyBanner = state.amplify && el('div', { class: 'amplify-banner' },
      el('strong', {}, 'TOA Amplify turn'),
      el('span', {}, 'The first 3 correct guesses score 2x points'));
    if (phase === 'choosing') {
      if (state.choices) {
        o.replaceChildren(
          amplifyBanner,
          el('h3', {}, 'Choose a word to draw'),
          el('div', { class: 'choices' }, state.choices.map((w, i) =>
            el('button', { class: 'btn', onclick: () => socket.emit('word:choose', i) }, w))),
        );
      } else {
        o.replaceChildren(amplifyBanner, el('h3', {}, `${playerName(state.drawerId)} is choosing a word...`));
      }
    } else if (phase === 'turnEnd' && state.result) {
      const r = state.result;
      const title = r.reason === 'drawerLeft' ? `${r.drawerName} left the game`
        : r.reason === 'allGuessed' ? 'Everyone guessed it!' : "Time's up!";
      o.replaceChildren(
        el('h3', {}, title),
        r.word ? el('div', {}, 'The word was ', el('div', { class: 'big-word' }, r.word)) : null,
        el('ul', { class: 'gains' }, r.gains.map((g) =>
          el('li', {},
            el('span', {}, g.name, g.boosted && el('span', { class: 'boost-tag', title: 'TOA Amplify' }, '2x')),
            el('span', { class: g.gain ? 'plus' : 'zero' }, g.gain ? `+${g.gain}` : '0')))),
        r.amplifyNext && el('div', { class: 'amplify-banner' },
          el('strong', {}, 'Next turn: TOA Amplify'),
          el('span', {}, 'First 3 correct guesses score 2x')),
      );
    } else if (phase === 'gameOver' && state.ranking) {
      const ranking = state.ranking;
      const top = ranking.slice(0, 3);
      const order = [top[1], top[0], top[2]];
      const cls = ['p2', 'p1', 'p3'];
      const rankOf = (p, fallback) => String(p.rank || fallback);
      const fallbackRank = [2, 1, 3];
      // Full standings for every participant, not just the podium.
      const standings = el('ol', { class: 'standings', 'aria-label': 'Final standings' }, ranking.map((p, i) =>
        el('li', { class: p.id === state.you ? 'me' : '' },
          el('span', { class: 'pos' }, `#${p.rank || i + 1}`),
          el('span', { class: 'avatar', style: `background:${p.color}` }, p.name.charAt(0)),
          el('span', { class: 'nm' }, p.name, p.id === state.you ? ' (you)' : ''),
          el('span', { class: 'pts' }, `${p.score} pts`))));
      o.replaceChildren(
        el('h3', {}, 'Final results'),
        el('div', { class: 'podium' }, order.map((p, i) => p && el('div', { class: `step ${cls[i]}` },
          el('span', { class: 'avatar', style: `background:${p.color}` }, p.name.charAt(0)),
          el('div', { class: 'nm' }, p.name),
          el('div', {}, `${p.score} pts`),
          el('div', { class: 'block' }, rankOf(p, fallbackRank[i]))))),
        standings,
        el('p', { class: 'small' }, 'Returning to the lobby shortly...'),
      );
      // Keep your own row in view in a long list.
      const mine = standings.querySelector('li.me');
      if (mine) standings.scrollTop = Math.max(0, mine.offsetTop - standings.clientHeight / 2);
    } else {
      o.classList.add('hidden');
    }
  }

  function render() {
    if (!state) { showScreen('home'); return; }
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame();
    }
  }

  // Timer
  setInterval(() => {
    if (!state) return;
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const timer = $('timer');
    timer.textContent = state.phase === 'lobby' ? '' : String(secs);
    timer.classList.toggle('low', state.phase === 'drawing' && secs <= 10);
    if (state.phase === 'lobby' && state.isPublic && deadline > Date.now()) {
      $('lobby-note').textContent = `Public room: the game starts in ${secs}s.`;
    }
  }, 250);

  // ---------- voice answers (chaos mode) ----------
  // Uses the browser's built-in speech recognition. Once switched on, the mic
  // keeps listening for the rest of the turn and sends each phrase as a guess.
  let recognizer = null;
  let micOn = false; // the player wants to be listening
  let listening = false; // the recogniser is running right now
  let restartTimer = null;
  let voiceError = ''; // shown until the player presses the mic again
  let heardSomething = false; // any speech result since the mic was switched on
  let quickEnds = []; // timestamps of sessions that ended without hearing anything

  // Word lists are English, and some browsers reject regional codes such as
  // en-PH, so always ask for US English.
  const SPEECH_LANG = 'en-US';

  async function micPermission() {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      return status.state; // 'granted' | 'denied' | 'prompt'
    } catch {
      return 'unknown';
    }
  }

  async function explainVoiceError(code) {
    const browserHint = /Edg\//.test(navigator.userAgent)
      ? ' In Edge this usually means its online speech service is turned off or blocked (often by company policy). Try Chrome.'
      : ' Try Chrome.';
    switch (code) {
      case 'not-allowed': {
        const perm = await micPermission();
        if (perm === 'granted') return `The microphone is allowed, but the browser's speech service refused to start.${browserHint}`;
        return 'Microphone access is blocked. Click the icon at the left of the address bar, allow the microphone, then press the mic again.';
      }
      case 'service-not-allowed':
        return `This browser's speech service is turned off.${browserHint}`;
      case 'network':
        return `Could not reach the browser's online speech service. Check your internet connection or firewall.${browserHint}`;
      case 'audio-capture':
        return 'No microphone was found, or another app is using it.';
      case 'language-not-supported':
        return `The speech service does not support ${SPEECH_LANG}.${browserHint}`;
      case 'stalled':
        return `Voice input keeps stopping without hearing anything.${browserHint}`;
      default:
        return `Voice input stopped (${code}).${browserHint}`;
    }
  }

  async function failVoice(code) {
    console.warn('[voice] error:', code);
    micOn = false;
    stopListening();
    voiceError = `Voice error: ${await explainVoiceError(code)}`;
    updateVoice();
  }

  function canSpeak() {
    const self = me();
    return Boolean(state && state.settings.chaos && state.phase === 'drawing'
      && state.drawerId !== state.you && self && !self.guessed);
  }

  function voiceStatus(text) {
    const box = $('voice-status');
    box.textContent = text || '';
    box.classList.toggle('hidden', !text);
    box.classList.toggle('error', Boolean(text) && text.startsWith('Voice error'));
  }

  function getRecognizer() {
    if (recognizer || !SpeechRecognitionImpl) return recognizer;
    recognizer = new SpeechRecognitionImpl();
    recognizer.lang = SPEECH_LANG;
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 5;

    recognizer.onstart = () => { listening = true; updateVoice(); };
    recognizer.onresult = (event) => {
      heardSomething = true;
      quickEnds = [];
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const alternatives = [...result].map((a) => a.transcript.trim()).filter(Boolean);
          if (alternatives.length && canSpeak()) {
            socket.emit('chat:voice', { alternatives });
            voiceStatus(`Heard: "${alternatives[0]}"`);
          }
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim.trim()) voiceStatus(`Listening... "${interim.trim()}"`);
    };
    recognizer.onerror = (event) => {
      // 'no-speech' and 'aborted' are normal; onend restarts if still wanted.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      failVoice(event.error);
    };
    recognizer.onend = () => {
      listening = false;
      clearTimeout(restartTimer);
      if (micOn && canSpeak()) {
        // Guard against a silent loop where the service ends straight away.
        const now = Date.now();
        if (!heardSomething) quickEnds = [...quickEnds.filter((t) => now - t < 8000), now];
        if (quickEnds.length >= 4) {
          failVoice('stalled');
          return;
        }
        restartTimer = setTimeout(startListening, 250);
      }
      updateVoice();
    };
    return recognizer;
  }

  function startListening() {
    const r = getRecognizer();
    if (!r || listening) return;
    try {
      r.start();
    } catch (err) {
      // InvalidStateError means it is already starting; anything else is real.
      if (!err || err.name !== 'InvalidStateError') failVoice(err && err.name ? err.name : 'start-failed');
    }
  }

  function stopListening() {
    clearTimeout(restartTimer);
    if (recognizer && listening) {
      try { recognizer.stop(); } catch { /* ignore */ }
    }
  }

  function updateVoice() {
    const mic = $('btn-mic');
    const chaos = Boolean(state && state.settings.chaos && state.phase !== 'lobby');
    mic.classList.toggle('hidden', !chaos);
    if (!chaos) { micOn = false; stopListening(); voiceStatus(''); return; }

    const speakable = canSpeak();
    mic.disabled = !speakable || !SpeechRecognitionImpl;
    if (!speakable) {
      stopListening();
      voiceStatus('');
    } else if (voiceError && !micOn) {
      voiceStatus(voiceError);
    } else if (micOn) {
      startListening();
      const current = $('voice-status').textContent;
      if (!listening) voiceStatus('Starting microphone...');
      else if (!current.startsWith('Heard') && !current.startsWith('Listening')) voiceStatus('Listening... say your answer');
    } else {
      voiceStatus(SpeechRecognitionImpl ? 'Chaos mode: press the mic and say your answer.' : 'Chaos mode: this browser has no voice input. Use Chrome.');
    }
    mic.classList.toggle('listening', speakable && micOn);
    mic.classList.toggle('ready', speakable && !micOn);
    mic.setAttribute('aria-pressed', String(speakable && micOn));
    mic.setAttribute('aria-label', micOn ? 'Stop voice answers' : 'Start voice answers');
  }

  $('btn-mic').addEventListener('click', () => {
    if (!canSpeak()) return;
    micOn = !micOn;
    voiceError = '';
    if (micOn) {
      heardSomething = false;
      quickEnds = [];
    } else {
      stopListening();
    }
    updateVoice();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm' && canSpeak()) {
      e.preventDefault();
      $('btn-mic').click();
    }
  });

  // ---------- lobby mic check (chaos mode) ----------
  // Runs once when a player lands in a chaos lobby: asks for microphone
  // permission, then briefly starts speech recognition, which is the step that
  // fails on browsers whose speech service is blocked. The result is shared so
  // the host can see who is ready before starting.
  const MIC_LABELS = {
    unknown: ['MIC ?', 'mic-unknown'],
    checking: ['CHECKING MIC', 'mic-checking'],
    ready: ['MIC OK', 'mic-ok'],
    blocked: ['NO MIC', 'mic-bad'],
    unsupported: ['NO VOICE', 'mic-bad'],
  };
  const micCheck = { status: 'unknown', text: '', ranFor: null };

  function micBadge(status) {
    const [label, cls] = MIC_LABELS[status] || MIC_LABELS.unknown;
    return el('span', { class: `badge ${cls}`, title: 'Voice answer check' }, label);
  }

  function setMicCheck(status, text) {
    micCheck.status = status;
    micCheck.text = text;
    socket.emit('voice:status', status);
    renderMicCheck();
  }

  function resetMicCheck() {
    micCheck.status = 'unknown';
    micCheck.text = '';
    micCheck.ranFor = null;
  }

  function renderMicCheck() {
    const box = $('mic-check');
    const show = Boolean(state && state.phase === 'lobby' && state.settings.chaos);
    box.classList.toggle('hidden', !show);
    if (!show) return;
    // Run automatically the first time this player sees a chaos lobby for this room.
    if (micCheck.ranFor !== state.code) {
      micCheck.ranFor = state.code;
      runMicCheck();
      return;
    }
    const [label, cls] = MIC_LABELS[micCheck.status] || MIC_LABELS.unknown;
    const pill = $('mic-check-pill');
    pill.textContent = label;
    pill.className = `mic-pill ${cls}`;
    $('mic-check-text').textContent = micCheck.text;
    box.dataset.status = micCheck.status;
    $('btn-mic-check').disabled = micCheck.status === 'checking';
  }

  async function runMicCheck() {
    if (micCheck.status === 'checking') return;
    if (!SpeechRecognitionImpl) {
      setMicCheck('unsupported', 'This browser has no voice input, so you cannot answer in chaos mode. Switch to Chrome.');
      return;
    }
    setMicCheck('checking', 'Asking for microphone access... allow it if your browser asks.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicCheck('blocked', 'This page cannot use the microphone. It must be opened over HTTPS (or localhost).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const name = err && err.name;
      setMicCheck('blocked', name === 'NotFoundError' || name === 'OverconstrainedError'
        ? 'No microphone was found. Plug one in, then check again.'
        : 'Microphone access is blocked. Click the icon at the left of the address bar, allow the microphone, then check again.');
      return;
    }
    setMicCheck('checking', 'Microphone allowed. Testing speech recognition... say something!');
    const result = await testSpeechService();
    if (result.ok) {
      setMicCheck('ready', result.heard
        ? `You're ready. Heard: "${result.heard}"`
        : "You're ready. Microphone and speech recognition both work.");
    } else {
      setMicCheck('blocked', await explainVoiceError(result.code));
    }
  }

  // Starts recognition for a few seconds. Success = it starts without an error.
  function testSpeechService() {
    return new Promise((resolve) => {
      const r = new SpeechRecognitionImpl();
      r.lang = SPEECH_LANG;
      r.continuous = false;
      r.interimResults = true;
      let started = false;
      let done = false;
      let heard = '';
      const timers = [];
      const finish = (res) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        try { r.abort(); } catch { /* ignore */ }
        resolve(res);
      };
      r.onstart = () => { started = true; };
      r.onresult = (event) => {
        heard = [...event.results].map((res) => res[0].transcript).join(' ').trim();
        if (heard) setMicCheck('checking', `Listening... "${heard}"`);
        if (event.results[event.results.length - 1].isFinal) finish({ ok: true, heard });
      };
      r.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          if (started) finish({ ok: true, heard });
          return;
        }
        finish({ ok: false, code: event.error });
      };
      r.onend = () => finish(started ? { ok: true, heard } : { ok: false, code: 'stalled' });
      timers.push(setTimeout(() => { if (!started) finish({ ok: false, code: 'stalled' }); }, 5000));
      timers.push(setTimeout(() => finish({ ok: started, heard, code: 'stalled' }), 6000));
      try {
        r.start();
      } catch (err) {
        finish({ ok: false, code: (err && err.name) || 'start-failed' });
      }
    });
  }

  $('btn-mic-check').addEventListener('click', runMicCheck);

  // ---------- chat ----------
  function addMessage(m) {
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const node = m.kind === 'chat' || m.kind === 'insider'
      ? el('div', { class: `msg msg-${m.kind}` },
        m.kind === 'insider' && el('span', { class: 'tag', title: 'Only players who know the word can see this' }, 'HIDDEN'),
        m.voice && el('span', { class: 'tag voice', title: 'Said out loud' }, 'VOICE'),
        el('span', { class: 'who', style: `color:${m.color}` }, `${m.name}:`), m.text)
      : el('div', { class: `msg msg-${m.kind}` }, m.text);
    log.append(node);
    while (log.children.length > 200) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', text);
    input.value = '';
  });

  // ---------- drawing ----------
  function clearBoard() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function floodFill(px, py, hex) {
    const sx = Math.max(0, Math.min(W - 1, Math.floor(px)));
    const sy = Math.max(0, Math.min(H - 1, Math.floor(py)));
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const [r, g, b] = hexToRgb(hex);
    const start = (sy * W + sx) * 4;
    const tr = d[start]; const tg = d[start + 1]; const tb = d[start + 2];
    if (Math.abs(tr - r) + Math.abs(tg - g) + Math.abs(tb - b) < 6) return;
    const TOL = 90;
    const seen = new Uint8Array(W * H);
    const match = (i) => !seen[i] && Math.abs(d[i * 4] - tr) + Math.abs(d[i * 4 + 1] - tg) + Math.abs(d[i * 4 + 2] - tb) <= TOL;
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      let i = y * W + x;
      while (x > 0 && match(i - 1)) { x--; i--; }
      let up = false;
      let down = false;
      while (x < W && match(i)) {
        seen[i] = 1;
        const p = i * 4;
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
        if (y > 0) {
          if (match(i - W)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
        }
        if (y < H - 1) {
          if (match(i + W)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
        }
        x++; i++;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function applyOp(op) {
    if (op.t === 'l') {
      const x0 = op.x0 * W; const y0 = op.y0 * H; const x1 = op.x1 * W; const y1 = op.y1 * H;
      if (x0 === x1 && y0 === y1) {
        ctx.fillStyle = op.c;
        ctx.beginPath();
        ctx.arc(x0, y0, op.w / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.strokeStyle = op.c;
      ctx.lineWidth = op.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (op.t === 'f') {
      floodFill(op.x * W, op.y * H, op.c);
    }
  }

  function replay(ops) {
    clearBoard();
    ops.forEach(applyOp);
  }

  const r4 = (v) => Math.round(v * 10000) / 10000;
  function pointFrom(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: r4(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))),
      y: r4(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))),
    };
  }

  function emitOp(op) {
    applyOp(op);
    pending.push(op);
  }

  function lineOp(a, b) {
    return { t: 'l', g: groupId, c: tool === 'eraser' ? '#ffffff' : color, w: tool === 'eraser' ? size * 1.5 : size, x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw() || e.button > 0) return;
    e.preventDefault();
    groupId++;
    const p = pointFrom(e);
    if (tool === 'fill') {
      emitOp({ t: 'f', g: groupId, c: color, x: p.x, y: p.y });
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    lastPoint = p;
    emitOp(lineOp(p, p));
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !canDraw()) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const p = pointFrom(ev);
      if (Math.abs(p.x - lastPoint.x) + Math.abs(p.y - lastPoint.y) < 0.002) continue;
      emitOp(lineOp(lastPoint, p));
      lastPoint = p;
    }
  });

  const stopDrawing = () => { drawing = false; lastPoint = null; };
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);

  setInterval(() => {
    if (pending.length) socket.emit('draw', pending.splice(0, 500));
  }, 40);

  // Toolbar
  $('palette').replaceChildren(...COLORS.map((c) => el('button', {
    class: `swatch${c === color ? ' active' : ''}`, style: `background:${c}`, title: c, 'aria-label': `Color ${c}`,
    onclick: (e) => {
      color = c;
      if (tool === 'eraser') setTool('brush');
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      e.currentTarget.classList.add('active');
    },
  })));
  $('sizes').replaceChildren(...SIZES.map((s) => el('button', {
    class: `size${s === size ? ' active' : ''}`, title: `Size ${s}`, 'aria-label': `Brush size ${s}`,
    onclick: (e) => {
      size = s;
      document.querySelectorAll('.size').forEach((b) => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
    },
  }, el('i', { style: `width:${Math.min(28, s * 0.75 + 3)}px;height:${Math.min(28, s * 0.75 + 3)}px` }))));

  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('btn-undo').addEventListener('click', () => { pending.length && socket.emit('draw', pending.splice(0)); socket.emit('canvas:undo'); });
  $('btn-clear').addEventListener('click', () => { pending = []; socket.emit('canvas:clear'); });

  document.addEventListener('keydown', (e) => {
    if (!canDraw() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('btn-undo').click(); return; }
    const map = { b: 'brush', e: 'eraser', f: 'fill' };
    if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
  });

  // ---------- socket events ----------
  socket.on('connect', () => {
    $('conn-status').className = 'conn online';
    // Rejoin after a dropped connection (e.g. network blip or server restart).
    if (lastCode && lastName) {
      socket.emit('room:join', { name: lastName, code: lastCode }, (res) => {
        if (!res || !res.ok) { toast('Your room is no longer available.'); leave(); } else handleJoinResult(res);
      });
    }
  });
  socket.on('disconnect', () => {
    $('conn-status').className = 'conn offline';
    if (state) toast('Connection lost. Reconnecting...');
  });

  socket.on('room:state', (s) => {
    const phaseChanged = !state || state.phase !== s.phase;
    state = s;
    deadline = Date.now() + s.timeLeft;
    if (phaseChanged) pending = [];
    render();
  });
  socket.on('chat:msg', addMessage);
  socket.on('draw', (ops) => ops.forEach(applyOp));
  socket.on('canvas:sync', replay);
  socket.on('kicked', () => { toast('You were removed from the room.'); leave(); });

  clearBoard();
  showScreen('home');
})();
