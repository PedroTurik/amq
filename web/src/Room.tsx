import { useEffect, useState } from 'react';
import { FORMATS, LIMITS, TIERS, type RoomView, type Settings } from '../../shared/types';
import { GameArea } from './Game';
import { media } from './media';
import { request } from './net';

export function RoomScreen({ view, onLeave }: { view: RoomView; onLeave: () => void }) {
  const [err, setErr] = useState('');
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    setErr(r.ok ? '' : r.error ?? 'Error');
  };

  return (
    <div className="room">
      <header>
        <b>{view.name}</b>
        <span className="muted">#{view.id}</span>
        <button className="secondary small" onClick={() => navigator.clipboard?.writeText(location.href)}>Copy link</button>
        <span className="grow" />
        <Volume />
        <button className="secondary small" onClick={() => { if (confirm('Leave this room?')) onLeave(); }}>Leave</button>
      </header>
      {err && <div className="banner" onClick={() => setErr('')}>{err}</div>}
      <div className="layout">
        <main>
          {view.game ? <GameArea view={view} act={act} /> : <Lobby view={view} act={act} />}
        </main>
        <aside>
          <Players view={view} act={act} />
        </aside>
      </div>
    </div>
  );
}

type Act = (p: Promise<{ ok: boolean; error?: string }>) => void;

function Volume() {
  const [v, setV] = useState(media.getVolume());
  return (
    <label className="volume" title="Volume">
      🔊 <input type="range" min={0} max={1} step={0.05} value={v} onChange={(e) => { const x = Number(e.target.value); setV(x); media.setVolume(x); }} />
    </label>
  );
}

