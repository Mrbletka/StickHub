// The Notebook's notes: files under "vault/" in the app's own data, kept through hubfs (design 8.5). In the hub with
// the vault on, that is the encrypted vault (a data socket and a token); otherwise plain files in the app's data
// folder (./data/vault when the app runs alone). No database, no index file of ours.
// - list() and index() are one tree() call each; a save checks the content id (ifMatch), so a note changed somewhere
//   else meanwhile is never overwritten by accident; rename, move and delete are moves (index operations in the hub).
// - Deleted items move to vault/.deleted/<date>/<time> <original folder>/<name>, so restore needs no index file.
//   Emptying it removes them (in the hub: to the vault's own trash, kept 30 days).
// - Every path from a request is checked here; new names follow the exFAT/Windows rules (names.mjs). Messages never
//   contain a vault folder, socket or token: hubfs errors are fixed texts, and anything else becomes a plain 500.

import { randomBytes } from 'node:crypto';
import { nameProblem, caseClash, isNote, isConflict } from '../public/js/names.mjs';

export const MAX_NOTE = 1024 * 1024;
export const MAX_FILES = 5000;
/** The notes folder inside the app's data. */
export const ROOT = 'vault';
/** Longest note path: hubfs paths are at most 200 characters, "vault/" included. */
export const MAX_PATH = 200 - ROOT.length - 1;
const DELETED = '.deleted';
const PATH_SEP = '⁄'; // stands for "/" inside a deletion folder name (valid on exFAT)

/** An error with an HTTP status and a message for the user. */
export class VaultError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hidden = (name) => name === DELETED || name.endsWith('.part') || name.endsWith('.tmp');
const pad = (n) => String(n).padStart(2, '0');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const join2 = (dir, name) => (dir ? `${dir}/${name}` : name);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; };
const conflict = (version) => Object.assign(new VaultError(409, 'This note was changed somewhere else.'), { version });

/** A hubfs error as a VaultError (fixed texts only). Anything unknown is thrown as it is (the server answers 500). */
function fsError(e, rel) {
  if (e instanceof VaultError) return e;
  const known = { ENOENT: [404, `Not found: ${rel}`], EEXIST: [409, 'Something with that name exists already.'],
    ECONFLICT: [409, 'This note was changed somewhere else.'], ENOTEMPTY: [409, 'The folder is not empty.'],
    EISDIR: [400, 'That is a folder.'], ENOTDIR: [400, 'Not a folder.'], EINVAL: [400, e.message], EFBIG: [413, 'Too big.'],
    ELOCKED: [423, 'The vault is locked. Unlock the hub, then try again.'],
    EIO: [503, 'The notes cannot be reached right now. Try again.'], EACCES: [503, 'The notes cannot be reached right now. Restart the app.'] }[e?.code];
  return known ? new VaultError(known[0], known[1]) : e;
}

export class Vault {
  /** @param {object} fs  a hubfs (createHubFs() from lib/hubfs.mjs) */
  constructor(fs) {
    this.fs = fs;
    this.queue = Promise.resolve();
    this.count = null;
  }

