// The data API under attack and under failure (design 8.1). TEST ONLY keys; temp folders; no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dapi-')); roots.push(d); return d; };

/** One raw request: {status, json, buf}. */
function req(sock, { method = 'POST', path = '/v1/stat', token, headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const r = http.request({ socketPath: sock, method, path, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
        ok({ status: res.statusCode, json, buf });
      });
    });
    r.on('error', fail);
    r.end(payload ?? undefined);
  });
}

async function setup(o = {}) {
  const t = await makeTestStore({ autoCleanupEvery: 0, guard: o.guard });
  roots.push(t.root);
  let store = t.store;
  const api = await createDataApi({ socketPath: join(tmp(), 'run', 'd.sock'), getStore: () => store, limits: o.limits });
  const token = api.issue('notebook');
  return { t, api, token, sock: api.socketPath, lock: () => { store = null; }, unlock: () => { store = t.store; },
    done: async () => { await api.close(); await t.store.close().catch(() => {}); } };
}

test('socket: run dir 0700, socket 0600, too long a path is a clear error, close removes the socket', async () => {
  const s = await setup();
  assert.equal(statSync(join(s.sock, '..')).mode & 0o777, 0o700);
  assert.equal(statSync(s.sock).mode & 0o777, 0o600);
  await s.done();
  assert.equal(existsSync(s.sock), false);
  await assert.rejects(createDataApi({ socketPath: `/tmp/${'x'.repeat(120)}/d.sock`, getStore: () => null }), { code: 'SOCKET_PATH_TOO_LONG' });
});

