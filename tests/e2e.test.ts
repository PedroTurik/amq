import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioc, type Socket } from 'socket.io-client';
import { createApp } from '../server/app';
import { Store } from '../server/db';
import type { ClientToServer, RoomView, ServerToClient } from '../shared/types';
import { fakeDataset } from './helpers';

type C = Socket<ServerToClient, ClientToServer>;

let url = '';
let cookie = '';
let app: ReturnType<typeof createApp>;
const clients: C[] = [];

beforeAll(async () => {
  app = createApp({ store: new Store(':memory:'), dataset: fakeDataset(), masterPassword: 'Guigayafuu', trustProxy: false });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  clients.forEach((c) => c.disconnect());
  app.io.close();
  app.server.close();
});

/** A client that keeps the latest room state. */
function client(withCookie = true) {
  const c: C = ioc(url, { transports: ['websocket'], extraHeaders: withCookie ? { cookie } : {}, reconnection: false, forceNew: true });
  clients.push(c);
  const state = { view: null as RoomView | null };
  c.on('room:state', (v) => (state.view = v));
  return { c, state };
}

const emit = <T>(c: C, ev: string, ...args: unknown[]) =>
  new Promise<T>((resolve) => (c.emit as (...a: unknown[]) => void)(ev, ...args, resolve));

async function until(fn: () => boolean, ms = 8000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('http auth gate', () => {
  it('serves only the login page without the master password', async () => {
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Site password');
    expect((await fetch(`${url}/api/rooms`)).status).toBe(401);
    expect((await fetch(`${url}/api/titles`)).status).toBe(401);

    const bad = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Guigayafuu' }) });
    expect(ok.status).toBe(200);
    cookie = ok.headers.get('set-cookie')!.split(';')[0];
    const titles = await fetch(`${url}/api/titles`, { headers: { cookie } });
    expect((await titles.json()).length).toBe(31);
  });

  it('rejects sockets without the cookie', async () => {
    const { c } = client(false);
    await new Promise<void>((resolve) => c.on('connect_error', () => resolve()));
    expect(c.connected).toBe(false);
  });
});

describe('multiplayer game over sockets', () => {
  it('create, join, play a round, drop and rejoin with points', async () => {
    const A = client();
    const B = client();
    const tokA = 'a'.repeat(32);
    const tokB = 'b'.repeat(32);

    const created = await emit<{ ok: boolean; roomId: string }>(A.c, 'room:create', { roomName: 'Friends', password: 'secret', playerName: 'Alice', token: tokA });
    expect(created.ok).toBe(true);
    const roomId = created.roomId;

    expect(await emit(B.c, 'room:join', { roomId, token: tokB })).toEqual({ ok: true, needPassword: true });
    expect(await emit(B.c, 'room:join', { roomId, token: tokB, password: 'wrong', playerName: 'Bob' })).toMatchObject({ ok: false });
    expect(await emit(B.c, 'room:join', { roomId, token: tokB, password: 'secret', playerName: 'alice' })).toMatchObject({ ok: false, error: /taken/ });
    expect(await emit(B.c, 'room:join', { roomId, token: tokB, password: 'secret', playerName: 'Bob' })).toEqual({ ok: true });
    await until(() => A.state.view?.players.length === 2);

    expect(await emit(B.c, 'game:start')).toMatchObject({ ok: false, error: /admin/ });
    expect(await emit(A.c, 'room:settings', { rounds: 2, guessSeconds: 5, revealSeconds: 5 })).toEqual({ ok: true });
    expect(await emit(A.c, 'room:settings', { rounds: 0 })).toMatchObject({ ok: false });
    expect(await emit(A.c, 'game:start')).toEqual({ ok: true });

    await until(() => A.state.view?.game?.phase === 'loading' && B.state.view?.game?.phase === 'loading');
    const g = A.state.view!.game!;
    expect(g.reveal).toBeNull();
    for (const x of [A, B]) x.c.emit('round:ready', { round: 0, audio: g.media!.audio });
    await until(() => A.state.view?.game?.phase === 'guessing');
    const clipStartAt = A.state.view!.game!.clipStartAt!;
    await new Promise((r) => setTimeout(r, clipStartAt - Date.now() + 50));

    // The server knows the answer; the clients don't.
    const room = app.manager.rooms.get(roomId)!;
    const answer = room.game!.playlist[0].song.row.anilistId;
    expect(await emit(A.c, 'guess:set', { anilistId: answer })).toEqual({ ok: true });
    expect(await emit(B.c, 'guess:set', { anilistId: answer === 5 ? 6 : 5 })).toEqual({ ok: true });
    await until(() => !!B.state.view?.players.find((p) => p.name === 'Alice')?.answered);
    expect(B.state.view!.game!.myGuess!.anilistId).not.toBe(answer);
    await emit(A.c, 'guess:lock');
    await emit(B.c, 'guess:lock');
    await until(() => A.state.view?.game?.phase === 'reveal');
    const alicePoints = A.state.view!.players.find((p) => p.name === 'Alice')!.points;
    expect(alicePoints).toBeGreaterThan(100);
    expect(A.state.view!.game!.reveal!.answer.anilistId).toBe(answer);

    // Alice's connection drops; she comes back on a new socket with the same token: no password, same points.
    A.c.disconnect();
    await until(() => B.state.view?.players.find((p) => p.name === 'Alice')?.connected === false);
    const A2 = client();
    await new Promise<void>((r) => A2.c.on('connect', () => r()));
    expect(await emit(A2.c, 'room:join', { roomId, token: tokA })).toEqual({ ok: true });
    await until(() => !!A2.state.view);
    expect(A2.state.view!.players.find((p) => p.name === 'Alice')!.points).toBe(alicePoints);
    expect(A2.state.view!.adminId).toBe(A2.state.view!.meId);

    // Same name from another device while Alice is online: refused. Once she's offline: takes over her seat.
    A2.c.disconnect();
    const A3 = client();
    await new Promise<void>((r) => A3.c.on('connect', () => r()));
    await until(() => B.state.view?.players.find((p) => p.name === 'Alice')?.connected === false);
    expect(await emit(A3.c, 'room:join', { roomId, token: 'c'.repeat(32), password: 'secret', playerName: 'Alice' })).toEqual({ ok: true });
    await until(() => !!A3.state.view);
    expect(A3.state.view!.players.length).toBe(2);
    expect(A3.state.view!.players.find((p) => p.name === 'Alice')!.points).toBe(alicePoints);

    const list = await (await fetch(`${url}/api/rooms`, { headers: { cookie } })).json();
    expect(list[0]).toMatchObject({ id: roomId, online: 2, players: 2, inGame: true });
  });
});
