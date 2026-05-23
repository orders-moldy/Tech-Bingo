const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const FREE_INDEX = 12;
const CARD_PHRASES = 24; // 25 cells minus the FREE space
const COOLDOWN_GAMES = 3; // how many games before a phrase can reappear

const allPhrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));
let gameCount = 0;
let recentLog = []; // [{ game: N, phrases: [...] }]
let players = {};   // socketId -> { name, card, marked, gameId }
let game = { id: 0, active: true, winner: null };

const WIN_LINES = [
  [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
  [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
  [0,6,12,18,24], [4,8,12,16,20],
];

function getPool() {
  const cutoff = gameCount - COOLDOWN_GAMES;
  const onCooldown = new Set(
    recentLog.filter(e => e.game > cutoff).flatMap(e => e.phrases)
  );
  const pool = allPhrases.filter(p => !onCooldown.has(p));
  return pool.length >= CARD_PHRASES ? pool : allPhrases;
}

function makeCard() {
  const pool = getPool();
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, CARD_PHRASES);
  // Insert FREE in the center (index 12 of a 5x5 grid)
  return [...picked.slice(0, FREE_INDEX), 'FREE', ...picked.slice(FREE_INDEX)];
}

function broadcastPlayers() {
  const names = Object.values(players).map(p => p.name);
  io.emit('players', names);
}

function hasBingo(marked) {
  const s = new Set(marked);
  return WIN_LINES.some(line => line.every(i => s.has(i)));
}

io.on('connection', socket => {
  socket.on('join', name => {
    if (players[socket.id]) return;
    const card = makeCard();
    const marked = [FREE_INDEX];
    players[socket.id] = { name, card, marked, gameId: game.id };
    socket.emit('joined', { card, marked, gameId: game.id, winner: game.winner });
    broadcastPlayers();
  });

  socket.on('mark', idx => {
    const p = players[socket.id];
    if (!p || idx === FREE_INDEX || p.gameId !== game.id || !game.active) return;
    if (p.marked.includes(idx)) return;
    p.marked.push(idx);

    if (hasBingo(p.marked) && !game.winner) {
      game.winner = p.name;
      game.active = false;
      // Log phrases from this card to cooldown pool
      recentLog.push({ game: gameCount, phrases: p.card.filter(c => c !== 'FREE') });
      io.emit('bingo', p.name);
    }
  });

  socket.on('new_game', () => {
    if (game.active) return;
    gameCount++;
    game = { id: gameCount, active: true, winner: null };
    for (const [id, p] of Object.entries(players)) {
      p.card = makeCard();
      p.marked = [FREE_INDEX];
      p.gameId = game.id;
      io.to(id).emit('new_game', { card: p.card, marked: p.marked, gameId: game.id });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastPlayers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo running on http://localhost:${PORT}`));
