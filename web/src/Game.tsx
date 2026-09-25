import { useEffect, useRef, useState } from 'react';
import type { GameView, RoomView } from '../../shared/types';
import { GuessInput } from './GuessInput';
import { media, type MediaStatus } from './media';
import { request, serverNow, socket } from './net';
import { Leaderboard } from './Room';
import { useTitleIndex } from './titles';

type Act = (p: Promise<{ ok: boolean; error?: string }>) => void;

function useMediaStatus(): MediaStatus {
  const [s, setS] = useState(media.status);
  useEffect(() => media.subscribe(setS), []);
  return s;
}

/** Seconds left until `endsAt` (server clock), re-rendered ~10×/s. */
function useCountdown(endsAt: number | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (endsAt == null) return setLeft(null);
    const tick = () => setLeft(Math.max(0, (endsAt - serverNow()) / 1000));
    tick();
    const t = setInterval(tick, 100);
    return () => clearInterval(t);
  }, [endsAt]);
  return left;
}

function TimerBar({ endsAt, total }: { endsAt: number | null; total: number }) {
  const left = useCountdown(endsAt);
  if (left == null) return null;
  return (
    <div className="timer">
      <div className="timer-fill" style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      <span>{Math.ceil(left)}s</span>
    </div>
  );
}

export function GameArea({ view, act }: { view: RoomView; act: Act }) {
  const g = view.game!;
  const isAdmin = view.meId === view.adminId;
  const status = useMediaStatus();

  return (
    <div className="game">
      <div className="game-head">
        <b>{g.phase === 'finished' ? 'Game over' : `Round ${g.round + 1} / ${g.totalRounds}`}</b>
        {g.paused && g.phase !== 'finished' && <span className="tag">paused{g.phase !== 'reveal' ? ' after this round' : ''}</span>}
        <span className="grow" />
        {isAdmin && g.phase !== 'finished' && (
          <span className="admin-bar">
            <button className="secondary small" onClick={() => act(request('admin:pause', { paused: !g.paused }))}>{g.paused ? 'Resume' : 'Pause'}</button>
            <button className="secondary small" title={g.phase === 'reveal' ? 'Next round' : 'Replace this song (no points)'}
              onClick={() => act(request('admin:skipRound'))}>{g.phase === 'reveal' ? 'Next' : 'Skip song'}</button>
            <button className="secondary small danger" onClick={() => confirm('End the game now?') && act(request('game:end'))}>End game</button>
          </span>
        )}
      </div>

      {status.blocked && g.phase !== 'finished' && (
        <button className="big warn" onClick={() => media.unlock()}>🔇 Click to enable sound</button>
      )}

      {g.phase === 'loading' && <Loading g={g} status={status} />}
      {g.phase === 'guessing' && <Guessing view={view} g={g} status={status} />}
      {/* The video element lives in the reveal view; keep it mounted only there. */}
      {g.phase === 'reveal' && <Reveal view={view} g={g} status={status} />}
      {g.phase === 'finished' && <Finished view={view} act={act} />}
    </div>
  );
}

function Loading({ g, status }: { g: GameView; status: MediaStatus }) {
  const left = useCountdown(g.phaseEndsAt);
  return (
    <div className="stage">
      <h2>Get ready…</h2>
      <p className="muted">
        {status.audioState === 'error' ? 'Could not load this song on your side; waiting for the others.' :
          status.audioState === 'ready' ? 'Loaded. Waiting for everyone else' : 'Loading the song'}
        {left != null ? ` (max ${Math.ceil(left)}s)` : ''}
      </p>
      {g.phaseEndsAt == null && <p className="muted">Waiting for players to connect.</p>}
    </div>
  );
}

function Guessing({ view, g, status }: { view: RoomView; g: GameView; status: MediaStatus }) {
  const index = useTitleIndex();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const check = () => setStarted(g.clipStartAt != null && serverNow() >= g.clipStartAt);
    check();
    const t = setInterval(check, 50);
    return () => clearInterval(t);
  }, [g.clipStartAt]);
  const online = view.players.filter((p) => p.connected);
  const locked = online.filter((p) => p.locked).length;

  return (
    <div className="stage">
      <TimerBar endsAt={started ? g.phaseEndsAt : null} total={g.clipSeconds} />
      <h2>{started ? (status.audioState === 'error' ? '⚠ Audio failed to load' : '♪ Listen… which anime is this?') : 'Starting…'}</h2>
      <GuessInput
        index={index}
        enabled={started}
        current={g.myGuess}
        roundKey={`${g.id}-${g.round}`}
        onPick={(e) => socket.emit('guess:set', { anilistId: e.id })}
        onLock={() => socket.emit('guess:lock')}
      />
      <p className="muted small">{locked} / {online.length} locked in. The round ends when everyone locks or time runs out.</p>
    </div>
  );
}

