// .vx files: the encrypted packs and index files (design 6.3).
//   8-byte plain header: "SHVX" | version 1 | kind ('P' pack, 'I' index) | 0 0
//   segments: AES-256-GCM(file key, nonce = segment number (11 bytes, big-endian) + last flag (1 byte),
//             64 KiB of plaintext (the last one 1..64 KiB), AAD = the 8-byte header) + 16-byte tag
//   file key = HKDF-SHA256(K_file, salt = file id, info = "StickHub vault v1 file" 0x00 | kind | vault id | epoch)
//   plaintext = payload length (4 bytes, big-endian) + payload + zero padding up to Padme(4 + length), at least 64 KiB
// This is STREAM (Hoang, Reyhanitabar, Rogaway, Vizar 2015) as used by age: a cut-short file has no segment marked
// last, a reordered or swapped segment has the wrong nonce, extra bytes break the segment layout. The key comes from
// the file id (the file name), so a renamed file does not decrypt.
// Streams hand out payload bytes as soon as their segment is authenticated; a consumer must not use the result
// unless the stream ends without an error (the end of the file is only checked at the end).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { VaultError, fail } from './errors.mjs';
import { bytes, fileIdToName, nameToFileId, u32, zero } from './bytes.mjs';
import { hkdf } from './kdf.mjs';
import { ID_BYTES } from './keys.mjs';

export const SEG = 65536;
export const TAG = 16;
export const HEAD = 8;
const FULL = SEG + TAG;
export const MIN_PADDED = 65536;
export const KINDS = Object.freeze({ pack: 'P', index: 'I' });
/** Largest payload per kind (design 6.6: index file <= 16 MiB, pack <= 32 MiB + padding). */
export const MAX_PAYLOAD = Object.freeze({ pack: 32 * 1024 * 1024, index: 16 * 1024 * 1024 });
const MAGIC = Buffer.from('SHVX');
const VERSION = 1;
const FILE_INFO = Buffer.from('StickHub vault v1 file\0');

/**
 * Padme (Nikitin et al., PETS 2019): round n up so that only about log2(log2(n)) bits of the size stay visible.
 * @param {number} n  1 to 2^31 - 1
 */
export function padme(n) {
  if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) fail('BAD_INPUT', 'padme: n out of range');
  if (n < 2) return n;
  const e = 31 - Math.clz32(n); // floor(log2 n)
  const s = 32 - Math.clz32(e); // floor(log2 e) + 1
  const step = 2 ** (e - s);
  return Math.ceil(n / step) * step;
}

/** Plaintext size (length prefix + payload + padding) for a payload of len bytes. */
export function paddedSize(len) {
  return Math.max(MIN_PADDED, padme(4 + len));
}

/** File size of a .vx file holding a payload of len bytes. */
export function vxSize(len) {
  const p = paddedSize(len);
  return HEAD + p + TAG * Math.ceil(p / SEG);
}

function letter(kind) {
  if (!Object.hasOwn(KINDS, kind)) fail('BAD_INPUT', 'kind: must be pack or index');
  return KINDS[kind];
}

function headerBytes(kind) {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, letter(kind).charCodeAt(0), 0, 0])]);
}

function checkHead(h, kind) {
  if (!h.subarray(0, 4).equals(MAGIC)) fail('BAD_VX', 'Not a vault file.');
  if (h[4] !== VERSION) fail(h[4] > VERSION ? 'UNSUPPORTED' : 'BAD_VX', 'Vault file of an unknown version.');
  if (h[5] !== letter(kind).charCodeAt(0)) fail('BAD_VX', 'Wrong kind of vault file.');
  if (h[6] !== 0 || h[7] !== 0) fail('BAD_VX', 'Damaged vault file header.');
}

/**
 * The key of one .vx file.
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx  kFile from subkeys(dk, ...).file
 * @param {'pack'|'index'} kind
 * @param {Buffer} fileId  16 bytes (the file name)
 * @returns {Buffer} zero it when done
 */
export function fileKey(ctx, kind, fileId) {
  const info = Buffer.concat([FILE_INFO, Buffer.from(letter(kind)), bytes(ctx.vaultId, ID_BYTES, 'vault id'), u32(ctx.epoch)]);
  return hkdf(bytes(ctx.kFile, 32, 'file base key'), bytes(fileId, ID_BYTES, 'file id'), info);
}

function nonce(i, last) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(i, 7);
  n[11] = last ? 1 : 0;
  return n;
}

