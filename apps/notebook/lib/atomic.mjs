// Atomic file writes: temp file "<name>.part" in the same folder, fsync, rename, fsync the folder.
// A reader (or the hub sync) sees the old file or the new one, never half of it. The hub sync skips *.part.

import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write data to file atomically.
 * @param {string} file
 * @param {string|Buffer} data
 */
export async function atomicWrite(file, data) {
  const part = `${file}.part`;
  const fh = await open(part, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(part).catch(() => {}); // the write already failed; a leftover .part is skipped by sync anyway
    throw e;
  }
  await fh.close();
  await rename(part, file);
  await syncDir(dirname(file));
}

/** fsync a folder so the rename itself is on disk. Some file systems refuse: that is fine. */
export async function syncDir(dir) {
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
