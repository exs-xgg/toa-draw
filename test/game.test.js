'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');
const { normalize, isClose, revealsWord, voiceMatches, cleanOp } = require('../src/room');

let server;
let url;
const clients = [];

before(async () => {
  ({ server } = createServer());
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise((resolve) => server.close(resolve));
  setImmediate(() => process.exit(0)); // stop any lingering room timers
});

function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  c.states = [];
  c.on('room:state', (s) => c.states.push(s));
  clients.push(c);
  return c;
}

const emit = (c, event, data) => new Promise((resolve) => c.emit(event, data, resolve));

function waitFor(c, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const found = c.states.find(predicate);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error('Timed out waiting for state')), timeout);
    const onState = (s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        c.off('room:state', onState);
        resolve(s);
      }
    };
    c.on('room:state', onState);
  });
}

test('helpers normalise guesses and validate draw ops', () => {
  assert.equal(normalize('  Hot-Dog! '), 'hot dog');
  assert.equal(isClose('pengin', 'penguin'), true);
  assert.equal(isClose('cat', 'car'), false);
  assert.equal(cleanOp({ t: 'l', g: 1, c: '#000000', w: 5, x0: 0, y0: 0, x1: 0.5, y1: 0.5 }).t, 'l');
  assert.equal(cleanOp({ t: 'l', g: 1, c: 'red', w: 5, x0: 0, y0: 0, x1: 1, y1: 1 }), null);
  assert.equal(cleanOp({ t: 'x', g: 1, c: '#000000' }), null);
});

test('two players can create, join, draw and guess', async () => {
  const alice = client();
  const bob = client();

  const created = await emit(alice, 'room:create', { name: 'Alice' });
  assert.equal(created.ok, true);
  const joined = await emit(bob, 'room:join', { name: 'Bob', code: created.code });
  assert.equal(joined.ok, true);

  const missing = await emit(bob, 'room:join', { name: 'Bob', code: 'ZZZZZ' });
  assert.equal(missing.ok, false);

  await waitFor(alice, (s) => s.players.length === 2);
  alice.emit('game:start');

  const choosing = await waitFor(alice, (s) => s.phase === 'choosing');
  const drawer = choosing.drawerId === alice.id ? alice : bob;
  const guesser = drawer === alice ? bob : alice;

  const drawerChoice = await waitFor(drawer, (s) => s.phase === 'choosing' && Array.isArray(s.choices));
  drawer.emit('word:choose', 0);
  const word = drawerChoice.choices[0];

  const guesserView = await waitFor(guesser, (s) => s.phase === 'drawing');
  assert.equal(guesserView.word, null, 'guesser must not see the word');
  assert.equal(guesserView.hint.length, word.length);

  // Drawing is relayed to the guesser.
  const relayed = new Promise((resolve) => guesser.once('draw', resolve));
  drawer.emit('draw', [{ t: 'l', g: 1, c: '#111827', w: 10, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }]);
  assert.equal((await relayed).length, 1);

  // A non-drawer cannot draw.
  let leaked = false;
  drawer.once('draw', () => { leaked = true; });
  guesser.emit('draw', [{ t: 'l', g: 1, c: '#111827', w: 10, x0: 0, y0: 0, x1: 1, y1: 1 }]);

  guesser.emit('chat', word.toUpperCase());
  const end = await waitFor(guesser, (s) => s.phase === 'turnEnd');
  assert.equal(end.result.word, word);
  assert.equal(end.result.reason, 'allGuessed');
  const scores = Object.fromEntries(end.players.map((p) => [p.id, p.score]));
  assert.ok(scores[guesser.id] > 0, 'guesser scored');
  assert.ok(scores[drawer.id] > 0, 'drawer scored');
  assert.equal(leaked, false, 'guesser draw ops were not relayed');
});

test('revealsWord catches the answer inside a message', () => {
  assert.equal(revealsWord('nice one, it was APPLE!', 'apple'), true);
  assert.equal(revealsWord('so close: aple', 'apple'), true);
  assert.equal(revealsWord('love that hotdog', 'hot dog'), true);
  assert.equal(revealsWord('hot dgo for sure', 'hot dog'), true);
  assert.equal(revealsWord('great drawing!', 'apple'), false);
  assert.equal(revealsWord('cat', 'car'), false);
});

