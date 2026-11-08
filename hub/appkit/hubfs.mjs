// hubfs: file functions for StickHub apps, shaped like node:fs/promises (design 8.1). One file, node: imports only,
// so an app can copy it. Two modes, same functions, same errors:
// - HUB_DATA_SOCKET + HUB_DATA_TOKEN set: talks to the hub's data API (the encrypted vault) over a Unix socket.
// - otherwise: plain files under HUB_DATA_DIR (or ./data), for an app that runs alone. Writes are atomic
//   (.part, fsync, rename); ifMatch uses a sha256 id that stat() reads the file for (tree() entries carry no id,
//   readdir() never reads a file); watch() sees only changes made through this process.
// Paths are app-relative: "notes/a.md". Errors carry fs-style codes (ENOENT, EEXIST, ENOTEMPTY, EISDIR, ENOTDIR,
// EFBIG, EINVAL, EACCES, EIO) plus ELOCKED (vault locked) and ECONFLICT (ifMatch failed); err.hubCode keeps the
// original code. Differences from node:fs are listed in hub/dataapi/README.md.

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

/** Depth for tree(): undefined = everything below, 1 = direct children only, ... */
function depthOf(d) {
  if (d === undefined) return undefined;
  if (!Number.isSafeInteger(d) || d < 1 || d > 64) throw hubError('BAD_INPUT', 'depth must be a whole number from 1 to 64.');
  return d;
}

/** The functions both modes share, built on primitives (p: tree, list, stat, read, write, mkdirp, move, remove, watch). */
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
    /** One folder, not what is below it: a single request (hub) or a single directory read (plain files). */
    async readdir(path, o = {}) {
      const kids = await p.list(isRoot(path) ? '' : checkAppPath(path));
      return kids.map((e) => (o.withFileTypes ? direntObj(e.name, e.kind) : e.name));
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
      if (e.kind === 'd' && !o.recursive && (await p.list(path)).length) throw hubError('NOT_EMPTY', 'The folder is not empty.');
      await p.remove(path);
    },
    /** Everything under a folder ({depth: 1}: its direct children). Plain-file mode: entries have no id (see stat). */
    async tree(prefix, o = {}) { return p.tree(isRoot(prefix) ? '' : checkAppPath(prefix), depthOf(o.depth)); },
    watch: p.watch,
  };
  api.promises = api;
  return api;
}

// ---- socket mode ----

/**
 * At most `max` calls at once; the rest wait in the order they came (the hub closes connections above its limit).
 * A call with keys (the paths a change touches) also waits while an earlier call with one of those keys runs or
 * waits, so changes to one path reach the hub in the order they were made.
 */
function limiter(max) {
  const queue = [];
  const busy = new Map(); // key -> running calls
  let running = 0;
  const pump = () => {
    const held = new Set(); // keys of earlier calls that still wait
    for (let i = 0; i < queue.length && running < max;) {
      const it = queue[i];
      if (it.keys.some((k) => busy.has(k) || held.has(k))) { for (const k of it.keys) held.add(k); i++; continue; }
      queue.splice(i, 1);
      running++;
      for (const k of it.keys) busy.set(k, (busy.get(k) || 0) + 1);
      it.fn().then(it.ok, it.fail).finally(() => {
        running--;
        for (const k of it.keys) { const n = busy.get(k) - 1; if (n) busy.set(k, n); else busy.delete(k); }
        pump();
      });
    }
  };
  return (keys, fn) => new Promise((ok, fail) => { queue.push({ keys, fn, ok, fail }); pump(); });
}

