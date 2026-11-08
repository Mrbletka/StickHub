// Stick service inside the hub: watches for the stick (reads /proc/self/mountinfo every 2 s, ~0.7 ms each),
// syncs on plug-in and after an app stops, and offers "Sync now" / "Cancel". Emits "change" with status().

import { EventEmitter } from 'node:events';
import { sep } from 'node:path';
import { listVolumes as realListVolumes } from '../platform/termux.mjs';
import { createGit } from '../platform/git.mjs';
import { createFsx } from './fsx.mjs';
import { findStick } from '../stick.mjs';
import { SyncRun } from './runner.mjs';
import { deviceId } from '../config.mjs';

const PROGRESS_EVERY_MS = 300;
const AFTER_STOP_DELAY_MS = 1500;

export class StickService extends EventEmitter {
  /**
   * @param {{root: string, procman: import('../procman.mjs').ProcessManager, listVolumes?: Function, git?: object,
   *   device?: string, pollMs?: number, autoSync?: boolean, dataSync?: boolean, dataSyncOff?: 'vault'|'data-on-stick'}} o
   *   pollMs 0 = no polling (tests call poll()); dataSync false: only code is copied, dataSyncOff says why
   */
  constructor(o) {
    super();
    // ?? and not a spread: an option passed as undefined must not wipe out the default.
    this.o = { ...o, pollMs: o.pollMs ?? 2000, autoSync: o.autoSync ?? true, listVolumes: o.listVolumes || realListVolumes };
    this.git = o.git || createGit(o.root);
    this.stick = { state: 'none' };
    this.key = 'none';
    this.run = null;
    this.again = null;
    this.last = null;
    this.code = null;
    this.pending = [];
    this.conflicts = [];
    this.progress = null;
    this.error = null;
    this.timer = null;
    this.polling = false;
    this.lastEmit = 0;
    this.prevStatus = new Map();
    this.onAppChange = (view) => this.#appChanged(view);
    o.procman.on('change', this.onAppChange);
  }

  /** Start watching. */
  async start() {
    await this.poll();
    if (this.o.pollMs > 0) this.timer = setInterval(() => this.poll(), this.o.pollMs);
  }

  /** Stop watching and cancel a running sync (waits for it to stop cleanly). */
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.o.procman.off('change', this.onAppChange);
    clearTimeout(this.afterStop);
    this.again = null;
    if (this.run) { this.run.cancel(); await this.runDone; }
  }

  /** Public status for the UI and API. */
  status() {
    const s = this.stick;
    return {
      state: s.state === 'ok' ? 'connected' : s.state,
      name: s.info?.name || null, id: s.info?.id || null, mount: s.mount || null,
      commit: s.info?.commit || null, codeState: s.info?.codeState || null,
      error: this.error || s.error || null,
      code: this.code, last: this.last, pending: this.pending, conflicts: this.conflicts,
      sync: this.run ? { running: true, ...this.progress } : { running: false },
      portable: this.#portable(),
      // vault: the app data is in the vault, so the plain data sync (planData) never touches data/ (vault sync: job 5)
      dataSync: this.o.dataSync === false ? { on: false, why: this.o.dataSyncOff || 'off' } : { on: true },
    };
  }

  /** Check for the stick once. Safe to call often; overlapping calls are skipped. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const { volumes, error } = await this.o.listVolumes();
      const s = await findStick(volumes, createFsx());
      const key = s.state === 'ok' ? `ok:${s.info.id}:${s.mount}` : `${s.state}:${s.mount || ''}`;
      this.error = error;
      if (key !== this.key) {
        const wasOk = this.key.startsWith('ok:');
        this.key = key;
        this.stick = s;
        if (!wasOk || s.state !== 'ok') { this.code = null; this.pending = []; this.conflicts = []; this.last = null; }
        if (s.state !== 'ok' && this.run) this.run.cancel(); // pulled out: the run stops; the journal resumes it later
        this.#emit(true);
        if (s.state === 'ok' && this.o.autoSync) this.syncNow('all');
      }
    } catch (e) {
      this.error = `stick check failed: ${e.message}`;
      this.#emit(true);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Start a sync in the background. If one is running, another runs right after it.
   * @param {'all'|'data'|'code'} what
   * @returns {boolean} true if a sync was started or queued
   */
  syncNow(what = 'all') {
    if (this.stick.state !== 'ok' || this.#portable()) return false;
    // Data on the stick: the stick is the live storage, so only the code backup is copied.
    if (this.o.dataSync === false) { if (what === 'data') return false; what = 'code'; }
    if (this.run) { this.again = this.again === 'all' || what === 'all' ? 'all' : what; return true; }
    this.runDone = this.#runOnce(what);
    return true;
  }

  /** Cancel the running sync (it stops after the current chunk, safe to resume). */
  cancel() {
    this.again = null;
    if (this.run) this.run.cancel();
  }

  async #runOnce(what) {
    const s = this.stick;
    const procman = this.o.procman;
    try {
      this.device ??= this.o.device || await deviceId();
      this.run = new SyncRun({
        root: this.o.root, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git: this.git, device: this.device,
        running: () => procman.syncBlockers(),
        what: { data: what !== 'code', code: what !== 'data' },
      });
      this.progress = { ...this.run.progress, what };
      this.run.on('progress', (p) => { this.progress = { ...p, what }; this.#emit(false); });
      this.run.on('warn', (w) => console.warn(`sync: ${w}`));
      this.#emit(true);
      const r = await this.run.run();
      if (r.code) this.code = r.code;
      this.pending = r.pending;
      this.conflicts = r.conflicts;
      this.last = { at: new Date().toISOString(), what, result: r.result, resumed: r.resumed, copied: r.copied, trashed: r.trashed,
        newConflicts: r.newConflicts, skipped: r.skipped.length, errors: r.errors };
      if (r.result === 'failed') console.error(`sync failed: ${r.errors.join('; ')}`);
      // Re-read stick.json: the code commit may have changed.
      const fresh = await findStick([{ mountPoint: s.mount }], createFsx());
      if (fresh.state === 'ok' && this.stick === s) this.stick = fresh;
    } catch (e) {
      this.last = { at: new Date().toISOString(), what, result: 'failed', errors: [e.message] };
      console.error(`sync: ${e.stack || e.message}`);
    } finally {
      this.run = null;
      this.progress = null;
      this.#emit(true);
    }
    const next = this.again;
    this.again = null;
    if (next && this.stick.state === 'ok') this.syncNow(next);
  }

  // An app stopped: its data may have changed, so sync data shortly after (several stops = one sync).
  #appChanged(view) {
    if (this.o.dataSync === false) return;
    const prev = this.prevStatus.get(view.id);
    this.prevStatus.set(view.id, view.status);
    const stopped = (prev === 'running' || prev === 'stopping') && (view.status === 'stopped' || view.status === 'error');
    if (!stopped || this.stick.state !== 'ok' || !this.o.autoSync) return;
    clearTimeout(this.afterStop);
    this.afterStop = setTimeout(() => this.syncNow('data'), AFTER_STOP_DELAY_MS);
  }

  // Running straight from the stick (portable mode): phone and stick are the same files, nothing to sync.
  #portable() {
    return !!(this.stick.mount && (this.o.root === this.stick.mount || this.o.root.startsWith(this.stick.mount + sep)));
  }

  #emit(force) {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_EVERY_MS) return;
    this.lastEmit = now;
    this.emit('change', this.status());
  }
}
