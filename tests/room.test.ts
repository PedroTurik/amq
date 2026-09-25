import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timing } from '../server/config';
import { Room } from '../server/room';
import { makeRoom } from './helpers';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Room with players A (admin) and B connected. */
function setup(settings = {}) {
  const ctx = makeRoom({ settings });
  const a = ctx.room.addPlayer('Alice', 'tokA');
  const b = ctx.room.addPlayer('Bob', 'tokB');
  ctx.room.attach(a.id, 'sA');
  ctx.room.attach(b.id, 'sB');
  return { ...ctx, a, b };
}

const g = (room: Room) => room.game!;
const song = (room: Room) => g(room).playlist[g(room).index].song;
const audio = (room: Room) => song(room).audio;
const readyAll = (room: Room, ...ids: string[]) => ids.forEach((id) => room.reportReady(id, g(room).index, audio(room)));
/** Everyone ready, then wait for the lead-in so answers are accepted. */
function toGuessing(room: Room, ...ids: string[]) {
  readyAll(room, ...ids);
  expect(g(room).phase).toBe('guessing');
  vi.advanceTimersByTime(timing.leadIn);
}

describe('game flow', () => {
  it('plays a round: early end when everyone locks, scoring with speed bonus', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    expect(g(room).phase).toBe('loading');
    room.reportReady(a.id, 0, audio(room));
    expect(g(room).phase).toBe('loading'); // waits for Bob
    room.reportReady(b.id, 0, audio(room));
    expect(g(room).phase).toBe('guessing');

    expect(() => room.setGuess(a.id, song(room).row.anilistId)).toThrow(/hasn’t started/);
    vi.advanceTimersByTime(timing.leadIn + 5000);
    const answer = song(room).row.anilistId;
    room.setGuess(a.id, answer);
    room.setGuess(b.id, answer === 1 ? 3 : 1);
    room.lockGuess(a.id);
    expect(g(room).phase).toBe('guessing');
    room.lockGuess(b.id);
    expect(g(room).phase).toBe('reveal');

    const view = room.view(a.id);
    const res = view.game!.reveal!.results;
    const ra = res.find((r) => r.playerId === a.id)!;
    expect(ra.correct).toBe(true);
    expect(ra.points).toBe(100 + Math.round(50 * (1 - 5000 / 20000)));
    expect(res.find((r) => r.playerId === b.id)!.points).toBe(0);
    expect(view.game!.reveal!.videoStart).toBeCloseTo(g(room).playlist[0].offset + 5, 1);
    expect(view.game!.next?.round).toBe(1);
  });

  it('accepts any entry of the same franchise, and hides other players’ guesses during guessing', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    // Force anime 2 (franchise 2) as the current song.
    const two = room['env'].dataset.songs.find((s) => s.row.anilistId === 2)!;
    g(room).playlist[0] = { song: two, offset: 0 };
    toGuessing(room, a.id, b.id);
    room.setGuess(a.id, 900); // "Anime 2 Season 2"
    expect(room.view(b.id).players.find((p) => p.id === a.id)!.answered).toBe(true);
    expect(room.view(b.id).game!.myGuess).toBeNull();
    vi.advanceTimersByTime(20_000 + timing.guessGrace);
    expect(g(room).phase).toBe('reveal');
    expect(g(room).round.results!.find((r) => r.playerId === a.id)!.correct).toBe(true);
    // Unlocked answers still count when time runs out.
    expect(g(room).scores.get(a.id)!.points).toBeGreaterThanOrEqual(100);
  });

  it('runs all rounds, finishes and records the room leaderboard', () => {
    const { room, a, b } = setup({ rounds: 2 });
    room.startGame(a.id);
    for (let i = 0; i < 2; i++) {
      toGuessing(room, a.id, b.id);
      room.setGuess(a.id, song(room).row.anilistId);
      vi.advanceTimersByTime(20_000 + timing.guessGrace);
      expect(g(room).phase).toBe('reveal');
      room.voteSkip(a.id);
      room.voteSkip(b.id);
    }
    expect(g(room).phase).toBe('finished');
    const lb = room.view(a.id).leaderboard;
    expect(lb[0]).toMatchObject({ playerId: a.id, gamesWon: 1, gamesPlayed: 1, correct: 2 });
    expect(lb[1]).toMatchObject({ playerId: b.id, gamesWon: 0, gamesPlayed: 1, points: 0 });
    room.toLobby(a.id);
    expect(room.game).toBeNull();
  });
});

