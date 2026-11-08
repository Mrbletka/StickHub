// Browser state on stop (design 8.5): every app answers /__hub/clear (Clear-Site-Data: "storage") and /__hub/start
// (its start id); the hub tells the open hub pages to load the clear URLs right before it stops apps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubRoutes } from '../hub/appkit/hubfs.mjs';
import { createHub } from '../hub/server.mjs';
import { CLEAR_WAIT_MS } from '../hub/api.mjs';
import { createHandler } from '../apps/notebook/server.mjs';
import { Vault } from '../apps/notebook/lib/vault.mjs';
import { createHubFs } from '../apps/notebook/lib/hubfs.mjs';
import { http } from './helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

test('hubRoutes: /__hub/clear sends Clear-Site-Data "storage", /__hub/start the start id; nothing else', async () => {
  const server = createServer((req, res) => { if (!hubRoutes(req, res, 'start-1')) { res.statusCode = 404; res.end('app'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const clear = await http(port, '/__hub/clear?x=1');
    assert.deepEqual([clear.status, clear.headers['clear-site-data'], clear.headers['cache-control']], [200, '"storage"', 'no-store']);
    assert.deepEqual(JSON.parse((await http(port, '/__hub/start')).body), { startId: 'start-1' });
    assert.equal((await http(port, '/__hub/clear', { method: 'POST' })).status, 404);
    assert.equal((await http(port, '/__hub/other')).status, 404);
    assert.equal((await http(port, '/')).headers['clear-site-data'], undefined);
  } finally {
    server.close();
  }
});

test('the Notebook answers /__hub/clear and /__hub/start (after its Host check)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-clear-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let port;
  const server = createServer(createHandler(new Vault(createHubFs({ dir, socket: '', token: '' })), () => port));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  try {
    assert.equal((await http(port, '/__hub/clear')).headers['clear-site-data'], '"storage"');
    assert.match(JSON.parse((await http(port, '/__hub/start')).body).startId, /^[\w-]{12}$/);
    assert.equal((await http(port, '/__hub/clear', { headers: { host: 'evil.example' } })).status, 421);
  } finally {
    server.close();
  }
});

/** Read the hub's event stream: returns {events: [{name, data, at}], close}. */
function events(port, token) {
  const got = [];
  let req;
  const ready = new Promise((resolve) => {
    req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, 'x-hub-token': token } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) got.push({ name, data: JSON.parse(data), at: Date.now() });
        }
      });
      resolve();
    });
    req.end();
  });
  return { ready, got, close: () => req.destroy() };
}

test('before a stop, open hub pages are told to clear the app; stopAll asks once for all; no page = no wait', async () => {
  const home = await mkdtemp(join(tmpdir(), 'stickhub-home-'));
  const data = await mkdtemp(join(tmpdir(), 'stickhub-data-'));
  const hub = await createHub({ root: ROOT, dataDir: data, port: 0, portRange: { from: 27290, to: 27299 }, home, startTimeoutMs: 6000,
    stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 } });
  cleanups.push(async () => { await hub.close().catch(() => {}); await rm(home, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
  const port = Number(new URL(await hub.listen()).port);
  const pt = await hub.procman.start('pocket-timer');
  const s1 = JSON.parse((await http(pt.port, '/__hub/start')).body).startId;
  assert.equal((await http(pt.port, '/__hub/clear')).headers['clear-site-data'], '"storage"', 'static apps too');

  let t0 = Date.now();
  await hub.procman.stop('pocket-timer');
  assert.ok(Date.now() - t0 < CLEAR_WAIT_MS, 'no hub page open: no wait');

  const ev = events(port, hub.token);
  await ev.ready;
  const again = await hub.procman.start('pocket-timer');
  assert.notEqual(JSON.parse((await http(again.port, '/__hub/start')).body).startId, s1, 'a new start id at every start');
  const tc = await hub.procman.start('tap-counter');
  assert.equal((await http(tc.port, '/__hub/clear')).headers['clear-site-data'], '"storage"');
  t0 = Date.now();
  await hub.procman.stop('tap-counter');
  assert.ok(Date.now() - t0 >= CLEAR_WAIT_MS - 20, 'waited for the page');
  const clear = ev.got.filter((e) => e.name === 'clear');
  const stopping = ev.got.find((e) => e.name === 'app' && e.data.id === 'tap-counter' && e.data.status === 'stopping');
  assert.deepEqual(clear.map((e) => e.data), [[{ id: 'tap-counter', url: tc.url }]]);
  assert.ok(clear[0].at <= stopping.at, 'the clear comes before the stop');

  await hub.procman.start('tap-counter');
  await hub.procman.stopAll();
  const all = ev.got.filter((e) => e.name === 'clear').slice(1);
  assert.equal(all.length, 1, 'one request for all apps');
  assert.deepEqual(all[0].data.map((a) => a.id).sort(), ['pocket-timer', 'tap-counter']);
  ev.close();
});
