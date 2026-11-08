// The hub with a vault (job 3b, DEV ONLY unlock): apps with "data": "hubfs" get the data socket and a fresh token
// per start (revoked on stop and crash), never HUB_DATA_DIR; an app that wants plain files shows why on its tile;
// tokens never reach logs, status or the pid file; close() closes the data API, then the store.
// TEST ONLY keys and passphrases (vault-helpers.mjs); temp folders only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { VAULT_FILES_ERROR } from '../hub/procman.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { findFreePort } from '../hub/ports.mjs';
import { Store } from '../hub/vault/store.mjs';
import { makeApps, http, GOOD_SERVER } from './helpers.mjs';
import { makeTestVault, makeVaultFolder } from './vault-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

// A hubfs app: tells the test its environment (TEST ONLY: a real app never shows its token), saves through hubfs.
const KEEPER = `
import { createServer } from 'node:http';
import * as hubfs from './lib/hubfs.mjs';
const s = createServer(async (q, r) => {
  try {
    if (q.url === '/env') return r.end(JSON.stringify({ socket: process.env.HUB_DATA_SOCKET ?? null, token: process.env.HUB_DATA_TOKEN ?? null,
      dataDir: process.env.HUB_DATA_DIR ?? null, vault: process.env.HUB_DEV_VAULT ?? null }));
    if (q.url === '/save') { const b = []; for await (const c of q) b.push(c); await hubfs.writeFile('save.txt', Buffer.concat(b)); return r.end('ok'); }
    if (q.url === '/load') return r.end(await hubfs.readFile('save.txt', 'utf8'));
    if (q.url === '/crash') { r.end('bye'); setTimeout(() => process.exit(1), 10); return; }
    r.end('keeper');
  } catch (e) { r.statusCode = 500; r.end(e.code || 'error'); }
});
s.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => s.close(() => process.exit(0)));
`;

async function setup({ vault = true } = {}) {
  const fx = await makeApps({
    keeper: { 'app.json': { id: 'keeper', name: 'Keeper', engine: 'node-server', entry: 'server.mjs', data: 'hubfs' }, 'server.mjs': KEEPER },
    plain: { 'app.json': { id: 'plain', name: 'Plain', engine: 'node-server', entry: 'server.mjs' }, 'server.mjs': GOOD_SERVER },
    page: { 'app.json': { id: 'page', name: 'Page', engine: 'static' }, 'index.html': '<p>hi</p>' },
  });
  await mkdir(join(fx.appsDir, 'keeper', 'lib'));
  await copyFile(join(ROOT, 'hub', 'appkit', 'hubfs.mjs'), join(fx.appsDir, 'keeper', 'lib', 'hubfs.mjs'));
  const vf = vault ? await makeVaultFolder() : null;
  const home = vf ? vf.home : await mkdtemp(join(tmpdir(), 'stickhub-home-'));
  const hub = await createHub({ root: fx.root, port: 0, portRange: { from: 27250, to: 27269 }, home, startTimeoutMs: 6000,
    stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 }, ...(vf ? { vault: { dir: vf.dir } } : {}) });
  const port = Number(new URL(await hub.listen()).port);
  if (vf) await hub.vault.unlock('passphrase', vf.passphrase);
  const t = vf ? { store: hub.vault.store, root: vf.root } : null;
  const call = (path, o = {}) => http(port, path, { ...o, headers: { 'x-hub-token': hub.token, ...o.headers } });
  cleanups.push(async () => { await hub.close().catch(() => {}); await fx.cleanup(); await rm(home, { recursive: true, force: true }); if (t) await rm(t.root, { recursive: true, force: true }); });
  return { fx, t, home, hub, call };
}

const env = async (v) => JSON.parse((await http(v.port, '/env')).body);
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 30)); } };

test('vault on: a hubfs app gets the socket and a fresh token per start, never HUB_DATA_DIR; tokens are revoked on stop and crash', async () => {
  const { t, home, hub, call } = await setup();
  const v1 = await hub.procman.start('keeper');
  const e1 = await env(v1);
  assert.equal(e1.socket, join(home, 'run', 'data.sock'));
  assert.match(e1.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(e1.dataDir, null, 'no HUB_DATA_DIR with the vault on');
  assert.equal(e1.vault, null, 'apps never see the vault folder');
  assert.equal((await http(v1.port, '/save', { method: 'PUT', body: 'into the vault' })).body, 'ok');
  assert.equal(await t.store.read('keeper/save.txt').then(String), 'into the vault');
  assert.equal((await http(v1.port, '/load')).body, 'into the vault');

  // the token is nowhere the hub shows or keeps
  const shown = [JSON.stringify(hub.procman.logs('keeper')), (await call('/api/status')).body, (await call('/api/apps')).body,
    (await call('/api/apps/keeper/logs')).body, await readFile(join(home, 'apps-running.json'), 'utf8').catch(() => '')].join('\n');
  assert.ok(!shown.includes(e1.token), 'token not in logs, status, app list or pid file');
  assert.equal(JSON.parse((await call('/api/status')).body).vault.on, true);
  assert.equal(JSON.parse((await http(hub.server.address().port, '/api/ping')).body).vault, true);

  const old = createHubFs({ socket: e1.socket, token: e1.token });
  await hub.procman.stop('keeper');
  await assert.rejects(old.readFile('save.txt'), { code: 'EACCES' }, 'revoked on stop');

  const v2 = await hub.procman.restart('keeper');
  const e2 = await env(v2);
  assert.notEqual(e2.token, e1.token, 'a fresh token per start');
  const live = createHubFs({ socket: e2.socket, token: e2.token });
  assert.equal(await live.readFile('save.txt', 'utf8'), 'into the vault');
  await http(v2.port, '/crash', { method: 'POST' });
  await until(() => hub.procman.view('keeper').status === 'error');
  await assert.rejects(live.readFile('save.txt'), { code: 'EACCES' }, 'revoked when the app crashed');
});

test('vault on: an app that wants plain files shows why on its tile and does not start; the others work', async () => {
  const { hub, call } = await setup();
  const plain = JSON.parse((await call('/api/apps')).body).find((a) => a.id === 'plain');
  assert.deepEqual([plain.data, plain.problems], ['files', [VAULT_FILES_ERROR]]);
  const r = await call('/api/apps/plain/start', { method: 'POST' });
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.body).error, VAULT_FILES_ERROR);
  assert.equal(hub.procman.view('plain').status, 'error');
  const page = await hub.procman.start('page'); // static, no data: unaffected
  assert.equal((await http(page.port, '/')).body, '<p>hi</p>');
  assert.deepEqual(hub.procman.view('page').problems, []);
  assert.equal((await hub.procman.start('keeper')).status, 'running');
});

