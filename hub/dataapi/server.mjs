// The data API server (design 8.1): HTTP over a Unix socket, one token per app, the vault store behind it.
// createDataApi({socketPath, getStore}) -> {issue, revoke, notify, close}. getStore() returns the open Store or null
// (locked: every route answers 423 after the token check). Every handler is wrapped: a store error or a bad request
// is an answer, never a crash. Tokens never appear in answers, errors or events.

import http from 'node:http';
import net from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiError } from './paths.mjs';
import { Tokens } from './tokens.mjs';
import { EventLog } from './events.mjs';
import { routes, eventsRoute } from './routes.mjs';
import { errorAnswer } from './errors.mjs';

/** Limits (design 8.1). Tests may lower the times. */
export const LIMITS = Object.freeze({
  socketPath: 107, headerBytes: 16 * 1024, bodyBytes: 32 * 1024 * 1024, jsonBytes: 1024 * 1024,
  treeEntries: 20_000, connections: 64, requestMs: 60_000, pollMs: 25_000, events: 1000,
});

/** A socket path that is too long for sun_path, or a folder we cannot use: a clear error, no crash. */
function checkSocketPath(p, max) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw Object.assign(new Error('Data API: the socket path must be absolute.'), { code: 'BAD_SOCKET_PATH' });
  if (Buffer.byteLength(p) > max) throw Object.assign(new Error(`Data API: the socket path is longer than ${max} bytes.`), { code: 'SOCKET_PATH_TOO_LONG' });
}

/** Remove a socket file left by a crash: only if it is a socket and nobody answers on it. */
async function removeStale(p) {
  let st;
  try { st = await lstat(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!st.isSocket()) throw Object.assign(new Error('Data API: something that is not a socket is in the way.'), { code: 'EEXIST' });
  const alive = await new Promise((resolve) => {
    const c = net.connect(p);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
  if (alive) throw Object.assign(new Error('Data API: another hub is answering on this socket.'), { code: 'EADDRINUSE' });
  await unlink(p);
}

/** The request body, at most max bytes (413 above). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > max) { reject(new ApiError(413, 'TOO_BIG', 'The request is too big.')); return; }
    const parts = [];
    let got = 0;
    req.on('data', (b) => {
      got += b.length;
      if (got > max) { req.pause(); reject(new ApiError(413, 'TOO_BIG', 'The request is too big.')); return; }
      parts.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* answered below */ }
  throw new ApiError(400, 'BAD_INPUT', 'The request body must be a JSON object.');
}

/**
 * @param {{socketPath: string, getStore: () => object|null, limits?: object}} o
 * @returns {Promise<{issue: (appId: string) => string, revoke: (appId: string) => void, revokeAll: () => void,
 *   notify: (vaultPath: string, kind: string, id?: string) => void, close: () => Promise<void>, socketPath: string}>}
 */
export async function createDataApi(o) {
  const L = { ...LIMITS, ...o.limits };
  checkSocketPath(o.socketPath, L.socketPath);
  const dir = dirname(o.socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await removeStale(o.socketPath);
  const tokens = new Tokens();
  const events = new EventLog(L.events);

  async function handle(req, res) {
    const send = (status, body, headers = {}) => {
      if (res.headersSent || res.destroyed) return;
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': buf.length, ...headers });
      res.end(buf);
    };
    try {
      if (req.headers.origin !== undefined) throw new ApiError(403, 'ORIGIN', 'Browsers may not use this API.');
      const appId = tokens.appFor(req.headers.authorization);
      if (!appId) throw new ApiError(401, 'UNAUTHORIZED', 'Not allowed.');
      const url = new URL(req.url, 'http://hub');
      const m = /^\/v1\/([a-z]+)$/.exec(url.pathname);
      const name = m?.[1];
      const isEvents = name === 'events' && req.method === 'GET';
      const isWrite = name === 'write' && req.method === 'PUT';
      const isJson = name && name !== 'write' && name !== 'events' && Object.hasOwn(routes, name) && req.method === 'POST';
      if (!isEvents && !isWrite && !isJson) throw new ApiError(404, 'NO_ROUTE', 'No such route.');
      const store = o.getStore();
      if (!store) throw new ApiError(423, 'LOCKED', 'The vault is locked.');
      const raw = isEvents ? Buffer.alloc(0) : await readBody(req, isWrite ? L.bodyBytes : L.jsonBytes);
      const c = { store, appId, body: isWrite ? raw : parseJson(raw), query: url.searchParams, headers: req.headers, events, limits: L };
      const out = isEvents ? await eventsRoute(c) : await routes[name](c);
      if (out.bytes) send(200, out.bytes, out.headers);
      else send(200, out.json);
    } catch (e) {
      const a = errorAnswer(e);
      send(a.status, a.body, a.status === 413 ? { connection: 'close' } : {});
    }
  }

  const server = http.createServer({ maxHeaderSize: L.headerBytes, requestTimeout: L.requestMs,
    headersTimeout: Math.min(L.requestMs, 20_000), connectionsCheckingInterval: Math.max(50, Math.min(30_000, L.requestMs / 2)) },
  (req, res) => { handle(req, res).catch(() => { res.destroy(); }); });
  server.maxConnections = L.connections;
  server.on('clientError', (err, sock) => { sock.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.socketPath, () => { server.off('error', reject); resolve(); }); });
  await chmod(o.socketPath, 0o600);
  let closed = false;

  return {
    socketPath: o.socketPath,
    issue: (appId) => tokens.issue(appId),
    revoke: (appId) => tokens.revoke(appId),
    /** On lock: every token stops working, open requests and long polls end, change events (paths) are forgotten. */
    revokeAll() {
      tokens.clear();
      events.clear();
      server.closeAllConnections();
    },
    /** A change made outside the API (sync, job 5): becomes an event of the app whose folder holds it. */
    notify(vaultPath, kind, id) {
      const i = typeof vaultPath === 'string' ? vaultPath.indexOf('/') : -1;
      if (i > 0) events.add(vaultPath.slice(0, i), { kind, path: vaultPath.slice(i + 1), ...(id ? { id } : {}) });
    },
    async close() {
      if (closed) return;
      closed = true;
      tokens.clear();
      events.wakeAll();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      await unlink(o.socketPath).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    },
  };
}
