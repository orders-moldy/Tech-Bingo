const socket = io();

let myCard = [];
let myMarked = new Set();
let myGameId = null;
let myName = '';
let myCampus = '';
let countdownTimer = null;

const CAMPUSES = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

function getDeviceId() {
  let id = localStorage.getItem('bingo_device_id');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('bingo_device_id', id);
  }
  return id;
}

const $ = id => document.getElementById(id);

const joinScreen  = $('join-screen');
const gameScreen  = $('game-screen');
const winOverlay  = $('win-overlay');
const cardEl      = $('card');
const winMsg      = $('win-message');
const countdownEl = $('countdown');
const playerCount = $('player-count');
const playersList = $('players-list');
const scoreList   = $('score-list');
const leadersEl   = $('leaders');

$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('join-btn').addEventListener('click', doJoin);
$('logo').addEventListener('click', goToJoin);

function goToJoin() {
  if (gameScreen.classList.contains('hidden')) return;
  socket.emit('leave');
  myCard = []; myMarked = new Set(); myName = ''; myCampus = '';
  clearInterval(countdownTimer);
  winOverlay.classList.add('hidden');
  gameScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  $('join-btn').disabled = false;
}

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
  $('join-btn').disabled = true;
  socket.emit('join', { name, campus, deviceId: getDeviceId() });
}

