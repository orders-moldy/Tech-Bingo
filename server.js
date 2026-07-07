// ─────────────────────────────────────────────────────────────
//  TCC Tech Bingo — server
//
//  Sections:
//    1. Config & state
//    2. Database (PostgreSQL, falls back to in-memory)
//    3. Scoreboard & weekend logic
//    4. Email summary
//    5. Admin endpoints (login / suspend / reset)
//    6. Game logic (cards, win detection, phrase rotation)
//    7. Socket handlers (join / mark / leave)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// ── 1. Config & state ──

const FREE_INDEX = 12;            // center square of the 5×5 card
const CARD_SIZE = 25;
const CARD_PHRASES = 24;          // phrases per card (24 + FREE)
const COOLDOWN_GAMES = 3;         // games before a winning card's phrases can reappear
const AUTO_RESET_SECONDS = 6;     // countdown after a bingo before new cards deal
const MAX_NAME_LENGTH = 20;
const DEVICE_EXPIRY_MS = 24 * 60 * 60 * 1000; // forget devices not seen for 24h (feeds the admin "recently active" list)
const SUMMARY_EMAIL_TO = 'mbeacom@ampliosystems.com';

const CAMPUSES = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

const allPhrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));

let gameCount = 0;
let recentLog = [];     // [{ game, phrases }] — winning cards, for phrase cooldown
let players = {};       // socketId -> playerState
let devicePlayers = {}; // deviceId -> playerState (survives disconnects)
let game = { id: 0, active: true, winner: null };
let phraseCounts = {};  // phrase -> times marked (drives "Most Marked")
let suspended = false;  // admin paused play to show the stats screen

// Chat — in-memory only; history is lost when the server sleeps (fine for a weekly event)
const CHAT_HISTORY_MAX = 50;    // ring buffer sent to new joiners
const CHAT_MSG_MAX_LENGTH = 200;
const CHAT_COOLDOWN_MS = 1500;  // min gap between messages per player
const CHAT_LOG_MAX = 2000;      // memory-mode cap for the full weekend log
let chatHistory = [];           // [{ name, campus, text, ts }]
let memChatLog = [];            // full weekend log fallback when no DB

// Reject anything a malicious client might sneak into a join payload.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[<>]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return name.length ? name : null;
}

function isValidCampus(campus) {
  return CAMPUSES.includes(campus);
}

// ── 2. Database (falls back to in-memory if no DATABASE_URL) ──

