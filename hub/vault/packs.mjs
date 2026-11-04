// Packs and the next index for a commit. No I/O.
// - buildPacks: new blobs (content id -> data) cut into pieces, at most packData bytes (default 31 MiB; the rest of
//   the 32 MiB is room for the table of contents) and 4096 pieces per pack.
// - packPieces: existing pieces moved by compaction, grouped into packs of about `target` bytes, never cut.
// - prepareCommit: fill in extents, check limits, encode the next index and decode it back once: an index this code
//   cannot read is never written.
// Every pack is encrypted under a new random name.

import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';
import { fileIdToName } from './bytes.mjs';
import { sealVx, newFileId } from './vx.mjs';
import { encodePack, encodeIndex, decodeIndex, usage } from './indexfile.mjs';

export const PACK_DATA = 31 * 1024 * 1024;
export const PACK_PIECES = 4096;

/** Seal groups of pieces into packs; ext: key(piece) -> extent [pack, offset, length]. */
function seal(groups, ctx, random, key) {
  const ext = new Map();
  const sizes = new Map();
  const packs = groups.map((g) => {
    const fileId = newFileId(random);
    const name = fileIdToName(fileId);
    const { payload, offsets } = encodePack(g.pieces);
    g.pieces.forEach((p, i) => {
      const k = key(p);
      if (!ext.has(k)) ext.set(k, []);
      ext.get(k).push([name, offsets[i], p.data.length]);
    });
    sizes.set(name, payload.length);
    return { name, file: sealVx(payload, ctx, { kind: 'pack', fileId }) };
  });
  return { packs, ext, sizes };
}

/**
 * @param {Map<string, {data: Buffer, path: string}>} blobs  content id -> data (path: a hint for a repair tool)
 * @returns {{packs: {name: string, file: Buffer}[], ext: Map<string, [string, number, number][]>, sizes: Map<string, number>}}
 *   ext: content id -> extents in order; sizes: pack name -> payload size
 */
export function buildPacks(blobs, ctx, random = randomBytes, now = Date.now(), packData = PACK_DATA) {
  const groups = [];
  let cur = { pieces: [], bytes: 0 };
  for (const [id, blob] of blobs) {
    for (let off = 0, part = 0; off < blob.data.length; part++) {
      if (cur.bytes >= packData || cur.pieces.length >= PACK_PIECES) { groups.push(cur); cur = { pieces: [], bytes: 0 }; }
      const take = Math.min(packData - cur.bytes, blob.data.length - off);
      cur.pieces.push({ id, part, data: blob.data.subarray(off, off + take), path: blob.path, t: now });
      cur.bytes += take;
      off += take;
    }
  }
  if (cur.pieces.length) groups.push(cur);
  return seal(groups, ctx, random, (p) => p.id);
}

/**
 * Pieces moved by compaction, grouped into packs of about `target` bytes (a piece is never cut).
 * @param {{key: string, id: string, part: number, data: Buffer, path: string}[]} pieces  key = "pack:offset:length"
 * @returns {{packs: object[], map: Map<string, [string, number, number]>, sizes: Map<string, number>}}
 *   map: old piece key -> its new extent
 */
export function packPieces(pieces, ctx, random = randomBytes, now = Date.now(), target = 8 * 1024 * 1024) {
  const groups = [];
  let cur = { pieces: [], bytes: 0 };
  for (const p of pieces) {
    if (cur.pieces.length && (cur.bytes + p.data.length > target || cur.pieces.length >= PACK_PIECES)) { groups.push(cur); cur = { pieces: [], bytes: 0 }; }
    cur.pieces.push({ ...p, t: now });
    cur.bytes += p.data.length;
  }
  if (cur.pieces.length) groups.push(cur);
  const { packs, ext, sizes } = seal(groups, ctx, random, (p) => p.key);
  return { packs, map: new Map([...ext].map(([k, [e]]) => [k, e])), sizes };
}

/**
 * The next state and its encoded index for a draft (see store-ops.mjs). No I/O.
 * @param {object} state  the committed state
 * @param {import('./store-ops.mjs').Draft} d
 * @param {{ctx: object, limits: {packs: number, indexBytes: number, packData?: number}, random: Function, now: number}} o
 * @returns {{next: object, packs: {name: string, file: Buffer}[], payload: Buffer}}
 */
export function prepareCommit(state, d, o) {
  const built = buildPacks(d.newBlobs, o.ctx, o.random, o.now, o.limits.packData);
  const packs = [...d.extraPacks, ...built.packs];
  const packSizes = new Map([...state.packSizes, ...d.extraSizes, ...built.sizes]);
  const fill = (e) => (e.kind === 'f' && e.x === null ? { ...e, x: built.ext.get(e.id) } : e);
  const files = new Map([...d.files].map(([p, e]) => [p, fill(e)]));
  const trash = d.trash.map(fill);
  const used = usage(files, trash);
  if (used.size > o.limits.packs) fail('TOO_MANY_PACKS', 'The vault has too many packs. Compact it first.');
  for (const n of [...packSizes.keys()]) if (!used.has(n)) packSizes.delete(n);
  const next = { ...state, seq: state.seq + 1, time: o.now, files, trash, packSizes };
  const payload = encodeIndex(next, o.ctx);
  if (payload.length > o.limits.indexBytes) fail('TOO_BIG', 'The vault index would be bigger than 16 MiB.');
  let back = null; // never write an index this code cannot read back
  try { back = decodeIndex(payload, o.ctx); } catch { back = null; }
  if (!back || back.seq !== next.seq || back.files.size !== files.size || back.trash.length !== trash.length) {
    fail('INTERNAL', 'The vault index could not be built (a bug). Nothing was saved.');
  }
  return { next, packs, payload };
}
