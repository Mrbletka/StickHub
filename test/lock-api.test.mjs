// The vault service and its hub API (job 4, design 7.2, 7.3, 7.9), hostile cases included. TEST ONLY vaults (tiny KDF
// settings) except one real-Argon2id unlock that checks the hub keeps answering. Temp folders only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { generatePaperCode, formatPaperCode } from '../hub/vault/papercode.mjs';
import { ARGON2ID_DEFAULT } from '../hub/vault/kdf.mjs';
import { makeApps, http } from './helpers.mjs';
import { makeVaultFolder } from './vault-helpers.mjs';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });
const NO_STICK = { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 };
const MARK = 'TEST-ONLY-MARKER-qz7Kp'; // a "passphrase" that must never show up anywhere

/** A clock the test moves: timers fire on advance(). */
export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (i) => { timers.delete(i); },
    advance(ms) { now += ms; for (const [i, t] of [...timers]) if (t.at <= now) { timers.delete(i); t.fn(); } },
  };
}

async function hubWith(o = {}) {
  const vf = o.vf || await makeVaultFolder();
  const fx = await makeApps({ page: { 'app.json': { id: 'page', name: 'Page', engine: 'static' }, 'index.html': 'hi' } });
  const hub = await createHub({ root: fx.root, port: 0, portRange: { from: 27300, to: 27309 }, home: vf.home, stick: NO_STICK,
    vault: { dir: vf.dir, clock: o.clock, open: o.open } });
  const port = Number(new URL(await hub.listen()).port);
  const bodies = [];
  const call = async (path, { method = 'GET', body, headers = {}, token = hub.token } = {}) => {
    const r = await http(port, path, { method, headers: { ...(token ? { 'x-hub-token': token } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    bodies.push(r.body);
    let json = null;
    try { json = JSON.parse(r.body); } catch { json = null; } // 421 "Wrong host" is plain text
    return { ...r, json };
  };
  const unlock = (method, secret, extra = {}) => call('/api/vault/unlock', { method: 'POST', body: { method, secret }, ...extra });
  const close = async () => { await hub.close(); };
  cleanups.push(async () => { await close().catch(() => {}); await fx.cleanup(); if (!o.vf) await rm(vf.root, { recursive: true, force: true }); });
  return { vf, fx, hub, port, call, unlock, bodies, close };
}

test('no vault.json in the vault folder: no vault, no lock screen, the hub works as before', async () => {
  const vf = await makeVaultFolder();
  await rm(vf.dir, { recursive: true, force: true });
  const h = await hubWith({ vf });
  cleanups.push(() => rm(vf.root, { recursive: true, force: true }));
  assert.equal(h.hub.vault, null);
  assert.equal((await h.call('/api/status')).json.vault.on, false);
  assert.equal((await h.call('/api/vault')).status, 404);
  assert.equal((await h.call('/api/apps/page/start', { method: 'POST' })).status, 200);
});

test('the hub starts locked: no app starts (423, a clear message); the passphrase opens it', async () => {
  const h = await hubWith();
  assert.deepEqual((await h.call('/api/vault')).json, { state: 'locked', unlocking: false, retryAfter: 0, autoLockSeconds: 300, paperUsed: false, lastLock: null });
  const start = await h.call('/api/apps/page/start', { method: 'POST' });
  assert.equal(start.status, 423);
  assert.match(start.json.error, /vault is locked/);
  assert.equal(start.json.app.status, 'stopped', 'not marked as failed');
  const u = await h.unlock('passphrase', h.vf.passphrase);
  assert.deepEqual([u.status, u.json.state], [200, 'unlocked']);
  assert.equal((await h.call('/api/status')).json.vault.state, 'unlocked');
  assert.equal((await h.call('/api/apps/page/start', { method: 'POST' })).status, 200);
  assert.equal((await h.unlock('passphrase', h.vf.passphrase)).status, 409, 'open already');
  assert.equal((await h.call('/api/vault/lock', { method: 'POST' })).json.state, 'locked');
});

test('a wrong passphrase and a wrong paper code get the same answer; a paper code typo is caught first, not counted', async () => {
  const h = await hubWith();
  const a = await h.unlock('passphrase', 'TEST ONLY wrong words here');
  const b = await h.unlock('paper', formatPaperCode(generatePaperCode())); // valid check characters, another code
  assert.deepEqual([a.status, a.json], [403, { error: 'That did not open the vault.', code: 'WRONG' }]);
  assert.deepEqual([b.status, b.json], [a.status, a.json]);
  const typo = h.vf.paperCode.replace(/^(.)/, (c) => (c === 'A' ? 'B' : 'A'));
  const t = await h.unlock('paper', typo);
  assert.deepEqual([t.status, t.json.code], [400, 'TYPO']);
  assert.match(t.json.error, /typo/);
  assert.equal(h.hub.vault.limiter.failures, 2, 'the typo was not counted');
  for (const [m, s] of [['passphrase', ''], ['passphrase', '   '], ['passphrase', 42], ['nope', 'x']]) {
    assert.equal((await h.unlock(m, s)).status, 400, JSON.stringify([m, s]));
  }
  const p = await h.unlock('paper', h.vf.paperCode.toLowerCase());
  assert.deepEqual([p.status, p.json.paperUsed], [200, true], 'the paper code opens it; the lock screen will remind');
  assert.ok(existsSync(join(h.vf.home, 'vault', 'paper-used.json')));
  assert.equal(h.hub.vault.limiter.failures, 0, 'a good unlock resets the count');
});

test('rate limit: 5 free tries, then 429 with the seconds left; it survives a hub restart; a good unlock resets it', async () => {
  const clock = fakeClock();
  const vf = await makeVaultFolder();
  cleanups.push(() => rm(vf.root, { recursive: true, force: true }));
  const h = await hubWith({ vf, clock });
  for (let i = 0; i < 5; i++) assert.equal((await h.unlock('passphrase', `TEST ONLY wrong ${i}`)).status, 403);
  const wait = await h.unlock('passphrase', vf.passphrase);
  assert.deepEqual([wait.status, wait.json.code, wait.json.retryAfter], [429, 'WAIT', 2], 'even the right one waits');
  assert.equal((await h.call('/api/vault')).json.retryAfter, 2);
  clock.advance(2000);
  assert.equal((await h.unlock('passphrase', 'TEST ONLY wrong 6')).status, 403);
  assert.equal((await h.unlock('passphrase', 'x')).json.retryAfter, 4);
  await h.close();
  const again = await hubWith({ vf, clock }); // a hub restart
  assert.equal((await again.call('/api/vault')).json.retryAfter, 4, 'the count is on the disk');
  assert.equal((await again.unlock('passphrase', vf.passphrase)).status, 429);
  clock.advance(4000);
  assert.equal((await again.unlock('passphrase', vf.passphrase)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(vf.home, 'vault', 'attempts.json'), 'utf8')), { failures: 0, last: 0 });
});

/** An open() the test releases by hand, to hold an unlock "in the key derivation". */
function gatedOpen() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const opened = [];
  return { release, opened, open: async (dir, unlockFn, o) => { await gate; const s = await openVaultFolder(dir, unlockFn, o); opened.push(s); return s; } };
}

test('one unlock at a time: a second one gets 429 busy; a lock while it runs wins and the late store is closed', async () => {
  const g = gatedOpen();
  const h = await hubWith({ open: g.open });
  const first = h.unlock('passphrase', h.vf.passphrase);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.call('/api/vault')).json.unlocking, true);
  const busy = await h.unlock('passphrase', h.vf.passphrase);
  assert.deepEqual([busy.status, busy.json.code], [429, 'BUSY']);
  assert.equal((await h.call('/api/vault/lock', { method: 'POST' })).json.state, 'locked');
  assert.equal((await h.unlock('passphrase', h.vf.passphrase)).status, 429, 'still one key derivation at a time');
  g.release();
  const late = await first;
  assert.deepEqual([late.status, late.json.code], [409, 'LOCKED']);
  assert.equal(h.hub.vault.state, 'locked');
  assert.equal(h.hub.vault.store, null);
  assert.equal(g.opened[0].status().closed, true, 'the store that opened late was closed (keys zeroed)');
  assert.equal((await h.unlock('passphrase', h.vf.passphrase)).status, 200, 'a normal unlock works after');
});

