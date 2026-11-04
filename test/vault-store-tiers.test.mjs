// Compaction by size tiers and its cost (design 8.6, job 2c). TEST ONLY keys; every vault lives in a temp folder.
// The bound: a byte moves about once per tier (4 packs of a tier make a pack of the next tier; 5 tiers below 1 MiB),
// plus at most once more when its pack falls under 50% live (that move is smaller than the dead bytes it frees, and
// those came from saves). So compaction moves at most about 6x the bytes the saves wrote; the test allows 8x.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tierOf } from '../hub/vault/compact.mjs';
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
  const t = await fresh({ autoCleanupEvery: 0 });
  const s = t.store;
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
  for (let n = 0; n < 20; n++) assert.match((await s.read(`n/note${n}.md`)).toString(), new RegExp(`^note ${280 + n} `));
  assert.equal((await s.verify()).ok, true);
  return { saved, moved, packs: s.status().packs };
}

test('300 saves over 20 notes: compaction moves at most 8x the bytes the saves wrote', async () => {
  const r = await churn(0);
  assert.ok(r.moved <= 8 * r.saved, `moved ${r.moved} bytes for ${r.saved} saved`);
  assert.ok(r.packs <= 16, `${r.packs} packs in use (at most 3 per tier, and packs over 1 MiB)`);
});

test('the same on top of 230 notes: the same bound (before tiers, each run moved all 230 notes again)', async () => {
  const r = await churn(230); // the old rule moved about 470 KB per maintenance, 75 times: about 58x the saves
  assert.ok(r.moved <= 8 * r.saved, `moved ${r.moved} bytes for ${r.saved} saved`);
});
