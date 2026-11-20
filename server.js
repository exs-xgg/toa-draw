'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, PHASE } = require('./src/room');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || 'Player';
}

function createServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6, pingTimeout: 20000 });
  const rooms = new Map();

  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  function newCode() {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function createRoom(isPublic) {
    const code = newCode();
    const room = new Room(io, code, { isPublic, onEmpty: () => rooms.delete(code) });
    rooms.set(code, room);
    return room;
  }

  function findPublicRoom() {
    return [...rooms.values()]
      .filter((r) => r.isPublic && r.phase !== PHASE.GAME_OVER && r.players.size < r.settings.maxPlayers)
      .sort((a, b) => b.players.size - a.players.size)[0];
  }

  io.on('connection', (socket) => {
    const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
    const currentRoom = () => rooms.get(socket.data.roomCode);

    function leaveRoom() {
      const room = currentRoom();
      socket.data.roomCode = null;
      if (room) {
        socket.leave(room.code);
        room.removePlayer(socket.id);
      }
    }

    function enter(room, name, ack) {
      leaveRoom();
      const result = room.addPlayer(socket, cleanName(name));
      if (!result.ok) {
        if (room.players.size === 0) rooms.delete(room.code);
        return reply(ack, result);
      }
      socket.data.roomCode = room.code;
      return reply(ack, { ok: true, code: room.code });
    }

    socket.on('room:create', (data, ack) => {
      const isPublic = Boolean(data && data.isPublic);
      const room = createRoom(isPublic);
      // Chaos mode (voice-only answers) is only offered for private rooms.
      if (!isPublic && data && data.chaos) room.settings.chaos = true;
      enter(room, data && data.name, ack);
    });

    socket.on('room:join', (data, ack) => {
      const code = String((data && data.code) || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return reply(ack, { ok: false, error: 'Room not found. Check the code and try again.' });
      if (room.code === socket.data.roomCode) return reply(ack, { ok: true, code });
      return enter(room, data && data.name, ack);
    });

    socket.on('room:quick', (data, ack) => {
      enter(findPublicRoom() || createRoom(true), data && data.name, ack);
    });

    socket.on('room:leave', leaveRoom);
    socket.on('room:settings', (s) => currentRoom()?.updateSettings(socket.id, s));
    socket.on('game:start', () => currentRoom()?.startGame(socket.id));
    socket.on('word:choose', (i) => currentRoom()?.chooseWord(socket.id, i));
    socket.on('draw', (ops) => currentRoom()?.handleDraw(socket, ops));
    socket.on('canvas:undo', () => currentRoom()?.undo(socket.id));
    socket.on('canvas:clear', () => currentRoom()?.clearCanvas(socket.id));
    socket.on('chat', (text) => currentRoom()?.handleChat(socket, text));
    socket.on('chat:voice', (payload) => currentRoom()?.handleVoice(socket, payload));
    socket.on('player:kick', (id) => currentRoom()?.kick(socket.id, id));
    socket.on('disconnect', leaveRoom);
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const { server, io } = createServer();
  server.listen(PORT, () => console.log(`TOA Draw listening on port ${PORT}`));

  const shutdown = () => {
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
