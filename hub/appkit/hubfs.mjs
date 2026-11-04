// hubfs: file functions for StickHub apps, shaped like node:fs/promises (design 8.1). One file, node: imports only,
// so an app can copy it. Two modes, same functions, same errors:
// - HUB_DATA_SOCKET + HUB_DATA_TOKEN set: talks to the hub's data API (the encrypted vault) over a Unix socket.
// - otherwise: plain files under HUB_DATA_DIR (or ./data), for an app that runs alone. Writes are atomic
//   (.part, fsync, rename); ifMatch uses a sha256 id; watch() sees only changes made through this process.
// Paths are app-relative: "notes/a.md". Errors carry fs-style codes (ENOENT, EEXIST, ENOTEMPTY, EISDIR, ENOTDIR,
// EFBIG, EINVAL, EACCES, EIO) plus ELOCKED (vault locked) and ECONFLICT (ifMatch failed); err.hubCode keeps the
// original code. Differences from node:fs are listed in docs/VAULT-DESIGN.md 8.1.

import http from 'node:http';
import fsp from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';

const FS_CODE = { NOT_FOUND: 'ENOENT', EXISTS: 'EEXIST', CASE_CLASH: 'EEXIST', CONFLICT: 'ECONFLICT', IS_DIR: 'EISDIR',
  NOT_DIR: 'ENOTDIR', BAD_PATH: 'EINVAL', BAD_INPUT: 'EINVAL', TOO_BIG: 'EFBIG', LOCKED: 'ELOCKED',
  UNAUTHORIZED: 'EACCES', ORIGIN: 'EACCES', NOT_EMPTY: 'ENOTEMPTY' };
const MAX_FILE = 32 * 1024 * 1024;
const BAD_CHARS = /[<>:"\\|?*\u0000-\u001f\u007f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** An fs-style error. */
function hubError(hubCode, message, status) {
  const e = new Error(message);
  e.code = FS_CODE[hubCode] || 'EIO';
  e.hubCode = hubCode;
  if (status) e.status = status;
  return e;
}

/** Same path rules as the hub (app-relative, no "..", no backslash, short names). */
export function checkAppPath(p) {
  const ok = typeof p === 'string' && p !== '' && p.length <= 200 && !p.startsWith('/')
    && p.split('/').every((s) => s.length > 0 && s.length <= 120 && s !== '.' && s !== '..' && !BAD_CHARS.test(s)
      && !/[ .]$/.test(s) && !WIN_RESERVED.test(s));
  if (!ok) throw hubError('BAD_PATH', 'That is not a valid path.');
  return p;
}
const isRoot = (p) => p === undefined || p === '' || p === '.';
const toBuf = (data, enc) => (Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data, enc || 'utf8')
  : data instanceof Uint8Array ? Buffer.from(data) : (() => { throw hubError('BAD_INPUT', 'Data must be a Buffer or text.'); })());
const encOf = (o) => (typeof o === 'string' ? o : o?.encoding);
const statObj = (e) => ({ path: e.path, size: e.size ?? 0, id: e.id ?? null, mtimeMs: e.mtime,
  isFile: () => e.kind === 'f', isDirectory: () => e.kind === 'd' });
const direntObj = (name, kind) => ({ name, isFile: () => kind === 'f', isDirectory: () => kind === 'd' });

/** The functions both modes share, built on six primitives (p: tree, stat, read, write, mkdirp, move, remove). */
function common(p) {
  const api = {
    async readFile(path, o) {
      const b = await p.read(checkAppPath(path));
      const enc = encOf(o);
      return enc ? b.toString(enc) : b;
    },
    async writeFile(path, data, o = {}) {
      const buf = toBuf(data, encOf(o));
      if (buf.length > MAX_FILE) throw hubError('TOO_BIG', 'The file is too big.');
      return p.write(checkAppPath(path), buf, o.ifMatch === 'none' ? null : o.ifMatch); // 'none' or null: must not exist
    },
    async stat(path) { return statObj(await p.stat(checkAppPath(path))); },
    async readdir(path, o = {}) {
      const base = isRoot(path) ? '' : checkAppPath(path);
      if (base && (await p.stat(base)).kind !== 'd') throw hubError('NOT_DIR', 'That is not a folder.');
      const kids = (await p.tree(base)).filter((e) => !e.path.slice(base ? base.length + 1 : 0).includes('/'));
      return kids.map((e) => {
        const name = e.path.slice(base ? base.length + 1 : 0);
        return o.withFileTypes ? direntObj(name, e.kind) : name;
      });
    },
    async mkdir(path, o = {}) {
      checkAppPath(path);
      if (!o.recursive) {
        const exists = await p.stat(path).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
        if (exists) throw hubError('EXISTS', 'It exists already.');
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent && (await p.stat(parent)).kind !== 'd') throw hubError('NOT_DIR', 'That is not a folder.');
      }
      await p.mkdirp(path);
    },
    async rename(from, to) { await p.move(checkAppPath(from), checkAppPath(to)); },
    async rm(path, o = {}) {
      let e;
      try { e = await p.stat(checkAppPath(path)); } catch (err) { if (err.code === 'ENOENT' && o.force) return; throw err; }
      if (e.kind === 'd' && !o.recursive && (await p.tree(path)).length) throw hubError('NOT_EMPTY', 'The folder is not empty.');
      await p.remove(path);
    },
    async tree(prefix) { return p.tree(isRoot(prefix) ? '' : checkAppPath(prefix)); },
    watch: p.watch,
  };
  api.promises = api;
  return api;
}

