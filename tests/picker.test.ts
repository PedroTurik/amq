import { describe, expect, it } from 'vitest';
import { Dataset, tierOf } from '../server/dataset';
import { clipOffset, pickSongs } from '../server/picker';
import { TitleIndex, normalize } from '../shared/search';
import { fakeDataset } from './helpers';

describe('pickSongs', () => {
  it('never repeats a song or (while possible) a franchise', () => {
    const ds = fakeDataset(20);
    const songs = pickSongs(ds.songs, 20, new Map());
    expect(new Set(songs.map((s) => s.key)).size).toBe(20);
    expect(new Set(songs.map((s) => s.franchiseId)).size).toBe(20);
  });

  it('prefers songs the room has not heard', () => {
    const ds = fakeDataset(10);
    const played = new Map(ds.songs.slice(0, 7).map((s, i) => [s.key, i]));
    const songs = pickSongs(ds.songs, 3, played);
    expect(songs.every((s) => !played.has(s.key))).toBe(true);
    // Once fresh songs run out, the least recently heard come first.
    const more = pickSongs(ds.songs, 4, played);
    expect(more.filter((s) => played.has(s.key)).map((s) => played.get(s.key))).toEqual([0]);
  });

  it('keeps clips inside the song', () => {
    for (let i = 0; i < 100; i++) {
      const o = clipOffset(90, 20, 15, 'random');
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(55);
    }
    expect(clipOffset(25, 20, 15, 'random')).toBe(0);
    expect(clipOffset(90, 20, 15, 'start')).toBe(0);
  });
});

describe('real dataset', () => {
  const ds = Dataset.load('.');

  it('dedupes reused songs and accepts every franchise that uses them', () => {
    const keys = ds.songs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const chala = ds.songs.find((s) => s.row.songName.startsWith('CHA-LA HEAD-CHA-LA') && s.accepted.size > 1);
    expect(chala).toBeTruthy();
    expect(ds.songs.every((s) => s.audio)).toBe(true);
  });

  it('tiers roughly match the documented counts', () => {
    const counts = { easy: 0, medium: 0, hard: 0, expert: 0 };
    for (const s of ds.songs) counts[s.tier]++;
    expect(counts.easy).toBeGreaterThan(250);
    expect(counts.expert).toBeGreaterThan(700);
    expect(tierOf(10, 80)).toBe('easy');
  });

  it('a whole-pool pick balances tiers', () => {
    const pool = ds.pool({ tiers: ['easy', 'expert'], formats: ['TV'], yearMin: null, yearMax: null });
    const picked = pickSongs(pool, 40, new Map());
    const easy = picked.filter((s) => s.tier === 'easy').length;
    expect(easy).toBeGreaterThan(8);
    expect(easy).toBeLessThan(32);
  });

  it('autocomplete finds shows by english, romaji and synonyms', () => {
    const idx = new TitleIndex(ds.titles);
    expect(idx.search('attack on')[0].t).toBe('Attack on Titan');
    expect(idx.search('shingeki')[0].t).toBe('Attack on Titan');
    expect(idx.search('aot').some((e) => e.t === 'Attack on Titan')).toBe(true);
    expect(idx.search('kimetsu')[0].t).toMatch(/Demon Slayer/);
    expect(idx.search('Pokémon').length).toBeGreaterThan(0);
    // One entry per franchise, but a specific season is still findable.
    expect(idx.search('attack on titan').filter((e) => e.t.startsWith('Attack on Titan')).length).toBe(1);
    expect(idx.search('attack on titan season 3')[0].t).toBe('Attack on Titan Season 3');
    expect(normalize('Re:ZERO -Starting Life-')).toBe('re zero starting life');
  });
});