test('unlock is refused across origins, without the token and with a wrong host; nothing is counted', async () => {
  const h = await hubWith();
  const tries = [
    [{ headers: { origin: 'http://evil.example' } }, 403], [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ headers: { 'sec-fetch-site': 'same-site' } }, 403], [{ token: null }, 401], [{ token: 'nope' }, 401],
    [{ headers: { host: 'evil.example' } }, 421],
  ];
  for (const [extra, status] of tries) assert.equal((await h.unlock('passphrase', 'TEST ONLY wrong', extra)).status, status, JSON.stringify(extra));
  for (const [extra, status] of [[{ token: null }, 401], [{ headers: { origin: 'http://evil.example' } }, 403]]) {
    assert.equal((await h.call('/api/vault/lock', { method: 'POST', ...extra })).status, status);
  }
  assert.equal((await h.call('/api/vault', { token: null })).status, 401);
  assert.equal(h.hub.vault.limiter.failures, 0);
  assert.equal(h.hub.vault.state, 'locked');
});

/** The hub's event stream as text. */
function stream(port, token) {
  let text = '';
  let req;
  const ready = new Promise((resolve) => {
    req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, 'x-hub-token': token } }, (res) => {
      res.on('data', (c) => { text += c; });
      resolve();
    });
    req.end();
  });
  return { ready, text: () => text, close: () => req.destroy() };
}

