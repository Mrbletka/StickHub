// Which code is this? Reads the git commit straight from .git (no git process), or from stick.json
// on a stick snapshot (which has no .git).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The commit hash of the code in root, or null when unknown.
 * @param {string} root  repo root (folder with .git) or HUB/ folder (with stick.json)
 * @returns {Promise<string|null>}
 */
export async function codeCommit(root) {
  try {
    const head = (await readFile(join(root, '.git', 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head; // detached HEAD
    const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
    if (!ref) return null;
    try {
      return (await readFile(join(root, '.git', ref), 'utf8')).trim();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // After `git gc` the ref only lives in packed-refs.
      const packed = await readFile(join(root, '.git', 'packed-refs'), 'utf8');
      return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.slice(0, 40) || null;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    const stick = JSON.parse(await readFile(join(root, 'stick.json'), 'utf8'));
    return typeof stick.commit === 'string' ? stick.commit : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
