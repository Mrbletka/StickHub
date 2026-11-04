// Reading files from a replica's packs (used by the store). Every pack segment is authenticated before use.
// - readRange: whole reads are checked against the content id (HMAC); part reads check each piece against the pack's
//   table of contents (the piece must be listed under that content id, offset and length).
// - readChunks: a whole file in chunks (export, verify, compaction), so a 256 MiB file is never held in memory; the
//   content id is checked after the last chunk: a consumer must not use the chunks unless the iteration ends cleanly.
// A missing pack file is PACK_MISSING (the running hub may have cleaned up since this store opened).

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { fail } from './errors.mjs';
import { parseVxFileName } from './vx.mjs';
import { openVxReader } from './vxread.mjs';
import { readPackToc } from './indexfile.mjs';
import { PACK_DIR } from './replica.mjs';

const TOC_CACHE = 32;
export const CHUNK = 4 * 1024 * 1024;

export class PackReader {
  #dir; #vfs; #ctx; #tocs = new Map();

  /** @param {string} dir  @param {object} vfs  @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx */
  constructor(dir, vfs, ctx) { this.#dir = dir; this.#vfs = vfs; this.#ctx = ctx; }

  /**
   * Bytes [off, off + len) of a pack's payload. tocCheck {id, off, len}: the piece must be in the table of contents.
   * @returns {Promise<Buffer>}
   */
  read(pack, off, len, tocCheck = null) {
    return this.withPack(pack, async (r) => {
      if (tocCheck) {
        let toc = this.#tocs.get(pack);
        if (!toc) {
          toc = await readPackToc(r);
          if (this.#tocs.size >= TOC_CACHE) this.#tocs.delete(this.#tocs.keys().next().value);
          this.#tocs.set(pack, toc);
        }
        if (!toc.some((b) => b.id === tocCheck.id && b.off === tocCheck.off && b.len === tocCheck.len)) fail('BAD_VX', 'A pack does not hold what the index says.');
      }
      return r.read(off, len);
    });
  }

  /**
   * Open one pack and run fn with its range reader (every segment authenticated before use), then close it.
   * @param {string} pack
   * @param {(r: {length: number, read: Function}) => Promise<any>} fn
   * @param {number} [keep]  segments the reader keeps (Infinity: each segment is decrypted at most once)
   */
  async withPack(pack, fn, keep) {
    const f = await this.#vfs.openRead(join(this.#dir, PACK_DIR, `${pack}.vx`)).catch((err) => {
      if (err.code === 'ENOENT') fail('PACK_MISSING', 'A pack file of the vault is missing.');
      throw err;
    });
    let r = null;
    try {
      r = await openVxReader(f, this.#ctx, { kind: 'pack', fileId: parseVxFileName(`${pack}.vx`) }, keep);
      return await fn(r);
    } finally {
      r?.close();
      await f.close();
    }
  }

  clear() { this.#tocs.clear(); }
}

const contentId = (key) => createHmac('sha256', key);

/**
 * Bytes [start, end) of a file entry.
 * @param {PackReader} pr
 * @param {{id: string, size: number, x: [string, number, number][]}} e
 * @param {Buffer} kId  content-id key
 */
export async function readRange(pr, e, start, end, kId) {
  const whole = start === 0 && end === e.size;
  const parts = [];
  let pos = 0;
  for (const [pack, off, len] of e.x) {
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + len);
    if (b > a) parts.push(await pr.read(pack, off + (a - pos), b - a, whole ? null : { id: e.id, off, len }));
    pos += len;
  }
  const data = Buffer.concat(parts);
  if (whole && contentId(kId).update(data).digest('base64url') !== e.id) fail('BAD_VX', 'A file in the vault does not match its content id.');
  return data;
}

/**
 * A whole file in chunks of at most `chunk` bytes, with the extent each chunk belongs to. The content id is checked
 * after the last chunk (BAD_VX if it does not match).
 * @param {PackReader} pr
 * @param {{id: string, size: number, x: [string, number, number][]}} e
 * @param {Buffer} kId
 * @returns {AsyncGenerator<{data: Buffer, extent: number}>}
 */
export async function* readChunks(pr, e, kId, chunk = CHUNK) {
  const h = contentId(kId);
  for (let i = 0; i < e.x.length; i++) {
    const [pack, off, len] = e.x[i];
    for (let done = 0; done < len;) {
      const take = Math.min(chunk, len - done);
      const data = await pr.read(pack, off + done, take);
      h.update(data);
      done += take;
      yield { data, extent: i };
    }
  }
  if (h.digest('base64url') !== e.id) fail('BAD_VX', 'A file in the vault does not match its content id.');
}
