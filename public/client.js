const socket = io();

let myCard = [];
let myMarked = new Set();
let myGameId = null;

const $ = id => document.getElementById(id);

const joinScreen  = $('join-screen');
const gameScreen  = $('game-screen');
const winOverlay  = $('win-overlay');
const cardEl      = $('card');
const winMsg      = $('win-message');
const playerCount = $('player-count');

$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('join-btn').addEventListener('click', doJoin);
$('new-game-btn').addEventListener('click', () => socket.emit('new_game'));

function doJoin() {
  const name = $('name-input').value.trim();
  if (!name) return;
  $('join-btn').disabled = true;
  socket.emit('join', name);
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

socket.on('player_count', n => {
  playerCount.textContent = `${n} player${n !== 1 ? 's' : ''}`;
});

socket.on('bingo', winner => showWin(winner));

socket.on('new_game', ({ card, marked, gameId }) => {
  myCard   = card;
  myMarked = new Set(marked);
  myGameId = gameId;
  winOverlay.classList.add('hidden');
  renderCard();
});

// Re-show join screen if the connection drops and comes back
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
  cardEl.querySelectorAll('.cell')[i].classList.add('marked');
  socket.emit('mark', i);
}

function showWin(winner) {
  winMsg.textContent = `${winner} got BINGO!`;
  winOverlay.classList.remove('hidden');
}
