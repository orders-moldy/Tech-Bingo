// ─────────────────────────────────────────────────────────────
//  TCC Tech Bingo — client
//
//  Sections:
//    1. State & helpers
//    2. Join / leave flow
//    3. Socket events
//    4. Card rendering & marking
//    5. Scoreboard & stats overlay
//    6. Confetti
//    7. Chat
// ─────────────────────────────────────────────────────────────

const socket = io();

// ── 1. State & helpers ──

let myCard = [];
let myMarked = new Set();
let myName = '';
let myCampus = '';
let countdownTimer = null;

const CAMPUSES = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

const $ = id => document.getElementById(id);

// Escape user-provided text before inserting into innerHTML (names, campuses)
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Stable per-device ID so one person can't play from 10 browser tabs
function getDeviceId() {
  let id = localStorage.getItem('bingo_device_id');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('bingo_device_id', id);
  }
  return id;
}

const joinScreen  = $('join-screen');
const gameScreen  = $('game-screen');
const winOverlay  = $('win-overlay');
const statsOverlay = $('stats-overlay');
const cardEl      = $('card');
const winMsg      = $('win-message');
const countdownEl = $('countdown');
const playerCount = $('player-count');
const playersList = $('players-list');
const scoreList   = $('score-list');
const leadersEl   = $('leaders');
const joinMsg     = $('join-msg');

// ── 2. Join / leave flow ──

$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('join-btn').addEventListener('click', doJoin);
$('logo').addEventListener('click', goToJoin);

function doJoin() {
  const name = $('name-input').value.trim();
  const campus = $('campus-select').value;
  if (!name || !campus) {
    if (!name) $('name-input').focus();
    else $('campus-select').focus();
    return;
  }
  myName = name;
  myCampus = campus;
  joinMsg.textContent = '';
  $('join-btn').disabled = true;
  socket.emit('join', { name, campus, deviceId: getDeviceId() });
}

// Tap the logo to return to the join screen (also forgets this device on the server)
function goToJoin() {
  if (gameScreen.classList.contains('hidden')) return;
  socket.emit('leave');
  showJoinScreen();
}

function showJoinScreen(message = '') {
  myCard = []; myMarked = new Set(); myName = ''; myCampus = '';
  clearInterval(countdownTimer);
  winOverlay.classList.add('hidden');
  statsOverlay.classList.add('hidden');
  gameScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  joinMsg.textContent = message;
  $('join-btn').disabled = false;
}

// ── 3. Socket events ──

socket.on('joined', ({ card, marked, winner, scoreboard, name: canonicalName, popularTiles, suspended, chatHistory }) => {
  if (canonicalName) myName = canonicalName;
  myCard   = card;
  myMarked = new Set(marked);
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderCard();
  updateScoreboard({ ...scoreboard, popularTiles });
  renderChat(chatHistory || []);
  setChatEnabled(!suspended);
  if (winner) {
    winMsg.textContent = `${winner} got BINGO!`;
    winOverlay.classList.remove('hidden');
  }
  if (suspended) showStatsOverlay({ ...scoreboard, popularTiles });
});

socket.on('players', players => {
  playerCount.textContent = `${players.length} player${players.length !== 1 ? 's' : ''}`;
  const groups = {};
  players.forEach(p => {
    if (!groups[p.campus]) groups[p.campus] = [];
    groups[p.campus].push(p);
  });
  playersList.innerHTML = CAMPUSES
    .filter(c => groups[c])
    .map(c => `
      <div class="campus-group">
        <div class="campus-name">${esc(c)}</div>
        <div class="campus-chips">
          ${groups[c].map(p => {
            const classes = ['player-chip', p.name === myName ? 'me' : '', p.hot ? 'hot' : ''].filter(Boolean).join(' ');
            return `<span class="${classes}">${esc(p.name)}</span>`;
          }).join('')}
        </div>
      </div>
    `).join('');
});

socket.on('bingo', ({ winner, scoreboard, resetIn, popularTiles }) => {
  const isMe = winner === myName;
  winMsg.textContent = isMe ? '🎉 You got BINGO!' : `${winner} got BINGO!`;
  winOverlay.classList.remove('hidden');
  updateScoreboard({ ...scoreboard, popularTiles });
  fireConfetti(isMe);
  startCountdown(resetIn);
});

socket.on('new_game', ({ card, marked }) => {
  myCard   = card;
  myMarked = new Set(marked);
  clearInterval(countdownTimer);
  winOverlay.classList.add('hidden');
  renderCard();
});

socket.on('scoreboard_update', updateScoreboard);

socket.on('suspend', ({ scoreboard, popularTiles }) => {
  showStatsOverlay({ ...scoreboard, popularTiles });
  setChatEnabled(false);
});

socket.on('resume', () => {
  statsOverlay.classList.add('hidden');
  setChatEnabled(true);
});