// ---- socket mode ----

function socketPrimitives(socketPath, token) {
  const tok = typeof token === 'function' ? token : () => token;
  const call = (method, route, { json, body, query = '', headers = {} } = {}) => new Promise((ok, fail) => {
    const payload = body ?? (json ? Buffer.from(JSON.stringify(json)) : null);
    const req = http.request({ socketPath, method, path: `/v1/${route}${query}`, agent: false,
      headers: { authorization: `Bearer ${tok()}`, ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        if (res.statusCode === 200) { ok({ buf, headers: res.headers }); return; }
        let j = {};
        try { j = JSON.parse(buf.toString('utf8')); } catch { j = {}; }
        fail(hubError(j.code || 'ERROR', j.message || `The hub answered ${res.statusCode}.`, res.statusCode));
      });
      res.on('error', (e) => fail(hubError('IO', e.message)));
    });
    req.on('error', (e) => fail(hubError('IO', `The hub cannot be reached (${e.code || 'error'}).`)));
    req.end(payload ?? undefined);
  });
  const j = async (route, json) => JSON.parse((await call('POST', route, { json })).buf.toString('utf8'));
  return {
    tree: async (prefix) => (await j('tree', { path: prefix })).entries,
    stat: (path) => j('stat', { path }),
    read: async (path) => (await call('POST', 'read', { json: { path } })).buf,
    write: async (path, buf, ifMatch) => JSON.parse((await call('PUT', 'write', { body: buf, query: `?path=${encodeURIComponent(path)}`,
      headers: ifMatch === undefined ? {} : { 'x-hub-if-match': ifMatch === null ? 'none' : ifMatch } })).buf.toString('utf8')),
    mkdirp: (path) => j('mkdir', { path }),
    move: (from, to) => j('move', { from, to }),
    remove: (path) => j('remove', { paths: [path] }),
    /** Changes as an async iterator: {seq, kind, path, id?, from?}, or {kind: 'lost'} (list again). Reconnects. */
    async *watch(o = {}) {
      let since = o.since ?? null; // null: start from now
      for (;;) {
        if (o.signal?.aborted) return;
        let r;
        try {
          r = JSON.parse((await call('GET', 'events', { query: since === null ? '' : `?since=${since}` })).buf.toString('utf8'));
        } catch (e) {
          if (e.hubCode === 'UNAUTHORIZED' || e.hubCode === 'LOCKED') throw e; // anything else: the hub is away, retry
          await new Promise((res) => setTimeout(res, o.retryMs ?? 1000));
          continue;
        }
        if (r.lost) yield { kind: 'lost', seq: r.seq };
        for (const ev of r.events) yield ev;
        since = r.seq;
      }
    },
  };
}

// ---- plain-file mode ----