test('bodies over 4 KiB get 413; a body that is not JSON gets a fixed 400; no secret in logs, events, answers or files', async () => {
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { seen.push(a.map(String).join(' ')); orig[k](...a); };
  try {
    const h = await hubWith();
    const sse = stream(h.port, h.hub.token);
    await sse.ready;
    assert.equal((await h.unlock('passphrase', `${MARK}${'x'.repeat(5000)}`)).status, 413);
    const broken = await h.call('/api/vault/unlock', { method: 'POST', body: `{"method":"passphrase","secret":"${MARK}` });
    assert.deepEqual([broken.status, broken.json], [400, { error: 'Bad request.', code: 'BAD' }]);
    assert.equal((await h.unlock('passphrase', MARK)).status, 403);
    assert.equal((await h.unlock('paper', MARK)).status, 400);
    assert.equal((await h.unlock('passphrase', h.vf.passphrase)).status, 200);
    await h.call('/api/vault/lock', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 100));
    sse.close();
    const files = await Promise.all((await readdir(join(h.vf.home, 'vault'))).map((f) => readFile(join(h.vf.home, 'vault', f), 'utf8')));
    const all = [seen.join('\n'), sse.text(), h.bodies.join('\n'), ...files].join('\n');
    assert.ok(sse.text().includes('event: status'), 'the stream was read');
    for (const secret of [MARK, h.vf.passphrase, h.vf.paperCode]) assert.ok(!all.includes(secret), `found ${secret.slice(0, 12)}...`);
  } finally {
    Object.assign(console, orig);
  }
});

test('auto-lock: no heartbeat for autoLockSeconds locks; a heartbeat pushes it back (fake clock)', async () => {
  const clock = fakeClock();
  const h = await hubWith({ clock });
  await h.unlock('passphrase', h.vf.passphrase);
  clock.advance(200_000);
  assert.equal((await h.call('/api/vault/heartbeat', { method: 'POST' })).status, 204);
  clock.advance(150_000); // 350 s after the unlock, 150 s after the heartbeat
  assert.equal(h.hub.vault.state, 'unlocked');
  clock.advance(149_000);
  assert.equal(h.hub.vault.state, 'unlocked');
  clock.advance(2_000); // 301 s after the heartbeat
  const end = Date.now() + 5000;
  while (h.hub.vault.state !== 'locked' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.hub.vault.state, 'locked');
  assert.equal(h.hub.vault.status().lastLock.reason, 'auto');
  assert.equal((await h.call('/api/vault/heartbeat', { method: 'POST' })).status, 204, 'a heartbeat while locked does nothing');
});

test('Argon2id runs on the async API: the hub answers while a real unlock runs (one real key derivation)', async () => {
  const vf = await makeVaultFolder({ kdf: ARGON2ID_DEFAULT });
  cleanups.push(() => rm(vf.root, { recursive: true, force: true }));
  const h = await hubWith({ vf });
  let done = false;
  const t0 = Date.now();
  const u = h.unlock('passphrase', vf.passphrase).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  const p0 = Date.now();
  assert.equal((await h.call('/api/ping', { token: null })).status, 200);
  const pingMs = Date.now() - p0;
  const answeredDuringUnlock = !done;
  assert.equal((await u).status, 200);
  assert.ok(answeredDuringUnlock, `ping ${pingMs} ms; the unlock took ${Date.now() - t0} ms`);
});
