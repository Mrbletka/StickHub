// Changes to the vault's file list, on a draft (a copy of the committed state). Pure: no file access, no crypto.
// Every operation checks everything first and only then changes the draft, so a failing operation leaves no half
// change behind and the other operations of the same group commit still go through.
// Error messages never contain a path (paths are note names).

import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';
import { relOk } from '../sync/safe-path.mjs';
import { INDEX_LIMITS } from './indexfile.mjs';

/** Throw BAD_PATH unless p is a valid vault path ("app/folder/name", exFAT/Windows-safe names). */
export function checkPath(p) {
  if (typeof p !== 'string' || !relOk(p)) fail('BAD_PATH', 'That is not a valid path.');
  return p;
}

const parentsOf = (p) => { const out = []; for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i)); return out; };
const under = (p, dir) => p.startsWith(`${dir}/`);

export class Draft {
  /** @param {{files: Map<string, object>, trash: object[]}} state  the committed state (not changed) */
  constructor(state) {
    this.files = new Map(state.files);
    this.trash = [...state.trash];
    this.lower = new Map([...this.files.keys()].map((p) => [p.toLowerCase(), p]));
    this.extentsById = null;
    this.newBlobs = new Map(); // content id -> {data, path}: written in this commit
    this.changed = false;
  }

  /** Extents already stored for a content id (dedupe), or undefined. */
  extentsFor(id) {
    if (!this.extentsById) {
      this.extentsById = new Map();
      for (const e of [...this.files.values(), ...this.trash]) if (e.kind === 'f' && e.x) this.extentsById.set(e.id, e.x);
    }
    return this.extentsById.get(id);
  }

  #set(p, e) { this.files.set(p, e); this.lower.set(p.toLowerCase(), p); this.changed = true; }
  #del(p) { this.files.delete(p); this.lower.delete(p.toLowerCase()); this.changed = true; }

