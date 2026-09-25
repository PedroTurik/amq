# Anime Opening Quiz: project handoff

## Goal
A web app where the user and their friends hear/see an anime opening and guess which anime it is.
Rounds pick random openings filtered by **difficulty** (mainly how popular the anime is).

## Status (2026-09-25)
- **Phase 1 is done: data research and dataset.** `openings.json` is a ready-to-use static dataset.
  Full evidence and reasoning are in `DATA_FINDINGS.md`. Read it before changing the data approach.
- **Phase 2 has not started: the app.** No app code, framework, or repo exists yet (the folder is not a git repo).

## Open decisions for the user
Ask about these before building. None of them are decided:
1. Tech stack and hosting. The user hasn't expressed a preference.
2. Multiplayer model: one shared screen (party mode) or everyone on their own device (needs a realtime backend).
3. Answer input: free text with autocomplete, or multiple choice.
4. Media: video, audio only, or both as modes. Clip length and start point (random offset or start of the song).
5. How difficulty is chosen (fixed tiers vs. sliders) and the tier thresholds (defaults below).

## Files
| File | What it is |
|---|---|
| `build_dataset.py` | Reproducible builder. Python 3 stdlib only. **Run it from this folder** (it reads/writes relative paths). `python3 build_dataset.py [N=3000]` takes ~3 min. |
| `openings.json` | **The dataset for the app.** 3,272 openings / 2,406 anime / 1,700 franchises (top 3,000 AniList anime). |
| `anilist_top.json` | Raw AniList top-N (incl. entries with no openings) with `popularityRank` and `franchiseId`. Useful for autocomplete, because it lists titles of every popular anime, not just the answers. |
| `anisongdb_openings_raw.json` | Raw crawl of **all** 8,873 AnisongDB openings (all anime, raw AnisongDB schema). |
| `anime_ids.json` | User-provided id map, keyed by **AniDB id** → `{mal_id, anilist_id, tvdb_id, ...}` (17k entries, 1.7 MB; query it programmatically). The builder uses it as a join fallback. |
| `DATA_FINDINGS.md` | Research report: sources compared, coverage numbers, rejected options. |

