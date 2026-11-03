// Static file serving for the hub UI and the `static` engine.
// Correct MIME types, ETag, Range requests, no path traversal, optional SPA fallback.

import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

/** MIME type for a file name (application/octet-stream when unknown). */
export function mimeType(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Map a URL path to a file inside root, or null if it would leave root.
 * Decodes %xx, rejects NUL and backslashes, and resolves "." / ".." segments before checking.
 * @param {string} root  absolute folder
 * @param {string} urlPath  path part of the URL, e.g. "/img/a.png"
 */
export function resolveInside(root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return join(root, ...parts);
}

/**
 * Parse a single "bytes=a-b" range. Multi-range requests are answered with the whole file.
 * @returns {{start: number, end: number}|null|'invalid'} null = no (usable) range header
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } // suffix: last N bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Serve a file from root for this request. Handles GET and HEAD only.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root  absolute folder to serve
 * @param {{spa?: boolean, urlPath?: string, cache?: string}} [opts]
 *   spa: unknown paths without a file extension get index.html; urlPath: path to use instead of req.url;
 *   cache: Cache-Control value (default "no-cache": always revalidate with the ETag)
 */
export async function serveStatic(req, res, root, opts = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
  const urlPath = opts.urlPath ?? new URL(req.url || '/', 'http://x').pathname;
  let file = resolveInside(root, urlPath);
  if (!file) return send(res, 400, 'Bad path');

  let st = await statOrNull(file);
  if (st?.isDirectory()) { file = join(file, 'index.html'); st = await statOrNull(file); }
  if (!st && opts.spa && !extname(urlPath)) { file = join(root, 'index.html'); st = await statOrNull(file); }
  if (!st || !st.isFile()) return send(res, 404, 'Not found');

  // A symlink inside root may point outside it: check the real location too.
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return send(res, 403, 'Forbidden');
  } catch (e) {
    return send(res, 404, 'Not found');
  }

  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    'content-type': mimeType(file), 'accept-ranges': 'bytes', etag,
    'cache-control': opts.cache || 'no-cache', 'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

  const range = parseRange(req.headers.range, st.size);
  if (range === 'invalid') return send(res, 416, 'Range not satisfiable', { 'content-range': `bytes */${st.size}` });
  const { start, end } = range || { start: 0, end: st.size - 1 };
  const length = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...headers, 'content-length': length, ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
  });
  if (req.method === 'HEAD' || length === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', (e) => { res.destroy(e); });
  stream.pipe(res);
}

async function statOrNull(file) {
  try { return await stat(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ENAMETOOLONG') return null;
    throw e;
  }
}

/** Send a short plain-text response. */
export function send(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}
