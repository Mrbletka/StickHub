// Shared helpers for the vault tests. TEST ONLY: tiny KDF settings, fixed "random" bytes. Never use these outside tests.

import { createHash } from 'node:crypto';
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { newDataKey, newId } from '../hub/vault/keys.mjs';
import { makePassphraseSlot, makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader } from '../hub/vault/header.mjs';

/** Argon2id settings far below the real ones (256 MiB), so tests run fast. TEST ONLY. */
export const SMALL_KDF = Object.freeze({ alg: 'argon2id', m: 1024, t: 1, p: 1 });

/**
 * Deterministic bytes: SHA-256(seed | counter) blocks. Same seed, same bytes. TEST ONLY (fixtures).
 * @param {string} seed
 * @returns {(n: number) => Buffer}
 */
export function fixedRandom(seed) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  return (n) => {
    while (pool.length < n) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter++);
      pool = Buffer.concat([pool, createHash('sha256').update(seed).update(c).digest()]);
    }
    const out = Buffer.from(pool.subarray(0, n));
    pool = pool.subarray(n);
    return out;
  };
}

/**
 * A small vault for tests: data key, ids, passphrase slot (SMALL_KDF), recovery slot, header text.
 * @param {{passphrase?: string, random?: (n: number) => Buffer, kdf?: object}} [o]
 */
export async function makeTestVault(o = {}) {
  const random = o.random;
  const dk = newDataKey(random);
  const vaultId = newId(random);
  const epoch = 1;
  const passphrase = o.passphrase ?? 'TEST ONLY correct horse battery staple';
  const ps = await makePassphraseSlot({ dk, vaultId, epoch, passphrase, kdf: o.kdf || SMALL_KDF, random });
  const { slot: rs, paperCode } = makeRecoverySlot({ dk, vaultId, epoch, random });
  const text = buildHeader({ vaultId, epoch, hseq: 1, slots: [ps, rs] }, dk);
  return { dk, vaultId, epoch, passphrase, paperCode, ps, rs, text };
}

/**
 * Replace crypto.argon2 and crypto.scrypt with counters while fn runs (proves that no KDF ran).
 * @param {() => Promise<void>} fn
 * @returns {Promise<number>} how many KDF calls happened
 */
export async function countKdfCalls(fn) {
  const orig = { argon2: nodeCrypto.argon2, scrypt: nodeCrypto.scrypt };
  let calls = 0;
  nodeCrypto.argon2 = (...a) => { calls++; return orig.argon2(...a); };
  nodeCrypto.scrypt = (...a) => { calls++; return orig.scrypt(...a); };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    Object.assign(nodeCrypto, orig);
    syncBuiltinESMExports();
  }
  return calls;
}

/** Flip one bit of a base64url field and return the new text. */
export function flipB64u(s, byte = 0) {
  const b = Buffer.from(s, 'base64url');
  b[byte] ^= 1;
  return b.toString('base64url');
}
