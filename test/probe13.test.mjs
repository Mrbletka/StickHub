// Probe 13 off the phone: tiny KDF settings, a 1 s auto-lock, and a fake person for the by-hand part. TEST ONLY.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Report } from '../probes/lib.mjs';
import { measureLock, byHand } from '../probes/p13-lock.mjs';
import { SMALL_KDF } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'p13t-')); roots.push(d); return d; };

test('probe 13, automatic part: opens, both apps stop, token revoked, 403 x5 then 429, auto-lock', async () => {
  const r = new Report();
  await measureLock(r, tmp(), { kdf: SMALL_KDF, autoLockSeconds: 1 });
  const t = r.toString();
  assert.match(t, /unlock with the real passphrase \(Argon2id\): opened in \d+ ms/);
  assert.match(t, /lock with 2 apps running .*: locked in \d+ ms; apps stopped: yes/);
  assert.match(t, /data token after the lock: 401: revoked \(good\)/);
  assert.match(t, /wrong passphrase x6 .*: 403, 403, 403, 403, 403, 429 \(wait 2 s\)/);
  assert.match(t, /then the right one .*: 403, 429 \(wait 4 s\)/);
  assert.match(t, /auto-lock with autoLockSeconds=1, no heartbeat: locked after [\d.]+ s \(auto\); app stopped: yes/);
});

test('probe 13, by hand: the person types the passphrase on the lock screen, the answers are recorded', async () => {
  const r = new Report();
  let shown = '';
  const answers = ['n', 'n', 'n'];
  await byHand(r, tmp(), {
    kdf: SMALL_KDF, say: (s) => { shown += s; },
    ask: async () => answers.shift(),
    // "Chrome": swap the login code for the token, then unlock with what Termux showed
    open: async (url) => {
      const u = new URL(url);
      const post = (path, body, token) => new Promise((ok) => {
        const b = Buffer.from(JSON.stringify(body));
        const q = request({ host: '127.0.0.1', port: u.port, path, method: 'POST', headers: { host: u.host, 'content-type': 'application/json',
          'content-length': b.length, ...(token ? { 'x-hub-token': token } : {}) } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => ok(JSON.parse(s))); });
        q.end(b);
      });
      const { token } = await post('/api/auth/exchange', { code: u.searchParams.get('code') });
      const pass = /\n {6}(.+)\n/.exec(shown)[1];
      setTimeout(() => post('/api/vault/unlock', { method: 'passphrase', secret: pass }, token), 50);
      return { ok: true };
    },
  });
  const t = r.toString();
  assert.match(t, /opened the vault: yes/);
  assert.match(t, /Chrome offered to save a password: no/);
  assert.match(t, /keyboard learned a word: no/);
});
