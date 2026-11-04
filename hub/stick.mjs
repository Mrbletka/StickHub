// The stick: finds HUB/stick.json on a mounted volume, validates it (untrusted), creates it (`stick init`),
// and holds the sync lock HUB/.lock.

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ID_RE } from './manifest.mjs';
import { createFsx } from './sync/fsx.mjs';

export const HUB = 'HUB';
const MAX_STICK_JSON = 64 * 1024;
const MAX_LOCK = 4 * 1024;
export const LOCK_STALE_MS = 5 * 60_000;

/**
 * Check a parsed stick.json. Unknown keys are dropped, bad values are errors.
 * @returns {{ok: boolean, info?: {id: string, name: string, created: string, commit: string|null, codeState: string}, error?: string}}
 */
export function validateStickInfo(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: 'stick.json is not a JSON object' };
  if (typeof j.id !== 'string' || !ID_RE.test(j.id)) return { ok: false, error: 'stick.json: bad id' };
  if (typeof j.name !== 'string' || !j.name.trim() || j.name.length > 40) return { ok: false, error: 'stick.json: bad name' };
  if (typeof j.created !== 'string' || j.created.length > 40 || Number.isNaN(Date.parse(j.created))) return { ok: false, error: 'stick.json: bad created date' };
  const commit = j.commit ?? null;
  if (commit !== null && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) return { ok: false, error: 'stick.json: bad commit' };
  const codeState = j.codeState ?? 'none';
  if (!['none', 'partial', 'complete'].includes(codeState)) return { ok: false, error: 'stick.json: bad codeState' };
  return { ok: true, info: { id: j.id, name: j.name.trim(), created: j.created, commit, codeState } };
}

/**
 * Read HUB/stick.json from a volume.
 * @returns {Promise<{state: 'none'|'blank'|'ok'|'bad', hubDir: string, info?: object, error?: string}>}
 *   none = volume gone, blank = no HUB/stick.json, bad = unreadable or invalid
 */
export async function readStick(mountPoint, fsx = createFsx()) {
  const hubDir = join(mountPoint, HUB);
  try {
    const j = await fsx.readJson(join(hubDir, 'stick.json'), MAX_STICK_JSON);
    if (j === null) {
      try { await stat(mountPoint); } catch { return { state: 'none', hubDir }; }
      return { state: 'blank', hubDir };
    }
    const v = validateStickInfo(j);
    return v.ok ? { state: 'ok', hubDir, info: v.info } : { state: 'bad', hubDir, error: v.error };
  } catch (e) {
    return { state: 'bad', hubDir, error: e.code || e.message };
  }
}

/**
 * The first volume with a valid HUB, else the first blank or bad one (so the UI can say why).
 * @param {{mountPoint: string}[]} volumes
 */
export async function findStick(volumes, fsx = createFsx()) {
  let fallback = null;
  for (const v of volumes) {
    const r = await readStick(v.mountPoint, fsx);
    if (r.state === 'ok') return { mount: v.mountPoint, ...r };
    if (r.state !== 'none' && !fallback) fallback = { mount: v.mountPoint, ...r };
  }
  return fallback || { state: 'none' };
}

/**
 * Create HUB/ and HUB/stick.json on a volume. Never touches an existing HUB/ unless force is set;
 * even then it only writes a new stick.json and leaves every other file alone.
 * @param {string} mountPoint
 * @param {{name?: string, force?: boolean, fsx?: object, now?: Date}} [o]
 * @returns {Promise<object>} the new stick info
 */
export async function initStick(mountPoint, o = {}) {
  const fsx = o.fsx || createFsx();
  const st = await stat(mountPoint).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`${mountPoint} is not a folder. Is the stick plugged in?`);
  const hubDir = join(mountPoint, HUB);
  const hubSt = await stat(hubDir).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (hubSt && !hubSt.isDirectory()) throw new Error(`${hubDir} exists and is not a folder. Nothing was changed.`);
  if (hubSt && !o.force) {
    const n = (await readdir(hubDir)).length;
    throw new Error(`${hubDir} already exists (${n} items). Nothing was changed. Use --force to write a new stick.json; other files stay.`);
  }
  const name = (o.name || 'My stick').trim().slice(0, 40) || 'My stick';
  const info = { id: `stick-${randomBytes(4).toString('hex')}`, name, created: (o.now || new Date()).toISOString(), commit: null, codeState: 'none', format: 1 };
  if (!hubSt) await mkdir(hubDir);
  await fsx.writeJsonSafe(join(hubDir, 'stick.json'), info);
  return info;
}

/** Write fields into stick.json (keeps the others). */
export async function updateStickInfo(hubDir, patch, fsx) {
  const cur = validateStickInfo(await fsx.readJson(join(hubDir, 'stick.json'), MAX_STICK_JSON));
  if (!cur.ok) throw new Error(cur.error);
  const next = { ...cur.info, ...patch, format: 1 };
  await fsx.writeJsonSafe(join(hubDir, 'stick.json'), next);
  return next;
}

/** Error when another device holds the lock. */
export class LockedError extends Error {
  constructor(lock) {
    super(`The stick is busy: another device (${lock.device}) is syncing since ${lock.time}. Try again later.`);
    this.code = 'LOCKED';
  }
}

/**
 * Take HUB/.lock. A lock from this device, or one older than LOCK_STALE_MS, is taken over.
 * @returns {Promise<{refresh: () => Promise<void>, release: () => Promise<void>}>}
 */
export async function acquireLock(hubDir, device, fsx, now = () => new Date()) {
  const file = join(hubDir, '.lock');
  const body = () => JSON.stringify({ device, pid: process.pid, time: now().toISOString() });
  try {
    fsx.guard('open', file);
    await writeFile(file, body(), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let cur = null;
    try { cur = await fsx.readJson(file, MAX_LOCK); } catch { cur = null; } // unreadable lock = stale
    const age = cur?.time ? now() - Date.parse(cur.time) : Infinity;
    if (cur && typeof cur.device === 'string' && cur.device !== device && age < LOCK_STALE_MS) throw new LockedError(cur);
    await fsx.writeJsonSafe(file, JSON.parse(body()));
  }
  return {
    refresh: () => fsx.writeJsonSafe(file, JSON.parse(body())),
    async release() {
      const cur = await fsx.readJson(file, MAX_LOCK).catch(() => null);
      if (!cur || cur.device === device) await fsx.removeOwn(file);
    },
  };
}
