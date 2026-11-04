// The vault header, vault.json (design 6.2):
//   { "stickhubVault": 1, "body": "<JSON text>", "mac": "<HMAC-SHA256(K_header, body bytes), base64url>" }
// body = { "vault": <16 B>, "epoch": n, "hseq": n, "slots": [...] }. body is a string, so the MAC covers exact bytes.
// Order of use: parseHeader (size limits + strict schema, no crypto) -> open a slot (KDF) -> verifyHeaderMac.
// So a broken or hostile header is refused before any KDF runs, and a changed one is caught right after the unlock.

import { createHmac } from 'node:crypto';
import { VaultError, fail } from './errors.mjs';
import { bytes, ctEqual, fromB64u, toB64u, u32, zero } from './bytes.mjs';
import { exactKeys, validateSlot, openPassphraseSlot, openRecoverySlot } from './slots.mjs';
import { subkeys, DK_BYTES, ID_BYTES } from './keys.mjs';

export const HEADER_VERSION = 1;
export const HEADER_MAX_BYTES = 128 * 1024; // whole file (body is a JSON string inside JSON, so escaped)
export const BODY_MAX_BYTES = 64 * 1024;
export const SLOT_MAX = Object.freeze({ passphrase: 1, recovery: 1, device: 8 });
const U32_MAX = 0xffffffff;

const okInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** Check the body fields; return {vaultId, epoch, hseq, slots} with clean slot copies. */
function checkBody(b) {
  exactKeys(b, ['vault', 'epoch', 'hseq', 'slots'], 'body');
  const vaultId = fromB64u(b.vault, ID_BYTES, 'body.vault');
  if (!okInt(b.epoch, 1, U32_MAX)) fail('BAD_HEADER', 'body.epoch: must be a whole number from 1');
  if (!okInt(b.hseq, 1, U32_MAX)) fail('BAD_HEADER', 'body.hseq: must be a whole number from 1');
  const max = SLOT_MAX.passphrase + SLOT_MAX.recovery + SLOT_MAX.device;
  if (!Array.isArray(b.slots) || b.slots.length < 1 || b.slots.length > max) fail('BAD_HEADER', `body.slots: must be a list of 1 to ${max} slots`);
  const slots = b.slots.map((s, i) => validateSlot(s, `body.slots[${i}]`));
  const count = { passphrase: 0, recovery: 0, device: 0 };
  const ids = new Set();
  for (const s of slots) {
    if (++count[s.type] > SLOT_MAX[s.type]) fail('BAD_HEADER', `body.slots: at most ${SLOT_MAX[s.type]} ${s.type} slot(s)`);
    if (ids.has(s.id)) fail('BAD_HEADER', 'body.slots: two slots with the same id');
    ids.add(s.id);
  }
  return { vaultId, epoch: b.epoch, hseq: b.hseq, slots };
}

function mac(dk, vaultId, epoch, body) {
  const k = subkeys(dk, vaultId, epoch);
  try {
    return createHmac('sha256', k.header).update(body, 'utf8').digest();
  } finally {
    zero(k.header, k.contentId, k.file);
  }
}

/**
 * Build the text of vault.json.
 * @param {{vaultId: Buffer, epoch: number, hseq: number, slots: object[]}} h  slots in wire form
 * @param {Buffer} dk  the data key (for the MAC)
 * @returns {string}
 */
export function buildHeader(h, dk) {
  bytes(dk, DK_BYTES, 'data key');
  const draft = { vault: toB64u(bytes(h.vaultId, ID_BYTES, 'vault id')), epoch: h.epoch, hseq: h.hseq, slots: h.slots };
  let clean;
  try {
    clean = checkBody(draft);
  } catch (e) {
    if (e instanceof VaultError && e.code === 'BAD_HEADER') fail('BAD_INPUT', `buildHeader: ${e.message}`);
    throw e;
  }
  const body = JSON.stringify({ vault: draft.vault, epoch: clean.epoch, hseq: clean.hseq, slots: clean.slots });
  if (Buffer.byteLength(body) > BODY_MAX_BYTES) fail('TOO_BIG', 'header body over 64 KiB');
  return `${JSON.stringify({ stickhubVault: HEADER_VERSION, body, mac: toB64u(mac(dk, clean.vaultId, clean.epoch, body)) })}\n`;
}

