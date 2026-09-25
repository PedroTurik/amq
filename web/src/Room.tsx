import { useEffect, useState } from 'react';
import { FORMATS, LIMITS, TIERS, type PlayerView, type RoomView, type Settings } from '../../shared/types';
import { GameArea } from './Game';
import { media } from './media';
import { request } from './net';
import { useTitleIndex } from './titles';
import { Avatar, Icon, Logo, Toast, useCopy } from './ui';

export function RoomScreen({ view, onLeave }: { view: RoomView; onLeave: () => void }) {
  const [err, setErr] = useState('');
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    setErr(r.ok ? '' : r.error ?? 'Error');
  };

  return (
    <div className="room">
      <header className="topbar">
        <Logo />
        <span className="sep" />
        <div className="room-title">
          <b>{view.name}</b>
          <CopyLink code={view.id} />
        </div>
        <span className="grow" />
        <Volume />
        <button className="btn ghost sm" onClick={() => { if (confirm('Leave this room?')) onLeave(); }}>
          <Icon name="door" size={16} /><span className="hide-sm">Leave</span>
        </button>
      </header>
      {err && <div className="toasts"><Toast tone="bad" onClose={() => setErr('')}>{err}</Toast></div>}
      <div className={view.game ? 'layout' : 'layout lobby-mode'}>
        <main>
          {view.game ? <GameArea view={view} act={act} /> : <Lobby view={view} act={act} />}
        </main>
        <aside className="card side">
          <Players view={view} act={act} />
        </aside>
      </div>
    </div>
  );
}

type Act = (p: Promise<{ ok: boolean; error?: string }>) => void;

function CopyLink({ code, label }: { code: string; label?: string }) {
  const [done, copy] = useCopy();
  if (label) {
    return (
      <button className={done ? 'btn good' : 'btn outline'} onClick={() => copy(location.href)}>
        <Icon name={done ? 'check' : 'link'} size={16} /> {done ? 'Link copied' : label}
      </button>
    );
  }
  return (
    <button className={done ? 'code copy-btn done' : 'code copy-btn'} title="Copy the room link" onClick={() => copy(location.href)}>
      {done ? <><Icon name="check" size={13} /> copied</> : <>{code} <Icon name="link" size={13} /></>}
    </button>
  );
}

function Volume() {
  const [v, setV] = useState(media.getVolume());
  const [before, setBefore] = useState(0.8);
  const set = (x: number) => { setV(x); media.setVolume(x); };
  return (
    <div className="volume">
      <button className="btn ghost icon" aria-label={v ? 'Mute' : 'Unmute'} onClick={() => { if (v) { setBefore(v); set(0); } else set(before || 0.8); }}>
        <Icon name={v ? 'volume' : 'mute'} />
      </button>
      <input type="range" aria-label="Volume" min={0} max={1} step={0.05} value={v} onChange={(e) => set(Number(e.target.value))} />
    </div>
  );
}

/** During a game the list doubles as a live scoreboard, so it's sorted by points. */
function sortedPlayers(view: RoomView): PlayerView[] {
  if (!view.game) return view.players;
  return [...view.players].sort((a, b) => b.points - a.points);
}

function Players({ view, act }: { view: RoomView; act: Act }) {
  const isAdmin = view.meId === view.adminId;
  const g = view.game;
  const guessing = g?.phase === 'guessing';
  const online = view.players.filter((p) => p.connected).length;
  return (
    <div>
      <div className="card-head">
        <h3>Players</h3>
        <span className="pill">{online}{online !== view.players.length ? ` / ${view.players.length}` : ''}</span>
        <span className="grow" />
        {g && <span className="faint small">pts</span>}
      </div>
      <ul className="players">
        {sortedPlayers(view).map((p) => (
          <li key={p.id} className={[p.connected ? '' : 'offline', p.id === view.meId ? 'me' : ''].join(' ')}>
            <Avatar name={p.name} size="sm" off={!p.connected} />
            <span className="pname">
              <span>{p.name}</span>
              {p.isAdmin && <span className="crown" title="Room admin"><Icon name="crown" size={14} /></span>}
              {p.id === view.meId && <span className="you">you</span>}
            </span>
            {isAdmin && p.id !== view.meId && (
              <span className="admin-actions">
                <button className="btn ghost icon" title={`Make ${p.name} the admin`} aria-label={`Make ${p.name} the admin`} onClick={() => confirm(`Make ${p.name} the admin?`) && act(request('admin:transfer', { playerId: p.id }))}><Icon name="crown" size={15} /></button>
                <button className="btn ghost icon danger" title={`Remove ${p.name}`} aria-label={`Remove ${p.name}`} onClick={() => confirm(`Remove ${p.name} from the room?`) && act(request('admin:kick', { playerId: p.id }))}><Icon name="x" size={15} /></button>
              </span>
            )}
            {guessing && p.connected && (
              <span className={`pstate ${p.locked ? 'locked' : p.answered ? 'answered' : ''}`} title={p.locked ? 'Locked in' : p.answered ? 'Picked an answer' : 'Thinking'}>
                <Icon name={p.locked ? 'lock' : p.answered ? 'pen' : 'dots'} size={15} />
              </span>
            )}
            {g && <b className="pts">{p.points}</b>}
          </li>
        ))}
      </ul>
      {!view.players.find((p) => p.id === view.adminId)?.connected && view.adminId && (
        <p className="side-note">The admin is offline. Admin passes to someone else after 20 s.</p>
      )}
    </div>
  );
}