test('chat stays public after a correct guess, but the answer is filtered', async () => {
  const players = [client(), client(), client()];
  const logs = new Map(players.map((p) => [p, []]));
  players.forEach((p) => p.on('chat:msg', (m) => logs.get(p).push(m)));

  const { code } = await emit(players[0], 'room:create', { name: 'P0' });
  await emit(players[1], 'room:join', { name: 'P1', code });
  await emit(players[2], 'room:join', { name: 'P2', code });
  await waitFor(players[0], (s) => s.players.length === 3);
  players[0].emit('game:start');

  const choosing = await waitFor(players[0], (s) => s.phase === 'choosing');
  const drawer = players.find((p) => p.id === choosing.drawerId);
  const [guessed, waiting] = players.filter((p) => p !== drawer);
  const { choices } = await waitFor(drawer, (s) => s.phase === 'choosing' && Array.isArray(s.choices));
  drawer.emit('word:choose', 0);
  await waitFor(waiting, (s) => s.phase === 'drawing');
  const word = choices[0];

  guessed.emit('chat', word);
  await waitFor(waiting, (s) => s.players.some((p) => p.id === guessed.id && p.guessed));
  logs.forEach((l) => { l.length = 0; });

  guessed.emit('chat', 'that was fun');
  drawer.emit('chat', 'thanks!');
  guessed.emit('chat', `it is ${word}`);
  waiting.emit('chat', 'is it a glorptastic');
  await new Promise((r) => setTimeout(r, 300));

  const texts = (p) => logs.get(p).filter((m) => m.kind === 'chat' || m.kind === 'insider').map((m) => m.text);
  assert.deepEqual(texts(waiting).sort(), ['is it a glorptastic', 'thanks!', 'that was fun'].sort(), 'non-guesser sees public chat but not the answer');
  assert.ok(texts(drawer).includes(`it is ${word}`), 'drawer sees the hidden message');
  assert.ok(texts(guessed).includes('is it a glorptastic'), 'guessed player still sees guesses');
  assert.ok(!logs.get(waiting).some((m) => normalize(m.text || '').includes(normalize(word))), 'answer never reaches the non-guesser');
});

test('voiceMatches accepts spoken phrases containing the answer', () => {
  assert.equal(voiceMatches(['is it a hot dog'], 'hot dog'), true);
  assert.equal(voiceMatches(['hotdog'], 'hot dog'), true);
  assert.equal(voiceMatches(['apples'], 'apple'), true);
  assert.equal(voiceMatches(['pineapple', 'pine apple'], 'apple'), true, 'second alternative matches');
  assert.equal(voiceMatches(['pineapple'], 'apple'), false);
  assert.equal(voiceMatches(['a red car'], 'cat'), false);
});

test('chaos mode: typed answers never count, spoken answers do', async () => {
  const [host, guest] = [client(), client()];
  const guestLog = [];
  const hostLog = [];
  guest.on('chat:msg', (m) => guestLog.push(m));
  host.on('chat:msg', (m) => hostLog.push(m));

  const { code } = await emit(host, 'room:create', { name: 'Host', chaos: true });
  await emit(guest, 'room:join', { name: 'Guest', code });
  const lobby = await waitFor(host, (s) => s.players.length === 2);
  assert.equal(lobby.settings.chaos, true);

  host.emit('game:start');
  const choosing = await waitFor(host, (s) => s.phase === 'choosing');
  const drawer = choosing.drawerId === host.id ? host : guest;
  const guesser = drawer === host ? guest : host;
  const guesserLog = guesser === guest ? guestLog : hostLog;
  const drawerLog = drawer === guest ? guestLog : hostLog;
  const { choices } = await waitFor(drawer, (s) => s.phase === 'choosing' && Array.isArray(s.choices));
  drawer.emit('word:choose', 0);
  await waitFor(guesser, (s) => s.phase === 'drawing');
  const word = choices[0];
  drawerLog.length = 0;
  guesserLog.length = 0;

  // Typed answer: not counted, not shown to anyone, sender is told to speak.
  guesser.emit('chat', word);
  guesser.emit('chat', 'just chatting');
  // The drawer cannot submit voice guesses.
  drawer.emit('chat:voice', { alternatives: [word] });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(guesser.states.at(-1).phase, 'drawing', 'typed answer did not end the turn');
  assert.ok(guesserLog.some((m) => m.kind === 'danger' && /out loud/i.test(m.text)));
  assert.ok(!drawerLog.some((m) => normalize(m.text || '') === normalize(word)), 'typed answer not broadcast');
  assert.ok(drawerLog.some((m) => m.text === 'just chatting'), 'normal typed chat still works');

  // Spoken wrong guess is shown with a voice flag.
  guesser.emit('chat:voice', { alternatives: ['zorblax quint flep'] });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(drawerLog.some((m) => m.voice && m.text === 'zorblax quint flep'));

  // Spoken answer counts.
  guesser.emit('chat:voice', { alternatives: ['umm', `I think it is ${word}`] });
  const end = await waitFor(guesser, (s) => s.phase === 'turnEnd');
  assert.equal(end.result.reason, 'allGuessed');
});

