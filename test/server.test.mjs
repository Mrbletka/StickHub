import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHub } from '../hub/server.mjs';
import { isPortFree } from '../hub/ports.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApps, http, GOOD_SERVER } from './helpers.mjs';

let fx, hub, port;
/** Call the hub API with the token. */
const call = (path, o = {}) => http(port, path, { ...o, headers: { 'x-hub-token': hub.token, ...o.headers } });

before(async () => {
  fx = await makeApps({
    good: { 'app.json': { id: 'good', name: 'Good', engine: 'node-server', entry: 'server.mjs', icon: 'icon.svg' },
      'server.mjs': GOOD_SERVER, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    broken: { 'app.json': { id: 'broken', name: 'B', engine: 'static', icon: '../../x.svg' } },
  });
  hub = await createHub({ root: fx.root, port: 0, portRange: { from: 27130, to: 27140 }, home: await mkdtemp(join(tmpdir(), 'stickhub-home-')),
    stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 } });
  port = Number(new URL(await hub.listen()).port);
});
after(async () => { await hub.close(); await fx.cleanup(); });

test('UI and status', async () => {
  const ui = await call('/');
  assert.equal(ui.status, 200);
  assert.match(ui.body, /<title>StickHub<\/title>/);
  const st = JSON.parse((await call('/api/status')).body);
  assert.deepEqual(st.engines.sort(), ['node-server', 'static']);
});

test('host and origin checks', async () => {
  assert.equal((await call('/api/apps', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await call('/api/apps', { headers: { host: `localhost:${port}` } })).status, 200);
  const r = await call('/api/apps/good/start', { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  for (const site of ['cross-site', 'same-site']) {
    const s = await call('/api/apps/good/start', { method: 'POST', headers: { 'sec-fetch-site': site } });
    assert.equal(s.status, 403, site);
  }
  const nullOrigin = await call('/api/apps/good/start', { method: 'POST', headers: { origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  assert.equal(hub.procman.view('good').status, 'stopped');
});

test('list, start, logs, icon, stop via the API', async () => {
  const list = JSON.parse((await call('/api/apps')).body);
  assert.deepEqual(list.map((a) => a.id), ['broken', 'good']);
  assert.ok(list[0].problems.length > 0);
  const started = await call('/api/apps/good/start', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(started.status, 200);
  const app = JSON.parse(started.body);
  assert.equal(app.status, 'running');
  assert.equal((await http(app.port, '/')).status, 200);
  const logs = JSON.parse((await call('/api/apps/good/logs')).body);
  assert.ok(logs.some((l) => /running at/.test(l.text)));
  const icon = await call('/api/apps/good/icon');
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
  const stopped = JSON.parse((await call('/api/apps/good/stop', { method: 'POST' })).body);
  assert.equal(stopped.status, 'stopped');
  assert.equal(await isPortFree(app.port), true);
});

test('errors are JSON with a message', async () => {
  let r = await call('/api/apps/broken/start', { method: 'POST' });
  assert.equal(r.status, 500);
  assert.match(JSON.parse(r.body).error, /problems/);
  assert.equal((await call('/api/apps/ghost/start', { method: 'POST' })).status, 404);
  assert.equal((await call('/api/apps/BAD!/start', { method: 'POST' })).status, 400);
  assert.equal((await call('/api/apps/good/start')).status, 405);
  assert.equal((await call('/api/apps/broken/icon')).status, 404);
  assert.equal((await call('/api/nope')).status, 404);
});

test('SSE sends the app list first, then changes', async () => {
  const events = [];
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-hub-token': hub.token } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push([m[1], JSON.parse(m[2])]);
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
        if (events.some(([e, d]) => e === 'app' && d.status === 'running')) { req.destroy(); resolve(); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
    req.end();
    setTimeout(() => call('/api/apps/good/start', { method: 'POST' }), 100);
  });
  assert.equal(events[0][0], 'apps');
  assert.ok(events.some(([e, d]) => e === 'app' && d.status === 'starting'));
  await call('/api/apps/good/stop', { method: 'POST' });
});

test('the real hub refuses a port that is taken', async () => {
  const other = await createHub({ root: fx.root, port, home: hub.home });
  await assert.rejects(other.listen(), { code: 'EADDRINUSE' });
});

test('token: API refuses without it; a one-time code is swapped for it once', async () => {
  for (const [method, path] of [['GET', '/api/apps'], ['GET', '/api/events'], ['POST', '/api/apps/good/start'], ['POST', '/api/sync'], ['POST', '/api/auth/code']]) {
    const r = await http(port, path, { method });
    assert.equal(r.status, 401, path);
    assert.match(JSON.parse(r.body).error, /login/);
  }
  assert.equal((await http(port, '/api/apps', { headers: { 'x-hub-token': 'f'.repeat(64) } })).status, 401);
  assert.equal((await http(port, '/api/ping')).status, 200);
  assert.equal((await http(port, '/api/apps/good/icon')).status, 200, 'icons are open');

  const { code, url } = JSON.parse((await call('/api/auth/code', { method: 'POST' })).body);
  assert.match(url, new RegExp(`/\\?code=${code}$`));
  const swap = (c) => http(port, '/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code: c }), headers: { 'content-type': 'application/json' } });
  const ok = await swap(code);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).token, hub.token);
  assert.equal((await swap(code)).status, 401, 'used once only');
  assert.equal((await swap('nope')).status, 401);
  assert.ok(JSON.parse((await http(port, '/api/ping')).body).lastLoginAt);
});

test('login codes expire after about 60 s', async () => {
  const { LoginCodes } = await import('../hub/auth.mjs');
  let t = 0;
  const codes = new LoginCodes(() => t);
  const a = codes.create();
  t = 59_000;
  assert.equal(codes.consume(a), true);
  const b = codes.create();
  t += 61_000;
  assert.equal(codes.consume(b), false);
});