let pool = null;
let memScores = {};  // "name|campus|day" -> { name, campus, day, weekendStart, wins }
let memArchive = []; // past-weekend rows moved here on reset (memory mode only)

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
  // Older deploys predate the archive flag — add it if missing
  await pool.query(`ALTER TABLE wins ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`);
  // Weekend chat log for the admin dashboard (wiped at reset)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      campus TEXT NOT NULL,
      text TEXT NOT NULL,
      ts BIGINT NOT NULL
    )
  `);
  console.log('Database connected ✓');
}

// ── 3. Scoreboard & weekend logic ──

// Weekend runs Saturday→Sunday in Chicago time (covers the 6pm Saturday service
// even though the server runs in UTC). Weekday wins count toward the upcoming weekend.
function getWeekendInfo() {
  const tz = process.env.TZ || 'America/Chicago';
  const now = new Date();

  const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const localDate = now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

  const [month, day, year] = localDate.split('/');
  const localDay = new Date(`${year}-${month}-${day}`);
  const daysToSat = { Sunday: -1, Saturday: 0, Monday: 6, Tuesday: 5, Wednesday: 4, Thursday: 3, Friday: 2 };
  const sat = new Date(localDay);
  sat.setDate(localDay.getDate() + (daysToSat[dayName] ?? 0));

  const label = (dayName === 'Saturday' || dayName === 'Sunday') ? dayName : 'Saturday';
  return { day: label, weekendStart: sat.toISOString().split('T')[0] };
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
    if (!memScores[key]) memScores[key] = { name, campus, day, weekendStart, wins: 0 };
    memScores[key].wins++;
  }
}

const EMPTY_SCOREBOARD = { list: [], weekendLeader: null, satLeader: null, sunLeader: null };

async function getScoreboard() {
  let rows = [];

  if (pool) {
    const { weekendStart } = getWeekendInfo();
    const result = await pool.query(
      `SELECT name, campus, day, COUNT(*) AS wins
       FROM wins WHERE weekend_start = $1 AND archived = FALSE
       GROUP BY name, campus, day`,
      [weekendStart]
    );
    rows = result.rows.map(r => ({ ...r, wins: parseInt(r.wins) }));
  } else {
    rows = Object.values(memScores);
  }

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

// ── 4. Email summary ──

function buildEmailHtml({ list, weekendLeader, satLeader, sunLeader }, popularTiles) {
  const row = (icon, label, entry, wins) => `
    <tr>
      <td style="padding:6px 12px;font-size:15px;">${icon}</td>
      <td style="padding:6px 12px;">
        <strong>${label}</strong><br>
        <span style="color:#555;">${entry.name} &mdash; ${entry.campus}</span>
      </td>
      <td style="padding:6px 12px;font-size:1.3rem;font-weight:800;color:#9BB6BF;text-align:right;">${wins}</td>
    </tr>`;

  const leaders = [
    weekendLeader ? row('🏆', 'Weekend Leader', weekendLeader, weekendLeader.total) : '',
    satLeader     ? row('📅', 'Saturday Leader', satLeader,     satLeader.saturday)  : '',
    sunLeader     ? row('📅', 'Sunday Leader',   sunLeader,     sunLeader.sunday)    : '',
  ].join('');

  const fullList = list.map((e, i) => `
    <tr style="border-top:1px solid #eee;">
      <td style="padding:5px 12px;color:#999;">${i + 1}.</td>
      <td style="padding:5px 12px;">${e.name} <span style="color:#aaa;font-size:0.85em;">${e.campus}</span></td>
      <td style="padding:5px 12px;text-align:right;">
        ${e.total} total
        <span style="color:#aaa;font-size:0.8em;">(Sat&nbsp;${e.saturday} / Sun&nbsp;${e.sunday})</span>
      </td>
    </tr>`).join('');

  const popular = (popularTiles || []).map((phrase, i) => `
    <tr style="border-top:1px solid #eee;">
      <td style="padding:5px 12px;color:#999;">${i + 1}.</td>
      <td style="padding:5px 12px;">${phrase}</td>
    </tr>`).join('');

  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#222;">
      <h2 style="color:#9BB6BF;margin-bottom:4px;">TCC Tech Bingo</h2>
      <p style="color:#777;margin-top:0;">Weekend leaderboard summary (captured at reset)</p>

      ${leaders ? `
      <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
        ${leaders}
      </table>` : '<p style="color:#aaa;">No wins recorded this weekend.</p>'}

      ${list.length ? `
      <h3 style="margin-bottom:8px;">Full Scoreboard</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${fullList}
      </table>` : ''}

      ${popular ? `
      <h3 style="margin-bottom:8px;">🔥 Most Marked Tiles</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${popular}
      </table>` : ''}
    </div>`;
}

async function sendSummaryEmail(scoreboard, popularTiles) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('No email credentials — skipping summary email');
    return;
  }
  if (!scoreboard.list.length) return; // nothing to report

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `TCC Tech Bingo <${process.env.GMAIL_USER}>`,
    to: SUMMARY_EMAIL_TO,
    subject: 'TCC Tech Bingo — Weekend Leaderboard Summary',
    html: buildEmailHtml(scoreboard, popularTiles),
  });

  console.log('Summary email sent');
}

// ── 5. Admin endpoints ──

function checkPassword(password) {
  return Boolean(process.env.ADMIN_PASSWORD) && password === process.env.ADMIN_PASSWORD;
}

// Verifies the password up front so the admin page only unlocks for real admins.
app.post('/admin/login', (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ ok: true, suspended });
});

