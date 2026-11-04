// Index and pack contents (design 6.4, 6.3). Everything decoded here comes from the stick: it is checked field by field
// after decryption, with limits (design 6.6). Error messages name the field, never a path or a file name inside it.
//
// Index payload: deflated JSON
//   { v: 1, vault, replica, epoch, seq, time,
//     files:   { "<path>": { kind: 'f', id, size, mtime, x: [[pack, off, len], ...] } | { kind: 'd', mtime } },
//     trash:   [ { tid, path, kind: 'f', id, size, mtime, x, deletedAt } | { tid, path, kind: 'd', mtime, deletedAt } ],
//     packs:   { "<pack name>": { size, live } },   // every pack the files and trash use
//     peers:   { "<replica id>": { base: { "<path>": id }, seenSeq, seenEpoch, lastSync } },
//     devices: { "<slot id>": { name, created, lastUsed } } }
// Pack payload: blob bytes, then the deflated JSON table of contents, then its length (4 bytes, big-endian):
//   toc = { v: 1, blobs: [ { id, part, off, len, path, t } ] }   (path and time are only a hint for a repair tool)

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fail, VaultError } from './errors.mjs';
import { fromB64u, toB64u } from './bytes.mjs';
import { MAX_PAYLOAD } from './vx.mjs';
import { relOk, LIMITS as PATH_LIMITS } from '../sync/safe-path.mjs';

export const INDEX_LIMITS = Object.freeze({
  files: 100_000, trash: 100_000, packs: 10_000, peers: 64, devices: 16, extents: 64,
  inflated: 64 * 1024 * 1024, fileBytes: PATH_LIMITS.dataFile, tocBlobs: 4096,
});
const NAME_RE = /^[a-z2-7]{26}$/;
const TID_RE = /^[0-9a-f]{16}$/;
const TIME_MAX = 8.64e15;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (what) => fail('BAD_INDEX', `The vault index is damaged (${what}).`);

function keys(o, want, what) {
  if (!isObj(o)) bad(what);
  const got = Object.keys(o);
  if (got.length !== want.length || !want.every((k) => Object.hasOwn(o, k))) bad(what);
}
const int = (v, min, max, what) => { if (!Number.isSafeInteger(v) || v < min || v > max) bad(what); return v; };
const b64 = (v, len, what) => {
  try { fromB64u(v, len, what, 'BAD_INDEX'); } catch (e) { if (e instanceof VaultError) bad(what); throw e; }
  return v;
};
const path = (p, what) => { if (typeof p !== 'string' || !relOk(p)) bad(what); return p; };

/** Check extents against the pack table; they must add up to size. */
function extents(x, size, packs, what) {
  if (!Array.isArray(x) || x.length > INDEX_LIMITS.extents) bad(what);
  let sum = 0;
  for (const e of x) {
    if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== 'string' || !NAME_RE.test(e[0])) bad(what);
    const p = packs[e[0]];
    if (!p) bad(`${what}: unknown pack`);
    int(e[1], 0, p.size - 1, what);
    int(e[2], 1, p.size - e[1], what);
    sum += e[2];
  }
  if (sum !== size) bad(`${what}: sizes do not add up`);
  return x.map((e) => [e[0], e[1], e[2]]);
}

function fileEntry(e, packs, what) {
  if (e?.kind === 'd') {
    keys(e, ['kind', 'mtime'], what);
    return { kind: 'd', mtime: int(e.mtime, 0, TIME_MAX, what) };
  }
  keys(e, ['kind', 'id', 'size', 'mtime', 'x'], what);
  if (e.kind !== 'f') bad(what);
  const size = int(e.size, 0, INDEX_LIMITS.fileBytes, what);
  return { kind: 'f', id: b64(e.id, 32, what), size, mtime: int(e.mtime, 0, TIME_MAX, what), x: extents(e.x, size, packs, what) };
}

/**
 * Decode and check an index payload.
 * @param {Buffer} payload  decrypted .vx payload
 * @param {{vaultId: Buffer, epoch: number}} expect
 * @returns {{seq: number, replica: string, time: number, files: Map<string, object>, trash: object[],
 *   packSizes: Map<string, number>, peers: object, devices: object}}
 */
