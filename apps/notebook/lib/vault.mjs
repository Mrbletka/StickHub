// The vault: notes are plain files in real folders under HUB_DATA_DIR/vault. No database, no index file.
// Every path from a request is checked here: relative, inside the vault (resolve, then check the prefix),
// and no symlink anywhere on the way (never followed). New names follow the exFAT/Windows rules (names.mjs).
// Deleted items move to .deleted/<date>/<time> <original folder>/<name>, so restore needs no index file.

import { mkdir, readdir, lstat, readFile, rename, realpath, rm, rmdir, copyFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, sep, basename, dirname, extname } from 'node:path';
import { atomicWrite } from './atomic.mjs';
import { nameProblem, caseClash, isNote, isConflict } from '../public/js/names.mjs';

export const MAX_NOTE = 1024 * 1024;
export const MAX_FILES = 5000;
const DELETED = '.deleted';
const PATH_SEP = '⁄'; // stands for "/" inside a deletion folder name (valid on exFAT)

/** An error with an HTTP status and a message for the user. */
export class VaultError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 20);
const hidden = (name) => name === DELETED || name.endsWith('.part') || name.endsWith('.tmp');
const pad = (n) => String(n).padStart(2, '0');

export class Vault {
  /** @param {string} root  real (symlink-free) absolute folder */
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
    this.count = null;
  }

  /** Create the vault folder if needed and open it. */
  static async open(dir) {
    await mkdir(dir, { recursive: true });
    return new Vault(await realpath(dir));
  }

  /** Run changes one at a time (no two writes race on the same files). */
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    this.count = null;
    return run;
  }

  /**
   * Relative path -> absolute path inside the vault. Rejects "..", odd parts and symlinks on the way.
   * @param {string} rel  "" = the vault itself
   * @param {{mustExist?: boolean, deleted?: boolean}} [o]  deleted: allow paths inside .deleted
   */
  async resolve(rel, o = {}) {
    if (typeof rel !== 'string' || rel.length > 4000) throw new VaultError(400, 'Bad path.');
    const segs = rel === '' ? [] : rel.split('/');
    for (const s of segs) {
      if (!s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')) throw new VaultError(400, 'Bad path.');
    }
    if (!o.deleted && segs[0] === DELETED) throw new VaultError(400, 'Bad path.');
    const abs = join(this.root, ...segs);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new VaultError(400, 'Bad path.');
    let cur = this.root;
    for (const s of segs) {
      cur = join(cur, s);
      let st;
      try { st = await lstat(cur); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (o.mustExist !== false || cur !== abs) throw new VaultError(404, `Not found: ${rel}`);
        break;
      }
      if (st.isSymbolicLink()) throw new VaultError(400, 'Links are not followed.');
    }
    return abs;
  }

  /** Relative path of an absolute one. */
  rel(abs) { return abs === this.root ? '' : abs.slice(this.root.length + 1).split(sep).join('/'); }

  /** One folder's entries (lazy tree). Hides .deleted, *.part, *.tmp and links. */
  async list(rel) {
    const abs = await this.resolve(rel);
    const st = await lstat(abs);
    if (!st.isDirectory()) throw new VaultError(400, 'Not a folder.');
    const out = [];
    for (const ent of await readdir(abs, { withFileTypes: true })) {
      if (hidden(ent.name) || ent.isSymbolicLink() || !(ent.isFile() || ent.isDirectory())) continue;
      const s = await lstat(join(abs, ent.name)).catch(() => null);
      if (!s) continue; // vanished meanwhile
      out.push({ name: ent.name, path: rel ? `${rel}/${ent.name}` : ent.name, type: ent.isDirectory() ? 'dir' : 'file',
        size: s.size, mtime: Math.round(s.mtimeMs), conflict: isConflict(ent.name) });
    }
    return out;
  }

  /** Every file and folder path (for quick open and the filter). Stops at MAX_FILES files. */
  async index() {
    const files = [];
    const dirs = [];
    let truncated = false;
    const walk = async (absDir, relDir) => {
      for (const ent of await readdir(absDir, { withFileTypes: true })) {
        if (hidden(ent.name) || ent.isSymbolicLink()) continue;
        const r = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { dirs.push(r); await walk(join(absDir, ent.name), r); } else if (ent.isFile()) {
          if (files.length >= MAX_FILES) { truncated = true; return; }
          files.push(r);
        }
      }
    };
    await walk(this.root, '');
    return { files, dirs, truncated };
  }

  /** Number of files (cached until the next change). */
  async fileCount() {
    if (this.count === null) this.count = (await this.index()).files.length;
    return this.count;
  }

  async #roomFor(n) {
    if ((await this.fileCount()) + n > MAX_FILES) throw new VaultError(409, `The vault is full (max ${MAX_FILES} files).`);
  }

  /** A note's text and version (hash of its bytes). */
  async read(rel) {
    const abs = await this.resolve(rel);
    const st = await lstat(abs);
    if (!st.isFile()) throw new VaultError(400, 'Not a file.');
    if (st.size > MAX_NOTE) throw new VaultError(413, 'This file is bigger than 1 MB and cannot be opened here.');
    const buf = await readFile(abs);
    return { content: buf.toString('utf8'), version: hash(buf), mtime: Math.round(st.mtimeMs), size: st.size };
  }

  /** Version of a file without its text, or exists: false. */
  async stat(rel) {
    try {
      const abs = await this.resolve(rel);
      const st = await lstat(abs);
      if (!st.isFile()) return { exists: false };
      if (st.size > MAX_NOTE) return { exists: true, version: `big-${st.size}`, mtime: Math.round(st.mtimeMs) };
      return { exists: true, version: hash(await readFile(abs)), mtime: Math.round(st.mtimeMs), size: st.size };
    } catch (e) {
      if (e.status === 404) return { exists: false };
      throw e;
    }
  }

  /**
   * Save a note. Unchanged content is never rewritten. If the file changed since `base` (another device, the sync),
   * the save is refused with 409 unless force is set.
   * @returns {Promise<{version: string, written: boolean}>}
   */
  write(rel, content, base, force = false) {
    return this.#serial(async () => {
      if (typeof content !== 'string') throw new VaultError(400, 'No text.');
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_NOTE) throw new VaultError(413, 'A note can be at most 1 MB.');
      const abs = await this.resolve(rel, { mustExist: false });
      if (!isNote(basename(abs))) throw new VaultError(400, 'Only .md and .txt files can be saved here.');
      let cur = null;
      try { cur = await readFile(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const curVer = cur ? hash(cur) : null;
      if (cur && cur.equals(bytes)) return { version: curVer, written: false };
      if (!force && base !== undefined && base !== curVer) {
        const err = new VaultError(409, 'This note was changed somewhere else.');
        err.version = curVer;
        throw err;
      }
      if (!cur) await this.#checkNew(dirname(abs), basename(abs), 1);
      await atomicWrite(abs, bytes);
      return { version: hash(bytes), written: true };
    });
  }

  async #checkNew(parentAbs, name, files, self = null) {
    const problem = nameProblem(name);
    if (problem) throw new VaultError(400, problem);
    const st = await lstat(parentAbs).catch(() => null);
    if (!st?.isDirectory()) throw new VaultError(404, 'The folder does not exist.');
    if (caseClash(await readdir(parentAbs), name, self)) throw new VaultError(409, `"${name}" already exists here (names ignore upper/lower case).`);
    if (files) await this.#roomFor(files);
  }

  /** New empty note or folder in dirRel. */
  create(dirRel, name, type) {
    return this.#serial(async () => {
      const parent = await this.resolve(dirRel);
      await this.#checkNew(parent, name, type === 'file' ? 1 : 0);
      const abs = join(parent, name);
      if (type === 'dir') await mkdir(abs);
      else if (type === 'file') await atomicWrite(abs, '');
      else throw new VaultError(400, 'type: file or dir');
      return { path: this.rel(abs) };
    });
  }

  /** Rename in place. A change of upper/lower case only goes through a temporary name (for case-insensitive disks). */
  rename(rel, name) {
    return this.#serial(async () => {
      const abs = await this.resolve(rel);
      if (abs === this.root) throw new VaultError(400, 'The vault itself cannot be renamed.');
      const old = basename(abs);
      if (name === old) return { path: rel };
      await this.#checkNew(dirname(abs), name, 0, old);
      const dest = join(dirname(abs), name);
      if (old.toLowerCase() === name.toLowerCase()) {
        const tmp = `${abs}.renaming-${randomBytes(3).toString('hex')}.tmp`;
        await rename(abs, tmp);
        await rename(tmp, dest);
      } else {
        await rename(abs, dest);
      }
      return { path: this.rel(dest) };
    });
  }

  /** Move items into a folder. Each item reports its own result. */
  move(rels, toRel) {
    return this.#serial(async () => {
      const to = await this.resolve(toRel);
      if (!(await lstat(to)).isDirectory()) throw new VaultError(400, 'Move target is not a folder.');
      const results = [];
      for (const rel of rels) {
        try {
          const abs = await this.resolve(rel);
          if (abs === this.root) throw new VaultError(400, 'The vault itself cannot be moved.');
          if (dirname(abs) === to) { results.push({ from: rel, to: rel }); continue; }
          if (to === abs || to.startsWith(abs + sep)) throw new VaultError(400, 'A folder cannot go inside itself.');
          await this.#checkNew(to, basename(abs), 0);
          const dest = join(to, basename(abs));
          await rename(abs, dest);
          results.push({ from: rel, to: this.rel(dest) });
        } catch (e) {
          if (!(e instanceof VaultError)) throw e;
          results.push({ from: rel, error: e.message });
        }
      }
      return { results };
    });
  }

  /** Copy a note or folder next to itself: "name copy.md", "name copy 2.md", ... */
  duplicate(rel) {
    return this.#serial(async () => {
      const abs = await this.resolve(rel);
      if (abs === this.root) throw new VaultError(400, 'The vault itself cannot be copied.');
      const st = await lstat(abs);
      const parent = dirname(abs);
      const names = await readdir(parent);
      const ext = st.isDirectory() ? '' : extname(abs);
      const stem = basename(abs, ext);
      let name = `${stem} copy${ext}`;
      for (let i = 2; caseClash(names, name); i++) name = `${stem} copy ${i}${ext}`;
      if (nameProblem(name)) throw new VaultError(400, nameProblem(name));
      const dest = join(parent, name);
      if (st.isDirectory()) {
        const files = await countTree(abs);
        await this.#roomFor(files);
        await copyTree(abs, dest);
      } else {
        await this.#roomFor(1);
        await copyFile(abs, `${dest}.part`);
        await rename(`${dest}.part`, dest);
      }
      return { path: this.rel(dest) };
    });
  }

  /** Delete = move to .deleted/<date>/<time> <original folder>/<name>. */
  remove(rels) {
    return this.#serial(async () => {
      const now = new Date();
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const results = [];
      for (const rel of rels) {
        try {
          const abs = await this.resolve(rel);
          if (abs === this.root) throw new VaultError(400, 'The vault itself cannot be deleted.');
          const parentRel = this.rel(dirname(abs));
          const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString('hex')}`;
          let holder = parentRel ? `${stamp} ${parentRel.split('/').join(PATH_SEP)}` : stamp;
          if (holder.length > 200) holder = stamp; // very deep path: restores to the top level
          const dir = join(this.root, DELETED, day, holder);
          await mkdir(dir, { recursive: true });
          await rename(abs, join(dir, basename(abs)));
          results.push({ from: rel });
        } catch (e) {
          if (!(e instanceof VaultError)) throw e;
          results.push({ from: rel, error: e.message });
        }
      }
      return { results };
    });
  }

  /** What is in .deleted, newest first. */
  async listDeleted() {
    const base = join(this.root, DELETED);
    const items = [];
    const days = await readdir(base).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    for (const day of days.sort().reverse()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const holders = await readdir(join(base, day)).catch(() => []);
      for (const holder of holders.sort().reverse()) {
        const m = /^(\d{6})-[0-9a-f]{4}(?: (.+))?$/.exec(holder);
        if (!m) continue;
        for (const ent of await readdir(join(base, day, holder), { withFileTypes: true })) {
          if (ent.isSymbolicLink()) continue;
          const parent = m[2] ? m[2].split(PATH_SEP).join('/') : '';
          items.push({ id: `${day}/${holder}/${ent.name}`, name: ent.name, type: ent.isDirectory() ? 'dir' : 'file',
            original: parent ? `${parent}/${ent.name}` : ent.name, when: `${day} ${m[1].replace(/(..)(..)(..)/, '$1:$2')}` });
        }
      }
    }
    return { items };
  }

  /** Put a deleted item back where it was (folders are made again; a clash gets " (restored)"). */
  restore(id) {
    return this.#serial(async () => {
      const item = (await this.listDeleted()).items.find((i) => i.id === id);
      if (!item) throw new VaultError(404, 'Not in Recently deleted.');
      const src = await this.resolve(`${DELETED}/${id}`, { deleted: true });
      const parts = item.original.split('/');
      let dir = this.root;
      for (const p of parts.slice(0, -1)) {
        if (nameProblem(p)) { dir = this.root; break; } // odd folder name: restore to the top level
        dir = join(dir, p);
        const st = await lstat(dir).catch(() => null);
        if (st?.isSymbolicLink() || (st && !st.isDirectory())) throw new VaultError(409, `Cannot restore into ${this.rel(dir)}.`);
        if (!st) await mkdir(dir);
      }
      const names = await readdir(dir);
      const ext = item.type === 'dir' ? '' : extname(item.name);
      const stem = basename(item.name, ext);
      let name = item.name;
      for (let i = 1; caseClash(names, name); i++) name = `${stem} (restored${i > 1 ? ` ${i}` : ''})${ext}`;
      await this.#roomFor(item.type === 'dir' ? await countTree(src) : 1);
      await rename(src, join(dir, name));
      // Remove the now empty holder (and day) folder; ENOTEMPTY means something else is still in there: keep it.
      for (const d of [dirname(src), dirname(dirname(src))]) await rmdir(d).catch((e) => { if (e.code !== 'ENOTEMPTY') throw e; });
      return { path: this.rel(join(dir, name)) };
    });
  }

  /** Empty Recently deleted for good. */
  emptyDeleted() {
    return this.#serial(async () => {
      const n = (await this.listDeleted()).items.length;
      await rm(join(this.root, DELETED), { recursive: true, force: true });
      return { removed: n };
    });
  }
}

async function countTree(dir) {
  let n = 0;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink() || hidden(ent.name)) continue;
    n += ent.isDirectory() ? await countTree(join(dir, ent.name)) : 1;
  }
  return n;
}

async function copyTree(src, dest) {
  await mkdir(dest);
  for (const ent of await readdir(src, { withFileTypes: true })) {
    if (ent.isSymbolicLink() || hidden(ent.name)) continue; // never follow or copy links
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) await copyTree(s, d);
    else if (ent.isFile()) { await copyFile(s, `${d}.part`); await rename(`${d}.part`, d); }
  }
}
