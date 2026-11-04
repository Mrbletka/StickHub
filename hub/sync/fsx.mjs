// File operations for sync. Every write is atomic: name.part, fsync, rename. Copies are verified by hash.
// All writes pass through `guard(path)` so tests can simulate the stick being pulled at any step.

import { open, readFile, rename, mkdir, unlink, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const CHUNK = 1 << 20;

/** Error thrown when a run is cancelled. */
export class CancelledError extends Error {
  constructor() { super('Cancelled'); this.code = 'CANCELLED'; }
}

const check = (signal) => { if (signal?.aborted) throw new CancelledError(); };

/**
 * @param {{guard?: (op: string, path: string) => void}} [opts]
 *   guard: called before every write-type step; throw from it to simulate an unplugged stick
 */
export function createFsx(opts = {}) {
  const guard = opts.guard || (() => {});
  const madeDirs = new Set();

  /** mkdir -p, remembered: on the stick every directory operation costs ~50 ms. */
  async function mkdirp(dir) {
    if (madeDirs.has(dir)) return;
    guard('mkdir', dir);
    await mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  }

  /** sha256 and size of a file, read in chunks. */
  async function hashFile(path, signal) {
    const h = createHash('sha256');
    const fh = await open(path, 'r');
    let size = 0;
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        check(signal);
        const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
        if (!bytesRead) break;
        h.update(buf.subarray(0, bytesRead));
        size += bytesRead;
      }
    } finally {
      await fh.close();
    }
    return { hash: h.digest('hex'), size };
  }

  /** Remove a leftover .part file; missing is fine. */
  async function removePart(path) {
    try { guard('unlink', path); await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  /**
   * Copy src to dst atomically and verify it.
   * @param {string} src
   * @param {string} dst
   * @param {{expectHash?: string, maxBytes?: number, signal?: AbortSignal, onBytes?: (n: number) => void}} [o]
   *   expectHash: the hash the plan saw; if the source changed since, the copy is refused (it syncs next time)
   * @returns {Promise<{hash: string, size: number}>}
   */
  async function copySafe(src, dst, o = {}) {
    await mkdirp(dirname(dst));
    const part = `${dst}.part`;
    const h = createHash('sha256');
    let size = 0;
    const input = await open(src, 'r');
    try {
      guard('open', part);
      const out = await open(part, 'w');
      try {
        const buf = Buffer.allocUnsafe(CHUNK);
        for (;;) {
          check(o.signal);
          const { bytesRead } = await input.read(buf, 0, CHUNK, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (o.maxBytes && size > o.maxBytes) throw new Error(`file is larger than ${o.maxBytes} bytes`);
          h.update(buf.subarray(0, bytesRead));
          guard('write', part);
          await out.write(buf, 0, bytesRead);
          o.onBytes?.(bytesRead);
        }
        guard('fsync', part);
        await out.sync();
      } finally {
        await out.close();
      }
    } catch (e) {
      await removePart(part).catch(() => {}); // best effort: the next run removes leftovers anyway
      throw e;
    } finally {
      await input.close();
    }
    const hash = h.digest('hex');
    if (o.expectHash && hash !== o.expectHash) {
      await removePart(part);
      throw Object.assign(new Error('the file changed while it was copied'), { code: 'CHANGED' });
    }
    // Read back what landed on the target before it replaces anything.
    const back = await hashFile(part, o.signal);
    if (back.hash !== hash || back.size !== size) {
      await removePart(part);
      throw Object.assign(new Error('the copy does not match the original (bad write?)'), { code: 'VERIFY' });
    }
    guard('rename', dst);
    await rename(part, dst);
    return { hash, size };
  }

  /** Write JSON atomically (part, fsync, rename). */
  async function writeJsonSafe(path, data) {
    await mkdirp(dirname(path));
    const part = `${path}.part`;
    guard('open', part);
    const fh = await open(part, 'w');
    try {
      guard('write', part);
      await fh.writeFile(JSON.stringify(data, null, 1));
      guard('fsync', part);
      await fh.sync();
    } finally {
      await fh.close();
    }
    guard('rename', path);
    await rename(part, path);
  }

  /**
   * Read a JSON file with a size limit. Missing file = null. Untrusted content: callers validate the shape.
   * @param {string} path
   * @param {number} maxBytes
   */
  async function readJson(path, maxBytes) {
    let st;
    try { st = await stat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) throw new Error(`${path} is not a file`);
    if (st.size > maxBytes) throw new Error(`${path} is too big (${st.size} bytes, max ${maxBytes})`);
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${path} is not valid JSON`);
      throw e;
    }
  }

  /**
   * Move a file into the trash folder (never delete). Keeps both if the trash already has that name.
   * @returns {Promise<string>} where it went
   */
  async function moveToTrash(file, trashDir, rel) {
    let target = join(trashDir, rel);
    for (let i = 1; await exists(target); i++) target = join(trashDir, `${rel}.${i}`);
    await mkdirp(dirname(target));
    guard('rename', target);
    await rename(file, target);
    return target;
  }

  /** Rename (same volume). */
  async function move(from, to) {
    await mkdirp(dirname(to));
    guard('rename', to);
    await rename(from, to);
  }

  /** Delete a file we created ourselves (journal, lock). Missing is fine. */
  async function removeOwn(path) {
    guard('unlink', path);
    await rm(path, { force: true });
  }

  return { mkdirp, hashFile, copySafe, writeJsonSafe, readJson, moveToTrash, move, removePart, removeOwn, guard };
}

/** True if path exists. */
export async function exists(path) {
  try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** Errors that mean "the stick is gone" (pulled, unmounted). */
export function isGoneError(e) {
  return ['ENOENT', 'EIO', 'ENODEV', 'ENXIO', 'ESTALE', 'ENOTCONN', 'EROFS'].includes(e?.code);
}
