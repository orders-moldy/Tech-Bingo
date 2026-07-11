// ─────────────────────────────────────────────────────────────
//  TCC Tech Bingo — server
//
//  Sections:
//    1. Config & state
//    2. Database (PostgreSQL, falls back to in-memory)
//    3. Scoreboard & weekend logic
//    4. Admin endpoints (auth / suspend / reset / editors)
//    5. Game logic (cards, win detection, phrase rotation)
//    6. Socket handlers (join / mark / leave / chat)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1); // Render sits behind a proxy — needed for real client IPs
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

// Seed list; once a database is connected the DB copy becomes the source of
// truth (editable from the admin dashboard's Campuses tab).
let allCampuses = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

// Seed list; once a database is connected the DB copy becomes the source of
// truth (editable from the admin dashboard) and this file is only the seed.
let allPhrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));

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
  return allCampuses.includes(campus);
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
  // Older deploys predate these columns — add them if missing
  await pool.query(`ALTER TABLE wins ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE wins ADD COLUMN IF NOT EXISTS device_id TEXT`);
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
  // Editable phrase list — seeded from phrases.json the first time, then the
  // DB copy is the source of truth so admin edits survive restarts/deploys
  await pool.query(`
    CREATE TABLE IF NOT EXISTS phrases (
      id SERIAL PRIMARY KEY,
      text TEXT UNIQUE NOT NULL
    )
  `);
  const { rows } = await pool.query('SELECT text FROM phrases ORDER BY id');
  if (rows.length === 0) {
    for (const p of allPhrases) {
      await pool.query('INSERT INTO phrases (text) VALUES ($1) ON CONFLICT DO NOTHING', [p]);
    }
    console.log(`Seeded ${allPhrases.length} phrases into the database`);
  } else {
    allPhrases = rows.map(r => r.text);
  }
  // Editable campus list — same seed-then-DB pattern as phrases
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campuses (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )
  `);
  const campusRows = await pool.query('SELECT name FROM campuses ORDER BY id');
  if (campusRows.rows.length === 0) {
    for (const c of allCampuses) {
      await pool.query('INSERT INTO campuses (name) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
    }
    console.log(`Seeded ${allCampuses.length} campuses into the database`);
  } else {
    allCampuses = campusRows.rows.map(r => r.name);
  }
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

// Wins are keyed by device so two people who happen to pick the same
// name at the same campus still count as separate players.
async function recordWin({ name, campus, deviceId }) {
  const { day, weekendStart } = getWeekendInfo();
  if (pool) {
    await pool.query(
      'INSERT INTO wins (name, campus, day, weekend_start, device_id) VALUES ($1, $2, $3, $4, $5)',
      [name, campus, day, weekendStart, deviceId || null]
    );
  } else {
    const key = `${deviceId || name}|${campus}|${day}`;
    if (!memScores[key]) memScores[key] = { name, campus, day, weekendStart, deviceId: deviceId || null, wins: 0 };
    memScores[key].wins++;
  }
}

// Identity key for scoreboard grouping: device when known, else name+campus
// (covers rows recorded before device tracking existed)
const playerKey = row => (row.device_id || row.deviceId) ? `d:${row.device_id || row.deviceId}` : `${row.name}|${row.campus}`;

const EMPTY_SCOREBOARD = { list: [], weekendLeader: null, satLeader: null, sunLeader: null };

async function getScoreboard() {
  let rows = [];

  if (pool) {
    const { weekendStart } = getWeekendInfo();
    const result = await pool.query(
      `SELECT name, campus, day, device_id, COUNT(*) AS wins
       FROM wins WHERE weekend_start = $1 AND archived = FALSE
       GROUP BY name, campus, day, device_id`,
      [weekendStart]
    );
    rows = result.rows.map(r => ({ ...r, wins: parseInt(r.wins) }));
  } else {
    rows = Object.values(memScores);
  }

  const byPlayer = {};
  for (const row of rows) {
    const key = playerKey(row);
    if (!byPlayer[key]) byPlayer[key] = { name: row.name, campus: row.campus, deviceId: row.device_id || row.deviceId || null, saturday: 0, sunday: 0, total: 0 };
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

// ── 4. Admin endpoints ──

// Public: the join screen fills its campus dropdown from this
app.get('/campuses', (req, res) => {
  res.json({ campuses: allCampuses });
});

function checkPassword(password) {
  return Boolean(process.env.ADMIN_PASSWORD) && password === process.env.ADMIN_PASSWORD;
}

// Brute-force protection: 8 wrong passwords from one IP locks that IP out
// of every admin endpoint for 15 minutes.
const AUTH_MAX_FAILS = 8;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
const authFails = {}; // ip -> { count, firstAt }

function requireAdmin(req, res, next) {
  const ip = req.ip;
  const rec = authFails[ip];
  if (rec && Date.now() - rec.firstAt >= AUTH_LOCKOUT_MS) delete authFails[ip];
  if (authFails[ip] && authFails[ip].count >= AUTH_MAX_FAILS) {
    return res.status(429).json({ error: 'Too many attempts — locked out for 15 minutes' });
  }
  if (!checkPassword(req.body.password)) {
    const r = authFails[ip] ??= { count: 0, firstAt: Date.now() };
    r.count++;
    return res.status(401).json({ error: 'Wrong password' });
  }
  delete authFails[ip];
  next();
}

// Verifies the password up front so the admin page only unlocks for real admins.
app.post('/admin/login', requireAdmin, (req, res) => {
  res.json({ ok: true, suspended });
});

// Snapshot for the admin dashboard: live counts + current weekend standings.
app.post('/admin/overview', requireAdmin, async (req, res) => {
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
app.post('/admin/players', requireAdmin, async (req, res) => {
  try {
    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    const winsFor = p => scoreboard.list.find(e =>
      e.deviceId ? e.deviceId === p.deviceId : (e.name === p.name && e.campus === p.campus))?.total || 0;
    const info = p => ({ name: p.name, campus: p.campus, device: p.device || null, wins: winsFor(p), lastSeen: p.lastSeen || null });

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
app.post('/admin/chat', requireAdmin, async (req, res) => {
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

// Phrase list editor. Actions: list / add / edit / remove.
// Changes apply to cards dealt from the next game onward.

const MAX_PHRASE_LENGTH = 60;

function cleanPhrase(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[<>]/g, '').trim().slice(0, MAX_PHRASE_LENGTH);
  return text.length ? text : null;
}

// Local fallback when no database — keeps phrases.json in sync so edits
// persist across restarts in local development
function savePhrasesToFile() {
  try {
    fs.writeFileSync('phrases.json', JSON.stringify(allPhrases, null, 2) + '\n');
  } catch (err) {
    console.error('Could not write phrases.json:', err.message);
  }
}

app.post('/admin/phrases', requireAdmin, async (req, res) => {
  const { action } = req.body;
  const fail = msg => res.status(400).json({ error: msg });
  try {
    if (action === 'add') {
      const text = cleanPhrase(req.body.text);
      if (!text) return fail('Phrase cannot be empty');
      if (allPhrases.some(p => p.toLowerCase() === text.toLowerCase())) return fail('That phrase already exists');
      allPhrases.push(text);
      if (pool) await pool.query('INSERT INTO phrases (text) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
      else savePhrasesToFile();

    } else if (action === 'edit') {
      const { oldText } = req.body;
      const text = cleanPhrase(req.body.text);
      const idx = allPhrases.indexOf(oldText);
      if (idx === -1) return fail('Original phrase not found — refresh and try again');
      if (!text) return fail('Phrase cannot be empty');
      if (allPhrases.some((p, i) => i !== idx && p.toLowerCase() === text.toLowerCase())) return fail('That phrase already exists');
      allPhrases[idx] = text;
      if (pool) await pool.query('UPDATE phrases SET text = $1 WHERE text = $2', [text, oldText]);
      else savePhrasesToFile();

    } else if (action === 'remove') {
      const idx = allPhrases.indexOf(req.body.text);
      if (idx === -1) return fail('Phrase not found — refresh and try again');
      if (allPhrases.length <= CARD_PHRASES) return fail(`Can't go below ${CARD_PHRASES} phrases — a card needs ${CARD_PHRASES}`);
      allPhrases.splice(idx, 1);
      if (pool) await pool.query('DELETE FROM phrases WHERE text = $1', [req.body.text]);
      else savePhrasesToFile();
    }
    // 'list' (and every successful action) returns the current list
    res.json({ ok: true, phrases: allPhrases, min: CARD_PHRASES });
  } catch (err) {
    console.error('Phrases failed:', err.message);
    res.status(500).json({ error: 'Phrase update failed' });
  }
});

