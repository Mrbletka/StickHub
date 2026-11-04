// One sync run between the phone (root) and the stick (hubDir).
// Order: lock -> journal -> remove leftover .part files -> code -> data -> journal removed -> unlock.
// Safe to stop at any point: every file write is atomic and the next run re-checks everything by hash.
// If the journal is still there at the start, the last run was interrupted and this one finishes the work.

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { scanTree } from './scan.mjs';
import { planData, planCode, codeDecision, listConflicts, appOf } from './plan.mjs';
import { relOk, trashDay, LIMITS } from './safe-path.mjs';
import { CancelledError, exists, isGoneError } from './fsx.mjs';
import { acquireLock, updateStickInfo } from '../stick.mjs';

const MAX_STATE = 8 << 20;
const MAX_INDEX = 4 << 20;
const CODE_DIRS = ['hub', 'apps'];
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} RunOptions
 * @property {string} root     phone copy (git clone): data/ and sync-state.json live here
 * @property {string} hubDir   HUB/ on the stick
 * @property {{id: string, commit: string|null, codeState: string}} stick  validated stick.json
 * @property {ReturnType<import('./fsx.mjs').createFsx>} fsx
 * @property {ReturnType<import('../platform/git.mjs').createGit>} git
 * @property {string} device
 * @property {() => Set<string>} [running]  ids of running apps (checked again before each file)
 * @property {{data?: boolean, code?: boolean}} [what]
 * @property {() => Date} [now]
 */

export class SyncRun extends EventEmitter {
  /** @param {RunOptions} o */
  constructor(o) {
    super();
    this.o = { ...o, running: o.running || (() => new Set()), what: o.what || { data: true, code: true }, now: o.now || (() => new Date()) };
    this.ac = new AbortController();
    this.progress = { phase: 'scan', done: 0, total: 0, bytes: 0, totalBytes: 0, current: '' };
  }

  /** Ask the run to stop after the current chunk. It leaves everything resumable. */
  cancel() { this.ac.abort(); }

  get signal() { return this.ac.signal; }

