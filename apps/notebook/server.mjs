// Notebook: StickHub app (engine node-server). Notes are files under "vault/" in the app's data, kept through
// lib/hubfs.mjs: the hub's encrypted vault when the hub gives a data socket, plain files otherwise.
// Runs on its own too, from this folder:  PORT=4110 node server.mjs   (then the notes are ./data/vault)
// App rules: listen on process.env.PORT at 127.0.0.1, data only through hubfs, stop cleanly on SIGTERM.
// Security: checks Host, Origin on every write and Sec-Fetch-Site; no CORS headers; every path stays in the vault.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { Vault, VaultError, MAX_NOTE } from './lib/vault.mjs';
import { Changes } from './lib/changes.mjs';
import { createHubFs } from './lib/hubfs.mjs';

const PORT = Number(process.env.PORT) || 4110;
const PUBLIC = join(import.meta.dirname, 'public');
const MAX_BODY = MAX_NOTE + 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
// The page may only load its own files; the hub (port 8787) may show it in its player.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:8787 http://localhost:8787";

/**
 * Build the request handler (tests create their own server with it).
 * @param {Vault} vault
 * @param {() => number} port  the port we listen on (for the Host and Origin checks)
 * @param {Changes} [changes]  note changes for "changed somewhere else" (GET /api/changes)
 */
export function createHandler(vault, port, changes) {
  return async (req, res) => {
    try {
      const p = port();
      const hosts = [`127.0.0.1:${p}`, `localhost:${p}`];
      if (!hosts.includes(req.headers.host || '')) return send(res, 421, { error: 'Wrong host.' });
      const url = new URL(req.url || '/', 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'Cross-site request refused.' });
        if (req.method !== 'GET' && !hosts.some((h) => req.headers.origin === `http://${h}`)) return send(res, 403, { error: 'Wrong origin.' });
        return await api(vault, req, res, url, changes);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
      return await serveFile(res, url.pathname);
    } catch (e) {
      if (e instanceof VaultError) return send(res, e.status, { error: e.message, ...(e.version !== undefined ? { version: e.version } : {}) });
      if (e instanceof SyntaxError) return send(res, 400, { error: 'Bad JSON.' });
      if (e.status === 413) return send(res, 413, { error: 'Too big.' });
      console.error(`${req.method} ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Server error. See the app log in the hub.' });
      else res.destroy();
    }
  };
}

async function api(vault, req, res, url, changes) {
  const q = (k) => url.searchParams.get(k) ?? '';
  const r = `${req.method} ${url.pathname}`;
  if (r === 'GET /api/changes' && changes) return send(res, 200, await changes.wait(q('cursor')));
  if (r === 'GET /api/list') return send(res, 200, { path: q('path'), entries: await vault.list(q('path')) });
  if (r === 'GET /api/index') return send(res, 200, await vault.index());
  if (r === 'GET /api/note') return send(res, 200, await vault.read(q('path')));
  if (r === 'GET /api/stat') return send(res, 200, await vault.stat(q('path')));
  if (r === 'GET /api/deleted') return send(res, 200, await vault.listDeleted());
  if (req.method !== 'POST' && req.method !== 'PUT') return send(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? 'Not found.' : 'Method not allowed.' });
  const b = JSON.parse(await readBody(req));
  if (!b || typeof b !== 'object') throw new VaultError(400, 'Bad request.');
  const list = (v) => { if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== 'string')) throw new VaultError(400, 'paths: a list of paths'); return v; };
  if (r === 'PUT /api/note') return send(res, 200, await vault.write(b.path, b.content, b.base ?? undefined, b.force === true));
  if (r === 'POST /api/create') return send(res, 200, await vault.create(b.dir ?? '', b.name, b.type));
  if (r === 'POST /api/rename') return send(res, 200, await vault.rename(b.path, b.name));
  if (r === 'POST /api/move') return send(res, 200, await vault.move(list(b.paths), b.to ?? ''));
  if (r === 'POST /api/duplicate') return send(res, 200, await vault.duplicate(b.path));
  if (r === 'POST /api/delete') return send(res, 200, await vault.remove(list(b.paths)));
  if (r === 'POST /api/restore') return send(res, 200, await vault.restore(b.id));
  if (r === 'POST /api/empty-deleted') return send(res, 200, await vault.emptyDeleted());
  return send(res, 404, { error: 'Not found.' });
}

/** Serve a file from public/: no "..", no links, only known types. */
async function serveFile(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath); } catch { return send(res, 400, { error: 'Bad path.' }); }
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0'))) return send(res, 400, { error: 'Bad path.' });
  const file = join(PUBLIC, ...segs);
  if (!file.startsWith(PUBLIC + sep)) return send(res, 400, { error: 'Bad path.' });
  const st = await lstat(file).catch(() => null);
  const type = TYPES[extname(file).toLowerCase()];
  if (!st?.isFile() || !type) return send(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}) });
  createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function main() {
  const fs = createHubFs();
  const vault = new Vault(fs);
  const changes = new Changes(fs);
  changes.start();
  const server = createServer(createHandler(vault, () => server.address().port, changes));
  // No folder, socket or token in the log: only which kind of storage.
  server.listen(PORT, '127.0.0.1', () => console.log(`Notebook on http://127.0.0.1:${PORT}/ (notes: ${fs.mode === 'hub' ? 'the hub vault' : 'plain files'})`));
  // The hub stops apps with SIGTERM (then SIGKILL after 3 s). Writes are atomic, so stopping mid-save is safe.
  process.on('SIGTERM', () => {
    changes.stop();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// Run only when started directly (tests import createHandler). Compare real paths: the hub passes an absolute path.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