// Snapshot for the admin dashboard: live counts + current weekend standings.
app.post('/admin/overview', async (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    res.json({
      ok: true,
      suspended,
      playersOnline: Object.keys(players).length,
      gamesThisSession: gameCount,
      phraseCount: allPhrases.length,
      scoreboard,
      popularTiles: getPopularTiles(),
    });
  } catch (err) {
    console.error('Overview failed:', err.message);
    res.status(500).json({ error: 'Could not load overview' });
  }
});

// Player roster for the admin dashboard: who's connected right now, plus
// devices seen in the last 24h. Both carry weekend win counts and device type.
app.post('/admin/players', async (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    const winsFor = (name, campus) =>
      scoreboard.list.find(p => p.name === name && p.campus === campus)?.total || 0;
    const info = p => ({ name: p.name, campus: p.campus, device: p.device || null, wins: winsFor(p.name, p.campus), lastSeen: p.lastSeen || null });

    const activeStates = new Set(Object.values(players));
    const active = [...activeStates].map(info);

    const cutoff = Date.now() - DEVICE_EXPIRY_MS;
    const recent = Object.values(devicePlayers)
      .filter(p => !activeStates.has(p) && (p.lastSeen || 0) >= cutoff)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .map(info);

    res.json({ ok: true, active, recent });
  } catch (err) {
    console.error('Players failed:', err.message);
    res.status(500).json({ error: 'Could not load players' });
  }
});

// Full chat log for the current weekend (admin dashboard). Cleared at reset.
app.post('/admin/chat', async (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    let messages;
    if (pool) {
      const result = await pool.query(
        'SELECT name, campus, text, ts FROM chat_messages ORDER BY ts DESC LIMIT 1000'
      );
      messages = result.rows.map(r => ({ ...r, ts: Number(r.ts) })).reverse();
    } else {
      messages = memChatLog;
    }
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('Chat log failed:', err.message);
    res.status(500).json({ error: 'Could not load chat log' });
  }
});

// Suspend pauses all marking and pushes the stats overlay to every player.
// { active: true } resumes play, { active: false } suspends it.
app.post('/admin/suspend', async (req, res) => {
  const { password, active } = req.body;
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  suspended = (active === false);
  if (suspended) {
    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    io.emit('suspend', { scoreboard, popularTiles: getPopularTiles() });
  } else {
    io.emit('resume');
  }
  res.json({ ok: true, suspended });
});

