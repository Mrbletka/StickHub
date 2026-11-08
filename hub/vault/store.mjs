// The vault store: one replica folder opened with the data key (design 6.1, 6.4, 8.2, 8.6). node:crypto only.
// - Open: the newest index that decrypts wins (a torn or damaged newer one is skipped and reported).
// - Writes go through one queue. Writes that arrive together share one commit: new pack(s) under random names
//   (fsync), then a new index (seq + 1) as .part, fsync, rename. A .vx file is never changed in place.
// - A failed write marks the store broken: only a fresh open shows what is on disk.
// - Cleanup (cleanup.mjs: full, or light when something is damaged), compaction (compact.mjs) and maintain() run in
//   the queue in small steps (maintain.mjs), so a save waits for one step at most. At 200 files in _index commits are
//   refused (NEEDS_REPAIR) after one capped cleanup run. No logging; errors never name a vault path.

import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fail, ioError as failedWrite } from './errors.mjs';
import { zero } from './bytes.mjs';
import { subkeys } from './keys.mjs';
import { verifyHeaderMac } from './header.mjs';
import { prepareCommit } from './packs.mjs';
import { compactStore, TRASH_DAYS_MS } from './compact.mjs';
import { Maintenance } from './maintain.mjs';
import { PackReader, readRange, readChunks } from './store-read.mjs';
import { verifyReplica } from './verify.mjs';
import { INDEX_LIMITS } from './indexfile.mjs';
import { scanIndexes, scanProblems, writeIndexPayload, writeHeaderFiles, checkNewerHeader, unlockReplica, createVault, PACK_DIR } from './replica.mjs';
import { runCleanup, noRemovals, CLEANUP_MAX } from './cleanup.mjs';
import { createVfs } from './vfs.mjs';
import { Draft, checkPath } from './store-ops.mjs';
import { WriteQueue } from './queue.mjs';

/** indexFiles: at this many files in _index new commits are refused (NEEDS_REPAIR); open refuses above 256. */
export const STORE_LIMITS = Object.freeze({ packs: INDEX_LIMITS.packs, indexBytes: 16 * 1024 * 1024, fileBytes: INDEX_LIMITS.fileBytes, indexFiles: 200 });

export class Store {
  #dir; #vfs; #dk; #keys; #ctx; #header; #headerText; #headerInfo; #random; #now; #limits;
  #state; #current; #problems = []; #broken = false; #closed = false; #queue; #reads = 0;
  #packs; #opts; #autoEvery = 4; #sinceCleanup = 0; #lastCleanup = null; #indexFiles = 0; #maintained = false; #dirty = false;
  #closing = false; #maint; #cleanupMax = CLEANUP_MAX; #indexCache = new Map();

  /**
   * Create a new, empty vault in dir and open it. dir must not hold a vault yet.
   * @param {string} dir
   * @param {{headerText: string, dk: Buffer, guard?: Function, random?: Function, now?: () => number}} o
   */
  static async create(dir, o) {
    const header = await createVault(dir, o);
    return Store.open(dir, { ...o, header, headerInfo: { used: 'main', problem: null, backupBehind: false } });
  }

