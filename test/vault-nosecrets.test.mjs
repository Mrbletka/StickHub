// No secret in any output: a recording logger catches everything written to the console, stdout and stderr while
// every vault operation and every failure runs; then no passphrase, paper code, data key or subkey (nor any 12-char
// piece of them, in any encoding) may appear there, in an error message or stack, or in the header. TEST ONLY secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { subkeys } from '../hub/vault/keys.mjs';
import { parseHeader, unlockWithPassphrase, unlockWithPaperCode, verifyHeaderMac, buildHeader } from '../hub/vault/header.mjs';
import { makePassphraseSlot, makeRecoverySlot, openPassphraseSlot, openRecoverySlot } from '../hub/vault/slots.mjs';
import { checkOwnPassphrase, normalizePassphrase, passphraseKey } from '../hub/vault/kdf.mjs';
import { parsePaperCode, formatPaperCode, generatePaperCode } from '../hub/vault/papercode.mjs';
import { sealVx, openVx, createSealStream, createOpenStream, newFileId } from '../hub/vault/vx.mjs';
import { generatePassphrase } from '../hub/vault/words.mjs';
import { VaultError } from '../hub/vault/errors.mjs';
import { makeTestVault } from './vault-helpers.mjs';

/** Record console.* and process.stdout/stderr writes (still passing them on) until stop(). */
function record() {
  const lines = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    saved[m] = console[m];
    console[m] = (...a) => { lines.push(a.map(String).join(' ')); saved[m](...a); };
  }
  const writes = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = function (c, ...a) { lines.push(String(c)); return writes.out.call(this, c, ...a); };
  process.stderr.write = function (c, ...a) { lines.push(String(c)); return writes.err.call(this, c, ...a); };
  return {
    text: () => lines.join('\n'),
    stop() { Object.assign(console, saved); process.stdout.write = writes.out; process.stderr.write = writes.err; },
  };
}

/** Every 12-character piece of s. */
const pieces = (s) => { const out = []; for (let i = 0; i + 12 <= s.length; i++) out.push(s.slice(i, i + 12)); return out.length ? out : [s]; };
const encodings = (b) => [b.toString('hex'), b.toString('base64'), b.toString('base64url')];

test('no secret shows up in any output, error or header', async () => {
  const rec = record();
  const errors = [];
  const fails = async (fn) => {
    try { await fn(); } catch (e) { errors.push(e); return; }
    throw new Error('expected a failure');
  };
  let v;
  let keys;
  let ownPass;
  try {
    v = await makeTestVault({ passphrase: 'TEST-ONLY-Qx7Zr9LmWv2Kp8Ns' }); // no common words: a piece cannot match normal text
    ownPass = 'TEST-ONLY-own-Hj4Tq8Bz3Yc6';
    generatePassphrase();
    const h = parseHeader(v.text);
    const ctx = { vaultId: v.vaultId, epoch: v.epoch };
    await unlockWithPassphrase(h, v.passphrase);
    await unlockWithPaperCode(h, v.paperCode);
    keys = subkeys(v.dk, v.vaultId, v.epoch);
    const fctx = { kFile: keys.file, vaultId: v.vaultId, epoch: v.epoch };
    const fileId = newFileId();
    const payload = Buffer.from(`TEST ONLY note ${v.passphrase}`);
    const file = sealVx(payload, fctx, { kind: 'pack', fileId });
    openVx(file, fctx, { kind: 'pack', fileId });
    // failures of every kind
    const typo = v.paperCode.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await fails(() => unlockWithPassphrase(h, `${v.passphrase}x`));
    await fails(() => unlockWithPaperCode(h, typo));
    await fails(() => unlockWithPaperCode(h, formatPaperCode(generatePaperCode())));
    await fails(() => openPassphraseSlot(v.ps, v.passphrase, { ...ctx, epoch: 9 }));
    await fails(() => openRecoverySlot(v.rs, v.paperCode, { ...ctx, epoch: 9 }));
    await fails(() => verifyHeaderMac(h, Buffer.alloc(32)));
    await fails(() => unlockWithPassphrase(parseHeader(v.text.replace('\\"hseq\\":1', '\\"hseq\\":2')), v.passphrase));
    await fails(() => parseHeader(v.text.slice(0, 50)));
    await fails(() => parseHeader(v.text.replace(v.ps.nonce, `${v.ps.nonce}x`)));
    await fails(() => checkOwnPassphrase(v.passphrase.slice(0, 15)));
    await fails(() => normalizePassphrase(`${ownPass}\uD800`));
    await fails(() => passphraseKey(Buffer.from(ownPass), { alg: 'argon2id', m: 1 << 30, t: 1, p: 1 }, Buffer.alloc(16), Buffer.alloc(32)));
    await fails(() => parsePaperCode(`${v.paperCode}Q`));
    await fails(() => makeRecoverySlot({ dk: v.dk, ...ctx, paperCode: typo }));
    await fails(() => makePassphraseSlot({ dk: v.dk.subarray(1), ...ctx, passphrase: ownPass }));
    await fails(() => buildHeader({ vaultId: v.vaultId, epoch: 1, hseq: 1, slots: [v.ps, v.ps] }, v.dk));
    const bad = Buffer.from(file);
    bad[100] ^= 1;
    await fails(() => openVx(bad, fctx, { kind: 'pack', fileId }));
    await fails(() => openVx(file, fctx, { kind: 'pack', fileId: newFileId() }));
    await fails(() => pipeline(Readable.from([bad]), createOpenStream(fctx, { kind: 'pack', fileId }), new Writable({ write(_c, _e, cb) { cb(); } })));
    await fails(() => pipeline(Readable.from([payload, payload]), createSealStream(fctx, { kind: 'pack', fileId, size: payload.length }), new Writable({ write(_c, _e, cb) { cb(); } })));
  } finally {
    rec.stop();
  }

  assert.ok(errors.length >= 20, `${errors.length} failures recorded`);
  for (const e of errors) assert.ok(e instanceof VaultError && typeof e.code === 'string', `${e.name}: a VaultError with a code`);
  const secretTexts = [v.passphrase, ownPass, v.paperCode, v.paperCode.replace(/-/g, ''), parsePaperCode(v.paperCode)];
  const secretBytes = [v.dk, keys.header, keys.contentId, keys.file, normalizePassphrase(v.passphrase)];
  const needles = [...secretTexts.flatMap(pieces), ...secretBytes.flatMap(encodings).flatMap(pieces)];
  const haystacks = {
    output: rec.text(),
    errors: errors.map((e) => `${e.code} ${e.message}\n${e.stack}\n${JSON.stringify(e)}`).join('\n'),
    header: v.text,
  };
  for (const [where, hay] of Object.entries(haystacks)) {
    for (const n of needles) assert.ok(!hay.includes(n), `a piece of a secret appears in ${where}`);
  }
});

