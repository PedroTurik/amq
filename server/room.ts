import { timing } from './config';
import type { Dataset, Song } from './dataset';
import { newId, type PlayerRow, type RoomRow, type Store } from './db';
import { clipOffset, pickSongs, type Rng } from './picker';
import {
  BASE_POINTS, MAX_SPEED_BONUS,
  type AnswerInfo, type GamePhase, type GameView, type GuessResult, type LeaderboardEntry, type MediaInfo,
  type PlayerView, type RoomView, type RoundSummary, type Settings,
} from '../shared/types';

/** How the room talks to the outside world (implemented by the socket layer, faked in tests). */
export interface Hub {
  /** Room state changed: send fresh views to everyone in it. */
  changed(room: Room): void;
  /** A socket no longer belongs to this room. */
  detached(socketId: string, reason: 'replaced' | 'kicked' | 'deleted' | 'left'): void;
}

export interface Env {
  store: Store;
  dataset: Dataset;
  hub: Hub;
  now?: () => number;
  rng?: Rng;
}

export class GameError extends Error {}

interface Player {
  id: string;
  name: string;
  tokenHash: string;
  joinedAt: number;
  left: boolean;
  /** All-time stats in this room. */
  stats: { points: number; correct: number; gamesPlayed: number; gamesWon: number };
  sockets: Set<string>;
  /** When the last connection dropped; null while connected (or never connected since boot). */
  disconnectedAt: number | null;
}

interface Guess { anilistId: number; at: number; locked: boolean }

interface PlaylistItem { song: Song; offset: number }

interface Round {
  ready: Set<string>;
  errors: Set<string>;
  clipStartAt: number | null;
  /** Players who were connected at some point while the clip was playing. */
  seen: Set<string>;
  guesses: Map<string, Guess>;
  results: GuessResult[] | null;
  videoStart: number;
  skipVotes: Set<string>;
}

interface Game {
  id: string;
  settings: Settings;
  startedAt: number;
  playlist: PlaylistItem[];
  reserve: PlaylistItem[];
  index: number;
  phase: GamePhase;
  phaseEndsAt: number | null;
  paused: boolean;
  /** Time left in the reveal when it was paused. */
  pausedRemaining: number | null;
  scores: Map<string, { points: number; correct: number }>;
  /** Everyone who took part in at least one round. */
  participants: Set<string>;
  history: RoundSummary[];
  round: Round;
}

/** What gets written to rooms.game_json so a game survives a server restart. */
interface GameSnapshot {
  id: string;
  settings: Settings;
  startedAt: number;
  playlist: { key: number; offset: number }[];
  reserve: { key: number; offset: number }[];
  index: number;
  phase: GamePhase;
  scores: [string, { points: number; correct: number }][];
  participants: string[];
  history: RoundSummary[];
}

const newRound = (): Round => ({
  ready: new Set(), errors: new Set(), clipStartAt: null, seen: new Set(), guesses: new Map(),
  results: null, videoStart: 0, skipVotes: new Set(),
});

const RESERVE_SONGS = 5;

export class Room {
  readonly id: string;
  name: string;
  passwordHash: string;
  adminId: string | null;
  settings: Settings;
  readonly createdAt: number;
  lastActiveAt: number;
  readonly players = new Map<string, Player>();
  game: Game | null = null;
  poolSize = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private adminTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTouchSaved = 0;
  private readonly now: () => number;
  private readonly rng: Rng;

  constructor(private env: Env, row: RoomRow, players: PlayerRow[]) {
    this.now = env.now ?? Date.now;
    this.rng = env.rng ?? Math.random;
    this.id = row.id;
    this.name = row.name;
    this.passwordHash = row.password_hash;
    this.adminId = row.admin_id;
    this.settings = JSON.parse(row.settings_json);
    this.createdAt = row.created_at;
    this.lastActiveAt = row.last_active_at;
    for (const p of players) {
      this.players.set(p.id, {
        id: p.id, name: p.name, tokenHash: p.token_hash, joinedAt: p.joined_at, left: !!p.left,
        stats: { points: p.points, correct: p.correct, gamesPlayed: p.games_played, gamesWon: p.games_won },
        sockets: new Set(), disconnectedAt: null,
      });
    }
    this.refreshPool();
    if (row.game_json) this.restoreGame(JSON.parse(row.game_json));
  }

  // ---------------------------------------------------------------- players & connections

  get activePlayers(): Player[] {
    return [...this.players.values()].filter((p) => !p.left);
  }

