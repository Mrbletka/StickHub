// Maintenance in small steps (design 8.6, job 2b). TEST ONLY keys; every vault lives in a temp folder.
// A save waits behind one step at most: with cleanupMax 1 that is at most one deleted file between its call and its
// commit. Unplug at every step of a stepped maintain; blocked and busy runs end the chain; close() does not wait for
// steps that have not started.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { scanStats } from '../hub/vault/replica.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'stickhub-steps-')); roots.push(d); return d; };
const open = (dir, v, o = {}) => openVaultFolder(dir, (h) => unlockWithPassphrase(h, v.passphrase), o);
const files = (dir, sub) => readdirSync(join(dir, sub));
const tick = () => new Promise((r) => setImmediate(r));

/** Everything a user could see; every file is read whole (its content id is checked). */
async function snapshot(s) {
  const out = [];
  for (const e of s.tree()) out.push(e.kind === 'd' ? `${e.path}/` : `${e.path}=${(await s.read(e.path)).toString('base64')}`);
  for (const t of s.listTrash()) out.push(`trash:${t.path}`);
  return out.sort().join('\n');
}

/** A closed vault with a backlog: old index files and the packs only they used (at least `n` files to delete). */
async function backlog(n = 30) {
  const t = await makeTestStore({ autoCleanupEvery: 0 });
  roots.push(t.root);
  await t.store.write('n/keep.md', 'keep');
  for (let i = 0; i < Math.ceil(n / 2) + 2; i++) await t.store.write('n/a.md', `version ${i}`);
  await t.store.close();
  const extra = files(t.dir, '_index').length - 2 + files(t.dir, '_packs').length - 3;
  assert.ok(extra >= n, `backlog of ${extra} files`);
  return t;
}

/** A guard that counts deleted files; `on(op, path)` runs first (may throw). */
function counter(on = () => {}) {
  const c = { deleted: 0 };
  c.guard = (op, path) => { on(op, path, c); if (op === 'unlink') c.deleted++; };
  return c;
}

/** Save and return how many files were deleted between the call and the commit. */
async function timedSave(s, c, p, data) {
  const at = c.deleted;
  await s.write(p, data);
  return c.deleted - at;
}

async function assertGood(dir, v) {
  const s = await open(dir, v, { autoCleanupEvery: 0 });
  assert.deepEqual(s.status().problems, []);
  assert.equal((await s.verify()).ok, true, 'verify OK');
  const snap = await snapshot(s);
  await s.close();
  return snap;
}

test('cleanupMax 1, a backlog of 30 files, saves all the time: no save is more than one step behind', async () => {
  const t = await backlog(30);
  const c = counter();
  const s = await open(t.dir, t.v, { guard: c.guard, cleanupMax: 1, autoCleanupEvery: 0 });
  let done = false;
  const m = s.maintain().finally(() => { done = true; });
  let saves = 0;
  let worst = 0;
  const loop = async (who) => {
    while (!done) worst = Math.max(worst, await timedSave(s, c, `n/${who}-${saves++ % 7}.md`, `${who} ${saves}`));
  };
  await Promise.all([loop('x'), loop('y'), (async () => { while (!done) { await tick(); worst = Math.max(worst, await timedSave(s, c, 'n/z.md', 'z')); } })()]);
  const r = await m;
  assert.ok(worst <= 1, `a save waited for ${worst} deletions`);
  assert.ok(saves >= 20, `${saves} saves ran between the steps`);
  assert.equal(r.cleanup.level, 'full');
  assert.ok(r.cleanup.steps >= 30, `${r.cleanup.steps} cleanup steps`); // as many as there was work when it started
  assert.equal(r.steps, r.cleanup.steps + (r.compacted?.steps ?? 0));
  assert.equal((await s.maintain()).cleanup.more, false, 'without saves arriving, maintain() ends with nothing left');
  assert.ok(files(t.dir, '_index').length <= 2);
  await s.close();
  assert.match(await assertGood(t.dir, t.v), /n\/keep\.md=/);
});

test('automatic steps (cleanupMax 1, after every commit): saves never more than one step behind, backlog gone', async () => {
  const t = await backlog(30);
  const c = counter();
  const s = await open(t.dir, t.v, { guard: c.guard, cleanupMax: 1, autoCleanupEvery: 1 });
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    const r = await Promise.all([timedSave(s, c, `n/s${i % 5}.md`, `${i}`), timedSave(s, c, 'n/t.md', `${i}`)]);
    worst = Math.max(worst, ...r);
  }
  assert.ok(worst <= 1, `a save waited for ${worst} deletions`);
  assert.ok(c.deleted >= 30, `${c.deleted} files deleted meanwhile`);
  for (let i = 0; i < 3; i++) { // quiet now: each save starts a chain that ends with nothing left
    await s.write('n/t.md', `quiet ${i}`);
    while (s.status().maintaining) await tick();
  }
  assert.ok(files(t.dir, '_index').length <= 3, 'the backlog went away');
  assert.equal(s.status().lastCleanup.error, undefined);
  await s.close();
  await assertGood(t.dir, t.v);
});

