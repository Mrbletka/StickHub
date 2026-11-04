// Compaction by size tiers and its cost (design 8.6, job 2c). TEST ONLY keys; every vault lives in a temp folder.
// The bound: a byte moves about once per tier (4 packs of a tier make a pack of the next tier; 5 tiers below 1 MiB),
// plus at most once more when its pack falls under 50% live (that move is smaller than the dead bytes it frees, and
// those came from saves). So compaction moves at most about 6x the bytes the saves wrote; the test allows 8x.
// Reads: a chosen pack is opened once and each of its segments decrypted at most once, and after the move it is no
// longer used. So compaction reads at most the bytes that were ever written to _packs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tierOf } from '../hub/vault/compact.mjs';
import { readerStats } from '../hub/vault/vxread.mjs';
import { HEAD, FULL_SEGMENT } from '../hub/vault/vx.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh(o) { const t = await makeTestStore(o); roots.push(t.root); return t; }
const NOTE = (i) => `note ${i} ${randomBytes(1000).toString('hex')}`.slice(0, 2048); // about 2 KB, like probe 10

test('size tiers: under 4 KiB, then x4 up to 1 MiB', () => {
  const k = 1024;
  assert.deepEqual([0, 4 * k - 1, 4 * k, 16 * k, 64 * k, 256 * k - 1, 256 * k, 1024 * k - 1].map(tierOf), [0, 0, 1, 2, 3, 3, 4, 4]);
});

test('a merged pack is not rewritten until its own tier is full', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  const s = t.store;
  for (let i = 0; i < 4; i++) await s.write(`n/a${i}.md`, NOTE(i));
  const r1 = await s.compact();
  assert.deepEqual([r1.done, r1.packs, r1.newPacks], [true, 4, 1]); // 4 x 2 KB: one pack of tier 1
  let fresh4 = 0;
  for (let i = 0; i < 4; i++) { const n = NOTE(10 + i); fresh4 += n.length; await s.write(`n/b${i}.md`, n); }
  const r2 = await s.compact();
  assert.equal(r2.packs, 4, 'only the 4 new packs');
  assert.equal(r2.bytes, fresh4, 'the merged pack did not move');
  assert.equal(s.status().packs, 2, 'two packs of tier 1');
  assert.equal((await s.compact()).reason, 'not worth it');
  for (let i = 0; i < 4; i++) assert.match((await s.read(`n/a${i}.md`)).toString(), new RegExp(`^note ${i} `));
});

/** 300 saves of 2 KB over 20 notes with maintenance every 4 commits (as the automatic one): bytes saved and moved. */
async function churn(base) {
  let packBytes = 0; // every byte written to _packs, from the start
  const t = await fresh({ autoCleanupEvery: 0, guard: (op, p) => { if (op === 'fsync' && p.includes('_packs')) packBytes += statSync(p).size; } });
  const s = t.store;
  const seg0 = readerStats.segments;
  for (let i = 0; i < base; i += 50) await Promise.all(Array.from({ length: Math.min(50, base - i) }, (_, k) => s.write(`b/m${i + k}.md`, NOTE(i + k))));
  await s.maintain();
  let saved = 0;
  let moved = 0;
  for (let i = 0; i < 300; i++) {
    const n = NOTE(i);
    saved += n.length;
    await s.write(`n/note${i % 20}.md`, n);
    if (i % 4 === 3) moved += (await s.maintain()).compacted?.bytes ?? 0;
  }
  const read = (readerStats.segments - seg0) * FULL_SEGMENT;
  for (let n = 0; n < 20; n++) assert.match((await s.read(`n/note${n}.md`)).toString(), new RegExp(`^note ${280 + n} `));
  assert.equal((await s.verify()).ok, true);
  return { saved, moved, read, packBytes, packs: s.status().packs };
}

test('300 saves over 20 notes: compaction moves at most 8x the bytes the saves wrote', async () => {
  const r = await churn(0);
  assert.ok(r.moved <= 8 * r.saved, `moved ${r.moved} bytes for ${r.saved} saved`);
  assert.ok(r.read <= r.packBytes, `read ${r.read} bytes, ${r.packBytes} written to _packs`);
  assert.ok(r.packs <= 16, `${r.packs} packs in use (at most 3 per tier, and packs over 1 MiB)`);
});

test('the same on top of 230 notes: the same bound (before tiers, each run moved all 230 notes again)', async () => {
  const r = await churn(230); // the old rule moved about 470 KB per maintenance, 75 times: about 58x the saves
  assert.ok(r.moved <= 8 * r.saved, `moved ${r.moved} bytes for ${r.saved} saved`);
  assert.ok(r.read <= r.packBytes, `read ${r.read} bytes, ${r.packBytes} written to _packs`);
});

test('one compaction decrypts each segment of the packs it reads at most once', async () => {
  const t = await fresh({ autoCleanupEvery: 0 });
  const s = t.store;
  for (let b = 0; b < 4; b++) await Promise.all(Array.from({ length: 100 }, (_, i) => s.write(`n/${b}/${i}.md`, NOTE(i)))); // 4 packs of 100 notes
  const segs = readdirSync(join(t.dir, '_packs')).reduce((n, f) => n + Math.ceil((statSync(join(t.dir, '_packs', f)).size - HEAD) / FULL_SEGMENT), 0);
  assert.ok(segs >= 16, `${segs} segments in 4 packs`);
  const seg0 = readerStats.segments;
  const r = await s.compact();
  assert.deepEqual([r.done, r.packs], [true, 4]);
  const used = readerStats.segments - seg0;
  assert.ok(used <= segs, `${used} segments decrypted for ${segs} in the packs (reading 400 files one by one: about 800)`);
  assert.equal((await s.verify()).ok, true);
  assert.match((await s.read('n/3/99.md')).toString(), /^note 99 /);
});

test('a partly moving file: its moving pieces are checked against the table of contents', async () => {
  const t = await fresh({ autoCleanupEvery: 0, limits: { packData: 512 * 1024 } });
  const s = t.store;
  const big = randomBytes(1200 * 1024); // 3 packs: 512 + 512 + 176 KiB (only the last one is in tier 3)
  await s.write('m/big.bin', big);
  for (let i = 0; i < 3; i++) await s.write(`m/s${i}`, randomBytes(100 * 1024)); // with the last piece: 4 packs of tier 3
  const r = await s.compact();
  assert.deepEqual([r.done, r.packs], [true, 4]);
  assert.deepEqual(await s.read('m/big.bin'), big);
  assert.equal((await s.verify()).ok, true);
});
