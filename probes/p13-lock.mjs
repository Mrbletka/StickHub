// Probe 13: the lock screen on the phone (job 4). A throwaway hub runs inside the probe, in the probe's own temp
// folder (its home, token, attempts.json, data socket and vault; the repo's apps), on a random port: the real hub,
// the real vault and ~/.stickhub/run are never touched. The vault has the real Argon2id (256 MiB) unless a test
// passes smaller settings. Measured: unlock time (and how the hub answers meanwhile), lock time with two apps
// running, auto-lock with autoLockSeconds = 10, the wrong-passphrase rate limit, tokens revoked after the lock.
// Then a by-hand check (design 7.9, 12 item 1): Chrome must not offer to save the passphrase, and the keyboard must
// not suggest or learn its words. Only the probe's own temp folder is removed.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { generatePassphrase } from '../hub/vault/words.mjs';
import { newDataKey, newId } from '../hub/vault/keys.mjs';
import { makePassphraseSlot, makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader } from '../hub/vault/header.mjs';
import { Store } from '../hub/vault/store.mjs';
import { createHub } from '../hub/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_STICK = { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 };
const ms = (t) => Math.round(performance.now() - t);
const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** One HTTP call to the probe hub: {status, json}. */
function call(port, path, { method = 'GET', body, token } = {}) {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-hub-token': token } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { json = null; } ok({ status: res.statusCode, json }); });
    });
    r.on('error', fail);
    r.end(payload ?? undefined);
  });
}

/** A throwaway vault in <home>/vault-dev with a generated passphrase. TEST ONLY: random keys, nothing real. */
async function makeVault(home, kdf) {
  const passphrase = generatePassphrase();
  const dk = newDataKey();
  const vaultId = newId();
  const ps = await makePassphraseSlot({ dk, vaultId, epoch: 1, passphrase, kdf });
  const { slot: rs } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
  await (await Store.create(join(home, 'vault-dev'), { headerText: buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [ps, rs] }, dk), dk })).close();
  dk.fill(0);
  return passphrase;
}

/** A probe hub on a random port in its own home. */
async function startHub(base, name, o) {
  const home = join(base, name);
  const passphrase = await makeVault(home, o.kdf);
  const hub = await createHub({ root: ROOT, home, dataDir: join(base, `${name}-data`), port: 0, portRange: { from: 24300, to: 24349 },
    stick: NO_STICK, startTimeoutMs: 15_000, autoLockSeconds: o.autoLockSeconds ?? 300 });
  const port = Number(new URL(await hub.listen()).port);
  const issued = []; // the tokens the hub gives the apps, to check they die with the lock (probe only)
  const issue = hub.dataApi.issue;
  hub.dataApi.issue = (id) => { const t = issue(id); issued.push(t); return t; };
  return { hub, port, home, passphrase, issued, api: (path, x = {}) => call(port, path, { ...x, token: hub.token }) };
}

/**
 * The automatic part.
 * @param {import('./lib.mjs').Report} r
 * @param {{kdf?: object, autoLockSeconds?: number}} [o]  tests only: tiny KDF settings, a shorter auto-lock
 */
