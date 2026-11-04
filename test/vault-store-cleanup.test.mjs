// Cleanup (design 8.6) and pulling the stick at every step. TEST ONLY keys; every vault lives in a temp folder.
// Unplug tests: the guard throws EIO before the k-th write-type step of a save, a group commit, a cleanup or a header
// write, for every k. A fresh open must then give the old or the new state (never an error), and cleanup must leave
// no leftovers. Cleanup must never delete what the 2 newest indexes use, and must do nothing at all when an index or
// a header copy is damaged.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase, buildHeader, parseHeader } from '../hub/vault/header.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'stickhub-unplug-')); roots.push(d); return d; };
async function fresh() { const t = await makeTestStore(); roots.push(t.root); return t; }
const open = (dir, v, guard) => openVaultFolder(dir, (h) => unlockWithPassphrase(h, v.passphrase), { guard, autoCleanupEvery: 0 });

/** Everything a user could see: files with content, folders, trash. */
async function snapshot(s) {
  const out = [];
  for (const e of s.tree()) out.push(e.kind === 'd' ? `${e.path}/` : `${e.path}=${(await s.read(e.path)).toString('base64')}`);
  for (const t of s.listTrash()) out.push(`trash:${t.path}`);
  return out.sort().join('\n');
}

/** Every file in the folder (to prove that nothing was touched). */
const listing = (dir) => ['', '_index', '_packs'].flatMap((sub) => readdirSync(join(dir, sub)).map((n) => `${sub}/${n}`)).sort();

/** No .part files; packs = exactly those the 2 newest indexes need; the two header copies equal. */
async function assertTidy(dir, v) {
  const all = listing(dir);
  assert.deepEqual(all.filter((n) => n.endsWith('.part')), [], 'no .part left');
  assert.ok(readdirSync(join(dir, '_index')).length <= 2, 'at most 2 index files');
  assert.equal(readFileSync(join(dir, 'vault.json'), 'utf8'), readFileSync(join(dir, 'vault.bak.json'), 'utf8'), 'header copies equal');
  const s = await open(dir, v);
  assert.deepEqual(s.status().problems, []);
  await snapshot(s); // every file still reads and matches its content id
  await s.close();
}

/** A vault with history: overwrites, a move, a folder in the trash, an orphan pack and .part leftovers. */
async function messyVault() {
  const t = await fresh();
  const s = t.store;
  await s.write('n/a.md', 'first');
  await s.write('n/a.md', 'second');
  await Promise.all([s.write('n/b.md', 'bee'), s.write('n/f/c.md', 'sea'), s.write('n/big.bin', Buffer.alloc(150_000, 5))]);
  await s.move('n/b.md', 'n/f/b.md');
  await s.remove(['n/f']);
  await s.write('n/d.md', 'dee');
  writeFileSync(join(t.dir, '_packs', `${'q'.repeat(26)}.vx`), 'orphan');
  writeFileSync(join(t.dir, '_index', `${'a'.repeat(26)}.vx.part`), 'torn');
  writeFileSync(join(t.dir, 'vault.json.part'), 'torn');
  return t;
}

test('cleanup removes leftovers and keeps everything the 2 newest indexes use', async () => {
  const t = await messyVault();
  const before = await snapshot(t.store);
  const r = await t.store.cleanup();
  assert.equal(r.done, true);
  assert.equal(r.removed.indexParts, 1);
  assert.equal(r.removed.headerParts, 1);
  assert.ok(r.removed.indexes >= 3);
  assert.ok(r.removed.packs >= 1, 'the orphan and the replaced "first" pack');
  assert.equal(await snapshot(t.store), before);
  await assertTidy(t.dir, t.v);
  // the previous index is still complete: drop the newest and everything of the state before still reads
  await t.store.write('n/e.md', 'eee');
  await t.store.cleanup();
  const previous = (await Promise.all(readdirSync(join(t.dir, '_index')).map(async (n) => {
    const copy = tmp(); cpSync(t.dir, copy, { recursive: true }); rmSync(join(copy, '_index', n));
    const s = await open(copy, t.v); return { n, seq: s.status().seq, snap: await snapshot(s) };
  }))).sort((a, b) => a.seq - b.seq)[0];
  assert.equal(previous.snap, before, 'the state before the last write is fully readable');
  // the trash keeps its data
  const s = await open(t.dir, t.v);
  await s.restore(s.listTrash().map((e) => e.tid));
  assert.equal((await s.read('n/f/c.md')).toString(), 'sea');
});

const untouched = (dir) => listing(dir).filter((n) => !n.startsWith('_index/')); // packs and headers (incl. .part)

