import { useEffect, useState } from 'react';
import type { RoomListItem } from '../../shared/types';
import { media } from './media';
import { playerToken, request, saveName, savedName } from './net';
import { Icon, Logo } from './ui';

/** Home screen: list of rooms + create a room. */
export function Browser({ onEnter, setNotice }: { onEnter: (roomId: string) => void; setNotice: (s: string) => void }) {
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [name, setName] = useState(savedName);
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/rooms').then((r) => r.json()).then((l) => alive && setRooms(l)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    media.unlock();
    setBusy(true);
    const r = await request('room:create', { roomName: roomName.trim(), password, playerName: name.trim(), token: playerToken() });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    saveName(name.trim());
    setNotice('');
    onEnter(r.roomId);
  };

  const enter = (id: string) => {
    media.unlock();
    if (name.trim()) saveName(name.trim());
    setNotice('');
    onEnter(id);
  };

  return (
    <div className="home">
      <header className="home-top">
        <Logo />
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => fetch('/api/logout', { method: 'POST' }).then(() => location.reload())}>
          <Icon name="logout" size={16} /> Log out
        </button>
      </header>

      <div className="home-hero">
        <h1>Hear the opening.<br /><em>Name the anime.</em></h1>
        <p>Join your friends' room, or open a new one.</p>
      </div>

      <div className="home-grid">
        <section className="card">
          <div className="card-head">
            <h3>Rooms</h3>
            {rooms && rooms.length > 0 && <span className="pill">{rooms.length}</span>}
          </div>
          {!rooms && <div className="empty"><span className="spinner" /></div>}
          {rooms?.length === 0 && (
            <div className="empty">
              <Icon name="music" size={28} />
              <b>No rooms yet</b>
              <span className="small">Create one and send the link to your friends.</span>
            </div>
          )}
          {!!rooms?.length && (
            <ul className="room-list">
              {rooms.map((r) => (
                <li key={r.id}>
                  <button className="room-item" onClick={() => enter(r.id)}>
                    <span className={r.inGame ? 'room-icon live' : 'room-icon'}><Icon name={r.inGame ? 'music' : 'users'} size={20} /></span>
                    <span className="meta">
                      <span className="name">{r.name}</span>
                      <span className="sub">
                        <span className="code">{r.id}</span>
                        <span><span className={r.online ? 'dot on' : 'dot'} /> {r.online} online</span>
                        {r.inGame && <span className="pill live"><span className="dot live" /> Playing</span>}
                      </span>
                    </span>
                    <Icon name="chevron" className="chev" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="code-row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) enter(code.trim().toUpperCase()); }}>
            <input placeholder="Have a room code?" aria-label="Room code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} autoCapitalize="characters" autoComplete="off" />
            <button className="btn outline" disabled={!code.trim()}>Join</button>
          </form>
        </section>

        <section className="card">
          <div className="card-head"><h3>New room</h3></div>
          <form className="create-form" onSubmit={create}>
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required autoComplete="nickname" />
            </label>
            <label className="field">
              <span>Room name</span>
              <input placeholder="Friday night OPs" value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={30} required />
            </label>
            <label className="field">
              <span>Room password</span>
              <input type="password" placeholder="Friends need it to join" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} required autoComplete="new-password" />
            </label>
            <button className="btn primary lg block" disabled={busy}><Icon name="plus" /> {busy ? 'Creating…' : 'Create room'}</button>
            <div className="error" role="alert">{err}</div>
          </form>
        </section>
      </div>
    </div>
  );
}