function filePrimitives(root) {
  const abs = (p) => join(root, ...p.split('/'));
  const listeners = new Set();
  let seq = 0;
  const emit = (ev) => { const e = { seq: ++seq, ...ev }; for (const l of listeners) l(e); };
  const io = (e) => {
    const map = { ENOENT: 'NOT_FOUND', EEXIST: 'EXISTS', EISDIR: 'IS_DIR', ENOTDIR: 'NOT_DIR', ENOTEMPTY: 'NOT_EMPTY' };
    return map[e.code] ? hubError(map[e.code], 'File operation failed.') : e.hubCode ? e : hubError('IO', 'File operation failed.');
  };
  const idOf = (buf) => createHash('sha256').update(buf).digest('base64url');
  const entry = async (p) => {
    const st = await fsp.stat(abs(p)).catch((e) => { throw io(e); });
    if (st.isDirectory()) return { path: p, kind: 'd', mtime: st.mtimeMs };
    return { path: p, kind: 'f', size: st.size, mtime: st.mtimeMs, id: idOf(await fsp.readFile(abs(p))) };
  };
  async function walk(base, out) {
    const items = await fsp.readdir(base ? abs(base) : root, { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT' && !base) return []; throw io(e); });
    for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (it.name.endsWith('.part')) continue;
      const p = base ? `${base}/${it.name}` : it.name;
      out.push(await entry(p));
      if (it.isDirectory()) await walk(p, out);
    }
    return out;
  }
  const exists = (p) => fsp.lstat(abs(p)).then(() => true, () => false);
  return {
    tree: async (prefix) => {
      if (prefix && (await entry(prefix)).kind !== 'd') throw hubError('NOT_DIR', 'That is not a folder.');
      return (await walk(prefix, [])).sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    stat: entry,
    read: async (p) => {
      if ((await entry(p)).kind === 'd') throw hubError('IS_DIR', 'That is a folder.');
      return fsp.readFile(abs(p)).catch((e) => { throw io(e); });
    },
    async write(p, buf, ifMatch) {
      const cur = await entry(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
      if (cur?.kind === 'd') throw hubError('IS_DIR', 'That is a folder.');
      if (ifMatch !== undefined && (ifMatch === null ? cur !== null : cur?.id !== ifMatch)) throw hubError('CONFLICT', 'It was changed meanwhile.');
      await fsp.mkdir(dirname(abs(p)), { recursive: true }).catch((e) => { throw io(e); });
      const part = `${abs(p)}.${randomBytes(6).toString('hex')}.part`;
      const fh = await fsp.open(part, 'wx');
      try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(part, abs(p));
      const id = idOf(buf);
      emit({ kind: 'write', path: p, id });
      return { id, size: buf.length };
    },
    async mkdirp(p) {
      if (await exists(p) && (await entry(p)).kind !== 'd') throw hubError('EXISTS', 'A file with that name exists.');
      await fsp.mkdir(abs(p), { recursive: true }).catch((e) => { throw io(e); });
      emit({ kind: 'mkdir', path: p });
      return {};
    },
    async move(from, to) {
      await entry(from);
      if (from === to) return {};
      if (to.startsWith(`${from}/`)) throw hubError('BAD_PATH', 'A folder cannot move into itself.');
      if (await exists(to)) throw hubError('EXISTS', 'Something with that name exists.');
      await fsp.mkdir(dirname(abs(to)), { recursive: true });
      await fsp.rename(abs(from), abs(to)).catch((e) => { throw io(e); });
      emit({ kind: 'move', path: to, from });
      return {};
    },
    async remove(p) {
      await entry(p);
      await fsp.rm(abs(p), { recursive: true }).catch((e) => { throw io(e); });
      emit({ kind: 'remove', path: p });
      return {};
    },
    async *watch(o = {}) {
      const queue = [];
      let wake = null;
      const l = (e) => { queue.push(e); wake?.(); };
      listeners.add(l);
      try {
        for (;;) {
          if (o.signal?.aborted) return;
          if (!queue.length) await new Promise((res) => { wake = res; o.signal?.addEventListener('abort', res, { once: true }); });
          wake = null;
          while (queue.length) yield queue.shift();
        }
      } finally { listeners.delete(l); }
    },
  };
}

/**
 * A hubfs for given settings (tests, or several vaults). Default: from the environment.
 * @param {{socket?: string, token?: string|(() => string), dir?: string}} [o]  token: a function is asked each request
 */
export function createHubFs(o = {}) {
  const socket = o.socket ?? process.env.HUB_DATA_SOCKET;
  const token = o.token ?? process.env.HUB_DATA_TOKEN;
  if (socket && token) return { mode: 'hub', ...common(socketPrimitives(socket, token)) };
  return { mode: 'files', ...common(filePrimitives(resolve(o.dir ?? process.env.HUB_DATA_DIR ?? './data'))) };
}

let dflt = null;
const d = () => (dflt ??= createHubFs());
export const readFile = (...a) => d().readFile(...a);
export const writeFile = (...a) => d().writeFile(...a);
export const readdir = (...a) => d().readdir(...a);
export const rename = (...a) => d().rename(...a);
export const mkdir = (...a) => d().mkdir(...a);
export const rm = (...a) => d().rm(...a);
export const stat = (...a) => d().stat(...a);
export const tree = (...a) => d().tree(...a);
export const watch = (...a) => d().watch(...a);
