// Data on the stick (setting dataOnStick, or `node hub/cli.mjs open --data-on-stick`).
// The hub and its apps run from the clone on the phone; only the app data lives on the stick: HUB_DATA_DIR =
// <stick>/HUB/data/<id>/. Nothing from the stick is ever run or imported. No data sync in this mode (the stick is
// the live storage); the code snapshot is still copied to the stick as a backup.
// - Plug-in: finish an interrupted sync (HUB/.journal.json), report and clean up after a pull (HUB/.running.json,
//   leftover *.part in HUB/data), mark the stick as in use, point the apps' data at it.
// - Stick gone: stop the apps (short grace, all stopped within 2 s), show "Stick removed", keep the hub running.
//   When it comes back, carry on; apps start again only when you tap them.
// - No stick: apps do not start ("Plug in the stick").

import { EventEmitter } from 'node:events';
import { readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findStick, RUNNING_MARK } from './stick.mjs';
import { createFsx, exists } from './sync/fsx.mjs';
import { SyncRun } from './sync/runner.mjs';

const STOP_GRACE_MS = 1200;

/**
 * Did the last use of this stick end with it pulled out? Remove the temp files such a pull can leave.
 * Call it before the data is used again.
 * @param {string} hubDir  <stick>/HUB
 * @returns {Promise<{pulled: object|null, partsRemoved: number}>}
 */
export async function checkAfterPull(hubDir) {
  let pulled = null;
  try {
    pulled = JSON.parse(await readFile(join(hubDir, RUNNING_MARK), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') pulled = { unreadable: e.message };
  }
  let partsRemoved = 0;
  if (pulled) {
    const sweep = async (dir) => {
      for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, ent.name);
        if (ent.isDirectory() && !ent.isSymbolicLink()) await sweep(p);
        else if (ent.isFile() && ent.name.endsWith('.part')) { await rm(p, { force: true }); partsRemoved++; }
      }
    };
    await sweep(join(hubDir, 'data'));
    await rm(join(hubDir, RUNNING_MARK), { force: true });
  }
  return { pulled, partsRemoved };
}

export class LiveData extends EventEmitter {
  /**
   * @param {{procman: import('./procman.mjs').ProcessManager, listVolumes: Function, root: string, git: object,
   *   device: () => Promise<string>, pollMs?: number, onAttach?: () => void, log?: (m: string) => void}} o
   *   pollMs 0 = no timer (tests call poll()); onAttach: e.g. copy the code backup to the stick
   */
  constructor(o) {
    super();
    // ?? and not a spread: an option passed as undefined must not wipe out the default.
    this.o = { ...o, pollMs: o.pollMs ?? 500, log: o.log || ((m) => console.log(m)) };
    this.s = { attached: false, removed: false, mount: null, name: null, lastPull: null, journal: null, stopMs: null, error: null };
    this.hubDir = null;
    this.key = null;
    this.busy = false;
    this.timer = null;
    this.o.procman.setDataDir(null); // no stick yet: no app may start
  }

  /** Public state for the UI. */
  status() { return { on: true, ...this.s }; }

  async start() {
    await this.poll();
    if (this.o.pollMs > 0) this.timer = setInterval(() => this.poll(), this.o.pollMs);
  }

  /** Stop watching; a clean stop removes the "in use" marker. */
  async stop() {
    clearInterval(this.timer);
    if (this.s.attached) await rm(join(this.hubDir, RUNNING_MARK), { force: true }).catch((e) => this.o.log(`marker: ${e.message}`));
  }

  /** Look once (cheap: one mountinfo read; a stat while attached). */
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { volumes } = await this.o.listVolumes();
      const s = await findStick(volumes, createFsx());
      const key = s.state === 'ok' ? `${s.info.id}@${s.mount}` : null;
      if (this.s.attached && (key !== this.key || !(await stat(join(this.hubDir, 'stick.json')).then(() => true, () => false)))) await this.#detach();
      if (key && !this.s.attached) await this.#attach(s, key);
    } catch (e) {
      // A stick pulled out halfway through attaching ends up here; the next poll sorts it out.
      this.s.error = e.message;
      if (this.s.attached) await this.#detach();
      this.emit('change');
    } finally {
      this.busy = false;
    }
  }

  async #attach(s, key) {
    this.s.error = null;
    if (await exists(join(s.hubDir, '.journal.json'))) {
      const run = new SyncRun({ root: this.o.root, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git: this.o.git, device: await this.o.device() });
      const r = await run.run();
      this.s.journal = { at: new Date().toISOString(), result: r.result, copied: r.copied };
      this.o.log(`finished an interrupted sync: ${r.result}`);
    }
    const check = await checkAfterPull(s.hubDir);
    if (check.pulled) {
      this.s.lastPull = { at: new Date().toISOString(), partsRemoved: check.partsRemoved };
      this.o.log(`the stick was pulled out while in use last time; removed ${check.partsRemoved} unfinished temp file(s)`);
    }
    const mark = join(s.hubDir, RUNNING_MARK);
    await writeFile(`${mark}.part`, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    await rename(`${mark}.part`, mark);
    this.hubDir = s.hubDir;
    this.key = key;
    this.o.procman.setDataDir(join(s.hubDir, 'data'));
    Object.assign(this.s, { attached: true, removed: false, mount: s.mount, name: s.info.name });
    this.o.log(`app data on the stick: ${join(s.hubDir, 'data')}`);
    this.emit('change');
    this.o.onAttach?.();
  }

  async #detach() {
    const t0 = Date.now();
    this.o.procman.setDataDir(null);
    Object.assign(this.s, { attached: false, removed: true });
    this.key = null;
    this.emit('change');
    await this.o.procman.stopAll(STOP_GRACE_MS);
    this.s.stopMs = Date.now() - t0;
    this.o.log(`stick removed: apps stopped in ${this.s.stopMs} ms`);
    this.emit('change');
  }
}
