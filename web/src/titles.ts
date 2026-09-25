import { useEffect, useState } from 'react';
import { TitleIndex } from '../../shared/search';
import type { TitleEntry } from '../../shared/types';

let promise: Promise<TitleIndex> | null = null;

function loadIndex(): Promise<TitleIndex> {
  promise ??= fetch('/api/titles')
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((entries: TitleEntry[]) => new TitleIndex(entries))
    .catch((e) => { promise = null; throw e; });
  return promise;
}

/** The autocomplete index, loaded once per page. */
export function useTitleIndex(): TitleIndex | null {
  const [index, setIndex] = useState<TitleIndex | null>(null);
  useEffect(() => {
    let alive = true;
    const attempt = (delay: number) => loadIndex().then((i) => alive && setIndex(i)).catch(() => alive && setTimeout(() => attempt(delay * 2), delay));
    attempt(1000);
    return () => { alive = false; };
  }, []);
  return index;
}
