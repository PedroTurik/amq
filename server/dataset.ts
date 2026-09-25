import fs from 'node:fs';
import path from 'node:path';
import type { Format, Settings, Tier, TitleEntry } from '../shared/types';

/** One row of openings.json (see CLAUDE.md for the schema). */
export interface OpeningRow {
  anilistId: number;
  malId: number;
  franchiseId: number;
  amqSongId: number;
  titles: { romaji: string; english: string | null; native: string | null; synonyms: string[]; amqEN?: string; amqJP?: string };
  format: string;
  year: number | null;
  genres: string[];
  cover: string;
  popularity: number;
  popularityRank: number;
  songType: string;
  songName: string;
  songArtist: string;
  songDifficulty: number | null;
  songLength: number | null;
  video: string;
  videoMQ: string | null;
  audio: string | null;
}

interface AnilistRow {
  id: number;
  format: string;
  seasonYear: number | null;
  title: { romaji: string; english: string | null; native: string | null };
  synonyms: string[];
  popularityRank: number;
  franchiseId: number;
}

/** A playable song. Rows that share an amqSongId (the same song in several anime) are merged into one. */
export interface Song {
  key: number;
  /** The most popular anime that uses this song; it's what the reveal shows. */
  row: OpeningRow;
  tier: Tier;
  franchiseId: number;
  /** Every franchise that uses this song; guessing any of them is correct. */
  accepted: Set<number>;
  /** Titles of the other anime that use this song. */
  alsoIn: string[];
  audio: string;
  video: string;
  length: number;
}

export function tierOf(popularityRank: number, songDifficulty: number | null): Tier {
  const d = songDifficulty ?? 0;
  if (popularityRank <= 250 && d >= 55) return 'easy';
  if (popularityRank <= 800 && d >= 35) return 'medium';
  if (popularityRank <= 2000) return 'hard';
  return 'expert';
}

export function displayTitle(t: { english: string | null; romaji: string }): string {
  return t.english || t.romaji;
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

export class Dataset {
  readonly songs: Song[];
  readonly titles: TitleEntry[];
  /** AniList id → franchise id and display title, for every anime players can guess. */
  readonly anime = new Map<number, { franchiseId: number; title: string }>();

  constructor(openings: OpeningRow[], top: AnilistRow[]) {
    const extraAliases = new Map<number, Set<string>>();
    for (const r of openings) {
      const s = extraAliases.get(r.anilistId) ?? new Set();
      if (r.titles.amqEN) s.add(r.titles.amqEN);
      if (r.titles.amqJP) s.add(r.titles.amqJP);
      extraAliases.set(r.anilistId, s);
    }

    this.titles = top.map((a) => {
      const aliases = new Set<string>([a.title.romaji]);
      if (a.title.english) aliases.add(a.title.english);
      if (a.title.native) aliases.add(a.title.native);
      for (const syn of a.synonyms) if (LATIN_ONLY.test(syn)) aliases.add(syn);
      for (const x of extraAliases.get(a.id) ?? []) aliases.add(x);
      const t = displayTitle(a.title);
      aliases.delete(t);
      this.anime.set(a.id, { franchiseId: a.franchiseId, title: t });
      return { id: a.id, t, a: [...aliases], y: a.seasonYear, f: a.format, p: a.popularityRank, g: a.franchiseId };
    });

    const groups = new Map<number, OpeningRow[]>();
    for (const r of openings) {
      if (!r.audio) continue; // guessing is audio-only
      const g = groups.get(r.amqSongId) ?? [];
      g.push(r);
      groups.set(r.amqSongId, g);
    }
    this.songs = [...groups.values()].map((rows) => {
      rows.sort((a, b) => a.popularityRank - b.popularityRank);
      const row = rows[0];
      const alsoIn = [...new Set(rows.slice(1).map((r) => displayTitle(r.titles)))].filter((t) => t !== displayTitle(row.titles));
      return {
        key: row.amqSongId,
        row,
        tier: tierOf(row.popularityRank, row.songDifficulty),
        franchiseId: row.franchiseId,
        accepted: new Set(rows.map((r) => r.franchiseId)),
        alsoIn,
        audio: row.audio!,
        video: row.videoMQ ?? row.video,
        length: row.songLength && row.songLength > 0 ? row.songLength : 90,
      };
    });
  }

  static load(dir: string): Dataset {
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return new Dataset(read('openings.json'), read('anilist_top.json'));
  }

  pool(s: Pick<Settings, 'tiers' | 'formats' | 'yearMin' | 'yearMax'>): Song[] {
    const tiers = new Set<Tier>(s.tiers);
    const formats = new Set<string>(s.formats as Format[]);
    return this.songs.filter((song) => {
      const r = song.row;
      if (!tiers.has(song.tier) || !formats.has(r.format)) return false;
      if (s.yearMin != null && (r.year == null || r.year < s.yearMin)) return false;
      if (s.yearMax != null && (r.year == null || r.year > s.yearMax)) return false;
      return true;
    });
  }

  isCorrect(song: Song, guessAnilistId: number): boolean {
    const a = this.anime.get(guessAnilistId);
    return !!a && song.accepted.has(a.franchiseId);
  }
}
