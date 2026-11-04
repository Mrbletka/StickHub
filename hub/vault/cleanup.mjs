// Cleanup of a replica folder (design 8.6). Runs inside the store's write queue only. Two levels:
// - FULL: keeps the 2 newest valid indexes and every pack they use (files and trash); removes index .part leftovers,
//   older index files, packs no kept index uses, header .part leftovers; finishes an interrupted header write.
//   It runs only when nothing is wrong: no damaged index file, no header problem (at open, or when re-checked now).
// - LIGHT: when full is refused because of damage, it still removes index .part files and valid index files beyond
//   the 2 newest valid ones, so index files cannot pile up until open fails. It never touches packs, damaged files
//   or headers.
// Neither runs if the order of the indexes is unclear: the newest index on disk is not the one the store knows, two
// indexes share a number, or indexes of different replicas are mixed. File times are never used; files whose names
// are not canonical vault names are never touched.

import { join } from 'node:path';
import { ioError } from './errors.mjs';
import { usage } from './indexfile.mjs';
import {
  scanIndexes, scanProblems, orderProblems, checkHeaderCopies, isVxName,
  INDEX_DIR, PACK_DIR, HEADER_MAIN, HEADER_BACKUP, MAX_INDEX_FILES, MAX_PACK_FILES,
} from './replica.mjs';

/**
 * @param {{dir: string, vfs: object, ctx: object, dk: Buffer, current: string, problems: string[]}} o
 *   current: the newest index file the store knows; problems: what the store found when it opened
 * @returns {Promise<{done: boolean, level: 'full'|'light'|'none', reasons: string[], removed: object, indexFiles: number}>}
 *   reasons: why full (or any) cleanup was refused, each once; indexFiles: files left in _index
 */
export async function runCleanup(o) {
  const { dir, vfs } = o;
  const removed = { indexParts: 0, indexes: 0, packs: 0, headerParts: 0, headerBackup: false };
  try {
    const scan = await scanIndexes(dir, o.ctx, vfs);
    const header = await checkHeaderCopies(dir, o.dk, o.ctx.vaultId, vfs); // now, not only at open
    const blockAll = orderProblems(scan);
    if (scan.valid[0]?.name !== o.current) blockAll.push('the newest index on disk is not the one this store knows');
    const blockFull = [...o.problems, ...scanProblems(scan), ...(header.problem ? [header.problem] : []), ...blockAll];
    const reasons = [...new Set(blockFull)];
    if (blockAll.length) return { done: false, level: 'none', reasons, removed, indexFiles: scan.count };

    for (const n of scan.parts) { await vfs.remove(join(dir, INDEX_DIR, n)); removed.indexParts++; }
    for (const v of scan.valid.slice(2)) { await vfs.remove(join(dir, INDEX_DIR, v.name)); removed.indexes++; }
    const level = reasons.length ? 'light' : 'full';
    if (level === 'full') {
      const used = new Set();
      for (const k of scan.valid.slice(0, 2)) for (const n of usage(k.state.files, k.state.trash).keys()) used.add(n);
      for (const n of await vfs.list(join(dir, PACK_DIR), MAX_PACK_FILES)) {
        if (isVxName(n) && !used.has(n.slice(0, -3))) { await vfs.remove(join(dir, PACK_DIR, n)); removed.packs++; }
      }
      const top = await vfs.list(dir, MAX_PACK_FILES);
      for (const n of [HEADER_MAIN, HEADER_BACKUP]) {
        if (top.includes(`${n}.part`)) { await vfs.remove(join(dir, `${n}.part`)); removed.headerParts++; }
      }
      if (header.backupBehind) { // an interrupted header write: finish it from the main copy checked just now
        await vfs.writeAtomic(join(dir, HEADER_BACKUP), header.text);
        removed.headerBackup = true;
      }
    }
    const indexFiles = (await vfs.list(join(dir, INDEX_DIR), MAX_INDEX_FILES)).length;
    return { done: true, level, reasons, removed, indexFiles };
  } catch (e) {
    throw ioError(e);
  }
}
