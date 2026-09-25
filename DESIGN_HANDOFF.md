# UX/UI design handoff

Handoff for whoever designs the frontend next. The game works end to end and has been tested by the user with
real players. **Your job is the look and feel.** Game rules, timing and networking are done and live on the server.
Read `CLAUDE.md` (project context) and `README.md` (game rules, code map) first.

## Ground rules
- **Only touch `web/`** (`web/src/*.tsx`, `web/src/styles.css`, `web/index.html`, assets). Don't change `server/`
  or `shared/types.ts` unless a design truly needs data the server doesn't send. If it does, add a field to the
  view types, fill it in `Room.view()`/`gameView()` in `server/room.ts`, and keep `npm test` green.
- **The server decides everything.** The UI renders the latest `RoomView` snapshot (`shared/types.ts`), which is
  pushed on every change, and sends actions. Never infer game state on the client or add timers that move the game forward.
- **Don't break `web/src/media.ts` or `net.ts`.** They handle clock sync, synchronized playback, preloading, mirror
  fallback and autoplay unlocking. Your components only *read* `media.status` and host the video element (see below).
- Keep it working on **phones** (friends will play from mobile browsers) and on desktop. The current CSS already
  collapses to one column under 800px.
- The user hasn't given any visual direction yet (theme, branding, mood). **Ask them** before committing to a style.

## Run it and reach every screen
```bash
npm install
npm run dev        # http://localhost:5173 (hot reload). Site password: Guigayafuu
```
- **Solo** gets you through every screen: create a room, set *Rounds 2, Guess time 5, Reveal time 5*, and start.
- Open a **private window** as a second player to see multiplayer states: other players' lock status, results
  tables with several rows, the waiting states for non-admins, and offline players (close the window).
- The URL `/r/<CODE>` opens a room directly. Reloading mid-game rejoins automatically.
- `window.aqMedia` in the browser console exposes the media engine (status, audio/video elements) for debugging.

## Screens and states
All in `web/src/`. Class names below are the current CSS hooks; rename them freely.