/**
 * Parse vault.json read from a stick or a phone. Untrusted: size limits and a strict schema, no crypto at all.
 * @param {string|Buffer} text
 * @returns {{vaultId: Buffer, epoch: number, hseq: number, slots: object[], body: string, mac: Buffer}}
 */
export function parseHeader(text) {
  if (typeof text !== 'string' && !Buffer.isBuffer(text)) fail('BAD_HEADER', 'header: no text');
  if (Buffer.byteLength(text) > HEADER_MAX_BYTES) fail('BAD_HEADER', 'header: file over 128 KiB');
  let outer;
  let inner;
  try {
    outer = JSON.parse(String(text));
  } catch {
    return fail('BAD_HEADER', 'header: not JSON');
  }
  if (outer?.stickhubVault !== HEADER_VERSION && Number.isSafeInteger(outer?.stickhubVault) && outer.stickhubVault > HEADER_VERSION) {
    fail('UNSUPPORTED', 'This vault was made by a newer StickHub. Update this hub first.');
  }
  exactKeys(outer, ['stickhubVault', 'body', 'mac'], 'header');
  if (outer.stickhubVault !== HEADER_VERSION) fail('BAD_HEADER', 'header.stickhubVault: must be 1');
  if (typeof outer.body !== 'string' || Buffer.byteLength(outer.body) > BODY_MAX_BYTES) fail('BAD_HEADER', 'header.body: must be text up to 64 KiB');
  const tag = fromB64u(outer.mac, 32, 'header.mac');
  try {
    inner = JSON.parse(outer.body);
  } catch {
    return fail('BAD_HEADER', 'header.body: not JSON');
  }
  return { ...checkBody(inner), body: outer.body, mac: tag };
}

/**
 * Throw BAD_MAC unless the header's MAC matches (call right after a slot gave the data key).
 * @param {{vaultId: Buffer, epoch: number, body: string, mac: Buffer}} h  from parseHeader
 * @param {Buffer} dk
 */
export function verifyHeaderMac(h, dk) {
  if (!ctEqual(mac(dk, h.vaultId, h.epoch, h.body), h.mac)) {
    fail('BAD_MAC', 'The vault header was changed outside StickHub. Try the backup header or the other copy.');
  }
}

/** The first slot of a type, or null. */
export function findSlot(h, type) {
  return h.slots.find((s) => s.type === type) || null;
}

async function unlock(h, type, open) {
  const slot = findSlot(h, type);
  if (!slot) fail('WRONG_SECRET', `This vault has no ${type} slot.`);
  u32(h.epoch);
  const dk = await open(slot, { vaultId: h.vaultId, epoch: h.epoch });
  try {
    verifyHeaderMac(h, dk);
  } catch (e) {
    zero(dk);
    throw e;
  }
  return dk;
}

/**
 * Open the vault with the passphrase: passphrase slot (KDF, limits checked first), then the header MAC.
 * @param {ReturnType<typeof parseHeader>} h
 * @param {string} passphrase
 * @returns {Promise<Buffer>} the data key (zero it when the vault locks)
 */
export function unlockWithPassphrase(h, passphrase) {
  return unlock(h, 'passphrase', (s, c) => openPassphraseSlot(s, passphrase, c));
}

/**
 * Open the vault with the paper code: typo check, recovery slot, then the header MAC.
 * @param {ReturnType<typeof parseHeader>} h
 * @param {string} typed
 * @returns {Promise<Buffer>} the data key
 */
export function unlockWithPaperCode(h, typed) {
  return unlock(h, 'recovery', async (s, c) => openRecoverySlot(s, typed, c));
}
