import { Dataset, type OpeningRow } from '../server/dataset';
import { Store, hashPassword } from '../server/db';
import { Room, type Hub } from '../server/room';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

/** A small synthetic dataset: `n` franchises with one anime each; anime i uses song 1000+i. */
export function fakeDataset(n = 30): Dataset {
  const top = [];
  const openings: OpeningRow[] = [];
  for (let i = 1; i <= n; i++) {
    top.push({
      id: i, format: 'TV', seasonYear: 2000 + i,
      title: { romaji: `Romaji ${i}`, english: `Anime ${i}`, native: null }, synonyms: [`Syn${i}`],
      popularityRank: i, franchiseId: i,
    });
    openings.push({
      anilistId: i, malId: i, franchiseId: i, amqSongId: 1000 + i,
      titles: { romaji: `Romaji ${i}`, english: `Anime ${i}`, native: null, synonyms: [] },
      format: 'TV', year: 2000 + i, genres: [], cover: `c${i}`, popularity: 1000 - i, popularityRank: i,
      songType: 'Opening 1', songName: `Song ${i}`, songArtist: `Artist ${i}`, songDifficulty: 80, songLength: 90,
      video: `v${i}.webm`, videoMQ: null, audio: `a${i}.mp3`,
    });
  }
  // Anime 2's sequel (same franchise) is guessable too.
  top.push({ id: 900, format: 'TV', seasonYear: 2020, title: { romaji: 'R2 S2', english: 'Anime 2 Season 2', native: null }, synonyms: [], popularityRank: 900, franchiseId: 2 });
  return new Dataset(openings, top);
}

export class FakeHub implements Hub {
  changes = 0;
  detachedLog: [string, string][] = [];
  changed() { this.changes++; }
  detached(socketId: string, reason: string) { this.detachedLog.push([socketId, reason]); }
}

export function makeRoom(opts: { settings?: Partial<Settings>; store?: Store; dataset?: Dataset; hub?: FakeHub } = {}) {
  const store = opts.store ?? new Store(':memory:');
  const dataset = opts.dataset ?? fakeDataset();
  const hub = opts.hub ?? new FakeHub();
  const now = Date.now();
  const row = {
    id: 'ROOM01', name: 'Test', password_hash: hashPassword('pw'), admin_id: null,
    settings_json: JSON.stringify({ ...DEFAULT_SETTINGS, tiers: ['easy', 'medium', 'hard', 'expert'], rounds: 3, ...opts.settings }),
    created_at: now, last_active_at: now, game_json: null,
  };
  if (!store.rooms().some((r) => r.id === row.id)) store.insertRoom(row);
  const room = new Room({ store, dataset, hub }, store.rooms().find((r) => r.id === row.id)!, store.players(row.id));
  return { room, store, dataset, hub };
}
