// Key slots (design 4.1, 4.2, 4.4, 6.2). Each slot wraps the data key (DK) with AES-256-GCM under a key-encryption
// key (KEK) from the passphrase (Argon2id or scrypt) or the paper code (HKDF-SHA256).
// AAD = "StickHub vault v1 slot" 0x00 | vault id (16) | epoch (4, big-endian) | slot id (16) | the slot's settings as
// canonical JSON. So a slot cannot be moved to another vault, epoch or slot, and changed settings make it fail.
// v1 builds passphrase and recovery slots. Device slots (v2) are only checked against the schema, so a v1 hub can
// read a header that has them.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { VaultError, fail } from './errors.mjs';
import { bytes, fromB64u, toB64u, u32, zero } from './bytes.mjs';
import { checkKdf, defaultKdf, hkdf, normalizePassphrase, passphraseKey } from './kdf.mjs';
import { generatePaperCode, parsePaperCode, formatPaperCode, paperCodeFromSecret, SECRET_CHARS } from './papercode.mjs';
import { DK_BYTES, ID_BYTES } from './keys.mjs';

const SLOT_LABEL = Buffer.from('StickHub vault v1 slot\0');
const RECOVERY_INFO = 'StickHub vault v1 recovery\0';
const NONCE = 12;
const WRAPPED = DK_BYTES + 16;
const SALT = { passphrase: 16, recovery: 32, device: 32 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Throw BAD_HEADER unless obj is a plain object with exactly these keys. */
export function exactKeys(obj, keys, where) {
  if (!isObj(obj)) fail('BAD_HEADER', `${where}: must be an object`);
  const got = Object.keys(obj);
  if (got.length !== keys.length || !keys.every((k) => Object.hasOwn(obj, k))) fail('BAD_HEADER', `${where}: must have exactly ${keys.join(', ')}`);
}

/**
 * Check a slot read from a header (untrusted) and return a clean copy with a fixed key order.
 * KDF settings are checked against the limits here, before anything runs.
 * @param {unknown} s
 * @param {string} [where]  for error messages
 * @returns {object}
 */
export function validateSlot(s, where = 'slot') {
  if (!isObj(s)) fail('BAD_HEADER', `${where}: must be an object`);
  const type = s.type;
  const common = (extra) => {
    exactKeys(s, ['id', 'type', ...extra, 'nonce', 'wrapped'], where);
    fromB64u(s.id, ID_BYTES, `${where}.id`);
    fromB64u(s.nonce, NONCE, `${where}.nonce`);
    fromB64u(s.wrapped, WRAPPED, `${where}.wrapped`);
  };
  if (type === 'passphrase') {
    common(['kdf']);
    const k = s.kdf;
    const fields = k?.alg === 'scrypt' ? ['alg', 'N', 'r', 'p', 'salt'] : ['alg', 'm', 't', 'p', 'salt'];
    exactKeys(k, fields, `${where}.kdf`);
    try { checkKdf(k); } catch (e) { if (e instanceof VaultError) fail('BAD_HEADER', `${where}.${e.message}`); throw e; }
    fromB64u(k.salt, SALT.passphrase, `${where}.kdf.salt`);
    const kdf = k.alg === 'scrypt' ? { alg: 'scrypt', N: k.N, r: k.r, p: k.p, salt: k.salt } : { alg: 'argon2id', m: k.m, t: k.t, p: k.p, salt: k.salt };
    return { id: s.id, type, kdf, nonce: s.nonce, wrapped: s.wrapped };
  }
  if (type === 'recovery') {
    common(['salt']);
    fromB64u(s.salt, SALT.recovery, `${where}.salt`);
    return { id: s.id, type, salt: s.salt, nonce: s.nonce, wrapped: s.wrapped };
  }
  if (type === 'device') {
    common(['sign', 'challenge', 'salt']);
    if (s.sign !== 'SHA256withRSA') fail('BAD_HEADER', `${where}.sign: must be SHA256withRSA`);
    fromB64u(s.challenge, 32, `${where}.challenge`);
    fromB64u(s.salt, SALT.device, `${where}.salt`);
    return { id: s.id, type, sign: s.sign, challenge: s.challenge, salt: s.salt, nonce: s.nonce, wrapped: s.wrapped };
  }
  return fail('BAD_HEADER', `${where}.type: must be passphrase, recovery or device`);
}

/** The slot's settings (everything but id, nonce and wrapped) as canonical JSON. */
function settings(slot) {
  const { id: _i, nonce: _n, wrapped: _w, ...rest } = validateSlot(slot);
  return JSON.stringify(rest);
}

/**
 * The AAD of a slot's AES-GCM wrap.
 * @param {Buffer} vaultId
 * @param {number} epoch
 * @param {object} slot  wire form (base64url strings)
 */
export function slotAad(vaultId, epoch, slot) {
  return Buffer.concat([SLOT_LABEL, bytes(vaultId, ID_BYTES, 'vault id'), u32(epoch),
    fromB64u(slot.id, ID_BYTES, 'slot.id', 'BAD_INPUT'), Buffer.from(settings(slot), 'utf8')]);
}

function wrap(kek, dk, nonce, aad) {
  const c = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(dk), c.final(), c.getAuthTag()]);
}

function unwrap(kek, slot, aad) {
  const w = fromB64u(slot.wrapped, WRAPPED, 'slot.wrapped', 'BAD_INPUT');
  try {
    const d = createDecipheriv('aes-256-gcm', kek, fromB64u(slot.nonce, NONCE, 'slot.nonce', 'BAD_INPUT'), { authTagLength: 16 });
    d.setAAD(aad);
    d.setAuthTag(w.subarray(DK_BYTES));
    return Buffer.concat([d.update(w.subarray(0, DK_BYTES)), d.final()]);
  } catch {
    throw new VaultError('WRONG_SECRET', 'That does not open this vault.'); // GCM tag check failed: wrong secret or changed slot
  }
}

