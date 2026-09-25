"""Prototype dataset builder for the anime opening quiz (data exploration, not the app).

1. AniList  -> top N anime by popularity (titles, synonyms, popularity rank, cover, MAL id)
2. AnisongDB -> every opening for those MAL ids (AMQ difficulty, video/audio file names)
3. Join     -> openings.json: one row per playable opening

Usage: python3 build_dataset.py [N=3000]
"""
import json
import sys
import time
import urllib.request

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
ANILIST = "https://graphql.anilist.co"
ANISONG = "https://anisongdb.com/api"
MEDIA_HOST = "https://naedist.animemusicquiz.com"  # also eudist./nawdist. mirrors; CORS *

QUERY = """
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
      id idMal format season seasonYear popularity averageScore genres
      title { romaji english native } synonyms
      coverImage { large }
      relations { edges { relationType node { id type } } }
    }
  }
}"""


def post(url, body, retries=5):
    for attempt in range(retries):
        req = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "Accept": "application/json",
                                      "User-Agent": "anime-quiz-dataset/0.1"})  # AniList 403s urllib's default UA
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            wait = int(e.headers.get("Retry-After", 10 * (attempt + 1)))
            print(f"  HTTP {e.code} on {url}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"gave up on {url}")


def fetch_anilist(n):
    out = []
    page = 1
    while len(out) < n:
        data = post(ANILIST, {"query": QUERY, "variables": {"page": page}})["data"]["Page"]
        out += data["media"]
        print(f"  anilist page {page}: {len(out)} anime", file=sys.stderr)
        if not data["pageInfo"]["hasNextPage"]:
            break
        page += 1
        time.sleep(2.1)  # AniList is currently rate limited to ~30 req/min
    for rank, m in enumerate(out[:n], 1):
        m["popularityRank"] = rank
    return out[:n]


def fetch_all_openings():
    # Crawl every season instead of querying by MAL id: AnisongDB's linked MAL ids are
    # sometimes wrong (e.g. Classroom of the Elite), so we join locally on several ids.
    songs = []
    for year in range(1940, time.gmtime().tm_year + 1):
        for season in ("Winter", "Spring", "Summer", "Fall"):
            songs += post(f"{ANISONG}/season_request", {
                "season": f"{season} {year}",
                "filters": {"song_types": ["opening"]},
            })
        print(f"  anisongdb {year}: {len(songs)} openings", file=sys.stderr)
    return songs


def assign_franchises(anime):
    # Union-find over sequel/prequel/parent links so "Attack on Titan" matches every season.
    # SIDE_STORY/SPIN_OFF are left out: they chain unrelated shows together too eagerly.
    parent = {m["id"]: m["id"] for m in anime}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for m in anime:
        for e in m["relations"]["edges"]:
            other = e["node"]["id"]
            if e["relationType"] in ("SEQUEL", "PREQUEL", "PARENT") and e["node"]["type"] == "ANIME" and other in parent:
                parent[find(m["id"])] = find(other)
    for m in anime:
        m["franchiseId"] = find(m["id"])
        del m["relations"]


def load_id_map(path="anime_ids.json"):
    # anime_ids.json is keyed by AniDB id; use it to map AniDB -> AniList as a join fallback
    try:
        return {int(k): v.get("anilist_id") for k, v in json.load(open(path)).items()}
    except FileNotFoundError:
        return {}


def main():
    anime = fetch_anilist(N)
    assign_franchises(anime)
    by_al = {m["id"]: m for m in anime}
    by_mal = {m["idMal"]: m for m in anime if m["idMal"]}
    anidb_to_al = load_id_map()
    songs = fetch_all_openings()
    json.dump(songs, open("anisongdb_openings_raw.json", "w"), ensure_ascii=False)

    rows = []
    for s in songs:
        ids = s["linked_ids"]
        m = (by_al.get(ids.get("anilist"))
             or by_al.get(anidb_to_al.get(ids.get("anidb")))
             or by_mal.get(ids.get("myanimelist")))
        if not m or s["isDub"] or s["isRebroadcast"] or not (s["HQ"] or s["MQ"] or s["audio"]):
            continue
        rows.append({
            "anilistId": m["id"],
            "malId": m["idMal"],
            "franchiseId": m["franchiseId"],
            "annId": s["annId"],
            "amqSongId": s["amqSongId"],
            "titles": {**m["title"], "synonyms": m["synonyms"], "amqEN": s["animeENName"], "amqJP": s["animeJPName"]},
            "format": m["format"],
            "year": m["seasonYear"],
            "genres": m["genres"],
            "cover": m["coverImage"]["large"],
            "popularity": m["popularity"],
            "popularityRank": m["popularityRank"],
            "songType": s["songType"],
            "songName": s["songName"],
            "songArtist": s["songArtist"],
            "songDifficulty": s["songDifficulty"],
            "songLength": s["songLength"],
            "video": f"{MEDIA_HOST}/{s['HQ'] or s['MQ']}" if (s["HQ"] or s["MQ"]) else None,
            "videoMQ": f"{MEDIA_HOST}/{s['MQ']}" if s["MQ"] else None,
            "audio": f"{MEDIA_HOST}/{s['audio']}" if s["audio"] else None,
        })

    json.dump(anime, open("anilist_top.json", "w"), ensure_ascii=False)
    json.dump(rows, open("openings.json", "w"), ensure_ascii=False, indent=1)
    print(f"{len(anime)} anime, {len(songs)} openings fetched, {len(rows)} playable rows -> openings.json",
          file=sys.stderr)


if __name__ == "__main__":
    main()
