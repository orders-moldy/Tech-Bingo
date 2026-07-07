# TCC Tech Bingo

Multiplayer buzzword bingo for live services. Players listen to the speaker and tap tiles when they hear a phrase. First to get 5 in a row wins — then everyone automatically gets a fresh card.

**Live at:** https://tech-bingo.onrender.com

## Features

- **Multiplayer** — everyone with the link plays live via Socket.io
- **Campus grouping** — players join under their campus (Plainfield, Bolingbrook, South Naperville, Naperville, Hinsdale, Wheaton)
- **Weekend scoreboard** — Saturday, Sunday, and overall Weekend leaders, persisted in PostgreSQL (times are Chicago-local, so the 6pm Saturday service counts correctly)
- **Top 3 leaderboard** — gold / silver / bronze
- **Phrase rotation** — phrases from winning cards sit out for 3 games so cards stay fresh
- **Most Marked tiles** — top 3 phrases appear in the sidebar after 4+ weekend wins
- **Hot glow** — players one tile away from bingo pulse in the player list
- **Live chat** — one shared room for all campuses (own column right of the card on desktop, collapsible panel below it on mobile; last 50 messages replay on join). The full weekend log is stored in the database and viewable in the admin Chat tab; it's deleted at weekend reset.
- **Device ID anti-cheat** — one game per device; opening a second tab signs out the first
- **Auto reset** — 6-second countdown after a bingo, then new cards for everyone

## Admin (`/admin.html`)

Enter the admin password to unlock two controls:

1. **📊 Show Stats Screen** — pauses play and pushes a full-screen leaderboard + most-marked-tiles summary to every player. Click again to resume.
2. **🗑️ Reset Scores** — archives the weekend scoreboard and emails a summary (leaders, full list, most-marked tiles). Archived weekends stay visible in Win History.
3. **📜 Win History** — all-time champions (total wins + weekend titles) and past weekend winners, accumulated across every weekend played.
4. **💬 Chat** — the full weekend chat log (deleted at reset).
5. **🧩 Phrases** — add, edit, or remove the phrases that feed the bingo tiles.

## Editing phrases

Use the **Phrases tab in the admin dashboard** (`/admin.html`) — add, edit, or remove phrases right from the browser. Changes are stored in the database, survive restarts, and apply to cards dealt after the next bingo. The editor won't let the list drop below 24 (a full card).

`phrases.json` is only the seed for the very first boot (or the fallback when no database is configured). Keep 30+ phrases so cards vary.

## Environment variables (set in Render)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (scores persist across server sleeps) |
| `ADMIN_PASSWORD` | Password for `/admin.html` |
| `GMAIL_USER` | Gmail address that sends the summary email |
| `GMAIL_APP_PASSWORD` | Gmail app password for that account |

Without `DATABASE_URL`, scores fall back to memory and reset when the server sleeps. Without the Gmail vars, the reset still works — it just skips the email.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Share your machine's local IP (e.g. `http://192.168.1.x:3000`) so others on the same Wi-Fi can join.

> Render's free tier spins down after 15 min of inactivity. Open the URL a minute before the service starts so it wakes up.