  /**
   * Open a replica with a data key and its checked header (see openVaultFolder for the usual way in).
   * @param {string} dir
   * @param {{dk: Buffer, header: object, headerText: string, headerInfo?: object, guard?: Function,
   *   random?: Function, now?: () => number, limits?: object, autoCleanupEvery?: number, cleanupMax?: number}} o
   *   limits: tests only; autoCleanupEvery: automatic maintenance after the first commit and then every this many
   *   commits (default 4, 0 = never); cleanupMax: files one cleanup run may delete (default 10)
   */
  static async open(dir, o) {
    verifyHeaderMac(o.header, o.dk);
    const s = new Store();
    s.#dir = dir;
    s.#vfs = createVfs({ guard: o.guard });
    s.#dk = Buffer.from(o.dk);
    s.#header = o.header;
    s.#headerText = o.headerText;
    s.#headerInfo = { ...(o.headerInfo || { used: 'main', problem: null, backupBehind: false }) };
    s.#random = o.random || randomBytes;
    s.#now = o.now || Date.now;
    s.#limits = { ...STORE_LIMITS, ...o.limits };
    s.#autoEvery = o.autoCleanupEvery ?? 4;
    s.#cleanupMax = o.cleanupMax ?? CLEANUP_MAX;
    s.#opts = { guard: o.guard, random: o.random, now: o.now, limits: o.limits, autoCleanupEvery: o.autoCleanupEvery, cleanupMax: o.cleanupMax };
    s.#keys = subkeys(s.#dk, o.header.vaultId, o.header.epoch);
    s.#ctx = { kFile: s.#keys.file, vaultId: o.header.vaultId, epoch: o.header.epoch };
    s.#packs = new PackReader(dir, s.#vfs, s.#ctx);
    s.#queue = new WriteQueue({ check: () => s.#usable(), runBatch: (batch) => s.#commit(batch) });
    s.#maint = new Maintenance(s.#queue, () => s.#io(), (e) => { s.#lastCleanup = { done: false, error: e.code || 'ERROR' }; });
    try {
      const scan = await scanIndexes(dir, s.#ctx, s.#vfs);
      if (!scan.valid.length) fail(scan.damaged.length ? 'BAD_INDEX' : 'NO_INDEX', 'The vault has no readable index.');
      s.#current = { name: scan.valid[0].name, seq: scan.valid[0].seq };
      s.#state = scan.valid[0].state;
      s.#problems = scanProblems(scan);
      s.#indexFiles = scan.count;
      // leftovers count toward the next cleanup: a folder near the limit gets one soon after the first commit
      s.#sinceCleanup = Math.max(0, scan.valid.length - 2) + scan.parts.length;
      s.#dirty = s.#headerInfo.backupBehind;
      if (s.#headerInfo.problem) s.#problems.push(s.#headerInfo.problem);
    } catch (e) {
      s.#wipe();
      throw e;
    }
    return s;
  }

  /** Counts and problems, for the UI (no names). */
  status() {
    return { seq: this.#state.seq, files: this.#state.files.size, trash: this.#state.trash.length,
      header: this.#headerInfo.used, problems: [...this.#problems], broken: this.#broken, closed: this.#closed,
      lastCleanup: this.#lastCleanup, indexFiles: this.#indexFiles, packs: this.#state.packSizes.size, maintaining: this.#maint.active };
  }

  // ---- reading (the committed state; no queue) ----

  #entry(p) {
    this.#usable();
    const e = this.#state.files.get(checkPath(p));
    if (!e) fail('NOT_FOUND', 'Not found.');
    return e;
  }

  /** @param {string} p */
  stat(p) {
    const e = this.#entry(p);
    return e.kind === 'd' ? { path: p, kind: 'd', mtime: e.mtime } : { path: p, kind: 'f', size: e.size, mtime: e.mtime, id: e.id };
  }

  /**
   * Everything under a folder ('' = the whole vault), sorted by path.
   * @param {string} [prefix]
   */
  tree(prefix = '') {
    this.#usable();
    if (prefix !== '' && this.#entry(prefix).kind !== 'd') fail('NOT_DIR', 'That is not a folder.');
    const out = [];
    for (const p of [...this.#state.files.keys()].sort()) {
      if (prefix === '' || p.startsWith(`${prefix}/`)) out.push(this.stat(p));
    }
    return out;
  }

  /** The vault trash, newest first (no data). */
  listTrash() {
    this.#usable();
    return this.#state.trash.map((t) => ({ tid: t.tid, path: t.path, kind: t.kind, ...(t.kind === 'f' ? { size: t.size } : {}), deletedAt: t.deletedAt }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /**
   * Read a file, or the bytes [start, end) of it. A whole read is checked against its content id; a part read decrypts
   * only the segments it needs and checks the pieces against each pack's table of contents.
   * @param {string} p
   * @param {{start?: number, end?: number}} [range]
   * @returns {Promise<Buffer>}
   */
  async read(p, range = {}) {
    const e = this.#entry(p);
    if (e.kind !== 'f') fail('IS_DIR', 'That is a folder.');
    const start = range.start ?? 0;
    const end = range.end ?? e.size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > e.size) fail('BAD_INPUT', 'Bad range.');
    this.#reads++;
    try {
      return await readRange(this.#packs, e, start, end, this.#keys.contentId);
    } finally {
      this.#reads--;
    }
  }

  /**
   * A whole file in chunks of at most 4 MiB (export, verify): never all of a big file in memory. The content id is
   * checked after the last chunk; if the iteration throws, throw away what it gave.
   * @param {string} p
   * @returns {AsyncGenerator<Buffer>}
   */
  async *readChunks(p) {
    const e = this.#entry(p);
    if (e.kind !== 'f') fail('IS_DIR', 'That is a folder.');
    this.#reads++;
    try {
      for await (const c of readChunks(this.#packs, e, this.#keys.contentId)) yield c.data;
    } finally {
      this.#reads--;
    }
  }

  /** Check the whole replica folder; no writes (verify.mjs). @param {{quick?: boolean}} [o] */
  verify(o = {}) {
    return this.#task(() => verifyReplica({ dir: this.#dir, vfs: this.#vfs, ctx: this.#ctx, dk: this.#dk, kId: this.#keys.contentId, quick: !!o.quick }));
  }

  /**
   * A new store on the same folder with the same data key (no KDF): sees what another process wrote meanwhile, and is
   * the way out after a failed save (this instance stays broken). Only a closed (locked) store refuses.
   */
  reopen() {
    if (this.#closed) fail('CLOSED', 'The vault is locked.');
    const dk = Buffer.from(this.#dk);
    return openVaultFolder(this.#dir, async (h) => { verifyHeaderMac(h, dk); return dk; }, this.#opts);
  }

  // ---- changes (queued; writes of the same moment share one commit) ----

  /**
   * Write a whole file. ifMatch: undefined = no check, null = must not exist yet, string = the current content id.
   * @param {string} p
   * @param {Buffer|string} data
   * @param {{ifMatch?: string|null}} [o]
   * @returns {Promise<{id: string, size: number}>}
   */
  write(p, data, o = {}) {
    checkPath(p);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (!Buffer.isBuffer(buf)) fail('BAD_INPUT', 'Data must be a Buffer or text.');
    if (buf.length > this.#limits.fileBytes) fail('TOO_BIG', 'The file is too big for the vault.');
    this.#usable();
    const id = createHmac('sha256', this.#keys.contentId).update(buf).digest('base64url');
    return this.#op((d, now) => d.write({ path: p, id, size: buf.length, data: buf }, o.ifMatch, now));
  }

  /** Create a folder (and its parents). */
  mkdir(p) { checkPath(p); return this.#op((d, now) => d.mkdir(p, now)); }

  /** Move or rename a file or a folder with everything in it. */
  move(from, to, o = {}) { checkPath(from); checkPath(to); return this.#op((d, now) => d.move(from, to, o.ifMatch, now)); }

  /** Move files or folders to the vault trash. @returns {Promise<{tids: string[]}>} */
  remove(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) fail('BAD_INPUT', 'Give 1 to 1000 paths.');
    paths.forEach(checkPath);
    return this.#op((d, now) => d.remove(paths, now));
  }

  /** Put trash entries back; `to` gives a single entry a new path. */
  restore(tids, o = {}) {
    if (!Array.isArray(tids) || !tids.length || tids.length > 1000 || !tids.every((t) => typeof t === 'string')) fail('BAD_INPUT', 'Give 1 to 1000 trash ids.');
    if (o.to !== undefined) checkPath(o.to);
    return this.#op((d, now) => d.restore(tids, o.to, now));
  }

  /** Remove trash entries for good: all, or the given ids. */
  emptyTrash(tids) {
    if (tids !== undefined && (!Array.isArray(tids) || tids.length > 1000 || !tids.every((t) => typeof t === 'string'))) fail('BAD_INPUT', 'Give up to 1000 trash ids.');
    return this.#op((d) => d.emptyTrash(tids));
  }

  /** Remove trash entries older than 30 days (store clock). */
  purgeTrash() { return this.#op((d, now) => d.purgeTrash(now - TRASH_DAYS_MS)); }

  /**
   * Remove leftovers (cleanup.mjs: full or light) in capped runs, each its own step in the write queue, until nothing
   * is left or a run is blocked or busy. One merged result: counts summed, plus `steps`.
   */
  cleanup() { this.#usable(); return this.#maint.run('cleanup'); }

  /**
   * Move the live pieces of small or mostly dead packs into new ~8 MiB packs: one commit (compact.mjs), reading at most
   * maxPacks packs (12) and maxBytes live bytes (16 MiB). Not while there are problems. Stops between files when the
   * signal is aborted (nothing written then). @param {{maxBytes?: number, maxPacks?: number, signal?: AbortSignal}} [o]
   */
  compact(o = {}) { return this.#task(() => compactStore(this.#inner(o))); }

  /**
   * Purge old trash, compact while worth it, then clean up: in steps (maintain.mjs), each its own item in the write
   * queue, so saves go first. Nothing to do = no I/O. @returns {Promise<{purged, compacted, cleanup, steps}>}
   */
  maintain() { this.#usable(); return this.#maint.run('maintain'); }

  /** After the first commit of a session and then every `autoCleanupEvery` commits: one automatic chain. */
  #maybeMaintain() {
    if (!this.#autoEvery || this.#closing || (this.#maintained && ++this.#sinceCleanup < this.#autoEvery)) return;
    this.#maintained = true;
    this.#sinceCleanup = 0;
    this.#maint.auto(); // one automatic chain at a time; none while maintain() or cleanup() runs
  }

  /** Replace the header (both copies). It must be for this vault and epoch, with a higher hseq and a valid MAC. */
  writeHeader(text) {
    return this.#task(async () => {
      const h = checkNewerHeader(text, this.#header, this.#dk);
      try {
        await writeHeaderFiles(this.#dir, text, this.#vfs);
      } catch (e) {
        this.#broken = true;
        throw failedWrite(e);
      }
      this.#header = h;
      this.#headerText = text;
      this.#headerInfo.backupBehind = false;
      return {};
    });
  }

  /**
   * Wait for the running step and for everything callers queued (saves, explicit tasks); automatic steps that have
   * not started are dropped and maintenance chains stop after their current step. Then forget the keys.
   */
  async close() { await this.flush(); this.#closed = true; this.#wipe(); }

  /** Finish the running step and everything callers queued (automatic steps not started are dropped); keep the keys. */
  async flush() { this.#closing = true; this.#queue.dropBackground(); await this.#queue.idle(); }

  #wipe() {
    zero(this.#dk, this.#keys?.header, this.#keys?.contentId, this.#keys?.file);
    this.#state = { seq: 0, files: new Map(), trash: [], packSizes: new Map() };
    this.#packs?.clear();
  }

  #usable() {
    if (this.#closed) fail('CLOSED', 'The vault is locked.');
    if (this.#broken) fail('STORE_BROKEN', 'A save failed. Open the vault again.');
  }

  #op(fn) { this.#usable(); return this.#queue.op(fn); }
  #task(fn) { this.#usable(); return this.#queue.task(fn); }

  async #commit(batch) {
    try {
      this.#usable();
    } catch (e) {
      for (const it of batch) it.reject(e);
      return;
    }
    const d = new Draft(this.#state);
    const now = this.#now();
    const ok = [];
    for (const it of batch) {
      try { ok.push([it, it.fn(d, now)]); } catch (e) { it.reject(e); }
    }
    if (!ok.length) return;
    try {
      if (d.changed) await this.#commitDraft(d, now);
    } catch (e) {
      for (const [it] of ok) it.reject(e);
      return;
    }
    for (const [it, r] of ok) it.resolve(r);
    if (d.changed) this.#maybeMaintain();
  }

  /** Commit a changed draft: packs (random names, fsync), then the index (.part, fsync, rename). Throws on failure. */
  async #commitDraft(d, now) {
    if (this.#indexFiles >= this.#limits.indexFiles) await this.#cleanupRun(); // one capped run; blocked or busy = no change
    if (this.#indexFiles >= this.#limits.indexFiles) {
      fail('NEEDS_REPAIR', 'The vault cannot save any more: a damaged file stops the cleanup. Run "vault verify", then "vault export" to save your notes.');
    }
    const prep = prepareCommit(this.#state, d, { ctx: this.#ctx, limits: this.#limits, random: this.#random, now });
    let name;
    try {
      for (const p of prep.packs) await this.#vfs.writeNew(join(this.#dir, PACK_DIR, `${p.name}.vx`), p.file);
      if (prep.packs.length) await this.#vfs.syncDir(join(this.#dir, PACK_DIR));
      name = await writeIndexPayload(this.#dir, prep.payload, this.#ctx, this.#vfs, this.#random);
    } catch (e) {
      this.#broken = true;
      throw failedWrite(e);
    }
    this.#current = { name, seq: prep.next.seq };
    this.#indexFiles++;
    this.#state = prep.next;
  }

  /** What compaction and maintenance need from the store (compact.mjs). */
  #inner(o = {}) {
    return { state: this.#state, problems: this.#problems, pr: this.#packs, kId: this.#keys.contentId, ctx: this.#ctx,
      random: this.#random, now: this.#now(), signal: o.signal, maxBytes: o.maxBytes, maxPacks: o.maxPacks, commit: (d, now) => this.#commitDraft(d, now) };
  }

  /** What a maintenance step needs from the store (maintain.mjs). */
  #io() {
    return {
      closing: () => this.#closing, state: () => this.#state, problems: () => this.#problems,
      purgeDue: () => this.#state.trash.some((t) => t.deletedAt < this.#now() - TRASH_DAYS_MS),
      purge: async () => {
        const now = this.#now(), d = new Draft(this.#state), { removed } = d.purgeTrash(now - TRASH_DAYS_MS);
        await this.#commitDraft(d, now);
        return removed;
      },
      compact: () => compactStore(this.#inner()), cleanupRun: () => this.#cleanupRun(),
      needsCleanup: () => this.#indexFiles > 2 || this.#dirty,
    };
  }

  /** One capped cleanup run (cleanup.mjs). */
  async #cleanupRun() {
    if (this.#reads) return { done: false, level: 'none', reasons: ['reads in progress'], removed: noRemovals(), indexFiles: this.#indexFiles, more: false, left: 0 };
    const r = await runCleanup({ dir: this.#dir, vfs: this.#vfs, ctx: this.#ctx, dk: this.#dk, current: this.#current.name, problems: this.#problems, max: this.#cleanupMax, cache: this.#indexCache });
    this.#lastCleanup = { done: r.done, level: r.level, reasons: r.reasons, more: r.more };
    if (r.done && r.level === 'full' && !r.more) this.#dirty = false; // the header backup is the last thing a run does
    this.#indexFiles = r.indexFiles;
    this.#sinceCleanup = 0;
    return r;
  }
}

/**
 * The usual way in: read the header copies, unlock (passphrase or paper code), open the store.
 * @param {string} dir
 * @param {(h: object) => Promise<Buffer>} unlock  e.g. (h) => unlockWithPassphrase(h, pass)
 * @param {{guard?: Function, random?: Function, now?: () => number, limits?: object}} [o]
 * @returns {Promise<Store>}
 */
export async function openVaultFolder(dir, unlock, o = {}) {
  const u = await unlockReplica(dir, unlock, createVfs({ guard: o.guard }));
  try {
    return await Store.open(dir, { ...o, dk: u.dk, header: u.header, headerText: u.text, headerInfo: u.info });
  } finally {
    zero(u.dk);
  }
}