function Reveal({ view, g, status }: { view: RoomView; g: GameView; status: MediaStatus }) {
  const box = useRef<HTMLDivElement>(null);
  const r = g.reveal!;
  const a = r.answer;
  useEffect(() => {
    const el = box.current!;
    el.appendChild(media.video);
    return () => { media.video.remove(); };
  }, []);
  const online = view.players.filter((p) => p.connected);
  const voted = r.skipVotes.includes(view.meId);
  const me = r.results.find((x) => x.playerId === view.meId);

  return (
    <div className="stage reveal">
      <TimerBar endsAt={g.phaseEndsAt} total={view.settings.revealSeconds} />
      <div className={`verdict ${me?.correct ? 'good' : 'bad'}`}>
        {me ? (me.correct ? `Correct! +${me.points}` : me.away ? 'You missed this one' : me.guess ? 'Wrong!' : 'No answer') : ''}
      </div>
      <div className="reveal-grid">
        <div className="video-box" ref={box}>
          {status.videoFailed && <img src={a.cover} alt="" className="cover-fallback" />}
        </div>
        <div className="answer">
          <img src={a.cover} alt="" className="cover" />
          <div>
            <h2>{a.title}</h2>
            {a.romaji !== a.title && <div className="muted">{a.romaji}</div>}
            {a.native && <div className="muted small">{a.native}</div>}
            <p>
              <b>{a.songType}</b>: “{a.songName}” by {a.songArtist}
            </p>
            <p className="muted small">
              {[a.format.replace('_', ' '), a.year, `${a.tier} tier`, `${Math.round(a.amqDifficulty)}% of AMQ players get it`].filter(Boolean).join(' · ')}
            </p>
            {a.alsoAccepted.length > 0 && <p className="muted small">Also accepted: {a.alsoAccepted.join(', ')}</p>}
          </div>
        </div>
      </div>
      <table className="table results">
        <thead><tr><th>Player</th><th>Answer</th><th></th><th>Points</th><th>Time</th></tr></thead>
        <tbody>
          {r.results.map((x) => (
            <tr key={x.playerId} className={x.playerId === view.meId ? 'me' : ''}>
              <td>{x.name}</td>
              <td>{x.away ? <i className="muted">away</i> : x.guess ?? <i className="muted">no answer</i>}</td>
              <td>{x.correct ? '✅' : x.away ? '' : '❌'}</td>
              <td>{x.points ? `+${x.points}` : ''}</td>
              <td className="muted">{x.ms != null ? `${(x.ms / 1000).toFixed(1)}s` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="secondary" disabled={voted || g.paused} onClick={() => socket.emit('reveal:skip')}>
        {voted ? 'Waiting for others' : g.next ? 'Next song' : 'Show results'} ({r.skipVotes.length}/{online.length})
      </button>
      {g.paused && <p className="muted">Paused by the admin.</p>}
    </div>
  );
}

function Finished({ view, act }: { view: RoomView; act: Act }) {
  const g = view.game!;
  const isAdmin = view.meId === view.adminId;
  const standings = view.players.filter((p) => p.points > 0 || p.correct > 0 || p.connected);
  return (
    <div className="stage">
      <h2>Final results</h2>
      <ol className="standings">
        {standings.map((p, i) => (
          <li key={p.id} className={p.id === view.meId ? 'me' : ''}>
            {i === 0 && p.points > 0 ? '🏆 ' : ''}<b>{p.name}</b>: {p.points} pts ({p.correct}/{g.history.length} correct)
          </li>
        ))}
      </ol>
      {isAdmin ? (
        <div className="row">
          <button className="big" onClick={() => { media.unlock(); act(request('game:start')); }}>Play again</button>
          <button className="secondary" onClick={() => act(request('game:toLobby'))}>Back to lobby (change settings)</button>
        </div>
      ) : <p className="muted">Waiting for the admin…</p>}
      <h3>Songs this game</h3>
      <ol className="history">
        {g.history.map((h) => (
          <li key={h.round}>
            <img src={h.cover} alt="" /> <b>{h.title}</b>: “{h.songName}” by {h.songArtist} <span className="muted">({h.correctCount}/{h.playerCount} got it)</span>
          </li>
        ))}
      </ol>
      <Leaderboard view={view} />
    </div>
  );
}
