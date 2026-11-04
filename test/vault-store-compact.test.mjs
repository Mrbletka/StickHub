// Trash (empty, purge after 30 days) and compaction / maintain() (design 8.6, decision 10). TEST ONLY keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { vxFileName } from '../hub/vault/vx.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh(o) { const t = await makeTestStore(o); roots.push(t.root); return t; }
const open = (t, o) => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase), o);
const DAY = 24 * 3600 * 1000;

test('300 saves over 20 notes, then maintain(): a few live packs, every note reads back', async () => {
  const t = await fresh();
  const s = t.store;
  for (let i = 0; i < 300; i++) await s.write(`n/note${i % 20}.md`, `note ${i % 20} version ${i} ${'x'.repeat(i % 50)}`);
  const before = s.status().packs;
  const r = await s.maintain();
  await s.write('n/after.md', 'one more commit');
  await s.maintain();
  assert.ok(s.status().packs <= 3, `${s.status().packs} live packs (was ${before} before the last maintain)`);
  assert.ok(r.compacted === null || r.compacted.done || r.compacted.reason === 'not worth it');
  for (let n = 0; n < 20; n++) {
    const last = 280 + n;
    assert.equal((await s.read(`n/note${n}.md`)).toString(), `note ${n} version ${last} ${'x'.repeat(last % 50)}`);
  }
  assert.ok(readdirSync(join(t.dir, '_packs')).length <= 6, `${readdirSync(join(t.dir, '_packs')).length} pack files on disk`);
  const s2 = await open(t);
  assert.deepEqual(s2.status().problems, []);
  assert.equal((await s2.read('n/note7.md')).toString().slice(0, 23), 'note 7 version 287 xxxx');
});

test('trash: purged after 30 days by the store clock (29 days stays), emptied on request', async () => {
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const t = await fresh({ now: () => clock, autoCleanupEvery: 0 });
  const s = t.store;
  await s.write('n/old.md', 'old');
  await s.write('n/keep.md', 'keep');
  await s.remove(['n/old.md']);
  clock += 29 * DAY;
  assert.deepEqual(await s.purgeTrash(), { removed: 0 });
  assert.equal(s.listTrash().length, 1);
  clock += 2 * DAY;
  assert.deepEqual(await s.purgeTrash(), { removed: 1 });
  assert.equal(s.listTrash().length, 0);
  // maintain() purges too
  await s.remove(['n/keep.md']);
  clock += 31 * DAY;
  assert.equal((await s.maintain()).purged, 1);
  // empty on request: some, then all
  await s.write('n/a', 'a');
  await s.write('n/b', 'b');
  const { tids } = await s.remove(['n/a', 'n/b']);
  await assert.rejects(s.emptyTrash(['ffffffffffffffff']), { code: 'NOT_FOUND' });
  assert.deepEqual(await s.emptyTrash([tids[0]]), { removed: 1 });
  assert.deepEqual(await s.emptyTrash(), { removed: 1 });
  assert.equal(s.listTrash().length, 0);
});

test('compaction keeps dedupe: two files with the same content share one moved piece', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  const s = t.store;
  const same = randomBytes(200_000);
  await s.write('d/one.bin', same);
  await s.write('d/two.bin', same);
  for (let i = 0; i < 4; i++) await s.write(`d/small${i}`, `small ${i}`);
  const r = await s.compact();
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(s.status().packs, 1);
  assert.deepEqual(await s.read('d/one.bin'), same);
  assert.deepEqual(await s.read('d/two.bin'), same);
  assert.equal(s.stat('d/one.bin').id, s.stat('d/two.bin').id);
  await s.write('d/x', 'x'); // one more commit, then a full cleanup removes the old packs
  assert.equal((await s.cleanup()).level, 'full');
  const files = readdirSync(join(t.dir, '_packs'));
  assert.equal(files.length, 2, 'the compacted pack and the new one');
  const s2 = await open(t);
  assert.deepEqual(await s2.read('d/two.bin', { start: 1000, end: 2000 }), same.subarray(1000, 2000));
});

test('a file over several packs is moved piece by piece; whole and part reads work after', async () => {
  const t = await fresh({ autoCleanupEvery: 0, limits: { packData: 512 * 1024 } });
  const s = t.store;
  const big = randomBytes(3 * 1024 * 1024);
  await s.write('m/big.bin', big);
  assert.ok(s.status().packs >= 6, `${s.status().packs} packs`);
  const r = await s.compact();
  assert.equal(r.done, true, JSON.stringify(r));
  assert.ok(s.status().packs <= 2);
  assert.deepEqual(await s.read('m/big.bin'), big);
  assert.deepEqual(await s.read('m/big.bin', { start: 600_000, end: 1_700_000 }), big.subarray(600_000, 1_700_000));
  const s2 = await open(t);
  assert.deepEqual(await s2.read('m/big.bin'), big);
});

test('a read started before the compaction commit still works', async () => {
  const t = await fresh({ autoCleanupEvery: 0, limits: { packData: 512 * 1024 } });
  const s = t.store;
  const big = randomBytes(9 * 1024 * 1024);
  await s.write('m/big.bin', big);
  const pending = s.read('m/big.bin');
  const it = s.readChunks('m/big.bin');
  const first = await it.next();
  const c = await s.compact();
  assert.equal(c.done, true);
  assert.deepEqual(await s.cleanup(), { done: false, level: 'none', reasons: ['reads in progress'] }); // waits for the reads
  const rest = [first.value];
  for await (const chunk of it) rest.push(chunk);
  assert.deepEqual(Buffer.concat(rest), big);
  assert.deepEqual(await pending, big);
  assert.equal((await s.cleanup()).level, 'full'); // now it runs
  assert.deepEqual(await s.read('m/big.bin'), big);
});

test('no compaction while there are problems; cancelled = nothing written; nothing to do = no I/O', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  for (let i = 0; i < 5; i++) await t.store.write(`n/${i}`, `${i}`);
  const ac = new AbortController();
  ac.abort();
  const packs = readdirSync(join(t.dir, '_packs')).length;
  assert.deepEqual(await t.store.compact({ signal: ac.signal }), { done: false, reason: 'cancelled' });
  assert.equal(readdirSync(join(t.dir, '_packs')).length, packs);
  writeFileSync(join(t.dir, '_index', vxFileName(randomBytes(16))), randomBytes(70_000)); // damaged index
  const s = await open(t, { autoCleanupEvery: 0 });
  assert.deepEqual(await s.compact(), { done: false, reason: 'problems' });
  // a tidy vault: maintain() does no write at all
  const u = await fresh({ autoCleanupEvery: 0 });
  await u.store.write('n/a', 'a');
  await u.store.cleanup();
  await u.store.close();
  let writes = 0;
  const s3 = await open(u, { autoCleanupEvery: 0, guard: () => { writes++; } });
  assert.deepEqual(await s3.maintain(), { purged: 0, compacted: null, cleanup: null });
  assert.equal(writes, 0);
});