  /** Run changes one at a time (no two changes race on the same notes). */
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    this.count = null;
    return run;
  }

  /**
   * A note path ("" = the notes folder) as a hubfs path. Rejects "..", odd parts and .deleted (unless allowed).
   * @param {string} rel
   * @param {{deleted?: boolean}} [o]
   */
  path(rel, o = {}) {
    if (typeof rel !== 'string') throw new VaultError(400, 'Bad path.');
    if (rel.length > MAX_PATH) throw new VaultError(400, `The path is too long (max ${MAX_PATH} characters).`);
    const segs = rel === '' ? [] : rel.split('/');
    for (const s of segs) {
      if (!s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')) throw new VaultError(400, 'Bad path.');
    }
    if (!o.deleted && segs[0] === DELETED) throw new VaultError(400, 'Bad path.');
    return rel ? `${ROOT}/${rel}` : ROOT;
  }

  /** stat of a note path, or null when it does not exist. */
  async #stat(rel, o) {
    try { return await this.fs.stat(this.path(rel, o)); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw fsError(e, rel);
    }
  }

  async #mv(from, to) {
    await this.fs.rename(this.path(from, { deleted: true }), this.path(to, { deleted: true })).catch((e) => { throw fsError(e, from); });
  }

  /** Names in a folder (all of them, also hidden ones); the notes folder may not exist yet. */
  async #names(dirRel) {
    try { return await this.fs.readdir(this.path(dirRel, { deleted: true })); } catch (e) {
      if (e.code === 'ENOENT' && dirRel === '') return [];
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new VaultError(404, 'The folder does not exist.');
      throw fsError(e, dirRel);
    }
  }

  /** One folder's entries (one tree() call, depth 1). Hides .deleted, *.part and *.tmp. */
  async list(rel) {
    const p = this.path(rel);
    let entries;
    try { entries = await this.fs.tree(p, { depth: 1 }); } catch (e) {
      if (e.code === 'ENOENT' && rel === '') return []; // nothing saved yet
      throw fsError(e, rel);
    }
    return entries.map((e) => ({ e, name: e.path.slice(p.length + 1) })).filter(({ name }) => !hidden(name))
      .map(({ e, name }) => ({ name, path: join2(rel, name), type: e.kind === 'd' ? 'dir' : 'file', size: e.size ?? 0,
        mtime: Math.round(e.mtime), conflict: isConflict(name) }));
  }

  /** Every file and folder path (for quick open and the filter), from one tree() call. At most MAX_FILES files. */
  async index() {
    let all;
    try { all = await this.fs.tree(ROOT); } catch (e) {
      if (e.code === 'ENOENT') return { files: [], dirs: [], truncated: false };
      throw fsError(e, '');
    }
    const files = [];
    const dirs = [];
    let truncated = false;
    for (const e of all) {
      const rel = e.path.slice(ROOT.length + 1);
      if (rel.split('/').some(hidden)) continue;
      if (e.kind === 'd') dirs.push(rel);
      else if (files.length >= MAX_FILES) truncated = true;
      else files.push(rel);
    }
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

  /** A note's text and version (its content id). The id is read before and after the text, so they belong together. */
  async read(rel) {
    const p = this.path(rel);
    for (let i = 0; ; i++) {
      const s = await this.#stat(rel);
      if (!s) throw new VaultError(404, `Not found: ${rel}`);
      if (!s.isFile()) throw new VaultError(400, 'Not a file.');
      if (s.size > MAX_NOTE) throw new VaultError(413, 'This file is bigger than 1 MB and cannot be opened here.');
      const buf = await this.fs.readFile(p).catch((e) => { throw fsError(e, rel); });
      if (i >= 2 || (await this.#stat(rel))?.id === s.id) return { content: buf.toString('utf8'), version: s.id, mtime: Math.round(s.mtimeMs), size: s.size };
    }
  }

  /** Version of a file without its text, or exists: false. */
  async stat(rel) {
    const s = await this.#stat(rel);
    if (!s?.isFile()) return { exists: false };
    if (s.size > MAX_NOTE) return { exists: true, version: `big-${s.size}`, mtime: Math.round(s.mtimeMs) };
    return { exists: true, version: s.id, mtime: Math.round(s.mtimeMs), size: s.size };
  }

  /**
   * Save a note. Unchanged content is never rewritten. If the file changed since `base` (another device, the sync),
   * the save is refused with 409 unless force is set; the write itself carries ifMatch, so a change that lands in
   * between is refused too.
   * @returns {Promise<{version: string, written: boolean}>}
   */
  write(rel, content, base, force = false) {
    return this.#serial(async () => {
      if (typeof content !== 'string') throw new VaultError(400, 'No text.');
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_NOTE) throw new VaultError(413, 'A note can be at most 1 MB.');
      const p = this.path(rel);
      if (!rel || !isNote(nameOf(rel))) throw new VaultError(400, 'Only .md and .txt files can be saved here.');
      const cur = await this.#stat(rel);
      if (cur?.isDirectory()) throw new VaultError(400, 'That is a folder.');
      if (cur && cur.size === bytes.length && (await this.fs.readFile(p).catch((e) => { throw fsError(e, rel); })).equals(bytes)) {
        return { version: cur.id, written: false };
      }
      if (!force && base !== undefined && base !== (cur ? cur.id : null)) throw conflict(cur ? cur.id : null);
      if (!cur) await this.#checkNew(parentOf(rel), nameOf(rel), 1);
      try {
        const r = await this.fs.writeFile(p, bytes, force ? {} : { ifMatch: cur ? cur.id : 'none' });
        return { version: r.id, written: true };
      } catch (e) {
        if (e.code === 'ECONFLICT') throw conflict((await this.#stat(rel))?.id ?? null);
        throw fsError(e, rel);
      }
    });
  }

  async #checkNew(parentRel, name, files, self = null) {
    const problem = nameProblem(name);
    if (problem) throw new VaultError(400, problem);
    if (join2(parentRel, name).length > MAX_PATH) throw new VaultError(400, `The path is too long (max ${MAX_PATH} characters).`);
    if (caseClash(await this.#names(parentRel), name, self)) throw new VaultError(409, `"${name}" already exists here (names ignore upper/lower case).`);
    if (files) await this.#roomFor(files);
  }

  /** New empty note or folder in dirRel. */
  create(dirRel, name, type) {
    return this.#serial(async () => {
      this.path(dirRel);
      await this.#checkNew(dirRel, name, type === 'file' ? 1 : 0);
      const rel = join2(dirRel, name);
      if (type === 'dir') await this.fs.mkdir(this.path(rel), { recursive: true }).catch((e) => { throw fsError(e, rel); });
      else if (type === 'file') await this.fs.writeFile(this.path(rel), '', { ifMatch: 'none' }).catch((e) => { throw fsError(e, rel); });
      else throw new VaultError(400, 'type: file or dir');
      return { path: rel };
    });
  }

  async #mustExist(rel, what) {
    this.path(rel);
    if (rel === '') throw new VaultError(400, `The vault itself cannot be ${what}.`);
    const s = await this.#stat(rel);
    if (!s) throw new VaultError(404, `Not found: ${rel}`);
    return s;
  }

  /** Rename in place. A change of upper/lower case only goes through a temporary name (case-insensitive disks). */
  rename(rel, name) {
    return this.#serial(async () => {
      await this.#mustExist(rel, 'renamed');
      const old = nameOf(rel);
      const parent = parentOf(rel);
      if (name === old) return { path: rel };
      await this.#checkNew(parent, name, 0, old);
      const dest = join2(parent, name);
      if (old.toLowerCase() === name.toLowerCase()) {
        const tmp = join2(parent, `.renaming-${randomBytes(3).toString('hex')}.tmp`);
        await this.#mv(rel, tmp);
        await this.#mv(tmp, dest);
      } else {
        await this.#mv(rel, dest);
      }
      return { path: dest };
    });
  }

  /** Move items into a folder. Each item reports its own result. */
  move(rels, toRel) {
    return this.#serial(async () => {
      this.path(toRel);
      const to = toRel === '' ? null : await this.#stat(toRel);
      if (toRel !== '' && !to) throw new VaultError(404, `Not found: ${toRel}`);
      if (to && !to.isDirectory()) throw new VaultError(400, 'Move target is not a folder.');
      const results = [];
      for (const rel of rels) {
        try {
          await this.#mustExist(rel, 'moved');
          if (parentOf(rel) === toRel) { results.push({ from: rel, to: rel }); continue; }
          if (toRel === rel || toRel.startsWith(`${rel}/`)) throw new VaultError(400, 'A folder cannot go inside itself.');
          await this.#checkNew(toRel, nameOf(rel), 0);
          const dest = join2(toRel, nameOf(rel));
          await this.#mv(rel, dest);
          results.push({ from: rel, to: dest });
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
      const s = await this.#mustExist(rel, 'copied');
      const parent = parentOf(rel);
      const names = await this.#names(parent);
      const ext = s.isDirectory() ? '' : extOf(nameOf(rel));
      const stem = nameOf(rel).slice(0, nameOf(rel).length - ext.length);
      let name = `${stem} copy${ext}`;
      for (let i = 2; caseClash(names, name); i++) name = `${stem} copy ${i}${ext}`;
      if (nameProblem(name)) throw new VaultError(400, nameProblem(name));
      const dest = join2(parent, name);
      const copy = async (from, to) => {
        const buf = await this.fs.readFile(this.path(from)).catch((e) => { throw fsError(e, from); });
        await this.fs.writeFile(this.path(to), buf, { ifMatch: 'none' }).catch((e) => { throw fsError(e, to); });
      };
      if (!s.isDirectory()) {
        await this.#roomFor(1);
        await copy(rel, dest);
        return { path: dest };
      }
      const kids = (await this.fs.tree(this.path(rel)).catch((e) => { throw fsError(e, rel); }))
        .map((e) => ({ kind: e.kind, sub: e.path.slice(this.path(rel).length + 1) })).filter((e) => !e.sub.split('/').some(hidden));
      await this.#roomFor(kids.filter((e) => e.kind === 'f').length);
      await this.fs.mkdir(this.path(dest)).catch((e) => { throw fsError(e, dest); });
      for (const d of kids.filter((e) => e.kind === 'd')) await this.fs.mkdir(this.path(`${dest}/${d.sub}`), { recursive: true }).catch((e) => { throw fsError(e, dest); });
      await Promise.all(kids.filter((e) => e.kind === 'f').map((f) => copy(`${rel}/${f.sub}`, `${dest}/${f.sub}`)));
      return { path: dest };
    });
  }

  /** Delete = move to .deleted/<date>/<time> <original folder>/<name> (one move each). */
  remove(rels) {
    return this.#serial(async () => {
      const now = new Date();
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const results = [];
      for (const rel of rels) {
        try {
          await this.#mustExist(rel, 'deleted');
          const parentRel = parentOf(rel);
          const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString('hex')}`;
          let holder = parentRel ? `${stamp} ${parentRel.split('/').join(PATH_SEP)}` : stamp;
          // a deep path does not fit in one name: it restores to the top level
          if (holder.length > 120 || `${DELETED}/${day}/${holder}/${nameOf(rel)}`.length > MAX_PATH) holder = stamp;
          await this.#mv(rel, `${DELETED}/${day}/${holder}/${nameOf(rel)}`);
          results.push({ from: rel });
        } catch (e) {
          if (!(e instanceof VaultError)) throw e;
          results.push({ from: rel, error: e.message });
        }
      }
      return { results };
    });
  }

  /** What is in .deleted, newest first (one tree() call). */
  async listDeleted() {
    const base = this.path(DELETED, { deleted: true });
    let all;
    try { all = await this.fs.tree(base, { depth: 3 }); } catch (e) {
      if (e.code === 'ENOENT') return { items: [] };
      throw fsError(e, '');
    }
    const items = [];
    for (const e of all) {
      const [day, holder, name, ...more] = e.path.slice(base.length + 1).split('/');
      if (!name || more.length || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const m = /^(\d{6})-[0-9a-f]{4}(?: (.+))?$/.exec(holder);
      if (!m) continue;
      const parent = m[2] ? m[2].split(PATH_SEP).join('/') : '';
      items.push({ id: `${day}/${holder}/${name}`, name, type: e.kind === 'd' ? 'dir' : 'file',
        original: join2(parent, name), when: `${day} ${m[1].replace(/(..)(..)(..)/, '$1:$2')}` });
    }
    const key = (i) => i.id.slice(0, i.id.length - i.name.length); // day/holder/: newest first
    return { items: items.sort((a, b) => (key(a) === key(b) ? (a.name < b.name ? -1 : 1) : key(a) < key(b) ? 1 : -1)) };
  }

  /** Put a deleted item back where it was (folders are made again; a clash gets " (restored)"). */
  restore(id) {
    return this.#serial(async () => {
      const item = (await this.listDeleted()).items.find((i) => i.id === id);
      if (!item) throw new VaultError(404, 'Not in Recently deleted.');
      const src = `${DELETED}/${id}`;
      let dir = '';
      for (const p of item.original.split('/').slice(0, -1)) {
        if (nameProblem(p)) { dir = ''; break; } // odd folder name: restore to the top level
        const next = join2(dir, p);
        const st = await this.#stat(next);
        if (st && !st.isDirectory()) throw new VaultError(409, `Cannot restore into ${next}.`);
        if (!st) await this.fs.mkdir(this.path(next), { recursive: true }).catch((e) => { throw fsError(e, next); });
        dir = next;
      }
      const names = await this.#names(dir);
      const ext = item.type === 'dir' ? '' : extOf(item.name);
      const stem = item.name.slice(0, item.name.length - ext.length);
      let name = item.name;
      for (let i = 1; caseClash(names, name); i++) name = `${stem} (restored${i > 1 ? ` ${i}` : ''})${ext}`;
      const files = item.type === 'dir' ? (await this.fs.tree(this.path(src, { deleted: true }))).filter((e) => e.kind === 'f').length : 1;
      await this.#roomFor(files);
      await this.#mv(src, join2(dir, name));
      // Remove the now empty holder (and day) folder; ENOTEMPTY means something else is still in there: keep it.
      for (const d of [parentOf(src), parentOf(parentOf(src))]) {
        await this.fs.rm(this.path(d, { deleted: true })).catch((e) => { if (e.code !== 'ENOTEMPTY') throw fsError(e, ''); });
      }
      return { path: join2(dir, name) };
    });
  }

  /** Empty Recently deleted (in the hub: into the vault's own trash, kept 30 days). */
  emptyDeleted() {
    return this.#serial(async () => {
      const n = (await this.listDeleted()).items.length;
      await this.fs.rm(this.path(DELETED, { deleted: true }), { recursive: true, force: true }).catch((e) => { throw fsError(e, ''); });
      return { removed: n };
    });
  }
}
