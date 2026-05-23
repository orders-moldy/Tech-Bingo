const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const FREE_INDEX = 12;
const CARD_PHRASES = 24;
const COOLDOWN_GAMES = 3;
const AUTO_RESET_SECONDS = 6; // countdown before next game starts

const allPhrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));
let gameCount = 0;
let recentLog = [];
let players = {};
let game = { id: 0, active: true, winner: null };
let scores = {}; // key: "name|campus" -> { name, campus, wins }

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
  return [...picked.slice(0, FREE_INDEX), 'FREE', ...picked.slice(FREE_INDEX)];
}

function getScoreboard() {
  return Object.values(scores).sort((a, b) => b.wins - a.wins);
}

function broadcastPlayers() {
  const list = Object.values(players).map(p => ({ name: p.name, campus: p.campus }));
  io.emit('players', list);
}

function hasBingo(marked) {
  const s = new Set(marked);
  return WIN_LINES.some(line => line.every(i => s.has(i)));
}

function startNewGame() {
  gameCount++;
  game = { id: gameCount, active: true, winner: null };
  for (const [id, p] of Object.entries(players)) {
    p.card = makeCard();
    p.marked = [FREE_INDEX];
    p.gameId = game.id;
    io.to(id).emit('new_game', { card: p.card, marked: p.marked, gameId: game.id });
  }
}

io.on('connection', socket => {
  socket.on('join', ({ name, campus }) => {
    if (players[socket.id]) return;
    const card = makeCard();
    const marked = [FREE_INDEX];
    players[socket.id] = { name, campus, card, marked, gameId: game.id };
    socket.emit('joined', {
      card, marked, gameId: game.id,
      winner: game.winner,
      scoreboard: getScoreboard()
    });
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
      recentLog.push({ game: gameCount, phrases: p.card.filter(c => c !== 'FREE') });

      // Update scoreboard
      const key = `${p.name}|${p.campus}`;
      if (!scores[key]) scores[key] = { name: p.name, campus: p.campus, wins: 0 };
      scores[key].wins++;

      io.emit('bingo', { winner: p.name, scoreboard: getScoreboard(), resetIn: AUTO_RESET_SECONDS });

      // Auto-reset after countdown
      setTimeout(startNewGame, AUTO_RESET_SECONDS * 1000);
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastPlayers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo running on http://localhost:${PORT}`));
