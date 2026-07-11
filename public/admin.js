// TCC Tech Bingo — admin dashboard logic

let adminPw = '';
let isSuspended = false;
let historyLoaded = false;
let chatLoaded = false;
let phrasesCache = null;   // current phrase list, null until first load
let editingPhrase = null;  // phrase currently in inline-edit mode
let campusesCache = null;  // current campus list, null until first load
let editingCampus = null;  // campus currently in inline-edit mode

const $ = id => document.getElementById(id);

// Theme: blue-dominant by default; "cream" flips the palette. Saved per device.
if (localStorage.getItem('bingo_theme') === 'cream') {
  document.documentElement.dataset.theme = 'cream';
}
document.getElementById('theme-toggle').addEventListener('click', () => {
  const toCream = document.documentElement.dataset.theme !== 'cream';
  if (toCream) document.documentElement.dataset.theme = 'cream';
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('bingo_theme', toCream ? 'cream' : 'blue');
});


// Toast-style status messages: slide up, auto-dismiss after 4s
let msgTimer = null;
const setMsg = (text, cls = '') => {
  const el = $('msg');
  clearTimeout(msgTimer);
  if (!text) { el.className = ''; return; }
  el.textContent = text;
  el.className = 'show ' + cls;
  msgTimer = setTimeout(() => { el.className = ''; }, 4000);
};

// Back to the lock screen (fresh state, password forgotten)
function signOut() {
  adminPw = '';
  location.reload();
}
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPw, ...body }),
  });
  return res.json();
}

// ── Login ──

$('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

async function doUnlock() {
  const pw = $('pw').value;
  if (!pw) return;
  $('login-msg').textContent = '';
  adminPw = pw;
  try {
    const data = await api('/admin/login');
    if (!data.ok) {
      adminPw = '';
      $('login-msg').textContent = '❌ ' + (data.error || 'Wrong password');
      return;
    }
    $('login-view').classList.add('hidden');
    $('dash').classList.remove('hidden');
    await refreshOverview();
  } catch {
    $('login-msg').textContent = '❌ Could not connect to server.';
  }
}

// ── Tabs ──

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-overview').classList.toggle('hidden', name !== 'overview');
  $('tab-history').classList.toggle('hidden', name !== 'history');
  $('tab-chat').classList.toggle('hidden', name !== 'chat');
  $('tab-phrases').classList.toggle('hidden', name !== 'phrases');
  $('tab-campuses').classList.toggle('hidden', name !== 'campuses');
  if (name === 'history' && !historyLoaded) loadHistory();
  if (name === 'chat' && !chatLoaded) loadChat();
  if (name === 'phrases' && phrasesCache === null) loadPhrases();
  if (name === 'campuses' && campusesCache === null) loadCampuses();
}

// ── Overview ──

async function refreshOverview() {
  try {
    const data = await api('/admin/overview');
    if (!data.ok) { setMsg('❌ ' + (data.error || 'Failed'), 'error'); return; }

    isSuspended = data.suspended;
    updateStatusUI();

    const list = data.scoreboard.list || [];
    $('stat-players').textContent = data.playersOnline;
    $('stat-wins').textContent    = list.reduce((s, p) => s + p.total, 0);
    $('stat-games').textContent   = data.gamesThisSession;
    $('stat-phrases').textContent = data.phraseCount;

    renderStandings(list);
    renderCampusStandings(list);
    renderPopular(data.popularTiles);
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  }
}