test('draw time is limited to 30, 45 or 60 seconds', async () => {
  const host = client();
  const { code } = await emit(host, 'room:create', { name: 'H' });
  const initial = await waitFor(host, (s) => s.code === code);
  assert.equal(initial.settings.drawTime, 60, 'default is 60s');
  for (const [asked, expected] of [[45, 45], [50, 45], [240, 60], [5, 30], [55, 60]]) {
    host.emit('room:settings', { drawTime: asked });
    const s = await waitFor(host, (x) => x.settings.drawTime === expected);
    assert.equal(s.settings.drawTime, expected, `asked ${asked}`);
  }
});

test('max players can be unlimited, and a cap still blocks extra players', async () => {
  const host = client();
  const { code } = await emit(host, 'room:create', { name: 'Host' });
  host.emit('room:settings', { maxPlayers: 0 });
  await waitFor(host, (s) => s.settings.maxPlayers === 0);

  const guests = Array.from({ length: 19 }, () => client());
  const results = await Promise.all(guests.map((g, i) => emit(g, 'room:join', { name: `G${i}`, code })));
  assert.ok(results.every((r) => r.ok), 'all 19 guests joined');
  await waitFor(host, (s) => s.players.length === 20);

  // A small cap: 2 players allowed, a third is turned away.
  const { code: small } = await emit(guests[0], 'room:create', { name: 'Small' });
  guests[0].emit('room:settings', { maxPlayers: 2 });
  await waitFor(guests[0], (s) => s.code === small && s.settings.maxPlayers === 2);
  assert.equal((await emit(guests[1], 'room:join', { name: 'Two', code: small })).ok, true);
  const third = await emit(guests[2], 'room:join', { name: 'Three', code: small });
  assert.equal(third.ok, false);
  assert.match(third.error, /full/i);
});

test('custom words are only sent to the host', async () => {
  const host = client();
  const guest = client();
  const { code } = await emit(host, 'room:create', { name: 'Host' });
  await emit(guest, 'room:join', { name: 'Guest', code });
  host.emit('room:settings', { customWords: 'secret alpha, secret beta, secret gamma' });

  const hostView = await waitFor(host, (s) => s.settings.customWordCount === 3);
  assert.deepEqual(hostView.settings.customWords, ['secret alpha', 'secret beta', 'secret gamma']);

  const guestView = await waitFor(guest, (s) => s.settings.customWordCount === 3);
  assert.deepEqual(guestView.settings.customWords, []);
  assert.ok(!guest.states.some((s) => JSON.stringify(s).includes('secret')), 'no guest update ever carried a custom word');

  // If the host leaves, the new host takes over the list so they can edit it.
  host.disconnect();
  const promoted = await waitFor(guest, (s) => s.hostId === guest.id);
  assert.equal(promoted.settings.customWords.length, 3);
});

test('chaos mode is ignored for public rooms', async () => {
  const a = client();
  const r = await emit(a, 'room:create', { name: 'A', isPublic: true, chaos: true });
  assert.equal(r.ok, true);
  const s = await waitFor(a, (x) => x.code === r.code);
  assert.equal(s.settings.chaos, false);
});

test('quick play puts players in the same public room', async () => {
  const a = client();
  const b = client();
  const r1 = await emit(a, 'room:quick', { name: 'A' });
  const r2 = await emit(b, 'room:quick', { name: 'B' });
  assert.equal(r1.code, r2.code);
  const s = await waitFor(a, (x) => x.players.length === 2);
  assert.equal(s.isPublic, true);
  assert.ok(s.timeLeft > 0, 'auto-start countdown running');
});

test('final ranking lists every player, with ties sharing a rank', () => {
  const { Room } = require('../src/room');
  const sent = [];
  const fakeIo = { to: () => ({ emit: (event, payload) => sent.push([event, payload]) }) };
  const room = new Room(fakeIo, 'TEST1');
  const scores = { a: 300, b: 500, c: 300, d: 100, e: 0 };
  for (const [id, score] of Object.entries(scores)) {
    room.players.set(id, { id, name: id.toUpperCase(), score, color: '#000000', guessed: false, chatTimes: [] });
  }
  room.gameOver();
  room.clearTimers();

  const ranking = room.stateFor('d').ranking;
  assert.equal(ranking.length, 5, 'all participants are included');
  assert.deepEqual(ranking.map((p) => [p.name, p.score, p.rank]), [
    ['B', 500, 1], ['A', 300, 2], ['C', 300, 2], ['D', 100, 4], ['E', 0, 5],
  ]);
});

