// Leftover app processes after a hard kill of the hub (Termux killed, phone reboot of the session, kill -9).
// The hub saves each app's PID with its exact command line in ~/.stickhub/apps-running.json.
// On the next start it stops a saved PID ONLY if /proc/<pid>/cmdline still matches that command line:
// a PID alone may by now belong to another program.

import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The command line of a process, or null if it does not exist (or cannot be read).
 * @param {number} pid
 * @returns {Promise<string[]|null>}
 */
export async function readCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return null; // zombie or kernel thread
    return raw.split('\0').slice(0, raw.endsWith('\0') ? -1 : undefined);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH' || e.code === 'EACCES') return null;
    throw e;
  }
}

/** True if two command lines are exactly the same. */
export function sameArgv(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Saves and loads the running app processes. Writes are atomic; errors are logged, never thrown. */
export class PidFile {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this.writing = Promise.resolve();
  }

  /** Remember a started app process. */
  add(id, pid, argv) {
    this.records.set(id, { pid, argv, started: new Date().toISOString() });
    return this.#save();
  }

  /** Forget an app process (it stopped). */
  remove(id) {
    if (!this.records.delete(id)) return Promise.resolve();
    return this.#save();
  }

  #save() {
    // One write at a time, always the latest state.
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      } catch (e) {
        console.error(`saving ${this.file}: ${e.message}`);
      }
    });
    return this.writing;
  }
}

/**
 * Stop app processes left over from an earlier hub that did not shut down cleanly.
 * @param {string} file  the saved PID file
 * @param {{graceMs?: number}} [o]
 * @returns {Promise<string[]>} one line per saved process: what happened
 */
export async function cleanupLeftovers(file, o = {}) {
  let saved;
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error(`${file} is unreadable (${e.message}); nothing stopped`);
    await rm(file, { force: true });
    return [];
  }
  const report = [];
  for (const [id, rec] of Object.entries(saved || {})) {
    const pid = Number(rec?.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !Array.isArray(rec.argv)) {
      report.push(`${id}: bad record, ignored`);
      continue;
    }
    const argv = await readCmdline(pid);
    if (!argv) { report.push(`${id}: pid ${pid} already gone`); continue; }
    if (!sameArgv(argv, rec.argv)) { report.push(`${id}: pid ${pid} is now another program, not touched`); continue; }
    report.push(`${id}: pid ${pid} ${await stopProcess(pid, rec.argv, o.graceMs ?? 3000)}`);
  }
  await rm(file, { force: true });
  return report;
}

// SIGTERM, wait, then SIGKILL; each signal only after checking the command line again.
async function stopProcess(pid, argv, graceMs) {
  const stillOurs = async () => sameArgv(await readCmdline(pid), argv);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return e.code === 'ESRCH' ? 'was gone' : `could not stop (${e.code})`;
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    if (!(await stillOurs())) return 'stopped';
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await stillOurs())) return 'stopped';
  try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return `could not kill (${e.code})`; }
  return 'killed (did not stop in time)';
}
