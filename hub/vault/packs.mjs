// Packs for a commit: the new blobs (content id -> data) cut into pieces, at most 31 MiB of blob bytes and 4096 pieces
// per pack (the rest of the 32 MiB is room for the table of contents), each pack encrypted under a new random name.

import { randomBytes } from 'node:crypto';
import { fileIdToName } from './bytes.mjs';
import { sealVx, newFileId } from './vx.mjs';
import { encodePack } from './indexfile.mjs';

export const PACK_DATA = 31 * 1024 * 1024;
export const PACK_PIECES = 4096;

/**
 * @param {Map<string, {data: Buffer, path: string}>} blobs  content id -> data (path: a hint for a repair tool)
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {(n: number) => Buffer} [random]
 * @param {number} [now]
 * @returns {{packs: {name: string, file: Buffer}[], ext: Map<string, [string, number, number][]>, sizes: Map<string, number>}}
 *   ext: content id -> extents [pack name, offset, length]; sizes: pack name -> payload size
 */
export function buildPacks(blobs, ctx, random = randomBytes, now = Date.now()) {
  const groups = [];
  let cur = { pieces: [], bytes: 0 };
  for (const [id, blob] of blobs) {
    for (let off = 0, part = 0; off < blob.data.length; part++) {
      if (cur.bytes >= PACK_DATA || cur.pieces.length >= PACK_PIECES) { groups.push(cur); cur = { pieces: [], bytes: 0 }; }
      const take = Math.min(PACK_DATA - cur.bytes, blob.data.length - off);
      cur.pieces.push({ id, part, data: blob.data.subarray(off, off + take), path: blob.path, t: now });
      cur.bytes += take;
      off += take;
    }
  }
  if (cur.pieces.length) groups.push(cur);
  const ext = new Map();
  const sizes = new Map();
  const packs = groups.map((g) => {
    const fileId = newFileId(random);
    const name = fileIdToName(fileId);
    const { payload, offsets } = encodePack(g.pieces);
    g.pieces.forEach((p, i) => { if (!ext.has(p.id)) ext.set(p.id, []); ext.get(p.id).push([name, offsets[i], p.data.length]); });
    sizes.set(name, payload.length);
    return { name, file: sealVx(payload, ctx, { kind: 'pack', fileId }) };
  });
  return { packs, ext, sizes };
}