export function decodeIndex(payload, expect) {
  let j;
  try {
    j = JSON.parse(inflateRawSync(payload, { maxOutputLength: INDEX_LIMITS.inflated }).toString('utf8'));
  } catch {
    return bad('not readable');
  }
  keys(j, ['v', 'vault', 'replica', 'epoch', 'seq', 'time', 'files', 'trash', 'packs', 'peers', 'devices'], 'top level');
  if (j.v !== 1) fail(Number.isSafeInteger(j.v) && j.v > 1 ? 'UNSUPPORTED' : 'BAD_INDEX', 'The vault index has an unknown version.');
  if (j.vault !== toB64u(expect.vaultId) || j.epoch !== expect.epoch) bad('another vault or epoch');
  b64(j.replica, 16, 'replica');
  const seq = int(j.seq, 1, 2 ** 52, 'seq');
  const time = int(j.time, 0, TIME_MAX, 'time');

  if (!isObj(j.packs) || Object.keys(j.packs).length > INDEX_LIMITS.packs) bad('pack table');
  const packs = Object.create(null);
  for (const [name, p] of Object.entries(j.packs)) {
    if (!NAME_RE.test(name)) bad('pack name');
    keys(p, ['size', 'live'], 'pack table');
    const size = int(p.size, 1, MAX_PAYLOAD.pack, 'pack size');
    packs[name] = { size, live: int(p.live, 0, size, 'pack live bytes') };
  }

  if (!isObj(j.files) || Object.keys(j.files).length > INDEX_LIMITS.files) bad('file list');
  const files = new Map();
  for (const [p, e] of Object.entries(j.files)) files.set(path(p, 'a path'), fileEntry(e, packs, 'a file entry'));
  for (const p of files.keys()) {
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (files.get(p.slice(0, i))?.kind !== 'd') bad('a folder is missing');
  }

  if (!Array.isArray(j.trash) || j.trash.length > INDEX_LIMITS.trash) bad('trash');
  const tids = new Set();
  const trash = j.trash.map((t) => {
    if (!isObj(t) || typeof t.tid !== 'string' || !TID_RE.test(t.tid) || tids.has(t.tid)) bad('trash entry');
    tids.add(t.tid);
    const { tid, path: tp, deletedAt, ...rest } = t;
    path(tp, 'trash path');
    return { tid, path: tp, ...fileEntry(rest, packs, 'trash entry'), deletedAt: int(deletedAt, 0, TIME_MAX, 'trash time') };
  });

  // The pack table must list exactly the packs in use, with the right live bytes.
  const live = usage(files, trash);
  if (live.size !== Object.keys(packs).length) bad('pack table does not match the files');
  for (const [name, bytes] of live) if (packs[name]?.live !== bytes) bad('pack live bytes');

  if (!isObj(j.peers) || Object.keys(j.peers).length > INDEX_LIMITS.peers) bad('peers');
  for (const [id, peer] of Object.entries(j.peers)) {
    b64(id, 16, 'peer id');
    keys(peer, ['base', 'seenSeq', 'seenEpoch', 'lastSync'], 'peer');
    if (!isObj(peer.base) || Object.keys(peer.base).length > INDEX_LIMITS.files) bad('peer base');
    for (const [p, cid] of Object.entries(peer.base)) { path(p, 'peer path'); b64(cid, 32, 'peer content id'); }
    int(peer.seenSeq, 0, 2 ** 52, 'peer seq');
    int(peer.seenEpoch, 0, 0xffffffff, 'peer epoch');
    int(peer.lastSync, 0, TIME_MAX, 'peer time');
  }
  if (!isObj(j.devices) || Object.keys(j.devices).length > INDEX_LIMITS.devices) bad('devices');
  for (const [id, d] of Object.entries(j.devices)) {
    b64(id, 16, 'device id');
    keys(d, ['name', 'created', 'lastUsed'], 'device');
    if (typeof d.name !== 'string' || !d.name.length || d.name.length > 40) bad('device name');
    int(d.created, 0, TIME_MAX, 'device time');
    int(d.lastUsed, 0, TIME_MAX, 'device time');
  }
  const packSizes = new Map(Object.entries(packs).map(([n, p]) => [n, p.size]));
  return { seq, replica: j.replica, time, files, trash, packSizes, peers: j.peers, devices: j.devices };
}

