// `vault dev-create` (DEV ONLY, hub/devvault.mjs): a new vault with generated words and a paper code, shown once,
// confirmed by typing the passphrase back; nothing is written before that. TEST ONLY KDF settings; temp folders only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultCommand } from '../hub/cli-vault.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPaperCode, unlockWithPassphrase } from '../hub/vault/header.mjs';
import { SMALL_KDF } from './vault-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'devvault-')); roots.push(d); return d; };

function tty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}
const sink = () => { const w = new Writable({ write(c, _e, cb) { w.text += c; cb(); } }); w.text = ''; return w; };

/**
 * Run dev-create; answer(passphrase, try) gives what the person types back (null = the shown passphrase).
 * @returns {Promise<{code: number, out: string, err: string, passphrase: string|null, paper: string|null}>}
 */
async function devCreate(args, answer = () => null, o = {}) {
  const input = tty();
  const out = [];
  const err = [];
  let shown = null;
  let tries = 0;
  const prompt = sink();
  const typeBack = () => { const a = answer(shown, tries++); input.write(`${a ?? shown}\r`); };
  const realWrite = prompt.write.bind(prompt);
  prompt.write = (c, ...rest) => { const r = realWrite(c, ...rest); if (String(c).startsWith('Type the passphrase')) setImmediate(typeBack); return r; };
  const code = await vaultCommand(['dev-create', ...args], { input, prompt, outTTY: o.outTTY ?? true, kdf: SMALL_KDF, root: ROOT, home: o.home,
    mounts: async () => o.mounts || [],
    out: (s) => { out.push(s); const m = /Passphrase: {2}(.+)/.exec(s); if (m) shown = m[1]; },
    err: (s) => err.push(s) });
  const text = out.join('\n');
  return { code, out: text, err: err.join('\n'), passphrase: shown, paper: /Paper code: {2}(.+)/.exec(text)?.[1] ?? null };
}

test('dev-create: 5 words and a paper code shown once, typed back, then the vault opens with either', async () => {
  const dir = join(tmp(), 'vault-dev');
  const r = await devCreate([dir], (_p, n) => (n === 0 ? 'not the words' : null));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.passphrase.split(' ').length, 5);
  assert.match(r.paper, /^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  assert.equal(r.out.split(r.passphrase).length, 2, 'the passphrase is shown exactly once');
  assert.match(r.err, /That is not it\. Try again\./);
  assert.match(r.out, /\u001b\[2J\u001b\[3J/, 'the screen is cleared after');
  assert.match(r.out, /DEV ONLY/);
  const store = await openVaultFolder(dir, (h) => unlockWithPassphrase(h, r.passphrase));
  assert.equal(store.status().files, 0);
  await store.close();
  const byPaper = await openVaultFolder(dir, (h) => unlockWithPaperCode(h, r.paper));
  await byPaper.close();
  // nothing readable on disk: no word of the passphrase, no paper code
  for (const f of readdirSync(dir, { recursive: true })) {
    if (!f.includes('.')) continue;
    const text = readFileSync(join(dir, f), 'latin1');
    for (const w of [...r.passphrase.split(' ').filter((x) => x.length > 3), r.paper]) assert.ok(!text.includes(w), f);
  }
});

test('dev-create: three wrong answers write nothing', async () => {
  const dir = join(tmp(), 'vault-dev');
  const r = await devCreate([dir], () => 'wrong words');
  assert.equal(r.code, 1);
  assert.match(r.err, /Nothing was created/);
  assert.equal(existsSync(dir), false);
});

test('dev-create: refuses a pipe, a folder in the clone, on a stick or not empty; default folder in home', async () => {
  const base = tmp();
  assert.match((await devCreate([join(base, 'a')], undefined, { outTTY: false })).err, /run it in a terminal/);
  assert.match((await devCreate([join(ROOT, 'data', 'vault-x')])).err, /inside the StickHub folder/);
  assert.match((await devCreate([join(base, 'stick', 'v')], undefined, { mounts: [join(base, 'stick')] })).err, /on a stick/);
  mkdirSync(join(base, 'full'));
  writeFileSync(join(base, 'full', 'x'), 'x');
  assert.match((await devCreate([join(base, 'full')])).err, /empty or not exist/);
  const home = join(base, 'home');
  const r = await devCreate([], undefined, { home });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(home, 'vault-dev', 'vault.json')));
  assert.equal((await vaultCommand(['dev-create', 'a', 'b'], { err: () => {}, root: ROOT })), 2);
});