function encSeg(key, i, last, aad, plain) {
  const c = createCipheriv('aes-256-gcm', key, nonce(i, last), { authTagLength: TAG });
  c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function decSeg(key, i, last, aad, seg) {
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce(i, last), { authTagLength: TAG });
    d.setAAD(aad);
    d.setAuthTag(seg.subarray(seg.length - TAG));
    return Buffer.concat([d.update(seg.subarray(0, seg.length - TAG)), d.final()]);
  } catch {
    throw new VaultError('BAD_VX', 'The vault file is damaged, cut short, renamed or not for this key.');
  }
}

/** Check length prefix and zero padding of a whole plaintext; return the payload (a view into plain). */
function payloadOf(plain, kind) {
  const len = plain.readUInt32BE(0);
  if (len > MAX_PAYLOAD[kind] || paddedSize(len) !== plain.length) fail('BAD_VX', 'The vault file has a wrong length.');
  for (let i = 4 + len; i < plain.length; i++) if (plain[i] !== 0) fail('BAD_VX', 'The vault file has a wrong padding.');
  return plain.subarray(4, 4 + len);
}

/**
 * Encrypt a payload into a whole .vx file.
 * @param {Buffer} payload
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {{kind: 'pack'|'index', fileId: Buffer}} f
 * @returns {Buffer}
 */
export function sealVx(payload, ctx, f) {
  if (!Buffer.isBuffer(payload)) fail('BAD_INPUT', 'payload: must be a Buffer');
  if (payload.length > MAX_PAYLOAD[f.kind]) fail('TOO_BIG', `A ${f.kind} holds at most ${MAX_PAYLOAD[f.kind]} bytes.`);
  const head = headerBytes(f.kind);
  const p = paddedSize(payload.length);
  const plain = Buffer.alloc(p);
  plain.writeUInt32BE(payload.length, 0);
  payload.copy(plain, 4);
  const key = fileKey(ctx, f.kind, f.fileId);
  try {
    const n = Math.ceil(p / SEG);
    const parts = [head];
    for (let i = 0; i < n; i++) parts.push(encSeg(key, i, i === n - 1, head, plain.subarray(i * SEG, Math.min(p, (i + 1) * SEG))));
    return Buffer.concat(parts);
  } finally {
    zero(key, plain);
  }
}

/**
 * Decrypt and check a whole .vx file.
 * @param {Buffer} file
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {{kind: 'pack'|'index', fileId: Buffer}} f
 * @returns {Buffer} the payload
 */
export function openVx(file, ctx, f) {
  if (!Buffer.isBuffer(file)) fail('BAD_INPUT', 'file: must be a Buffer');
  const head = headerBytes(f.kind);
  if (file.length > vxSize(MAX_PAYLOAD[f.kind])) fail('TOO_BIG', 'The vault file is bigger than allowed.');
  if (file.length < HEAD + MIN_PADDED + TAG) fail('BAD_VX', 'The vault file is too short.');
  checkHead(file, f.kind);
  const body = file.length - HEAD;
  const n = Math.ceil(body / FULL);
  if (body - (n - 1) * FULL <= TAG) fail('BAD_VX', 'The vault file has a wrong size.');
  const plain = Buffer.alloc(body - TAG * n);
  const key = fileKey(ctx, f.kind, f.fileId);
  try {
    for (let i = 0; i < n; i++) {
      decSeg(key, i, i === n - 1, head, file.subarray(HEAD + i * FULL, Math.min(file.length, HEAD + (i + 1) * FULL))).copy(plain, i * SEG);
    }
    return payloadOf(plain, f.kind);
  } catch (e) {
    zero(plain);
    throw e;
  } finally {
    zero(key);
  }
}

/**
 * A stream that encrypts exactly `size` payload bytes into a .vx file.
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {{kind: 'pack'|'index', fileId: Buffer, size: number}} f  size must be known up front (it is in segment 0)
 * @returns {Transform}
 */
