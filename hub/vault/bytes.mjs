// Small byte helpers for the vault: zeroing, fixed-size integers, strict base64url, file-name base32.

import { timingSafeEqual } from 'node:crypto';
import { fail } from './errors.mjs';

/**
 * Overwrite buffers with zeros (key material we no longer need). Best effort: JavaScript may have copied the bytes
 * before, and strings cannot be cleared at all.
 * @param {...(Buffer|Uint8Array|null|undefined)} bufs
 */
export function zero(...bufs) {
  for (const b of bufs) if (b) b.fill(0);
}

/** 4-byte big-endian unsigned integer. */
export function u32(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) fail('BAD_INPUT', 'u32: not a 32-bit unsigned integer');
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/**
 * Check that b is a Buffer of exactly len bytes.
 * @param {unknown} b
 * @param {number} len
 * @param {string} what  name for the error message
 * @returns {Buffer}
 */
export function bytes(b, len, what) {
  if (!Buffer.isBuffer(b) || b.length !== len) fail('BAD_INPUT', `${what}: must be ${len} bytes`);
  return b;
}

/** Bytes as base64url without padding. */
export function toB64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Strict base64url: only the canonical form of exactly len bytes is accepted (one value, one spelling).
 * @param {unknown} s
 * @param {number} len
 * @param {string} what  field name for the error message
 * @param {string} [code]  error code, default BAD_HEADER
 * @returns {Buffer}
 */
export function fromB64u(s, len, what, code = 'BAD_HEADER') {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) fail(code, `${what}: not base64url`);
  const b = Buffer.from(s, 'base64url');
  if (b.length !== len || b.toString('base64url') !== s) fail(code, `${what}: must be ${len} bytes in canonical base64url`);
  return b;
}

/** Constant-time equality of two buffers (false if the lengths differ). */
export function ctEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 alphabet, lower case (exFAT is case-insensitive)

/**
 * A 16-byte file id as 26 lower-case base32 characters (128 bits; the last character carries 3 bits + 2 zero bits).
 * @param {Buffer} id
 */
export function fileIdToName(id) {
  bytes(id, 16, 'file id');
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of id) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out + B32[(acc << (5 - bits)) & 31];
}

/**
 * Parse a 26-character file name back to its 16-byte id. Only the canonical spelling is accepted, so every id has
 * exactly one name.
 * @param {unknown} name
 * @returns {Buffer}
 */
export function nameToFileId(name) {
  if (typeof name !== 'string' || !/^[a-z2-7]{26}$/.test(name)) fail('BAD_VX', 'not a vault file name');
  const out = Buffer.alloc(16);
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of name) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8 && i < 16) {
      out[i++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (fileIdToName(out) !== name) fail('BAD_VX', 'not a vault file name');
  return out;
}
