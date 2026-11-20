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