export function createSealStream(ctx, f) {
  if (!Number.isSafeInteger(f.size) || f.size < 0) fail('BAD_INPUT', 'size: must be a whole number');
  if (f.size > MAX_PAYLOAD[f.kind]) fail('TOO_BIG', `A ${f.kind} holds at most ${MAX_PAYLOAD[f.kind]} bytes.`);
  const head = headerBytes(f.kind);
  const p = paddedSize(f.size);
  const n = Math.ceil(p / SEG);
  const key = fileKey(ctx, f.kind, f.fileId);
  let seg = 0;
  let cur = Buffer.alloc(SEG);
  let fill = 4;
  let got = 0;
  let started = false;
  cur.writeUInt32BE(f.size, 0);
  const emit = (t, len) => {
    t.push(encSeg(key, seg, seg === n - 1, head, cur.subarray(0, len)));
    zero(cur);
    seg++;
    cur = Buffer.alloc(SEG);
    fill = 0;
  };
  const start = (t) => { if (!started) { t.push(head); started = true; } };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        start(this);
        got += chunk.length;
        if (got > f.size) fail('TOO_BIG', 'More data than announced.');
        for (let off = 0; off < chunk.length;) {
          const take = Math.min(SEG - fill, chunk.length - off);
          chunk.copy(cur, fill, off, off + take);
          fill += take;
          off += take;
          if (fill === SEG && seg < n - 1) emit(this, SEG);
        }
        cb();
      } catch (e) {
        zero(key, cur);
        cb(e);
      }
    },
    flush(cb) {
      try {
        if (got !== f.size) fail('BAD_INPUT', 'Less data than announced.');
        start(this);
        while (seg < n - 1) emit(this, SEG); // only padding left: cur is zeros after the first emit
        emit(this, p - (n - 1) * SEG);
        cb();
      } catch (e) {
        cb(e);
      } finally {
        zero(key, cur);
      }
    },
  });
}

/**
 * A stream that decrypts a .vx file and outputs its payload. It errors on any damage; see the note at the top.
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {{kind: 'pack'|'index', fileId: Buffer}} f
 * @returns {Transform}
 */
export function createOpenStream(ctx, f) {
  const head = headerBytes(f.kind);
  const max = vxSize(MAX_PAYLOAD[f.kind]);
  const key = fileKey(ctx, f.kind, f.fileId);
  let pending = Buffer.alloc(0);
  let headOk = false;
  let total = 0;
  let seg = 0;
  let pos = 0; // plaintext bytes seen
  let len = -1;
  let p = 0;
  const handle = (t, plain) => {
    if (seg === 0) {
      if (plain.length < 4) fail('BAD_VX', 'The vault file has a wrong length.');
      len = plain.readUInt32BE(0);
      if (len > MAX_PAYLOAD[f.kind]) fail('BAD_VX', 'The vault file has a wrong length.');
      p = paddedSize(len);
    }
    const start = pos;
    pos += plain.length;
    seg++;
    if (pos > p) fail('BAD_VX', 'The vault file has a wrong length.');
    const a = Math.max(start, 4);
    const b = Math.min(pos, 4 + len);
    if (b > a) t.push(Buffer.from(plain.subarray(a - start, b - start)));
    for (let i = Math.max(start, 4 + len) - start; i < plain.length; i++) if (plain[i] !== 0) fail('BAD_VX', 'The vault file has a wrong padding.');
    zero(plain);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        total += chunk.length;
        if (total > max) fail('TOO_BIG', 'The vault file is bigger than allowed.');
        pending = Buffer.concat([pending, chunk]);
        if (!headOk) {
          if (pending.length < HEAD) return cb();
          checkHead(pending, f.kind);
          pending = pending.subarray(HEAD);
          headOk = true;
        }
        while (pending.length > FULL) { // more bytes follow, so this segment is not the last
          handle(this, decSeg(key, seg, false, head, pending.subarray(0, FULL)));
          pending = pending.subarray(FULL);
        }
        return cb();
      } catch (e) {
        zero(key);
        return cb(e);
      }
    },
    flush(cb) {
      try {
        if (!headOk || pending.length <= TAG) fail('BAD_VX', 'The vault file is cut short.');
        handle(this, decSeg(key, seg, true, head, pending));
        if (pos !== p) fail('BAD_VX', 'The vault file has a wrong length.');
        cb();
      } catch (e) {
        cb(e);
      } finally {
        zero(key);
      }
    },
  });
}

/** A new random file id. */
export function newFileId(random = randomBytes) {
  return bytes(random(ID_BYTES), ID_BYTES, 'file id');
}

/** "<26 base32 characters>.vx" for a file id. */
export function vxFileName(fileId) {
  return `${fileIdToName(fileId)}.vx`;
}

/**
 * The file id of a .vx file name (only the canonical spelling).
 * @param {unknown} name
 * @returns {Buffer}
 */
export function parseVxFileName(name) {
  if (typeof name !== 'string' || !name.endsWith('.vx')) fail('BAD_VX', 'not a vault file name');
  return nameToFileId(name.slice(0, -3));
}

/** Size of one full segment in the file (64 KiB + tag). */
export const FULL_SEGMENT = FULL;
// Internals for the range reader (vxread.mjs). Not for other callers.
export { decSeg as decryptSegment, headerBytes as vxHeaderBytes, checkHead as checkVxHeader };