const passAd = (vaultId, slot) => Buffer.concat([vaultId, fromB64u(slot.id, ID_BYTES, 'slot.id', 'BAD_INPUT')]);

function recoveryKey(secret, slot, vaultId) {
  const info = Buffer.concat([Buffer.from(RECOVERY_INFO), vaultId, fromB64u(slot.id, ID_BYTES, 'slot.id', 'BAD_INPUT')]);
  return hkdf(Buffer.from(secret, 'ascii'), fromB64u(slot.salt, SALT.recovery, 'slot.salt', 'BAD_INPUT'), info);
}

function ctx(o) {
  bytes(o.dk, DK_BYTES, 'data key');
  bytes(o.vaultId, ID_BYTES, 'vault id');
  u32(o.epoch);
  return o.random || randomBytes;
}

/**
 * Make the passphrase slot: KEK = Argon2id (or scrypt) of the NFKC passphrase, wrap DK.
 * @param {{dk: Buffer, vaultId: Buffer, epoch: number, passphrase: string, kdf?: object,
 *   random?: (n: number) => Buffer}} o  kdf: default 256 MiB Argon2id (scrypt without Argon2); random: tests only
 * @returns {Promise<object>} the slot in wire form
 */
export async function makePassphraseSlot(o) {
  const random = ctx(o);
  const kdf = o.kdf || defaultKdf();
  checkKdf(kdf);
  const params = kdf.alg === 'scrypt' ? { alg: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p } : { alg: 'argon2id', m: kdf.m, t: kdf.t, p: kdf.p };
  const draft = { id: toB64u(random(ID_BYTES)), type: 'passphrase', kdf: { ...params, salt: toB64u(random(SALT.passphrase)) } };
  const nonce = random(NONCE);
  const pass = normalizePassphrase(o.passphrase);
  let kek = null;
  try {
    kek = await passphraseKey(pass, draft.kdf, Buffer.from(draft.kdf.salt, 'base64url'), passAd(o.vaultId, draft));
    const slot = { ...draft, nonce: toB64u(nonce), wrapped: '' };
    slot.wrapped = toB64u(wrap(kek, o.dk, nonce, slotAad(o.vaultId, o.epoch, { ...slot, wrapped: toB64u(Buffer.alloc(WRAPPED)) })));
    return validateSlot(slot);
  } finally {
    zero(pass, kek);
  }
}

/**
 * Open the passphrase slot. The KDF settings are checked before the KDF runs.
 * @param {object} slot  from parseHeader (validated)
 * @param {string} passphrase
 * @param {{vaultId: Buffer, epoch: number}} c
 * @returns {Promise<Buffer>} the data key
 */
export async function openPassphraseSlot(slot, passphrase, c) {
  const s = validateSlot(slot);
  if (s.type !== 'passphrase') fail('BAD_INPUT', 'not a passphrase slot');
  bytes(c.vaultId, ID_BYTES, 'vault id');
  const pass = normalizePassphrase(passphrase);
  let kek = null;
  try {
    kek = await passphraseKey(pass, s.kdf, fromB64u(s.kdf.salt, SALT.passphrase, 'slot.kdf.salt', 'BAD_INPUT'), passAd(c.vaultId, s));
    return unwrap(kek, s, slotAad(c.vaultId, c.epoch, s));
  } finally {
    zero(pass, kek);
  }
}

/**
 * Make the recovery slot and its paper code. Pass paperCode to keep an existing code (it is checked first).
 * @param {{dk: Buffer, vaultId: Buffer, epoch: number, paperCode?: string, random?: (n: number) => Buffer}} o
 * @returns {{slot: object, paperCode: string}} paperCode formatted as 7 groups of 4: show it once, never store it
 */
export function makeRecoverySlot(o) {
  const random = ctx(o);
  const code = o.paperCode !== undefined ? null : generatePaperCode(random);
  const secret = code ? code.slice(0, SECRET_CHARS) : parsePaperCode(o.paperCode);
  const draft = { id: toB64u(random(ID_BYTES)), type: 'recovery', salt: toB64u(random(SALT.recovery)) };
  const nonce = random(NONCE);
  const kek = recoveryKey(secret, draft, o.vaultId);
  try {
    const slot = { ...draft, nonce: toB64u(nonce), wrapped: toB64u(Buffer.alloc(WRAPPED)) };
    slot.wrapped = toB64u(wrap(kek, o.dk, nonce, slotAad(o.vaultId, o.epoch, slot)));
    return { slot: validateSlot(slot), paperCode: formatPaperCode(code || paperCodeFromSecret(secret)) };
  } finally {
    zero(kek);
  }
}

/**
 * Open the recovery slot with a typed paper code. A typo is caught (BAD_CODE) before any key work.
 * @param {object} slot
 * @param {string} typed
 * @param {{vaultId: Buffer, epoch: number}} c
 * @returns {Buffer} the data key
 */
export function openRecoverySlot(slot, typed, c) {
  const s = validateSlot(slot);
  if (s.type !== 'recovery') fail('BAD_INPUT', 'not a recovery slot');
  bytes(c.vaultId, ID_BYTES, 'vault id');
  const secret = parsePaperCode(typed);
  const kek = recoveryKey(secret, s, c.vaultId);
  try {
    return unwrap(kek, s, slotAad(c.vaultId, c.epoch, s));
  } finally {
    zero(kek);
  }
}