// Campus list editor. Actions: list / add / edit / remove.
// Renaming a campus also updates recorded wins and connected players.

const MAX_CAMPUS_LENGTH = 30;

function cleanCampus(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[<>]/g, '').trim().slice(0, MAX_CAMPUS_LENGTH);
  return name.length ? name : null;
}

app.post('/admin/campuses', requireAdmin, async (req, res) => {
  const { action } = req.body;
  const fail = msg => res.status(400).json({ error: msg });
  try {
    if (action === 'add') {
      const name = cleanCampus(req.body.name);
      if (!name) return fail('Campus name cannot be empty');
      if (allCampuses.some(c => c.toLowerCase() === name.toLowerCase())) return fail('That campus already exists');
      allCampuses.push(name);
      if (pool) await pool.query('INSERT INTO campuses (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);

    } else if (action === 'edit') {
      const { oldName } = req.body;
      const name = cleanCampus(req.body.name);
      const idx = allCampuses.indexOf(oldName);
      if (idx === -1) return fail('Original campus not found — refresh and try again');
      if (!name) return fail('Campus name cannot be empty');
      if (allCampuses.some((c, i) => i !== idx && c.toLowerCase() === name.toLowerCase())) return fail('That campus already exists');
      allCampuses[idx] = name;
      if (pool) {
        await pool.query('UPDATE campuses SET name = $1 WHERE name = $2', [name, oldName]);
        await pool.query('UPDATE wins SET campus = $1 WHERE campus = $2', [name, oldName]);
      } else {
        [...Object.values(memScores), ...memArchive].forEach(r => { if (r.campus === oldName) r.campus = name; });
      }
      // Move connected/recent players to the renamed campus too
      new Set([...Object.values(devicePlayers), ...Object.values(players)]).forEach(p => {
        if (p.campus === oldName) p.campus = name;
      });
      broadcastPlayers();

    } else if (action === 'remove') {
      const idx = allCampuses.indexOf(req.body.name);
      if (idx === -1) return fail('Campus not found — refresh and try again');
      if (allCampuses.length <= 1) return fail('At least one campus is required');
      allCampuses.splice(idx, 1);
      if (pool) await pool.query('DELETE FROM campuses WHERE name = $1', [req.body.name]);
      // Past wins and already-joined players keep the old name; it just
      // disappears from the join dropdown.
    }
    if (action === 'add' || action === 'edit' || action === 'remove') {
      io.emit('campuses_update', allCampuses); // join screens refresh their dropdown live
    }
    res.json({ ok: true, campuses: allCampuses });
  } catch (err) {
    console.error('Campuses failed:', err.message);
    res.status(500).json({ error: 'Campus update failed' });
  }
});

// Hard reset: permanently erases ALL game history — every win (archived
// weekends included), the chat log, and tile counts. Phrases and campuses
// survive. For clearing out test data; no summary email is sent.
app.post('/admin/hard-reset', requireAdmin, async (req, res) => {
  try {
    if (pool) {
      await pool.query('DELETE FROM wins');
      await pool.query('DELETE FROM chat_messages');
    }
    memScores = {};
    memArchive = [];
    phraseCounts = {};
    chatHistory = [];
    memChatLog = [];

    // Forget disconnected devices so tester names leave the roster too;
    // anyone still connected keeps playing untouched
    const connected = new Set(Object.values(players));
    for (const [deviceId, state] of Object.entries(devicePlayers)) {
      if (!connected.has(state)) delete devicePlayers[deviceId];
    }

    if (suspended) {
      suspended = false;
      io.emit('resume');
    }
    io.emit('scoreboard_update', { ...EMPTY_SCOREBOARD, popularTiles: [] });
    io.emit('chat_history', []);
    res.json({ ok: true });
  } catch (err) {
    console.error('Hard reset failed:', err.message);
    res.status(500).json({ error: 'Hard reset failed' });
  }
});

// Suspend pauses all marking and pushes the stats overlay to every player.
// { active: true } resumes play, { active: false } suspends it.
app.post('/admin/suspend', requireAdmin, async (req, res) => {
  const { active } = req.body;
  suspended = (active === false);
  if (suspended) {
    const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);
    io.emit('suspend', { scoreboard, popularTiles: getPopularTiles() });
  } else {
    io.emit('resume');
  }
  res.json({ ok: true, suspended });
});

