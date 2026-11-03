import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHub } from '../hub/server.mjs';
import { isPortFree } from '../hub/ports.mjs';
import { makeApps, http, GOOD_SERVER } from './helpers.mjs';

let fx, hub, port;

before(async () => {
  fx = await makeApps({
    good: { 'app.json': { id: 'good', name: 'Good', engine: 'node-server', entry: 'server.mjs', icon: 'icon.svg' },
      'server.mjs': GOOD_SERVER, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    broken: { 'app.json': { id: 'broken', name: 'B', engine: 'static', icon: '../../x.svg' } },
  });
  hub = await createHub({ root: fx.root, port: 0, portRange: { from: 47130, to: 47140 } });
  port = Number(new URL(await hub.listen()).port);
});
after(async () => { await hub.close(); await fx.cleanup(); });

test('UI and status', async () => {
  const ui = await http(port, '/');
  assert.equal(ui.status, 200);
  assert.match(ui.body, /<title>StickHub<\/title>/);
  const st = JSON.parse((await http(port, '/api/status')).body);
  assert.deepEqual(st.engines.sort(), ['node-server', 'static']);
});

test('host and origin checks', async () => {
  assert.equal((await http(port, '/api/apps', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await http(port, '/api/apps', { headers: { host: `localhost:${port}` } })).status, 200);
  const r = await http(port, '/api/apps/good/start', { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(hub.procman.view('good').status, 'stopped');
});

test('list, start, logs, icon, stop via the API', async () => {
  const list = JSON.parse((await http(port, '/api/apps')).body);
  assert.deepEqual(list.map((a) => a.id), ['broken', 'good']);
  assert.ok(list[0].problems.length > 0);
  const started = await http(port, '/api/apps/good/start', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(started.status, 200);
  const app = JSON.parse(started.body);
  assert.equal(app.status, 'running');
  assert.equal((await http(app.port, '/')).status, 200);
  const logs = JSON.parse((await http(port, '/api/apps/good/logs')).body);
  assert.ok(logs.some((l) => /running at/.test(l.text)));
  const icon = await http(port, '/api/apps/good/icon');
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
  const stopped = JSON.parse((await http(port, '/api/apps/good/stop', { method: 'POST' })).body);
  assert.equal(stopped.status, 'stopped');
  assert.equal(await isPortFree(app.port), true);
});

test('errors are JSON with a message', async () => {
  let r = await http(port, '/api/apps/broken/start', { method: 'POST' });
  assert.equal(r.status, 500);
  assert.match(JSON.parse(r.body).error, /problems/);
  assert.equal((await http(port, '/api/apps/ghost/start', { method: 'POST' })).status, 404);
  assert.equal((await http(port, '/api/apps/BAD!/start', { method: 'POST' })).status, 400);
  assert.equal((await http(port, '/api/apps/good/start')).status, 405);
  assert.equal((await http(port, '/api/apps/broken/icon')).status, 404);
  assert.equal((await http(port, '/api/nope')).status, 404);
});

test('SSE sends the app list first, then changes', async () => {
  const events = [];
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
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
    setTimeout(() => http(port, '/api/apps/good/start', { method: 'POST' }), 100);
  });
  assert.equal(events[0][0], 'apps');
  assert.ok(events.some(([e, d]) => e === 'app' && d.status === 'starting'));
  await http(port, '/api/apps/good/stop', { method: 'POST' });
});

test('the real hub refuses a port that is taken', async () => {
  const other = await createHub({ root: fx.root, port });
  await assert.rejects(other.listen(), { code: 'EADDRINUSE' });
});
