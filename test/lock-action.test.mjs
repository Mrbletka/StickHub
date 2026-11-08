// The lock (job 4, design 7.3): its steps in order, the data API after it, no data names while locked, an unplug
// during the lock. TEST ONLY vaults (tiny KDF); temp folders only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rm, mkdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { makeApps, http } from './helpers.mjs';
import { makeVaultFolder, fakeClock } from './vault-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });
const NAME = 'Secret-Name-Kq9'; // a "note name" that must not leave the hub while locked

// A hubfs app that logs a note name and tells the test its token (TEST ONLY).
const KEEPER = `
import { createServer } from 'node:http';
import * as hubfs from './lib/hubfs.mjs';
console.log('saved notes/${NAME}.md');
createServer(async (q, r) => {
  if (q.url === '/env') return r.end(JSON.stringify({ socket: process.env.HUB_DATA_SOCKET, token: process.env.HUB_DATA_TOKEN }));
  r.end('keeper');
}).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

async function setup(o = {}) {
  const vf = await makeVaultFolder();
  const fx = await makeApps({
    keeper: { 'app.json': { id: 'keeper', name: 'Keeper', engine: 'node-server', entry: 'server.mjs', data: 'hubfs' }, 'server.mjs': KEEPER },
    page: { 'app.json': { id: 'page', name: 'Page', engine: 'static' }, 'index.html': 'hi' },
  });
  await mkdir(join(fx.appsDir, 'keeper', 'lib'));
  await copyFile(join(ROOT, 'hub', 'appkit', 'hubfs.mjs'), join(fx.appsDir, 'keeper', 'lib', 'hubfs.mjs'));
  const hub = await createHub({ root: fx.root, port: 0, portRange: { from: 27320, to: 27339 }, home: vf.home, startTimeoutMs: 6000,
    stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 }, vault: { dir: vf.dir, storeOpts: o.storeOpts, clock: o.clock } });
  const port = Number(new URL(await hub.listen()).port);
  cleanups.push(async () => { await hub.close().catch(() => {}); await fx.cleanup(); await rm(vf.root, { recursive: true, force: true }); });
  const call = (path, o2 = {}) => http(port, path, { ...o2, headers: { 'x-hub-token': hub.token, ...o2.headers } });
  await hub.vault.unlock('passphrase', vf.passphrase);
  return { vf, hub, port, call };
}

/** The event stream as a list of {name, data}. */
function events(port, token, path = '/api/events') {
  const got = [];
  let raw = '';
  let req;
  const ready = new Promise((resolve) => {
    req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, 'x-hub-token': token } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        raw += c;
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          if (name) got.push({ name, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
        }
      });
      resolve();
    });
    req.end();
  });
  return { ready, got, raw: () => raw, close: () => req.destroy() };
}

const ROUTES = [['POST', '/v1/tree', {}], ['POST', '/v1/stat', { path: 'a' }], ['POST', '/v1/read', { path: 'a' }], ['PUT', '/v1/write?path=a', 'x'],
  ['POST', '/v1/mkdir', { path: 'd' }], ['POST', '/v1/move', { from: 'a', to: 'b' }], ['POST', '/v1/remove', { paths: ['a'] }], ['GET', '/v1/events?since=0', undefined]];

/** One raw data API call: its status. */
function dataCall(sock, token, [method, path, body]) {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = request({ socketPath: sock, method, path, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-length': payload.length } : {}) } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    r.on('error', fail);
    r.end(payload ?? undefined);
  });
}

test('lock: data calls refused, the running commit lands, browser state cleared, apps stopped, tokens revoked, store closed', async () => {
  const { hub, port, call, vf } = await setup();
  const keeper = await hub.procman.start('keeper');
  await hub.procman.start('page');
  const env = JSON.parse((await http(keeper.port, '/env')).body);
  const fs = createHubFs({ socket: env.socket, token: env.token });
  await fs.writeFile('before.txt', 'saved before the lock');
  const ev = events(port, hub.token);
  await ev.ready;
  const store = hub.vault.store;
  const late = store.write('keeper/late.txt', 'queued right before the lock'); // a commit in progress
  const t0 = Date.now();
  assert.equal(JSON.parse((await call('/api/vault/lock', { method: 'POST' })).body).state, 'locked');
  const lockMs = Date.now() - t0;
  assert.deepEqual(await late, { id: (await late).id, size: 28 }, 'the commit in progress landed');
  // order: locking (423 from now on) -> clear browser state -> apps stopping -> locked
  const until = Date.now() + 3000;
  while (!ev.got.some((e) => e.name === 'status' && e.data.vault.state === 'locked') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  const names = ev.got.map((e) => (e.name === 'status' ? `vault:${e.data.vault.state}` : e.name === 'app' ? `app:${e.data.status}` : e.name));
  const i = (n) => names.indexOf(n);
  assert.ok(i('vault:locking') >= 0 && i('vault:locking') < i('clear') && i('clear') < i('app:stopping') && i('app:stopping') < i('vault:locked'), names.join(' '));
  assert.deepEqual(ev.got.find((e) => e.name === 'clear').data.map((a) => a.id).sort(), ['keeper', 'page']);
  ev.close();
  assert.equal(hub.procman.view('keeper').status, 'stopped');
  assert.equal(hub.procman.view('page').status, 'stopped');
  assert.ok(lockMs < 4000, `lock took ${lockMs} ms`);
  assert.deepEqual(hub.procman.logs('keeper'), [], 'app logs (they can hold names) are gone');
  assert.equal(store.status().closed, true, 'store closed, keys zeroed');
  assert.equal(hub.vault.store, null);
  for (const r of ROUTES) assert.equal(await dataCall(env.socket, env.token, r), 401, `old token: ${r[1]}`);
  const fresh = hub.dataApi.issue('keeper'); // a token issued now still finds the vault locked
  for (const r of ROUTES) assert.equal(await dataCall(env.socket, fresh, r), 423, `locked: ${r[1]}`);
  await assert.rejects(fs.readFile('before.txt'), { code: 'EACCES' });
  // unlock again: what was saved is there
  await hub.vault.unlock('passphrase', vf.passphrase);
  assert.equal(String(await hub.vault.store.read('keeper/late.txt')), 'queued right before the lock');
  assert.equal(String(await hub.vault.store.read('keeper/before.txt')), 'saved before the lock');
});

test('while locked, no answer and no event holds a data name; unlocked, the names show again', async () => {
  const { hub, port, call, vf } = await setup();
  await hub.procman.start('keeper');
  await new Promise((r) => setTimeout(r, 200)); // its log line arrives
  assert.ok(JSON.stringify(hub.procman.logs('keeper')).includes(NAME), 'the app logged the name while unlocked');
  const fake = { state: 'connected', name: 'Test stick', conflicts: [`notes/${NAME}.conflict-20261108-120000.md`], pending: [], code: null,
    last: { at: '2026-11-08T12:00:00Z', what: 'all', result: 'failed', errors: [`data/notes/${NAME}.md: copy failed`], newConflicts: [`notes/${NAME}.md`] },
    sync: { running: true, current: `data/notes/${NAME}.md`, done: 1, total: 2 } };
  hub.stick.status = () => fake;
  await call('/api/vault/lock', { method: 'POST' });
  const ev = events(port, hub.token, '/api/events?logs=keeper');
  await ev.ready;
  const answers = [];
  for (const p of ['/api/stick', '/api/status', '/api/apps', '/api/vault', '/api/apps/keeper/logs']) answers.push(await call(p));
  assert.equal(answers[4].status, 423, 'app logs while locked');
  answers.push(await call('/api/apps/keeper/start', { method: 'POST' }));
  assert.equal(answers[5].status, 423);
  await new Promise((r) => setTimeout(r, 100));
  ev.close();
  const text = [...answers.map((a) => a.body), ev.raw()].join('\n');
  assert.ok(!text.includes(NAME), 'no data name while locked');
  const st = JSON.parse(answers[0].body);
  assert.deepEqual([st.conflictsHidden, st.last.errorsHidden, st.conflicts, st.sync.current], [1, 1, [], '']);
  assert.ok(text.includes('Keeper'), 'app names are code: they show');
  await hub.vault.unlock('passphrase', vf.passphrase);
  assert.ok((await call('/api/stick')).body.includes(NAME), 'unlocked: the stick sheet shows its conflicts again');
});

test('the stick pulled during the lock (the folder fails): the lock still ends locked, the vault stays valid', async () => {
  let unplugged = false;
  const guard = () => { if (unplugged) throw Object.assign(new Error('unplugged'), { code: 'EIO' }); };
  const { hub, vf } = await setup({ storeOpts: { guard } });
  await hub.vault.store.write('keeper/kept.txt', 'before the pull');
  unplugged = true;
  const write = hub.vault.store.write('keeper/lost.txt', 'during the pull').then(() => 'ok', (e) => e.code);
  await hub.vault.lock('button');
  assert.equal(await write, 'WRITE_FAILED');
  assert.equal(hub.vault.state, 'locked');
  unplugged = false;
  const s = await openVaultFolder(vf.dir, (h) => unlockWithPassphrase(h, vf.passphrase), { autoCleanupEvery: 0 });
  try {
    assert.equal((await s.verify()).ok, true, 'verify OK');
    assert.equal(String(await s.read('keeper/kept.txt')), 'before the pull');
    assert.throws(() => s.stat('keeper/lost.txt'), { code: 'NOT_FOUND' }, 'the half save is not there');
  } finally {
    await s.close();
  }
});

test('auto-lock and hub stop run the same lock: apps stop, reason recorded', async () => {
  const clock = fakeClock();
  const a = await setup({ clock });
  await a.hub.procman.start('page');
  clock.advance(301_000);
  const end = Date.now() + 8000;
  while (a.hub.vault.state !== 'locked' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([a.hub.vault.state, a.hub.vault.status().lastLock.reason, a.hub.procman.view('page').status], ['locked', 'auto', 'stopped']);
  const b = await setup();
  await b.hub.procman.start('page');
  await b.hub.close();
  assert.deepEqual([b.hub.vault.state, b.hub.vault.status().lastLock.reason, b.hub.procman.view('page').status], ['locked', 'stop', 'stopped']);
});

test('the service worker never touches /api/ (vault answers are never cached)', async () => {
  const sw = await readFile(join(ROOT, 'hub', 'ui', 'sw.js'), 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)[^\n]*return;/);
});
