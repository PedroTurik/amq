import { useEffect, useState } from 'react';
import type { RoomListItem } from '../../shared/types';
import { media } from './media';
import { playerToken, request, saveName, savedName } from './net';

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
    <div className="browser">
      <h1>Anime Opening Quiz</h1>

      <section>
        <h3>Rooms</h3>
        {!rooms && <p className="muted">Loading…</p>}
        {rooms?.length === 0 && <p className="muted">No rooms yet: create one below.</p>}
        <ul className="room-list">
          {rooms?.map((r) => (
            <li key={r.id}>
              <button onClick={() => enter(r.id)}>Join</button>
              <b>{r.name}</b> <span className="muted">#{r.id}</span>
              <span className="muted"> · {r.online} online / {r.players} players{r.inGame ? ' · in game' : ''}</span>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) enter(code.trim().toUpperCase()); }}>
          <input placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} />
          <button className="secondary">Go</button>
        </form>
      </section>

      <section>
        <h3>Create a room</h3>
        <form className="stack" onSubmit={create}>
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
          <input placeholder="Room name" value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={30} required />
          <input placeholder="Room password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} required />
          <button disabled={busy}>Create room</button>
          <div className="error">{err}</div>
        </form>
      </section>

      <p className="muted small">
        <a href="#" onClick={(e) => { e.preventDefault(); fetch('/api/logout', { method: 'POST' }).then(() => location.reload()); }}>Log out of the site</a>
      </p>
    </div>
  );
}
