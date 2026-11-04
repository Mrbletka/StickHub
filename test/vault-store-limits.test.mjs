// Limits and untrusted input (design 6.6): the decrypted index is checked field by field; sizes and counts are
// limited; a pack that does not hold what the index says is refused. TEST ONLY keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { decodeIndex, encodeIndex } from '../hub/vault/indexfile.mjs';
import { writeIndexPayload } from '../hub/vault/replica.mjs';
import { createVfs } from '../hub/vault/vfs.mjs';
import { subkeys } from '../hub/vault/keys.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh(o) { const t = await makeTestStore(o); roots.push(t.root); return t; }
const reopen = (t) => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase));

const ctx = { vaultId: randomBytes(16), epoch: 1 };
const id = () => randomBytes(32).toString('base64url');
const PACK = 'a'.repeat(26);
function good() {
  return {
    v: 1, vault: ctx.vaultId.toString('base64url'), replica: randomBytes(16).toString('base64url'), epoch: 1, seq: 5, time: 1,
    files: { app: { kind: 'd', mtime: 1 }, 'app/n.md': { kind: 'f', id: id(), size: 10, mtime: 1, x: [[PACK, 0, 10]] } },
    trash: [{ tid: '0123456789abcdef', path: 'app/old.md', kind: 'f', id: id(), size: 5, mtime: 1, x: [[PACK, 10, 5]], deletedAt: 2 }],
    packs: { [PACK]: { size: 100, live: 15 } }, peers: {}, devices: {},
  };
}
const enc = (j) => deflateRawSync(Buffer.from(JSON.stringify(j)));

test('a good index decodes', () => {
  const s = decodeIndex(enc(good()), ctx);
  assert.equal(s.seq, 5);
  assert.equal(s.files.get('app/n.md').size, 10);
  assert.equal(s.trash.length, 1);
  // encode -> decode gives the same
  assert.deepEqual(decodeIndex(encodeIndex(s, ctx), ctx), s);
});