describe('connections', () => {
  it('does not wait for disconnected players, and keeps their points when they come back', () => {
    const { room, a, b } = setup({ rounds: 2 });
    room.startGame(a.id);
    toGuessing(room, a.id, b.id);
    room.setGuess(b.id, song(room).row.anilistId);
    room.lockGuess(b.id);
    room.detach(a.id, 'sA'); // Alice drops: the round ends because the only connected player locked
    expect(g(room).phase).toBe('reveal');
    const bobPoints = g(room).scores.get(b.id)!.points;
    expect(bobPoints).toBeGreaterThan(100);

    room.voteSkip(b.id); // only Bob is connected, so his vote is enough
    expect(g(room).phase).toBe('loading');
    room.reportReady(b.id, 1, audio(room)); // loading doesn't wait for Alice
    expect(g(room).phase).toBe('guessing');

    room.detach(b.id, 'sB');
    room.attach(b.id, 'sB2'); // Bob reconnects mid-round
    expect(room.view(b.id).players.find((p) => p.id === b.id)!.points).toBe(bobPoints);
  });

  it('marks players who were away for a whole round', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    toGuessing(room, a.id, b.id);
    vi.advanceTimersByTime(20_000 + timing.guessGrace);
    room.voteSkip(a.id);
    room.detach(b.id, 'sB');
    room.voteSkip(a.id);
    expect(g(room).phase).toBe('loading');
    toGuessing(room, a.id);
    vi.advanceTimersByTime(20_000 + timing.guessGrace);
    expect(g(room).round.results!.find((r) => r.playerId === b.id)!.away).toBe(true);
  });

  it('starts after the load timeout even if someone is still buffering', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    room.reportReady(a.id, 0, audio(room));
    vi.advanceTimersByTime(timing.loadTimeout - 1);
    expect(g(room).phase).toBe('loading');
    vi.advanceTimersByTime(1);
    expect(g(room).phase).toBe('guessing');
    void b;
  });

  it('holds the game while nobody is connected', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    room.detach(a.id, 'sA');
    room.detach(b.id, 'sB');
    vi.advanceTimersByTime(60_000);
    expect(g(room).phase).toBe('loading');
    expect(g(room).phaseEndsAt).toBeNull();
    room.attach(b.id, 'sB2');
    room.reportReady(b.id, 0, audio(room));
    expect(g(room).phase).toBe('guessing');
  });

  it('replaces a song that fails to load for everyone', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    const first = song(room).key;
    room.reportMediaError(a.id, 0, audio(room));
    room.reportMediaError(b.id, 0, audio(room));
    expect(g(room).phase).toBe('loading');
    expect(song(room).key).not.toBe(first);
    expect(g(room).playlist.length).toBe(3);
  });

  it('a newer connection for the same player replaces the old one', () => {
    const { room, a, hub } = setup();
    room.attach(a.id, 'sA-tab2');
    expect(hub.detachedLog).toContainEqual(['sA', 'replaced']);
    room.detach(a.id, 'sA'); // late disconnect of the old socket is ignored
    expect(room.view(a.id).players.find((p) => p.id === a.id)!.connected).toBe(true);
  });
});

describe('admin', () => {
  it('passes admin on after the grace period, and immediately when the admin leaves', () => {
    const { room, a, b } = setup();
    expect(room.adminId).toBe(a.id);
    room.detach(a.id, 'sA');
    vi.advanceTimersByTime(timing.adminGrace - 1000);
    expect(room.adminId).toBe(a.id);
    vi.advanceTimersByTime(2000);
    expect(room.adminId).toBe(b.id);

    room.attach(a.id, 'sA2');
    room.leave(b.id, 'left');
    expect(room.adminId).toBe(a.id);
  });

  it('only the admin controls the game', () => {
    const { room, b } = setup();
    expect(() => room.startGame(b.id)).toThrow(/admin/);
  });

  it('pause holds the reveal until resumed', () => {
    const { room, a, b } = setup();
    room.startGame(a.id);
    toGuessing(room, a.id, b.id);
    room.setPaused(a.id, true);
    vi.advanceTimersByTime(20_000 + timing.guessGrace);
    expect(g(room).phase).toBe('reveal');
    vi.advanceTimersByTime(120_000);
    expect(g(room).phase).toBe('reveal');
    room.setPaused(a.id, false);
    vi.advanceTimersByTime(15_000);
    expect(g(room).phase).toBe('loading');
  });
});

describe('persistence', () => {
  it('a game survives a server restart and resumes with scores', () => {
    const { room, a, b, store, dataset, hub } = setup({ rounds: 3 });
    room.startGame(a.id);
    toGuessing(room, a.id, b.id);
    room.setGuess(a.id, song(room).row.anilistId);
    vi.advanceTimersByTime(20_000 + timing.guessGrace);
    const points = g(room).scores.get(a.id)!.points;
    room.dispose();

    const { room: again } = makeRoom({ store, dataset, hub });
    expect(again.game!.phase).toBe('loading');
    expect(again.game!.index).toBe(1);
    expect(again.game!.scores.get(a.id)!.points).toBe(points);
    expect(again.view(a.id).players.every((p) => !p.connected)).toBe(true);
    again.attach(a.id, 'x');
    again.reportReady(a.id, 1, again.game!.playlist[1].song.audio);
    expect(again.game!.phase).toBe('guessing');
  });
});
