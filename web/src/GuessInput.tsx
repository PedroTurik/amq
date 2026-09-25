import { useEffect, useMemo, useRef, useState } from 'react';
import type { TitleIndex } from '../../shared/search';
import type { TitleEntry } from '../../shared/types';
import { Icon } from './ui';

interface Props {
  index: TitleIndex | null;
  enabled: boolean;
  current: { anilistId: number; title: string; locked: boolean } | null;
  onPick: (e: TitleEntry) => void;
  onLock: () => void;
  /** Changes every round: clears the input. */
  roundKey: string;
}

/**
 * Type → pick from the list (click, or arrows + Enter) → that's your answer; you can change it until you lock.
 * Enter with the list closed locks the current answer.
 */
export function GuessInput({ index, enabled, current, onPick, onLock, roundKey }: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setText(''); setOpen(false); }, [roundKey]);
  useEffect(() => { if (enabled) input.current?.focus(); }, [enabled]);

  const results = useMemo(() => (index && text.trim() ? index.search(text, 8) : []), [index, text]);
  const showList = open && enabled && results.length > 0;
  const locked = !!current?.locked;

  const pick = (e: TitleEntry) => {
    onPick(e);
    setText(e.t);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && showList) { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp' && showList) { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (showList) pick(results[hi] ?? results[0]);
      else if (current && !locked) onLock();
    }
  };

  return (
    <div className="guess">
      <div className="guess-row">
        <div className="ac">
          <Icon name={locked ? 'lock' : 'search'} size={20} />
          <input
            ref={input}
            value={text}
            disabled={!enabled || locked}
            placeholder={!index ? 'Loading titles…' : locked ? 'Answer locked' : 'Type the anime name…'}
            aria-label="Your answer"
            role="combobox"
            aria-expanded={showList}
            aria-autocomplete="list"
            onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKey}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
          />
          {showList && (
            <ul className="ac-list" role="listbox">
              {results.map((r, i) => (
                <li key={r.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); pick(r); }} onMouseEnter={() => setHi(i)}>
                  <span className="t">{r.t}</span>
                  <span className="m">{[r.f.replace('_', ' '), r.y].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className={locked ? 'btn good' : 'btn primary'} disabled={!enabled || !current || locked} onClick={onLock}>
          {locked ? <><Icon name="check" /> Locked</> : <><Icon name="lock" size={17} /> Lock in</>}
        </button>
      </div>
      <div className="guess-hint">
        {current ? (
          locked ? <>Locked in: <b>{current.title}</b></> : <>Your answer: <b>{current.title}</b> <span className="faint">· <span className="kbd">Enter</span> or Lock in to confirm</span></>
        ) : enabled ? 'Pick a title from the list. You can change it until you lock in.' : '\u00a0'}
      </div>
    </div>
  );
}