  /** Throw CASE_CLASH if another path differs from p only in upper/lower case (exFAT and Windows cannot hold both). */
  #checkCase(p, except) {
    const other = this.lower.get(p.toLowerCase());
    if (other !== undefined && other !== p && other !== except) fail('CASE_CLASH', 'A name that differs only in upper/lower case exists.');
  }

  /** Parents that must be created for p; throws NOT_DIR if one of them is a file. */
  #missingParents(p) {
    const missing = [];
    for (const q of parentsOf(p)) {
      const e = this.files.get(q);
      if (!e) { this.#checkCase(q); missing.push(q); } else if (e.kind !== 'd') fail('NOT_DIR', 'A part of the path is a file.');
    }
    return missing;
  }

  #room(n) {
    if (this.files.size + n > INDEX_LIMITS.files) fail('TOO_BIG', 'The vault holds too many files.');
  }

  /**
   * Write a file (create or replace). ifMatch: undefined = no check, null = must not exist, string = current content id.
   * @param {{path: string, id: string, size: number, data: Buffer}} f
   */
  write(f, ifMatch, now) {
    const cur = this.files.get(f.path);
    if (cur?.kind === 'd') fail('IS_DIR', 'That is a folder.');
    if (ifMatch !== undefined && (ifMatch === null ? cur !== undefined : cur?.id !== ifMatch)) fail('CONFLICT', 'It was changed meanwhile.');
    if (cur && cur.id === f.id) return { id: f.id, size: f.size }; // same content: nothing to commit, mtime kept
    if (!cur) this.#checkCase(f.path);
    const missing = this.#missingParents(f.path);
    this.#room(missing.length + 1);
    for (const q of missing) this.#set(q, { kind: 'd', mtime: now });
    let x = f.size === 0 ? [] : this.extentsFor(f.id);
    if (!x) {
      x = null; // filled in when the pack is built
      if (!this.newBlobs.has(f.id)) this.newBlobs.set(f.id, { data: f.data, path: f.path });
    }
    this.#set(f.path, { kind: 'f', id: f.id, size: f.size, mtime: now, x });
    return { id: f.id, size: f.size };
  }

  /** Create a folder and its parents; an existing folder is fine. */
  mkdir(p, now) {
    const cur = this.files.get(p);
    if (cur?.kind === 'd') return {};
    if (cur) fail('EXISTS', 'A file with that name exists.');
    this.#checkCase(p);
    const missing = this.#missingParents(p);
    this.#room(missing.length + 1);
    for (const q of [...missing, p]) this.#set(q, { kind: 'd', mtime: now });
    return {};
  }

  /** Move or rename a file or a folder (with everything in it). The target must not exist. */
  move(from, to, ifMatch, now) {
    const src = this.files.get(from);
    if (!src) fail('NOT_FOUND', 'Not found.');
    if (ifMatch !== undefined && src.id !== ifMatch) fail('CONFLICT', 'It was changed meanwhile.');
    if (from === to) return {};
    if (under(to, from)) fail('BAD_PATH', 'A folder cannot move into itself.');
    if (this.files.has(to) && to.toLowerCase() !== from.toLowerCase()) fail('EXISTS', 'Something with that name exists.');
    const moves = [[from, to]];
    if (src.kind === 'd') for (const p of this.files.keys()) if (under(p, from)) moves.push([p, to + p.slice(from.length)]);
    const leaving = new Set(moves.map(([a]) => a));
    for (const [, b] of moves) {
      const other = this.lower.get(b.toLowerCase());
      if (other !== undefined && !leaving.has(other)) fail('CASE_CLASH', 'A name that differs only in upper/lower case exists.');
    }
    const missing = this.#missingParents(to).filter((q) => !leaving.has(q));
    this.#room(missing.length);
    for (const q of missing) this.#set(q, { kind: 'd', mtime: now });
    const entries = moves.map(([a, b]) => [b, this.files.get(a)]);
    for (const [a] of moves) this.#del(a);
    for (const [b, e] of entries) this.#set(b, e);
    return {};
  }

  /** Move files or folders (with their contents) to the vault trash. Returns the new trash ids. */
  remove(paths, now) {
    const all = new Set();
    for (const p of paths) {
      if (!this.files.has(p)) fail('NOT_FOUND', 'Not found.');
      all.add(p);
      if (this.files.get(p).kind === 'd') for (const q of this.files.keys()) if (under(q, p)) all.add(q);
    }
    if (this.trash.length + all.size > INDEX_LIMITS.trash) fail('TOO_BIG', 'The vault trash is full. Empty it first.');
    const tids = [];
    for (const p of [...all].sort()) {
      const tid = randomBytes(8).toString('hex');
      this.trash.push({ tid, path: p, ...this.files.get(p), deletedAt: now });
      tids.push(tid);
    }
    for (const p of all) this.#del(p);
    return { tids };
  }

  /** Put trash entries back (at their old path, or `to` for a single one). */
  restore(tids, to, now) {
    const picked = tids.map((tid) => {
      const i = this.trash.findIndex((t) => t.tid === tid);
      if (i < 0) fail('NOT_FOUND', 'Not in the trash.');
      return this.trash[i];
    });
    if (to !== undefined && picked.length !== 1) fail('BAD_INPUT', 'A new path works for one entry only.');
    const plan = picked.map((t) => [to ?? t.path, t]).sort(([a], [b]) => (a < b ? -1 : 1));
    const targets = new Map(plan.map(([p, t]) => [p, t.kind]));
    if (targets.size !== plan.length) fail('EXISTS', 'Something with that name exists.');
    for (const [p, t] of plan) {
      const cur = this.files.get(p);
      if (cur && !(cur.kind === 'd' && t.kind === 'd')) fail('EXISTS', 'Something with that name exists.');
      if (!cur) this.#checkCase(p);
      for (const q of parentsOf(p)) {
        const kind = this.files.get(q)?.kind ?? targets.get(q);
        if (kind === 'f') fail('NOT_DIR', 'A part of the path is a file.');
        if (!kind) this.#checkCase(q);
      }
    }
    this.#room(plan.length);
    for (const [p, t] of plan) {
      for (const q of parentsOf(p)) if (!this.files.has(q)) this.#set(q, { kind: 'd', mtime: now });
      const { tid: _t, path: _p, deletedAt: _d, ...entry } = t;
      if (!this.files.has(p)) this.#set(p, entry);
    }
    const gone = new Set(tids);
    this.trash = this.trash.filter((t) => !gone.has(t.tid));
    this.changed = true;
    return {};
  }
}
