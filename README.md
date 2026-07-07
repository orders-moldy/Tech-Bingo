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
- **Device ID anti-cheat** — one game per device; opening a second tab signs out the first
- **Auto reset** — 6-second countdown after a bingo, then new cards for everyone

## Admin (`/admin.html`)

Enter the admin password to unlock two controls:

1. **📊 Show Stats Screen** — pauses play and pushes a full-screen leaderboard + most-marked-tiles summary to every player. Click again to resume.
2. **🗑️ Reset Scores** — archives the weekend scoreboard and emails a summary (leaders, full list, most-marked tiles). Archived weekends stay visible in Win History.
3. **📜 Win History** — all-time champions (total wins + weekend titles) and past weekend winners, accumulated across every weekend played.

A live chat feature is specced but not built yet — see [CHAT-ROADMAP.md](CHAT-ROADMAP.md).

## Editing phrases

Edit **`phrases.json`** — a plain list of strings. Keep 30+ so cards vary (the game picks 24 per card). Watch for a trailing comma after the last phrase — that breaks the deploy.

After editing:

```bash
git add phrases.json
git commit -m "Update phrases"
git push
```

Render redeploys automatically on push.

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
