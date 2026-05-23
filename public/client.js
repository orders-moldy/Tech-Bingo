const socket = io();

let myCard = [];
let myMarked = new Set();
let myGameId = null;
let myName = '';
let myCampus = '';
let countdownTimer = null;

const CAMPUSES = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

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
  socket.emit('join', { name, campus });
}

socket.on('joined', ({ card, marked, gameId, winner, scoreboard }) => {
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderCard();
  updateScoreboard(scoreboard);
  if (winner) {
    // Joined mid-countdown — show overlay but don't restart timer
    winMsg.textContent = `${winner} got BINGO!`;
    winOverlay.classList.remove('hidden');
  }
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

socket.on('bingo', ({ winner, scoreboard, resetIn }) => {
  const isMe = winner === myName;
  winMsg.textContent = isMe ? '🎉 You got BINGO!' : `${winner} got BINGO!`;
  winOverlay.classList.remove('hidden');
  updateScoreboard(scoreboard);
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

socket.on('connect', () => {
  if (!gameScreen.classList.contains('hidden')) {
    gameScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
    $('join-btn').disabled = false;
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

function updateScoreboard({ list, weekendLeader, satLeader, sunLeader } = {}) {
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
    ${list.map((entry, i) => `
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
