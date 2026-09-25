import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { timing } from './config';
import type { Dataset } from './dataset';
import { hashPassword, roomCode, sha256, verifyPassword, type Store } from './db';
import { GameError, Room, type Hub } from './room';
import { DEFAULT_SETTINGS, FORMATS, LIMITS, TIERS, type Ack, type ClientToServer, type RoomListItem, type ServerToClient, type Settings } from '../shared/types';

type IO = Server<ClientToServer, ServerToClient, {}, SocketData>;
type Sock = Socket<ClientToServer, ServerToClient, {}, SocketData>;
interface SocketData { roomId?: string; playerId?: string }

const name = (max: number) => z.string().trim().min(1).max(max);
const token = z.string().min(16).max(128);

const settingsSchema = z.object({
  rounds: z.number().int().min(LIMITS.rounds[0]).max(LIMITS.rounds[1]),
  guessSeconds: z.number().int().min(LIMITS.guessSeconds[0]).max(LIMITS.guessSeconds[1]),
  revealSeconds: z.number().int().min(LIMITS.revealSeconds[0]).max(LIMITS.revealSeconds[1]),
  tiers: z.array(z.enum(TIERS)).min(1).transform((t) => [...new Set(t)]),
  formats: z.array(z.enum(FORMATS)).min(1).transform((f) => [...new Set(f)]),
  yearMin: z.number().int().min(LIMITS.year[0]).max(LIMITS.year[1]).nullable(),
  yearMax: z.number().int().min(LIMITS.year[0]).max(LIMITS.year[1]).nullable(),
  startPoint: z.enum(['random', 'start']),
  speedBonus: z.boolean(),
  avoidRepeats: z.boolean(),
});

const schemas = {
  create: z.object({ roomName: name(LIMITS.roomName), password: z.string().min(1).max(LIMITS.roomPassword), playerName: name(LIMITS.playerName), token }),
  join: z.object({ roomId: z.string().trim().toUpperCase().max(12), token, password: z.string().max(LIMITS.roomPassword).optional(), playerName: name(LIMITS.playerName).optional() }),
  media: z.object({ round: z.number().int().min(0), audio: z.string().max(500) }),
  guess: z.object({ anilistId: z.number().int().positive() }),
  paused: z.object({ paused: z.boolean() }),
  player: z.object({ playerId: z.string().max(40) }),
};

export class RoomManager implements Hub {
  readonly rooms = new Map<string, Room>();
  private dirty = new Set<Room>();
  private flushScheduled = false;
  private io!: IO;

  constructor(private store: Store, private dataset: Dataset) {
    for (const row of store.rooms()) {
      const room = new Room(this.env, row, store.players(row.id));
      this.rooms.set(room.id, room);
    }
  }

  private get env() {
    return { store: this.store, dataset: this.dataset, hub: this as Hub };
  }

  // ---------------------------------------------------------------- Hub

  changed(room: Room) {
    this.dirty.add(room);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Coalesce every change made while handling one event into one message per socket.
    setImmediate(() => {
      this.flushScheduled = false;
      const rooms = [...this.dirty];
      this.dirty.clear();
      for (const r of rooms) {
        if (!this.rooms.has(r.id) || !this.io) continue;
        for (const p of r.players.values()) {
          if (!p.sockets.size) continue;
          const view = r.view(p.id);
          for (const sid of p.sockets) this.io.to(sid).emit('room:state', view);
        }
      }
    });
  }

  detached(socketId: string, reason: 'replaced' | 'kicked' | 'deleted' | 'left') {
    const s = this.io?.sockets.sockets.get(socketId);
    if (!s) return;
    s.data.roomId = undefined;
    s.data.playerId = undefined;
    if (reason === 'replaced') s.emit('session:replaced');
    else if (reason !== 'left') s.emit('room:gone', { reason });
  }

  // ---------------------------------------------------------------- HTTP helpers

  list(): RoomListItem[] {
    return [...this.rooms.values()]
      .map((r) => ({
        id: r.id, name: r.name, online: r.connectedPlayers.length, players: r.activePlayers.length,
        inGame: !!r.game && r.game.phase !== 'finished', lastActiveAt: r.lastActiveAt,
      }))
      .sort((a, b) => b.online - a.online || b.lastActiveAt - a.lastActiveAt);
  }

  /** Deletes rooms nobody has used for a long time. */
  cleanup(now = Date.now()) {
    for (const r of this.rooms.values()) {
      if (!r.connectedPlayers.length && now - r.lastActiveAt > timing.roomTtl) {
        r.dispose();
        this.rooms.delete(r.id);
        this.store.deleteRoom(r.id);
      }
    }
  }

  // ---------------------------------------------------------------- sockets

