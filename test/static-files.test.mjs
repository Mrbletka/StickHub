import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic, resolveInside, parseRange, mimeType } from '../hub/static-files.mjs';
import { http } from './helpers.mjs';

let root, server, port, spa = false;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'stickhub-static-'));
  root = join(base, 'site');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(join(root, 'sub', 'index.html'), 'sub home');
  await writeFile(join(root, 'data.bin'), Buffer.from('0123456789'));
  await writeFile(join(root, 'app.mjs'), 'export {}');
  await writeFile(join(base, 'secret.txt'), 'secret');
  server = createServer((req, res) => serveStatic(req, res, root, { spa }).catch((e) => { res.writeHead(500); res.end(e.message); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => { server.close(); await rm(join(root, '..'), { recursive: true, force: true }); });

test('resolveInside blocks traversal', () => {
  assert.equal(resolveInside('/r', '/a/b.txt'), '/r/a/b.txt');
  assert.equal(resolveInside('/r', '/../x'), null);
  assert.equal(resolveInside('/r', '/a/%2e%2e/%2e%2e/x'), null);
  assert.equal(resolveInside('/r', '/a%5c..%5cx'), null);
  assert.equal(resolveInside('/r', '/a%00'), null);
  assert.equal(resolveInside('/r', '/%E0%A4%A'), null);
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-12', 10), 'invalid');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test('MIME types', () => {
  assert.equal(mimeType('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeType('a.WASM'), 'application/wasm');
  assert.equal(mimeType('a.unknown'), 'application/octet-stream');
});

test('serves files, index.html, ranges and 304', async () => {
  let r = await http(port, '/');
  assert.equal(r.status, 200);
  assert.equal(r.body, '<h1>home</h1>');
  assert.match(r.headers['content-type'], /text\/html/);
  r = await http(port, '/sub/');
  assert.equal(r.body, 'sub home');
  r = await http(port, '/app.mjs');
  assert.match(r.headers['content-type'], /javascript/);
  r = await http(port, '/data.bin', { headers: { range: 'bytes=2-4' } });
  assert.equal(r.status, 206);
  assert.equal(r.body, '234');
  assert.equal(r.headers['content-range'], 'bytes 2-4/10');
  r = await http(port, '/data.bin', { headers: { range: 'bytes=20-' } });
  assert.equal(r.status, 416);
  const etag = (await http(port, '/data.bin')).headers.etag;
  r = await http(port, '/data.bin', { headers: { 'if-none-match': etag } });
  assert.equal(r.status, 304);
  r = await http(port, '/data.bin', { method: 'HEAD' });
  assert.equal(r.headers['content-length'], '10');
  assert.equal(r.body, '');
});

test('no traversal, 404, 405 and the SPA fallback', async () => {
  // The URL parser folds ".." away, so these become /secret.txt inside root: not found, never the real file.
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/sub/..%2f..%2fsecret.txt']) {
    const r = await http(port, p);
    assert.notEqual(r.body, 'secret', p);
    assert.ok(r.status >= 400, p);
  }
  assert.equal((await http(port, '/nope')).status, 404);
  assert.equal((await http(port, '/', { method: 'POST' })).status, 405);
  spa = true;
  const r = await http(port, '/some/route');
  assert.equal(r.body, '<h1>home</h1>');
  assert.equal((await http(port, '/missing.png')).status, 404);
  spa = false;
});