test('a damaged index file: only the light cleanup runs; packs, the damaged file and the headers stay', async () => {
  const t = await messyVault();
  const seq = t.store.status().seq;
  const damage = (n) => { const b = readFileSync(join(t.dir, '_index', n)); b[b.length - 5] ^= 1; writeFileSync(join(t.dir, '_index', n), b); return b; };
  const names = readdirSync(join(t.dir, '_index')).filter((n) => n.endsWith('.vx'));
  // the newest one damaged: the store's own newest is gone, so no cleanup at all
  let newest = null;
  for (const n of names) {
    const saved = readFileSync(join(t.dir, '_index', n));
    damage(n);
    if ((await open(t.dir, t.v)).status().seq !== seq) newest = n;
    writeFileSync(join(t.dir, '_index', n), saved);
  }
  damage(newest);
  assert.equal((await t.store.cleanup()).level, 'none');
  writeFileSync(join(t.dir, '_index', newest), (b => { b[b.length - 5] ^= 1; return b; })(readFileSync(join(t.dir, '_index', newest))));
  // an older one damaged: the light cleanup runs
  const victim = names.find((n) => n !== newest);
  damage(victim);
  const keep = untouched(t.dir);
  const r1 = await t.store.cleanup(); // damaged after the store opened
  assert.equal(r1.level, 'light');
  assert.deepEqual(r1.reasons, ['damaged index file'], 'each reason once');
  assert.equal(r1.removed.packs, 0);
  assert.deepEqual(untouched(t.dir), keep, 'packs and headers untouched');
  const idx = readdirSync(join(t.dir, '_index'));
  assert.ok(idx.includes(victim), 'the damaged file stays');
  assert.equal(idx.filter((n) => n.endsWith('.part')).length, 0, 'index .part files removed');
  assert.ok(idx.length <= 3, `${idx.length} index files`);
  const s2 = await open(t.dir, t.v); // damaged at open
  assert.deepEqual(s2.status().problems, ['damaged index file']);
  const r2 = await s2.cleanup();
  assert.equal(r2.level, 'light');
  assert.deepEqual(r2.reasons, ['damaged index file'], 'once, though found at open and again now');
  assert.deepEqual(untouched(t.dir), keep);
});

