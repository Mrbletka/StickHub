// One replica folder (a stick's HUB/data/ or the phone's data/), layout per design 6.1:
//   vault.json, vault.bak.json   header, two copies (written .part + fsync + rename, main first)
//   _index/<id>.vx               encrypted index files: written as <id>.vx.part, fsync, renamed (the commit point)
//   _packs/<id>.vx               encrypted packs: written once under their final name, fsync (no .part)
// A .vx in _index was complete when it got its name, so one that does not decrypt is damage, not a pulled stick.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VaultError, fail } from './errors.mjs';
import { toB64u, zero } from './bytes.mjs';
import { parseHeader, verifyHeaderMac, HEADER_MAX_BYTES } from './header.mjs';
import { openVx, sealVx, vxSize, newFileId, vxFileName, parseVxFileName, MAX_PAYLOAD } from './vx.mjs';
import { decodeIndex, encodeIndex } from './indexfile.mjs';
import { ID_BYTES, subkeys } from './keys.mjs';
import { createVfs } from './vfs.mjs';

export const INDEX_DIR = '_index';
export const PACK_DIR = '_packs';
export const HEADER_MAIN = 'vault.json';
export const HEADER_BACKUP = 'vault.bak.json';
export const MAX_INDEX_FILES = 256;
export const MAX_PACK_FILES = 20_000;

const vaultCodes = new Set(['BAD_VX', 'BAD_INDEX', 'TOO_BIG', 'UNSUPPORTED']);

/** True if name is a canonical "<26 base32>.vx" name. */
export function isVxName(name) {
  try { parseVxFileName(name); return true; } catch (e) { if (e instanceof VaultError) return false; throw e; }
}

/**
 * Read the two header copies and open the vault with unlock(parsedHeader) -> data key (which also checks the MAC).
 * The main copy is tried first; the backup only if the main one fails. Nothing is written here.
 * @param {string} dir
 * @param {(h: object) => Promise<Buffer>} unlock  e.g. (h) => unlockWithPassphrase(h, pass)
 * @param {ReturnType<import('./vfs.mjs').createVfs>} vfs
 * @returns {Promise<{header: object, text: string, dk: Buffer, info: {used: 'main'|'backup', problem: string|null,
 *   backupBehind: boolean}}>}  problem: a header copy is damaged or changed (cleanup will not run);
 *   backupBehind: an interrupted header write left the backup older or missing (cleanup finishes it)
 */
export async function unlockReplica(dir, unlock, vfs) {
  const read = async (name) => (await vfs.readLimited(join(dir, name), HEADER_MAX_BYTES))?.toString('utf8') ?? null;
  const main = await read(HEADER_MAIN);
  const backup = await read(HEADER_BACKUP);
  if (main === null && backup === null) fail('NO_VAULT', 'There is no vault in this folder.');
  let mainError = null;
  if (main !== null) {
    try {
      const header = parseHeader(main);
      const dk = await unlock(header);
      return { header, text: main, dk, info: { used: 'main', ...backupState(main, backup, header, dk) } };
    } catch (e) {
      if (!(e instanceof VaultError)) throw e;
      mainError = e;
      if (backup === main || backup === null) throw e;
    }
  }
  const header = parseHeader(backup);
  const dk = await unlock(header);
  return { header, text: backup, dk, info: { used: 'backup', problem: main === null ? 'main header missing' : `main header ${mainError.code}`, backupBehind: false } };
}

function backupState(main, backup, header, dk) {
  if (backup === main) return { problem: null, backupBehind: false };
  if (backup === null) return { problem: null, backupBehind: true };
  try {
    const b = parseHeader(backup);
    verifyHeaderMac(b, dk);
    if (!b.vaultId.equals(header.vaultId)) return { problem: 'backup header of another vault', backupBehind: false };
    if (b.epoch < header.epoch || (b.epoch === header.epoch && b.hseq < header.hseq)) return { problem: null, backupBehind: true };
    return { problem: 'backup header is newer than the main one', backupBehind: false };
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    return { problem: `backup header ${e.code}`, backupBehind: false };
  }
}

/**
 * Check both header copies now, with the data key (for cleanup: it must not run on a header that fails).
 * @returns {Promise<{problem: string|null, backupBehind: boolean, text: string|null}>} text: the checked main copy
 */
export async function checkHeaderCopies(dir, dk, vaultId, vfs) {
  const read = async (name) => (await vfs.readLimited(join(dir, name), HEADER_MAX_BYTES))?.toString('utf8') ?? null;
  const main = await read(HEADER_MAIN);
  if (main === null) return { problem: 'main header missing', backupBehind: false, text: null };
  try {
    const h = parseHeader(main);
    verifyHeaderMac(h, dk);
    if (!h.vaultId.equals(vaultId)) return { problem: 'main header of another vault', backupBehind: false, text: null };
    return { ...backupState(main, await read(HEADER_BACKUP), h, dk), text: main };
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    return { problem: `main header ${e.code}`, backupBehind: false, text: null };
  }
}

/** Write both header copies: main first, then the backup (each .part, fsync, rename). */
export async function writeHeaderFiles(dir, text, vfs) {
  await vfs.writeAtomic(join(dir, HEADER_MAIN), text);
  await vfs.writeAtomic(join(dir, HEADER_BACKUP), text);
}