/** Live bytes per pack, from the extents of files and trash. */
export function usage(files, trash) {
  const live = new Map();
  const add = (e) => { if (e.kind === 'f') for (const [n, , len] of e.x) live.set(n, (live.get(n) || 0) + len); };
  for (const e of files.values()) add(e);
  for (const e of trash) add(e);
  return live;
}

/**
 * Encode an index payload (deflated JSON). Extents must be filled in.
 * @param {ReturnType<typeof decodeIndex>} s
 * @param {{vaultId: Buffer, epoch: number}} ctx
 * @returns {Buffer}
 */
export function encodeIndex(s, ctx) {
  const live = usage(s.files, s.trash);
  const packs = {};
  for (const [name, bytes] of [...live].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!s.packSizes.has(name)) fail('BAD_INPUT', 'encodeIndex: a pack size is missing');
    packs[name] = { size: s.packSizes.get(name), live: bytes };
  }
  const out = (e) => (e.kind === 'd' ? { kind: 'd', mtime: e.mtime } : { kind: 'f', id: e.id, size: e.size, mtime: e.mtime, x: e.x });
  const files = {};
  for (const p of [...s.files.keys()].sort()) files[p] = out(s.files.get(p));
  const trash = s.trash.map((t) => ({ tid: t.tid, path: t.path, ...out(t), deletedAt: t.deletedAt }));
  const j = { v: 1, vault: toB64u(ctx.vaultId), replica: s.replica, epoch: ctx.epoch, seq: s.seq, time: s.time, files, trash, packs, peers: s.peers, devices: s.devices };
  return deflateRawSync(Buffer.from(JSON.stringify(j)));
}

/**
 * Build a pack payload from pieces of blobs.
 * @param {{id: string, part: number, data: Buffer, path: string, t: number}[]} pieces
 * @returns {{payload: Buffer, offsets: number[]}} offsets[i] = where piece i starts in the payload
 */
export function encodePack(pieces) {
  if (!pieces.length || pieces.length > INDEX_LIMITS.tocBlobs) fail('BAD_INPUT', 'encodePack: 1 to 4096 pieces');
  const offsets = [];
  let off = 0;
  for (const p of pieces) { offsets.push(off); off += p.data.length; }
  const toc = deflateRawSync(Buffer.from(JSON.stringify({ v: 1, blobs: pieces.map((p, i) => ({ id: p.id, part: p.part, off: offsets[i], len: p.data.length, path: p.path, t: p.t })) })));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(toc.length);
  const payload = Buffer.concat([...pieces.map((p) => p.data), toc, len]);
  if (payload.length > MAX_PAYLOAD.pack) fail('TOO_BIG', 'A pack would be bigger than allowed.');
  return { payload, offsets };
}

/**
 * Read and check a pack's table of contents through a range reader.
 * @param {{length: number, read: (off: number, len: number) => Promise<Buffer>}} reader
 * @returns {Promise<{id: string, part: number, off: number, len: number}[]>}
 */
export async function readPackToc(reader) {
  if (reader.length < 4) bad('pack too short');
  const tocLen = (await reader.read(reader.length - 4, 4)).readUInt32BE(0);
  if (tocLen > reader.length - 4) bad('pack table of contents');
  let j;
  try {
    j = JSON.parse(inflateRawSync(await reader.read(reader.length - 4 - tocLen, tocLen), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'));
  } catch {
    return bad('pack table of contents');
  }
  keys(j, ['v', 'blobs'], 'pack table of contents');
  if (j.v !== 1 || !Array.isArray(j.blobs) || j.blobs.length > INDEX_LIMITS.tocBlobs) bad('pack table of contents');
  const end = reader.length - 4 - tocLen;
  return j.blobs.map((b) => {
    keys(b, ['id', 'part', 'off', 'len', 'path', 't'], 'pack table of contents');
    b64(b.id, 32, 'pack blob id');
    int(b.part, 0, INDEX_LIMITS.extents, 'pack blob part');
    int(b.off, 0, end, 'pack blob offset');
    int(b.len, 1, end - b.off, 'pack blob length');
    return { id: b.id, part: b.part, off: b.off, len: b.len };
  });
}
