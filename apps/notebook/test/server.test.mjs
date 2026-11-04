import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../lib/vault.mjs';
import { createHandler } from '../server.mjs';

let server, port;
before(async () => {
  const vault = await Vault.open(join(await mkdtemp(join(tmpdir(), 'notebook-srv-')), 'vault'));
  server = createServer(createHandler(vault, () => port));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

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