| Screen | Component | Shown when | Data / actions |
|---|---|---|---|
| Login | server `server/login.html` (prod) and `Login` in `App.tsx` (dev) | No auth cookie | POST `/api/login`. **Two copies:** in production the server serves the standalone `server/login.html` (the SPA isn't sent to unauthenticated users), so style both or make them match. |
| Room browser | `Browser.tsx` | Path `/` | Room list (`GET /api/rooms`, polled every 4 s: name, code, online/total, in game), join by code, create room (your name, room name, room password), log out |
| Join room | `JoinForm` in `App.tsx` | Opening `/r/CODE` as a non-member | Name + room password. Errors: wrong password, name taken, room full |
| Room shell | `RoomScreen` in `Room.tsx` | Joined | Header (room name, code, copy link, volume, leave) + main area + players sidebar |
| Players sidebar | `Players` in `Room.tsx` | Always in a room | Online dot, name, "(you)", admin ★, points during a game, answer status during guessing (… / ✎ picked / 🔒 locked). The admin also sees make-admin ★ and kick ✕ buttons. Offline players are struck through |
| Lobby | `Lobby` + `SettingsForm` in `Room.tsx` | No game running | Settings (editable by the admin only, read-only for others), "N songs match", Start (admin), Delete room (admin), room ranking table |
| Loading | `Loading` in `Game.tsx` | `game.phase === 'loading'` | Usually 1–3 s. Status: loading / loaded, waiting for others / failed on your side. Shows "Waiting for players to connect" when the game is on hold (`phaseEndsAt === null`) |
| Guessing | `Guessing` + `GuessInput.tsx` | `phase === 'guessing'` | Short "Starting…" lead-in (~1.2 s, until `clipStartAt`), then a countdown bar, the answer input with autocomplete, a Lock in button, and "X / Y locked in". **Audio only; nothing on screen may hint at the answer.** |
| Reveal | `Reveal` in `Game.tsx` | `phase === 'reveal'` | Your verdict (correct +points / wrong / no answer / missed), **the video** (continues from where the audio stopped), cover, title (+ romaji/native), "Opening N: song by artist", format · year · tier · AMQ %, "also accepted", results table (every player's answer, ✅/❌, points, time), "Next song (votes/online)", countdown, paused notice |
| Final results | `Finished` in `Game.tsx` | `phase === 'finished'` | Standings (🏆), per-song history with covers and how many got it, room ranking. Admin: Play again / Back to lobby |
| Admin bar | `GameArea` header | Admin, during a game | Pause/Resume, Skip song (becomes "Next" during reveal), End game |
| Global banners | `App.tsx` | — | "Connecting to the server…", dismissable notices (kicked, room deleted, errors), "Click to enable sound" (`media.status.blocked`), and an overlay when the room is opened in another tab ("Play here instead") |

Good places to add polish (none of these need server changes):
- Countdown in the last seconds, a reveal animation, and correct/wrong feedback.
- A visible "music is playing" indicator during guessing, such as an equalizer driven by `media.status.audioState`.
- A standings podium, and highlighting who got it fastest.
- A game-progress indicator: `game.round`, `game.totalRounds` and `game.history` are all available.
- Empty and edge states: a lobby with nobody else, 0 songs matching, a very long anime title, a 20+ player list.

## Technical constraints for the designer
- **Video element:** `media.video` is one persistent `<video>` element created by `media.ts`. `Reveal` appends it
  into `.video-box` on mount and removes it on unmount. Don't render your own `<video>` for the reveal. Keep an element
  with a ref and append `media.video` the same way. Style it through the `.reveal-video` class.
- **Autoplay:** browsers only allow sound after a click. `media.unlock()` must be called **inside the click handler**
  of buttons that lead into audio: Join, Create room, Start game, Play again, "Click to enable sound", and
  "Play here instead". Keep these calls if you restyle or replace those buttons.
- **Answer input behaviour (`GuessInput.tsx`)** is part of the game design, so keep it:
  - Picking a title sets the answer, and it can be changed until locked.
  - Enter picks the highlighted item. Enter with the list closed locks the answer.
  - The input autofocuses when the clip starts.
  - The list shows one entry per franchise.
- **Timers:** render from `phaseEndsAt` / `clipStartAt` with `serverNow()` (see `useCountdown`), never `Date.now()`.
  `phaseEndsAt` can be `null` (game on hold, or reveal paused), so show no countdown then.
- **Errors from actions** come back as `{ ok: false, error }` and are shown in the room banner (`act()` in `Room.tsx`).
- The autocomplete data (`/api/titles`, ~250 KB gzipped) loads when the Guessing screen first mounts. You could
  preload it in the lobby if you like (`useTitleIndex()`).
- Available per-anime visuals: `answer.cover` (AniList cover, portrait), and cover URLs in `game.history`. There
  are no banners or backgrounds in the dataset. `build_dataset.py` could fetch AniList `bannerImage` if a design
  needs it; that's a data change, so check with the user.
- No UI library or CSS framework is installed. Choose one if you want (keep the bundle reasonable for phones), or
  stay with plain CSS. Fonts must be self-hosted or from a CDN.

## Current design (2026-09-25): "Petit Quiz", night stage
Chosen with the user: a dark stage, one hot accent, English copy, tasteful motion (no confetti).
- **Tokens** are at the top of `web/src/styles.css` (`--bg`, `--surface*`, `--accent` magenta `#e3206f`, `--pink`, `--cyan`
  for focus/secondary, `--good`/`--bad`/`--warn`, radii). Plain CSS, no framework. Motion respects `prefers-reduced-motion`.
- **Font:** Outfit Variable, self-hosted through `@fontsource-variable/outfit` (32 KB woff2, latin). `server/login.html` can't
  reach bundled assets before auth, so it loads Outfit from Google Fonts and copies the tokens inline. **Keep it in sync with
  `Login` in `App.tsx`.**
- **Primitives** are in `web/src/ui.tsx`: `Logo`/`LogoMark` (equalizer-bar mark, same motif as the in-game equalizer), `Icon` (inline
  stroke SVGs), `Avatar` (initial plus a stable hue per name), `useCopy`, `Toast`. Favicon: inline SVG data URI in `index.html` and `login.html`.
- **Screens:** the home page has a room list plus a create form, and a join-by-code row. The lobby is start card (pool size, Start, invite
  hint when alone), then settings (steppers, toggle chips, segmented control, switches), then ranking. Guessing shows an equalizer
  (`media.status.audioState === 'playing'`), a big countdown that turns red and ticks in the last 5 s, and faces showing who locked in. Reveal
  has the verdict pill with Next/votes in the same row, the video, and answer details, with results sorted correct first and the fastest correct
  marked with ⚡. Finished shows a podium (2nd, 1st, 3rd), a card grid of the songs, and the ranking.
- **Phones (<900px / <600px):** one column, players card after the game area (in the lobby it sits between the start card and the settings,
  using `display: contents`). The logo is hidden in the room top bar, and the autocomplete list spans the input and the Lock button. Inputs are 16px+ so iOS doesn't zoom.
- During a game the players list is sorted by points (display only). The lobby preloads the autocomplete index.
- Not covered by QA yet: Safari/iOS on a real device, 20+ players, very long titles in the podium.

## Checklist before you hand back
- [ ] `npm run typecheck` and `npm test` pass. `npm run build` succeeds.
- [ ] Played a full game solo **and** with a second window, on desktop width and on a phone-sized viewport (~375px).
- [ ] Reveal video plays and is framed well. Nothing during guessing gives the answer away.
- [ ] `server/login.html` matches the new look.
- [ ] Update this file and `CLAUDE.md` (status) with what changed.
