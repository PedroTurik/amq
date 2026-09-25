import { useEffect, useRef, useState } from 'react';
import type { GameView, PlayerView, RoomView } from '../../shared/types';
import { GuessInput } from './GuessInput';
import { media, type MediaStatus } from './media';
import { request, serverNow, socket } from './net';
import { Leaderboard } from './Room';
import { useTitleIndex } from './titles';
import { Avatar, Icon } from './ui';

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

function TimerBar({ left, total, tone }: { left: number | null; total: number; tone?: 'urgent' | 'calm' }) {
  const frac = left == null ? 0 : Math.min(1, left / total);
  return (
    <div className={`timer ${tone ?? ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left == null ? undefined : Math.ceil(left)}>
      <div style={{ transform: `scaleX(${frac})` }} />
    </div>
  );
}

/** Equalizer bars: dance while the clip plays, breathe while waiting. */
function Eq({ state, large }: { state: 'on' | 'wait' | 'err'; large?: boolean }) {
  return <span className={`eq ${state}${large ? ' lg' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

export function GameArea({ view, act }: { view: RoomView; act: Act }) {
  const g = view.game!;
  const isAdmin = view.meId === view.adminId;
  const status = useMediaStatus();
  const finished = g.phase === 'finished';
  const done = finished ? g.totalRounds : g.round + (g.phase === 'reveal' ? 1 : 0);

  return (
    <div className="game">
      <div className="game-head">
        <div className="round-label">
          {finished ? 'Game over' : <>Round <b className="num-tab">{g.round + 1}</b>/{g.totalRounds}</>}
        </div>
        <div className="progress" aria-hidden="true"><div style={{ width: `${(done / g.totalRounds) * 100}%` }} /></div>
        {g.paused && !finished && <span className="pill warn"><Icon name="pause" size={13} /> {g.phase !== 'reveal' ? 'Pausing after this round' : 'Paused'}</span>}
        {isAdmin && !finished && (
          <div className="admin-bar">
            <button className="btn ghost sm" title={g.paused ? 'Resume' : 'Pause (holds on the next reveal)'} onClick={() => act(request('admin:pause', { paused: !g.paused }))}>
              <Icon name={g.paused ? 'play' : 'pause'} size={15} /><span className="lbl">{g.paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button className="btn ghost sm" title={g.phase === 'reveal' ? 'Next round' : 'Replace this song (no points)'} onClick={() => act(request('admin:skipRound'))}>
              <Icon name="skip" size={15} /><span className="lbl">{g.phase === 'reveal' ? 'Next' : 'Skip song'}</span>
            </button>
            <button className="btn ghost sm danger" title="End the game now" onClick={() => confirm('End the game now?') && act(request('game:end'))}>
              <Icon name="stop" size={15} /><span className="lbl">End</span>
            </button>
          </div>
        )}
      </div>

      {status.blocked && !finished && (
        <button className="btn lg sound-btn" onClick={() => media.unlock()}><Icon name="mute" /> Tap to enable sound</button>
      )}

      {g.phase === 'loading' && <Loading g={g} status={status} />}
      {g.phase === 'guessing' && <Guessing view={view} g={g} status={status} />}
      {/* The video element lives in the reveal view; keep it mounted only there. */}
      {g.phase === 'reveal' && <Reveal view={view} g={g} status={status} />}
      {finished && <Finished view={view} act={act} />}
    </div>
  );
}

function Loading({ g, status }: { g: GameView; status: MediaStatus }) {
  const left = useCountdown(g.phaseEndsAt);
  return (
    <section className="card stage stage-center">
      <Eq state={status.audioState === 'error' ? 'err' : 'wait'} large />
      <span className="kicker">Round {g.round + 1}</span>
      <h2>Get ready…</h2>
      <p className="muted">
        {g.phaseEndsAt == null ? 'Waiting for players to connect.' :
          status.audioState === 'error' ? "Couldn't load this song on your side. Waiting for the others." :
            status.audioState === 'ready' ? 'Loaded. Waiting for everyone else' : 'Loading the song'}
        {left != null ? ` (${Math.ceil(left)}s max)` : ''}
      </p>
    </section>
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
  const left = useCountdown(started ? g.phaseEndsAt : null);
  const urgent = left != null && left <= 5 && g.clipSeconds > 5;
  const online = view.players.filter((p) => p.connected);
  const locked = online.filter((p) => p.locked).length;
  const failed = status.audioState === 'error';

  return (
    <section className="card stage stage-card">
      <div className="listen">
        <Eq state={failed ? 'err' : started && status.audioState === 'playing' ? 'on' : 'wait'} />
        <div>
          <h2>{!started ? 'Get ready…' : failed ? 'Audio failed to load' : 'Which anime is this?'}</h2>
          <p className="sub">{!started ? 'The song starts in a moment' : failed ? 'You can still guess, or wait for the reveal' : 'Any season or movie of the series counts'}</p>
        </div>
        {left != null && <span className={urgent ? 'count urgent' : 'count'} key={urgent ? Math.ceil(left) : 'n'} aria-label={`${Math.ceil(left)} seconds left`}>{Math.ceil(left)}</span>}
      </div>
      <TimerBar left={left ?? (started ? 0 : g.clipSeconds)} total={g.clipSeconds} tone={urgent ? 'urgent' : undefined} />
      <GuessInput
        index={index}
        enabled={started}
        current={g.myGuess}
        roundKey={`${g.id}-${g.round}`}
        onPick={(e) => socket.emit('guess:set', { anilistId: e.id })}
        onLock={() => socket.emit('guess:lock')}
      />
      {online.length > 1 && (
        <div className="lock-status">
          <span className="faces">
            {online.map((p) => <Avatar key={p.id} name={p.name} size="sm" className={p.locked ? '' : 'pending'} />)}
          </span>
          <span><b className="num-tab">{locked}</b> / {online.length} locked in</span>
        </div>
      )}
    </section>
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
  const left = useCountdown(g.phaseEndsAt);
  const online = view.players.filter((p) => p.connected);
  const voted = r.skipVotes.includes(view.meId);
  const me = r.results.find((x) => x.playerId === view.meId);
  const fastest = Math.min(...r.results.filter((x) => x.correct && x.ms != null).map((x) => x.ms!));
  const results = [...r.results].sort((x, y) => Number(y.correct) - Number(x.correct) || y.points - x.points);
  const tone = !me || me.away || (!me.correct && !me.guess) ? 'none' : me.correct ? 'good' : 'bad';

  return (
    <div className="stage">
      <div className="verdict-row">
        {me && (
          <div className={`verdict ${tone}`}>
            <span className="ico"><Icon name={me.correct ? 'check' : me.away || !me.guess ? 'dots' : 'x'} size={18} /></span>
            {me.correct ? <>Correct! <span className="plus">+{me.points}</span></> : me.away ? 'You missed this one' : me.guess ? 'Not this time' : 'No answer'}
          </div>
        )}
        <span className="grow" />
        <button className={voted ? 'btn outline' : 'btn primary'} disabled={voted || g.paused} onClick={() => socket.emit('reveal:skip')}>
          {voted ? 'Waiting for others' : g.next ? 'Next song' : 'Show results'}
          <span className="num-tab" style={{ opacity: .75 }}>{r.skipVotes.length}/{online.length}</span>
          {!voted && <Icon name="chevron" size={16} />}
        </button>
      </div>
      {g.paused ? <p className="pill warn" style={{ justifySelf: 'start' }}><Icon name="pause" size={13} /> Paused by the admin</p>
        : <TimerBar left={left} total={view.settings.revealSeconds} tone="calm" />}

      <div className="reveal-grid">
        <div className="video-box" ref={box}>
          {status.videoFailed && <img src={a.cover} alt="" className="cover-fallback" />}
        </div>
        <div className="answer">
          <div className="answer-head">
            <img src={a.cover} alt="" className="cover" />
            <div>
              <h2>{a.title}</h2>
              {a.romaji !== a.title && <div className="alt">{a.romaji}</div>}
              {a.native && a.native !== a.romaji && a.native !== a.title && <div className="native">{a.native}</div>}
            </div>
          </div>
          <div className="song">
            <span className="note"><Icon name="music" /></span>
            <div>
              <div className="name">{a.songName}</div>
              <div className="by">{a.songType} · {a.songArtist}</div>
            </div>
          </div>
          <div className="facts">
            <span className="pill">{a.format.replace('_', ' ')}</span>
            {a.year && <span className="pill">{a.year}</span>}
            <span className="pill" style={{ textTransform: 'capitalize' }}>{a.tier}</span>
            <span className="pill cyan" title="Share of AnimeMusicQuiz players who get this song">{Math.round(a.amqDifficulty)}% on AMQ</span>
          </div>
          {a.alsoAccepted.length > 0 && <p className="also">Also accepted: {a.alsoAccepted.join(', ')}</p>}
        </div>
      </div>

      <ul className="results">
        {results.map((x) => (
          <li key={x.playerId} className={x.playerId === view.meId ? 'me' : ''}>
            <Avatar name={x.name} size="sm" off={x.away} />
            <div className="who">
              <b>{x.name}</b>
              <span className={`guess-text ${x.correct ? 'good' : x.guess ? 'bad' : ''}`}>
                {x.away ? <i>away</i> : x.guess ? <><Icon name={x.correct ? 'check' : 'x'} size={14} />{x.guess}</> : <i>no answer</i>}
              </span>
            </div>
            <div className="score">
              {x.points ? <b>+{x.points}</b> : null}
              {x.ms != null && (
                <span>{x.correct && x.ms === fastest && r.results.length > 1 && <span className="fast"><Icon name="zap" size={12} /> fastest </span>}{(x.ms / 1000).toFixed(1)}s</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Finished({ view, act }: { view: RoomView; act: Act }) {
  const g = view.game!;
  const isAdmin = view.meId === view.adminId;
  const standings = view.players.filter((p) => p.points > 0 || p.correct > 0 || p.connected).sort((a, b) => b.points - a.points);
  // Visual order 2nd, 1st, 3rd; with fewer players the missing places are simply dropped.
  const podium = ([[standings[1], 2], [standings[0], 1], [standings[2], 3]] as [PlayerView | undefined, number][])
    .filter((x): x is [PlayerView, number] => !!x[0]);
  const rest = standings.slice(3);
  const rounds = g.history.length;

  return (
    <div className="stage">
      <section className="card stage-card" style={{ display: 'grid', gap: 20 }}>
        <div style={{ textAlign: 'center' }}>
          <span className="kicker">Final results</span>
          <h2 style={{ fontSize: 30, marginTop: 4 }}>{standings[0] && standings[0].points > 0 ? `${standings[0].name} wins!` : 'Game over'}</h2>
        </div>
        <div className="podium" style={{ '--n': podium.length } as React.CSSProperties}>
          {podium.map(([p, place]) => {
            return (
              <div key={p.id} className={`place p${place}`}>
                <Avatar name={p.name} size="lg" />
                <span className="pname"><span>{p.name}</span></span>
                <div className="step">
                  <span className="medal">{place === 1 ? '1ST' : place === 2 ? '2ND' : '3RD'}</span>
                  <b>{p.points}</b>
                  <span>{p.correct}/{rounds} correct</span>
                </div>
              </div>
            );
          })}
        </div>
        {rest.length > 0 && (
          <ul className="results">
            {rest.map((p, i) => (
              <li key={p.id} className={p.id === view.meId ? 'me' : ''}>
                <span className="rank">{i + 4}</span>
                <div className="who"><b>{p.name}</b><span className="guess-text">{p.correct}/{rounds} correct</span></div>
                <div className="score"><b style={{ color: 'var(--text)' }}>{p.points}</b></div>
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <div className="finish-actions">
            <button className="btn primary lg" onClick={() => { media.unlock(); act(request('game:start')); }}><Icon name="replay" /> Play again</button>
            <button className="btn outline lg" onClick={() => act(request('game:toLobby'))}><Icon name="sliders" /> Change settings</button>
          </div>
        ) : <p className="waiting" style={{ justifyContent: 'center' }}><span className="dot live" /> Waiting for the admin…</p>}
      </section>

      {rounds > 0 && (
        <section className="card">
          <div className="card-head"><h3>Songs this game</h3><span className="pill">{rounds}</span></div>
          <ol className="history">
            {g.history.map((h) => (
              <li key={h.round}>
                <img src={h.cover} alt="" loading="lazy" />
                <div className="info">
                  <b title={h.title}>{h.title}</b>
                  <span title={`${h.songName} · ${h.songArtist}`}>{h.songName} · {h.songArtist}</span>
                  <span className="got">
                    <span className="bar"><div style={{ width: `${h.playerCount ? (h.correctCount / h.playerCount) * 100 : 0}%` }} /></span>
                    {h.correctCount}/{h.playerCount} got it
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Leaderboard view={view} />
    </div>
  );
}
