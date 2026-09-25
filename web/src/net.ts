import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, ServerToClient } from '../../shared/types';

export const socket: Socket<ServerToClient, ClientToServer> = io({ autoConnect: false });

// ---------------------------------------------------------------- identity (per browser, no login)

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

let memToken: string | null = null;
/** Secret that identifies this browser as the same player when it reconnects. */
export function playerToken(): string {
  let t = memToken ?? store('aq_token');
  if (!t) {
    const bytes = crypto.getRandomValues(new Uint8Array(24)); // works on plain http too, unlike randomUUID
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    store('aq_token', t);
  }
  memToken = t;
  return t;
}

export const savedName = () => store('aq_name') ?? '';
export const saveName = (n: string) => store('aq_name', n);
export const savedVolume = () => Number(store('aq_volume') ?? 0.8);
export const saveVolume = (v: number) => store('aq_volume', String(v));

// ---------------------------------------------------------------- clock sync

let offset = 0;
/** Current time on the server clock (ms). Phase deadlines from the server are in this clock. */
export const serverNow = () => Date.now() + offset;

/** NTP-style: several round trips, keep the one with the lowest latency. */
export async function syncClock(samples = 6) {
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const server = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      socket.emit('sync', t0, (s) => { clearTimeout(timer); resolve(s); });
    });
    const t1 = Date.now();
    if (server == null) continue;
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: server - (t0 + t1) / 2 };
  }
  if (best.rtt < Infinity) offset = best.offset;
}

// ---------------------------------------------------------------- requests

type Events = ClientToServer;
type AckOf<E extends keyof Events> = Parameters<Events[E]> extends [...infer _A, infer Cb]
  ? Cb extends ((r: infer R) => void) | undefined ? R : never : never;

/** Emits an event and resolves with the server's ack (or a timeout error). */
export function request<E extends keyof Events>(event: E, ...args: unknown[]): Promise<AckOf<E>> {
  return new Promise((resolve) => {
    if (!socket.connected) return resolve({ ok: false, error: 'Not connected, retrying…' } as AckOf<E>);
    (socket.timeout(8000).emit as (...a: unknown[]) => void)(event, ...args, (err: unknown, res: AckOf<E>) => {
      resolve(err ? ({ ok: false, error: 'The server did not answer' } as AckOf<E>) : res);
    });
  });
}

export type { Ack };
