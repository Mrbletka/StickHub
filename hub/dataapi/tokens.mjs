// Per-app tokens for the data API: 32 random bytes, base64url, one app each. Compared with timingSafeEqual.
// A token never leaves this module except as the return value of issue().

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_ID_RE } from './paths.mjs';

export class Tokens {
  #byApp = new Map();

  /** A new token for an app; the app's old token stops working. @returns {string} */
  issue(appId) {
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) throw new TypeError('issue: bad app id');
    const t = randomBytes(32);
    this.#byApp.set(appId, t);
    return t.toString('base64url');
  }

  revoke(appId) { this.#byApp.delete(appId); }

  /** The app id for an Authorization header, or null (missing, malformed, wrong or revoked: all the same). */
  appFor(header) {
    const m = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null;
    if (!m) return null;
    const b = Buffer.from(m[1], 'base64url');
    if (b.length !== 32) return null;
    let found = null;
    for (const [id, t] of this.#byApp) if (timingSafeEqual(t, b)) found = id; // no early exit
    return found;
  }

  clear() { this.#byApp.clear(); }
}
