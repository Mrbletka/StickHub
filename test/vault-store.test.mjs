// The vault store: writes, reads, folders, trash, group commit, dedupe, the newest valid index, header fallback.
// TEST ONLY keys; every vault lives in a temp folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase, unlockWithPaperCode } from '../hub/vault/header.mjs';
import { subkeys } from '../hub/vault/keys.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh(o) { const t = await makeTestStore(o); roots.push(t.root); return t; }
const reopen = (t, o) => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase), o);
const count = (t, sub) => readdirSync(join(t.dir, sub)).length;
const paths = (s, prefix) => s.tree(prefix).map((e) => `${e.path}${e.kind === 'd' ? '/' : ''}`);

test('create, write, read, stat, and reopen with the passphrase or the paper code', async () => {
  const t = await fresh();
  const { store: s, v } = t;
  assert.deepEqual(s.tree(), []);
  const r = await s.write('notes/hello.md', 'Hello vault');
  assert.equal(r.size, 11);
  assert.equal(r.id, createHmac('sha256', subkeys(v.dk, v.vaultId, 1).contentId).update('Hello vault').digest('base64url'));
  assert.equal((await s.read('notes/hello.md')).toString(), 'Hello vault');
  assert.deepEqual({ ...s.stat('notes/hello.md'), mtime: 0 }, { path: 'notes/hello.md', kind: 'f', size: 11, mtime: 0, id: r.id });
  assert.equal(s.stat('notes').kind, 'd', 'parents are created');
  await s.write('notes/empty.txt', '');
  assert.equal((await s.read('notes/empty.txt')).length, 0);
  await s.close();
  assert.throws(() => s.stat('notes'), { code: 'CLOSED' });
  const s2 = await reopen(t);
  assert.equal((await s2.read('notes/hello.md')).toString(), 'Hello vault');
  const s3 = await openVaultFolder(t.dir, (h) => unlockWithPaperCode(h, v.paperCode));
  assert.deepEqual(paths(s3), ['notes/', 'notes/empty.txt', 'notes/hello.md']);
  await assert.rejects(openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, 'wrong')), { code: 'WRONG_SECRET' });
});

test('group commit: writes of the same moment share one pack and one index', async () => {
  const t = await fresh();
  const before = { idx: count(t, '_index'), packs: count(t, '_packs'), seq: t.store.status().seq };
  await Promise.all(Array.from({ length: 10 }, (_, i) => t.store.write(`app/n${i}.md`, `note ${i}`)));
  assert.equal(t.store.status().seq, before.seq + 1);
  assert.equal(count(t, '_index'), before.idx + 1);
  assert.equal(count(t, '_packs'), before.packs + 1);
  // one bad change in a group does not stop the others
  const res = await Promise.allSettled([t.store.write('app/n0.md/x', 'under a file'), t.store.write('app/ok.md', 'fine')]);
  assert.equal(res[0].status, 'rejected');
  assert.equal(res[0].reason.code, 'NOT_DIR');
  assert.equal(res[1].status, 'fulfilled');
});

test('dedupe: the same content is stored once', async () => {
  const t = await fresh();
  const data = Buffer.alloc(100_000, 7);
  await Promise.all([t.store.write('a/1', data), t.store.write('a/2', data), t.store.write('b/3', data)]);
  const packs = count(t, '_packs');
  assert.equal(packs, 1);
  await t.store.write('c/4', data); // later commit, same content: no new pack
  assert.equal(count(t, '_packs'), packs);
  assert.deepEqual(await t.store.read('c/4'), data);
  assert.equal(t.store.stat('a/1').id, t.store.stat('c/4').id);
  const s2 = await reopen(t); // a shared piece counts once in the pack's live bytes, so the index decodes
  assert.deepEqual(s2.status().problems, []);
  assert.equal(s2.status().seq, t.store.status().seq);
  assert.deepEqual(await s2.read('b/3'), data);
});

