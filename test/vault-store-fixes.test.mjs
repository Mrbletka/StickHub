// Fixes C1-C4 (job 2, part 2): index files must not pile up (short sessions, a damaged index), the NEEDS_REPAIR
// guard, paths like "__proto__", identical writes, and the bounded folder listing. TEST ONLY keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
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

test('at the index-file limit a commit first runs one cleanup, then goes on', async () => {
  const t = await fresh({ limits: { indexFiles: 6 }, autoCleanupEvery: 0 });
  const s = t.store;
  for (let i = 0; indexFiles(t) < 6; i++) await s.write('n/a.md', `v${i}`);
  await s.write('n/b.md', 'b'); // at the limit: the cleanup runs inside the commit
  assert.equal(s.status().lastCleanup.level, 'full');
  assert.ok(indexFiles(t) <= 3, `${indexFiles(t)} index files`);
  assert.equal((await s.read('n/b.md')).toString(), 'b');
});

test('at the index-file limit with the cleanup blocked or busy: NEEDS_REPAIR; reads keep working', async () => {
  const t = await fresh({ limits: { indexFiles: 6 }, autoCleanupEvery: 0 });
  const s = t.store;
  for (let i = 0; indexFiles(t) < 6; i++) await s.write('n/a.md', `v${i}`);
  // busy: a read is running, so the cleanup does nothing
  const it = s.readChunks('n/a.md');
  await it.next();
  await assert.rejects(s.write('n/b.md', 'b'), (e) => e.code === 'NEEDS_REPAIR' && /vault verify/.test(e.message) && /vault export/.test(e.message));
  assert.equal(s.status().broken, false);
  assert.equal(s.status().lastCleanup, null, 'no cleanup ran');
  await it.return();
  // blocked: another writer moved the newest index on, so this store's cleanup must not touch anything
  const other = await open(t, { autoCleanupEvery: 0 });
  await other.write('n/c.md', 'c');
  await assert.rejects(s.write('n/b.md', 'b'), { code: 'NEEDS_REPAIR' });
  assert.equal(s.status().lastCleanup.level, 'none');
  assert.ok((await s.read('n/a.md')).length > 0, 'reads still work');
});

test('reopen() works on a broken store; the broken one stays broken; a closed one refuses', async () => {
  let fail = false;
  const t = await fresh({ autoCleanupEvery: 0, guard: (op) => { if (fail && op === 'rename') throw Object.assign(new Error('pulled'), { code: 'EIO' }); } });
  const s = t.store;
  await s.write('n/a.md', 'kept');
  fail = true;
  await assert.rejects(s.write('n/b.md', 'lost'), { code: 'WRITE_FAILED' });
  fail = false;
  assert.equal(s.status().broken, true);
  const s2 = await s.reopen();
  assert.equal((await s2.read('n/a.md')).toString(), 'kept');
  assert.throws(() => s2.stat('n/b.md'), { code: 'NOT_FOUND' });
  await s2.write('n/b.md', 'saved now');
  await assert.rejects(async () => s.write('n/x.md', 'x'), { code: 'STORE_BROKEN' });
  await s2.close();
  assert.throws(() => s2.reopen(), { code: 'CLOSED' });
});

test('an unfinished header write is redone by the next FULL cleanup, not lost to a busy one', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  await t.store.write('n/a.md', 'a');
  await t.store.close();
  rmSync(join(t.dir, 'vault.bak.json')); // as if pulled before the backup copy was written
  const s = await open(t, { autoCleanupEvery: 0 });
  assert.equal(indexFiles(t), 2, 'only the header leftover is left to do');
  const it = s.readChunks('n/a.md');
  await it.next();
  assert.equal((await s.maintain()).cleanup.reasons[0], 'reads in progress');
  await it.return();
  const r = await s.maintain(); // still marked: the cleanup runs now and writes the backup copy
  assert.equal(r.cleanup.level, 'full');
  assert.equal(r.cleanup.removed.headerBackup, true);
  assert.ok(existsSync(join(t.dir, 'vault.bak.json')));
  assert.deepEqual(await s.maintain(), { purged: 0, compacted: null, cleanup: null }, 'now nothing is left to do');
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
