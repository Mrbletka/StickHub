// Guarded file operations for the vault store. Every write-type step calls guard(op, path) first, so tests can
// simulate the stick being pulled at any step (the same idea as hub/sync/fsx.mjs). Never uses file times.

import { open, rename, unlink, opendir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fail } from './errors.mjs';

/**
 * @param {{guard?: (op: string, path: string) => void}} [opts]  guard: throw from it to simulate an unplugged stick
 */
export function createVfs(opts = {}) {
  const guard = opts.guard || (() => {});

  /** fsync a folder so a create or rename in it is on disk. Some file systems refuse: that is fine. */
  async function syncDir(dir) {
    guard('syncdir', dir);
    let fh;
    try {
      fh = await open(dir, 'r');
      await fh.sync();
    } catch (e) {
      if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(e.code)) throw e;
    } finally {
      await fh?.close();
    }
  }

  async function mkdirp(dir) {
    guard('mkdir', dir);
    await mkdir(dir, { recursive: true });
  }

  /** Create a new file (never overwrites: open with wx), write it, fsync it. */
  async function writeNew(path, data) {
    guard('open', path);
    const fh = await open(path, 'wx');
    try {
      guard('write', path);
      await fh.writeFile(data);
      guard('fsync', path);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Replace path atomically: path.part, write, fsync, rename, fsync the folder. */
  async function writeAtomic(path, data) {
    const part = `${path}.part`;
    guard('open', part);
    const fh = await open(part, 'w');
    try {
      guard('write', part);
      await fh.writeFile(data);
      guard('fsync', part);
      await fh.sync();
    } finally {
      await fh.close();
    }
    guard('rename', path);
    await rename(part, path);
    await syncDir(dirname(path));
  }

  /** Delete a file; missing is fine. */
  async function remove(path) {
    guard('unlink', path);
    try {
      await unlink(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  /**
   * Names in a folder (missing folder = []). More than max entries is refused (a hostile stick could hold millions).
   * @param {string} dir
   * @param {number} max
   */
  async function list(dir, max) {
    let d;
    try {
      d = await opendir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const names = [];
    for await (const ent of d) { // reads entries a few at a time; leaving the loop closes the folder
      names.push(ent.name);
      if (names.length > max) fail('TOO_BIG', 'A vault folder has too many files.');
    }
    return names;
  }

  /**
   * Open a file for reading at offsets.
   * @param {string} path
   * @returns {Promise<{size: number, read: (pos: number, len: number) => Promise<Buffer>, close: () => Promise<void>}>}
   */
  async function openRead(path) {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    return {
      size,
      async read(pos, len) {
        const buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
          if (!bytesRead) fail('BAD_VX', 'A vault file ended early.');
          got += bytesRead;
        }
        return buf;
      },
      close: () => fh.close(),
    };
  }

  /**
   * Read a whole file of at most max bytes; a missing file gives null.
   * @param {string} path
   * @param {number} max
   * @returns {Promise<Buffer|null>}
   */
  async function readLimited(path, max) {
    let f;
    try {
      f = await openRead(path);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      if (f.size > max) fail('TOO_BIG', 'A vault file is bigger than allowed.');
      return await f.read(0, f.size);
    } finally {
      await f.close();
    }
  }

  return { syncDir, mkdirp, writeNew, writeAtomic, remove, list, openRead, readLimited, guard };
}