test('folders: mkdir, tree, move with contents, and the errors', async () => {
  const { store: s } = await fresh();
  await s.mkdir('n/empty/deeper');
  await s.write('n/a/x.md', 'x');
  await s.write('n/a/sub/y.md', 'y');
  assert.deepEqual(paths(s, 'n/a'), ['n/a/sub/', 'n/a/sub/y.md', 'n/a/x.md']);
  await s.mkdir('n/empty'); // existing folder: fine
  await assert.rejects(s.write('n/a/x.md/z', 'z'), { code: 'NOT_DIR' });
  await assert.rejects(s.write('n/a', 'z'), { code: 'IS_DIR' });
  await assert.rejects(s.mkdir('n/a/x.md'), { code: 'EXISTS' });
  await assert.rejects(s.write('n/A/q.md', 'q'), { code: 'CASE_CLASH' });
  await assert.rejects(s.mkdir('N'), { code: 'CASE_CLASH' });
  await s.move('n/a', 'n/b/moved');
  assert.deepEqual(paths(s, 'n/b'), ['n/b/moved/', 'n/b/moved/sub/', 'n/b/moved/sub/y.md', 'n/b/moved/x.md']);
  assert.throws(() => s.stat('n/a'), { code: 'NOT_FOUND' });
  assert.equal((await s.read('n/b/moved/sub/y.md')).toString(), 'y');
  await assert.rejects(s.move('n/b', 'n/b/moved/inside'), { code: 'BAD_PATH' });
  await assert.rejects(s.move('n/b/moved/x.md', 'n/b/moved/sub/y.md'), { code: 'EXISTS' });
  await assert.rejects(s.move('n/nothing', 'n/z'), { code: 'NOT_FOUND' });
  await s.move('n/b/moved/x.md', 'n/b/moved/X.md'); // a case-only rename is fine
  assert.equal(s.stat('n/b/moved/X.md').kind, 'f');
  assert.throws(() => s.tree('n/b/moved/X.md'), { code: 'NOT_DIR' });
  for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a/b:c', 'con', 'x'.repeat(130)]) assert.throws(() => s.stat(bad), { code: 'BAD_PATH' });
});

test('ifMatch: create-only, replace-if-unchanged, conflicts', async () => {
  const { store: s } = await fresh();
  const a = await s.write('p/n.md', 'one', { ifMatch: null });
  await assert.rejects(s.write('p/n.md', 'two', { ifMatch: null }), { code: 'CONFLICT' });
  const b = await s.write('p/n.md', 'two', { ifMatch: a.id });
  await assert.rejects(s.write('p/n.md', 'three', { ifMatch: a.id }), { code: 'CONFLICT' });
  await assert.rejects(s.move('p/n.md', 'p/m.md', { ifMatch: a.id }), { code: 'CONFLICT' });
  await s.move('p/n.md', 'p/m.md', { ifMatch: b.id });
  assert.equal((await s.read('p/m.md')).toString(), 'two');
});

test('trash: remove files and folders, list, restore, restore elsewhere, survive a reopen', async () => {
  const t = await fresh();
  const s = t.store;
  await s.write('n/f/one.md', '1');
  await s.write('n/f/two.md', '2');
  await s.write('n/keep.md', 'k');
  const { tids } = await s.remove(['n/f']);
  assert.equal(tids.length, 3);
  assert.deepEqual(paths(s), ['n/', 'n/keep.md']);
  assert.deepEqual(s.listTrash().map((e) => e.path).sort(), ['n/f', 'n/f/one.md', 'n/f/two.md']);
  await assert.rejects(s.read('n/f/one.md'), { code: 'NOT_FOUND' });
  const s2 = await reopen(t);
  const one = s2.listTrash().find((e) => e.path === 'n/f/one.md');
  await s2.restore([one.tid], { to: 'n/back.md' });
  assert.equal((await s2.read('n/back.md')).toString(), '1');
  await s2.restore(s2.listTrash().map((e) => e.tid));
  assert.deepEqual(paths(s2), ['n/', 'n/back.md', 'n/f/', 'n/f/two.md', 'n/keep.md']);
  assert.equal(s2.listTrash().length, 0);
  const { tids: [k] } = await s2.remove(['n/keep.md']);
  await s2.write('n/keep.md', 'new');
  await assert.rejects(s2.restore([k]), { code: 'EXISTS' });
  await assert.rejects(s2.restore(['0000000000000000']), { code: 'NOT_FOUND' });
});