app.post('/admin/reset', async (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    // Capture stats BEFORE wiping so the email has something to report
    const scoreboard = await getScoreboard();
    const popularTiles = getPopularTiles();

    // Archive rather than delete — wins stay queryable for the history view
    if (pool) {
      await pool.query('UPDATE wins SET archived = TRUE WHERE archived = FALSE');
    } else {
      memArchive.push(...Object.values(memScores));
      memScores = {};
    }
    phraseCounts = {};

    sendSummaryEmail(scoreboard, popularTiles).catch(err => console.error('Email failed:', err.message));

    // A reset means the event is over — make sure nobody is stuck on the stats screen
    if (suspended) {
      suspended = false;
      io.emit('resume');
    }

    // Fresh weekend, fresh chat — the archived log disappears with the reset
    chatHistory = [];
    memChatLog = [];
    if (pool) await pool.query('DELETE FROM chat_messages');
    io.emit('chat_history', []);

    io.emit('scoreboard_update', { ...EMPTY_SCOREBOARD, popularTiles: [] });
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset failed:', err.message);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// All-time win history (archived + current), grouped by weekend.
// Powers the admin history view so repeat winners show up across weekends.
async function getHistory() {
  let rows = [];

  if (pool) {
    const result = await pool.query(
      `SELECT name, campus, weekend_start, COUNT(*)::int AS wins
       FROM wins GROUP BY name, campus, weekend_start`
    );
    rows = result.rows;
  } else {
    rows = [...memArchive, ...Object.values(memScores)].map(r => ({
      name: r.name, campus: r.campus, weekend_start: r.weekendStart || 'unknown', wins: r.wins,
    }));
  }

  // Group per weekend, combining a player's Saturday + Sunday wins
  const byWeekend = {};
  for (const row of rows) {
    const wk = byWeekend[row.weekend_start] ??= {};
    const key = `${row.name}|${row.campus}`;
    if (!wk[key]) wk[key] = { name: row.name, campus: row.campus, wins: 0 };
    wk[key].wins += row.wins;
  }

  const weekends = Object.entries(byWeekend)
    .sort((a, b) => b[0].localeCompare(a[0])) // newest first
    .map(([weekendStart, playerMap]) => ({
      weekendStart,
      players: Object.values(playerMap).sort((a, b) => b.wins - a.wins),
    }));

  // All-time totals + championship count (most wins in a weekend = 1 title)
  const allTimeMap = {};
  for (const wk of weekends) {
    const topWins = wk.players[0]?.wins || 0;
    for (const p of wk.players) {
      const key = `${p.name}|${p.campus}`;
      if (!allTimeMap[key]) allTimeMap[key] = { name: p.name, campus: p.campus, wins: 0, titles: 0 };
      allTimeMap[key].wins += p.wins;
      if (p.wins === topWins) allTimeMap[key].titles++;
    }
  }
  const allTime = Object.values(allTimeMap).sort((a, b) => b.wins - a.wins || b.titles - a.titles);

  return { weekends, allTime };
}

app.post('/admin/history', async (req, res) => {
  if (!checkPassword(req.body.password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    res.json({ ok: true, ...await getHistory() });
  } catch (err) {
    console.error('History failed:', err.message);
    res.status(500).json({ error: 'Could not load history' });
  }
});

// ── 6. Game logic ──

const WIN_LINES = [
  [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
  [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
  [0,6,12,18,24], [4,8,12,16,20],
];

// Phrases from recent winning cards sit out for COOLDOWN_GAMES games so
// cards feel fresh week to week. Falls back to the full list if too few remain.
function getPhrasePool() {
  const cutoff = gameCount - COOLDOWN_GAMES;
  const onCooldown = new Set(recentLog.filter(e => e.game > cutoff).flatMap(e => e.phrases));
  const available = allPhrases.filter(p => !onCooldown.has(p));
  return available.length >= CARD_PHRASES ? available : allPhrases;
}

function makeCard() {
  const shuffled = getPhrasePool().slice().sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, CARD_PHRASES);
  return [...picked.slice(0, FREE_INDEX), 'FREE', ...picked.slice(FREE_INDEX)];
}

function hasBingo(marked) {
  const s = new Set(marked);
  return WIN_LINES.some(line => line.every(i => s.has(i)));
}

// "Hot" = one tile away from bingo on any line (drives the glow on player chips)
function isOneAway(marked) {
  const s = new Set(marked);
  return WIN_LINES.some(line => line.filter(i => !s.has(i)).length === 1);
}

function getPopularTiles() {
  return Object.entries(phraseCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([phrase]) => phrase);
}

function broadcastPlayers() {
  const list = Object.values(players).map(p => ({ name: p.name, campus: p.campus, hot: p.hot || false }));
  io.emit('players', list);
}

function startNewGame() {
  gameCount++;
  game = { id: gameCount, active: true, winner: null };

  // Prune cooldown log — anything older than the window will never matter again
  recentLog = recentLog.filter(e => e.game > gameCount - COOLDOWN_GAMES);

  for (const [id, p] of Object.entries(players)) {
    p.card = makeCard();
    p.marked = [FREE_INDEX];
    p.gameId = game.id;
    p.hot = false;
    io.to(id).emit('new_game', { card: p.card, marked: p.marked, gameId: game.id });
  }
  broadcastPlayers();
}

// Forget devices that haven't been seen in a while so the map can't grow forever
setInterval(() => {
  const cutoff = Date.now() - DEVICE_EXPIRY_MS;
  for (const [deviceId, state] of Object.entries(devicePlayers)) {
    if ((state.lastSeen || 0) < cutoff) delete devicePlayers[deviceId];
  }
}, 60 * 60 * 1000);

// ── 7. Socket handlers ──

io.on('connection', socket => {
  socket.on('join', async ({ name: rawName, campus, deviceId, deviceType } = {}) => {
    if (players[socket.id]) return;

    const name = cleanName(rawName);
    if (!name || !isValidCampus(campus)) return;
    const device = ['mobile', 'desktop'].includes(deviceType) ? deviceType : null;

    let state = deviceId ? devicePlayers[deviceId] : null;

    if (state) {
      // Returning device — kick any old tab still holding this player, restore state
      const oldSocketId = Object.entries(players).find(([, p]) => p === state)?.[0];
      if (oldSocketId && oldSocketId !== socket.id) {
        delete players[oldSocketId];
        io.to(oldSocketId).emit('kicked');
      }

      // If the game moved on since they left, deal them a fresh card
      if (state.gameId !== game.id) {
        state.card   = makeCard();
        state.marked = [FREE_INDEX];
        state.gameId = game.id;
        state.hot    = false;
      }
    } else {
      state = { name, campus, card: makeCard(), marked: [FREE_INDEX], gameId: game.id, hot: false, deviceId: deviceId || null };
      if (deviceId) devicePlayers[deviceId] = state;
    }

    if (device) state.device = device;
    state.lastSeen = Date.now();
    players[socket.id] = state;

    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    socket.emit('joined', {
      card: state.card,
      marked: state.marked,
      gameId: state.gameId,
      winner: game.winner,
      scoreboard,
      name: state.name,
      popularTiles: getPopularTiles(),
      suspended,
      chatHistory,
    });
    broadcastPlayers();
  });

  socket.on('chat', text => {
    const p = players[socket.id];
    if (!p || suspended) return;                       // must be joined; quiet during stats
    if (typeof text !== 'string') return;
    const clean = text.replace(/[<>]/g, '').trim().slice(0, CHAT_MSG_MAX_LENGTH);
    if (!clean) return;
    const now = Date.now();
    if (p.lastChatAt && now - p.lastChatAt < CHAT_COOLDOWN_MS) return;  // rate limit
    p.lastChatAt = now;

    const msg = { name: p.name, campus: p.campus, text: clean, ts: now };
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();

    // Persist the full weekend log for the admin dashboard (best-effort)
    if (pool) {
      pool.query('INSERT INTO chat_messages (name, campus, text, ts) VALUES ($1, $2, $3, $4)',
        [msg.name, msg.campus, msg.text, msg.ts])
        .catch(err => console.error('chat save failed:', err.message));
    } else {
      memChatLog.push(msg);
      if (memChatLog.length > CHAT_LOG_MAX) memChatLog.shift();
    }

    io.emit('chat', msg);
  });

  socket.on('mark', async idx => {
    const p = players[socket.id];
    if (!p || p.gameId !== game.id || !game.active || suspended) return;
    if (!Number.isInteger(idx) || idx < 0 || idx >= CARD_SIZE || idx === FREE_INDEX) return;
    if (p.marked.includes(idx)) return;

    p.marked.push(idx);
    p.lastSeen = Date.now();

    const phrase = p.card[idx];
    if (phrase && phrase !== 'FREE') {
      phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    }

    const wasHot = p.hot || false;
    p.hot = !hasBingo(p.marked) && isOneAway(p.marked);
    if (p.hot !== wasHot) broadcastPlayers();

    if (hasBingo(p.marked) && !game.winner) {
      game.winner = p.name;
      game.active = false;
      recentLog.push({ game: gameCount, phrases: p.card.filter(c => c !== 'FREE') });

      try { await recordWin(p.name, p.campus); } catch (err) { console.error('recordWin failed:', err); }
      const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);

      io.emit('bingo', { winner: p.name, scoreboard, resetIn: AUTO_RESET_SECONDS, popularTiles: getPopularTiles() });
      setTimeout(startNewGame, AUTO_RESET_SECONDS * 1000);
    }
  });

  // Explicit leave (logo tap) — forget the device so they can rejoin fresh
  socket.on('leave', () => {
    const p = players[socket.id];
    if (p?.deviceId) delete devicePlayers[p.deviceId];
    delete players[socket.id];
    broadcastPlayers();
  });

  // Disconnect (closed tab, lost signal) — keep device state so they can reconnect
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