test('unplug at every step of a stepped maintain (cleanupMax 1): opens, verifies OK, every file reads', async () => {
  const t = await makeTestStore({ autoCleanupEvery: 0 });
  roots.push(t.root);
  for (const x of 'abcdef') await t.store.write(`n/${x}.md`, `note ${x}`); // 6 small packs: worth compacting
  for (let i = 0; i < 3; i++) await t.store.write('n/a.md', `a ${i}`);
  await t.store.close();
  const template = tmp();
  cpSync(t.dir, template, { recursive: true });
  const work = () => { const d = join(tmp(), 'data'); cpSync(template, d, { recursive: true }); return d; };
  let ops = 0;
  const d0 = work();
  const s0 = await open(d0, t.v, { guard: () => { ops++; }, cleanupMax: 1, autoCleanupEvery: 0 });
  const before = await snapshot(s0);
  const r0 = await s0.maintain();
  assert.equal(r0.compacted?.done, true, 'one compaction step');
  assert.ok(r0.cleanup.steps >= 8, `${r0.cleanup.steps} cleanup steps`);
  await s0.close();
  for (let k = 1; k <= ops; k++) {
    const d = work();
    let n = 0;
    const s = await open(d, t.v, { guard: () => { if (++n === k) throw Object.assign(new Error('unplugged'), { code: 'EIO' }); }, cleanupMax: 1, autoCleanupEvery: 0 });
    await s.maintain().then(() => {}, (e) => assert.match(e.code, /^(WRITE_FAILED|STORE_BROKEN)$/, `step ${k}`));
    assert.equal(await assertGood(d, t.v), before, `step ${k}: nothing lost`);
    const re = await open(d, t.v, { cleanupMax: 1, autoCleanupEvery: 0 });
    assert.equal((await re.maintain()).cleanup?.done ?? true, true, `step ${k}: the next maintain finishes`);
    await re.close();
    assert.equal(await assertGood(d, t.v), before);
    assert.ok(files(d, '_index').length <= 2, `step ${k}: tidy`);
  }
});

test('blocked: another writer between two steps ends the chain, nothing more is deleted', async () => {
  const t = await backlog(30);
  const other = join(tmp(), 'data');
  cpSync(t.dir, other, { recursive: true });
  const b = await open(other, t.v, { autoCleanupEvery: 0 });
  await b.write('n/other.md', 'from the other writer');
  await b.close();
  const newer = ['_index', '_packs'].flatMap((sub) => files(other, sub).filter((n) => !files(t.dir, sub).includes(n)).map((n) => join(sub, n)));
  assert.equal(newer.length, 2, 'one index and one pack');
  const c = counter((op, p, k) => { if (op === 'unlink' && k.deleted === 0) for (const f of newer) copyFileSync(join(other, f), join(t.dir, f)); });
  const s = await open(t.dir, t.v, { guard: c.guard, cleanupMax: 1, autoCleanupEvery: 0 });
  const r = await s.maintain();
  assert.equal(c.deleted, 1, 'only the first run deleted (its scan was before the other writer)');
  assert.equal(r.cleanup.done, false);
  assert.equal(r.cleanup.level, 'none');
  assert.ok(r.cleanup.reasons.includes('the newest index on disk is not the one this store knows'));
  assert.equal(r.cleanup.steps, 2);
  assert.equal((await s.cleanup()).removed.indexes, 0, 'still blocked, still nothing deleted');
  await s.close();
  assert.match(await assertGood(t.dir, t.v), /n\/other\.md=/);
});

test('busy: a read opened between two steps ends the chain, nothing more is deleted', async () => {
  const t = await backlog(30);
  let it = null;
  let s;
  const c = counter((op, p, k) => { if (op === 'unlink' && k.deleted === 0) { it = s.readChunks('n/keep.md'); it.next(); } });
  s = await open(t.dir, t.v, { guard: c.guard, cleanupMax: 1, autoCleanupEvery: 0 });
  const r = await s.maintain();
  assert.equal(c.deleted, 1);
  assert.deepEqual([r.cleanup.done, r.cleanup.reasons, r.cleanup.steps], [false, ['reads in progress'], 2]);
  await it.return();
  const r2 = await s.maintain(); // the read is over: now it runs to the end
  assert.equal(r2.cleanup.level, 'full');
  assert.equal(r2.cleanup.more, false);
  await s.close();
  await assertGood(t.dir, t.v);
});

