import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  root,
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Site-wide password. Nothing but the login page is served without it. */
  masterPassword: process.env.MASTER_PASSWORD ?? 'Guigayafuu',
  /** Folder with openings.json / anilist_top.json (written by build_dataset.py). */
  datasetDir: process.env.DATASET_DIR ?? root,
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'anime-quiz.db'),
  webDist: path.join(root, 'dist'),
  production: process.env.NODE_ENV === 'production',
  /** Set when running behind a reverse proxy (Caddy/nginx) so secure cookies and client IPs work. */
  trustProxy: process.env.TRUST_PROXY !== '0',
};

/** Game timing constants (ms). */
export const timing = {
  /** Max wait for every connected player to buffer the clip before starting anyway. */
  loadTimeout: 10_000,
  /** Delay between "everyone is ready" and the clip starting, so every client starts in sync. */
  leadIn: 1_200,
  /** Late guesses (network lag) are still accepted for this long after the deadline. */
  guessGrace: 400,
  /** How long the admin may be disconnected before admin passes to someone else. */
  adminGrace: 20_000,
  /** Rooms without activity for this long are deleted. */
  roomTtl: 14 * 24 * 3600_000,
};
