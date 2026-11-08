// Hub API routes for the vault (design 7.2, 7.3, 7.9). They sit behind the same checks as every API route: Host,
// Origin and Sec-Fetch-Site in server.mjs, the X-Hub-Token header in api.mjs.
//   GET  /api/vault            status: {state, unlocking, retryAfter, autoLockSeconds, paperUsed, lastLock}
//   POST /api/vault/unlock     {method: 'passphrase'|'paper', secret} -> status, or {error, code, retryAfter?}
//   POST /api/vault/lock       locks (waits until done) -> status
//   POST /api/vault/heartbeat  the page is visible -> 204
// The unlock body is at most 4 KiB, read here, zeroed after parsing; a body that is not JSON gets a fixed text (the
// parser's own message can quote the body). Nothing here logs; answers never echo the secret.

import { UnlockError } from './service.mjs';

export const MAX_UNLOCK_BODY = 4096;

/** The body as a Buffer, at most max bytes (null when it is bigger). The chunks are zeroed. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) over = true;
      if (over) c.fill(0); else parts.push(c);
    });
    req.on('end', () => {
      if (over) { for (const p of parts) p.fill(0); resolve(null); return; }
      const buf = Buffer.concat(parts);
      for (const p of parts) p.fill(0);
      resolve(buf);
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('./service.mjs').VaultService} vault
 * @param {(res, status: number, body: object) => void} json
 */
export function vaultRoutes(vault, json) {
  return async function handle(req, res, path) {
    if (!path.startsWith('/api/vault')) return false;
    if (req.method === 'GET' && path === '/api/vault') { json(res, 200, vault.status()); return true; }
    if (req.method === 'POST' && path === '/api/vault/heartbeat') {
      vault.heartbeat();
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (req.method === 'POST' && path === '/api/vault/lock') {
      await vault.lock('button');
      json(res, 200, vault.status());
      return true;
    }
    if (req.method === 'POST' && path === '/api/vault/unlock') {
      const buf = await readBody(req, MAX_UNLOCK_BODY);
      if (!buf) { json(res, 413, { error: 'Too big.', code: 'TOO_BIG' }); return true; }
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch { body = null; } finally { buf.fill(0); }
      if (!body || typeof body !== 'object') { json(res, 400, { error: 'Bad request.', code: 'BAD' }); return true; }
      try {
        json(res, 200, await vault.unlock(body.method, body.secret));
      } catch (e) {
        if (!(e instanceof UnlockError)) throw e;
        json(res, e.status, { error: e.message, code: e.code, ...e.extra });
      } finally {
        body.secret = null; // best effort: strings cannot be zeroed in JavaScript
      }
      return true;
    }
    json(res, 404, { error: 'Not found' });
    return true;
  };
}
