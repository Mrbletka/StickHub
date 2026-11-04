// Range reads from a .vx file: decrypt only the 64 KiB segments a read needs. Every segment is authenticated before
// any byte of it is used, and segment 0 (length prefix) is checked against the file size first, so a cut or extended
// file is refused before the first read.

import { fail } from './errors.mjs';
import { zero } from './bytes.mjs';
import {
  fileKey, decryptSegment, vxHeaderBytes, checkVxHeader, paddedSize, vxSize, MAX_PAYLOAD, HEAD, TAG, SEG, MIN_PADDED,
  FULL_SEGMENT,
} from './vx.mjs';

const CACHE = 8; // segments kept per reader

/** Segments decrypted by range readers so far (tests and probes count compaction reads with it). */
export const readerStats = { segments: 0 };

/**
 * Open a reader over an open .vx file.
 * @param {{size: number, read: (pos: number, len: number) => Promise<Buffer>}} src
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {{kind: 'pack'|'index', fileId: Buffer}} f
 * @returns {Promise<{length: number, read: (off: number, len: number) => Promise<Buffer>, close: () => void}>}
 */
export async function openVxReader(src, ctx, f) {
  if (src.size > vxSize(MAX_PAYLOAD[f.kind])) fail('TOO_BIG', 'The vault file is bigger than allowed.');
  if (src.size < HEAD + MIN_PADDED + TAG) fail('BAD_VX', 'The vault file is too short.');
  const head = vxHeaderBytes(f.kind);
  checkVxHeader(await src.read(0, HEAD), f.kind);
  const body = src.size - HEAD;
  const n = Math.ceil(body / FULL_SEGMENT);
  const lastLen = body - (n - 1) * FULL_SEGMENT;
  if (lastLen <= TAG) fail('BAD_VX', 'The vault file has a wrong size.');
  const padded = body - TAG * n;
  const key = fileKey(ctx, f.kind, f.fileId);
  const cache = new Map();
  const segment = async (i) => {
    if (cache.has(i)) return cache.get(i);
    const last = i === n - 1;
    const plain = decryptSegment(key, i, last, head, await src.read(HEAD + i * FULL_SEGMENT, last ? lastLen : FULL_SEGMENT));
    readerStats.segments++;
    if (cache.size >= CACHE) {
      const [oldest] = cache.keys();
      zero(cache.get(oldest));
      cache.delete(oldest);
    }
    cache.set(i, plain);
    return plain;
  };
  let length;
  try {
    const s0 = await segment(0);
    length = s0.readUInt32BE(0);
    if (length > MAX_PAYLOAD[f.kind] || paddedSize(length) !== padded) fail('BAD_VX', 'The vault file has a wrong length.');
  } catch (e) {
    zero(key);
    throw e;
  }
  return {
    length,
    /** Payload bytes [off, off + len). */
    async read(off, len) {
      if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0 || off + len > length) {
        fail('BAD_VX', 'A read outside the vault file.');
      }
      const out = Buffer.alloc(len);
      let done = 0;
      while (done < len) {
        const pos = 4 + off + done; // plaintext position (after the length prefix)
        const i = Math.floor(pos / SEG);
        const s = await segment(i);
        const take = Math.min(len - done, SEG - (pos - i * SEG));
        s.copy(out, done, pos - i * SEG, pos - i * SEG + take);
        done += take;
      }
      return out;
    },
    close() {
      zero(key);
      for (const s of cache.values()) zero(s);
      cache.clear();
    },
  };
}
