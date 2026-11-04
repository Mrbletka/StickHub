// Key derivation: Argon2id (RFC 9106) for the passphrase, scrypt (RFC 7914) only where Argon2id is missing,
// HKDF-SHA256 (RFC 5869) for high-entropy secrets and subkeys. node:crypto only.
// KDF settings come from the stick (untrusted), so checkKdf() runs before any KDF: a tampered stick must not make
// the phone run out of memory or spin for minutes.

import * as crypto from 'node:crypto';
import { VaultError, fail } from './errors.mjs';
import { bytes } from './bytes.mjs';

/** Argon2id settings for new slots: 256 MiB (memory is in KiB), 3 passes, 4 lanes. 0.9 s on the phone (probe 9). */
export const ARGON2ID_DEFAULT = Object.freeze({ alg: 'argon2id', m: 262144, t: 3, p: 4 });
/** scrypt settings for new slots on a device without Argon2id: 128 MiB. 0.54 s on the phone (probe 9). */
export const SCRYPT_DEFAULT = Object.freeze({ alg: 'scrypt', N: 131072, r: 8, p: 1 });

/** Limits for KDF settings read from a stick (design 4.2, plus r, p and memory bounds for scrypt). */
export const KDF_LIMITS = Object.freeze({
  argon2id: Object.freeze({ mMax: 1048576, tMax: 10, pMax: 8 }), // m in KiB: 1 GiB
  scrypt: Object.freeze({ nMax: 2 ** 20, rMax: 32, pMax: 4, memMax: 2 ** 30 }),
});

/** Most characters a passphrase may have (a longer one is refused before any work). */
export const PASSPHRASE_MAX = 1024;
/** Fewest characters (after NFKC) for a passphrase the user chose (decision 5). */
export const OWN_PASSPHRASE_MIN = 20;

/** True if this Node has Argon2 (Node 24.7+). */
export const hasArgon2 = typeof crypto.argon2 === 'function';

/** The KDF settings for a new passphrase slot on this device. */
export function defaultKdf() {
  return hasArgon2 ? ARGON2ID_DEFAULT : SCRYPT_DEFAULT;
}

const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * Throw KDF_LIMITS unless the settings are known and inside the limits. Call before running a KDF.
 * @param {{alg: string, m?: number, t?: number, p?: number, N?: number, r?: number}} k
 */
export function checkKdf(k) {
  if (!k || typeof k !== 'object') fail('KDF_LIMITS', 'kdf: missing');
  if (k.alg === 'argon2id') {
    const L = KDF_LIMITS.argon2id;
    if (!int(k.p, 1, L.pMax)) fail('KDF_LIMITS', `kdf.p: must be 1 to ${L.pMax}`);
    if (!int(k.m, 8 * k.p, L.mMax)) fail('KDF_LIMITS', `kdf.m: must be ${8 * k.p} to ${L.mMax} KiB`);
    if (!int(k.t, 1, L.tMax)) fail('KDF_LIMITS', `kdf.t: must be 1 to ${L.tMax}`);
  } else if (k.alg === 'scrypt') {
    const L = KDF_LIMITS.scrypt;
    if (!int(k.N, 2, L.nMax) || (k.N & (k.N - 1)) !== 0) fail('KDF_LIMITS', `kdf.N: must be a power of 2 up to ${L.nMax}`);
    if (!int(k.r, 1, L.rMax)) fail('KDF_LIMITS', `kdf.r: must be 1 to ${L.rMax}`);
    if (!int(k.p, 1, L.pMax)) fail('KDF_LIMITS', `kdf.p: must be 1 to ${L.pMax}`);
    if (128 * k.N * k.r > L.memMax) fail('KDF_LIMITS', 'kdf: scrypt memory over 1 GiB');
  } else {
    fail('KDF_LIMITS', 'kdf.alg: must be argon2id or scrypt');
  }
}

/**
 * NFKC-normalize a passphrase (the same Polish letters typed on another keyboard give the same bytes) and return its
 * UTF-8 bytes. The caller zeroes the buffer when done.
 * @param {unknown} s
 * @returns {Buffer}
 */
export function normalizePassphrase(s) {
  if (typeof s !== 'string' || !s.isWellFormed()) fail('BAD_INPUT', 'passphrase: must be text');
  if (s.length > PASSPHRASE_MAX) fail('BAD_INPUT', `passphrase: more than ${PASSPHRASE_MAX} characters`);
  const n = s.normalize('NFKC');
  if (!n.length) fail('BAD_INPUT', 'passphrase: empty');
  return Buffer.from(n, 'utf8');
}

/**
 * Throw WEAK_PASSPHRASE if a passphrase the user chose is shorter than 20 characters (counted after NFKC).
 * Generated passphrases (5 words) do not go through this check.
 * @param {string} s
 */
export function checkOwnPassphrase(s) {
  normalizePassphrase(s);
  const chars = [...s.normalize('NFKC')].length;
  if (chars < OWN_PASSPHRASE_MIN) fail('WEAK_PASSPHRASE', `Choose at least ${OWN_PASSPHRASE_MIN} characters, or use the generated words.`);
}

/**
 * Derive a 32-byte key from passphrase bytes with the slot's KDF. Limits are checked first.
 * @param {Buffer} pass  normalized passphrase bytes (from normalizePassphrase)
 * @param {object} kdf  checked settings: {alg:'argon2id', m, t, p} or {alg:'scrypt', N, r, p}
 * @param {Buffer} salt  16 bytes
 * @param {Buffer} ad  Argon2id associated data (vault id + slot id); not used by scrypt
 * @returns {Promise<Buffer>}
 */
export async function passphraseKey(pass, kdf, salt, ad) {
  checkKdf(kdf);
  bytes(salt, 16, 'salt');
  if (!Buffer.isBuffer(pass) || !pass.length) fail('BAD_INPUT', 'passphrase bytes: missing');
  if (kdf.alg === 'argon2id' && !hasArgon2) fail('UNSUPPORTED', 'This Node has no Argon2id; this slot needs it.');
  try {
    if (kdf.alg === 'argon2id') {
      return await new Promise((resolve, reject) => crypto.argon2('argon2id', {
        message: pass, nonce: salt, parallelism: kdf.p, tagLength: 32, memory: kdf.m, passes: kdf.t, associatedData: ad,
      }, (e, k) => (e ? reject(e) : resolve(k))));
    }
    return await new Promise((resolve, reject) => crypto.scrypt(pass, salt, 32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r + (1 << 20) }, (e, k) => (e ? reject(e) : resolve(k))));
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError('KDF_FAILED', 'Key derivation failed (not enough memory?).'); // Node's text may quote settings
  }
}

/**
 * HKDF-SHA256 (RFC 5869).
 * @param {Buffer} ikm  input key material
 * @param {Buffer} salt
 * @param {Buffer|string} info
 * @param {number} [len] output bytes, default 32
 * @returns {Buffer}
 */
export function hkdf(ikm, salt, info, len = 32) {
  if (!Buffer.isBuffer(ikm) || !Buffer.isBuffer(salt)) fail('BAD_INPUT', 'hkdf: ikm and salt must be Buffers');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}