test('a stale socket from a crash is removed; a live one or a plain file is not', async () => {
  const sock = join(tmp(), 'run', 'd.sock');
  const child = spawn(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(sock, '..'))},{recursive:true});require('net').createServer().listen(${JSON.stringify(sock)},()=>console.log('up'))`]);
  await new Promise((r) => child.stdout.once('data', r));
  await assert.rejects(createDataApi({ socketPath: sock, getStore: () => null }), { code: 'EADDRINUSE' });
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(existsSync(sock), true, 'left behind by the crash');
  const api = await createDataApi({ socketPath: sock, getStore: () => null });
  await api.close();
  writeFileSync(sock, 'not a socket');
  await assert.rejects(createDataApi({ socketPath: sock, getStore: () => null }), { code: 'EEXIST' });
});

test('tokens: missing, wrong, malformed, revoked and replaced all get the same 401; Origin is refused', async () => {
  const s = await setup();
  const ok = await req(s.sock, { token: s.token, body: { path: 'x' } });
  assert.equal(ok.status, 404);
  const answers = [];
  answers.push(await req(s.sock, { body: { path: 'x' } }));
  answers.push(await req(s.sock, { token: 'A'.repeat(43), body: { path: 'x' } }));
  answers.push(await req(s.sock, { headers: { authorization: 'Bearer abc' }, body: { path: 'x' } }));
  answers.push(await req(s.sock, { headers: { authorization: `Basic ${s.token}` }, body: { path: 'x' } }));
  const t2 = s.api.issue('notebook'); // the old token dies
  answers.push(await req(s.sock, { token: s.token, body: { path: 'x' } }));
  s.api.revoke('notebook');
  answers.push(await req(s.sock, { token: t2, body: { path: 'x' } }));
  for (const a of answers) assert.deepEqual([a.status, a.json], [401, { code: 'UNAUTHORIZED', message: 'Not allowed.' }]);
  const t3 = s.api.issue('notebook');
  assert.equal((await req(s.sock, { token: t3, headers: { origin: 'http://127.0.0.1:8787' }, body: { path: 'x' } })).status, 403);
  for (const a of answers) assert.ok(!a.buf.toString().includes(s.token) && !a.buf.toString().includes(t2));
  await s.done();
});

test('paths: escapes refused, another app id stays inside the caller, case clash, no vault paths in answers', async () => {
  const s = await setup();
  const other = s.api.issue('other');
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a\u0000b', 'a/./b', '..', '.', '', 'x'.repeat(300), 'a//b', 'a\nb']) {
    const r = await req(s.sock, { token: s.token, body: { path: bad } });
    assert.deepEqual([r.status, r.json.code], [400, 'BAD_PATH'], JSON.stringify(bad));
  }
  const w = await req(s.sock, { method: 'PUT', path: `/v1/write?path=${encodeURIComponent('other/secret.md')}`, token: s.token, body: Buffer.from('mine') });
  assert.equal(w.status, 200);
  assert.deepEqual(s.t.store.tree('').map((e) => e.path), ['notebook', 'notebook/other', 'notebook/other/secret.md']);
  assert.deepEqual((await req(s.sock, { path: '/v1/tree', token: other, body: {} })).json, { entries: [] });
  const mine = (await req(s.sock, { path: '/v1/tree', token: s.token, body: {} })).json.entries.map((e) => e.path);
  assert.deepEqual(mine, ['other', 'other/secret.md']);
  const clash = await req(s.sock, { method: 'PUT', path: `/v1/write?path=${encodeURIComponent('other/SECRET.md')}`, token: s.token, body: Buffer.from('x') });
  assert.deepEqual([clash.status, clash.json.code], [409, 'CASE_CLASH']);
  const missing = await req(s.sock, { token: s.token, body: { path: 'nope/x.md' } });
  assert.ok(!missing.buf.toString().includes('notebook'), 'no vault path in an error');
  await s.done();
});

test('bodies: 33 MiB is 413, a stalled body is cut off, the server stays up', async () => {
  const s = await setup({ limits: { requestMs: 300 } });
  const big = await req(s.sock, { method: 'PUT', path: '/v1/write?path=big.bin', token: s.token, body: Buffer.alloc(33 * 1024 * 1024) });
  assert.deepEqual([big.status, big.json.code], [413, 'TOO_BIG']);
  const t0 = Date.now();
  await new Promise((resolve) => {
    const c = net.connect(s.sock, () => c.write(`PUT /v1/write?path=a HTTP/1.1\r\nhost: hub\r\nauthorization: Bearer ${s.token}\r\ncontent-length: 100\r\n\r\n0123456789`));
    c.on('data', () => {});
    c.on('close', resolve);
    c.on('error', resolve);
  });
  assert.ok(Date.now() - t0 < 5000, 'cut off');
  assert.equal((await req(s.sock, { token: s.token, body: { path: 'a' } })).status, 404, 'still up');
  await s.done();
});

test('40 connections at once: no crash, the server answers after', async () => {
  const s = await setup();
  const all = await Promise.allSettled(Array.from({ length: 40 }, () => req(s.sock, { token: s.token, body: { path: 'x' } })));
  assert.ok(all.filter((r) => r.status === 'fulfilled').length >= 32);
  assert.equal((await req(s.sock, { token: s.token, body: { path: 'x' } })).status, 404);
  await s.done();
});

test('locked: every route answers 423 after the token check, events too', async () => {
  const s = await setup();
  s.lock();
  const routes = [['POST', '/v1/tree', {}], ['POST', '/v1/stat', { path: 'a' }], ['POST', '/v1/read', { path: 'a' }],
    ['PUT', '/v1/write?path=a', Buffer.from('x')], ['POST', '/v1/mkdir', { path: 'd' }], ['POST', '/v1/move', { from: 'a', to: 'b' }],
    ['POST', '/v1/remove', { paths: ['a'] }], ['GET', '/v1/events?since=0', undefined]];
  for (const [method, path, body] of routes) {
    const r = await req(s.sock, { method, path, token: s.token, body });
    assert.deepEqual([r.status, r.json.code], [423, 'LOCKED'], path);
  }
  assert.equal((await req(s.sock, { body: {} })).status, 401, 'the token check comes first');
  await s.done();
});

test('store closed or unplugged mid-request: 503, the server stays up', async () => {
  let unplugged = false;
  const s = await setup({ guard: () => { if (unplugged) throw Object.assign(new Error('unplugged'), { code: 'EIO' }); } });
  const fs = createHubFs({ socket: s.sock, token: s.token });
  await fs.writeFile('a.md', 'a');
  unplugged = true;
  const w = await req(s.sock, { method: 'PUT', path: '/v1/write?path=b.md', token: s.token, body: Buffer.from('b') });
  assert.deepEqual([w.status, w.json.code], [503, 'WRITE_FAILED']);
  await assert.rejects(fs.readFile('a.md'), (e) => e.code === 'EIO' && e.hubCode === 'STORE_BROKEN');
  await s.t.store.close();
  assert.deepEqual((await req(s.sock, { token: s.token, body: { path: 'a.md' } })).json.code, 'CLOSED');
  s.lock();
  assert.equal((await req(s.sock, { token: s.token, body: { path: 'a.md' } })).status, 423, 'still up');
  await s.done();
});

test('events: order, lost when too old, a long poll wakes at once', async () => {
  const s = await setup({ limits: { events: 3 } });
  const fs = createHubFs({ socket: s.sock, token: s.token });
  const ev = async (q) => (await req(s.sock, { method: 'GET', path: `/v1/events${q}`, token: s.token })).json;
  assert.deepEqual(await ev(''), { seq: 0, lost: false, events: [] });
  const poll = ev('?since=0');
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await fs.writeFile('a.md', 'a');
  const got = await poll;
  assert.ok(Date.now() - t0 < 1000, 'woke at once');
  assert.deepEqual(got.events.map((e) => [e.seq, e.kind, e.path]), [[1, 'write', 'a.md']]);
  for (const n of ['b', 'c', 'd', 'e']) await fs.writeFile(`${n}.md`, n);
  assert.equal((await ev('?since=0')).lost, true, 'event 1 fell out of the buffer');
  assert.deepEqual((await ev('?since=3')).events.map((e) => e.path), ['d.md', 'e.md']);
  await s.done();
});

test('watch() reconnects after a hub restart and reports lost', async () => {
  const t = await makeTestStore({ autoCleanupEvery: 0 });
  roots.push(t.root);
  const sock = join(tmp(), 'run', 'd.sock');
  let api = await createDataApi({ socketPath: sock, getStore: () => t.store });
  let token = api.issue('notebook');
  const fs = createHubFs({ socket: sock, token: () => token });
  const it = fs.watch({ retryMs: 50 })[Symbol.asyncIterator]();
  const first = it.next();
  await new Promise((r) => setTimeout(r, 50));
  await fs.writeFile('a.md', 'a');
  assert.equal((await first).value.path, 'a.md');
  const next = it.next();
  await api.close();
  await new Promise((r) => setTimeout(r, 150)); // the watch retries meanwhile
  api = await createDataApi({ socketPath: sock, getStore: () => t.store });
  token = api.issue('notebook');
  assert.equal((await next).value.kind, 'lost', 'a new hub: list again');
  const after = it.next();
  await new Promise((r) => setTimeout(r, 100));
  await fs.writeFile('b.md', 'b');
  assert.equal((await after).value.path, 'b.md');
  await it.return();
  await api.close();
  await t.store.close();
});

test('the client file imports nothing outside node:', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../hub/appkit/hubfs.mjs', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.match(s, /^node:/, s);
});