test('vault off: the hub works as before (HUB_DATA_DIR, no socket, no token)', async () => {
  const { fx, hub, call } = await setup({ vault: false });
  const v = await hub.procman.start('keeper');
  const e = await env(v);
  assert.deepEqual([e.socket, e.token, e.dataDir], [null, null, join(fx.dataDir, 'keeper')]);
  await http(v.port, '/save', { method: 'PUT', body: 'plain' });
  assert.equal(await readFile(join(fx.dataDir, 'keeper', 'save.txt'), 'utf8'), 'plain');
  assert.equal((await hub.procman.start('plain')).status, 'running');
  assert.equal(JSON.parse((await call('/api/status')).body).vault.on, false);
});

test('close: apps stop, then the data API goes, then the store closes after its running step', async () => {
  const { t, home, hub } = await setup();
  await hub.procman.start('keeper');
  const sock = join(home, 'run', 'data.sock');
  assert.ok(existsSync(sock));
  const pending = t.store.write('keeper/late.txt', 'written while closing');
  await hub.close();
  await pending;
  assert.equal(existsSync(sock), false, 'socket removed');
  assert.equal(t.store.status().closed, true, 'store closed');
  assert.equal(hub.procman.view('keeper').status, 'stopped');
});

/** Run node hub/server.mjs with a dev vault; the passphrase goes on stdin (a pipe), as `open --vault` does. */
async function runHub(dir, passphrase, home) {
  const port = await findFreePort({ from: 27270, to: 27279 });
  const child = spawn(process.execPath, [join(ROOT, 'hub', 'server.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HUB_PORT: String(port), STICKHUB_HOME: home, HUB_DEV_VAULT: dir } });
  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });
  child.stdin.end(`${passphrase}\n`);
  const exit = new Promise((r) => child.once('exit', (code) => r(code)));
  return { child, port, exit, output: () => output };
}

test('node hub/server.mjs with HUB_DEV_VAULT: passphrase from stdin; wrong = exit 3; SIGTERM closes socket and store', async () => {
  const v = await makeTestVault();
  const root = await mkdtemp(join(tmpdir(), 'stickhub-devvault-'));
  const home = join(root, 'home');
  const dir = join(root, 'vault');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await (await Store.create(dir, { headerText: v.text, dk: v.dk })).close();

  const wrong = await runHub(dir, 'TEST ONLY not the passphrase', home);
  assert.equal(await wrong.exit, 3);
  assert.match(wrong.output(), /wrong passphrase/);

  const ok = await runHub(dir, v.passphrase, home);
  try {
    await until(async () => (await http(ok.port, '/api/ping').catch(() => null))?.status === 200, 15000);
    assert.equal(JSON.parse((await http(ok.port, '/api/ping')).body).vault, true);
    assert.ok(existsSync(join(home, 'run', 'data.sock')));
    assert.ok(!ok.output().includes(v.passphrase), 'the passphrase is never printed');
  } finally {
    ok.child.kill('SIGTERM');
  }
  assert.equal(await ok.exit, 0);
  assert.equal(existsSync(join(home, 'run', 'data.sock')), false);
});

test('the real sample apps with the vault on: tap-counter counts into the vault, pocket-timer needs nothing', async () => {
  const vf = await makeVaultFolder();
  const data = await mkdtemp(join(tmpdir(), 'stickhub-data-'));
  const hub = await createHub({ root: ROOT, dataDir: data, port: 0, portRange: { from: 27280, to: 27289 }, home: vf.home, startTimeoutMs: 6000,
    stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 }, vault: { dir: vf.dir } });
  cleanups.push(async () => { await hub.close().catch(() => {}); for (const d of [data, vf.root]) await rm(d, { recursive: true, force: true }); });
  await hub.listen();
  await hub.vault.unlock('passphrase', vf.passphrase);
  const t = { store: hub.vault.store };
  const tc = await hub.procman.start('tap-counter');
  for (let i = 0; i < 3; i++) await http(tc.port, '/tap', { method: 'POST' });
  assert.equal(JSON.parse(String(await t.store.read('tap-counter/count.json'))).count, 3);
  await hub.procman.restart('tap-counter');
  const again = hub.procman.view('tap-counter');
  assert.match((await http(again.port, '/')).body, /<button id="b">3<\/button>/, 'the count survives a restart');
  assert.equal(JSON.parse((await http(again.port, '/tap', { method: 'POST' })).body).count, 4);
  const pt = await hub.procman.start('pocket-timer');
  assert.match((await http(pt.port, '/')).body, /Pocket Timer/);
  assert.deepEqual(hub.procman.view('pocket-timer').problems, []);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(data), [], 'nothing written as plain files');
});
