import crypto from 'node:crypto';

export const COOKIE = 'aq_auth';

/** The cookie value proves the holder knew the master password. Changing the password invalidates it. */
export function authToken(secret: string, masterPassword: string): string {
  return crypto.createHmac('sha256', secret).update(`auth:v1:${masterPassword}`).digest('base64url');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Tiny fixed-window limiter for login attempts. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now > h.reset) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    return ++h.n <= this.max;
  }
}
