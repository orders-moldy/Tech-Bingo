# Live Chat — Build Roadmap

A complete spec for adding player chat to TCC Tech Bingo at the same standard as the rest
of the game. Written so any developer (or AI session) can implement it without extra context.

**Decision already made:** one shared room for all campuses (not campus-scoped).

---

## Ground rules (match the existing codebase)

- No build step, no new dependencies. Plain JS in `public/client.js`, plain CSS in `public/style.css`, socket handlers in `server.js`.
- Follow the section-comment structure already in each file (numbered `── N. Title ──` banners).
- **Every player-typed string must be escaped with the existing `esc()` helper in client.js before touching `innerHTML`**, and stripped of `<>` on the server (see `cleanName()` for the pattern).
- Use the CSS design tokens in `:root` (`--surface`, `--accent`, `--line`, `--muted`, `--radius`) — no hardcoded colors.
- Messages are **in-memory only** (no DB). Render's free tier sleeps between services; losing chat history is fine and keeps this simple.

## Server (`server.js`)

State (add near the other `let` declarations in section 1):

```js
const CHAT_HISTORY_MAX = 50;    // ring buffer sent to new joiners
const CHAT_MSG_MAX_LENGTH = 200;
const CHAT_COOLDOWN_MS = 1500;  // min gap between messages per player
let chatHistory = [];           // [{ name, campus, text, ts }]
```

Socket handler (add inside `io.on('connection', ...)` next to `mark`):

```js
socket.on('chat', text => {
  const p = players[socket.id];
  if (!p) return;                                    // must be joined
  if (typeof text !== 'string') return;
  const clean = text.replace(/[<>]/g, '').trim().slice(0, CHAT_MSG_MAX_LENGTH);
  if (!clean) return;
  const now = Date.now();
  if (p.lastChatAt && now - p.lastChatAt < CHAT_COOLDOWN_MS) return;  // rate limit
  p.lastChatAt = now;

  const msg = { name: p.name, campus: p.campus, text: clean, ts: now };
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
  io.emit('chat', msg);
});
```

Send history to joiners — add `chatHistory` to the `joined` payload in the `join` handler.

**Do not** clear `chatHistory` on `startNewGame()` (chat spans games). Optionally clear it in
`/admin/reset` (end of the weekend event).

## Client (`public/client.js`)

- New section `── 7. Chat ──` after Confetti.
- On `joined`: render `chatHistory` into the panel.
- On `socket.on('chat', msg)`: append one message.
- Sending: input + button; `Enter` sends; clear input after emit; ignore empty. Disable the
  input while the stats overlay is visible (play is suspended — screens are covered anyway).
- Render each message with `esc()` on name AND text:

```js
const mine = msg.name === myName;
row.innerHTML = `<span class="chat-name${mine ? ' me' : ''}">${esc(msg.name)}</span>
                 <span class="chat-text">${esc(msg.text)}</span>`;
```

- **Auto-scroll rule:** scroll to bottom on new message ONLY if the user is already within
  ~40px of the bottom. If they've scrolled up to read, don't yank them down — show a small
  "↓ new messages" pill (click = scroll to bottom) instead.
- Keep it lightweight: cap the DOM at ~100 message nodes (drop the oldest).

## UI placement (`public/index.html` + `public/style.css`)

- **Desktop:** new grid row in `#content` — `grid-column: 2; grid-row: 4;` (under the players
  list, same column as the card). A collapsed bar ("💬 Chat") that expands to a ~220px-tall
  panel: message list + input row.
- **Mobile (`max-width: 620px`):** `grid-row: 4` full width, above the scoreboard (bump
  `#sb-title` to row 5 and `#scoreboard` to row 6 in the media query).
- Style: same card treatment as `#scoreboard` (gradient surface, `1px solid var(--line)`,
  `var(--radius)`, `--shadow-card`). Own messages tinted with `rgba(155,182,191,0.08)` like
  `.player-chip.me`. Names in `var(--accent)`, timestamps optional in `var(--muted)`.
- Input: reuse the shared `input[type="text"]` styles (they're global). Send button is small —
  override the global `button { width: 100% }` with a scoped `.chat-send { width: auto }`.

## Edge cases to handle

| Case | Behavior |
|---|---|
| Player kicked (second tab) | Old tab's input disabled by `showJoinScreen()` — nothing extra needed if the panel lives inside `#game-screen` |
| Suspended (stats overlay up) | Overlay covers the screen; also guard server-side: ignore `chat` while `suspended` if you want silence during stats |
| Server sleeps / restarts | History is lost — acceptable, document in README |
| Spam | Server cooldown (1.5s) + 200-char cap; client disables send button during cooldown for good UX |
| Emoji | Works natively — no special handling |

## Testing checklist (mirror the verification done for other features)

1. `node --check server.js && node --check public/client.js`
2. Two browser contexts: join as two players, exchange messages both directions.
3. Send `<img src=x onerror=alert(1)>` as a message → must render as literal text.
4. Spam Enter rapidly → only ~1 message per 1.5s lands.
5. Scroll up in history, receive a message → no auto-scroll, pill appears.
6. Refresh page, rejoin → last 50 messages restored.
7. Mobile viewport (375px): panel usable, keyboard doesn't cover input (test `100dvh`).
8. Mark tiles while chat is open → game still works; bingo overlay sits above chat.

## Out of scope (deliberately)

- Profanity filtering (church crowd, small trusted group — revisit if needed)
- Persistence, DMs, campus-scoped rooms, moderation tools, typing indicators
