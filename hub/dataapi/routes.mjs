// The data API routes (design 8.1). Each takes the open store, the app id and the parsed request, and returns
// {json} or {bytes}. App paths in and out; vault paths never leave this file.

import { ApiError, toVault, fromVault } from './paths.mjs';

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** ifMatch from JSON or a header: undefined = no check, 'none' = must not exist yet, else a content id. */
function ifMatchOf(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === 'none') return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ApiError(400, 'BAD_INPUT', 'ifMatch must be a content id or "none".');
  return v;
}

const entryOut = (appId, e) => ({ path: fromVault(appId, e.path), kind: e.kind, mtime: e.mtime,
  ...(e.kind === 'f' ? { size: e.size, id: e.id } : {}) });

const int = (v, what) => {
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(400, 'BAD_INPUT', `${what} must be a whole number.`);
  return v;
};

/**
 * @param {object} c  {store, appId, body (parsed JSON or Buffer), query: URLSearchParams, headers, events, limits}
 */
export const routes = {
  async tree(c) {
    const { store, appId, body } = c;
    const depth = int(body.depth, 'depth');
    if (depth === 0 || depth > 64) throw new ApiError(400, 'BAD_INPUT', 'depth must be a whole number from 1 to 64.');
    const base = body.path === undefined || body.path === '' ? appId : toVault(appId, body.path);
    let entries;
    try {
      entries = store.tree(base);
    } catch (e) {
      if (e.code === 'NOT_FOUND' && base === appId) entries = []; // the app has not saved anything yet
      else throw e;
    }
    // depth 1 = direct children only: a folder listing never sends what is below it
    if (depth) entries = entries.filter((e) => e.path.split('/').length - base.split('/').length <= depth);
    if (entries.length > c.limits.treeEntries) throw new ApiError(413, 'TOO_BIG', 'Too many entries: ask for a smaller folder.');
    return { json: { entries: entries.map((e) => entryOut(appId, e)) } };
  },

  async stat(c) { return { json: entryOut(c.appId, c.store.stat(toVault(c.appId, c.body.path))) }; },

  async read(c) {
    const p = toVault(c.appId, c.body.path);
    const e = c.store.stat(p);
    if (e.kind !== 'f') throw new ApiError(400, 'IS_DIR', 'That is a folder.');
    const start = int(c.body.start, 'start');
    const end = int(c.body.end, 'end');
    const data = await c.store.read(p, start === undefined && end === undefined ? {} : { start: start ?? 0, end: end ?? e.size });
    return { bytes: data, headers: { 'x-hub-id': e.id, 'x-hub-size': String(e.size) } };
  },

  async write(c) {
    const rel = c.query.get('path');
    const p = toVault(c.appId, rel);
    const r = await c.store.write(p, c.body, { ifMatch: ifMatchOf(c.headers['x-hub-if-match']) });
    c.events.add(c.appId, { kind: 'write', path: rel, id: r.id });
    return { json: { id: r.id, size: r.size } };
  },

  async mkdir(c) {
    await c.store.mkdir(toVault(c.appId, c.body.path));
    c.events.add(c.appId, { kind: 'mkdir', path: c.body.path });
    return { json: {} };
  },

  async move(c) {
    const { from, to } = c.body;
    await c.store.move(toVault(c.appId, from), toVault(c.appId, to), { ifMatch: ifMatchOf(c.body.ifMatch) });
    c.events.add(c.appId, { kind: 'move', path: to, from });
    return { json: {} };
  },

  async remove(c) {
    const { paths } = c.body;
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new ApiError(400, 'BAD_INPUT', 'Give 1 to 1000 paths.');
    await c.store.remove(paths.map((p) => toVault(c.appId, p)));
    for (const p of paths) c.events.add(c.appId, { kind: 'remove', path: p });
    return { json: {} };
  },
};

/** Long poll: GET /v1/events?since=N. */
export async function eventsRoute(c) {
  const s = c.query.get('since');
  let n;
  if (s !== null) {
    n = Number(s);
    if (!/^\d{1,15}$/.test(s) || !Number.isSafeInteger(n)) throw new ApiError(400, 'BAD_INPUT', 'since must be a whole number.');
  }
  return { json: await c.events.wait(c.appId, n, c.limits.pollMs) };
}