  get connectedPlayers(): Player[] {
    return this.activePlayers.filter((p) => p.sockets.size > 0);
  }

  findByToken(tokenHash: string): Player | undefined {
    return [...this.players.values()].find((p) => p.tokenHash === tokenHash);
  }

  findByName(name: string): Player | undefined {
    const n = name.trim().toLowerCase();
    return [...this.players.values()].find((p) => p.name.toLowerCase() === n);
  }

  /** Adds a new player, or brings back a player who left. Caller has checked the room password. */
  addPlayer(name: string, tokenHash: string, existing?: Player): Player {
    let p = existing;
    if (p) {
      p.left = false;
      p.tokenHash = tokenHash;
      p.name = name;
    } else {
      p = {
        id: newId(), name, tokenHash, joinedAt: this.now(), left: false,
        stats: { points: 0, correct: 0, gamesPlayed: 0, gamesWon: 0 }, sockets: new Set(), disconnectedAt: null,
      };
      this.players.set(p.id, p);
    }
    this.savePlayer(p);
    if (!this.adminId || !this.players.get(this.adminId) || this.players.get(this.adminId)!.left) this.setAdmin(p.id);
    this.changed();
    return p;
  }

  attach(playerId: string, socketId: string) {
    const p = this.players.get(playerId)!;
    for (const old of p.sockets) this.env.hub.detached(old, 'replaced');
    p.sockets = new Set([socketId]);
    p.disconnectedAt = null;
    this.touch();
    const g = this.game;
    if (g?.phase === 'guessing') g.round.seen.add(p.id), g.participants.add(p.id);
    this.ensureAdmin();
    this.recheck();
    this.changed();
  }

  detach(playerId: string, socketId: string) {
    const p = this.players.get(playerId);
    if (!p || !p.sockets.delete(socketId)) return;
    if (p.sockets.size === 0) p.disconnectedAt = this.now();
    if (p.id === this.adminId && p.sockets.size === 0) this.scheduleAdminCheck();
    this.recheck();
    this.changed();
  }

  leave(playerId: string, reason: 'left' | 'kicked') {
    const p = this.players.get(playerId);
    if (!p || p.left) return;
    p.left = true;
    for (const s of p.sockets) this.env.hub.detached(s, reason);
    p.sockets.clear();
    p.disconnectedAt = this.now();
    this.savePlayer(p);
    if (this.adminId === p.id) this.ensureAdmin(true);
    this.recheck();
    this.changed();
  }

  private setAdmin(id: string | null) {
    this.adminId = id;
    this.env.store.updateRoom(this.id, { admin_id: id });
  }

  transferAdmin(byId: string, toId: string) {
    this.requireAdmin(byId);
    const to = this.players.get(toId);
    if (!to || to.left) throw new GameError('Player not found');
    this.setAdmin(toId);
    this.changed();
  }

