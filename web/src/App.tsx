import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomView } from '../../shared/types';
import { Browser } from './Browser';
import { media } from './media';
import { playerToken, request, saveName, savedName, socket, syncClock } from './net';
import { RoomScreen } from './Room';

// ---------------------------------------------------------------- tiny router

function usePath(): [string, (p: string, replace?: boolean) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((p: string, replace = false) => {
    if (p === location.pathname) return;
    if (replace) history.replaceState(null, '', p);
    else history.pushState(null, '', p);
    setPath(p);
  }, []);
  return [path, navigate];
}

const roomIdFrom = (path: string) => /^\/r\/([A-Za-z0-9]+)\/?$/.exec(path)?.[1].toUpperCase() ?? null;

// ---------------------------------------------------------------- app

export function App() {
  const [auth, setAuth] = useState<'checking' | 'yes' | 'no'>('checking');
  useEffect(() => {
    fetch('/api/me').then((r) => setAuth(r.ok ? 'yes' : 'no')).catch(() => setAuth('no'));
  }, []);
  if (auth === 'checking') return null;
  if (auth === 'no') return <Login />;
  return <Main />;
}

function Login() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({ ok: false }));
    if (j.ok) location.reload();
    else setErr(j.error ?? 'Wrong password');
  };
  return (
    <form className="center-card" onSubmit={submit}>
      <h2>Anime Quiz</h2>
      <input type="password" placeholder="Site password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      <button>Enter</button>
      <div className="error">{err}</div>
    </form>
  );
}

type JoinState = 'idle' | 'joining' | 'needPassword' | 'joined';

function Main() {
  const [path, navigate] = usePath();
  const roomId = roomIdFrom(path);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<RoomView | null>(null);
  const [joinState, setJoinState] = useState<JoinState>('idle');
  const [notice, setNotice] = useState('');
  const [replaced, setReplaced] = useState(false);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const joinStateRef = useRef(joinState);
  joinStateRef.current = joinState;
  const replacedRef = useRef(replaced);
  replacedRef.current = replaced;

  const join = useCallback(async (id: string) => {
    setJoinState('joining');
    const r = await request('room:join', { roomId: id, token: playerToken() });
    if (roomRef.current !== id) return;
    if (!r.ok) {
      setJoinState('idle');
      setNotice(r.error);
      if (r.error === 'Room not found') navigate('/', true);
      return;
    }
    setJoinState(r.needPassword ? 'needPassword' : 'joined');
  }, [navigate]);

  useEffect(() => {
    const onConnect = async () => {
      setConnected(true);
      await syncClock();
      // Reconnect: take our seat back (no password needed for members), unless another tab has it now.
      if (roomRef.current && joinStateRef.current !== 'needPassword' && !replacedRef.current) join(roomRef.current);
    };
    const onDisconnect = () => setConnected(false);
    const onState = (v: RoomView) => {
      if (v.id !== roomRef.current) return;
      setView(v);
      setJoinState('joined');
      media.update(v.game);
    };
    const onGone = ({ reason }: { reason: string }) => {
      setView(null);
      media.update(null);
      setJoinState('idle');
      setNotice(reason === 'kicked' ? 'You were removed from the room.' : 'The room was deleted.');
      navigate('/');
    };
    const onReplaced = () => {
      setReplaced(true);
      media.update(null);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', onState);
    socket.on('room:gone', onGone);
    socket.on('session:replaced', onReplaced);
    socket.connect();
    // Re-sync the clock now and then (laptops sleep, clocks drift).
    const t = setInterval(() => socket.connected && syncClock(3), 60_000);
    return () => {
      clearInterval(t);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', onState);
      socket.off('room:gone', onGone);
      socket.off('session:replaced', onReplaced);
      socket.disconnect();
    };
  }, [join, navigate]);

  // Entering / leaving a room URL.
  useEffect(() => {
    setView(null);
    media.update(null);
    if (!roomId) {
      setJoinState('idle');
      return;
    }
    if (socket.connected) join(roomId);
  }, [roomId, join]);

  const leave = async () => {
    await request('room:leave');
    navigate('/');
  };

  return (
    <>
      {!connected && <div className="banner warn">Connecting to the server…</div>}
      {notice && <div className="banner" onClick={() => setNotice('')}>{notice} <small>(click to dismiss)</small></div>}
      {replaced && (
        <div className="overlay">
          <div className="center-card">
            <p>This room is open in another tab or device.</p>
            <button onClick={() => { setReplaced(false); if (roomId) join(roomId); media.unlock(); }}>Play here instead</button>
          </div>
        </div>
      )}
      {!roomId && <Browser onEnter={(id) => navigate(`/r/${id}`)} setNotice={setNotice} />}
      {roomId && joinState === 'needPassword' && (
        <JoinForm roomId={roomId} onJoined={() => setJoinState('joined')} onCancel={() => navigate('/')} />
      )}
      {roomId && view && joinState === 'joined' && <RoomScreen view={view} onLeave={leave} />}
      {roomId && !view && joinState !== 'needPassword' && <p className="muted pad">Joining room {roomId}…</p>}
    </>
  );
}

function JoinForm({ roomId, onJoined, onCancel }: { roomId: string; onJoined: () => void; onCancel: () => void }) {
  const [name, setName] = useState(savedName);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    media.unlock();
    setBusy(true);
    const r = await request('room:join', { roomId, token: playerToken(), password, playerName: name.trim() });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    saveName(name.trim());
    onJoined();
  };
  return (
    <form className="center-card" onSubmit={submit}>
      <h2>Join room {roomId}</h2>
      <input placeholder="Your name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} required autoFocus={!name} />
      <input type="password" placeholder="Room password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!name} />
      <button disabled={busy}>Join</button>
      <button type="button" className="secondary" onClick={onCancel}>Back</button>
      <div className="error">{err}</div>
    </form>
  );
}