export async function measureLock(r, base, o = {}) {
  const a = await startHub(base, 'p13a', o);
  try {
    // unlock, and how fast the hub answers meanwhile (Argon2id runs on Node's async API)
    const pings = [];
    let done = false;
    const t0 = performance.now();
    const u = a.api('/api/vault/unlock', { method: 'POST', body: { method: 'passphrase', secret: a.passphrase } }).finally(() => { done = true; });
    while (!done) { const p = performance.now(); await call(a.port, '/api/ping'); pings.push(ms(p)); await sleep(50); }
    const res = await u;
    r.add('unlock with the real passphrase (Argon2id)', `${res.json?.state === 'unlocked' ? 'opened' : `NOT opened (${res.status})`} in ${ms(t0)} ms`);
    r.add('the hub answering during the unlock (ping)', `${pings.length} pings, slowest ${Math.max(...pings)} ms`);
    // two apps, then lock
    await a.hub.procman.start('tap-counter');
    await a.hub.procman.start('pocket-timer');
    const fs = createHubFs({ socket: a.hub.dataApi.socketPath, token: a.issued.at(-1) });
    await fs.writeFile('probe.txt', 'p13');
    const t1 = performance.now();
    const l = await a.api('/api/vault/lock', { method: 'POST' });
    const stopped = ['tap-counter', 'pocket-timer'].every((id) => a.hub.procman.view(id).status === 'stopped');
    r.add('lock with 2 apps running (no hub page open: no 400 ms clear wait)', `${l.json?.state} in ${ms(t1)} ms; apps stopped: ${stopped ? 'yes' : 'NO'}`);
    const after = await fs.readFile('probe.txt').then(() => 'STILL WORKS (bad)', (e) => (e.code === 'EACCES' ? '401: revoked (good)' : `${e.code}`));
    r.add('the app\'s data token after the lock', after);
    // rate limit: 5 free, then waits (each wrong try is a real key derivation)
    const answers = [];
    for (let i = 0; i < 6; i++) {
      const w = await a.api('/api/vault/unlock', { method: 'POST', body: { method: 'passphrase', secret: `probe wrong ${i}` } });
      answers.push(w.status === 429 ? `429 (wait ${w.json.retryAfter} s)` : String(w.status));
    }
    await sleep(2100);
    const seventh = await a.api('/api/vault/unlock', { method: 'POST', body: { method: 'passphrase', secret: 'probe wrong 7' } });
    const eighth = await a.api('/api/vault/unlock', { method: 'POST', body: { method: 'passphrase', secret: a.passphrase } });
    r.add('wrong passphrase x6 (want 403 x5, then 429 wait 2 s)', answers.join(', '));
    r.add('after 2 s: one more wrong, then the right one (want 403, then 429 wait 4 s)', `${seventh.status}, ${eighth.status}${eighth.json?.retryAfter ? ` (wait ${eighth.json.retryAfter} s)` : ''}`);
  } finally {
    await a.hub.close();
  }
  // auto-lock: no heartbeat at all
  const secs = o.autoLockSeconds ?? 10;
  const b = await startHub(base, 'p13b', { ...o, autoLockSeconds: secs });
  try {
    await b.api('/api/vault/unlock', { method: 'POST', body: { method: 'passphrase', secret: b.passphrase } });
    await b.hub.procman.start('pocket-timer');
    const t2 = performance.now();
    while (b.hub.vault.state !== 'locked' && performance.now() - t2 < (secs + 20) * 1000) await sleep(100);
    r.add(`auto-lock with autoLockSeconds=${secs}, no heartbeat`, b.hub.vault.state === 'locked'
      ? `locked after ${(ms(t2) / 1000).toFixed(1)} s (${b.hub.vault.status().lastLock?.reason}); app stopped: ${b.hub.procman.view('pocket-timer').status === 'stopped' ? 'yes' : 'NO'}`
      : `NOT locked after ${secs + 20} s`);
  } finally {
    await b.hub.close();
  }
}

/**
 * The by-hand part (design 7.9 and 12 item 1): the real lock screen of a probe hub in Chrome.
 * @param {{open: (url: string) => Promise<{ok: boolean, error?: string}>, ask: (q: string) => Promise<string>,
 *   say?: (s: string) => void, kdf?: object, waitMs?: number}} o
 */
export async function byHand(r, base, o) {
  const say = o.say || console.log;
  const c = await startHub(base, 'p13c', o);
  try {
    say(['', '>>> Chrome opens a StickHub lock screen (a throwaway test vault). Type this passphrase there and tap Unlock:',
      '', `      ${c.passphrase}`, '', '    Watch for a "Save password?" offer and for word suggestions above the keyboard. Then come back.'].join('\n'));
    const opened = await o.open(`http://127.0.0.1:${c.port}/?code=${c.hub.codes.create()}`);
    if (!opened.ok) { r.add('by hand: the lock screen', `could not open it (${opened.error}); not checked`); return; }
    const t0 = Date.now();
    while (c.hub.vault.state !== 'unlocked' && Date.now() - t0 < (o.waitMs ?? 180_000)) await sleep(250);
    r.add('by hand: the passphrase typed on the lock screen opened the vault', c.hub.vault.state === 'unlocked' ? 'yes' : 'NO (not within 3 min)');
    const yn = async (q) => ({ y: 'yes', n: 'no' }[(await o.ask(`${q} (y/n)`)).slice(0, 1)] || 'no answer');
    r.add('by hand: Chrome offered to save a password', await yn('Did Chrome offer to save a password ("Save password?" bar or box)?'));
    r.add('by hand: word suggestions above the keyboard while typing', await yn('While you typed, did the keyboard show word suggestions above the keys?'));
    const w = c.passphrase.split(' ')[0];
    r.add('by hand: the keyboard learned a word', await yn(`Open Chrome's address bar and type "${w.slice(0, 3)}". Does the keyboard suggest "${w}"?`));
  } finally {
    await c.hub.close();
  }
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{ask: Function, open: Function}} io
 */
export async function run13(r, io) {
  r.section('13. The lock screen: unlock and lock times, auto-lock, rate limit, tokens; field checks by hand');
  const base = mkdtempSync(join(tmpdir(), 'p13-'));
  try {
    await measureLock(r, base);
    if (!process.stdin.isTTY) r.add('by hand', 'skipped (no terminal to answer on)');
    else await byHand(r, base, io);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
