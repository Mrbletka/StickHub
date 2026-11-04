// The vault store: one replica folder opened with the data key (design 6.1, 6.4, 8.2, 8.6). node:crypto only.
// - Open: the newest index that decrypts wins (a torn or damaged newer one is skipped and reported).
// - Writes go through one queue. Writes that arrive together share one commit: new pack(s) under random names
//   (fsync), then a new index (seq + 1) as .part, fsync, rename. A .vx file is never changed in place.
// - A failed write marks the store broken: only a fresh open shows what is on disk.
// - Cleanup runs in the queue (cleanup.mjs): full when nothing is damaged, light (index files only) when something is.
//   At 200 files in _index new commits are refused (NEEDS_REPAIR); reads keep working.
// No logging. Errors are VaultErrors whose messages never contain a path or a name from the vault.

import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { VaultError, fail, ioError as failedWrite } from './errors.mjs';
import { zero } from './bytes.mjs';
import { subkeys } from './keys.mjs';
import { parseHeader, verifyHeaderMac } from './header.mjs';
import { buildPacks } from './packs.mjs';
import { PackReader, readRange } from './store-read.mjs';
import { encodeIndex, decodeIndex, usage, INDEX_LIMITS } from './indexfile.mjs';
import { scanIndexes, scanProblems, writeIndexPayload, writeHeaderFiles, unlockReplica, createReplica, PACK_DIR } from './replica.mjs';
import { runCleanup } from './cleanup.mjs';
import { createVfs } from './vfs.mjs';
import { Draft, checkPath } from './store-ops.mjs';

/** indexFiles: at this many files in _index new commits are refused (NEEDS_REPAIR); open refuses above 256. */
export const STORE_LIMITS = Object.freeze({ packs: INDEX_LIMITS.packs, indexBytes: 16 * 1024 * 1024, fileBytes: INDEX_LIMITS.fileBytes, indexFiles: 200 });

export class Store {
  #dir; #vfs; #dk; #keys; #ctx; #header; #headerText; #headerInfo; #random; #now; #limits;
  #state; #current; #problems = []; #broken = false; #closed = false; #q = []; #running = null; #reads = 0;
  #packs; #autoEvery = 16; #sinceCleanup = 0; #lastCleanup = null; #indexFiles = 0;

  /**
   * Create a new, empty vault in dir and open it. dir must not hold a vault yet.
   * @param {string} dir
   * @param {{headerText: string, dk: Buffer, guard?: Function, random?: Function, now?: () => number}} o
   */
  static async create(dir, o) {
    const header = parseHeader(o.headerText);
    verifyHeaderMac(header, o.dk);
    const keys = subkeys(o.dk, header.vaultId, header.epoch);
    try {
      await createReplica(dir, { headerText: o.headerText, ctx: { kFile: keys.file, vaultId: header.vaultId, epoch: header.epoch },
        vfs: createVfs({ guard: o.guard }), random: o.random, now: o.now });
    } finally {
      zero(keys.header, keys.contentId, keys.file);
    }
    return Store.open(dir, { ...o, header, headerInfo: { used: 'main', problem: null, backupBehind: false } });
  }

