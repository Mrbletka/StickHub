// The Notebook server (guards, API, page) in both modes: plain files and the hub's vault (TEST ONLY keys).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Vault } from '../lib/vault.mjs';
import { Changes } from '../lib/changes.mjs';
import { createHandler } from '../server.mjs';
import { MODES } from './modes.mjs';

for (const [mode, make] of Object.entries(MODES)) describe(mode, () => {
let server, port, m, changes;
before(async () => {
  m = await make();
  changes = new Changes(m.fs, { retryMs: 50, log: () => {} });
  changes.start();
  server = createServer(createHandler(new Vault(m.fs), () => port, changes));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  changes.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await m.done();
});

function call(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const write = (path, body, extra = {}) => call(path, { method: 'POST', body, headers: { origin: `http://127.0.0.1:${port}`, ...extra } });

test('host, origin and sec-fetch-site are checked; no CORS headers', async () => {
  assert.equal((await call('/api/list?path=', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await call('/api/create', { method: 'POST', body: { name: 'a.md', type: 'file' } })).status, 403, 'no origin');
  assert.equal((await write('/api/create', { name: 'a.md', type: 'file' }, { origin: 'http://127.0.0.1:8787' })).status, 403, 'the hub page or another app');
  assert.equal((await write('/api/create', { name: 'a.md', type: 'file' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await call('/api/list?path=', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const ok = await write('/api/create', { name: 'a.md', type: 'file' }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  const list = await call('/api/list?path=');
  assert.deepEqual(list.body.entries.map((e) => e.name), ['a.md']);
  assert.equal(list.headers['access-control-allow-origin'], undefined);
});

test('API round trip: save, conflict, errors as JSON', async () => {
  const save = (b) => call('/api/note', { method: 'PUT', body: b, headers: { origin: `http://127.0.0.1:${port}` } });
  const first = await save({ path: 'n.md', content: 'hi', base: null });
  assert.equal(first.status, 200);
  const read = await call('/api/note?path=n.md');
  assert.equal(read.body.content, 'hi');
  assert.equal((await save({ path: 'n.md', content: 'new', base: 'stale' })).status, 409);
  assert.equal((await call('/api/note?path=../x')).status, 400);
  assert.equal((await write('/api/create', { name: 'CON', type: 'file' })).body.error, '"CON" is a reserved name on Windows.');
  assert.equal((await call('/api/nope')).status, 404);
});

test('the page has a strict CSP and may be framed only by the hub', async () => {
  const page = await call('/');
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self' http:\/\/127\.0\.0\.1:8787/);
  assert.equal((await call('/../server.mjs')).status, 404);
  assert.equal((await call('/js/names.mjs')).headers['content-type'], 'text/javascript; charset=utf-8');
});

test('changes: the page learns about a change made through the data; a stale cursor means "list again"', async () => {
  const first = (await call('/api/changes')).body;
  assert.equal(first.lost, false);
  const waiting = call(`/api/changes?cursor=${encodeURIComponent(first.cursor)}`);
  await new Promise((r) => setTimeout(r, 100));
  await m.fs.writeFile('vault/from-elsewhere.md', 'hi');
  const got = (await waiting).body;
  assert.deepEqual([got.lost, got.paths], [false, ['from-elsewhere.md']]);
  assert.equal((await call('/api/changes?cursor=00000000:0')).body.lost, true);
});

if (mode === 'hub') {
  test('the hub gone: errors say so, with no socket path, vault folder or token', async () => {
    await m.api.close();
    for (const path of ['/api/list?path=', '/api/note?path=n.md', '/api/index']) {
      const r = await call(path);
      assert.equal(r.status, 503, path);
      const text = JSON.stringify(r.body);
      for (const secret of [m.api.socketPath, m.token, m.base, 'data.sock']) assert.ok(!text.includes(secret), text);
    }
  });
}
});

