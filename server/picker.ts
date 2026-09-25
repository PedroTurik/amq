import type { Song } from './dataset';
import type { Tier } from '../shared/types';

export type Rng = () => number;

const pick = <T>(arr: T[], rng: Rng): T => arr[Math.floor(rng() * arr.length)];

/**
 * Picks up to `count` distinct songs for a game.
 *
 * - Tier first (uniform over the selected tiers that still have songs), then franchise, then song, so
 *   franchises with dozens of openings (One Piece, Naruto...) aren't over-represented and mixing
 *   "easy + expert" really gives half of each.
 * - A franchise is not repeated within a game while other franchises are left.
 * - Songs the room already heard (`played`: song key → last played ms) are avoided while fresh ones
 *   exist; otherwise the least recently played one is used.
 */
export function pickSongs(pool: Song[], count: number, played: Map<number, number>, rng: Rng = Math.random): Song[] {
  const byTier = new Map<Tier, Map<number, Song[]>>();
  for (const s of pool) {
    const fr = byTier.get(s.tier) ?? new Map<number, Song[]>();
    const list = fr.get(s.franchiseId) ?? [];
    list.push(s);
    fr.set(s.franchiseId, list);
    byTier.set(s.tier, fr);
  }

  const usedSongs = new Set<number>();
  const usedFranchises = new Set<number>();
  const out: Song[] = [];
  const unused = (songs: Song[]) => songs.filter((s) => !usedSongs.has(s.key));

  while (out.length < count) {
    const tiers = [...byTier.entries()].filter(([, fr]) => [...fr.values()].some((l) => unused(l).length));
    if (!tiers.length) break;
    const [, franchises] = pick(tiers, rng);

    // Rank franchises: 0 = new franchise with an unheard song ... 3 = used franchise, only heard songs.
    let bestRank = Infinity;
    let best: Song[][] = [];
    for (const [fid, songs] of franchises) {
      const left = unused(songs);
      if (!left.length) continue;
      const rank = (usedFranchises.has(fid) ? 2 : 0) + (left.some((s) => !played.has(s.key)) ? 0 : 1);
      if (rank < bestRank) { bestRank = rank; best = []; }
      if (rank === bestRank) best.push(left);
    }
    let song: Song;
    if (bestRank % 2 === 0) {
      song = pick(pick(best, rng).filter((s) => !played.has(s.key)), rng);
    } else {
      // Only heard songs left: replay the one heard longest ago.
      song = best.flat().reduce((a, b) => (played.get(a.key)! <= played.get(b.key)! ? a : b));
    }

    usedSongs.add(song.key);
    usedFranchises.add(song.franchiseId);
    out.push(song);
  }
  return out;
}

/** Where in the song the guessing clip starts, leaving room for the reveal to continue the video. */
export function clipOffset(length: number, guessSeconds: number, revealSeconds: number, mode: 'random' | 'start', rng: Rng = Math.random): number {
  if (mode === 'start') return 0;
  const max = length - guessSeconds - revealSeconds;
  if (max <= 0) return 0;
  return Math.round(rng() * max * 10) / 10;
}