  attach(io: IO) {
    this.io = io;
    io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: Sock) {
    const current = () => {
      const room = socket.data.roomId ? this.rooms.get(socket.data.roomId) : undefined;
      const playerId = socket.data.playerId;
      if (!room || !playerId) throw new GameError('You are not in a room');
      return { room, playerId };
    };

    /** Runs a handler, turning thrown errors into `{ ok: false }` acks. */
    const handle = <A extends unknown[]>(fn: (...args: A) => void | object) => (...args: A) => {
      const ack = args[args.length - 1];
      const reply = typeof ack === 'function' ? (ack as (r: Ack<object>) => void) : undefined;
      try {
        const res = fn(...args);
        reply?.({ ok: true, ...(res ?? {}) });
      } catch (e) {
        const error = e instanceof GameError ? e.message : e instanceof z.ZodError ? 'Invalid input' : 'Server error';
        if (!(e instanceof GameError) && !(e instanceof z.ZodError)) console.error(e);
        reply?.({ ok: false, error });
      }
    };

    socket.on('sync', (_t, ack) => typeof ack === 'function' && ack(Date.now()));

    socket.on('room:create', handle((p) => {
      const { roomName, password, playerName, token } = schemas.create.parse(p);
      this.leaveCurrent(socket);
      let id = roomCode();
      while (this.rooms.has(id)) id = roomCode();
      const now = Date.now();
      const row = {
        id, name: roomName, password_hash: hashPassword(password), admin_id: null,
        settings_json: JSON.stringify(DEFAULT_SETTINGS), created_at: now, last_active_at: now, game_json: null,
      };
      this.store.insertRoom(row);
      const room = new Room(this.env, row, []);
      this.rooms.set(id, room);
      const player = room.addPlayer(playerName, sha256(token));
      this.bind(socket, room, player.id);
      return { roomId: id };
    }));

    socket.on('room:join', handle((p) => {
      const { roomId, token, password, playerName } = schemas.join.parse(p);
      const room = this.rooms.get(roomId);
      if (!room) throw new GameError('Room not found');
      const tokenHash = sha256(token);
      const mine = room.findByToken(tokenHash);

      // Reconnecting member: no password needed.
      if (mine && !mine.left) {
        this.leaveCurrent(socket, room.id);
        this.bind(socket, room, mine.id);
        return {};
      }

      if (password == null) return { needPassword: true };
      if (!verifyPassword(password, room.passwordHash)) throw new GameError('Wrong room password');
      const wanted = playerName ?? mine?.name;
      if (!wanted) throw new GameError('Pick a name');

      // Same name as someone in the room: if they're offline this is them on another device, so take
      // over their seat (and points); if they're online the name is taken.
      const sameName = room.findByName(wanted);
      let seat = mine;
      if (sameName && sameName !== mine) {
        if (!sameName.left && sameName.sockets.size) throw new GameError('That name is taken in this room');
        seat = sameName;
      }
      if (!seat && room.activePlayers.length >= LIMITS.maxPlayers) throw new GameError('Room is full');
      this.leaveCurrent(socket, room.id);
      const player = room.addPlayer(wanted, tokenHash, seat);
      this.bind(socket, room, player.id);
      return {};
    }));

    socket.on('room:leave', handle(() => {
      const { room, playerId } = current();
      socket.leave(room.id);
      room.leave(playerId, 'left');
      socket.data.roomId = socket.data.playerId = undefined;
    }));

    socket.on('room:settings', handle((p) => {
      const { room, playerId } = current();
      room.updateSettings(playerId, validSettings({ ...room.settings, ...(p as object) }));
    }));

    socket.on('room:delete', handle(() => {
      const { room, playerId } = current();
      if (playerId !== room.adminId) throw new GameError('Only the room admin can do that');
      for (const pl of room.players.values()) for (const s of pl.sockets) this.detached(s, 'deleted');
      room.dispose();
      this.rooms.delete(room.id);
      this.store.deleteRoom(room.id);
    }));

    socket.on('game:start', handle(() => { const { room, playerId } = current(); room.startGame(playerId); }));
    socket.on('game:end', handle(() => { const { room, playerId } = current(); room.endGame(playerId); }));
    socket.on('game:toLobby', handle(() => { const { room, playerId } = current(); room.toLobby(playerId); }));

    socket.on('round:ready', handle((p) => {
      const { round, audio } = schemas.media.parse(p);
      const { room, playerId } = current();
      room.reportReady(playerId, round, audio);
    }));
    socket.on('round:mediaError', handle((p) => {
      const { round, audio } = schemas.media.parse(p);
      const { room, playerId } = current();
      room.reportMediaError(playerId, round, audio);
    }));

    socket.on('guess:set', handle((p) => {
      const { anilistId } = schemas.guess.parse(p);
      const { room, playerId } = current();
      room.setGuess(playerId, anilistId);
    }));
    socket.on('guess:lock', handle(() => { const { room, playerId } = current(); room.lockGuess(playerId); }));
    socket.on('reveal:skip', handle(() => { const { room, playerId } = current(); room.voteSkip(playerId); }));

    socket.on('admin:pause', handle((p) => {
      const { paused } = schemas.paused.parse(p);
      const { room, playerId } = current();
      room.setPaused(playerId, paused);
    }));
    socket.on('admin:skipRound', handle(() => { const { room, playerId } = current(); room.skipRound(playerId); }));
    socket.on('admin:kick', handle((p) => {
      const { playerId: target } = schemas.player.parse(p);
      const { room, playerId } = current();
      if (playerId !== room.adminId) throw new GameError('Only the room admin can do that');
      if (target === playerId) throw new GameError('You can’t kick yourself');
      room.leave(target, 'kicked');
    }));
    socket.on('admin:transfer', handle((p) => {
      const { playerId: target } = schemas.player.parse(p);
      const { room, playerId } = current();
      room.transferAdmin(playerId, target);
    }));

    socket.on('disconnect', () => this.leaveCurrent(socket));
  }

  private bind(socket: Sock, room: Room, playerId: string) {
    socket.data.roomId = room.id;
    socket.data.playerId = playerId;
    socket.join(room.id);
    room.attach(playerId, socket.id);
  }

  /** Detaches the socket from whatever room it was in (it stays a member of that room). */
  private leaveCurrent(socket: Sock, exceptRoomId?: string) {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const room = this.rooms.get(roomId);
    if (roomId !== exceptRoomId) socket.leave(roomId);
    socket.data.roomId = socket.data.playerId = undefined;
    room?.detach(playerId, socket.id);
  }
}

export function validSettings(s: unknown): Settings {
  const v = settingsSchema.parse(s);
  if (v.yearMin != null && v.yearMax != null && v.yearMin > v.yearMax) throw new GameError('Year range is empty');
  return v;
}