app.post('/admin/reset', requireAdmin, async (req, res) => {
  try {
    // Archive rather than delete — wins stay queryable for the history view
    if (pool) {
      await pool.query('UPDATE wins SET archived = TRUE WHERE archived = FALSE');
    } else {
      memArchive.push(...Object.values(memScores));
      memScores = {};
    }
    phraseCounts = {};

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
      `SELECT name, campus, weekend_start, device_id, COUNT(*)::int AS wins
       FROM wins GROUP BY name, campus, weekend_start, device_id`
    );
    rows = result.rows;
  } else {
    rows = [...memArchive, ...Object.values(memScores)].map(r => ({
      name: r.name, campus: r.campus, weekend_start: r.weekendStart || 'unknown', device_id: r.deviceId || null, wins: r.wins,
    }));
  }

  // Group per weekend, combining a player's Saturday + Sunday wins
  const byWeekend = {};
  for (const row of rows) {
    const wk = byWeekend[row.weekend_start] ??= {};
    const key = playerKey(row);
    if (!wk[key]) wk[key] = { name: row.name, campus: row.campus, wins: 0 };
    wk[key].wins += row.wins;
  }

  const weekends = Object.entries(byWeekend)
    .sort((a, b) => b[0].localeCompare(a[0])) // newest first
    .map(([weekendStart, playerMap]) => ({
      weekendStart,
      players: Object.entries(playerMap)
        .map(([key, p]) => ({ ...p, key })) // identity key rides along for cross-weekend grouping
        .sort((a, b) => b.wins - a.wins),
    }));

  // All-time totals + championship count (most wins in a weekend = 1 title)
  const allTimeMap = {};
  for (const wk of weekends) {
    const topWins = wk.players[0]?.wins || 0;
    for (const p of wk.players) {
      if (!allTimeMap[p.key]) allTimeMap[p.key] = { name: p.name, campus: p.campus, key: p.key, wins: 0, titles: 0 };
      allTimeMap[p.key].wins += p.wins;
      if (p.wins === topWins) allTimeMap[p.key].titles++;
    }
  }
  const allTime = Object.values(allTimeMap).sort((a, b) => b.wins - a.wins || b.titles - a.titles);

  return { weekends, allTime };
}

