// `vault verify` and `vault export` (hub/cli-vault.mjs), the export rules and the no-echo prompt. TEST ONLY keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { vaultCommand } from '../hub/cli-vault.mjs';
import { readSecret } from '../hub/cli-prompt.mjs';
import { exportVault } from '../hub/vault/export.mjs';
import { buildHeader, parseHeader } from '../hub/vault/header.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPassphrase } from '../hub/vault/header.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
async function fresh() { const t = await makeTestStore(); roots.push(t.root); return t; }

/** A fake terminal that "types" text. */
function tty(text = null, isTTY = true) {
  const s = new PassThrough();
  s.isTTY = isTTY;
  s.raw = [];
  s.setRawMode = (v) => { s.raw.push(v); };
  if (text !== null) s.write(text);
  return s;
}
const sink = () => { const w = new Writable({ write(c, _e, cb) { w.text += c; cb(); } }); w.text = ''; return w; };

/** Run a vault command; returns {code, out, err, prompt}. */
async function cli(args, secret, o = {}) {
  const out = [];
  const err = [];
  const prompt = sink();
  const code = await vaultCommand(args, { input: o.input || tty(secret === null ? null : `${secret}\r`), out: (s) => out.push(s), err: (s) => err.push(s),
    prompt, root: ROOT, mounts: async () => o.mounts || [] });
  return { code, out: out.join('\n'), err: err.join('\n'), prompt: prompt.text };
}

const NAMES = ['notes/Zażółć gęślą-Kq7.md', 'notes/sub/deep/plan-Kq7.txt', 'toString', 'media/big-Kq7.bin'];
async function filled() {
  const t = await fresh();
  const big = randomBytes(3 * 1024 * 1024);
  await t.store.write(NAMES[0], 'Polish note');
  await t.store.write(NAMES[1], 'deep');
  await t.store.write(NAMES[2], 'odd name');
  await t.store.write(NAMES[3], big);
  await t.store.mkdir('notes/empty-Kq7/inner');
  await t.store.close();
  return { ...t, big };
}
const noNames = (text) => assert.ok(!/Kq7|Zażółć|toString/.test(text), 'no note name in the output');

test('the prompt: typing, Backspace, Ctrl-U, paste, arrows, split UTF-8, raw mode on and off', async () => {
  const a = tty('abc\u007fd\r');
  assert.equal(await readSecret('P: ', { input: a, output: sink() }), 'abd');
  assert.deepEqual(a.raw, [true, false]);
  assert.equal(await readSecret('P: ', { input: tty('abc\u0015xy\n'), output: sink() }), 'xy');
  assert.equal(await readSecret('P: ', { input: tty('\u001b[200~my  pass phrase\u001b[201~\r'), output: sink() }), 'my  pass phrase');
  assert.equal(await readSecret('P: ', { input: tty('a\u001b[Db\u001bOc\r'), output: sink() }), 'ab');
  const split = tty();
  const bytes = Buffer.from('zażółć\r');
  const out = sink();
  const p = readSecret('P: ', { input: split, output: out });
  split.write(bytes.subarray(0, 3)); // cuts "ż" in half
  split.write(bytes.subarray(3));
  assert.equal(await p, 'zażółć');
  assert.equal(out.text, 'P: \n', 'nothing echoed');
  await assert.rejects(readSecret('P: ', { input: tty('abc\u0003'), output: sink() }), { code: 'CANCELLED' });
  const ended = tty('abc');
  const q = readSecret('P: ', { input: ended, output: sink() });
  ended.end();
  await assert.rejects(q, { code: 'CANCELLED' });
});

test('export: names, contents, empty folders and a 3 MiB file come out; no .part left; the warning is printed', async () => {
  const t = await filled();
  const dest = join(t.root, 'plain');
  const r = await cli(['export', t.dir, dest], t.v.passphrase);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(dest, 'notes', 'Zażółć gęślą-Kq7.md'), 'utf8'), 'Polish note');
  assert.equal(readFileSync(join(dest, 'notes', 'sub', 'deep', 'plan-Kq7.txt'), 'utf8'), 'deep');
  assert.equal(readFileSync(join(dest, 'toString'), 'utf8'), 'odd name');
  assert.deepEqual(readFileSync(join(dest, 'media', 'big-Kq7.bin')), t.big);
  assert.ok(statSync(join(dest, 'notes', 'empty-Kq7', 'inner')).isDirectory());
  const all = (d) => readdirSync(d, { recursive: true });
  assert.deepEqual(all(dest).filter((n) => n.endsWith('.part')), []);
  assert.match(r.out, /Exported 4 files/);
  assert.match(r.out, /NOT encrypted/);
  noNames(r.out + r.err + r.prompt);
  const again = await cli(['export', t.dir, join(t.root, 'plain2'), '--paper'], t.v.paperCode);
  assert.equal(again.code, 0, again.err);
});