socket.on('joined', ({ card, marked, gameId, winner, scoreboard, name: canonicalName, popularTiles, suspended }) => {
  if (canonicalName) myName = canonicalName;
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderCard();
  updateScoreboard({ ...scoreboard, popularTiles });
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
        <div class="campus-name">${c}</div>
        <div class="campus-chips">
          ${groups[c].map(p => {
            const classes = ['player-chip', p.name === myName ? 'me' : '', p.hot ? 'hot' : ''].filter(Boolean).join(' ');
            return `<span class="${classes}">${p.name}</span>`;
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

socket.on('new_game', ({ card, marked, gameId }) => {
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  clearInterval(countdownTimer);
  winOverlay.classList.add('hidden');
  renderCard();
});

socket.on('scoreboard_update', updateScoreboard);

socket.on('suspend', ({ scoreboard, popularTiles }) => {
  showStatsOverlay({ ...scoreboard, popularTiles });
});

socket.on('resume', () => {
  $('stats-overlay').classList.add('hidden');
});

socket.on('connect', () => {
  if (myName) {
    // Reconnect — rejoin silently with same device ID
    socket.emit('join', { name: myName, campus: myCampus, deviceId: getDeviceId() });
  }
});

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

function renderCard() {
  cardEl.innerHTML = '';
  myCard.forEach((phrase, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
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

function updateScoreboard({ list, weekendLeader, satLeader, sunLeader, popularTiles } = {}) {
  if (!list || list.length === 0) {
    leadersEl.innerHTML = '';
    scoreList.innerHTML = '<p class="empty-state">No wins yet</p>';
    return;
  }

  // Leaders
  const leaderCard = (icon, label, entry, wins) => `
    <div class="leader-item">
      <div class="leader-left">
        <div class="leader-label">${icon} ${label}</div>
        <div class="leader-name">${entry.name}</div>
        <div class="leader-campus">${entry.campus}</div>
      </div>
      <div class="leader-wins">${wins}</div>
    </div>`;

  leadersEl.innerHTML = [
    weekendLeader ? leaderCard('🏆', 'Weekend', weekendLeader, weekendLeader.total) : '',
    satLeader     ? leaderCard('📅', 'Saturday', satLeader, satLeader.saturday)     : '',
    sunLeader     ? leaderCard('📅', 'Sunday',   sunLeader, sunLeader.sunday)       : '',
  ].join('');

  // Full list
  scoreList.innerHTML = `
    <div class="score-divider"></div>
    ${list.slice(0, 3).map((entry, i) => `
      <div class="score-item">
        <div class="score-rank">${['🥇','🥈','🥉'][i] ?? `${i+1}.`}</div>
        <div class="score-info">
          <div class="score-name">${entry.name}</div>
          <div class="score-campus">${entry.campus}</div>
        </div>
        <div class="score-wins">${entry.total}</div>
      </div>
    `).join('')}
  `;

  // Popular tiles (show after 4+ total wins)
  const totalWins = list.reduce((s, p) => s + p.total, 0);
  const popularBox = $('popular-box');
  if (popularTiles && popularTiles.length > 0 && totalWins >= 4) {
    $('popular-list').innerHTML = popularTiles.map((phrase, i) => `
      <div class="popular-item">
        <span class="popular-rank">${i + 1}.</span>
        <span class="popular-phrase">${phrase}</span>
      </div>
    `).join('');
    popularBox.classList.remove('hidden');
  } else {
    popularBox.classList.add('hidden');
  }
}

function showStatsOverlay({ list, weekendLeader, satLeader, sunLeader, popularTiles } = {}) {
  const medals = ['🥇', '🥈', '🥉'];

  // Leaders section
  const leaderCard = (medal, label, entry, wins) => `
    <div class="stats-leader">
      <div class="stats-leader-medal">${medal}</div>
      <div class="stats-leader-info">
        <div class="stats-leader-label">${label}</div>
        <div class="stats-leader-name">${entry.name}</div>
        <div class="stats-leader-campus">${entry.campus}</div>
      </div>
      <div class="stats-leader-wins">${wins}</div>
    </div>`;

  $('stats-leaders').innerHTML = [
    weekendLeader ? leaderCard('🏆', 'Weekend Leader', weekendLeader, weekendLeader.total) : '',
    satLeader     ? leaderCard('📅', 'Saturday',       satLeader,     satLeader.saturday)  : '',
    sunLeader     ? leaderCard('📅', 'Sunday',         sunLeader,     sunLeader.sunday)    : '',
  ].join('');

  // Full top-3 list
  const top3 = (list || []).slice(0, 3);
  $('stats-list').innerHTML = top3.length ? top3.map((entry, i) => `
    <div class="stats-score-item">
      <div class="stats-score-rank">${medals[i] ?? `${i+1}.`}</div>
      <div class="stats-score-info">
        <div class="stats-score-name">${entry.name}</div>
        <div class="stats-score-campus">${entry.campus}</div>
      </div>
      <div class="stats-score-wins">${entry.total}</div>
    </div>
  `).join('') : '<p class="stats-no-data">No wins yet</p>';

  // Popular tiles
  const popularRankIcons = ['🔥', '2️⃣', '3️⃣'];
  $('stats-popular').innerHTML = popularTiles && popularTiles.length ? popularTiles.map((phrase, i) => `
    <div class="stats-popular-item">
      <div class="stats-popular-rank">${popularRankIcons[i] ?? `${i+1}.`}</div>
      <div class="stats-popular-phrase">${phrase}</div>
    </div>
  `).join('') : '<p class="stats-no-data">Not enough data yet</p>';

  $('stats-overlay').classList.remove('hidden');
}

function showWin(winner) {
  const isMe = winner === myName;
  winMsg.textContent = isMe ? '🎉 You got BINGO!' : `${winner} got BINGO!`;
  winOverlay.classList.remove('hidden');
  fireConfetti(isMe);
}

function fireConfetti(big) {
  if (typeof confetti === 'undefined') return;
  const count = big ? 250 : 120;
  confetti({ particleCount: count, spread: 80, origin: { y: 0.55 }, colors: ['#9BB6BF', '#ffffff', '#b3cdd5', '#ff6b6b', '#4ecdc4'] });
  if (big) {
    setTimeout(() => confetti({ particleCount: 80, angle: 60,  spread: 55, origin: { x: 0, y: 0.6 } }), 200);
    setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1, y: 0.6 } }), 350);
  }
}