function renderStandings(list) {
  const el = $('weekend-standings');
  if (!list.length) {
    el.innerHTML = '<p class="empty">No wins yet this weekend.</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = `
    <table>
      <tr><th></th><th>Player</th><th class="num">Sat</th><th class="num">Sun</th><th class="num">Total</th></tr>
      ${list.slice(0, 5).map((p, i) => `
        <tr>
          <td class="rank">${medals[i] ?? `${i + 1}.`}</td>
          <td>${esc(p.name)}<span class="campus">${esc(p.campus)}</span></td>
          <td class="num">${p.saturday}</td>
          <td class="num">${p.sunday}</td>
          <td class="num total">${p.total}</td>
        </tr>`).join('')}
    </table>`;
}

function renderCampusStandings(list) {
  const el = $('campus-standings');
  if (!list.length) {
    el.innerHTML = '<p class="empty">No wins yet this weekend.</p>';
    return;
  }
  // Roll player rows up into campus totals
  const map = {};
  list.forEach(p => {
    const c = map[p.campus] ??= { campus: p.campus, saturday: 0, sunday: 0, total: 0 };
    c.saturday += p.saturday; c.sunday += p.sunday; c.total += p.total;
  });
  const campuses = Object.values(map).sort((a, b) => b.total - a.total);
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = `
    <table>
      <tr><th></th><th>Campus</th><th class="num">Sat</th><th class="num">Sun</th><th class="num">Total</th></tr>
      ${campuses.map((c, i) => `
        <tr>
          <td class="rank">${medals[i] ?? `${i + 1}.`}</td>
          <td>${esc(c.campus)}</td>
          <td class="num">${c.saturday}</td>
          <td class="num">${c.sunday}</td>
          <td class="num total">${c.total}</td>
        </tr>`).join('')}
    </table>`;
}

// ── Players modal ──

function agoLabel(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function playerRow(p, isActive) {
  const sub = [
    esc(p.campus),
    p.device ? esc(p.device) : null,
    !isActive && p.lastSeen ? agoLabel(p.lastSeen) : null,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `
    <div class="plr${isActive ? '' : ' recent'}">
      <span class="dot${isActive ? '' : ' idle'}"></span>
      <div class="plr-info">
        <div class="plr-name">${esc(p.name)}</div>
        <div class="plr-sub">${sub}</div>
      </div>
      <div class="plr-wins">
        <span class="plr-wins-num">${p.wins}</span>
        <span class="plr-wins-label">win${p.wins !== 1 ? 's' : ''}</span>
      </div>
    </div>`;
}

const plrSection = (dotCls, label, count) => `
  <div class="plr-section">
    <span class="sec-dot ${dotCls}"></span>
    <span class="sec-label">${label}</span>
    <span class="sec-count">${count}</span>
  </div>`;

async function openPlayers() {
  $('players-modal').classList.remove('hidden');
  $('players-content').innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await api('/admin/players');
    if (!data.ok) { $('players-content').innerHTML = `<p class="empty">❌ ${esc(data.error || 'Failed')}</p>`; return; }
    const parts = [];
    parts.push(plrSection('live', 'Active now', data.active.length));
    parts.push(data.active.length ? data.active.map(p => playerRow(p, true)).join('') : '<p class="empty">Nobody is playing right now.</p>');
    parts.push(plrSection('idle', 'Last 24 hours', data.recent.length));
    parts.push(data.recent.length ? data.recent.map(p => playerRow(p, false)).join('') : '<p class="empty">No one else in the last 24 hours.</p>');
    $('players-content').innerHTML = parts.join('');
  } catch {
    $('players-content').innerHTML = '<p class="empty">❌ Could not connect to server.</p>';
  }
}

function closePlayers() {
  $('players-modal').classList.add('hidden');
}

function renderPopular(tiles) {
  const el = $('overview-popular');
  if (!tiles || !tiles.length) {
    el.innerHTML = '<p class="empty">Not enough data yet.</p>';
    return;
  }
  el.innerHTML = tiles.map((phrase, i) => `
    <div class="popular-item">
      <span class="popular-rank">${['🔥', '2️⃣', '3️⃣'][i] ?? `${i + 1}.`}</span>
      <span class="popular-phrase">${esc(phrase)}</span>
    </div>`).join('');
}

function updateStatusUI() {
  const pill = $('status-pill');
  pill.className = 'pill ' + (isSuspended ? 'suspended' : 'live');
  pill.textContent = isSuspended ? '⏸ Suspended' : '● Live';

  const btn = $('suspend-btn');
  btn.textContent = isSuspended ? '▶️ Resume Play' : '📊 Show Stats Screen';
  btn.classList.toggle('active', isSuspended);
  $('suspend-hint').textContent = isSuspended
    ? 'Resumes the game and hides the stats screen for all players.'
    : 'Pauses play and shows the stats screen to all players.';
}

// ── History ──

async function loadHistory() {
  try {
    const data = await api('/admin/history');
    if (!data.ok) { setMsg('❌ ' + (data.error || 'Failed'), 'error'); return; }
    historyLoaded = true;
    renderHistory(data);
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  }
}

// "Jul 11–12, 2026" (or "Jun 30 – Jul 1, 2026" across a month boundary)
function fmtWeekendRange(iso) {
  if (!iso || iso === 'unknown') return 'Unknown';
  const sat = new Date(iso + 'T12:00:00');
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
  const mo = d => d.toLocaleDateString('en-US', { month: 'short' });
  return mo(sat) === mo(sun)
    ? `${mo(sat)} ${sat.getDate()}–${sun.getDate()}, ${sun.getFullYear()}`
    : `${mo(sat)} ${sat.getDate()} – ${mo(sun)} ${sun.getDate()}, ${sun.getFullYear()}`;
}

function renderHistory({ weekends, allTime }) {
  const medals = ['🥇', '🥈', '🥉'];

  // Roll each weekend up by campus; track the winning campus per weekend
  const campusMap = {};
  for (const wk of weekends) {
    const perCampus = {};
    wk.players.forEach(p => { perCampus[p.campus] = (perCampus[p.campus] || 0) + p.wins; });
    const ranked = Object.entries(perCampus).sort((a, b) => b[1] - a[1]);
    const topWins = ranked[0]?.[1] || 0;
    wk.campusChampion = ranked[0]?.[0] || null;
    for (const [campus, wins] of ranked) {
      const c = campusMap[campus] ??= { campus, wins: 0, titles: 0 };
      c.wins += wins;
      if (wins === topWins) c.titles++;
    }
  }
  const campusAllTime = Object.values(campusMap).sort((a, b) => b.wins - a.wins || b.titles - a.titles);

  // Per-player weekend breakdown — powers the expandable rows below.
  // Keyed by the server's identity key (device-based), so two players
  // with the same name stay separate.
  const perPlayer = {};
  for (const wk of weekends) {
    wk.players.forEach(p => {
      const k = p.key || `${p.name}|${p.campus}`;
      (perPlayer[k] ??= []).push({ weekendStart: wk.weekendStart, wins: p.wins, champ: wk.players[0] === p });
    });
  }

  $('hist-champions').innerHTML = allTime.length ? allTime.slice(0, 5).map((p, i) => {
    const breakdown = perPlayer[p.key || `${p.name}|${p.campus}`] || [];
    const expandable = p.wins > 1;
    const row = `
      <div class="hist-champ${expandable ? ' expandable' : ''}"${expandable ? ' onclick="toggleHistDetail(this)" title="Show weekends won"' : ''}>
        <div class="hist-champ-rank">${medals[i] ?? `${i + 1}.`}</div>
        <div class="hist-champ-info">
          <div class="hist-champ-name">${esc(p.name)}</div>
          <div class="hist-champ-sub">${esc(p.campus)} · ${p.titles} weekend title${p.titles !== 1 ? 's' : ''}</div>
        </div>
        <div class="hist-champ-wins">${p.wins}</div>
        ${expandable ? '<span class="hist-chevron">▸</span>' : ''}
      </div>`;
    const detail = expandable ? `
      <div class="hist-detail hidden">
        ${breakdown.map(b => `
          <div class="hist-detail-row">
            <span>📅 ${fmtWeekendRange(b.weekendStart)}${b.champ ? ' <span title="Weekend champion">🏆</span>' : ''}</span>
            <span class="d-wins">${b.wins} win${b.wins !== 1 ? 's' : ''}</span>
          </div>`).join('')}
      </div>` : '';
    return row + detail;
  }).join('') : '<p class="empty">No wins recorded yet.</p>';

  $('hist-campuses').innerHTML = campusAllTime.length ? campusAllTime.map((c, i) => `
    <div class="hist-champ">
      <div class="hist-champ-rank">${medals[i] ?? `${i + 1}.`}</div>
      <div class="hist-champ-info">
        <div class="hist-champ-name">${esc(c.campus)}</div>
        <div class="hist-champ-sub">${c.titles} weekend title${c.titles !== 1 ? 's' : ''}</div>
      </div>
      <div class="hist-champ-wins">${c.wins}</div>
    </div>`).join('') : '<p class="empty">No wins recorded yet.</p>';

  $('hist-weekends').innerHTML = weekends.length ? weekends.map(wk => {
    const top = wk.players[0];
    return `
      <div class="hist-weekend">
        <span class="hist-weekend-date">${fmtWeekendRange(wk.weekendStart)}</span>
        <span class="hist-weekend-winner">🏆 ${esc(top.name)}${wk.campusChampion ? ` <span style="color:var(--muted);font-weight:400;">· 🏫 ${esc(wk.campusChampion)}</span>` : ''}</span>
        <span class="hist-weekend-wins">${top.wins}</span>
      </div>`;
  }).join('') : '<p class="empty">No past weekends yet.</p>';
}

// Expand/collapse a player's per-weekend breakdown in Win History
function toggleHistDetail(row) {
  row.classList.toggle('open');
  row.nextElementSibling.classList.toggle('hidden');
}

// ── Weekend chat log ──

async function loadChat() {
  try {
    const data = await api('/admin/chat');
    if (!data.ok) { setMsg('❌ ' + (data.error || 'Failed'), 'error'); return; }
    chatLoaded = true;
    renderChatLog(data.messages);
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  }
}

function renderChatLog(messages) {
  const el = $('chat-log');
  $('chat-log-title').textContent = `💬 Weekend Chat (${messages.length}${messages.length === 1000 ? '+' : ''})`;
  if (!messages.length) {
    el.innerHTML = '<p class="empty">No chat messages yet this weekend.</p>';
    return;
  }
  el.innerHTML = messages.map(m => {
    const d = new Date(m.ts);
    const when = d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' +
                 d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `
      <div class="chatlog-row">
        <span class="chatlog-name">${esc(m.name)}</span>
        <span class="chatlog-meta">${esc(m.campus)} · ${when}</span>
        <span>${esc(m.text)}</span>
      </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight; // newest messages at the bottom
}

// ── Phrase editor ──

async function loadPhrases() {
  await phraseAction({ action: 'list' });
}

// Runs any phrase action and re-renders from the returned list
async function phraseAction(body) {
  try {
    const data = await api('/admin/phrases', body);
    if (!data.ok) { setMsg('❌ ' + (data.error || 'Failed'), 'error'); return false; }
    phrasesCache = data.phrases;
    editingPhrase = null;
    $('stat-phrases').textContent = data.phrases.length; // keep the stat card in sync
    renderPhrases();
    setMsg('');
    return true;
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
    return false;
  }
}

function renderPhrases() {
  if (phrasesCache === null) return;
  $('phrases-title').textContent = `🧩 Phrases (${phrasesCache.length})`;
  const filter = $('phr-filter').value.trim().toLowerCase();
  const shown = [...phrasesCache]
    .sort((a, b) => a.localeCompare(b))
    .filter(p => !filter || p.toLowerCase().includes(filter));

  $('phr-list').innerHTML = shown.length ? shown.map(p => {
    if (p === editingPhrase) {
      return `
        <div class="phr-row">
          <input type="text" id="phr-edit-input" maxlength="60" value="${esc(p)}"
                 onkeydown="if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') cancelEdit();">
          <button class="icon-btn save" title="Save" onclick="saveEdit()">✓</button>
          <button class="icon-btn" title="Cancel" onclick="cancelEdit()">✕</button>
        </div>`;
    }
    return `
      <div class="phr-row">
        <span class="phr-text">${esc(p)}</span>
        <button class="icon-btn" title="Edit" onclick="startEdit(this)" data-phrase="${esc(p)}">✎</button>
        <button class="icon-btn danger" title="Remove" onclick="removePhrase(this)" data-phrase="${esc(p)}">✕</button>
      </div>`;
  }).join('') : '<p class="empty">No phrases match that filter.</p>';

  const editInput = $('phr-edit-input');
  if (editInput) { editInput.focus(); editInput.select(); }
}

async function addPhrase() {
  const text = $('phr-new').value.trim();
  if (!text) { $('phr-new').focus(); return; }
  if (await phraseAction({ action: 'add', text })) {
    $('phr-new').value = '';
    setMsg('✅ Phrase added.', 'success');
  }
}
$('phr-new').addEventListener('keydown', e => { if (e.key === 'Enter') addPhrase(); });

function startEdit(btn) {
  editingPhrase = btn.dataset.phrase;
  renderPhrases();
}

function cancelEdit() {
  editingPhrase = null;
  renderPhrases();
}

async function saveEdit() {
  const text = $('phr-edit-input').value.trim();
  const oldText = editingPhrase;
  if (!text || text === oldText) { cancelEdit(); return; }
  if (await phraseAction({ action: 'edit', oldText, text })) {
    setMsg('✅ Phrase updated.', 'success');
  }
}

async function removePhrase(btn) {
  if (await phraseAction({ action: 'remove', text: btn.dataset.phrase })) {
    setMsg('✅ Phrase removed.', 'success');
  }
}

// ── Campus editor ──

async function loadCampuses() {
  await campusAction({ action: 'list' });
}

async function campusAction(body) {
  try {
    const data = await api('/admin/campuses', body);
    if (!data.ok) { setMsg('❌ ' + (data.error || 'Failed'), 'error'); return false; }
    campusesCache = data.campuses;
    editingCampus = null;
    renderCampuses();
    setMsg('');
    return true;
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
    return false;
  }
}

function renderCampuses() {
  if (campusesCache === null) return;
  $('campuses-title').textContent = `🏫 Campuses (${campusesCache.length})`;

  $('cmp-list').innerHTML = campusesCache.map(c => {
    if (c === editingCampus) {
      return `
        <div class="phr-row">
          <input type="text" id="cmp-edit-input" maxlength="30" value="${esc(c)}"
                 onkeydown="if (event.key === 'Enter') saveEditCampus(); if (event.key === 'Escape') cancelEditCampus();">
          <button class="icon-btn save" title="Save" onclick="saveEditCampus()">✓</button>
          <button class="icon-btn" title="Cancel" onclick="cancelEditCampus()">✕</button>
        </div>`;
    }
    return `
      <div class="phr-row">
        <span class="phr-text">${esc(c)}</span>
        <button class="icon-btn" title="Rename" onclick="startEditCampus(this)" data-campus="${esc(c)}">✎</button>
        <button class="icon-btn danger" title="Remove" onclick="removeCampus(this)" data-campus="${esc(c)}">✕</button>
      </div>`;
  }).join('');

  const editInput = $('cmp-edit-input');
  if (editInput) { editInput.focus(); editInput.select(); }
}

async function addCampus() {
  const name = $('cmp-new').value.trim();
  if (!name) { $('cmp-new').focus(); return; }
  if (await campusAction({ action: 'add', name })) {
    $('cmp-new').value = '';
    setMsg('✅ Campus added.', 'success');
  }
}
$('cmp-new').addEventListener('keydown', e => { if (e.key === 'Enter') addCampus(); });

function startEditCampus(btn) {
  editingCampus = btn.dataset.campus;
  renderCampuses();
}

function cancelEditCampus() {
  editingCampus = null;
  renderCampuses();
}

async function saveEditCampus() {
  const name = $('cmp-edit-input').value.trim();
  const oldName = editingCampus;
  if (!name || name === oldName) { cancelEditCampus(); return; }
  if (await campusAction({ action: 'edit', oldName, name })) {
    setMsg('✅ Campus renamed — wins and players moved with it.', 'success');
  }
}

async function removeCampus(btn) {
  if (await campusAction({ action: 'remove', name: btn.dataset.campus })) {
    setMsg('✅ Campus removed from the join screen.', 'success');
  }
}

// ── Actions ──

async function refreshAll() {
  setMsg('Refreshing…');
  await refreshOverview();
  if (historyLoaded) await loadHistory();
  if (chatLoaded) await loadChat();
  if (phrasesCache !== null) await loadPhrases();
  if (campusesCache !== null) await loadCampuses();
  setMsg('');
}

async function doSuspend() {
  const btn = $('suspend-btn');
  btn.disabled = true; // no double-fires while the request is in flight
  setMsg(isSuspended ? 'Resuming…' : 'Suspending…');
  try {
    const data = await api('/admin/suspend', { active: isSuspended }); // active:true = resume
    if (data.ok) {
      isSuspended = data.suspended;
      updateStatusUI();
      setMsg(isSuspended ? '✅ Stats screen shown to all players.' : '✅ Play resumed.', 'success');
    } else {
      setMsg('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// Two clicks within 4s required — this one erases everything, forever
let hardResetTimer = null;
async function doHardReset(btn) {
  if (!hardResetTimer) {
    btn.textContent = '⚠️ Click again to erase everything';
    hardResetTimer = setTimeout(() => {
      hardResetTimer = null;
      btn.textContent = '🧹 Erase All History';
    }, 4000);
    return;
  }
  clearTimeout(hardResetTimer);
  hardResetTimer = null;
  btn.textContent = '🧹 Erase All History';
  btn.disabled = true;
  setMsg('Erasing all history…');
  try {
    const data = await api('/admin/hard-reset');
    if (data.ok) {
      historyLoaded = false;
      chatLoaded = false;
      await refreshOverview();
      setMsg('✅ All game history erased — fresh slate.', 'success');
    } else {
      setMsg('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function doReset() {
  const btn = $('reset-btn');
  btn.disabled = true;
  setMsg('Resetting…');
  try {
    const data = await api('/admin/reset');
    if (data.ok) {
      historyLoaded = false; // stale — refetches next time the tab opens
      chatLoaded = false;    // chat log was wiped with the reset
      await refreshOverview();
      setMsg('✅ Scores reset! Everyone starts fresh.', 'success');
    } else {
      setMsg('❌ ' + (data.error || 'Failed'), 'error');
    }
  } catch {
    setMsg('❌ Could not connect to server.', 'error');
  } finally {
    btn.disabled = false;
  }
}