// This device joined from another tab — this tab is no longer in the game
socket.on('kicked', () => {
  showJoinScreen('You joined from another tab, so this one signed out.');
});

// Auto-rejoin after a dropped connection (server sleep, lost wifi)
socket.on('connect', () => {
  if (myName) {
    socket.emit('join', { name: myName, campus: myCampus, deviceId: getDeviceId() });
  }
});

// ── 4. Card rendering & marking ──

function renderCard() {
  cardEl.innerHTML = '';
  myCard.forEach((phrase, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    // Size text to fit: short phrases display larger, long ones tighter
    cell.classList.add(phrase.length <= 20 ? 'len-s' : phrase.length <= 34 ? 'len-m' : 'len-l');
    if (myMarked.has(i)) cell.classList.add('marked');
    if (phrase === 'FREE') cell.classList.add('free');
    cell.textContent = phrase;
    cell.addEventListener('click', () => markCell(i));
    cardEl.appendChild(cell);
  });
}

function markCell(i) {
  if (myMarked.has(i) || myCard[i] === 'FREE') return;
  myMarked.add(i);
  const cell = cardEl.querySelectorAll('.cell')[i];
  cell.classList.add('marked', 'stamping');
  cell.addEventListener('animationend', () => cell.classList.remove('stamping'), { once: true });
  socket.emit('mark', i);
}

function startCountdown(seconds) {
  clearInterval(countdownTimer);
  let remaining = seconds;
  countdownEl.textContent = `New game starting in ${remaining}…`;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      countdownEl.textContent = `New game starting in ${remaining}…`;
    } else {
      clearInterval(countdownTimer);
      countdownEl.textContent = 'Starting…';
    }
  }, 1000);
}

// ── 5. Scoreboard & stats overlay ──

function updateScoreboard({ list, weekendLeader, satLeader, sunLeader, popularTiles } = {}) {
  if (!list || list.length === 0) {
    leadersEl.innerHTML = '';
    scoreList.innerHTML = '<p class="empty-state">No wins yet</p>';
    $('popular-box').classList.add('hidden');
    return;
  }

  const leaderCard = (icon, label, entry, wins) => `
    <div class="leader-item">
      <div class="leader-left">
        <div class="leader-label">${icon} ${label}</div>
        <div class="leader-name">${esc(entry.name)}</div>
        <div class="leader-campus">${esc(entry.campus)}</div>
      </div>
      <div class="leader-wins">${wins}</div>
    </div>`;

  leadersEl.innerHTML = [
    weekendLeader ? leaderCard('🏆', 'Weekend', weekendLeader, weekendLeader.total) : '',
    satLeader     ? leaderCard('📅', 'Saturday', satLeader, satLeader.saturday)     : '',
    sunLeader     ? leaderCard('📅', 'Sunday',   sunLeader, sunLeader.sunday)       : '',
  ].join('');

  // Top 3 — gold, silver, bronze
  scoreList.innerHTML = `
    <div class="score-divider"></div>
    ${list.slice(0, 3).map((entry, i) => `
      <div class="score-item">
        <div class="score-rank">${['🥇', '🥈', '🥉'][i]}</div>
        <div class="score-info">
          <div class="score-name">${esc(entry.name)}</div>
          <div class="score-campus">${esc(entry.campus)}</div>
        </div>
        <div class="score-wins">${entry.total}</div>
      </div>
    `).join('')}
  `;

  // Most-marked tiles appear once the weekend has 4+ wins
  const totalWins = list.reduce((s, p) => s + p.total, 0);
  const popularBox = $('popular-box');
  if (popularTiles && popularTiles.length > 0 && totalWins >= 4) {
    $('popular-list').innerHTML = popularTiles.map((phrase, i) => `
      <div class="popular-item">
        <span class="popular-rank">${i + 1}.</span>
        <span class="popular-phrase">${esc(phrase)}</span>
      </div>
    `).join('');
    popularBox.classList.remove('hidden');
  } else {
    popularBox.classList.add('hidden');
  }
}