  /** Hands admin to the longest-present connected player if the admin is gone (left, or disconnected past the grace period). */
  private ensureAdmin(immediate = false) {
    const admin = this.adminId ? this.players.get(this.adminId) : undefined;
    const gone = !admin || admin.left ||
      (admin.sockets.size === 0 && (immediate || (admin.disconnectedAt != null && this.now() - admin.disconnectedAt >= timing.adminGrace)));
    if (!gone) return;
    const candidates = this.connectedPlayers.length ? this.connectedPlayers : this.activePlayers;
    const next = candidates.sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next && next.id !== this.adminId) this.setAdmin(next.id);
    else if (!next && admin?.left) this.setAdmin(null);
  }

  private scheduleAdminCheck() {
    if (this.adminTimer) clearTimeout(this.adminTimer);
    this.adminTimer = setTimeout(() => {
      this.adminTimer = null;
      const before = this.adminId;
      this.ensureAdmin();
      if (before !== this.adminId) this.changed();
    }, timing.adminGrace + 50);
  }

  private requireAdmin(playerId: string) {
    if (playerId !== this.adminId) throw new GameError('Only the room admin can do that');
  }

  // ---------------------------------------------------------------- settings

  updateSettings(playerId: string, s: Settings) {
    this.requireAdmin(playerId);
    if (this.game && this.game.phase !== 'finished') throw new GameError('Settings are locked during a game');
    this.settings = s;
    this.env.store.updateRoom(this.id, { settings_json: JSON.stringify(s) });
    this.refreshPool();
    this.changed();
  }

  private refreshPool() {
    this.poolSize = this.env.dataset.pool(this.settings).length;
  }

  // ---------------------------------------------------------------- game lifecycle

  startGame(playerId: string) {
    this.requireAdmin(playerId);
    if (this.game && this.game.phase !== 'finished') throw new GameError('A game is already running');
    const pool = this.env.dataset.pool(this.settings);
    const played = this.settings.avoidRepeats ? this.env.store.playedSongs(this.id) : new Map<number, number>();
    const s = this.settings;
    const songs = pickSongs(pool, s.rounds + RESERVE_SONGS, played, this.rng)
      .map((song) => ({ song, offset: clipOffset(song.length, s.guessSeconds, s.revealSeconds, s.startPoint, this.rng) }));
    if (!songs.length) throw new GameError('No songs match these settings');
    const rounds = Math.min(s.rounds, songs.length);
    this.clearTimer();
    this.game = {
      id: newId(), settings: { ...s }, startedAt: this.now(),
      playlist: songs.slice(0, rounds), reserve: songs.slice(rounds),
      index: 0, phase: 'loading', phaseEndsAt: null, paused: false, pausedRemaining: null,
      scores: new Map(), participants: new Set(), history: [], round: newRound(),
    };
    this.beginRound(0);
  }

  /** Admin ends the game early: results are kept if at least one round was played. */
  endGame(playerId: string) {
    this.requireAdmin(playerId);
    const g = this.game;
    if (!g || g.phase === 'finished') throw new GameError('No game running');
    if (g.history.length) this.finish();
    else this.toLobby(playerId);
  }

  toLobby(playerId: string) {
    this.requireAdmin(playerId);
    if (this.game && this.game.phase !== 'finished' && this.game.history.length) throw new GameError('End the game first');
    this.clearTimer();
    this.game = null;
    this.saveGame();
    this.changed();
  }

  private beginRound(index: number) {
    const g = this.game!;
    this.clearTimer();
    g.index = index;
    g.phase = 'loading';
    g.phaseEndsAt = null;
    g.round = newRound();
    this.saveGame();
    this.checkLoading();
    this.changed();
  }

  /** Starts the clip once every connected player has buffered it (or reported an error), or after the load timeout. */
  private checkLoading() {
    const g = this.game;
    if (!g || g.phase !== 'loading') return;
    const conn = this.connectedPlayers;
    if (!conn.length) {
      // Nobody is here: hold the game instead of burning rounds.
      this.clearTimer();
      g.phaseEndsAt = null;
      return;
    }
    const { ready, errors } = g.round;
    if (conn.every((p) => ready.has(p.id) || errors.has(p.id))) {
      if (conn.some((p) => ready.has(p.id))) return this.startGuessing();
      return this.replaceSong();
    }
    if (!this.timer) {
      g.phaseEndsAt = this.now() + timing.loadTimeout;
      this.setTimer(timing.loadTimeout, () => {
        if (g.round.ready.size) this.startGuessing();
        else this.replaceSong();
      });
    }
  }

  private startGuessing() {
    const g = this.game!;
    this.clearTimer();
    const now = this.now();
    g.phase = 'guessing';
    g.round.clipStartAt = now + timing.leadIn;
    g.phaseEndsAt = g.round.clipStartAt + g.settings.guessSeconds * 1000;
    for (const p of this.connectedPlayers) g.round.seen.add(p.id), g.participants.add(p.id);
    this.setTimer(g.phaseEndsAt - now + timing.guessGrace, () => this.endGuessing());
    this.changed();
  }

  private endGuessing() {
    const g = this.game!;
    const r = g.round;
    const item = g.playlist[g.index];
    this.clearTimer();
    const now = this.now();
    const clipStart = r.clipStartAt ?? now;
    const guessMs = g.settings.guessSeconds * 1000;
    const heardMs = Math.max(0, Math.min(now, g.phaseEndsAt ?? now) - clipStart);
    r.videoStart = Math.round((item.offset + heardMs / 1000) * 100) / 100;

    const results: GuessResult[] = [];
    for (const p of this.activePlayers) {
      const guess = r.guesses.get(p.id);
      if (!guess && !r.seen.has(p.id)) {
        if (g.participants.has(p.id)) results.push({ playerId: p.id, name: p.name, guess: null, correct: false, points: 0, ms: null, away: true });
        continue;
      }
      const correct = !!guess && this.env.dataset.isCorrect(item.song, guess.anilistId);
      const ms = guess ? Math.max(0, guess.at - clipStart) : null;
      const bonus = correct && g.settings.speedBonus ? Math.round(MAX_SPEED_BONUS * Math.max(0, 1 - ms! / guessMs)) : 0;
      const points = correct ? BASE_POINTS + bonus : 0;
      const score = g.scores.get(p.id) ?? { points: 0, correct: 0 };
      score.points += points;
      score.correct += correct ? 1 : 0;
      g.scores.set(p.id, score);
      results.push({
        playerId: p.id, name: p.name, guess: guess ? this.titleOf(guess.anilistId) : null,
        correct, points, ms, away: false,
      });
    }
    results.sort((a, b) => b.points - a.points || (a.ms ?? Infinity) - (b.ms ?? Infinity));
    r.results = results;
    g.history.push({
      round: g.index + 1,
      title: this.titleOf(item.song.row.anilistId),
      songName: item.song.row.songName,
      songArtist: item.song.row.songArtist,
      cover: item.song.row.cover,
      correctCount: results.filter((x) => x.correct).length,
      playerCount: results.filter((x) => !x.away).length,
    });
    this.env.store.markPlayed(this.id, item.song.key, now);

    g.phase = 'reveal';
    if (g.paused) {
      g.phaseEndsAt = null;
      g.pausedRemaining = g.settings.revealSeconds * 1000;
    } else {
      g.phaseEndsAt = now + g.settings.revealSeconds * 1000;
      this.setTimer(g.settings.revealSeconds * 1000, () => this.nextRound());
    }
    this.saveGame();
    this.changed();
  }

  private nextRound() {
    const g = this.game!;
    if (g.index + 1 < g.playlist.length) this.beginRound(g.index + 1);
    else this.finish();
  }

  /** The current song can't be played: swap in a reserve song, or drop the round. */
  private replaceSong() {
    const g = this.game!;
    const replacement = g.reserve.shift();
    if (replacement) {
      g.playlist[g.index] = replacement;
      return this.beginRound(g.index);
    }
    g.playlist.splice(g.index, 1);
    if (g.index < g.playlist.length) return this.beginRound(g.index);
    if (g.history.length) return this.finish();
    this.clearTimer();
    this.game = null;
    this.saveGame();
    this.changed();
  }

  private finish() {
    const g = this.game!;
    this.clearTimer();
    g.phase = 'finished';
    g.phaseEndsAt = null;
    g.paused = false;
    const top = Math.max(0, ...[...g.participants].map((id) => g.scores.get(id)?.points ?? 0));
    const standings = [...g.participants].map((id) => ({ id, name: this.players.get(id)?.name ?? '?', ...(g.scores.get(id) ?? { points: 0, correct: 0 }) }))
      .sort((a, b) => b.points - a.points);
    this.env.store.transaction(() => {
      for (const s of standings) {
        const p = this.players.get(s.id);
        if (!p) continue;
        p.stats.points += s.points;
        p.stats.correct += s.correct;
        p.stats.gamesPlayed += 1;
        if (top > 0 && s.points === top) p.stats.gamesWon += 1;
        this.savePlayer(p);
      }
      this.env.store.insertGame({
        id: g.id, room_id: this.id, started_at: g.startedAt, ended_at: this.now(), rounds_played: g.history.length,
        settings_json: JSON.stringify(g.settings), results_json: JSON.stringify({ standings, rounds: g.history }),
      });
      this.saveGame();
    });
    this.changed();
  }

  // ---------------------------------------------------------------- player actions during a game

  reportReady(playerId: string, round: number, audio: string) {
    const g = this.game;
    if (!g || round !== g.index || g.playlist[g.index]?.song.audio !== audio) return;
    g.round.ready.add(playerId);
    g.round.errors.delete(playerId);
    this.checkLoading();
  }

  reportMediaError(playerId: string, round: number, audio: string) {
    const g = this.game;
    if (!g || round !== g.index || g.playlist[g.index]?.song.audio !== audio || g.round.ready.has(playerId)) return;
    g.round.errors.add(playerId);
    this.checkLoading();
  }

  setGuess(playerId: string, anilistId: number) {
    const g = this.game;
    if (!g || g.phase !== 'guessing') throw new GameError('Not accepting answers right now');
    if (!this.env.dataset.anime.has(anilistId)) throw new GameError('Unknown anime');
    const now = this.now();
    if (now < g.round.clipStartAt!) throw new GameError('The song hasn’t started yet');
    const cur = g.round.guesses.get(playerId);
    if (cur?.locked) throw new GameError('Your answer is locked');
    if (cur?.anilistId === anilistId) return;
    g.round.guesses.set(playerId, { anilistId, at: now, locked: false });
    g.round.seen.add(playerId);
    this.changed();
  }

  lockGuess(playerId: string) {
    const g = this.game;
    if (!g || g.phase !== 'guessing') throw new GameError('Not accepting answers right now');
    const cur = g.round.guesses.get(playerId);
    if (!cur) throw new GameError('Pick an answer first');
    cur.locked = true;
    this.checkAllLocked();
    this.changed();
  }

  private checkAllLocked() {
    const g = this.game;
    if (g?.phase !== 'guessing') return;
    const conn = this.connectedPlayers;
    if (conn.length && conn.every((p) => g.round.guesses.get(p.id)?.locked)) this.endGuessing();
  }

  voteSkip(playerId: string) {
    const g = this.game;
    if (g?.phase !== 'reveal') return;
    g.round.skipVotes.add(playerId);
    this.checkSkipVotes();
    this.changed();
  }

  private checkSkipVotes() {
    const g = this.game;
    if (g?.phase !== 'reveal' || g.paused) return;
    const conn = this.connectedPlayers;
    if (conn.length && conn.every((p) => g.round.skipVotes.has(p.id))) this.nextRound();
  }

  /** Pausing holds the game on the next reveal screen until resumed. */
  setPaused(playerId: string, paused: boolean) {
    this.requireAdmin(playerId);
    const g = this.game;
    if (!g || g.phase === 'finished') throw new GameError('No game running');
    if (g.paused === paused) return;
    g.paused = paused;
    if (g.phase === 'reveal') {
      if (paused) {
        g.pausedRemaining = Math.max(0, (g.phaseEndsAt ?? this.now()) - this.now());
        g.phaseEndsAt = null;
        this.clearTimer();
      } else {
        const ms = Math.max(3000, g.pausedRemaining ?? 0);
        g.phaseEndsAt = this.now() + ms;
        g.pausedRemaining = null;
        this.setTimer(ms, () => this.nextRound());
        this.checkSkipVotes();
      }
    }
    this.changed();
  }

  /** Admin skip: during loading/guessing replaces the song (no points); during reveal goes to the next round. */
  skipRound(playerId: string) {
    this.requireAdmin(playerId);
    const g = this.game;
    if (!g) throw new GameError('No game running');
    if (g.phase === 'reveal') {
      if (g.paused) g.paused = false;
      this.nextRound();
    } else if (g.phase === 'loading' || g.phase === 'guessing') this.replaceSong();
  }

  /** Re-evaluates waiting conditions after someone connects or drops. */
  private recheck() {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'loading') this.checkLoading();
    else if (g.phase === 'guessing') this.checkAllLocked();
    else if (g.phase === 'reveal') this.checkSkipVotes();
  }

  // ---------------------------------------------------------------- views

  view(forPlayerId: string): RoomView {
    const g = this.game;
    const inRound = g?.phase === 'guessing';
    const players: PlayerView[] = this.activePlayers.map((p) => {
      const guess = inRound ? g!.round.guesses.get(p.id) : undefined;
      const score = g?.scores.get(p.id);
      return {
        id: p.id, name: p.name, connected: p.sockets.size > 0, isAdmin: p.id === this.adminId,
        points: score?.points ?? 0, correct: score?.correct ?? 0, answered: !!guess, locked: !!guess?.locked,
      };
    });
    if (g) players.sort((a, b) => b.points - a.points);

    const leaderboard: LeaderboardEntry[] = [...this.players.values()]
      .filter((p) => p.stats.gamesPlayed > 0)
      .map((p) => ({ playerId: p.id, name: p.name, points: p.stats.points, correct: p.stats.correct, gamesPlayed: p.stats.gamesPlayed, gamesWon: p.stats.gamesWon }))
      .sort((a, b) => b.gamesWon - a.gamesWon || b.points - a.points);

    return {
      id: this.id, name: this.name, meId: forPlayerId, adminId: this.adminId, settings: this.settings, poolSize: this.poolSize,
      players, leaderboard, game: g ? this.gameView(g, forPlayerId) : null,
    };
  }

  private gameView(g: Game, me: string): GameView {
    const item = g.playlist[g.index];
    const media = (i: PlaylistItem): MediaInfo => ({ audio: i.song.audio, video: i.song.video, offset: i.offset });
    const guess = g.round.guesses.get(me);
    const next = g.phase === 'reveal' && g.index + 1 < g.playlist.length ? g.playlist[g.index + 1] : null;
    return {
      id: g.id,
      round: g.index,
      totalRounds: g.playlist.length,
      phase: g.phase,
      phaseEndsAt: g.phaseEndsAt,
      clipStartAt: g.phase === 'guessing' ? g.round.clipStartAt : null,
      clipSeconds: g.settings.guessSeconds,
      paused: g.paused,
      media: g.phase !== 'finished' && item ? media(item) : null,
      next: next ? { ...media(next), round: g.index + 1 } : null,
      myGuess: guess && g.phase !== 'finished' ? { anilistId: guess.anilistId, title: this.titleOf(guess.anilistId), locked: guess.locked } : null,
      reveal: g.phase === 'reveal' && g.round.results
        ? { answer: this.answerInfo(item.song), results: g.round.results, videoStart: g.round.videoStart, skipVotes: [...g.round.skipVotes] }
        : null,
      history: g.history,
    };
  }

  private answerInfo(song: Song): AnswerInfo {
    const r = song.row;
    return {
      anilistId: r.anilistId, title: this.titleOf(r.anilistId), romaji: r.titles.romaji, native: r.titles.native,
      cover: r.cover, format: r.format, year: r.year, songType: r.songType, songName: r.songName, songArtist: r.songArtist,
      tier: song.tier, amqDifficulty: r.songDifficulty ?? 0, alsoAccepted: song.alsoIn,
    };
  }

  private titleOf(anilistId: number): string {
    return this.env.dataset.anime.get(anilistId)?.title ?? String(anilistId);
  }

  // ---------------------------------------------------------------- persistence & timers

  private changed() {
    this.env.hub.changed(this);
  }

  touch() {
    this.lastActiveAt = this.now();
    if (this.lastActiveAt - this.lastTouchSaved > 60_000) {
      this.lastTouchSaved = this.lastActiveAt;
      this.env.store.updateRoom(this.id, { last_active_at: this.lastActiveAt });
    }
  }

  private savePlayer(p: Player) {
    this.env.store.upsertPlayer({
      id: p.id, room_id: this.id, token_hash: p.tokenHash, name: p.name, joined_at: p.joinedAt, left: p.left ? 1 : 0,
      points: p.stats.points, correct: p.stats.correct, games_played: p.stats.gamesPlayed, games_won: p.stats.gamesWon,
    });
  }

  private saveGame() {
    const g = this.game;
    let snap: GameSnapshot | null = null;
    if (g) {
      snap = {
        id: g.id, settings: g.settings, startedAt: g.startedAt, index: g.index, phase: g.phase,
        playlist: g.playlist.map((i) => ({ key: i.song.key, offset: i.offset })),
        reserve: g.reserve.map((i) => ({ key: i.song.key, offset: i.offset })),
        scores: [...g.scores], participants: [...g.participants], history: g.history,
      };
    }
    this.env.store.updateRoom(this.id, { game_json: snap && JSON.stringify(snap), last_active_at: this.now() });
  }

  /** After a restart: resume at the start of the interrupted round (or the next one if it was already revealed). */
  private restoreGame(s: GameSnapshot) {
    const byKey = new Map(this.env.dataset.songs.map((x) => [x.key, x]));
    const items = (l: { key: number; offset: number }[]) =>
      l.flatMap((i) => (byKey.has(i.key) ? [{ song: byKey.get(i.key)!, offset: i.offset }] : []));
    const playlist = items(s.playlist);
    this.game = {
      id: s.id, settings: s.settings, startedAt: s.startedAt, playlist, reserve: items(s.reserve),
      index: s.index, phase: s.phase, phaseEndsAt: null, paused: false, pausedRemaining: null,
      scores: new Map(s.scores), participants: new Set(s.participants), history: s.history, round: newRound(),
    };
    if (s.phase === 'finished') return;
    const index = s.phase === 'reveal' ? s.index + 1 : s.index;
    if (index >= playlist.length) return this.finish();
    this.game.index = index;
    this.game.phase = 'loading';
  }

  private setTimer(ms: number, fn: () => void) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, Math.max(0, ms));
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.clearTimer();
    if (this.adminTimer) clearTimeout(this.adminTimer);
  }
}