test('range reads decrypt only what is needed and match the file; a file bigger than a pack spans two', async () => {
  const { store: s } = await fresh();
  const big = Buffer.alloc(33 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32BE(i, i);
  await s.write('m/big.bin', big);
  for (const [a, b] of [[0, 10], [65530, 65600], [31 * 1024 * 1024 - 5, 31 * 1024 * 1024 + 5], [big.length - 3, big.length], [100, 100]]) {
    assert.deepEqual(await s.read('m/big.bin', { start: a, end: b }), big.subarray(a, b), `${a}-${b}`);
  }
  assert.deepEqual(await s.read('m/big.bin'), big);
  await assert.rejects(s.read('m/big.bin', { start: 5, end: 4 }), { code: 'BAD_INPUT' });
  await assert.rejects(s.read('m/big.bin', { end: big.length + 1 }), { code: 'BAD_INPUT' });
});

test('the newest index that decrypts wins; a damaged newest one is skipped and reported', async () => {
  const t = await fresh();
  await t.store.write('a/1.md', 'one');
  await t.store.write('a/2.md', 'two'); // newest: seq 3
  const s1 = await reopen(t);
  assert.equal(s1.status().seq, 3);
  assert.deepEqual(s1.status().problems, []);
  // find the newest index file and damage it
  const names = readdirSync(join(t.dir, '_index'));
  let newest = null;
  for (const n of names) {
    const f = join(t.dir, '_index', n);
    const saved = readFileSync(f);
    writeFileSync(f, Buffer.concat([saved.subarray(0, 100), Buffer.from([saved[100] ^ 1]), saved.subarray(101)]));
    const s = await reopen(t);
    if (s.status().seq === 2) { newest = n; assert.deepEqual(s.status().problems, ['damaged index file']); assert.deepEqual(paths(s), ['a/', 'a/1.md']); }
    writeFileSync(f, saved);
  }
  assert.ok(newest, 'damaging the newest gave the previous state');
  // a torn index from a pulled stick is a .part: ignored, no problem
  writeFileSync(join(t.dir, '_index', `${newest}.part`), Buffer.alloc(1000));
  const s2 = await reopen(t);
  assert.equal(s2.status().seq, 3);
  assert.deepEqual(s2.status().problems, []);
});

test('header: a damaged or missing main copy falls back to the backup and is reported', async () => {
  const t = await fresh();
  await t.store.write('a/x', 'x');
  const main = join(t.dir, 'vault.json');
  const text = readFileSync(main, 'utf8');
  writeFileSync(main, text.replace(/"hseq\\":1/, '"hseq\\":7'));
  const s = await reopen(t);
  assert.equal(s.status().header, 'backup');
  assert.equal(s.status().problems.length, 1);
  assert.equal((await s.read('a/x')).toString(), 'x');
  rmSync(main);
  assert.equal((await reopen(t)).status().header, 'backup');
  renameSync(join(t.dir, 'vault.bak.json'), main);
  const s3 = await reopen(t); // backup missing: an interrupted header write, not a problem
  assert.equal(s3.status().header, 'main');
  assert.deepEqual(s3.status().problems, []);
  rmSync(main);
  await assert.rejects(reopen(t), { code: 'NO_VAULT' });
});

test('error messages never contain a path or a name from the vault', async () => {
  const { store: s } = await fresh();
  const secretName = 'diary/Kasia-secret-plans.md';
  await s.write(secretName, 'x');
  const errs = await Promise.allSettled([
    s.write(`${secretName}/under`, 'y'), s.write(secretName, 'z', { ifMatch: null }), s.mkdir(secretName),
    s.move('diary/missing-Kasia.md', 'diary/other.md'), s.read('diary/missing-Kasia.md'), s.write('Diary/kasia-SECRET-plans.md', 'c'),
    s.move('diary', 'diary/Kasia-sub'), s.restore(['ffffffffffffffff']),
  ]);
  for (const r of errs) {
    assert.equal(r.status, 'rejected');
    assert.ok(!/kasia|diary|secret|plans/i.test(`${r.reason.message} ${r.reason.stack}`), r.reason.message);
  }
});