test('the decrypted index is checked field by field', () => {
  const cases = {
    'extra top key': (j) => { j.extra = 1; },
    'missing key': (j) => { delete j.devices; },
    'newer version': (j) => { j.v = 2; },
    'other vault': (j) => { j.vault = randomBytes(16).toString('base64url'); },
    'other epoch': (j) => { j.epoch = 2; },
    'seq as text': (j) => { j.seq = '5'; },
    'path with ..': (j) => { j.files['app/../x'] = { kind: 'd', mtime: 1 }; },
    'bad name': (j) => { j.files['app/a:b'] = { kind: 'd', mtime: 1 }; },
    'missing parent folder': (j) => { delete j.files.app; },
    'extra entry key': (j) => { j.files['app/n.md'].extra = 1; },
    'bad kind': (j) => { j.files['app/n.md'].kind = 'x'; },
    'bad id': (j) => { j.files['app/n.md'].id = 'abc'; },
    'negative size': (j) => { j.files['app/n.md'].size = -1; },
    'extents do not add up': (j) => { j.files['app/n.md'].x = [[PACK, 0, 9]]; },
    'unknown pack': (j) => { j.files['app/n.md'].x = [['b'.repeat(26), 0, 10]]; },
    'extent past the pack end': (j) => { j.files['app/n.md'].x = [[PACK, 95, 10]]; },
    'zero-length extent': (j) => { j.files['app/n.md'].x = [[PACK, 0, 0], [PACK, 0, 10]]; },
    'pack table lists an unused pack': (j) => { j.packs['c'.repeat(26)] = { size: 10, live: 0 }; },
    'wrong live bytes': (j) => { j.packs[PACK].live = 14; },
    'pack bigger than 32 MiB': (j) => { j.packs[PACK].size = 33 * 1024 * 1024; },
    'duplicate trash id': (j) => { j.trash.push({ ...j.trash[0], path: 'app/o2.md' }); j.packs[PACK].live = 20; },
    'bad trash id': (j) => { j.trash[0].tid = 'xyz'; },
    'bad peer': (j) => { j.peers[randomBytes(16).toString('base64url')] = { base: {}, seenSeq: 1 }; },
    'bad device name': (j) => { j.devices[randomBytes(16).toString('base64url')] = { name: '', created: 1, lastUsed: 1 }; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const j = good();
    change(j);
    assert.throws(() => decodeIndex(enc(j), ctx), (e) => ['BAD_INDEX', 'UNSUPPORTED'].includes(e.code), name);
  }
  assert.throws(() => decodeIndex(Buffer.from('not deflate at all'), ctx), { code: 'BAD_INDEX' });
});

test('more than 10,000 packs is refused', () => {
  const j = good();
  for (let i = 0; i < 10_001; i++) j.packs[i.toString(32).padStart(26, 'a').replace(/[01]/g, 'b').replace(/[89]/g, 'z')] = { size: 1, live: 0 };
  assert.throws(() => decodeIndex(enc(j), ctx), { code: 'BAD_INDEX' });
});

test('an index that inflates to more than 64 MiB is refused (no zip bomb)', () => {
  const bomb = deflateRawSync(Buffer.alloc(65 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => decodeIndex(bomb, ctx), { code: 'BAD_INDEX' });
});

test('store limits: file size, index size and pack count are enforced before anything is written', async () => {
  const t = await fresh({ limits: { fileBytes: 1000, indexBytes: 2000, packs: 2 } });
  const s = t.store;
  await assert.rejects(async () => s.write('a/big', Buffer.alloc(1001)), { code: 'TOO_BIG' });
  await s.write('a/1', 'one');
  await s.write('a/2', 'two');
  const files = readdirSync(join(t.dir, '_packs')).length;
  await assert.rejects(s.write('a/3', 'three'), { code: 'TOO_MANY_PACKS' });
  assert.equal(readdirSync(join(t.dir, '_packs')).length, files, 'no pack written');
  await s.write('a/4', 'one'); // same content as a/1: no new pack, fine
  const many = Array.from({ length: 60 }, () => s.write(`a/${randomBytes(50).toString('hex')}`, 'one')); // random names: deflate cannot shrink them
  const res = await Promise.allSettled(many);
  assert.ok(res.every((r) => r.status === 'rejected' && r.reason.code === 'TOO_BIG'), 'index over the limit');
  assert.equal(s.status().broken, false, 'refused before any I/O, so the store is still fine');
  await s.write('a/5', 'two');
});

test('more than 256 files in _index is refused', async () => {
  const t = await fresh();
  for (let i = 0; i < 257; i++) writeFileSync(join(t.dir, '_index', `junk${i}`), 'x');
  await assert.rejects(reopen(t), { code: 'TOO_BIG' });
});

test('a pack that does not hold what the index says is refused, in whole and part reads', async () => {
  const t = await fresh();
  const data = Buffer.alloc(200_000, 9);
  await t.store.write('a/f.bin', data);
  await t.store.write('a/g.bin', Buffer.alloc(1000, 1));
  // write a newer index whose extent for f.bin points 1000 bytes further into the same pack
  const k = subkeys(t.v.dk, t.v.vaultId, 1);
  const c = { kFile: k.file, vaultId: t.v.vaultId, epoch: 1 };
  const s0 = await reopen(t);
  const st = s0.status();
  const scanState = (await import('../hub/vault/replica.mjs')).scanIndexes;
  const { valid } = await scanState(t.dir, c, createVfs());
  const state = valid[0].state;
  const f = state.files.get('a/f.bin');
  const shifted = { ...state, seq: st.seq + 1, files: new Map(state.files) };
  shifted.files.set('a/f.bin', { ...f, x: [[f.x[0][0], f.x[0][1] + 500, f.x[0][2] - 500]], size: f.size - 500 });
  await writeIndexPayload(t.dir, encodeIndex(shifted, c), c, createVfs());
  const s = await reopen(t);
  assert.equal(s.status().seq, st.seq + 1);
  await assert.rejects(s.read('a/f.bin'), { code: 'BAD_VX' }); // content id check
  await assert.rejects(s.read('a/f.bin', { start: 0, end: 10 }), { code: 'BAD_VX' }); // table of contents check
  assert.equal((await s.read('a/g.bin')).length, 1000);
  mkdirSync(join(t.dir, 'unrelated'), { recursive: true });
});

test('a missing pack file is reported as damage, not a crash', async () => {
  const t = await fresh();
  await t.store.write('a/x', 'x');
  for (const n of readdirSync(join(t.dir, '_packs'))) rmSync(join(t.dir, '_packs', n));
  await assert.rejects(t.store.read('a/x'), { code: 'PACK_MISSING' });
});
