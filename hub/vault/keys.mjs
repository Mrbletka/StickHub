// The data key (DK) and the keys derived from it (design 4.1). The DK is a Buffer: zero() it when the vault locks.
// Nothing here logs or prints a key.

import { randomBytes } from 'node:crypto';
import { hkdf } from './kdf.mjs';
import { bytes, u32, zero } from './bytes.mjs';

export { zero };

/** Size of the data key, a vault id, a slot id and a file id. */
export const DK_BYTES = 32;
export const ID_BYTES = 16;
const LABEL = 'StickHub vault v1 ';

/**
 * A new random data key.
 * @param {(n: number) => Buffer} [random]  for tests only; default crypto.randomBytes
 */
export function newDataKey(random = randomBytes) {
  return bytes(random(DK_BYTES), DK_BYTES, 'data key');
}

/**
 * A new random 16-byte id (vault, slot or file).
 * @param {(n: number) => Buffer} [random]
 */
export function newId(random = randomBytes) {
  return bytes(random(ID_BYTES), ID_BYTES, 'id');
}

/**
 * Keys derived from the DK: HKDF-SHA256(ikm = DK, salt = vault id + epoch, info = "StickHub vault v1 " + purpose).
 *   header: HMAC key of the header body; contentId: HMAC key for content ids; file: base key for the .vx file keys.
 * The caller zeroes them (zero(k.header, k.contentId, k.file)) when done.
 * @param {Buffer} dk
 * @param {Buffer} vaultId  16 bytes
 * @param {number} epoch
 * @returns {{header: Buffer, contentId: Buffer, file: Buffer}}
 */
export function subkeys(dk, vaultId, epoch) {
  bytes(dk, DK_BYTES, 'data key');
  const salt = Buffer.concat([bytes(vaultId, ID_BYTES, 'vault id'), u32(epoch)]);
  return {
    header: hkdf(dk, salt, `${LABEL}header`),
    contentId: hkdf(dk, salt, `${LABEL}content-id`),
    file: hkdf(dk, salt, `${LABEL}file`),
  };
}