// ---------- TOA Amplify ----------
function amplifyRoom({ chaos }) {
  const { Room } = require('../src/room');
  const fakeIo = { to: () => ({ emit: () => {} }) };
  const room = new Room(fakeIo, 'AMP01');
  room.settings.chaos = chaos;
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    room.players.set(id, { id, name: id.toUpperCase(), score: 0, color: '#000000', guessed: false, chatTimes: [] });
  }
  room.round = 1;
  room.queue = ['a', 'b'];
  return room;
}
const guess = (room, ids) => ids.forEach((id) => room.correctGuess(room.players.get(id)));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 4, `${actual} ~ ${expected}`);

test('TOA Amplify: everyone guessing earns a 2x turn for the first three guessers', () => {
  const room = amplifyRoom({ chaos: true });
  room.nextTurn();
  room.chooseWord('a', 0);
  assert.equal(room.stateFor('b').amplify, false, 'first turn is not amplified');
  guess(room, ['b', 'c', 'd', 'e']);
  assert.equal(room.phase, 'turnEnd');
  assert.equal(room.lastResult.reason, 'allGuessed');
  assert.equal(room.lastResult.amplifyNext, true, 'next turn announced as Amplify');

  room.clearTimers();
  room.nextTurn(); // B draws
  assert.equal(room.stateFor('c').amplify, true, 'players are told this is an Amplify turn');
  room.chooseWord('b', 0);
  assert.equal(room.stateFor('c').amplifySlotsLeft, 3);
  guess(room, ['c', 'd', 'e', 'a']);
  room.clearTimers();

  // Instant guesses score 500, 475, 450, 425 before the multiplier.
  const gains = Object.fromEntries(room.lastResult.gains.map((g) => [g.id, g]));
  near(gains.c.gain, 1000);
  near(gains.d.gain, 950);
  near(gains.e.gain, 900);
  near(gains.a.gain, 425);
  assert.deepEqual(['c', 'd', 'e', 'a'].map((id) => gains[id].boosted), [true, true, true, false]);
  assert.equal(gains.b.gain, 4 * 60, 'drawer points are not doubled');
  assert.equal(room.lastResult.amplified, true);
});

test('TOA Amplify: not triggered by a partial turn or outside chaos mode', () => {
  const partial = amplifyRoom({ chaos: true });
  partial.nextTurn();
  partial.chooseWord('a', 0);
  guess(partial, ['b', 'c']);
  partial.endTurn(); // time runs out
  partial.clearTimers();
  assert.equal(partial.lastResult.amplifyNext, false);
  partial.nextTurn();
  assert.equal(partial.amplify, false);
  partial.clearTimers();

  const normal = amplifyRoom({ chaos: false });
  normal.nextTurn();
  normal.chooseWord('a', 0);
  guess(normal, ['b', 'c', 'd', 'e']);
  normal.clearTimers();
  assert.equal(normal.lastResult.amplifyNext, false, 'no Amplify without chaos mode');
  normal.nextTurn();
  assert.equal(normal.amplify, false);
  normal.clearTimers();
});

test('lobby mic check status is shared with the room', async () => {
  const host = client();
  const guest = client();
  const { code } = await emit(host, 'room:create', { name: 'Host', chaos: true });
  await emit(guest, 'room:join', { name: 'Guest', code });
  const initial = await waitFor(host, (s) => s.players.length === 2);
  assert.ok(initial.players.every((p) => p.voice === 'unknown'));

  guest.emit('voice:status', 'blocked');
  await waitFor(host, (s) => s.players.some((p) => p.id === guest.id && p.voice === 'blocked'));
  guest.emit('voice:status', 'ready');
  await waitFor(host, (s) => s.players.some((p) => p.id === guest.id && p.voice === 'ready'));

  guest.emit('voice:status', '<script>');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(host.states.at(-1).players.find((p) => p.id === guest.id).voice, 'ready', 'unknown values ignored');
});

