// Fixes C1-C4 (job 2, part 2): index files must not pile up (short sessions, a damaged index), the NEEDS_REPAIR
// guard, paths like "__proto__", identical writes, and the bounded folder listing. TEST ONLY keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { createVfs } from '../hub/vault/vfs.mjs';
import { vxFileName } from '../hub/vault/vx.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh(o) { const t = await makeTestStore(o); roots.push(t.root); return t; }
const open = (t, o) => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase), o);
const indexFiles = (t) => readdirSync(join(t.dir, '_index')).length;
const packFiles = (t) => readdirSync(join(t.dir, '_packs'));

test('40 short sessions of 10 saves: never more than 20 index files at an open', async () => {
  const t = await fresh();
  await t.store.close();
  let most = 0;
  for (let session = 0; session < 40; session++) {
    most = Math.max(most, indexFiles(t));
    const s = await open(t);
    for (let i = 0; i < 10; i++) await s.write(`n/s${session}.md`, `session ${session} save ${i}`);
    await s.close(); // waits for a queued cleanup
  }
  assert.ok(most <= 20, `at most ${most} index files at an open`);
  const s = await open(t);
  assert.deepEqual(s.status().problems, []);
  assert.equal((await s.read('n/s39.md')).toString(), 'session 39 save 9');
});

test('a damaged index file and 300 saves: still opens, few index files, packs untouched, problem reported', async () => {
  const t = await fresh();
  await t.store.write('n/start.md', 'start');
  writeFileSync(join(t.dir, '_index', vxFileName(randomBytes(16))), randomBytes(70_000)); // looks committed, does not decrypt
  const s = await open(t);
  assert.deepEqual(s.status().problems, ['damaged index file']);
  const packsBefore = packFiles(t);
  for (let i = 0; i < 300; i++) await s.write(`n/note${i % 20}.md`, `version ${i}`);
  await s.close();
  assert.ok(indexFiles(t) <= 20, `${indexFiles(t)} index files`);
  const packsAfter = new Set(packFiles(t));
  assert.ok(packsBefore.every((p) => packsAfter.has(p)), 'no pack removed');
  assert.equal(packsAfter.size, packsBefore.length + 300, 'every pack written is still there');
  const s2 = await open(t);
  assert.deepEqual(s2.status().problems, ['damaged index file']);
  assert.equal(s2.status().lastCleanup, null);
  assert.equal((await s2.read('n/note19.md')).toString(), 'version 299');
});

test('at the index-file limit new commits are refused with NEEDS_REPAIR; reads keep working', async () => {
  const t = await fresh({ limits: { indexFiles: 6 }, autoCleanupEvery: 0 });
  const s = t.store;
  for (let i = 0; indexFiles(t) < 6; i++) await s.write('n/a.md', `v${i}`);
  await assert.rejects(s.write('n/b.md', 'b'), (e) => e.code === 'NEEDS_REPAIR' && /vault verify/.test(e.message) && /vault export/.test(e.message));
  assert.equal(s.status().broken, false);
  assert.ok((await s.read('n/a.md')).length > 0, 'reads still work');
  const r = await s.cleanup(); // the count is taken again after a cleanup
  assert.equal(r.level, 'full');
  assert.equal(s.status().indexFiles, 2);
  await s.write('n/b.md', 'b');
});

test('the counter starts from the disk: a folder with many leftovers gets a cleanup after the first commit', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  for (let i = 0; i < 20; i++) await t.store.write('n/a.md', `v${i}`);
  await t.store.close();
  assert.equal(indexFiles(t), 21);
  const s = await open(t);
  await s.write('n/a.md', 'one more');
  await s.close();
  assert.ok(indexFiles(t) <= 3, `${indexFiles(t)} index files`);
});

test('top-level paths "__proto__", "constructor" and "toString" survive a close and an open', async () => {
  const t = await fresh();
  const names = ['__proto__', 'constructor', 'toString', 'n/__proto__', 'hasOwnProperty'];
  for (const n of names) await t.store.write(n, `content of ${n}`);
  await t.store.mkdir('__proto__2/__proto__');
  await t.store.close();
  const s = await open(t);
  assert.deepEqual(s.status().problems, []);
  for (const n of names) assert.equal((await s.read(n)).toString(), `content of ${n}`);
  assert.equal(s.stat('__proto__2/__proto__').kind, 'd');
});

test('writing the content a file already has makes no commit and keeps its time', async () => {
  const t = await fresh();
  const a = await t.store.write('n/same.md', 'same');
  const seq = t.store.status().seq;
  const mtime = t.store.stat('n/same.md').mtime;
  const r = await Promise.all([t.store.write('n/same.md', 'same'), t.store.write('n/same.md', 'same')]);
  await t.store.write('n/same.md', 'same', { ifMatch: a.id });
  assert.equal(t.store.status().seq, seq, '3 identical writes after the first: no commit');
  assert.deepEqual(r[0], { id: a.id, size: 4 });
  assert.equal(t.store.stat('n/same.md').mtime, mtime);
  await assert.rejects(t.store.write('n/same.md', 'same', { ifMatch: null }), { code: 'CONFLICT' });
});

test('a folder listing stops after max + 1 names', async () => {
  const t = await fresh();
  const d = join(t.root, 'many');
  mkdirSync(d);
  for (let i = 0; i < 50; i++) writeFileSync(join(d, `f${i}`), '');
  const vfs = createVfs();
  assert.equal((await vfs.list(d, 50)).length, 50);
  await assert.rejects(vfs.list(d, 10), { code: 'TOO_BIG' });
  assert.deepEqual(await vfs.list(join(t.root, 'missing'), 10), []);
});