function socketPrimitives(socketPath, token, o = {}) {
  const tok = typeof token === 'function' ? token : () => token;
  const timeoutMs = o.timeoutMs ?? 60_000;
  const limit = limiter(o.maxInFlight ?? 8);
  // One request on its own connection. Every request ends within timeoutMs: a stalled one fails with EIO
  // (hubCode TIMEOUT) and frees its place. A write that timed out may still have landed.
  const send = (method, route, { json, body, query = '', headers = {}, signal } = {}) => new Promise((ok, fail) => {
    const payload = body ?? (json ? Buffer.from(JSON.stringify(json)) : null);
    const req = http.request({ socketPath, method, path: `/v1/${route}${query}`, agent: false,
      headers: { authorization: `Bearer ${tok()}`, ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (b) => parts.push(b));
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(parts);
        if (res.statusCode === 200) { ok({ buf, headers: res.headers }); return; }
        let j = {};
        try { j = JSON.parse(buf.toString('utf8')); } catch { j = {}; }
        fail(hubError(j.code || 'ERROR', j.message || `The hub answered ${res.statusCode}.`, res.statusCode));
      });
      res.on('error', (e) => { clearTimeout(timer); fail(hubError('IO', e.message)); });
      res.on('close', () => { clearTimeout(timer); if (!res.complete) fail(hubError('IO', 'The hub closed the connection.')); });
    });
    const timer = setTimeout(() => { req.destroy(); fail(hubError('TIMEOUT', 'The hub did not answer in time.')); }, timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); fail(hubError('IO', `The hub cannot be reached (${e.code || 'error'}).`)); });
    signal?.addEventListener('abort', () => req.destroy(), { once: true }); // a stopped watch ends its long poll at once
    req.end(payload ?? undefined);
  });
  const call = (method, route, o2 = {}) => limit(o2.keys || [], () => send(method, route, o2));
  const j = async (route, json, keys) => JSON.parse((await call('POST', route, { json, keys })).buf.toString('utf8'));
  return {
    tree: async (prefix, depth) => (await j('tree', { path: prefix, ...(depth ? { depth } : {}) })).entries,
    list: async (base) => (await j('tree', { path: base, depth: 1 })).entries.map((e) => ({ name: e.path.slice(base ? base.length + 1 : 0), kind: e.kind })),
    stat: (path) => j('stat', { path }),
    read: async (path) => (await call('POST', 'read', { json: { path } })).buf,
    write: async (path, buf, ifMatch) => JSON.parse((await call('PUT', 'write', { keys: [path], body: buf, query: `?path=${encodeURIComponent(path)}`,
      headers: ifMatch === undefined ? {} : { 'x-hub-if-match': ifMatch === null ? 'none' : ifMatch } })).buf.toString('utf8')),
    mkdirp: (path) => j('mkdir', { path }, [path]),
    move: (from, to) => j('move', { from, to }, [from, to]),
    remove: (path) => j('remove', { paths: [path] }, [path]),
    /** Changes as an async iterator: {seq, kind, path, id?, from?}, or {kind: 'lost'} (list again). Reconnects. */
    async *watch(o = {}) {
      let since = o.since ?? null; // null: start from now
      for (;;) {
        if (o.signal?.aborted) return;
        let r;
        try {
          // the long poll has its own connection, outside the limit: a watch must never hold back reads and writes
          r = JSON.parse((await send('GET', 'events', { query: since === null ? '' : `?since=${since}`, signal: o.signal })).buf.toString('utf8'));
        } catch (e) {
          if (o.signal?.aborted) return;
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
  /** A link anywhere on the way is refused (EINVAL): links are never followed out of the data folder. */
  async function noLinks(p) {
    let cur = root;
    for (const seg of p.split('/')) {
      cur = join(cur, seg);
      let st;
      try { st = await fsp.lstat(cur); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw io(e); }
      if (st.isSymbolicLink()) throw hubError('BAD_PATH', 'Links are not followed.');
    }
  }
  // lmeta: from lstat only, never reads the file (for names a directory read gave). meta: lmeta after the link check.
  // entry: meta plus the content id (reads the file).
  const lmeta = async (p) => {
    const st = await fsp.lstat(abs(p)).catch((e) => { throw io(e); });
    if (st.isDirectory()) return { path: p, kind: 'd', mtime: st.mtimeMs };
    if (!st.isFile()) throw hubError('NOT_FOUND', 'File operation failed.'); // a link or a device: not part of the data
    return { path: p, kind: 'f', size: st.size, mtime: st.mtimeMs };
  };
  const meta = async (p) => { await noLinks(p); return lmeta(p); };
  const entry = async (p) => {
    const m = await meta(p);
    return m.kind === 'd' ? m : { ...m, id: idOf(await fsp.readFile(abs(p)).catch((e) => { throw io(e); })) };
  };
  const kindOf = (d) => (d.isDirectory() ? 'd' : d.isFile() ? 'f' : null); // links and others are left out
  /** One directory read: [{name, kind}], sorted by name; *.part files and links are left out. */
  async function listRaw(base) {
    let items;
    try { items = await fsp.readdir(base ? abs(base) : root, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT' && !base) return []; // nothing saved yet
      throw io(e);
    }
    return items.filter((it) => kindOf(it) && !it.name.endsWith('.part')).map((it) => ({ name: it.name, kind: kindOf(it) }))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
  }
  const list = async (base) => { if (base) await noLinks(base); return listRaw(base); };
  async function walk(base, depth, out) {
    for (const it of await listRaw(base)) {
      const p = base ? `${base}/${it.name}` : it.name;
      out.push(await lmeta(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })); // gone meanwhile: skip
      if (it.kind === 'd' && (depth === undefined || depth > 1)) await walk(p, depth && depth - 1, out);
    }
    return out;
  }
  const exists = (p) => fsp.lstat(abs(p)).then(() => true, () => false);
  return {
    tree: async (prefix, depth) => {
      if (prefix) await noLinks(prefix);
      return (await walk(prefix, depth, [])).filter(Boolean).sort((x, y) => (x.path < y.path ? -1 : 1));
    },
    list,
    stat: entry,
    read: async (p) => {
      if ((await meta(p)).kind === 'd') throw hubError('IS_DIR', 'That is a folder.');
      return fsp.readFile(abs(p)).catch((e) => { throw io(e); });
    },
    async write(p, buf, ifMatch) {
      const cur = await (typeof ifMatch === 'string' ? entry : meta)(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
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
      await noLinks(p);
      if (await exists(p) && (await meta(p)).kind !== 'd') throw hubError('EXISTS', 'A file with that name exists.');
      await fsp.mkdir(abs(p), { recursive: true }).catch((e) => { throw io(e); });
      emit({ kind: 'mkdir', path: p });
      return {};
    },
    async move(from, to) {
      await meta(from);
      await noLinks(to);
      if (from === to) return {};
      if (to.startsWith(`${from}/`)) throw hubError('BAD_PATH', 'A folder cannot move into itself.');
      if (await exists(to)) throw hubError('EXISTS', 'Something with that name exists.');
      await fsp.mkdir(dirname(abs(to)), { recursive: true });
      await fsp.rename(abs(from), abs(to)).catch((e) => { throw io(e); });
      emit({ kind: 'move', path: to, from });
      return {};
    },
    async remove(p) {
      await meta(p);
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
 * @param {{socket?: string, token?: string|(() => string), dir?: string, maxInFlight?: number, timeoutMs?: number}} [o]
 *   token: a function is asked each request; maxInFlight: requests at once (8, the rest wait in order);
 *   timeoutMs: the longest a request may take (60 s)
 */
export function createHubFs(o = {}) {
  const socket = o.socket ?? process.env.HUB_DATA_SOCKET;
  const token = o.token ?? process.env.HUB_DATA_TOKEN;
  if (socket && token) return { mode: 'hub', ...common(socketPrimitives(socket, token, o)) };
  return { mode: 'files', ...common(filePrimitives(resolve(o.dir ?? process.env.HUB_DATA_DIR ?? './data'))) };
}

// ---- for the app's own web server: the hub's page routes (design 8.5) ----

/** This app process's start id (new at every start). */
export const START_ID = randomBytes(9).toString('base64url');

/**
 * Answer the hub's page routes; call it first in the app's request handler: `if (hubRoutes(req, res)) return;`
 * - GET /__hub/clear: `Clear-Site-Data: "storage"`, so Chrome drops this app's localStorage, IndexedDB and the rest.
 *   The hub page loads it in a hidden frame before the hub stops the app (and, from job 4, on lock).
 * - GET /__hub/start: {startId}. The app page keeps its UI state next to it and drops the state when it changed
 *   (an app that crashed never got the clear).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} [startId]  default: START_ID of this process
 * @returns {boolean} true when it answered
 */
export function hubRoutes(req, res, startId = START_ID) {
  const path = (req.url || '').split('?')[0];
  if (req.method !== 'GET' || (path !== '/__hub/clear' && path !== '/__hub/start')) return false;
  const clear = path === '/__hub/clear';
  const body = clear ? '<!doctype html><title>cleared</title>' : JSON.stringify({ startId });
  res.writeHead(200, { 'content-type': clear ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body), ...(clear ? { 'clear-site-data': '"storage"' } : {}) });
  res.end(body);
  return true;
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
