import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RoomRow {
  id: string;
  name: string;
  password_hash: string;
  admin_id: string | null;
  settings_json: string;
  created_at: number;
  last_active_at: number;
  game_json: string | null;
}

export interface PlayerRow {
  id: string;
  room_id: string;
  token_hash: string;
  name: string;
  joined_at: number;
  left: number;
  points: number;
  correct: number;
  games_played: number;
  games_won: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  admin_id TEXT,
  settings_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  game_json TEXT
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_room ON players(room_id);
CREATE TABLE IF NOT EXISTS played_songs (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  song_key INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, song_key)
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  rounds_played INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  results_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /** A random secret that survives restarts (signs auth cookies). */
  secret(): string {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get('secret') as { v: string } | undefined;
    if (row) return row.v;
    const v = crypto.randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('secret', v);
    return v;
  }

  rooms(): RoomRow[] {
    return this.db.prepare('SELECT * FROM rooms').all() as RoomRow[];
  }

  players(roomId: string): PlayerRow[] {
    return this.db.prepare('SELECT * FROM players WHERE room_id = ? ORDER BY joined_at').all(roomId) as PlayerRow[];
  }

  insertRoom(r: RoomRow) {
    this.db.prepare(`INSERT INTO rooms (id, name, password_hash, admin_id, settings_json, created_at, last_active_at, game_json)
      VALUES (@id, @name, @password_hash, @admin_id, @settings_json, @created_at, @last_active_at, @game_json)`).run(r);
  }

  updateRoom(id: string, fields: Partial<Omit<RoomRow, 'id'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE rooms SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }

  deleteRoom(id: string) {
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  upsertPlayer(p: PlayerRow) {
    this.db.prepare(`INSERT INTO players (id, room_id, token_hash, name, joined_at, left, points, correct, games_played, games_won)
      VALUES (@id, @room_id, @token_hash, @name, @joined_at, @left, @points, @correct, @games_played, @games_won)
      ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, name = excluded.name, left = excluded.left,
        points = excluded.points, correct = excluded.correct, games_played = excluded.games_played, games_won = excluded.games_won`).run(p);
  }

  playedSongs(roomId: string): Map<number, number> {
    const rows = this.db.prepare('SELECT song_key, played_at FROM played_songs WHERE room_id = ?').all(roomId) as { song_key: number; played_at: number }[];
    return new Map(rows.map((r) => [r.song_key, r.played_at]));
  }

  markPlayed(roomId: string, songKey: number, at: number) {
    this.db.prepare(`INSERT INTO played_songs (room_id, song_key, played_at) VALUES (?, ?, ?)
      ON CONFLICT(room_id, song_key) DO UPDATE SET played_at = excluded.played_at`).run(roomId, songKey, at);
  }

  insertGame(g: { id: string; room_id: string; started_at: number; ended_at: number; rounds_played: number; settings_json: string; results_json: string }) {
    this.db.prepare(`INSERT INTO games (id, room_id, started_at, ended_at, rounds_played, settings_json, results_json)
      VALUES (@id, @room_id, @started_at, @ended_at, @rounds_played, @settings_json, @results_json)`).run(g);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

/** Short, unambiguous, shareable room code, e.g. "K7QM2X". */
export function roomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}
