// Access control for the hub API.
// - The token: random, per install, in ~/.stickhub/token.json (never on the stick, never in git).
//   The browser keeps it in localStorage (per origin, so app servers on other ports cannot read it) and sends it
//   as the X-Hub-Token header. No cookies: cookies on 127.0.0.1 would reach every app port too.
// - Login codes: one-time, ~60 s. The watcher and `hub login` put a code (never the token) in the URL; the hub
//   page swaps it for the token.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

export const CODE_TTL_MS = 60_000;
const MAX_CODES = 20;

/**
 * Read the token, or create it on first use (file mode 600).
 * @param {string} home  ~/.stickhub
 * @returns {Promise<string>} 64 hex characters
 */
export async function loadToken(home) {
  const file = join(home, 'token.json');
  try {
    const { token } = JSON.parse(await readFile(file, 'utf8'));
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) return token;
    console.warn('token.json is invalid: making a new token (log in again)');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify({ token, created: new Date().toISOString() }), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return token;
}

/**
 * Read the token without creating it (for the CLI and watcher). null if there is none yet.
 * @param {string} home
 */
export async function readToken(home) {
  try {
    const { token } = JSON.parse(await readFile(join(home, 'token.json'), 'utf8'));
    return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Constant-time compare of a header value with the token. */
export function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** One-time login codes, kept in memory only. */
export class LoginCodes {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.codes = new Map();
  }

  /** A new code (base64url, 128 bits), valid CODE_TTL_MS. */
  create() {
    this.#prune();
    if (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value); // drop the oldest
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, this.now() + CODE_TTL_MS);
    return code;
  }

  /** True if the code is known and fresh. It can never be used again either way. */
  consume(code) {
    this.#prune();
    if (typeof code !== 'string' || !this.codes.has(code)) return false;
    this.codes.delete(code);
    return true;
  }

  #prune() {
    const t = this.now();
    for (const [c, until] of this.codes) if (until < t) this.codes.delete(c);
  }
}
