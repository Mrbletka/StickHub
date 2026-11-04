// Cleanup of a replica folder (design 8.6). Runs inside the store's write queue only.
// Safety first: it touches NOTHING if any index file is damaged, a header copy failed (problems), two indexes share
// a number, the newest index on disk is not the one the store knows, or a header copy fails its check right now. Otherwise it keeps the 2 newest valid
// indexes and every pack they use (files and trash), and removes: index .part leftovers, older index files, packs no
// kept index uses, header .part leftovers; and it finishes an interrupted header write (backup behind the main copy).
// It never looks at file times (exFAT times are unreliable) and never touches files whose names are not its own.

import { join } from 'node:path';
import { ioError } from './errors.mjs';
import { usage } from './indexfile.mjs';
import { scanIndexes, scanProblems, checkHeaderCopies, isVxName, INDEX_DIR, PACK_DIR, HEADER_MAIN, HEADER_BACKUP, MAX_PACK_FILES } from './replica.mjs';

/**
 * @param {{dir: string, vfs: object, ctx: object, dk: Buffer, current: string, problems: string[]}} o
 *   current: the newest index file the store knows; problems: what the store found when it opened
 * @returns {Promise<{done: boolean, reasons?: string[], removed?: object}>}
 */
export async function runCleanup(o) {
  const { dir, vfs } = o;
  let scan;
  let header;
  try {
    scan = await scanIndexes(dir, o.ctx, vfs);
    header = await checkHeaderCopies(dir, o.dk, o.ctx.vaultId, vfs); // now, not only at open
  } catch (e) {
    throw ioError(e);
  }
  const reasons = [...o.problems, ...scanProblems(scan)];
  if (header.problem) reasons.push(header.problem);
  if (scan.valid[0]?.name !== o.current) reasons.push('the newest index on disk is not the one this store knows');
  if (reasons.length) return { done: false, reasons }; // touch nothing
  const keep = scan.valid.slice(0, 2);
  const used = new Set();
  for (const k of keep) for (const n of usage(k.state.files, k.state.trash).keys()) used.add(n);
  const removed = { indexParts: 0, indexes: 0, packs: 0, headerParts: 0, headerBackup: false };
  try {
    for (const n of scan.parts) { await vfs.remove(join(dir, INDEX_DIR, n)); removed.indexParts++; }
    for (const v of scan.valid.slice(2)) { await vfs.remove(join(dir, INDEX_DIR, v.name)); removed.indexes++; }
    for (const n of await vfs.list(join(dir, PACK_DIR), MAX_PACK_FILES)) {
      if (isVxName(n) && !used.has(n.slice(0, -3))) { await vfs.remove(join(dir, PACK_DIR, n)); removed.packs++; }
    }
    for (const n of [HEADER_MAIN, HEADER_BACKUP]) {
      const part = join(dir, `${n}.part`);
      if ((await vfs.list(dir, MAX_PACK_FILES)).includes(`${n}.part`)) { await vfs.remove(part); removed.headerParts++; }
    }
    if (header.backupBehind) { // an interrupted header write: finish it from the main copy checked just now
      await vfs.writeAtomic(join(dir, HEADER_BACKUP), header.text);
      removed.headerBackup = true;
    }
  } catch (e) {
    throw ioError(e);
  }
  return { done: true, removed };
}
