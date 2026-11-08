// Per-install settings that live outside the synced tree: ~/.stickhub/ (never on the stick, never in git).

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** The private folder: $STICKHUB_HOME or ~/.stickhub */
export function stickhubHome(env = process.env) {
  return env.STICKHUB_HOME || join(homedir(), '.stickhub');
}

/**
 * This device's random id (used in the stick lock). Created on first use.
 * @param {string} home  private folder
 * @returns {Promise<string>}
 */
export async function deviceId(home = stickhubHome()) {
  const file = join(home, 'device.json');
  try {
    const { id } = JSON.parse(await readFile(file, 'utf8'));
    if (typeof id === 'string' && /^dev-[0-9a-f]{12}$/.test(id)) return id;
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  const id = `dev-${randomBytes(6).toString('hex')}`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify({ id, created: new Date().toISOString() }), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return id;
}

const DEFAULT_SETTINGS = { requireStick: false, autoPull: false, dataOnStick: false, autoLockSeconds: 300 };
/** Number settings: [min, max]. */
const NUMBER_SETTINGS = { autoLockSeconds: [10, 86_400] };

/**
 * Settings from ~/.stickhub/settings.json (all optional):
 *   requireStick: the hub refuses to start without the stick (cartridge feel). Default false.
 *   autoPull: the watcher runs `git pull --ff-only` when the stick is plugged in. Default false.
 *   dataOnStick: app data lives on the stick (HUB/data/<id>), the code runs from the clone. Default false.
 *   autoLockSeconds: the vault locks after this many seconds without a visible hub page (10 to 86400, default 300;
 *   short values are for tests and probes).
 * @param {string} home
 * @returns {Promise<{requireStick: boolean, autoPull: boolean, dataOnStick: boolean, autoLockSeconds: number}>}
 */
export async function loadSettings(home = stickhubHome()) {
  let j;
  try {
    j = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw new Error(`${join(home, 'settings.json')}: ${e.message}`);
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(j || {})) {
    const range = NUMBER_SETTINGS[k];
    if (!(k in DEFAULT_SETTINGS)) console.warn(`settings.json: unknown setting "${k}" ignored`);
    else if (range && !(Number.isInteger(v) && v >= range[0] && v <= range[1])) console.warn(`settings.json: "${k}" must be a whole number from ${range[0]} to ${range[1]}`);
    else if (!range && typeof v !== 'boolean') console.warn(`settings.json: "${k}" must be true or false`);
    else out[k] = v;
  }
  return out;
}