test('the store: no secret, note name or note text shows up in any output or error', async () => {
  const { makeTestStore } = await import('./vault-helpers.mjs');
  const { openVaultFolder } = await import('../hub/vault/store.mjs');
  const { rmSync, writeFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const name = 'Private-Qz8Kw/Letter-to-Mw4Rt.md';
  const text = 'TEST-ONLY note body Hv5Lp9Xc';
  const rec = record();
  const errors = [];
  const fails = async (fn) => {
    try { await fn(); } catch (e) { errors.push(e); return; }
    throw new Error('expected a failure');
  };
  let t;
  try {
    t = await makeTestStore();
    const s = t.store;
    await s.write(name, text);
    await s.read(name);
    await s.read(name, { start: 2, end: 9 });
    await fails(() => s.write(`${name}/under`, text));
    await fails(() => s.write(name, text, { ifMatch: null }));
    await fails(() => s.mkdir(name));
    await fails(() => s.move(name, 'Private-Qz8Kw'));
    await fails(() => s.write('private-qz8kw/Other-Mw4Rt.md', text));
    await fails(() => s.read(`${name}.missing`));
    await fails(() => s.stat('Private-Qz8Kw/../Letter-to-Mw4Rt.md'));
    await fails(() => s.restore(['0123456789abcdef']));
    await s.remove([name]);
    await s.cleanup();
    for (const n of readdirSync(join(t.dir, '_index'))) writeFileSync(join(t.dir, '_index', n), 'damaged');
    await fails(() => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, t.v.passphrase)));
    await fails(() => openVaultFolder(t.dir, (h) => unlockWithPassphrase(h, `${t.v.passphrase}x`)));
    await s.close();
    await fails(() => s.read(name));
  } finally {
    rec.stop();
    if (t) rmSync(t.root, { recursive: true, force: true });
  }
  assert.ok(errors.length >= 11, `${errors.length} failures recorded`);
  for (const e of errors) assert.ok(e instanceof VaultError, `${e.name}: a VaultError`);
  const needles = [...['Private-Qz8Kw', 'Letter-to-Mw4Rt', 'Qz8Kw', 'Mw4Rt', 'Hv5Lp9Xc', t.v.passphrase].flatMap((x) => [x, x.toLowerCase()]),
    ...encodings(t.v.dk).flatMap(pieces)];
  const hay = `${rec.text()}\n${errors.map((e) => `${e.code} ${e.message}\n${e.stack}\n${JSON.stringify(e)}`).join('\n')}`;
  for (const n of needles) assert.ok(!hay.includes(n), 'a note name, note text or key appears in the output or an error');
});