/**
 * Read every committed index file. Decrypt failures are listed, never fatal; I/O errors (a pulled stick) are thrown.
 * @param {string} dir
 * @param {{kFile: Buffer, vaultId: Buffer, epoch: number}} ctx
 * @param {ReturnType<import('./vfs.mjs').createVfs>} vfs
 * @returns {Promise<{valid: {name: string, seq: number, state: object}[], damaged: string[], parts: string[], count: number}>}
 *   valid sorted newest first; parts = leftover <id>.vx.part files; count = all files in _index
 */
export async function scanIndexes(dir, ctx, vfs) {
  const names = await vfs.list(join(dir, INDEX_DIR), MAX_INDEX_FILES);
  const valid = [];
  const damaged = [];
  const parts = [];
  for (const name of names.sort()) {
    if (name.endsWith('.part') && isVxName(name.slice(0, -5))) { parts.push(name); continue; }
    if (!isVxName(name)) continue; // not ours: never touched
    try {
      const file = await vfs.readLimited(join(dir, INDEX_DIR, name), vxSize(MAX_PAYLOAD.index));
      if (!file) continue;
      const state = decodeIndex(openVx(file, ctx, { kind: 'index', fileId: parseVxFileName(name) }), ctx);
      valid.push({ name, seq: state.seq, state });
    } catch (e) {
      if (!(e instanceof VaultError) || !vaultCodes.has(e.code)) throw e;
      damaged.push(name);
    }
  }
  valid.sort((a, b) => b.seq - a.seq || (a.name < b.name ? 1 : -1));
  return { valid, damaged, parts, count: names.length };
}

/**
 * Problems a scan found that make cleanup unsafe (a damaged index might hold data the others do not).
 * @param {{valid: {seq: number, state: {replica: string}}[], damaged: string[]}} scan
 * @returns {string[]}
 */
export function scanProblems(scan) {
  return [...(scan.damaged.length ? ['damaged index file'] : []), ...orderProblems(scan)];
}

/** Problems that make even the light cleanup unsafe: the order of the index files is not clear. */
export function orderProblems(scan) {
  const p = [];
  if (scan.valid[1] && scan.valid[1].seq === scan.valid[0].seq) p.push('two index files with the same number');
  if (new Set(scan.valid.map((v) => v.state.replica)).size > 1) p.push('index files of different replicas');
  return p;
}

/**
 * Encrypt and commit an encoded index: <id>.vx.part, fsync, rename to <id>.vx (the commit point), fsync the folder.
 * @param {Buffer} payload  from encodeIndex (size already checked)
 * @returns {Promise<string>} the new file name
 */
export async function writeIndexPayload(dir, payload, ctx, vfs, random = randomBytes) {
  if (payload.length > MAX_PAYLOAD.index) fail('TOO_BIG', 'The vault index would be bigger than 16 MiB.');
  const fileId = newFileId(random);
  const name = vxFileName(fileId);
  await vfs.writeAtomic(join(dir, INDEX_DIR, name), sealVx(payload, ctx, { kind: 'index', fileId }));
  return name;
}

/**
 * Create an empty replica: folders, the first index (seq 1), then the header (main, backup). A folder that already
 * holds a header or any index or pack file is refused.
 * @param {string} dir
 * @param {{headerText: string, ctx: {kFile: Buffer, vaultId: Buffer, epoch: number}, vfs: object,
 *   random?: (n: number) => Buffer, now?: () => number}} o
 */
export async function createReplica(dir, o) {
  const { vfs } = o;
  for (const name of [HEADER_MAIN, HEADER_BACKUP]) if (await vfs.readLimited(join(dir, name), HEADER_MAX_BYTES)) fail('EXISTS', 'There is already a vault here.');
  for (const sub of [INDEX_DIR, PACK_DIR]) if ((await vfs.list(join(dir, sub), MAX_PACK_FILES)).some((n) => n.includes('.vx'))) fail('EXISTS', 'This folder has vault files already.');
  for (const sub of [dir, join(dir, INDEX_DIR), join(dir, PACK_DIR)]) await vfs.mkdirp(sub);
  const random = o.random || randomBytes;
  const state = { seq: 1, replica: toB64u(random(ID_BYTES)), time: (o.now || Date.now)(), files: new Map(), trash: [], packSizes: new Map(), peers: {}, devices: {} };
  await writeIndexPayload(dir, encodeIndex(state, o.ctx), o.ctx, vfs, random);
  await writeHeaderFiles(dir, o.headerText, vfs);
}

/**
 * Create a new, empty vault in dir from a header text and its data key (Store.create opens it afterwards).
 * @param {string} dir
 * @param {{headerText: string, dk: Buffer, guard?: Function, random?: Function, now?: () => number}} o
 * @returns {Promise<object>} the parsed, checked header
 */
export async function createVault(dir, o) {
  const header = parseHeader(o.headerText);
  verifyHeaderMac(header, o.dk);
  const keys = subkeys(o.dk, header.vaultId, header.epoch);
  try {
    await createReplica(dir, { headerText: o.headerText, ctx: { kFile: keys.file, vaultId: header.vaultId, epoch: header.epoch },
      vfs: createVfs({ guard: o.guard }), random: o.random, now: o.now });
  } finally {
    zero(keys.header, keys.contentId, keys.file);
  }
  return header;
}
