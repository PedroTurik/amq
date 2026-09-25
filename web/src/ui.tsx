import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------- brand

/** The mark: four equalizer bars, the same motif as the "music is playing" indicator. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="pq-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5ea0" />
          <stop offset="1" stopColor="#c4165f" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#pq-g)" />
      <g fill="#fff">
        <rect x="7" y="14" width="3.2" height="11" rx="1.6" />
        <rect x="12.6" y="7" width="3.2" height="18" rx="1.6" />
        <rect x="18.2" y="11" width="3.2" height="14" rx="1.6" />
        <rect x="23.8" y="16" width="3.2" height="9" rx="1.6" fillOpacity=".75" />
      </g>
    </svg>
  );
}

export function Logo({ large }: { large?: boolean }) {
  return (
    <span className={large ? 'logo lg' : 'logo'}>
      <LogoMark />
      <span className="word">Petit <b>Quiz</b></span>
    </span>
  );
}

// ---------------------------------------------------------------- icons (stroke, 24×24)

const PATHS = {
  volume: <><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" /></>,
  mute: <><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 4 13 8-13 8V4z" />,
  skip: <><path d="m5 4 10 8-10 8V4z" /><path d="M19 5v14" /></>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  crown: <path d="m3 8 4.5 3.5L12 5l4.5 6.5L21 8l-2 11H5L3 8z" />,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  pen: <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />,
  dots: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />,
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  alert: <><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>,
  replay: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  door: <><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /><path d="m10 17 5-5-5-5M15 12H3" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- avatars

/** Stable hue per name, so a player keeps their colour everywhere (sidebar, results, podium). */
function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function Avatar({ name, size, off, className = '' }: { name: string; size?: 'sm' | 'lg'; off?: boolean; className?: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span className={['avatar', size, off && 'off', className].filter(Boolean).join(' ')} style={{ '--h': hue(name) } as React.CSSProperties} aria-hidden="true">
      {letter}
    </span>
  );
}

// ---------------------------------------------------------------- misc

/** Copies text and reports success for a moment (for "Copied!" feedback). */
export function useCopy(): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = (text: string) => {
    const ok = () => { setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, () => prompt('Copy this link:', text));
    else prompt('Copy this link:', text); // plain http on a LAN: no clipboard API
  };
  return [done, copy];
}

export function Toast({ children, tone, onClose }: { children: React.ReactNode; tone?: 'warn' | 'bad'; onClose?: () => void }) {
  return (
    <div className={`toast ${tone ?? ''}`} role="status">
      {tone === 'warn' ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, flex: 'none' }} /> : <Icon name="alert" />}
      <span>{children}</span>
      {onClose && <button className="btn ghost icon" onClick={onClose} aria-label="Dismiss"><Icon name="x" /></button>}
    </div>
  );
}
