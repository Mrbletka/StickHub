// Vault KDFs: published test vectors (RFC 9106, 7914, 5869, the GCM spec), limits checked before running,
// NFKC normalization, the own-passphrase rule, and one run with the real Argon2id settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, argon2Sync, scryptSync } from 'node:crypto';
import {
  ARGON2ID_DEFAULT, SCRYPT_DEFAULT, checkKdf, normalizePassphrase, canonicalPassphrase, checkOwnPassphrase, passphraseKey, hkdf, hasArgon2,
} from '../hub/vault/kdf.mjs';
import { subkeys } from '../hub/vault/keys.mjs';

const hex = (h) => Buffer.from(h, 'hex');

test('Argon2id gives the RFC 9106 (5.3) answer', { skip: !hasArgon2 && 'this Node has no Argon2id (the scrypt path is used)' }, () => {
  const k = argon2Sync('argon2id', { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3),
    associatedData: Buffer.alloc(12, 4), parallelism: 4, tagLength: 32, memory: 32, passes: 3 });
  assert.equal(k.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('scrypt gives the RFC 7914 answer', () => {
  const k = scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 });
  assert.equal(k.toString('hex'), 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640');
});

test('hkdf() gives the RFC 5869 answers (A.1 and A.3)', () => {
  const a1 = hkdf(Buffer.alloc(22, 0x0b), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42);
  assert.equal(a1.toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  const a3 = hkdf(Buffer.alloc(22, 0x0b), Buffer.alloc(0), '', 42);
  assert.equal(a3.toString('hex'), '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
});

test('AES-256-GCM gives the GCM spec answers (test cases 13 and 14)', () => {
  const run = (pt) => {
    const c = createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return [ct.toString('hex'), c.getAuthTag().toString('hex')];
  };
  assert.deepEqual(run(Buffer.alloc(0)), ['', '530f8afbc74536b9a963b4f1c4cb738b']);
  assert.deepEqual(run(Buffer.alloc(16)), ['cea7403d4d606b6e074ec5d3baf39d18', 'd0d1c8a799996bf0265b98b5d48ab919']);
  const d = createDecipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
  d.setAuthTag(hex('d0d1c8a799996bf0265b98b5d48ab919'));
  assert.deepEqual(Buffer.concat([d.update(hex('cea7403d4d606b6e074ec5d3baf39d18')), d.final()]), Buffer.alloc(16));
});

test('the default KDF settings are the reviewed ones and within the limits', () => {
  assert.deepEqual({ ...ARGON2ID_DEFAULT }, { alg: 'argon2id', m: 262144, t: 3, p: 4 });
  assert.deepEqual({ ...SCRYPT_DEFAULT }, { alg: 'scrypt', N: 131072, r: 8, p: 1 });
  checkKdf(ARGON2ID_DEFAULT);
  checkKdf(SCRYPT_DEFAULT);
});

test('checkKdf refuses settings outside the limits (design 4.2)', () => {
  const bad = [
    null, {}, { alg: 'pbkdf2' },
    { alg: 'argon2id', m: 1048577, t: 3, p: 4 }, { alg: 'argon2id', m: 2 ** 31, t: 3, p: 4 },
    { alg: 'argon2id', m: 262144, t: 11, p: 4 }, { alg: 'argon2id', m: 262144, t: 0, p: 4 },
    { alg: 'argon2id', m: 262144, t: 3, p: 9 }, { alg: 'argon2id', m: 16, t: 3, p: 4 }, { alg: 'argon2id', m: 1.5, t: 3, p: 1 },
    { alg: 'argon2id', m: '262144', t: 3, p: 4 },
    { alg: 'scrypt', N: 2 ** 21, r: 8, p: 1 }, { alg: 'scrypt', N: 3000, r: 8, p: 1 }, { alg: 'scrypt', N: 2 ** 20, r: 16, p: 1 },
    { alg: 'scrypt', N: 1024, r: 33, p: 1 }, { alg: 'scrypt', N: 1024, r: 8, p: 5 },
  ];
  for (const k of bad) assert.throws(() => checkKdf(k), { code: 'KDF_LIMITS' }, JSON.stringify(k));
  checkKdf({ alg: 'argon2id', m: 1048576, t: 10, p: 8 });
  checkKdf({ alg: 'scrypt', N: 2 ** 20, r: 8, p: 4 });
});

test('a huge KDF memory setting is refused before the KDF runs', async () => {
  const t0 = performance.now();
  await assert.rejects(passphraseKey(Buffer.from('x'), { alg: 'argon2id', m: 4194304, t: 3, p: 4 }, Buffer.alloc(16), Buffer.alloc(32)), { code: 'KDF_LIMITS' });
  await assert.rejects(passphraseKey(Buffer.from('x'), { alg: 'scrypt', N: 2 ** 24, r: 8, p: 1 }, Buffer.alloc(16), Buffer.alloc(32)), { code: 'KDF_LIMITS' });
  assert.ok(performance.now() - t0 < 200, 'refused at once, nothing ran');
});

test('NFKC: the same Polish word typed two ways gives the same bytes', () => {
  const composed = 'zażółć gęślą jaźń';
  const decomposed = composed.normalize('NFD');
  assert.notEqual(composed, decomposed);
  assert.deepEqual(normalizePassphrase(decomposed), normalizePassphrase(composed));
  assert.deepEqual(normalizePassphrase('ﬁsh'), Buffer.from('fish')); // the "fi" ligature
  assert.throws(() => normalizePassphrase(''), { code: 'BAD_INPUT' });
  assert.throws(() => normalizePassphrase('\uD800x'), { code: 'BAD_INPUT' }); // lone surrogate
  assert.throws(() => normalizePassphrase('x'.repeat(1025)), { code: 'BAD_INPUT' });
  assert.throws(() => normalizePassphrase(42), { code: 'BAD_INPUT' });
});

test('canonical passphrase: trimmed, whitespace runs collapsed, case kept', () => {
  const want = 'red fox jumps';
  for (const typed of ['red fox jumps ', ' red fox jumps', 'red  fox jumps', 'red\tfox\njumps', 'red\u00a0fox\u00a0jumps',
    '\t red \r\n fox   jumps \n', 'red\u3000fox\u2003jumps']) {
    assert.equal(canonicalPassphrase(typed), want, JSON.stringify(typed));
    assert.deepEqual(normalizePassphrase(typed), Buffer.from(want));
  }
  assert.notEqual(canonicalPassphrase('Red fox jumps'), want, 'no case folding');
  assert.equal(canonicalPassphrase('redfoxjumps'), 'redfoxjumps', 'spaces are not removed, only collapsed');
  assert.equal(canonicalPassphrase('zażółć  gęślą '.normalize('NFD')), 'zażółć gęślą'.normalize('NFC'), 'Polish letters in two spellings');
  assert.throws(() => canonicalPassphrase(' \t\n '), { code: 'BAD_INPUT' });
});

test('an own passphrase needs 20 characters in its canonical form', () => {
  assert.throws(() => checkOwnPassphrase('  nineteen    characters  '), { code: 'WEAK_PASSPHRASE' }); // 19 after collapsing
  checkOwnPassphrase('twenty  characters ok\n');
  assert.throws(() => checkOwnPassphrase('nineteen characters'), { code: 'WEAK_PASSPHRASE' });
  checkOwnPassphrase('twenty characters ok');
  checkOwnPassphrase('źdźbło źdźbło źdźbło'); // 20 letters and spaces, more bytes
  assert.throws(() => checkOwnPassphrase('ąęółżźćńśąęółżźćńś'), { code: 'WEAK_PASSPHRASE' }); // 18 characters, 36 bytes
});

test('scrypt and Argon2id keys depend on salt and associated data', async () => {
  const small = { alg: 'argon2id', m: 1024, t: 1, p: 1 };
  const a = await passphraseKey(Buffer.from('pw'), small, Buffer.alloc(16, 1), Buffer.alloc(32, 1));
  assert.equal(a.length, 32);
  assert.deepEqual(await passphraseKey(Buffer.from('pw'), small, Buffer.alloc(16, 1), Buffer.alloc(32, 1)), a);
  assert.notDeepEqual(await passphraseKey(Buffer.from('pw'), small, Buffer.alloc(16, 2), Buffer.alloc(32, 1)), a);
  assert.notDeepEqual(await passphraseKey(Buffer.from('pw'), small, Buffer.alloc(16, 1), Buffer.alloc(32, 2)), a);
  const s = await passphraseKey(Buffer.from('pw'), { alg: 'scrypt', N: 1024, r: 8, p: 1 }, Buffer.alloc(16, 1), Buffer.alloc(32));
  assert.equal(s.length, 32);
  assert.notDeepEqual(s, a);
});

test('subkeys differ by purpose, vault id and epoch', () => {
  const dk = Buffer.alloc(32, 9);
  const a = subkeys(dk, Buffer.alloc(16, 1), 1);
  assert.equal(new Set([a.header, a.contentId, a.file].map((b) => b.toString('hex'))).size, 3);
  assert.notDeepEqual(subkeys(dk, Buffer.alloc(16, 2), 1).file, a.file);
  assert.notDeepEqual(subkeys(dk, Buffer.alloc(16, 1), 2).file, a.file);
  assert.throws(() => subkeys(Buffer.alloc(31), Buffer.alloc(16), 1), { code: 'BAD_INPUT' });
});

test('one run with the real settings: Argon2id 256 MiB, t=3, p=4', { skip: !hasArgon2 && 'no Argon2id here' }, async () => {
  const t0 = performance.now();
  const k = await passphraseKey(Buffer.from('TEST ONLY real-size run'), ARGON2ID_DEFAULT, Buffer.alloc(16, 7), Buffer.alloc(32, 7));
  assert.equal(k.length, 32);
  assert.ok(performance.now() - t0 < 20_000, 'finished in time');
});
