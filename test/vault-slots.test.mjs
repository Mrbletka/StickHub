// Key slots: they open with the right secret only, and any change to a slot, or moving it to another vault, epoch or
// slot, makes it fail. KDF settings over the limits are refused before any KDF runs. TEST ONLY secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePassphraseSlot, makeRecoverySlot, openPassphraseSlot, openRecoverySlot, validateSlot } from '../hub/vault/slots.mjs';
import { formatPaperCode, generatePaperCode } from '../hub/vault/papercode.mjs';
import { makeTestVault, countKdfCalls, SMALL_KDF } from './vault-helpers.mjs';

const v = await makeTestVault();
const ctx = { vaultId: v.vaultId, epoch: v.epoch };

/** Every variant of b64u field `key` (in obj) with one bit flipped in one byte. */
function* flips(obj, key) {
  const b = Buffer.from(obj[key], 'base64url');
  for (let i = 0; i < b.length; i++) {
    const c = Buffer.from(b);
    c[i] ^= 1 << (i % 8);
    yield { ...obj, [key]: c.toString('base64url') };
  }
}

test('the right passphrase and the right paper code open their slots', async () => {
  assert.deepEqual(await openPassphraseSlot(v.ps, v.passphrase, ctx), v.dk);
  assert.deepEqual(openRecoverySlot(v.rs, v.paperCode, ctx), v.dk);
  assert.deepEqual(openRecoverySlot(v.rs, v.paperCode.toLowerCase().replace(/-/g, ' '), ctx), v.dk);
});

test('the passphrase opens with stray spaces, tabs or a trailing newline, but not in another case', async () => {
  const typed = `  ${v.passphrase.replace(/ /g, '  \t')}\n`;
  assert.deepEqual(await openPassphraseSlot(v.ps, typed, ctx), v.dk);
  await assert.rejects(openPassphraseSlot(v.ps, v.passphrase.replace(/ /g, ''), ctx), { code: 'WRONG_SECRET' });
});

test('a wrong passphrase or another valid paper code fails', async () => {
  await assert.rejects(openPassphraseSlot(v.ps, `${v.passphrase}!`, ctx), { code: 'WRONG_SECRET' });
  await assert.rejects(openPassphraseSlot(v.ps, v.passphrase.toUpperCase(), ctx), { code: 'WRONG_SECRET' });
  assert.throws(() => openRecoverySlot(v.rs, formatPaperCode(generatePaperCode()), ctx), { code: 'WRONG_SECRET' });
});

test('passphrase slot: changing any byte of id, salt, nonce or wrapped key fails', async () => {
  const variants = [...flips(v.ps, 'id'), ...flips(v.ps, 'nonce'), ...flips(v.ps, 'wrapped')];
  for (const k of flips(v.ps.kdf, 'salt')) variants.push({ ...v.ps, kdf: k });
  assert.equal(variants.length, 16 + 12 + 48 + 16);
  for (const s of variants) await assert.rejects(openPassphraseSlot(s, v.passphrase, ctx), { code: 'WRONG_SECRET' });
});

test('passphrase slot: changing the KDF settings fails', async () => {
  const k = v.ps.kdf;
  for (const kdf of [{ ...k, m: 2048 }, { ...k, t: 2 }, { ...k, p: 2 }, { alg: 'scrypt', N: 1024, r: 8, p: 1, salt: k.salt }]) {
    await assert.rejects(openPassphraseSlot({ ...v.ps, kdf }, v.passphrase, ctx), { code: 'WRONG_SECRET' }, JSON.stringify(kdf));
  }
});

test('recovery slot: changing any byte of id, salt, nonce or wrapped key fails', () => {
  const variants = [...flips(v.rs, 'id'), ...flips(v.rs, 'salt'), ...flips(v.rs, 'nonce'), ...flips(v.rs, 'wrapped')];
  assert.equal(variants.length, 16 + 32 + 12 + 48);
  for (const s of variants) assert.throws(() => openRecoverySlot(s, v.paperCode, ctx), { code: 'WRONG_SECRET' });
});

test('changing the vault id or the epoch fails', async () => {
  for (const c of [{ ...ctx, epoch: 2 }, { ...ctx, vaultId: Buffer.from(v.vaultId).fill(0, 0, 1) }]) {
    await assert.rejects(openPassphraseSlot(v.ps, v.passphrase, c), { code: 'WRONG_SECRET' });
    assert.throws(() => openRecoverySlot(v.rs, v.paperCode, c), { code: 'WRONG_SECRET' });
  }
});

