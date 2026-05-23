const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const FREE_INDEX = 12;
const CARD_PHRASES = 24;
const COOLDOWN_GAMES = 3;
const AUTO_RESET_SECONDS = 6;

const allPhrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));
let gameCount = 0;
let recentLog = [];
let players = {};
let game = { id: 0, active: true, winner: null };

// ── Database setup (falls back to in-memory if no DATABASE_URL) ──

let pool = null;
let memScores = {}; // fallback: "name|campus|day" -> { name, campus, day, wins }

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function initDB() {
  if (!pool) {
    console.log('No DATABASE_URL — using in-memory scores (resets on server restart)');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wins (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      campus TEXT NOT NULL,
      day TEXT NOT NULL,
      weekend_start TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database connected ✓');
}

function getWeekendInfo() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const sat = new Date(now);

  let dayName;
  if (day === 6) {
    dayName = 'Saturday';
  } else if (day === 0) {
    dayName = 'Sunday';
    sat.setDate(now.getDate() - 1); // go back to Saturday
  } else {
    dayName = 'Saturday'; // weekday — treat as upcoming Saturday for testing
    sat.setDate(now.getDate() + (6 - day));
  }

  sat.setHours(0, 0, 0, 0);
  return { day: dayName, weekendStart: sat.toISOString().split('T')[0] };
}

async function recordWin(name, campus) {
  const { day, weekendStart } = getWeekendInfo();
  if (pool) {
    await pool.query(
      'INSERT INTO wins (name, campus, day, weekend_start) VALUES ($1, $2, $3, $4)',
      [name, campus, day, weekendStart]
    );
  } else {
    const key = `${name}|${campus}|${day}`;
    if (!memScores[key]) memScores[key] = { name, campus, day, wins: 0 };
    memScores[key].wins++;
  }
}

async function getScoreboard() {
  let rows = [];

  if (pool) {
    const { weekendStart } = getWeekendInfo();
    const result = await pool.query(
      `SELECT name, campus, day, COUNT(*) AS wins
       FROM wins WHERE weekend_start = $1
       GROUP BY name, campus, day`,
      [weekendStart]
    );
    rows = result.rows.map(r => ({ ...r, wins: parseInt(r.wins) }));
  } else {
    rows = Object.values(memScores);
  }

  // Aggregate per player
  const byPlayer = {};
  for (const row of rows) {
    const key = `${row.name}|${row.campus}`;
    if (!byPlayer[key]) byPlayer[key] = { name: row.name, campus: row.campus, saturday: 0, sunday: 0, total: 0 };
    if (row.day === 'Saturday') byPlayer[key].saturday += row.wins;
    if (row.day === 'Sunday')   byPlayer[key].sunday   += row.wins;
    byPlayer[key].total += row.wins;
  }

  const list = Object.values(byPlayer).sort((a, b) => b.total - a.total);
  const maxBy = (arr, fn) => arr.length ? arr.reduce((best, x) => fn(x) > fn(best) ? x : best) : null;

  return {
    list,
    weekendLeader: list[0] || null,
    satLeader: maxBy(list.filter(p => p.saturday > 0), p => p.saturday),
    sunLeader: maxBy(list.filter(p => p.sunday   > 0), p => p.sunday),
  };
}

// ── Admin reset endpoint ──

app.post('/admin/reset', async (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    if (pool) await pool.query('DELETE FROM wins');
    else memScores = {};
    const scoreboard = await getScoreboard();
    io.emit('scoreboard_update', scoreboard);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ── Game logic ──

const WIN_LINES = [
  [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
  [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
  [0,6,12,18,24], [4,8,12,16,20],
];

function getPool() {
  const cutoff = gameCount - COOLDOWN_GAMES;
  const onCooldown = new Set(recentLog.filter(e => e.game > cutoff).flatMap(e => e.phrases));
  const pool = allPhrases.filter(p => !onCooldown.has(p));
  return pool.length >= CARD_PHRASES ? pool : allPhrases;
}

function makeCard() {
  const pool = getPool();
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, CARD_PHRASES);
  return [...picked.slice(0, FREE_INDEX), 'FREE', ...picked.slice(FREE_INDEX)];
}

function hasBingo(marked) {
  const s = new Set(marked);
  return WIN_LINES.some(line => line.every(i => s.has(i)));
}

function broadcastPlayers() {
  const list = Object.values(players).map(p => ({ name: p.name, campus: p.campus }));
  io.emit('players', list);
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
  socket.on('join', async ({ name, campus }) => {
    if (players[socket.id]) return;
    const card = makeCard();
    const marked = [FREE_INDEX];
    players[socket.id] = { name, campus, card, marked, gameId: game.id };
    const scoreboard = await getScoreboard().catch(() => ({ list: [], weekendLeader: null, satLeader: null, sunLeader: null }));
    socket.emit('joined', { card, marked, gameId: game.id, winner: game.winner, scoreboard });
    broadcastPlayers();
  });

  socket.on('mark', async idx => {
    const p = players[socket.id];
    if (!p || idx === FREE_INDEX || p.gameId !== game.id || !game.active) return;
    if (p.marked.includes(idx)) return;
    p.marked.push(idx);

    if (hasBingo(p.marked) && !game.winner) {
      game.winner = p.name;
      game.active = false;
      recentLog.push({ game: gameCount, phrases: p.card.filter(c => c !== 'FREE') });

      try { await recordWin(p.name, p.campus); } catch (err) { console.error('recordWin failed:', err); }
      const scoreboard = await getScoreboard().catch(() => ({ list: [], weekendLeader: null, satLeader: null, sunLeader: null }));

      io.emit('bingo', { winner: p.name, scoreboard, resetIn: AUTO_RESET_SECONDS });
      setTimeout(startNewGame, AUTO_RESET_SECONDS * 1000);
    }
  });

  socket.on('leave', () => {
    delete players[socket.id];
    broadcastPlayers();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastPlayers();
  });
});

// ── Start ──

initDB()
  .catch(err => { console.error('DB init error:', err.message); pool = null; })
  .finally(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Bingo running on http://localhost:${PORT}`));
  });
