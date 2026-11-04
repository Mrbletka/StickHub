// Git adapter: the few git questions code sync asks. Argument arrays, never a shell, always a timeout.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const TIMEOUT_MS = 15_000;

/**
 * Run git in root. Resolves {code, stdout, stderr}; rejects only if git cannot run at all or times out.
 */
function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(new Error(err.killed ? `git ${args[0]} took longer than ${TIMEOUT_MS / 1000} s` : `git: ${err.code || err.message}`));
        return;
      }
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/**
 * Git facts about a clone.
 * @param {string} root
 */
export function createGit(root) {
  return {
    /** True if root is a git clone. */
    async available() {
      try { await access(join(root, '.git')); return true; } catch { return false; }
    },
    /** The commit hash of HEAD. */
    async head() {
      const r = await git(root, ['rev-parse', 'HEAD']);
      if (r.code !== 0) throw new Error(`git rev-parse: ${r.stderr.trim()}`);
      return r.stdout.trim();
    },
    /** True if tracked files have no uncommitted changes (untracked files do not count). */
    async clean() {
      const r = await git(root, ['status', '--porcelain', '--untracked-files=no']);
      if (r.code !== 0) throw new Error(`git status: ${r.stderr.trim()}`);
      return r.stdout.trim() === '';
    },
    /**
     * Is `older` an ancestor of `newer` (or the same commit)?
     * @returns {Promise<boolean|null>} null when git does not know `older` (e.g. made on another device)
     */
    async isAncestor(older, newer) {
      if (!/^[0-9a-f]{40}$/.test(older) || !/^[0-9a-f]{40}$/.test(newer)) return null;
      const r = await git(root, ['merge-base', '--is-ancestor', older, newer]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      return null;
    },
    /**
     * Git's blob hash (sha1 of "blob <size>\\0" + content) of every file under dirs in a commit.
     * @returns {Promise<Map<string, string>|null>} null if the commit is unknown here
     */
    async treeBlobs(commit, dirs) {
      if (!/^[0-9a-f]{40}$/.test(commit)) return null;
      const r = await git(root, ['ls-tree', '-r', '-z', commit, '--', ...dirs]);
      if (r.code !== 0) return null;
      const out = new Map();
      for (const rec of r.stdout.split('\0').filter(Boolean)) {
        const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(rec);
        if (m) out.set(m[2], m[1]);
      }
      return out;
    },
    /** git pull --ff-only (setting autoPull). Returns a short result text, never throws. */
    async pullFastForward() {
      try {
        const r = await git(root, ['pull', '--ff-only', '--quiet']);
        return r.code === 0 ? 'ok' : `failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`;
      } catch (e) {
        return `failed: ${e.message}`;
      }
    },
    /**
     * Tracked files under the given folders.
     * @param {string[]} dirs
     * @returns {Promise<string[]>} relative paths with "/"
     */
    async trackedFiles(dirs) {
      const r = await git(root, ['ls-files', '-z', '--', ...dirs]);
      if (r.code !== 0) throw new Error(`git ls-files: ${r.stderr.trim()}`);
      return r.stdout.split('\0').filter(Boolean);
    },
  };
}
