# Anime Opening Quiz

A multiplayer game for friends: everyone in a room hears the same anime opening and guesses the anime.
The video is revealed afterwards, continuing from where the audio stopped.

## Run it

Requires Node 18.18+ (Node 22 recommended).

```bash
npm install
npm run dev          # server on :3000 + Vite on http://localhost:5173 (hot reload)
npm test             # unit + socket end-to-end tests
npm run build && npm start   # production: one process on :3000 serving everything
```

The site password is `Guigayafuu` (override with `MASTER_PASSWORD`).

| Env var | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `MASTER_PASSWORD` | `Guigayafuu` | Changing it logs everyone out |
| `DB_PATH` | `data/anime-quiz.db` | SQLite file (rooms, players, rankings, running games) |
| `DATASET_DIR` | repo root | Where `openings.json` and `anilist_top.json` live |
| `TRUST_PROXY` | on | Set `0` if **not** behind a reverse proxy |

## Deploy on a VPS

```bash
git clone <repo> && cd anime-quiz
DOMAIN=quiz.example.com docker compose up -d --build
```

This runs the app plus Caddy, which terminates HTTPS with an automatic Let's Encrypt certificate and proxies
WebSockets. Point the domain's DNS at the VPS first, and open ports 80 and 443. Data lives in the `quizdata`
volume. It's a single Node process with SQLite, and a 1 vCPU / 512 MB box is plenty.

Without Docker, run `npm ci && npm run build && npm start` behind any reverse proxy that forwards WebSockets
(nginx needs `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

Media is streamed by each browser directly from AMQ's CDN, not through the server, so the VPS needs very little bandwidth.

## How it plays

1. Open the site, enter the site password, pick a name, and create a room (name + room password) or join one.
   Share the room link (`/r/CODE`). Friends still need the room password.
2. The room creator is the **admin** and sets the rounds, guess/reveal time, difficulty tiers, anime types,
   year range, clip start (random or beginning), speed bonus and repeat avoidance. The lobby shows how many songs match.
3. Each round: every client buffers the clip. The clip starts at the same moment for everyone once they're ready
   (at most 10 s wait), synchronized on the server clock.
4. Type and pick the anime from the autocomplete. **Any season or movie of the right franchise counts.**
   You can change your answer until you lock it. The round ends when every connected player has locked, or when time is up.
   An answer that isn't locked still counts at the deadline.
5. Reveal: the video continues from where the audio stopped. You also see the title, song and artist, and everyone's answers and points.
   The next round starts when the reveal timer ends or when everyone presses "Next".
6. Scoring: 100 points for a correct answer, plus up to 50 for speed if enabled. The room keeps an all-time ranking (wins, points, correct answers).

### Connection handling
- Each browser has a random secret token (localStorage). Reloading, losing Wi-Fi or reopening the link puts the
  player back in their seat with their points, and no password is needed.
- On another device, join with the **same name** while the old seat is offline to take it over (points included).
- A disconnected player is excluded from the current round: nobody waits for them to load or lock. They're back in
  as soon as they reconnect, even mid-round.
- If the admin is offline for 20 s, admin passes to the longest-present online player. The admin can also hand it
  over, kick players, pause (it holds on the next reveal), skip a song, or end the game.
- If nobody is connected, the game holds instead of burning rounds. Games also survive a server restart: they
  resume at the interrupted round.
- If a song fails to load for everyone, it's swapped for a reserve song. AMQ mirrors are tried in turn. If the video
  can't play (e.g. Safari without WebM), the song keeps playing during the reveal and the cover is shown.

## Code map

| Path | |
|---|---|
| `shared/types.ts` | Socket protocol, settings, view types (shared by server and client) |
| `shared/search.ts` | Autocomplete matching (accent/punctuation-insensitive, one entry per franchise) |
| `server/room.ts` | **The game engine**: room state machine (lobby → loading → guessing → reveal → finished), scoring, reconnects, admin, persistence |
| `server/rooms.ts` | Socket.IO layer: validation (zod), join/rejoin rules, broadcasting per-player views |
| `server/app.ts` | Express + Socket.IO, master-password gate, `/api/titles`, `/api/rooms` |
| `server/dataset.ts` / `picker.ts` | Loads the dataset, difficulty tiers, song selection (tier → franchise → song, no repeats) |
| `server/db.ts` | SQLite schema and queries |
| `web/src/media.ts` | Playback engine: syncs audio to the server clock, preloads, mirror fallback, autoplay unlock |
| `web/src/*.tsx` | React UI (deliberately plain for now) |

The server is authoritative and sends each player a full, personalized snapshot of the room on every change (small,
coalesced per tick). Clients hold no game logic, which is why a reconnect is just "send me the snapshot". Answers
are only revealed to clients after the round ends.