  /** Look at both sides and decide what to do. Reads only. */
  async plan() {
    const { root, hubDir, fsx, git, stick, what } = this.o;
    const signal = this.signal;
    const plan = { parts: [], data: null, code: null, base: new Map(), phoneData: null };
    if (what.data) {
      const stickScan = await scanTree(join(hubDir, 'data'), { fsx, maxFileSize: LIMITS.dataFile, signal });
      const phoneScan = await scanTree(join(root, 'data'), { fsx, maxFileSize: LIMITS.dataFile, signal });
      plan.parts.push(...stickScan.parts.map((r) => join(hubDir, 'data', r)));
      plan.base = await this.#readBase();
      plan.phoneData = phoneScan.files;
      plan.data = planData({ phone: phoneScan.files, stick: stickScan.files, base: plan.base, running: this.o.running(), now: this.o.now() });
      plan.data.skipped.push(...stickScan.skipped.map((s) => ({ ...s, rel: `stick: ${s.rel}` })), ...phoneScan.skipped.map((s) => ({ ...s, rel: `phone: ${s.rel}` })));
    }
    if (what.code) {
      const hasGit = await git.available();
      const d = { hasGit, stick };
      if (hasGit) {
        d.head = await git.head();
        d.clean = await git.clean();
        if (stick.commit && stick.commit !== d.head) d.relation = await git.isAncestor(stick.commit, d.head);
      }
      const decision = codeDecision(d);
      plan.code = { decision, head: d.head, ops: [], phone: null };
      if (decision.copy) {
        const phone = new Map();
        for (const rel of await git.trackedFiles(CODE_DIRS)) {
          if (!relOk(rel)) throw new Error(`Tracked file with a name the stick cannot store: ${rel}`);
          phone.set(rel, await fsx.hashFile(join(root, rel), signal));
        }
        const present = new Map();
        for (const dir of CODE_DIRS) {
          const s = await scanTree(join(hubDir, dir), { fsx, hash: false, maxFileSize: LIMITS.codeFile, signal });
          for (const [rel, f] of s.files) present.set(`${dir}/${rel}`, f);
          plan.parts.push(...s.parts.map((r) => join(hubDir, dir, r)));
        }
        plan.code.phone = phone;
        plan.code.ops = planCode(phone, await this.#readIndex(), present);
      }
    }
    return plan;
  }

  /**
   * Plan and (unless dry) do the sync.
   * @param {{dry?: boolean}} [opt]
   * @returns {Promise<object>} summary: result is ok | cancelled | interrupted | locked | failed
   */
  async run(opt = {}) {
    const { hubDir, fsx, device } = this.o;
    const sum = { result: 'ok', resumed: false, code: null, copied: 0, trashed: 0, conflicts: [], newConflicts: [], pending: [], skipped: [], errors: [] };
    let lock = null;
    let timer = null;
    let state = null;
    try {
      this.#phase('scan');
      const plan = await this.plan();
      sum.code = plan.code?.decision || null;
      sum.pending = plan.data?.pending || [];
      sum.skipped = plan.data?.skipped || [];
      sum.newConflicts = plan.data?.conflicts || [];
      const dataOps = plan.data?.ops || [];
      const codeOps = plan.code?.ops || [];
      if (opt.dry) return { ...sum, dry: true, plan: { data: dataOps, code: codeOps, agreed: plan.data?.agreed.size || 0 } };

      lock = await acquireLock(hubDir, device, fsx, this.o.now);
      // Keep the lock fresh on long runs so other devices do not take it over as stale.
      timer = setInterval(() => lock.refresh().catch((e) => this.emit('warn', `lock refresh: ${e.message}`)), 60_000);
      const journal = join(hubDir, '.journal.json');
      sum.resumed = await exists(journal);
      await fsx.writeJsonSafe(journal, { started: this.o.now().toISOString(), device, data: dataOps.length, code: codeOps.length });
      for (const part of plan.parts) await fsx.removePart(part);

      const all = [...codeOps, ...dataOps];
      this.progress.total = all.length;
      this.progress.totalBytes = all.reduce((n, op) => n + (op.op === 'put' ? op.size : 0), 0);

      if (plan.code?.decision.copy) await this.#runCode(plan.code, sum);
      if (plan.data) {
        state = { base: plan.base };
        for (const [rel, h] of plan.data.agreed) { if (h) state.base.set(rel, h); else state.base.delete(rel); }
        await this.#runData(dataOps, state.base, sum);
      }
      this.#phase('finish');
      await fsx.removeOwn(journal);
    } catch (e) {
      if (e instanceof CancelledError) sum.result = 'cancelled';
      else if (e.code === 'LOCKED') sum.result = 'locked';
      else if (isGoneError(e) && !(await this.#stickThere())) sum.result = 'interrupted';
      else sum.result = 'failed';
      if (sum.result !== 'cancelled') sum.errors.push(e.message);
    } finally {
      clearInterval(timer);
      if (state) await this.#writeBase(state.base).catch((e) => sum.errors.push(`saving sync-state.json: ${e.message}`));
      if (lock && sum.result !== 'interrupted') await lock.release().catch((e) => sum.errors.push(`unlock: ${e.message}`));
      this.#phase('done');
    }
    if (state || this.o.what.data) sum.conflicts = listConflicts(await this.#phoneDataNames().catch(() => new Map()));
    return sum;
  }

  async #runCode(code, sum) {
    const { root, hubDir, fsx } = this.o;
    this.#phase('code');
    await updateStickInfo(hubDir, { commit: code.head, codeState: 'partial' }, fsx);
    const trash = join(hubDir, '.trash', trashDay(this.o.now()), 'code');
    for (const op of code.ops) {
      this.#step(op.rel);
      if (op.op === 'put') {
        try {
          await fsx.copySafe(join(root, op.rel), join(hubDir, op.rel), this.#copyOpts(op, LIMITS.codeFile));
        } catch (e) {
          if (e.code === 'CHANGED') throw new Error(`Code changed during the copy (${op.rel}). Sync again.`);
          throw e;
        }
        sum.copied++;
      } else if (op.op === 'trash') {
        const file = join(hubDir, op.rel);
        if (await exists(file)) { await fsx.moveToTrash(file, trash, op.rel); sum.trashed++; }
      }
      this.#stepDone(op);
    }
    const files = Object.fromEntries([...code.phone].map(([rel, f]) => [rel, { size: f.size, hash: f.hash }]));
    await fsx.writeJsonSafe(join(hubDir, '.index.json'), { format: 1, commit: code.head, files });
    await updateStickInfo(hubDir, { commit: code.head, codeState: 'complete' }, fsx);
  }

  async #runData(ops, base, sum) {
    const { root, hubDir, fsx } = this.o;
    this.#phase('data');
    const day = trashDay(this.o.now());
    const dirs = { phone: join(root, 'data'), stick: join(hubDir, 'data') };
    const trash = { phone: join(root, '.trash', day, 'data'), stick: join(hubDir, '.trash', day, 'data') };
    const pending = new Set(sum.pending);
    for (const op of ops) {
      const app = appOf(op.rel);
      this.#step(op.rel);
      // An app may have started since the plan: never write into the data of a running app.
      if (this.o.running().has(app)) { pending.add(app); this.#stepDone(op); continue; }
      try {
        if (op.op === 'put') {
          const to = op.from === 'phone' ? 'stick' : 'phone';
          await fsx.copySafe(join(dirs[op.from], op.rel), join(dirs[to], op.to || op.rel), this.#copyOpts(op, LIMITS.dataFile));
          base.set(op.to || op.rel, op.hash);
          sum.copied++;
        } else if (await this.#stillSame(join(dirs[op.side], op.rel), op.hash)) {
          if (op.op === 'trash') {
            await fsx.moveToTrash(join(dirs[op.side], op.rel), trash[op.side], op.rel);
            base.delete(op.rel);
            sum.trashed++;
          } else if (op.op === 'rename') {
            await fsx.move(join(dirs.stick, op.rel), join(dirs.stick, op.to));
          }
        }
      } catch (e) {
        // A file that changed or vanished since the plan is left for the next sync; a vanished stick stops the run.
        if (e.code === 'CHANGED' || (e.code === 'ENOENT' && await this.#stickThere())) {
          sum.skipped.push({ rel: op.rel, why: 'changed during sync; next sync takes it' });
        } else throw e;
      }
      await this.#writeBase(base); // phone write, cheap: progress survives an unplug
      this.#stepDone(op);
    }
    sum.pending = [...pending].sort();
  }

  /** False when the stick's HUB folder can no longer be read (pulled out). */
  async #stickThere() {
    try { return await exists(this.o.hubDir); } catch { return false; }
  }

  async #stillSame(file, hash) {
    if (!(await exists(file))) return false;
    return (await this.o.fsx.hashFile(file, this.signal)).hash === hash;
  }

  #copyOpts(op, maxBytes) {
    return { expectHash: op.hash, maxBytes, signal: this.signal, onBytes: (n) => { this.progress.bytes += n; this.emit('progress', this.progress); } };
  }

  #phase(phase) { this.progress.phase = phase; this.emit('progress', this.progress); }
  #step(rel) { this.progress.current = rel; this.emit('progress', this.progress); }
  #stepDone() { this.progress.done++; this.emit('progress', this.progress); }

  async #phoneDataNames() {
    return (await scanTree(join(this.o.root, 'data'), { fsx: this.o.fsx, hash: false })).files;
  }

  // sync-state.json: { format: 1, sticks: { <stick id>: { data: { <rel>: <sha256> }, lastSync } } }
  async #readBase() {
    const j = await this.o.fsx.readJson(join(this.o.root, 'sync-state.json'), MAX_STATE);
    const data = j?.sticks?.[this.o.stick.id]?.data || {};
    const base = new Map();
    for (const [rel, h] of Object.entries(data)) if (relOk(rel) && HEX64.test(h)) base.set(rel, h);
    return base;
  }

  async #writeBase(base) {
    const file = join(this.o.root, 'sync-state.json');
    const j = (await this.o.fsx.readJson(file, MAX_STATE).catch((e) => { this.emit('warn', `sync-state.json unreadable, starting fresh: ${e.message}`); return null; })) || {};
    const sticks = j.sticks && typeof j.sticks === 'object' ? j.sticks : {};
    sticks[this.o.stick.id] = { data: Object.fromEntries(base), lastSync: this.o.now().toISOString() };
    await this.o.fsx.writeJsonSafe(file, { format: 1, sticks });
  }

  // HUB/.index.json is untrusted: keep only well-formed entries for code folders.
  async #readIndex() {
    // A broken index only costs time: every code file is then copied again.
    const j = await this.o.fsx.readJson(join(this.o.hubDir, '.index.json'), MAX_INDEX)
      .catch((e) => { this.emit('warn', `stick index unreadable, copying all code: ${e.message}`); return null; });
    const index = new Map();
    for (const [rel, f] of Object.entries(j?.files || {})) {
      if (relOk(rel) && CODE_DIRS.includes(rel.split('/')[0]) && f && HEX64.test(f.hash) && Number.isInteger(f.size) && f.size >= 0) {
        index.set(rel, { size: f.size, hash: f.hash });
      }
    }
    return index;
  }
}
