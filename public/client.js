const socket = io();

let myCard = [];
let myMarked = new Set();
let myGameId = null;
let myName = '';
let myCampus = '';

const CAMPUSES = ['Plainfield', 'Bolingbrook', 'South Naperville', 'Naperville', 'Hinsdale', 'Wheaton'];

const $ = id => document.getElementById(id);

const joinScreen  = $('join-screen');
const gameScreen  = $('game-screen');
const winOverlay  = $('win-overlay');
const cardEl      = $('card');
const winMsg      = $('win-message');
const playerCount = $('player-count');
const playersList = $('players-list');

$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('join-btn').addEventListener('click', doJoin);
$('new-game-btn').addEventListener('click', () => socket.emit('new_game'));

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

socket.on('joined', ({ card, marked, gameId, winner }) => {
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  joinScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderCard();
  if (winner) showWin(winner);
});

socket.on('players', players => {
  playerCount.textContent = `${players.length} player${players.length !== 1 ? 's' : ''}`;

  // Group by campus, preserving the defined order
  const groups = {};
  players.forEach(p => {
    if (!groups[p.campus]) groups[p.campus] = [];
    groups[p.campus].push(p.name);
  });

  playersList.innerHTML = CAMPUSES
    .filter(c => groups[c])
    .map(c => `
      <div class="campus-group">
        <div class="campus-name">${c}</div>
        <div class="campus-chips">
          ${groups[c].map(n => `<span class="player-chip${n === myName ? ' me' : ''}">${n}</span>`).join('')}
        </div>
      </div>
    `).join('');
});

socket.on('bingo', winner => showWin(winner));

socket.on('new_game', ({ card, marked, gameId }) => {
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  winOverlay.classList.add('hidden');
  renderCard();
});

socket.on('connect', () => {
  if (!gameScreen.classList.contains('hidden')) {
    gameScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
    $('join-btn').disabled = false;
  }
});

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

function showWin(winner) {
  const isMe = winner === myName;
  winMsg.textContent = isMe ? 'You got BINGO!' : `${winner} got BINGO!`;
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