test('export refuses: a non-empty folder, inside the vault, inside this clone, on a stick, a file; nothing is asked', async () => {
  const t = await filled();
  mkdirSync(join(t.root, 'full'));
  writeFileSync(join(t.root, 'full', 'x'), 'x');
  writeFileSync(join(t.root, 'afile'), 'x');
  const inClone = join(ROOT, `export-must-not-exist-${randomBytes(4).toString('hex')}`);
  const cases = [
    [join(t.root, 'full'), {}], [join(t.dir, 'inside'), {}], [join(t.dir, '_packs', 'x'), {}], [inClone, {}],
    [join(t.root, 'stick', 'plain'), { mounts: [join(t.root, 'stick')] }], [join(t.root, 'afile'), {}],
  ];
  for (const [dest, o] of cases) {
    const r = await cli(['export', t.dir, dest], t.v.passphrase, o);
    assert.equal(r.code, 1, dest);
    assert.equal(r.prompt, '', 'refused before the passphrase was asked');
  }
  assert.ok(!existsSync(inClone));
  assert.ok(!existsSync(join(t.root, 'stick')));
});

test('a wrong passphrase creates nothing', async () => {
  const t = await filled();
  const dest = join(t.root, 'never');
  const r = await cli(['export', t.dir, dest], 'wrong passphrase here');
  assert.equal(r.code, 1);
  assert.match(r.err, /does not open/);
  assert.ok(!existsSync(dest));
});

test('verify: a clean vault is OK (full, quick, json, paper code)', async () => {
  const t = await filled();
  const r = await cli(['verify', t.dir], t.v.passphrase);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK/);
  assert.match(r.out, /files: 4 checked, 0 bad/);
  assert.equal((await cli(['verify', t.dir, '--quick'], t.v.passphrase)).code, 0);
  const j = JSON.parse((await cli(['verify', t.dir, '--json', '--paper'], t.v.paperCode)).out);
  assert.equal(j.ok, true);
  noNames(r.out);
});

test('verify finds a flipped byte in a pack, a damaged index, a missing pack and unequal header copies', async () => {
  const flip = (f, at) => { const b = readFileSync(f); b[at] ^= 1; writeFileSync(f, b); };
  const packs = (t) => readdirSync(join(t.dir, '_packs'));
  // a flipped byte in a pack: full finds it, quick (sizes only) does not
  let t = await filled();
  const p = join(t.dir, '_packs', packs(t)[0]);
  flip(p, 2000);
  let r = await cli(['verify', t.dir], t.v.passphrase);
  assert.equal(r.code, 1);
  assert.match(r.out, /damaged pack: [a-z2-7]{26}\.vx/);
  assert.equal((await cli(['verify', t.dir, '--quick'], t.v.passphrase)).code, 0);
  noNames(r.out);
  // a damaged index file
  t = await filled();
  await (await openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase))).write('x/one-more', 'm');
  const idx = readdirSync(join(t.dir, '_index'));
  flip(join(t.dir, '_index', idx[0]), 3000);
  r = await cli(['verify', t.dir], t.v.passphrase);
  assert.equal(r.code, 1);
  assert.match(r.out, /damaged index: [a-z2-7]{26}\.vx/);
  // a missing pack
  t = await filled();
  rmSync(join(t.dir, '_packs', packs(t)[0]));
  r = await cli(['verify', t.dir, '--quick'], t.v.passphrase);
  assert.equal(r.code, 1);
  assert.match(r.out, /missing pack: [a-z2-7]{26}\.vx/);
  // unequal header copies (both valid)
  t = await filled();
  const h = parseHeader(readFileSync(join(t.dir, 'vault.json'), 'utf8'));
  writeFileSync(join(t.dir, 'vault.bak.json'), buildHeader({ vaultId: h.vaultId, epoch: 1, hseq: h.hseq + 1, slots: h.slots }, t.v.dk));
  r = await cli(['verify', t.dir], t.v.passphrase);
  assert.equal(r.code, 1);
  assert.match(r.out, /copies NOT equal/);
});

test('export: a pack the running hub removed meanwhile -> one reopen with the same key; a second miss is damage', async () => {
  const t = await filled();
  const open = () => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase), { autoCleanupEvery: 0 });
  const mine = await open(); // the export's store
  const hub = await open(); // "the running hub"
  await hub.write(NAMES[1], 'deep, newer');
  await hub.write('x/a', 'a');
  await hub.write('x/b', 'b');
  assert.equal((await hub.cleanup()).level, 'full'); // the old pack of NAMES[1] is gone
  const dest = join(t.root, 'out1');
  const r = await exportVault(mine, dest);
  assert.equal(readFileSync(join(dest, 'notes', 'sub', 'deep', 'plan-Kq7.txt'), 'utf8'), 'deep, newer');
  assert.notEqual(r.store, mine, 'reopened once');
  // now packs the newest index uses are gone for real: reopening does not help -> damage
  const s = await open();
  for (const n of readdirSync(join(t.dir, '_packs'))) rmSync(join(t.dir, '_packs', n));
  await assert.rejects(exportVault(s, join(t.root, 'out2')), { code: 'PACK_MISSING' });
  assert.deepEqual(readdirSync(join(t.root, 'out2'), { recursive: true }).filter((n) => n.endsWith('.part')), []);
});

test('no terminal, or bad arguments: refused', async () => {
  const t = await filled();
  const r = await cli(['verify', t.dir], null, { input: tty('x\r', false) });
  assert.equal(r.code, 1);
  assert.match(r.err, /terminal/);
  for (const args of [[], ['verify'], ['export', t.dir], ['verify', t.dir, '--passphrase=x'], ['export', t.dir, 'd', '--quick'], ['nuke', t.dir]]) {
    assert.equal((await cli(args, null)).code, 2, args.join(' '));
  }
});