function Lobby({ view, act }: { view: RoomView; act: Act }) {
  useTitleIndex(); // warm up the autocomplete data (~250 KB) before the first round needs it
  const isAdmin = view.meId === view.adminId;
  const admin = view.players.find((p) => p.id === view.adminId);
  const alone = view.players.filter((p) => p.connected).length < 2;
  const short = view.poolSize < view.settings.rounds && view.poolSize > 0;
  return (
    <div className="lobby">
      <section className="card start-card">
        <div className="start-row">
          <div className={view.poolSize === 0 ? 'pool zero' : 'pool'}>
            <b>{view.poolSize.toLocaleString()}</b>
            <span>{view.poolSize === 1 ? 'song matches' : 'songs match'} these settings</span>
          </div>
          <span className="grow" />
          {isAdmin ? (
            <button className="btn primary lg" disabled={view.poolSize === 0} onClick={() => { media.unlock(); act(request('game:start')); }}>
              <Icon name="play" /> Start game
            </button>
          ) : (
            <div className="waiting"><span className="dot live" /> Waiting for {admin?.name ?? 'the admin'} to start…</div>
          )}
        </div>
        {view.poolSize === 0 && <p className="warn-text small">No song fits. Add a difficulty or type, or widen the years.</p>}
        {short && <p className="warn-text small">Only {view.poolSize} songs fit, so the game will have {view.poolSize} rounds.</p>}
        {alone && (
          <div className="invite">
            <p>Playing with friends? Send them the link, plus the room password.</p>
            <CopyLink code={view.id} label="Copy invite link" />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Game settings</h3>
          <span className="grow" />
          {!isAdmin && <span className="faint small">Set by the admin</span>}
        </div>
        <SettingsForm settings={view.settings} editable={isAdmin} act={act} />
      </section>

      <Leaderboard view={view} />

      {isAdmin && (
        <div className="danger-zone">
          <button className="btn ghost sm danger" onClick={() => confirm('Delete this room and its ranking for everyone?') && act(request('room:delete'))}>
            <Icon name="trash" size={15} /> Delete room
          </button>
        </div>
      )}
    </div>
  );
}

export function Leaderboard({ view }: { view: RoomView }) {
  if (!view.leaderboard.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h3>Room ranking</h3><span className="faint small">all games</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Player</th><th className="num">Wins</th><th className="num hide-sm">Games</th><th className="num">Points</th><th className="num hide-sm">Correct</th></tr></thead>
          <tbody>
            {view.leaderboard.map((e, i) => (
              <tr key={e.playerId} className={e.playerId === view.meId ? 'me' : ''}>
                <td className={`rank r${i + 1}`}>{i + 1}</td>
                <td><span className="who"><Avatar name={e.name} size="sm" />{e.name}</span></td>
                <td className="num">{e.gamesWon}</td>
                <td className="num hide-sm">{e.gamesPlayed}</td>
                <td className="num"><b>{e.points.toLocaleString()}</b></td>
                <td className="num hide-sm">{e.correct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const TIER_HELP: Record<string, string> = {
  easy: 'Top 250, big hits',
  medium: 'Top 800',
  hard: 'Top 2000',
  expert: 'Deep cuts',
};

const FORMAT_LABEL: Record<string, string> = { TV: 'TV', TV_SHORT: 'TV short', ONA: 'ONA', MOVIE: 'Movie', OVA: 'OVA', SPECIAL: 'Special' };

function SettingsForm({ settings, editable, act }: { settings: Settings; editable: boolean; act: Act }) {
  const save = (patch: Partial<Settings>) => act(request('room:settings', patch));
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset className="settings" disabled={!editable}>
      <div className="setting">
        <span className="label">Length</span>
        <div className="setting-nums">
          <NumberField label="Rounds" value={settings.rounds} range={LIMITS.rounds} step={5} onCommit={(v) => save({ rounds: v! })} />
          <NumberField label="Guess time" unit="s" value={settings.guessSeconds} range={LIMITS.guessSeconds} step={5} onCommit={(v) => save({ guessSeconds: v! })} />
          <NumberField label="Reveal time" unit="s" value={settings.revealSeconds} range={LIMITS.revealSeconds} step={5} onCommit={(v) => save({ revealSeconds: v! })} />
        </div>
      </div>
      <div className="setting">
        <span className="label">Difficulty<small>by anime popularity</small></span>
        <div className="chips">
          {TIERS.map((t) => {
            const on = settings.tiers.includes(t);
            return (
              <button type="button" key={t} className="chip tall" aria-pressed={on}
                onClick={() => { const n = toggle(settings.tiers, t); if (n.length) save({ tiers: n }); }}>
                <span style={{ textTransform: 'capitalize' }}>{t}</span><small>{TIER_HELP[t]}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div className="setting">
        <span className="label">Types</span>
        <div className="chips">
          {FORMATS.map((f) => (
            <button type="button" key={f} className="chip" aria-pressed={settings.formats.includes(f)}
              onClick={() => { const n = toggle(settings.formats, f); if (n.length) save({ formats: n }); }}>
              {FORMAT_LABEL[f] ?? f}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <span className="label">Years</span>
        <div className="year-row">
          <NumberField value={settings.yearMin} range={LIMITS.year} placeholder="Any" nullable ariaLabel="From year" onCommit={(v) => save({ yearMin: v })} />
          –
          <NumberField value={settings.yearMax} range={LIMITS.year} placeholder="Any" nullable ariaLabel="To year" onCommit={(v) => save({ yearMax: v })} />
        </div>
      </div>
      <div className="setting">
        <span className="label">Clip starts</span>
        <div className="segmented" role="group" aria-label="Clip starts">
          <button type="button" aria-pressed={settings.startPoint === 'random'} onClick={() => save({ startPoint: 'random' })}>Random point</button>
          <button type="button" aria-pressed={settings.startPoint === 'start'} onClick={() => save({ startPoint: 'start' })}>From the start</button>
        </div>
      </div>
      <div className="setting">
        <span className="label">Scoring</span>
        <label className="switch">
          <input type="checkbox" checked={settings.speedBonus} onChange={(e) => save({ speedBonus: e.target.checked })} />
          <span>Speed bonus <span className="faint small">· up to +50% for fast answers</span></span>
        </label>
      </div>
      <div className="setting">
        <span className="label">Songs</span>
        <label className="switch">
          <input type="checkbox" checked={settings.avoidRepeats} onChange={(e) => save({ avoidRepeats: e.target.checked })} />
          <span>Avoid repeats <span className="faint small">· prefer songs this room hasn’t heard</span></span>
        </label>
      </div>
    </fieldset>
  );
}

/**
 * Number input that only sends valid values, on blur or Enter (so typing "1" on the way to "15" doesn't save).
 * With a label it's a stepper: −/+ buttons move by `step` and save right away.
 */
function NumberField({ label, unit, value, range, step = 1, onCommit, placeholder, nullable, ariaLabel }: {
  label?: string; unit?: string; value: number | null; range: readonly [number, number]; step?: number;
  onCommit: (v: number | null) => void; placeholder?: string; nullable?: boolean; ariaLabel?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  const clamp = (n: number) => Math.min(range[1], Math.max(range[0], n));
  const commit = () => {
    const t = text.trim();
    if (!t && nullable) return value !== null && onCommit(null);
    const n = Math.round(Number(t));
    if (!Number.isFinite(n) || !t) return setText(value == null ? '' : String(value));
    const clamped = clamp(n);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  const inputProps = {
    type: 'number', inputMode: 'numeric', value: text, min: range[0], max: range[1],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value), onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && commit(),
  } as const;
  if (!label) return <input {...inputProps} className="year-input" placeholder={placeholder} aria-label={ariaLabel} />;
  // Snap to the step grid: 12 → + → 15, not 17.
  const bump = (dir: 1 | -1) => {
    const v = value ?? range[0];
    const next = clamp(dir > 0 ? Math.floor(v / step) * step + step : Math.ceil(v / step) * step - step);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="field">
      <span>{label}</span>
      <div className="stepper">
        <button type="button" aria-label={`Less ${label.toLowerCase()}`} disabled={value != null && value <= range[0]} onClick={() => bump(-1)}>−</button>
        <input {...inputProps} aria-label={label} />
        {unit && <span className="unit">{unit}</span>}
        <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value != null && value >= range[1]} onClick={() => bump(1)}>+</button>
      </div>
    </div>
  );
}
