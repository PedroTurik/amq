# Anime Opening Quiz: data findings

Tested 2026-09-24/25. The data problem is solved: `build_dataset.py` produces a ready-to-use
`openings.json` with **3,272 playable openings from the top 3,000 anime**. Each opening has a
direct video URL, an audio URL, a popularity rank, an AMQ difficulty score, all titles/synonyms,
and a franchise ID.

## Recommended stack

| Need | Source | Why |
|---|---|---|
| Opening videos + audio | **AnisongDB** (`anisongdb.com/api`) + AMQ media mirrors | Actual OP clips (~90s, TV-size), 720p VP9 webm + mp3, `Access-Control-Allow-Origin: *`, range requests, so they play straight in a `<video>`/`<audio>` tag |
| Song difficulty | **AnisongDB `songDifficulty`** | % of AnimeMusicQuiz players who guessed that song correctly. It measures the *song*, not the show |
| Anime popularity, titles, covers, franchise | **AniList GraphQL** | `sort: POPULARITY_DESC`, English/romaji/native titles + synonyms (for answer matching), relations (for grouping seasons) |
| ID cross-check | `anime_ids.json` (keyed by AniDB id) | Fixes cases where AnisongDB's linked MAL id is wrong (see below) |
| Fallback for missing songs | YouTube via `yt-dlp` search | Only if you want to cover newer or Chinese shows; unreliable for obscure titles |

## Evidence

### AnisongDB (winner)
- 38,821 songs / 9,516 anime. **8,873 openings**, 28,875 songs with HQ video, 37,939 with audio.
- Endpoints that matter: `season_request` (used for a full crawl in about 1 minute), `mal_ids_request`
  (≤500 ids), `get_n_random_songs` (n ≤ 500, with filters for song type / anime type / season /
  **difficulty range** / genres / tags / required media). The random endpoint alone could act as a live backend.
- The media file name from the API is served by `https://naedist.animemusicquiz.com/<file>` (US),
  `eudist.` (EU), and `nawdist.` (US-West). `files.catbox.moe` returned empty bodies, so don't use it.
- Measured files: HQ = 1280×720 VP9/Opus, ~90s, 30–60 MB. MQ = 640×480, ~11 MB. Audio = 320 kbps mp3, ~3 MB.
  **Use MQ or audio for a quiz.** HQ is heavy for several friends on one connection.
- I checked frames from the AoT OP1 file against the listed metadata, and they match on both mirrors.

### Coverage: top AniList anime (TV/ONA) that have ≥1 opening
| Popularity rank | Coverage |
|---|---|
| 1–100 | 100% |
| 101–300 | 100% |
| 301–700 | 96.8% |
| 701–1500 | 96.6% |
| 1501–3000 | 89.9% |

Most of the remaining misses are expected: shows with no opening (*From the New World*, *Sonny Boy*,
*PLUTO*), Chinese donghua (AMQ excludes them: *Link Click*, *Lord of Mysteries*), and some 2025
seasons AMQ hasn't added yet.

### AnisongDB data quality issue, and the fix
*Classroom of the Elite* is linked to MAL 30813 in AnisongDB (correct is 35507), but its AniList and
AniDB ids are correct. So the builder crawls all openings and joins on **AniList id →
AniDB id (via anime_ids.json) → MAL id**, in that order. That brought top-300 coverage from 99.7% to 100%.

### Difficulty: use both signals
AMQ difficulty drops with AniList popularity rank (median 65 for the top 100, 31 for ranks
1501–3000), so the signals agree in general. AMQ's player base is hardcore, though, and on its own
it puts niche shows (*Teekyuu* 72%, *Nyanbo!* 77%) into "easy". There are 76 such cases in the
dataset. A hybrid rule looked right on random samples:

```
easy    popularityRank ≤ 250  and songDifficulty ≥ 55   (~309 OPs: Re:Zero OP2, Madoka, Naruto "Silhouette")
medium  popularityRank ≤ 800  and songDifficulty ≥ 35   (~668 OPs: Bleach OP4, One Piece OP25, Blood Lad)
hard    popularityRank ≤ 2000                            (~1361 OPs)
expert  everything else                                  (~934 OPs)
```
Tweak the thresholds to fit your group. Running `build_dataset.py 5000` extends the pool.

### Answer matching
`franchiseId` (union of AniList SEQUEL/PREQUEL/PARENT relations) groups 3,000 entries into 1,897
franchises. For example, all 16 AoT entries share one id, and Dragon Ball (25 entries) and Naruto/Boruto are
each grouped. Accept any title/synonym of any entry in the same franchise. `titles` also includes AMQ's own
English and Japanese names.

### Tested and rejected as the primary source
- **Jikan** (`/anime/{id}/themes`): returned 504 for the whole ~30 min session (MyAnimeList
  upstream down). Even when it works, it gives only song *names*, with no media and no difficulty.
- **AnimeThemes.moe API**: Cloudflare 522 for the whole session. It's a good dataset with creditless
  OP webms, but it has no difficulty metric, and today's outage shows the risk of depending on it at runtime.
  It could serve as a secondary video source later.
- **YouTube search** (`yt-dlp "ytsearch:<anime> opening <n> <song>"`): popular OPs return the official
  Crunchyroll or creditless upload first, and oEmbed says they can be embedded. Obscure OPs return wrong
  results (full songs, piano covers). Video titles also give the answer away, and takedowns are common.
  Use it as a fallback only.
- **AniList**: no theme-song data at all, but it's the best source for popularity, titles and relations. It
  returns 403 to Python's default User-Agent, so send one. It's currently limited to ~30 req/min.

## Recommendations for the app
1. **Pre-build the dataset** (`python3 build_dataset.py`) and ship `openings.json` as a static file.
   Don't call Jikan, AnimeThemes or AniList live, because all three were degraded or down during this session.
   Re-run it every season.
2. Play `videoMQ ?? video` (or `audio` for an audio-only round). Start at a random offset between
   0 and `songLength - clipLength`. Seeking works through range requests.
3. Hide the video while guessing, then reveal it along with the cover and title.
4. Media URLs point at AMQ's CDN, which you depend on without an agreement. That's fine for a private game
   with friends, but mirror the files you use if this ever becomes public.

## Files
- `CLAUDE.md`: handoff doc for the next agent: schema, gotchas, open decisions (start there)
- `build_dataset.py`: reproducible builder (stdlib only; runs in about 3 min)
- `openings.json`: the joined dataset (one row per opening)
- `anilist_top.json`: raw AniList top-N with `franchiseId`
- `anisongdb_openings_raw.json`: the raw AnisongDB crawl of all 8,873 openings (all anime, not only the top N)
