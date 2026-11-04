// Explicit stick -> phone code copy (`node hub/cli.mjs code pull-from-stick`). Never automatic.
// The stick's files are untrusted: names, sizes and counts are checked, nothing is run or imported.
// The clone must have no uncommitted changes, so `git status` / `git diff` show exactly what came from the stick
// and `git checkout .` undoes it.

import { join } from 'node:path';
import { scanTree } from './scan.mjs';
import { LIMITS, trashDay } from './safe-path.mjs';
import { exists } from './fsx.mjs';

const CODE_DIRS = ['hub', 'apps'];

/**
 * Plan (and with apply: do) the copy of the stick's hub/ and apps/ into the clone.
 * @param {{root: string, hubDir: string, stick: {commit: string|null, codeState: string},
 *   fsx: object, git: object, apply?: boolean, now?: () => Date}} o
 * @returns {Promise<{puts: string[], trash: string[], skipped: {rel: string, why: string}[], done: boolean}>}
 */
export async function pullCode(o) {
  if (!(await o.git.available())) throw new Error('This copy is not a git clone. Pulling code needs git so you can see and undo the changes.');
  if (!(await o.git.clean())) throw new Error('The phone has uncommitted changes. Commit or undo them first, so you can see what the stick changes.');
  if (o.stick.codeState === 'partial') throw new Error('The code on the stick is incomplete (a copy was interrupted). Not copied.');
  if (o.stick.codeState === 'none') throw new Error('The stick has no code yet.');

  const stickFiles = new Map();
  const skipped = [];
  for (const dir of CODE_DIRS) {
    const s = await scanTree(join(o.hubDir, dir), { fsx: o.fsx, maxFileSize: LIMITS.codeFile, maxFiles: 5000 });
    for (const [rel, f] of s.files) stickFiles.set(`${dir}/${rel}`, f);
    skipped.push(...s.skipped.map((x) => ({ rel: `${dir}/${x.rel}`, why: x.why })));
  }
  if (!stickFiles.size) throw new Error('No code files found on the stick.');

  const phone = new Map();
  for (const rel of await o.git.trackedFiles(CODE_DIRS)) {
    if (await exists(join(o.root, rel))) phone.set(rel, await o.fsx.hashFile(join(o.root, rel)));
  }
  const puts = [...stickFiles].filter(([rel, f]) => phone.get(rel)?.hash !== f.hash).map(([rel]) => rel).sort();
  const trash = [...phone.keys()].filter((rel) => !stickFiles.has(rel)).sort();
  if (!o.apply) return { puts, trash, skipped, done: false };

  const trashDir = join(o.root, '.trash', trashDay((o.now || (() => new Date()))()), 'code');
  for (const rel of trash) await o.fsx.moveToTrash(join(o.root, rel), trashDir, rel);
  for (const rel of puts) {
    await o.fsx.copySafe(join(o.hubDir, rel), join(o.root, rel), { expectHash: stickFiles.get(rel).hash, maxBytes: LIMITS.codeFile });
  }
  return { puts, trash, skipped, done: true };
}