test('a header copy that fails its check: only the light cleanup runs; packs and headers stay', async () => {
  const t = await messyVault();
  const main = join(t.dir, 'vault.json');
  const text = readFileSync(main, 'utf8');
  const flipMac = (x) => x.replace(/"mac":"(.)/, (_, c) => `"mac":"${c === 'A' ? 'B' : 'A'}`);
  for (const [file, broken] of [[main, flipMac(text)], [join(t.dir, 'vault.bak.json'), '{"not":"a header"}']]) {
    const saved = readFileSync(file, 'utf8');
    writeFileSync(file, broken);
    const keep = untouched(t.dir);
    const r = await t.store.cleanup(); // checked when cleanup runs, not only at open
    assert.equal(r.level, 'light', file);
    assert.equal(r.reasons.length, 1);
    assert.deepEqual(untouched(t.dir), keep);
    const s = await open(t.dir, t.v);
    assert.equal(s.status().problems.length, 1);
    assert.equal((await s.cleanup()).level, 'light');
    assert.deepEqual(untouched(t.dir), keep);
    writeFileSync(file, saved);
  }
  const r = await (await open(t.dir, t.v)).cleanup();
  assert.equal(r.level, 'full');
  assert.deepEqual(r.reasons, []);
});

test('no cleanup at all when the newest index on disk is not the one the store knows', async () => {
  const t = await fresh();
  await t.store.write('n/a', 'a');
  const other = await open(t.dir, t.v);
  await other.write('n/b', 'b'); // another writer moved on
  const before = listing(t.dir);
  const r = await t.store.cleanup();
  assert.equal(r.level, 'none');
  assert.deepEqual(listing(t.dir), before);
});

test('maintenance (with its cleanup) runs by itself, so index files cannot pile up', async () => {
  const t = await fresh();
  for (let i = 0; i < 40; i++) await t.store.write('n/counter.md', `v${i}`);
  while (t.store.status().lastCleanup === null) await new Promise((r) => setImmediate(r));
  await t.store.mkdir('n/flush'); // the queue has run everything before it
  assert.equal(t.store.status().lastCleanup.done, true);
  assert.ok(readdirSync(join(t.dir, '_index')).length <= 2 + 16, `${readdirSync(join(t.dir, '_index')).length} index files`);
  assert.equal((await (await open(t.dir, t.v)).read('n/counter.md')).toString(), 'v39');
});

test('cleanup never touches files it does not own', async () => {
  const t = await fresh();
  writeFileSync(join(t.dir, '_packs', 'README.txt'), 'mine');
  writeFileSync(join(t.dir, '_index', 'notes.txt'), 'mine');
  writeFileSync(join(t.dir, 'other.json'), 'mine');
  await t.store.write('a/x', 'x');
  assert.equal((await t.store.cleanup()).done, true);
  for (const f of ['_packs/README.txt', '_index/notes.txt', 'other.json']) assert.equal(readFileSync(join(t.dir, f), 'utf8'), 'mine');
});

/**
 * Kill `op` at every write-type step. After each, a fresh open gives `before` or `after` (never an error), then
 * cleanup leaves the folder tidy.
 */
async function unplugAtEveryStep(t, op, label, headers = null, cleanFirst = true) {
  if (cleanFirst) await t.store.cleanup();
  await t.store.close();
  const template = tmp();
  cpSync(t.dir, template, { recursive: true });
  const work = (k) => { const d = join(tmp(), 'data'); cpSync(template, d, { recursive: true }); return d; };
  // dry run: count the steps and learn the state after
  let steps = 0;
  const d0 = work();
  const s0 = await open(d0, t.v, () => { steps++; });
  const before = await snapshot(s0);
  await op(s0);
  const afterState = await snapshot(await open(d0, t.v));
  assert.ok(steps >= 2, `${label}: ${steps} steps`);
  for (let k = 1; k <= steps; k++) {
    const d = work(k);
    let n = 0;
    const s = await open(d, t.v, () => { if (++n === k) throw Object.assign(new Error('unplugged'), { code: 'EIO' }); });
    await op(s).then(() => {}, (e) => assert.match(e.code, /^(WRITE_FAILED|STORE_BROKEN)$/, `${label} step ${k}`));
    const re = await open(d, t.v); // never an error
    if (headers) assert.ok(headers.has(readFileSync(join(d, 'vault.json'), 'utf8')), `${label} step ${k}: old or new header`);
    const snap = await snapshot(re);
    assert.ok(snap === before || snap === afterState, `${label}: old or new state after step ${k}`);
    assert.deepEqual(re.status().problems, [], `${label} step ${k}: no damage`);
    const c = await re.cleanup();
    assert.equal(c.done, true, `${label} step ${k}`);
    await re.close();
    await assertTidy(d, t.v);
  }
  return steps;
}

test('unplug at every step of a save', async () => {
  const t = await fresh();
  await t.store.write('n/old.md', 'old');
  const steps = await unplugAtEveryStep(t, (s) => s.write('n/new.md', Buffer.alloc(70_000, 1)), 'save');
  assert.ok(steps >= 9);
});

test('unplug at every step of a group commit (overwrite, move, trash, new file)', async () => {
  const t = await fresh();
  await Promise.all([t.store.write('n/a.md', 'a'), t.store.write('n/b.md', 'b'), t.store.write('n/c.md', 'c')]);
  await unplugAtEveryStep(t, (s) => Promise.all([s.write('n/a.md', 'A2'), s.move('n/b.md', 'n/z/b.md'), s.remove(['n/c.md']), s.write('n/d.md', 'd')]), 'commit');
});

test('unplug at every step of a cleanup', async () => {
  const t = await messyVault(); // old indexes, replaced packs, an orphan pack, .part leftovers: all in the template
  for (const x of ['x1', 'x2', 'x3']) await t.store.write('n/x.md', x);
  const steps = await unplugAtEveryStep(t, (s) => s.cleanup(), 'cleanup', null, false);
  assert.ok(steps >= 8, `${steps} steps`);
});

test('unplug at every step of a header write', async () => {
  const t = await fresh();
  await t.store.write('n/a.md', 'a');
  const h = parseHeader(readFileSync(join(t.dir, 'vault.json'), 'utf8'));
  const next = buildHeader({ vaultId: h.vaultId, epoch: h.epoch, hseq: h.hseq + 1, slots: h.slots }, t.v.dk);
  const headers = new Set([readFileSync(join(t.dir, 'vault.json'), 'utf8'), next]);
  const steps = await unplugAtEveryStep(t, (s) => s.writeHeader(next), 'header', headers);
  assert.ok(steps >= 10);
  assert.equal(headers.size, 2);
});

test('unplug at every step of a compaction', async () => {
  const t = await fresh();
  for (let i = 0; i < 6; i++) await t.store.write(`n/c${i}.md`, `compact me ${i}`);
  const steps = await unplugAtEveryStep(t, async (s) => {
    const r = await s.compact();
    assert.equal(r.done, true, JSON.stringify(r));
  }, 'compaction');
  assert.ok(steps >= 9, `${steps} steps`);
});
