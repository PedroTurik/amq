import type { TitleEntry } from './types';

/** Lowercase, strip accents and punctuation, collapse whitespace. Keeps CJK characters. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface Indexed {
  entry: TitleEntry;
  /** Normalized aliases, each with its word list and space-less form. */
  aliases: { full: string; words: string[]; compact: string }[];
}

export class TitleIndex {
  private items: Indexed[];

  constructor(entries: TitleEntry[]) {
    this.items = entries.map((entry) => {
      const seen = new Set<string>();
      const aliases = [];
      for (const a of [entry.t, ...entry.a]) {
        const full = normalize(a);
        if (!full || seen.has(full)) continue;
        seen.add(full);
        aliases.push({ full, words: full.split(' '), compact: full.replace(/ /g, '') });
      }
      return { entry, aliases };
    });
  }

  /**
   * Best matches for a query: exact > prefix > all words prefix-match > substring; ties go to the more popular anime.
   * Only the best entry of each franchise is returned (any season is a correct answer, so listing all of them
   * would just push other shows out of the list).
   */
  search(query: string, limit = 10): TitleEntry[] {
    const q = normalize(query);
    if (!q) return [];
    const qWords = q.split(' ');
    const qCompact = q.replace(/ /g, '');
    const scored: { e: TitleEntry; s: number }[] = [];
    for (const { entry, aliases } of this.items) {
      let best = 0;
      for (const a of aliases) {
        let s = 0;
        if (a.full === q) s = 100;
        else if (a.full.startsWith(q)) s = 80;
        else if (qWords.every((w) => a.words.some((aw) => aw.startsWith(w)))) s = 60;
        else if (a.full.includes(q)) s = 40;
        else if (qCompact.length >= 3 && a.compact.includes(qCompact)) s = 30;
        if (s > best) best = s;
        if (best === 100) break;
      }
      if (best) scored.push({ e: entry, s: best });
    }
    scored.sort((x, y) => y.s - x.s || x.e.p - y.e.p);
    const out: TitleEntry[] = [];
    const seen = new Set<number>();
    for (const { e } of scored) {
      if (seen.has(e.g)) continue;
      seen.add(e.g);
      out.push(e);
      if (out.length === limit) break;
    }
    return out;
  }
}