test('close() with steps pending does not wait for them; the reopen is fine', async () => {
  // an explicit maintain(): it stops after the step that runs
  const t = await backlog(30);
  const c = counter();
  const s = await open(t.dir, t.v, { guard: c.guard, cleanupMax: 1, autoCleanupEvery: 0 });
  const m = s.maintain();
  while (c.deleted < 3) await tick();
  const at = c.deleted;
  const saved = s.write('n/last.md', 'queued before close');
  await s.close();
  assert.ok(c.deleted - at <= 1, `close() waited for ${c.deleted - at} deletions`);
  const r = await m;
  assert.ok(r.cleanup.more, 'the chain stopped early');
  await saved; // what callers queued still ran
  assert.match(await assertGood(t.dir, t.v), /n\/last\.md=/);
  // the automatic chain: its steps that have not started are dropped
  const c2 = counter();
  const s2 = await open(t.dir, t.v, { guard: c2.guard, cleanupMax: 1, autoCleanupEvery: 1 });
  await s2.write('n/b.md', 'b');
  while (c2.deleted < 2) await tick();
  assert.equal(s2.status().maintaining, true);
  const at2 = c2.deleted;
  await s2.close();
  assert.ok(c2.deleted - at2 <= 1);
  assert.ok(files(t.dir, '_index').length > 3, 'work was left');
  const snap = await assertGood(t.dir, t.v);
  assert.match(snap, /n\/b\.md=/);
  const s3 = await open(t.dir, t.v, { cleanupMax: 1, autoCleanupEvery: 0 });
  await s3.maintain();
  await s3.close();
  assert.equal(await assertGood(t.dir, t.v), snap);
});

test('maintain() during an automatic chain: the automatic one gives way', async () => {
  const t = await backlog(30);
  const s = await open(t.dir, t.v, { cleanupMax: 1, autoCleanupEvery: 1 });
  await s.write('n/b.md', 'b'); // starts the automatic chain
  assert.equal(s.status().maintaining, true);
  const r = await s.maintain();
  assert.equal(s.status().maintaining, false);
  assert.equal(r.cleanup.more, false);
  assert.ok(files(t.dir, '_index').length <= 2);
  await s.close();
  await assertGood(t.dir, t.v);
});

/** A vault of 12 commits; the index file names in commit order (oldest first), from the guard. */
async function history() {
  const names = [];
  const t = await makeTestStore({ autoCleanupEvery: 0, guard: (op, p) => { if (op === 'rename' && p.includes('_index')) names.push(basename(p)); } });
  roots.push(t.root);
  for (let i = 0; i < 11; i++) await t.store.write(`n/${i % 3}.md`, `version ${i}`);
  await t.store.close();
  assert.equal(names.length, 12);
  return { t, names };
}

/** Open with cleanupMax 1 and do exactly one cleanup run (a read opened after the first deletion ends the chain). */
async function oneRun(t, c) {
  let it = null;
  let s;
  s = await open(t.dir, t.v, { guard: (op) => { c.deleted += op === 'unlink'; if (op === 'unlink' && !it) { it = s.readChunks('n/0.md'); it.next(); } }, cleanupMax: 1, autoCleanupEvery: 0 });
  assert.equal((await s.cleanup()).steps, 2);
  await it.return();
  return s;
}

test('the index cache: a stepped cleanup decodes each older index file once', async () => {
  const t = await backlog(30);
  const s = await open(t.dir, t.v, { cleanupMax: 1, autoCleanupEvery: 0 });
  const before = scanStats.decoded;
  const r = await s.cleanup();
  const decoded = scanStats.decoded - before;
  assert.equal(r.more, false);
  assert.ok(decoded <= 17 + 2 * r.steps, `${decoded} index files decoded in ${r.steps} runs`);
  await s.close();
  await assertGood(t.dir, t.v);
});

test('the index cache never decides the 2 newest: a damaged one that moves up is read fresh', async () => {
  const { t, names } = await history();
  const c = { deleted: 0 };
  const s = await oneRun(t, c); // the cache now holds every index file
  const idx = (n) => join(t.dir, '_index', n);
  const left = names.filter((n) => files(t.dir, '_index').includes(n)); // oldest first
  rmSync(idx(left.at(-2))); // the second newest is gone: the third moves up ...
  const f = readFileSync(idx(left.at(-3)));
  f[f.length - 20] ^= 1; // ... and it is damaged, same size (only a fresh read can see that)
  writeFileSync(idx(left.at(-3)), f);
  const packs = files(t.dir, '_packs').length;
  const r = await s.cleanup();
  assert.ok(r.reasons.includes('damaged index file'), JSON.stringify(r.reasons));
  assert.equal(r.level, 'light');
  assert.equal(r.removed.packs, 0);
  assert.equal(files(t.dir, '_packs').length, packs, 'no pack deleted');
  await s.close();
});

test('the index cache: a changed size is decoded again; verify and open always read fresh', async () => {
  const { t, names } = await history();
  const s = await oneRun(t, { deleted: 0 });
  const idx = (n) => join(t.dir, '_index', n);
  const old = names.filter((n) => files(t.dir, '_index').includes(n))[2];
  const f = readFileSync(idx(old));
  f[f.length - 20] ^= 1; // an older file, same size: the cache does not see it ...
  writeFileSync(idx(old), f);
  assert.deepEqual((await s.verify()).indexes.damaged, [old], '... verify does');
  const re = await open(t.dir, t.v, { autoCleanupEvery: 0 });
  assert.deepEqual(re.status().problems, ['damaged index file'], '... and so does a fresh open');
  await re.close();
  writeFileSync(idx(old), f.subarray(0, f.length - 1)); // another size: the next run decodes it
  const r = await s.cleanup();
  assert.ok(r.reasons.includes('damaged index file'));
  assert.equal(r.removed.packs, 0);
  await s.close();
});