function Players({ view, act }: { view: RoomView; act: Act }) {
  const isAdmin = view.meId === view.adminId;
  const g = view.game;
  const guessing = g?.phase === 'guessing';
  return (
    <div>
      <h3>Players</h3>
      <ul className="players">
        {view.players.map((p) => (
          <li key={p.id} className={p.connected ? '' : 'offline'}>
            <span className={p.connected ? 'dot on' : 'dot'} title={p.connected ? 'online' : 'offline'} />
            <span className="pname">
              {p.name}
              {p.id === view.meId && <span className="muted"> (you)</span>}
              {p.isAdmin && <span title="Room admin"> ★</span>}
            </span>
            {guessing && p.connected && <span className="small">{p.locked ? '🔒' : p.answered ? '✎' : '…'}</span>}
            {g && <b className="pts">{p.points}</b>}
            {isAdmin && p.id !== view.meId && (
              <span className="admin-actions">
                <button className="link" title="Make admin" onClick={() => confirm(`Make ${p.name} the admin?`) && act(request('admin:transfer', { playerId: p.id }))}>★</button>
                <button className="link" title="Remove from room" onClick={() => confirm(`Remove ${p.name} from the room?`) && act(request('admin:kick', { playerId: p.id }))}>✕</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {!view.players.find((p) => p.id === view.adminId)?.connected && view.adminId && (
        <p className="muted small">The admin is offline; admin passes to someone else after 20 s.</p>
      )}
    </div>
  );
}

function Lobby({ view, act }: { view: RoomView; act: Act }) {
  const isAdmin = view.meId === view.adminId;
  const admin = view.players.find((p) => p.id === view.adminId);
  return (
    <div className="lobby">
      <h2>Lobby</h2>
      <SettingsForm settings={view.settings} editable={isAdmin} act={act} />
      <p>
        <b>{view.poolSize}</b> songs match these settings.
        {view.poolSize < view.settings.rounds && view.poolSize > 0 && <span className="warn-text"> The game will have only {view.poolSize} rounds.</span>}
      </p>
      {isAdmin ? (
        <button className="big" disabled={view.poolSize === 0} onClick={() => { media.unlock(); act(request('game:start')); }}>Start game</button>
      ) : (
        <p className="muted">Waiting for {admin?.name ?? 'the admin'} to start the game…</p>
      )}
      {isAdmin && (
        <p className="small"><button className="link danger" onClick={() => confirm('Delete this room and its ranking for everyone?') && act(request('room:delete'))}>Delete room</button></p>
      )}
      <Leaderboard view={view} />
    </div>
  );
}

export function Leaderboard({ view }: { view: RoomView }) {
  if (!view.leaderboard.length) return null;
  return (
    <div>
      <h3>Room ranking</h3>
      <table className="table">
        <thead><tr><th>#</th><th>Player</th><th>Wins</th><th>Games</th><th>Points</th><th>Correct</th></tr></thead>
        <tbody>
          {view.leaderboard.map((e, i) => (
            <tr key={e.playerId} className={e.playerId === view.meId ? 'me' : ''}>
              <td>{i + 1}</td><td>{e.name}</td><td>{e.gamesWon}</td><td>{e.gamesPlayed}</td><td>{e.points}</td><td>{e.correct}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TIER_HELP: Record<string, string> = {
  easy: 'Top 250 anime, very recognizable songs',
  medium: 'Top 800 anime',
  hard: 'Top 2000 anime',
  expert: 'Everything else',
};

function SettingsForm({ settings, editable, act }: { settings: Settings; editable: boolean; act: Act }) {
  const save = (patch: Partial<Settings>) => act(request('room:settings', patch));
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset className="settings" disabled={!editable}>
      <NumberField label="Rounds" value={settings.rounds} range={LIMITS.rounds} onCommit={(v) => save({ rounds: v! })} />
      <NumberField label="Guess time (s)" value={settings.guessSeconds} range={LIMITS.guessSeconds} onCommit={(v) => save({ guessSeconds: v! })} />
      <NumberField label="Reveal time (s)" value={settings.revealSeconds} range={LIMITS.revealSeconds} onCommit={(v) => save({ revealSeconds: v! })} />
      <div className="field">
        <span>Difficulty</span>
        <div className="checks">
          {TIERS.map((t) => (
            <label key={t} title={TIER_HELP[t]}>
              <input type="checkbox" checked={settings.tiers.includes(t)} onChange={() => { const n = toggle(settings.tiers, t); if (n.length) save({ tiers: n }); }} /> {t}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Types</span>
        <div className="checks">
          {FORMATS.map((f) => (
            <label key={f}>
              <input type="checkbox" checked={settings.formats.includes(f)} onChange={() => { const n = toggle(settings.formats, f); if (n.length) save({ formats: n }); }} /> {f.replace('_', ' ')}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Years</span>
        <div className="row">
          <NumberField value={settings.yearMin} range={LIMITS.year} placeholder="any" nullable onCommit={(v) => save({ yearMin: v })} />
          –
          <NumberField value={settings.yearMax} range={LIMITS.year} placeholder="any" nullable onCommit={(v) => save({ yearMax: v })} />
        </div>
      </div>
      <div className="field">
        <span>Clip starts</span>
        <select value={settings.startPoint} onChange={(e) => save({ startPoint: e.target.value as Settings['startPoint'] })}>
          <option value="random">at a random point</option>
          <option value="start">at the start of the song</option>
        </select>
      </div>
      <label className="field"><span>Speed bonus</span><input type="checkbox" checked={settings.speedBonus} onChange={(e) => save({ speedBonus: e.target.checked })} /> <small className="muted">up to +50% for fast answers</small></label>
      <label className="field"><span>Avoid repeats</span><input type="checkbox" checked={settings.avoidRepeats} onChange={(e) => save({ avoidRepeats: e.target.checked })} /> <small className="muted">prefer songs this room hasn’t heard</small></label>
    </fieldset>
  );
}

/** Number input that only sends valid values, on blur or Enter (so typing "1" on the way to "15" doesn't save). */
function NumberField({ label, value, range, onCommit, placeholder, nullable }: {
  label?: string; value: number | null; range: readonly [number, number]; onCommit: (v: number | null) => void; placeholder?: string; nullable?: boolean;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    if (!t && nullable) return value !== null && onCommit(null);
    const n = Math.round(Number(t));
    if (!Number.isFinite(n) || !t) return setText(value == null ? '' : String(value));
    const clamped = Math.min(range[1], Math.max(range[0], n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  const input = (
    <input type="number" inputMode="numeric" className="num" value={text} placeholder={placeholder} min={range[0]} max={range[1]}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
  );
  return label ? <label className="field"><span>{label}</span>{input}</label> : input;
}
