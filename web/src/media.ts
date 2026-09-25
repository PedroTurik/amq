import type { GameView, MediaInfo } from '../../shared/types';
import { savedVolume, saveVolume, serverNow, socket } from './net';

/** AMQ serves the same file names from several mirrors; fall back through them on errors. */
const MIRRORS = ['naedist.animemusicquiz.com', 'eudist.animemusicquiz.com', 'nawdist.animemusicquiz.com'];

function mirrorUrl(url: string, attempt: number): string | null {
  if (attempt === 0) return url;
  const u = new URL(url);
  const others = MIRRORS.filter((h) => h !== u.host);
  if (attempt > others.length) return null;
  u.host = others[attempt - 1];
  return u.toString();
}

/** A 0.1 s silent WAV, used to unlock media elements inside a user gesture (iOS needs it per element). */
function silentWav(): string {
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  let bin = '';
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/** One media element plus what it's supposed to hold. */
class Slot<E extends HTMLMediaElement> {
  key: string | null = null; // the original URL (identity), even when playing from a mirror
  offset = 0;
  attempt = 0;
  failed = false;

  constructor(readonly el: E) {
    el.preload = 'auto';
    el.addEventListener('loadedmetadata', () => {
      if (this.key && Math.abs(el.currentTime - this.offset) > 0.5) el.currentTime = this.offset;
    });
    el.addEventListener('error', () => {
      if (!this.key || !el.getAttribute('src')) return;
      const next = mirrorUrl(this.key, ++this.attempt);
      if (next) {
        el.src = next;
        el.load();
      } else this.failed = true;
    });
  }

  load(url: string, offset: number) {
    if (this.key === url) {
      if (this.offset !== offset) { this.offset = offset; this.seek(offset); }
      return;
    }
    this.key = url;
    this.offset = offset;
    this.attempt = 0;
    this.failed = false;
    this.el.pause();
    this.el.src = url;
    this.el.load();
  }

  seek(t: number) {
    if (this.el.readyState >= 1) this.el.currentTime = t;
  }

  /** Buffered and positioned at the clip start. */
  get ready(): boolean {
    const el = this.el;
    return !!this.key && !this.failed && el.readyState >= 3 && !el.seeking && Math.abs(el.currentTime - this.offset) < 1;
  }

  clear() {
    this.key = null;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }
}

export interface MediaStatus {
  /** The browser refused to play until the user clicks something. */
  blocked: boolean;
  audioState: 'idle' | 'loading' | 'ready' | 'playing' | 'error';
  videoFailed: boolean;
}

/**
 * Drives playback from the server's game state. Every tick it compares what should be playing (from the
 * server clock) with what is, and corrects: so late joiners, reconnects and drift all heal themselves.
 */
export class MediaEngine {
  readonly video: HTMLVideoElement;
  readonly audio: Slot<HTMLAudioElement>[];
  private videoSlot: Slot<HTMLVideoElement>;
  private game: GameView | null = null;
  private reported = '';
  private revealKey = '';
  private audioFallbackKey = '';
  private readonly canPlayWebm: boolean;
  private listeners = new Set<(s: MediaStatus) => void>();
  status: MediaStatus = { blocked: false, audioState: 'idle', videoFailed: false };
  private volume = savedVolume();

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.className = 'reveal-video';
    this.videoSlot = new Slot(this.video);
    this.canPlayWebm = this.video.canPlayType('video/webm; codecs="vp9, opus"') !== '';
    this.audio = [new Slot(new Audio()), new Slot(new Audio())];
    this.setVolume(this.volume);
    setInterval(() => this.tick(), 200);
  }

  subscribe(fn: (s: MediaStatus) => void) {
    this.listeners.add(fn);
    fn(this.status);
    return () => { this.listeners.delete(fn); };
  }

  private setStatus(patch: Partial<MediaStatus>) {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.listeners.forEach((f) => f(next));
  }

  getVolume() { return this.volume; }

  setVolume(v: number) {
    this.volume = v;
    saveVolume(v);
    for (const s of this.audio) s.el.volume = v;
    this.video.volume = v;
  }

  /** Call from a click handler: lets audio start later without another gesture (iOS/Safari). */
  unlock() {
    const wav = silentWav();
    for (const el of [...this.audio.map((s) => s.el), this.video]) {
      if (el.getAttribute('src')) {
        el.play().then(() => el.pause()).catch(() => {});
        continue;
      }
      el.src = wav;
      el.play().then(() => { el.pause(); if (el.src === wav) el.removeAttribute('src'); }).catch(() => {});
    }
    this.setStatus({ blocked: false });
    this.tick();
  }

  update(game: GameView | null) {
    this.game = game;
    this.tick();
  }

  private slotFor(m: MediaInfo, avoid?: Slot<HTMLAudioElement>): Slot<HTMLAudioElement> {
    const have = this.audio.find((s) => s.key === m.audio);
    if (have) { have.load(m.audio, m.offset); return have; }
    const free = this.audio.find((s) => s !== avoid) ?? this.audio[0];
    free.load(m.audio, m.offset);
    return free;
  }

  private play(el: HTMLMediaElement) {
    if (!el.paused) return;
    el.play().catch((e: DOMException) => {
      if (e.name === 'NotAllowedError') this.setStatus({ blocked: true });
    });
  }

  private tick() {
    const g = this.game;
    if (!g || !g.media || g.phase === 'finished') {
      this.audio.forEach((s) => s.el.pause());
      this.video.pause();
      this.setStatus({ audioState: 'idle' });
      return;
    }
    const now = serverNow();
    const cur = this.slotFor(g.media);
    for (const s of this.audio) if (s !== cur) s.el.pause();

    if (g.phase === 'loading') {
      cur.el.pause();
      if (Math.abs(cur.el.currentTime - g.media.offset) > 1) cur.seek(g.media.offset);
      const key = `${g.round}|${g.media.audio}`;
      if (cur.ready && this.reported !== key) {
        this.reported = key;
        socket.emit('round:ready', { round: g.round, audio: g.media.audio });
      } else if (cur.failed && this.reported !== key + '!') {
        this.reported = key + '!';
        socket.emit('round:mediaError', { round: g.round, audio: g.media.audio });
      }
      this.setStatus({ audioState: cur.failed ? 'error' : cur.ready ? 'ready' : 'loading' });
      this.stopVideo();
      return;
    }

    if (g.phase === 'guessing') {
      // Buffer the video from the clip start meanwhile, so the reveal is instant.
      if (this.canPlayWebm) {
        this.videoSlot.load(g.media.video, g.media.offset);
        this.video.muted = true;
        this.video.pause();
      }
      const start = g.clipStartAt ?? Infinity;
      const expected = g.media.offset + (now - start) / 1000;
      if (now < start || expected >= g.media.offset + g.clipSeconds) {
        cur.el.pause();
        if (now < start && Math.abs(cur.el.currentTime - g.media.offset) > 0.3) cur.seek(g.media.offset);
      } else if (cur.el.readyState >= 1) {
        if (Math.abs(cur.el.currentTime - expected) > 0.35) cur.el.currentTime = expected;
        this.play(cur.el);
      }
      this.setStatus({ audioState: cur.failed ? 'error' : cur.el.paused ? 'loading' : 'playing' });
      return;
    }

    // Reveal: the video picks up exactly where the audio stopped.
    if (g.reveal) {
      const key = `${g.id}|${g.round}`;
      const fresh = this.revealKey !== key;
      this.revealKey = key;
      const videoOk = this.canPlayWebm && !this.videoSlot.failed;
      if (videoOk) {
        cur.el.pause();
        if (fresh) {
          this.videoSlot.load(g.media.video, g.reveal.videoStart);
          this.videoSlot.seek(g.reveal.videoStart);
          this.video.muted = false;
        }
        if (!this.video.ended) this.play(this.video);
      } else {
        // No video (e.g. Safari without WebM, or every mirror failed): keep the song going instead.
        this.video.pause();
        if (fresh || this.audioFallbackKey !== key) {
          this.audioFallbackKey = key;
          cur.seek(g.reveal.videoStart);
        }
        if (!cur.el.ended) this.play(cur.el);
      }
      this.setStatus({ videoFailed: !videoOk, audioState: 'idle' });
    } else cur.el.pause();
    if (g.next) this.slotFor(g.next, cur);
  }

  private stopVideo() {
    this.video.pause();
    this.revealKey = '';
    this.setStatus({ videoFailed: false });
  }
}

export const media = new MediaEngine();

// Handy when debugging playback from the browser console.
(window as unknown as { aqMedia: MediaEngine }).aqMedia = media;