test('Christmas theme: every word choice includes a holiday word, and the page is told the theme', async () => {
  const { Room } = require('../src/room');
  const { HOLIDAY_WORDS } = require('../src/words');
  const room = new Room({ to: () => ({ emit: () => {} }) }, 'XMAS1');
  for (let i = 0; i < 50; i++) {
    const choices = room.pickChoices();
    assert.equal(choices.length, 3);
    assert.equal(new Set(choices).size, 3, 'no duplicates');
    assert.ok(choices.some((w) => HOLIDAY_WORDS.includes(w)), `holiday word in ${choices}`);
  }
  // Custom-words-only rooms are left alone.
  room.settings.customWords = ['one', 'two', 'three'];
  room.settings.customOnly = true;
  assert.ok(room.pickChoices().every((w) => ['one', 'two', 'three'].includes(w)));

  const res = await fetch(`${url}/theme-config.js`);
  assert.equal(await res.text(), 'window.TOA_THEME="christmas";');
});

// ---------- Drawers per round ----------
function drawersRoom(n, playerCount) {
  const { Room } = require('../src/room');
  const room = new Room({ to: () => ({ emit: () => {} }) }, 'DRAW1');
  room.settings.drawersPerRound = n;
  for (let i = 0; i < playerCount; i++) {
    const id = `p${i}`;
    room.players.set(id, { id, name: `P${i}`, score: 0, color: '#000000', guessed: false, chatTimes: [], voice: 'unknown' });
  }
  return room;
}

test('drawers per round: random picks, and nobody draws twice before everyone has drawn once', () => {
  const room = drawersRoom(3, 7);
  const seen = new Map();
  for (let round = 1; round <= 3; round++) {
    const picked = room.pickDrawers();
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, 'no duplicates in a round');
    picked.forEach((id) => room.drawCounts.set(id, (room.drawCounts.get(id) || 0) + 1));
    picked.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
    if (round === 2) assert.equal(seen.size, 6, 'rounds 1-2 used 6 different players');
  }
  assert.equal(seen.size, 7, 'all 7 players drew within 3 rounds of 3');
  assert.ok([...seen.values()].every((c) => c <= 2));

  // Different games pick different drawers (randomised).
  const firstPicks = new Set();
  for (let i = 0; i < 30; i++) firstPicks.add(drawersRoom(3, 7).pickDrawers().slice().sort().join());
  assert.ok(firstPicks.size > 1, 'selection is random');

  // "Everyone" (0) and limits larger than the room let everyone draw.
  assert.equal(drawersRoom(0, 5).pickDrawers().length, 5);
  assert.equal(drawersRoom(10, 4).pickDrawers().length, 4);
});

test('drawers per round: setting validation and late joiners', () => {
  const room = drawersRoom(0, 2);
  room.hostId = 'p0';
  room.updateSettings('p0', { drawersPerRound: 4 });
  assert.equal(room.settings.drawersPerRound, 4);
  room.updateSettings('p0', { drawersPerRound: 999 });
  assert.equal(room.settings.drawersPerRound, 50);
  room.updateSettings('p0', { drawersPerRound: 'abc' });
  assert.equal(room.settings.drawersPerRound, 50, 'junk ignored');
  room.updateSettings('p0', { drawersPerRound: 0 });
  assert.equal(room.settings.drawersPerRound, 0, 'Everyone');
  room.updateSettings('p1', { drawersPerRound: 3 });
  assert.equal(room.settings.drawersPerRound, 0, 'non-host cannot change it');

  // Mid-game joiner: queued only when everyone draws.
  const fakeSocket = (id) => ({ id, join() {}, emit() {} });
  room.settings.drawersPerRound = 2;
  room.phase = 'drawing';
  room.queue = [];
  room.addPlayer(fakeSocket('late1'), 'Late');
  assert.deepEqual(room.queue, [], 'limited: late joiner waits for a later round');
  room.settings.drawersPerRound = 0;
  room.addPlayer(fakeSocket('late2'), 'Later');
  assert.deepEqual(room.queue, ['late2'], 'everyone: late joiner gets a turn this round');
  room.clearTimers();
});

test('round counter never goes past the total, including on the final results', () => {
  const room = drawersRoom(2, 4);
  room.hostId = 'p0';
  room.settings.rounds = 4;
  room.startGame('p0');
  let maxSeen = 0;
  for (let step = 0; step < 50 && room.phase !== 'gameOver'; step++) {
    maxSeen = Math.max(maxSeen, room.stateFor('p0').round);
    room.clearTimers();
    room.nextTurn();
  }
  room.clearTimers();
  assert.equal(room.phase, 'gameOver');
  assert.equal(maxSeen, 4, 'played rounds 1 to 4');
  assert.equal(room.stateFor('p0').round, 4, 'final results show round 4, not 5');
});

