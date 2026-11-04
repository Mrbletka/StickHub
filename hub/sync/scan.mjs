// Walks a folder and lists its files with size and sha256. Untrusted-safe: odd names, symlinks,
// too-big files and too many files are reported as skipped, never followed or read.

import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { nameOk, isIgnored, LIMITS } from './safe-path.mjs';

/**
 * @typedef {{size: number, hash: string|null}} FileInfo
 * @typedef {{files: Map<string, FileInfo>, parts: string[], skipped: {rel: string, why: string}[]}} ScanResult
 */

/**
 * Scan root. A missing root is an empty tree.
 * @param {string} root
 * @param {{fsx: ReturnType<import('./fsx.mjs').createFsx>, hash?: boolean, maxFileSize?: number,
 *   maxFiles?: number, signal?: AbortSignal, only?: (rel: string) => boolean}} o
 *   hash: false = sizes only (cheap); only: filter on relative paths
 * @returns {Promise<ScanResult>}
 */
export async function scanTree(root, o) {
  const files = new Map();
  const parts = [];
  const skipped = [];
  const lower = new Set();
  const maxFiles = o.maxFiles ?? LIMITS.files;
  const stack = [['', 0]];
  while (stack.length) {
    const [dirRel, depth] = stack.pop();
    let entries;
    try {
      entries = await readdir(dirRel ? join(root, dirRel) : root, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' && !dirRel) return { files, parts, skipped };
      throw e;
    }
    for (const ent of entries) {
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      if (ent.name.endsWith('.part')) { parts.push(rel); continue; }
      if (isIgnored(ent.name)) continue;
      if (!nameOk(ent.name)) { skipped.push({ rel, why: 'name not allowed' }); continue; }
      if (o.only && !o.only(rel) && !ent.isDirectory()) continue;
      if (ent.isSymbolicLink()) { skipped.push({ rel, why: 'link' }); continue; }
      if (ent.isDirectory()) {
        if (depth + 1 >= LIMITS.depth) skipped.push({ rel, why: 'folders too deep' });
        else stack.push([rel, depth + 1]);
        continue;
      }
      if (!ent.isFile()) { skipped.push({ rel, why: 'not a file' }); continue; }
      // The stick ignores case: two names that differ only in case would overwrite each other there.
      if (lower.has(rel.toLowerCase())) { skipped.push({ rel, why: 'same name in other case' }); continue; }
      if (files.size >= maxFiles) { skipped.push({ rel, why: `more than ${maxFiles} files` }); continue; }
      const st = await lstat(join(root, rel));
      if (o.maxFileSize && st.size > o.maxFileSize) { skipped.push({ rel, why: `bigger than ${Math.round(o.maxFileSize / 1048576)} MB` }); continue; }
      const hash = o.hash === false ? null : (await o.fsx.hashFile(join(root, rel), o.signal)).hash;
      files.set(rel, { size: st.size, hash });
      lower.add(rel.toLowerCase());
    }
  }
  return { files, parts, skipped };
}
