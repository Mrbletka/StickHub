// Test helpers: temp app folders and small HTTP calls.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { request } from 'node:http';

/**
 * Create a temp root with apps/<id>/<file> from a spec: { "app-id": { "app.json": {...}, "server.mjs": "..." } }.
 * Objects are written as JSON. Returns { root, appsDir, dataDir, cleanup }.
 */
export async function makeApps(spec) {
  const root = await mkdtemp(join(tmpdir(), 'stickhub-test-'));
  for (const [id, files] of Object.entries(spec)) {
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, 'apps', id, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  return { root, appsDir: join(root, 'apps'), dataDir: join(root, 'data'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A node-server app that listens on PORT and logs one line. */
export const GOOD_SERVER = `
import { createServer } from 'node:http';
const s = createServer((q, r) => r.end('hello ' + process.env.HUB_APP_ID + ' ' + process.env.HUB_DATA_DIR));
s.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('up on ' + process.env.PORT));
process.on('SIGTERM', () => s.close(() => process.exit(0)));
`;

/**
 * HTTP request to 127.0.0.1:port. Resolves { status, headers, body }.
 * @param {number} port
 * @param {string} path
 * @param {{method?: string, headers?: object, body?: string}} [opts]
 */
export function http(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method || 'GET',
      headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