test('a slot moved to another vault, or given another slot id, fails', async () => {
  const other = await makeTestVault({ passphrase: v.passphrase });
  const otherCtx = { vaultId: other.vaultId, epoch: other.epoch };
  await assert.rejects(openPassphraseSlot(v.ps, v.passphrase, otherCtx), { code: 'WRONG_SECRET' });
  assert.throws(() => openRecoverySlot(v.rs, v.paperCode, otherCtx), { code: 'WRONG_SECRET' });
  // the same passphrase in another vault gives another key, and slot ids are bound too
  await assert.rejects(openPassphraseSlot({ ...v.ps, id: other.ps.id }, v.passphrase, ctx), { code: 'WRONG_SECRET' });
  assert.throws(() => openRecoverySlot({ ...v.rs, id: v.ps.id }, v.paperCode, ctx), { code: 'WRONG_SECRET' });
});

test('a huge KDF memory setting is refused before any KDF runs', async () => {
  const huge = { ...v.ps, kdf: { ...v.ps.kdf, m: 4 * 1024 * 1024 } };
  assert.throws(() => validateSlot(huge), { code: 'BAD_HEADER' });
  const calls = await countKdfCalls(async () => {
    await assert.rejects(openPassphraseSlot(huge, v.passphrase, ctx), { code: 'BAD_HEADER' });
    await assert.rejects(makePassphraseSlot({ dk: v.dk, ...ctx, passphrase: 'x', kdf: { alg: 'argon2id', m: 4194304, t: 3, p: 4 } }), { code: 'KDF_LIMITS' });
  });
  assert.equal(calls, 0);
  assert.equal(await countKdfCalls(() => openPassphraseSlot(v.ps, v.passphrase, ctx)), 1, 'the counter works');
});

test('a typo in the paper code is caught before any key work', () => {
  const typo = v.paperCode.slice(0, 3) + (v.paperCode[3] === 'A' ? 'B' : 'A') + v.paperCode.slice(4);
  assert.throws(() => openRecoverySlot(v.rs, typo, ctx), { code: 'BAD_CODE' });
});

test('a kept paper code makes a new slot that opens with the same code', () => {
  const { slot, paperCode } = makeRecoverySlot({ dk: v.dk, ...ctx, paperCode: v.paperCode.toLowerCase() });
  assert.equal(paperCode, v.paperCode);
  assert.notEqual(slot.id, v.rs.id);
  assert.notEqual(slot.salt, v.rs.salt);
  assert.deepEqual(openRecoverySlot(slot, v.paperCode, ctx), v.dk);
});

test('scrypt slots work (devices without Argon2id)', async () => {
  const s = await makePassphraseSlot({ dk: v.dk, ...ctx, passphrase: v.passphrase, kdf: { alg: 'scrypt', N: 1024, r: 8, p: 1 } });
  assert.deepEqual(Object.keys(s.kdf), ['alg', 'N', 'r', 'p', 'salt']);
  assert.deepEqual(await openPassphraseSlot(s, v.passphrase, ctx), v.dk);
  await assert.rejects(openPassphraseSlot(s, 'wrong', ctx), { code: 'WRONG_SECRET' });
});

test('slot schema: exact fields, canonical base64url, exact sizes', () => {
  const bad = [
    { ...v.ps, extra: 1 }, { ...v.ps, nonce: undefined }, { ...v.ps, type: 'pin' },
    { ...v.ps, nonce: `${v.ps.nonce}A` }, { ...v.ps, wrapped: v.ps.wrapped.slice(0, -2) },
    { ...v.ps, id: Buffer.from(v.ps.id, 'base64url').toString('base64') + '==' },
    { ...v.ps, kdf: { ...v.ps.kdf, extra: 1 } }, { ...v.ps, kdf: { ...v.ps.kdf, alg: 'pbkdf2' } },
    { ...v.rs, salt: v.ps.kdf.salt }, // 16 bytes where 32 are needed
    { ...v.rs, kdf: v.ps.kdf },
    { id: v.rs.id, type: 'device', sign: 'SHA1withRSA', challenge: v.rs.salt, salt: v.rs.salt, nonce: v.rs.nonce, wrapped: v.rs.wrapped },
    null, [], 'slot',
  ];
  for (const s of bad) assert.throws(() => validateSlot(JSON.parse(JSON.stringify(s ?? null))), { code: 'BAD_HEADER' }, JSON.stringify(s));
  const device = { id: v.rs.id, type: 'device', sign: 'SHA256withRSA', challenge: v.rs.salt, salt: v.rs.salt, nonce: v.rs.nonce, wrapped: v.rs.wrapped };
  assert.deepEqual(validateSlot(device), device, 'v2 device slots pass the schema (v1 does not open them)');
  assert.deepEqual(validateSlot(v.ps), v.ps);
  assert.equal(SMALL_KDF.m, v.ps.kdf.m);
});
