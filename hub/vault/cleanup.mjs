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
// Capped (job 2b): one run does at most `max` units of work (a deleted file, or the header backup completion) in this
// order: index .part files, valid index files beyond the 2 newest, unused packs, header .part files, header backup.
// It answers more: true when work is left, and left: how many units this run saw and did not do. The next run starts
// again from its own scan and checks; only older index files may come from the store's cache (replica.scanIndexes).

import { join } from 'node:path';
import { fail, ioError } from './errors.mjs';
import { usage } from './indexfile.mjs';
import {
  scanIndexes, scanProblems, orderProblems, checkHeaderCopies, isVxName,
  INDEX_DIR, PACK_DIR, HEADER_MAIN, HEADER_BACKUP, MAX_INDEX_FILES, MAX_PACK_FILES,
} from './replica.mjs';

/** Default units of work per cleanup run: about 0.55 s of deleting on the stick (55 ms per file, probe 10). */
export const CLEANUP_MAX = 10;

/** Counts of a run that did nothing. */
export const noRemovals = () => ({ indexParts: 0, indexes: 0, packs: 0, headerParts: 0, headerBackup: false });

/**
 * One capped cleanup run.
 * @param {{dir: string, vfs: object, ctx: object, dk: Buffer, current: string, problems: string[], max?: number,
 *   cache?: Map}} o  current: the newest index file the store knows; problems: what the store found when it opened;
 *   max: units of work; cache: decoded older index files from earlier runs (see scanIndexes)
 * @returns {Promise<{done: boolean, level: 'full'|'light'|'none', reasons: string[], removed: object, indexFiles: number,
 *   more: boolean, left: number}>}  reasons: why full (or any) cleanup was refused, each once; indexFiles: files left
 *   in _index; more: work is left for another run; left: units of work this run saw but left for later
 */
export async function runCleanup(o) {
  const { dir, vfs } = o;
  const max = o.max ?? CLEANUP_MAX;
  if (!Number.isSafeInteger(max) || max < 1) fail('BAD_INPUT', 'cleanup: max must be a whole number from 1');
  const removed = noRemovals();
  try {
    const scan = await scanIndexes(dir, o.ctx, vfs, o.cache);
    const header = await checkHeaderCopies(dir, o.dk, o.ctx.vaultId, vfs); // now, not only at open
    const blockAll = orderProblems(scan);
    if (scan.valid[0]?.name !== o.current) blockAll.push('the newest index on disk is not the one this store knows');
    const blockFull = [...o.problems, ...scanProblems(scan), ...(header.problem ? [header.problem] : []), ...blockAll];
    const reasons = [...new Set(blockFull)];
    if (blockAll.length) return { done: false, level: 'none', reasons, removed, indexFiles: scan.count, more: false, left: 0 };

    // The whole plan, in order; this run does the first `max` units.
    const level = reasons.length ? 'light' : 'full';
    const plan = [];
    for (const n of scan.parts) plan.push(['indexParts', join(dir, INDEX_DIR, n)]);
    for (const v of scan.valid.slice(2)) plan.push(['indexes', join(dir, INDEX_DIR, v.name)]);
    if (level === 'full') {
      const used = new Set(); // packs the 2 newest valid indexes of THIS scan use: never deleted
      for (const k of scan.valid.slice(0, 2)) for (const n of usage(k.state.files, k.state.trash).keys()) used.add(n);
      for (const n of await vfs.list(join(dir, PACK_DIR), MAX_PACK_FILES)) {
        if (isVxName(n) && !used.has(n.slice(0, -3))) plan.push(['packs', join(dir, PACK_DIR, n)]);
      }
    }
    if (level === 'full') {
      const top = await vfs.list(dir, MAX_PACK_FILES);
      for (const n of [HEADER_MAIN, HEADER_BACKUP]) if (top.includes(`${n}.part`)) plan.push(['headerParts', join(dir, `${n}.part`)]);
      if (header.backupBehind) plan.push(['headerBackup', null]); // last: finish an interrupted header write
    }
    for (const [kind, path] of plan.slice(0, max)) {
      if (kind === 'headerBackup') {
        await vfs.writeAtomic(join(dir, HEADER_BACKUP), header.text); // the main copy, checked just now
        removed.headerBackup = true;
      } else {
        await vfs.remove(path);
        removed[kind]++;
      }
    }
    const indexFiles = (await vfs.list(join(dir, INDEX_DIR), MAX_INDEX_FILES)).length;
    return { done: true, level, reasons, removed, indexFiles, more: plan.length > max, left: Math.max(0, plan.length - max) };
  } catch (e) {
    throw ioError(e);
  }
}