## `openings.json` schema (array of objects, one per opening)
| Field | Type | Notes |
|---|---|---|
| `anilistId` | int | AniList id of the anime entry |
| `malId` | int | MyAnimeList id |
| `franchiseId` | int | Same value for all seasons/movies of one franchise (AniList SEQUEL/PREQUEL/PARENT union-find). **Use it for answer checking.** |
| `annId`, `amqSongId` | int | AnimeNewsNetwork anime id / AMQ song id (from AnisongDB) |
| `titles` | object | `romaji` (always set), `english` (**null for 125 rows**), `native`, `synonyms` (array), `amqEN`, `amqJP` (AMQ's naming) |
| `format` | string | TV (2832), ONA, MOVIE, OVA, TV_SHORT, SPECIAL |
| `year` | int\|null | null for 10 rows |
| `genres` | string[] | AniList genres |
| `cover` | url | AniList cover image (for the reveal screen) |
| `popularity` | int | AniList member count |
| `popularityRank` | int | 1 = most popular, within the top N fetched |
| `songType` | string | "Opening 1", "Opening 2", ... (only openings are included) |
| `songName`, `songArtist` | string | |
| `songDifficulty` | float 0–100 | % of AMQ players who guessed it. **Higher = easier.** Always set in the current data (one row is 0). |
| `songLength` | float s | Usually ~90. **Outliers: 15 rows under 30s, 35 rows over 150s (max 667).** Clamp the clip window. |
| `video` | url | Always set: 720p webm if available, else 480p |
| `videoMQ` | url\|null | 480p webm, ~11 MB. **null for 2,102 rows.** Prefer it when present. |
| `audio` | url\|null | 320 kbps mp3, ~3 MB. null for 30 rows |

## Data gotchas (verified)
- **The same song is reused across several anime.** 129 `amqSongId`s appear more than once. *CHA-LA HEAD-CHA-LA*
  shows up in 12 Dragon Ball Z movies **and** *Gintama: THE FINAL*. When picking a round, dedupe by
  `amqSongId`. When checking an answer, accept every anime/franchise that uses that `amqSongId`.
- Big franchises have many openings (One Piece, Naruto, Dragon Ball...). Uniform random sampling over
  rows over-represents them. Consider sampling a franchise first, then one of its openings.
- AnisongDB's MAL links are sometimes wrong. That's why the builder joins on AniList id → AniDB (via `anime_ids.json`) → MAL.
- AMQ difficulty alone misjudges "easy" for a casual group (niche shows score high). Combine it with popularity:
  ```python
  def tier(r):  # defaults validated by sampling; tune with the user
      p, d = r["popularityRank"], r["songDifficulty"] or 0
      if p <= 250 and d >= 55: return "easy"     # ~309 OPs
      if p <= 800 and d >= 35: return "medium"   # ~668
      if p <= 2000: return "hard"                # ~1361
      return "expert"                            # ~934
  ```
- Franchise grouping deliberately ignores SIDE_STORY/SPIN_OFF (they chain unrelated shows together). Spin-offs
  therefore count as separate answers.
- Missing on purpose: shows without openings, Chinese donghua (AMQ excludes them), and some 2025+ seasons AMQ
  hasn't added. Re-running the builder picks up new data.

## Media playback facts (verified with curl/ffprobe, not yet in a real browser)
- Hosts: `naedist.animemusicquiz.com` (used in the dataset, fastest from the user's location, which is probably
  Brazil: ~2 MB/s, ~1.1s TTFB), `eudist.` (similar), `nawdist.` (slower). Same file names on every mirror.
  `files.catbox.moe` returns empty bodies, so don't use it.
- `Access-Control-Allow-Origin: *`, range requests supported, so seeking works and `<video>`/`<audio>` can use the URLs directly.
- Codecs: VP9 + Opus webm (plays in Chrome/Firefox/Edge; **Safari/iOS webm support is shaky, so test it or use the mp3 `audio`**), MP3.
- At ~2 MB/s a 480p file takes ~5s and 720p takes 15–30s. **Preload the next round's media.**
- Browsers block autoplay with sound until a user gesture, so start the first round from a click.
- Hide the video element (or show only audio) while guessing. Reveal the video, `cover` and titles afterwards.

## External APIs (for rebuilding or extending the data)
- **AnisongDB**: `https://anisongdb.com/api/*`, docs at `https://anisongdb.com/docs`, OpenAPI at `/openapi.json`. POST JSON, no auth.
  - `season_request` `{"season":"Fall 2023","filters":{"song_types":["opening"]}}`: used by the builder for the full crawl.
  - `get_n_random_songs` `{"n":8,"filters":{"song_types":["opening"],"anime_types":["tv"],"difficulty":{"start":60,"end":100},"media_links":{"require_any":["HQ","MQ"]}}}`
    (n ≤ 500). This could act as a live backend, but the plan is a static dataset.
  - `mal_ids_request` (≤500 ids), `search_request`, `ann_ids_request`, `database_stats`.
  - Filter enums: song_types `opening|ending|insert`. broadcasts `normal|dub|rebroadcast`. anime_types
    `tv|movie|ova|ona|special|other`. song_categories `standard|character|chanting|instrumental|other`.
  - Raw song fields: `HQ`/`MQ`/`audio` are **bare file names**; prefix them with a media host.
- **AniList GraphQL**: `POST https://graphql.anilist.co`. **Send a User-Agent header** (Python's default gets 403).
  Currently rate limited to ~30 req/min (the builder sleeps 2.1s between pages). `perPage` max 50.
- **Jikan** (`api.jikan.moe/v4`) and the **AnimeThemes API** (`api.animethemes.moe`) were down the whole research
  session (504 / 522). Don't depend on them at runtime. AnimeThemes is a possible secondary video source later.
- **YouTube** via `yt-dlp "ytsearch3:<anime> opening <n> <song>"` is a fallback only. It's unreliable for obscure
  songs, and the video titles give the answer away.


