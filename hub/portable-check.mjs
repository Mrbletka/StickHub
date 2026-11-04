// Portable mode check (phase 4, NOT used yet). Portable mode = a device without the git clone runs the hub's code
// from the stick. Before any of it runs, the code must be exactly a commit we trust: same git blob hashes,
// no extra files (an extra file could be run as an app), no links. On the phone nothing from the stick is run,
// so this check is not needed there.

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { exists } from './sync/fsx.mjs';

const CODE_DIRS = ['hub', 'apps'];
const MAX_CODE_FILES = 5000;

/** Git's blob hash of a file: sha1("blob <size>\0" + bytes). */
export async function gitBlobHash(file) {
  const buf = await readFile(file);
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// Every entry counts here (no ignore list).
async function walk(abs, rel, out, problems) {
  for (const ent of await readdir(abs, { withFileTypes: true })) {
    const r = `${rel}/${ent.name}`;
    if (ent.isSymbolicLink()) problems.push(`${r} is a link`);
    else if (ent.isDirectory()) await walk(join(abs, ent.name), r, out, problems);
    else if (ent.isFile()) {
      if (out.size >= MAX_CODE_FILES) { problems.push('too many code files'); return; }
      out.set(r, join(abs, ent.name));
    } else problems.push(`${r} is not a file`);
  }
}

/**
 * Is the code on the stick (HUB/hub, HUB/apps) exactly a commit that `git` knows?
 * @param {{git: ReturnType<import('./platform/git.mjs').createGit>, hubDir: string, stick: {commit: string|null, codeState: string}}} o
 * @returns {Promise<{ok: boolean, problems: string[]}>} problems: a readable list of the differences
 */
export async function verifyStickCode(o) {
  const problems = [];
  if (!(await o.git.available())) return { ok: false, problems: ['No git clone here to check the code on the stick against.'] };
  if (o.stick.codeState !== 'complete' || !o.stick.commit) {
    return { ok: false, problems: ['The code on the stick is missing or incomplete. Copy it first: node hub/cli.mjs sync run code'] };
  }
  const head = await o.git.head();
  const known = o.stick.commit === head || (await o.git.isAncestor(o.stick.commit, head)) === true;
  const blobs = known ? await o.git.treeBlobs(o.stick.commit, CODE_DIRS) : null;
  if (!blobs) return { ok: false, problems: [`The stick has code (${o.stick.commit.slice(0, 7)}) that this clone does not know.`] };
  const files = new Map();
  for (const dir of CODE_DIRS) {
    const abs = join(o.hubDir, dir);
    if (await exists(abs)) await walk(abs, dir, files, problems);
  }
  for (const [rel, sha] of blobs) {
    if (!files.has(rel)) problems.push(`missing on the stick: ${rel}`);
    else if ((await gitBlobHash(files.get(rel))) !== sha) problems.push(`changed on the stick: ${rel}`);
  }
  for (const rel of files.keys()) if (!blobs.has(rel)) problems.push(`not part of the code: ${rel}`);
  return { ok: problems.length === 0, problems: problems.slice(0, 12).concat(problems.length > 12 ? [`… and ${problems.length - 12} more`] : []) };
}