// ---------- Chaos mode mic opt-out (3s delayed typed answers) ----------
function optOutRoom({ chaos = true } = {}) {
  const { Room } = require('../src/room');
  const sent = new Map(); // player id -> messages sent to that player
  const io = { to: (id) => ({ emit: (event, payload) => { if (event === 'chat:msg' && sent.has(id)) sent.get(id).push(payload); } }) };
  const room = new Room(io, 'OPT01');
  room.settings.chaos = chaos;
  room.settings.drawTime = 60;
  const sockets = {};
  for (const id of ['drawer', 'opt', 'voice', 'other']) {
    room.players.set(id, { id, name: id, score: 0, color: '#000000', guessed: false, chatTimes: [], voice: 'ready', micOptOut: false });
    sent.set(id, []);
    sockets[id] = { id, join() {}, emit: (event, payload) => { if (event === 'chat:msg') sent.get(id).push(payload); } };
  }
  room.round = 1;
  room.queue = ['drawer'];
  room.nextTurn();
  room.chooseWord('drawer', 0);
  return { room, sockets, sent, word: room.word };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gainOf = (room, id) => room.turnGains[id] || 0;

test('mic opt-out: typed answer scores as if sent 3s later, and loses guess order', async () => {
  const a = optOutRoom(); // opted-out player types at t=0
  const b = optOutRoom(); // control: normal player speaks the answer at t=3s
  a.room.setMicOptOut('opt', true);
  assert.equal(a.room.stateFor('drawer').players.find((p) => p.id === 'opt').micOptOut, true, 'visible to others');

  a.room.handleChat(a.sockets.opt, a.word); // typed, t=0
  await sleep(1000);
  a.room.handleVoice(a.sockets.voice, { alternatives: [a.word] }); // normal voice player, t=1s
  await sleep(1500);
  assert.equal(a.room.players.get('opt').guessed, false, 'not counted yet at t=2.5s');
  b.room.handleVoice(b.sockets.voice, { alternatives: [] }); // no-op, keeps timing honest
  await sleep(500);
  b.room.handleVoice(b.sockets.voice, { alternatives: [b.word] }); // control at t=3s
  await sleep(200);

  assert.equal(a.room.players.get('opt').guessed, true, 'counted after the 3s hold');
  assert.equal(a.room.turnBoosted.size, 0);
  // Voice player answered at 1s, so they are first; the opted-out player is second.
  assert.ok(gainOf(a.room, 'voice') > gainOf(a.room, 'opt'));
  // Opted-out answer (sent at 0s, order 2nd) vs control (sent at 3s, order 1st):
  // remove the order bonus difference (100 for 1st vs 75 for 2nd) and compare time scores.
  const optTimeScore = gainOf(a.room, 'opt') - 75;
  const controlTimeScore = gainOf(b.room, 'voice') - 100;
  assert.ok(Math.abs(optTimeScore - controlTimeScore) <= 3, `opt ${optTimeScore} vs control-at-3s ${controlTimeScore}`);
  // ...and clearly less than an instant answer would have scored (~400).
  assert.ok(optTimeScore <= 385, `time score ${optTimeScore} reflects the 3s delay`);
  a.room.clearTimers(); b.room.clearTimers();
});

test('mic opt-out: answers landing after the turn ends do not count; ignored outside chaos', async () => {
  const a = optOutRoom();
  a.room.setMicOptOut('opt', true);
  a.room.handleChat(a.sockets.opt, a.word);
  a.room.endTurn(); // turn ends inside the 3s window
  a.room.clearTimers();
  await sleep(3200);
  assert.equal(gainOf(a.room, 'opt'), 0);
  assert.equal(a.room.lastResult.gains.find((g) => g.id === 'opt').gain, 0, 'no points for a late answer');
  assert.ok(a.sent.get('opt').some((m) => /after the turn ended/.test(m.text)), 'player is told why');

  const normal = optOutRoom({ chaos: false });
  normal.room.setMicOptOut('opt', true);
  assert.equal(normal.room.players.get('opt').micOptOut, false, 'no opt-out outside chaos mode');
  normal.room.handleChat(normal.sockets.opt, normal.word);
  assert.equal(normal.room.players.get('opt').guessed, true, 'normal rooms: typed answers count instantly');
  normal.room.clearTimers();
  normal.room.clearPendingAnswers();
});