  /**
   * Open a replica with a data key and its checked header (see openVaultFolder for the usual way in).
   * @param {string} dir
   * @param {{dk: Buffer, header: object, headerText: string, headerInfo?: object, guard?: Function,
   *   random?: Function, now?: () => number, limits?: object, autoCleanupEvery?: number}} o  limits: tests only;
   *   autoCleanupEvery: queue a cleanup after this many commits (default 16, 0 = never), so index files cannot pile up
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
    s.#autoEvery = o.autoCleanupEvery ?? 16;
    s.#keys = subkeys(s.#dk, o.header.vaultId, o.header.epoch);
    s.#ctx = { kFile: s.#keys.file, vaultId: o.header.vaultId, epoch: o.header.epoch };
    s.#packs = new PackReader(dir, s.#vfs, s.#ctx);
    try {
      const scan = await scanIndexes(dir, s.#ctx, s.#vfs);
      if (!scan.valid.length) fail(scan.damaged.length ? 'BAD_INDEX' : 'NO_INDEX', 'The vault has no readable index.');
      s.#current = { name: scan.valid[0].name, seq: scan.valid[0].seq };
      s.#state = scan.valid[0].state;
      s.#problems = scanProblems(scan);
      s.#indexFiles = scan.count;
      // leftovers count toward the next cleanup: a folder near the limit gets one soon after the first commit
      s.#sinceCleanup = Math.max(0, scan.valid.length - 2) + scan.parts.length;
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
      lastCleanup: this.#lastCleanup, indexFiles: this.#indexFiles, packs: this.#state.packSizes.size };
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

  /** Remove leftovers (see the note at the top). @returns {Promise<{done: boolean, reasons?: string[], removed?: object}>} */
  cleanup() { return this.#task(() => this.#cleanup()); }

  /** After every `autoCleanupEvery` commits, queue a cleanup; its result (or error code) goes to status().lastCleanup. */
  #maybeAutoCleanup() {
    if (!this.#autoEvery || ++this.#sinceCleanup < this.#autoEvery) return;
    this.#sinceCleanup = 0;
    this.#q.push({ kind: 'task', fn: () => this.#cleanup(), resolve: () => {}, reject: (e) => { this.#lastCleanup = { done: false, error: e.code || 'ERROR' }; } });
  }

  /** Replace the header (both copies). It must be for this vault and epoch, with a higher hseq and a valid MAC. */
  writeHeader(text) {
    return this.#task(async () => {
      const h = parseHeader(text);
      verifyHeaderMac(h, this.#dk);
      if (!h.vaultId.equals(this.#header.vaultId) || h.epoch !== this.#header.epoch || h.hseq <= this.#header.hseq) fail('BAD_INPUT', 'Not a newer header of this vault.');
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

  /** Finish queued work, then forget the keys. */
  async close() {
    while (this.#running) await this.#running;
    this.#closed = true;
    this.#wipe();
  }

  #wipe() {
    zero(this.#dk, this.#keys?.header, this.#keys?.contentId, this.#keys?.file);
    this.#state = { seq: 0, files: new Map(), trash: [], packSizes: new Map() };
    this.#packs?.clear();
  }

  #usable() {
    if (this.#closed) fail('CLOSED', 'The vault is locked.');
    if (this.#broken) fail('STORE_BROKEN', 'A save failed. Open the vault again.');
  }

  #op(fn) { this.#usable(); return this.#enqueue('op', fn); }
  #task(fn) { this.#usable(); return this.#enqueue('task', fn); }

  #enqueue(kind, fn) {
    return new Promise((resolve, reject) => {
      this.#q.push({ kind, fn, resolve, reject });
      if (!this.#running) this.#running = this.#drain();
    });
  }

  async #drain() {
    try {
      await new Promise((r) => setImmediate(r)); // writes of the same moment join one commit
      while (this.#q.length) {
        if (this.#q[0].kind === 'task') {
          const t = this.#q.shift();
          try {
            this.#usable();
            t.resolve(await t.fn());
          } catch (e) {
            t.reject(e);
          }
        } else {
          const batch = [];
          while (this.#q.length && this.#q[0].kind === 'op') batch.push(this.#q.shift());
          await this.#commit(batch);
        }
      }
    } finally {
      this.#running = null;
    }
  }

  async #commit(batch) {
    try {
      this.#usable();
    } catch (e) {
      for (const it of batch) it.reject(e);
      return;
    }
    if (this.#indexFiles >= this.#limits.indexFiles) {
      const err = new VaultError('NEEDS_REPAIR', 'The vault cannot save any more: a damaged file stops the cleanup. Run "vault verify", then "vault export" to save your notes.');
      for (const it of batch) it.reject(err);
      return;
    }
    const d = new Draft(this.#state);
    const now = this.#now();
    const ok = [];
    for (const it of batch) {
      try { ok.push([it, it.fn(d, now)]); } catch (e) { it.reject(e); }
    }
    if (!ok.length) return;
    if (!d.changed) { for (const [it, r] of ok) it.resolve(r); return; }
    let prep;
    try {
      prep = this.#prepare(d, now);
    } catch (e) {
      for (const [it] of ok) it.reject(e);
      return;
    }
    let name;
    try {
      for (const p of prep.packs) await this.#vfs.writeNew(join(this.#dir, PACK_DIR, `${p.name}.vx`), p.file);
      if (prep.packs.length) await this.#vfs.syncDir(join(this.#dir, PACK_DIR));
      name = await writeIndexPayload(this.#dir, prep.payload, this.#ctx, this.#vfs, this.#random);
    } catch (e) {
      this.#broken = true;
      const err = failedWrite(e);
      for (const [it] of ok) it.reject(err);
      return;
    }
    this.#current = { name, seq: prep.next.seq };
    this.#indexFiles++;
    this.#state = prep.next;
    for (const [it, r] of ok) it.resolve(r);
    this.#maybeAutoCleanup();
  }

  /** Build the packs for the new blobs, fill in the extents, encode the next index. No I/O. */
  #prepare(d, now) {
    const { packs, ext, sizes } = buildPacks(d.newBlobs, this.#ctx, this.#random, now);
    const packSizes = new Map([...this.#state.packSizes, ...sizes]);
    const fill = (e) => (e.kind === 'f' && e.x === null ? { ...e, x: ext.get(e.id) } : e);
    const files = new Map([...d.files].map(([p, e]) => [p, fill(e)]));
    const trash = d.trash.map(fill);
    const used = usage(files, trash);
    if (used.size > this.#limits.packs) fail('TOO_MANY_PACKS', 'The vault has too many packs. Compact it first.');
    for (const n of [...packSizes.keys()]) if (!used.has(n)) packSizes.delete(n);
    const next = { ...this.#state, seq: this.#state.seq + 1, time: now, files, trash, packSizes };
    const payload = encodeIndex(next, this.#ctx);
    if (payload.length > this.#limits.indexBytes) fail('TOO_BIG', 'The vault index would be bigger than 16 MiB.');
    let back = null; // never write an index this code cannot read back
    try { back = decodeIndex(payload, this.#ctx); } catch { back = null; }
    if (!back || back.seq !== next.seq || back.files.size !== files.size || back.trash.length !== trash.length) {
      fail('INTERNAL', 'The vault index could not be built (a bug). Nothing was saved.');
    }
    return { next, packs, payload };
  }

  async #cleanup() {
    if (this.#reads) return { done: false, reasons: ['reads in progress'] };
    const r = await runCleanup({ dir: this.#dir, vfs: this.#vfs, ctx: this.#ctx, dk: this.#dk, current: this.#current.name, problems: this.#problems });
    this.#lastCleanup = { done: r.done, level: r.level, reasons: r.reasons };
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
