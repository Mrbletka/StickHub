// Phone adapter: finds removable volumes. On Android they appear in /proc/self/mountinfo as /storage/<uuid>
// about 1 s after plug-in, with no termux-setup-storage needed (measured, docs/PROBES.md).
// STICKHUB_MOUNTS (folders separated by ":") adds folders that act as sticks: for PCs and for testing.

import { readFile, stat } from 'node:fs/promises';

/**
 * Parse /proc/self/mountinfo text into mount points (space etc. are octal-escaped there).
 * @param {string} text
 * @returns {{mountPoint: string, fsType: string}[]}
 */
export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const mountPoint = (left.split(' ')[4] || '').replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    out.push({ mountPoint, fsType: right.split(' ')[0] || '' });
  }
  return out;
}

/** Removable volumes in mountinfo text: /storage/<id>, not the internal "emulated" or "self". */
export function volumesFromMountinfo(text) {
  const seen = new Set();
  return parseMountinfo(text)
    .filter((m) => /^\/storage\/[^/]+$/.test(m.mountPoint) && !/^\/storage\/(emulated|self)$/.test(m.mountPoint))
    .filter((m) => !seen.has(m.mountPoint) && seen.add(m.mountPoint));
}

/**
 * The volumes that may hold a stick right now. Cheap (one small file read): safe to call every 2 s.
 * @param {{env?: object, mountinfo?: string}} [opts]  mountinfo: file to read (tests pass their own)
 * @returns {Promise<{volumes: {mountPoint: string, fsType: string}[], error: string|null}>}
 */
export async function listVolumes(opts = {}) {
  const env = opts.env || process.env;
  const volumes = [];
  let error = null;
  try {
    volumes.push(...volumesFromMountinfo(await readFile(opts.mountinfo || '/proc/self/mountinfo', 'utf8')));
  } catch (e) {
    // Not Linux, or no /proc: only the extra folders count.
    if (e.code !== 'ENOENT') error = `mountinfo: ${e.code || e.message}`;
  }
  for (const dir of (env.STICKHUB_MOUNTS || '').split(':').filter(Boolean)) {
    try {
      if ((await stat(dir)).isDirectory()) volumes.push({ mountPoint: dir, fsType: 'folder' });
    } catch (e) {
      if (e.code !== 'ENOENT') error = `${dir}: ${e.code}`;
    }
  }
  return { volumes, error };
}
