# Bingo

Multiplayer buzzword bingo for live events. Players listen to a speaker and tap tiles when they hear a phrase. First to get 5 in a row wins.

## Setup

### 1. Install Node.js

Download and run the installer from **https://nodejs.org** (choose the LTS version).

### 2. Install dependencies

```bash
cd bingo
npm install
```

### 3. Customize your phrases

Edit **`phrases.json`** — it's just a list of strings. Add as many as you want (50+ recommended so cards vary). The game picks 24 randomly per card and rotates recently-used phrases out after each win.

```json
[
  "your custom phrase",
  "another phrase",
  ...
]
```

### 4. Run locally

```bash
npm start
```

Open `http://localhost:3000` in a browser. Share your machine's local IP (e.g. `http://192.168.1.x:3000`) so others on the same Wi-Fi can join.

---

## Deploy to the web (Render)

So anyone with a link can play from anywhere:

1. Push this folder to a GitHub repo
2. Go to **https://render.com** → New → Web Service
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Deploy — Render gives you a public URL to share

> Render's free tier spins down after 15 min of inactivity. For a weekly event, just open the URL a minute before you start so it wakes up.

---

## How it works

- Each player joins with their name and gets a unique 5×5 card
- Center square is always FREE
- Tap a tile when you hear the phrase — the server registers it
- First to complete a row, column, or diagonal triggers a BINGO announcement for everyone
- Anyone can click **New Game** — all players get fresh cards with rotated phrases