app.post('/admin/history', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, ...await getHistory() });
  } catch (err) {
    console.error('History failed:', err.message);
    res.status(500).json({ error: 'Could not load history' });
  }
});

// ── 5. Game logic ──

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

// ── 6. Socket handlers ──

io.on('connection', socket => {
  socket.on('join', async ({ name: rawName, campus, deviceId, deviceType } = {}) => {
    if (players[socket.id]) return;

    const name = cleanName(rawName);
    if (!name || !isValidCampus(campus)) return;
    const device = ['mobile', 'desktop'].includes(deviceType) ? deviceType : null;

    let state = deviceId ? devicePlayers[deviceId] : null;

    // A different device already using this exact name at this campus?
    // Make the newcomer pick a unique name instead of silently merging.
    if (!state) {
      const known = new Set([...Object.values(devicePlayers), ...Object.values(players)]);
      const clash = [...known].some(s =>
        s.name.toLowerCase() === name.toLowerCase() && s.campus === campus);
      if (clash) {
        socket.emit('join_error', {
          message: `"${name}" is already playing at ${campus} — add a last initial or pick another name.`,
        });
        return;
      }
    }

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
      winner: game.winner?.name || null,
      winnerDeviceId: game.winner?.deviceId || null,
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
      // Winner is identified by device, not just name — two players who
      // happen to share a name never both see "You got BINGO!"
      game.winner = { name: p.name, deviceId: p.deviceId || null };
      game.active = false;
      recentLog.push({ game: gameCount, phrases: p.card.filter(c => c !== 'FREE') });

      try { await recordWin(p); } catch (err) { console.error('recordWin failed:', err); }
      const scoreboard = await getScoreboard().catch(() => EMPTY_SCOREBOARD);

      io.emit('bingo', { winner: p.name, winnerDeviceId: p.deviceId || null, scoreboard, resetIn: AUTO_RESET_SECONDS, popularTiles: getPopularTiles() });
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
