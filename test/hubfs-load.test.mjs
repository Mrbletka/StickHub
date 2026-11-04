// hubfs under load (job 3b, commit 0a): many calls at once must not overrun the hub's connection limit. The client
// keeps at most 8 requests in flight, queues the rest in order, keeps the order of changes to one path, and a
// stalled request times out instead of blocking the queue. TEST ONLY keys; temp folders only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hubfs-load-')); roots.push(d); return d; };

async function hub() {
  const t = await makeTestStore({ autoCleanupEvery: 0 });
  roots.push(t.root);
  const api = await createDataApi({ socketPath: join(tmp(), 'run', 'd.sock'), getStore: () => t.store });
  return { t, api, fs: (app) => createHubFs({ socket: api.socketPath, token: api.issue(app) }),
    done: async () => { await api.close(); await t.store.close(); } };
}

const failures = (all) => all.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

test('300 parallel writes and 300 parallel reads from one app: none fails', async () => {
  const h = await hub();
  try {
    const fs = h.fs('notebook');
    const w = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => fs.writeFile(`n/${i}.md`, `note ${i}`)));
    assert.deepEqual(failures(w), []);
    const r = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => fs.readFile(`n/${i}.md`, 'utf8')));
    assert.deepEqual(failures(r), []);
    assert.deepEqual(r.map((x) => x.value), Array.from({ length: 300 }, (_, i) => `note ${i}`));
  } finally {
    await h.done();
  }
});

test('two apps, 100 writes and 100 reads each, all at once: none fails, each stays in its folder', async () => {
  const h = await hub();
  try {
    const a = h.fs('app-a');
    const b = h.fs('app-b');
    const w = await Promise.allSettled([...Array.from({ length: 100 }, (_, i) => a.writeFile(`${i}.txt`, `a${i}`)),
      ...Array.from({ length: 100 }, (_, i) => b.writeFile(`${i}.txt`, `b${i}`))]);
    assert.deepEqual(failures(w), []);
    const r = await Promise.allSettled([...Array.from({ length: 100 }, (_, i) => a.readFile(`${i}.txt`, 'utf8')),
      ...Array.from({ length: 100 }, (_, i) => b.readFile(`${i}.txt`, 'utf8'))]);
    assert.deepEqual(failures(r), []);
    assert.equal(r[7].value, 'a7');
    assert.equal(r[107].value, 'b7');
    assert.equal(h.t.store.tree('app-a').length, 100);
  } finally {
    await h.done();
  }
});

test('changes to one path keep their order, also among many other calls', async () => {
  const h = await hub();
  try {
    const fs = h.fs('notebook');
    const ac = new AbortController();
    const seen = [];
    const it = fs.watch({ since: 0, signal: ac.signal })[Symbol.asyncIterator]();
    const first = it.next();
    await new Promise((r) => setTimeout(r, 50));
    const all = [];
    const same = []; // the changes of same.md, in call order
    for (let i = 0; i < 40; i++) {
      const w = fs.writeFile('same.md', `v${i}`);
      same.push(w.then((r) => r.id));
      all.push(w, fs.writeFile(`other/${i}.md`, 'x'));
      if (i === 20) {
        const m = fs.rename('same.md', 'moved.md').then(() => 'move');
        same.push(m);
        all.push(m, fs.writeFile('moved.md', 'after move'));
      }
    }
    await Promise.all(all);
    assert.equal(await fs.readFile('same.md', 'utf8'), 'v39', 'the last write wins');
    assert.equal(await fs.readFile('moved.md', 'utf8'), 'after move', 'written after the move');
    seen.push((await first).value);
    while (seen.length < all.length) seen.push((await it.next()).value);
    ac.abort();
    const got = seen.filter((e) => e.path === 'same.md' || e.from === 'same.md').map((e) => (e.kind === 'move' ? 'move' : e.id));
    assert.deepEqual(got, await Promise.all(same));
  } finally {
    await h.done();
  }
});

test('a big write and then a small one to the same path: the small one lands last', async () => {
  const h = await hub();
  try {
    const fs = h.fs('notebook');
    for (let round = 0; round < 3; round++) {
      const big = fs.writeFile('race.bin', Buffer.alloc(6 * 1024 * 1024, round)); // takes longer to send
      const small = fs.writeFile('race.bin', `small ${round}`);
      await Promise.all([big, small]);
      assert.equal(await fs.readFile('race.bin', 'utf8'), `small ${round}`, `round ${round}`);
    }
  } finally {
    await h.done();
  }
});

/** A fake hub on a Unix socket: counts requests in flight; reads of "stall*" never get an answer. */
async function fakeHub(delayMs = 15) {
  const sock = join(tmp(), 'f.sock');
  const st = { now: 0, max: 0, order: [] };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (b) => parts.push(b));
    req.on('end', () => {
      const path = JSON.parse(Buffer.concat(parts).toString() || '{}').path;
      if (String(path).startsWith('stall')) return; // never answers
      st.now++;
      st.max = Math.max(st.max, st.now);
      st.order.push(path);
      setTimeout(() => {
        st.now--;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path, kind: 'f', size: 1, id: 'x', mtime: 0 }));
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(sock, r));
  return { sock, st, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('at most 8 requests are in flight; the rest are served in the order they came', async () => {
  const f = await fakeHub();
  try {
    const fs = createHubFs({ socket: f.sock, token: 'TEST-ONLY' });
    const names = Array.from({ length: 60 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => fs.stat(n)));
    assert.equal(f.st.max, 8);
    assert.deepEqual(f.st.order.slice(8), names.slice(8), 'fair: first come, first served');
  } finally {
    await f.close();
  }
});

test('a stalled request times out and frees its place; the queue goes on', async () => {
  const f = await fakeHub(1);
  try {
    const fs = createHubFs({ socket: f.sock, token: 'TEST-ONLY', timeoutMs: 300 });
    const stalled = Array.from({ length: 8 }, (_, i) => fs.stat(`stall${i}`).then(() => null, (e) => e));
    const t0 = Date.now();
    const ok = await fs.stat('after');
    assert.equal(ok.path, 'after');
    const waited = Date.now() - t0;
    assert.ok(waited >= 250 && waited < 3000, `waited ${waited} ms`);
    for (const e of await Promise.all(stalled)) assert.deepEqual([e?.code, e?.hubCode], ['EIO', 'TIMEOUT']);
  } finally {
    await f.close();
  }
});
