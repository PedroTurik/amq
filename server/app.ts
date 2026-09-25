import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { Server } from 'socket.io';
import { COOKIE, RateLimiter, authToken, readCookie, safeEqual } from './auth';
import type { Dataset } from './dataset';
import type { Store } from './db';
import { RoomManager } from './rooms';
import type { ClientToServer, ServerToClient } from '../shared/types';

export interface AppOptions {
  store: Store;
  dataset: Dataset;
  masterPassword: string;
  trustProxy: boolean;
  /** Built web client to serve (production). Omit when Vite serves the client (dev, tests). */
  webDist?: string;
}

const LOGIN_HTML = fs.readFileSync(new URL('./login.html', import.meta.url), 'utf8');

export function createApp(opts: AppOptions) {
  const { store, dataset } = opts;
  const token = authToken(store.secret(), opts.masterPassword);
  const isAuthed = (cookieHeader: string | undefined) => {
    const c = readCookie(cookieHeader, COOKIE);
    return !!c && safeEqual(c, token);
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ? 1 : false);
  app.use(express.json({ limit: '16kb' }));

  app.get('/healthz', (_req, res) => res.send('ok'));

  const limiter = new RateLimiter(10, 60_000);
  app.post('/api/login', (req, res) => {
    if (!limiter.allow(req.ip ?? '?')) return res.status(429).json({ ok: false, error: 'Too many attempts, wait a minute' });
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(pw, opts.masterPassword)) return res.status(401).json({ ok: false, error: 'Wrong password' });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 24 * 3600_000, path: '/' });
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Everything below requires the master password.
  app.use((req, res, next) => {
    if (isAuthed(req.headers.cookie)) return next();
    if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.status(401).type('html').set('Cache-Control', 'no-store').send(LOGIN_HTML);
  });

  app.get('/api/me', (_req, res) => res.json({ ok: true }));

  // Autocomplete data (~250 KB gzipped): precomputed once, cached by ETag.
  const titlesJson = Buffer.from(JSON.stringify(dataset.titles));
  const titlesGz = zlib.gzipSync(titlesJson, { level: 9 });
  const titlesEtag = `"${crypto.createHash('sha1').update(titlesJson).digest('hex').slice(0, 16)}"`;
  app.get('/api/titles', (req, res) => {
    res.set({ ETag: titlesEtag, 'Cache-Control': 'private, no-cache', 'Content-Type': 'application/json', Vary: 'Accept-Encoding' });
    if (req.headers['if-none-match'] === titlesEtag) return res.status(304).end();
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return res.set('Content-Encoding', 'gzip').send(titlesGz);
    res.send(titlesJson);
  });

  const manager = new RoomManager(store, dataset);
  app.get('/api/rooms', (_req, res) => res.json(manager.list()));

  if (opts.webDist && fs.existsSync(opts.webDist)) {
    const index = path.join(opts.webDist, 'index.html');
    app.use('/assets', express.static(path.join(opts.webDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(opts.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(index));
  }

  const server = http.createServer(app);
  const io = new Server<ClientToServer, ServerToClient>(server, {
    // Fast disconnect detection: a dropped player is excluded from the round within ~10 s.
    pingInterval: 5_000,
    pingTimeout: 5_000,
    maxHttpBufferSize: 64 * 1024,
    allowRequest: (req, cb) => cb(null, isAuthed(req.headers.cookie)),
  });
  manager.attach(io);

  const cleanup = setInterval(() => manager.cleanup(), 3600_000);
  cleanup.unref();

  return { app, server, io, manager };
}