// Full-screen stats view, pushed by the admin's "Show Stats Screen" button
function showStatsOverlay({ list, weekendLeader, satLeader, sunLeader, popularTiles } = {}) {
  const medals = ['🥇', '🥈', '🥉'];

  const leaderCard = (medal, label, entry, wins) => `
    <div class="stats-leader">
      <div class="stats-leader-medal">${medal}</div>
      <div class="stats-leader-info">
        <div class="stats-leader-label">${label}</div>
        <div class="stats-leader-name">${esc(entry.name)}</div>
        <div class="stats-leader-campus">${esc(entry.campus)}</div>
      </div>
      <div class="stats-leader-wins">${wins}</div>
    </div>`;

  $('stats-leaders').innerHTML = [
    weekendLeader ? leaderCard('🏆', 'Weekend Leader', weekendLeader, weekendLeader.total) : '',
    satLeader     ? leaderCard('📅', 'Saturday',       satLeader,     satLeader.saturday)  : '',
    sunLeader     ? leaderCard('📅', 'Sunday',         sunLeader,     sunLeader.sunday)    : '',
  ].join('');

  const top3 = (list || []).slice(0, 3);
  $('stats-list').innerHTML = top3.length ? top3.map((entry, i) => `
    <div class="stats-score-item">
      <div class="stats-score-rank">${medals[i]}</div>
      <div class="stats-score-info">
        <div class="stats-score-name">${esc(entry.name)}</div>
        <div class="stats-score-campus">${esc(entry.campus)}</div>
      </div>
      <div class="stats-score-wins">${entry.total}</div>
    </div>
  `).join('') : '<p class="stats-no-data">No wins yet</p>';

  const popularRankIcons = ['🔥', '2️⃣', '3️⃣'];
  $('stats-popular').innerHTML = popularTiles && popularTiles.length ? popularTiles.map((phrase, i) => `
    <div class="stats-popular-item">
      <div class="stats-popular-rank">${popularRankIcons[i]}</div>
      <div class="stats-popular-phrase">${esc(phrase)}</div>
    </div>
  `).join('') : '<p class="stats-no-data">Not enough data yet</p>';

  statsOverlay.classList.remove('hidden');
}

// ── 6. Confetti ──

function fireConfetti(big) {
  if (typeof confetti === 'undefined') return;
  const count = big ? 250 : 120;
  confetti({ particleCount: count, spread: 80, origin: { y: 0.55 }, colors: ['#9BB6BF', '#ffffff', '#b3cdd5', '#ff6b6b', '#4ecdc4'] });
  if (big) {
    setTimeout(() => confetti({ particleCount: 80, angle: 60,  spread: 55, origin: { x: 0, y: 0.6 } }), 200);
    setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1, y: 0.6 } }), 350);
  }
}

// ── 7. Chat ──

const CHAT_DOM_MAX = 100;        // cap rendered messages
const CHAT_SEND_COOLDOWN = 1500; // matches server rate limit

const chatBody     = $('chat-body');
const chatMessages = $('chat-messages');
const chatInput    = $('chat-input');
const chatSend     = $('chat-send');
const chatUnread   = $('chat-unread');
const chatPill     = $('chat-pill');

let chatOpen = false;
let unreadCount = 0;

$('chat-toggle').addEventListener('click', () => {
  chatOpen = !chatOpen;
  chatBody.classList.toggle('hidden', !chatOpen);
  $('chat-caret').textContent = chatOpen ? '▾' : '▸';
  if (chatOpen) {
    clearUnread();
    scrollChatToBottom();
  }
});

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
chatPill.addEventListener('click', () => { scrollChatToBottom(); chatPill.classList.add('hidden'); });

// Hide the pill once the user scrolls back to the bottom themselves
chatMessages.addEventListener('scroll', () => {
  if (isChatNearBottom()) chatPill.classList.add('hidden');
});

socket.on('chat', msg => {
  appendChatMessage(msg);
  if (!chatOpen) {
    unreadCount++;
    chatUnread.textContent = unreadCount > 9 ? '9+' : unreadCount;
    chatUnread.classList.remove('hidden');
  }
});

socket.on('chat_history', renderChat);

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  socket.emit('chat', text);
  chatInput.value = '';
  // Brief cooldown matching the server's rate limit
  chatSend.disabled = true;
  setTimeout(() => { chatSend.disabled = false; }, CHAT_SEND_COOLDOWN);
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatInput.placeholder = enabled ? 'Say something…' : 'Chat paused during stats';
}

function clearUnread() {
  unreadCount = 0;
  chatUnread.classList.add('hidden');
}

function isChatNearBottom() {
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function chatRow(msg) {
  const row = document.createElement('div');
  row.className = 'chat-msg';
  const mine = msg.name === myName;
  row.innerHTML = `<span class="chat-name${mine ? ' me' : ''}">${esc(msg.name)}</span><span class="chat-text">${esc(msg.text)}</span>`;
  return row;
}

function renderChat(list) {
  chatMessages.innerHTML = '';
  (list || []).slice(-CHAT_DOM_MAX).forEach(msg => chatMessages.appendChild(chatRow(msg)));
  scrollChatToBottom();
  clearUnread();
}

function appendChatMessage(msg) {
  const wasNearBottom = isChatNearBottom();
  chatMessages.appendChild(chatRow(msg));
  while (chatMessages.children.length > CHAT_DOM_MAX) chatMessages.firstChild.remove();

  // Don't yank the view down if the user scrolled up to read older messages
  if (wasNearBottom || msg.name === myName) {
    scrollChatToBottom();
  } else if (chatOpen) {
    chatPill.classList.remove('hidden');
  }
}
