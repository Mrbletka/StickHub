// StickHub server: UI + API on 127.0.0.1:8787, starts and stops the apps.
// Run: node hub/server.mjs

import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngines } from './engines.mjs';
import { ProcessManager } from './procman.mjs';
import { createApi, json } from './api.mjs';
import { serveStatic, send } from './static-files.mjs';
import { codeCommit } from './version.mjs';
import { StickService } from './sync/service.mjs';
import { loadToken, LoginCodes } from './auth.mjs';
import { stickhubHome } from './config.mjs';

export const HUB_PORT = 8787;
const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HUB_DIR);

/**
 * Build the hub (does not listen yet).
 * @param {{root?: string, appsDir?: string, dataDir?: string, port?: number,
 *   portRange?: {from: number, to: number}, startTimeoutMs?: number,
 *   stick?: {listVolumes?: Function, pollMs?: number, autoSync?: boolean, device?: string, git?: object},
 *   home?: string, shutdown?: () => void}} [opts]
 *   stick: options for the stick service (tests pass fakes); home: private folder (token, app PIDs)
 */
export async function createHub(opts = {}) {
  const root = opts.root || ROOT;
  const home = opts.home || stickhubHome();
  const token = await loadToken(home);
  const codes = new LoginCodes();
  const port = opts.port ?? HUB_PORT;
  const { engines, errors: engineErrors } = await loadEngines();
  const procman = new ProcessManager({
    engines, appsDir: opts.appsDir || join(root, 'apps'), dataDir: opts.dataDir || join(root, 'data'),
    portRange: opts.portRange, startTimeoutMs: opts.startTimeoutMs,
  });
  await procman.reload();
  const commit = await codeCommit(root).catch(() => null);
  const stick = new StickService({ root, procman, ...opts.stick });
  const status = () => ({ name: 'StickHub', commit, engines: [...engines.keys()], engineErrors, stick: stick.status() });
  const api = createApi({ procman, stick, status, token, codes, shutdown: () => opts.shutdown?.() });
  const uiDir = join(HUB_DIR, 'ui');

  const server = createServer(async (req, res) => {
    try {
      // A web page in the browser can send requests to 127.0.0.1. Only accept our own host name,
      // and for anything that changes state, only our own origin (or none, e.g. curl).
      const p = server.address()?.port;
      const allowed = [`127.0.0.1:${p}`, `localhost:${p}`];
      if (!allowed.includes(req.headers.host || '')) return send(res, 421, 'Wrong host');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !allowed.some((h) => origin === `http://${h}`)) return json(res, 403, { error: 'Wrong origin' });
        // Browsers also say where a request comes from; "none" = typed by the user, same-origin = our own UI.
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'Cross-site request refused' });
      }
      const path = new URL(req.url || '/', 'http://x').pathname;
      if (path.startsWith('/api/')) return await api.handle(req, res, path);
      return await serveStatic(req, res, uiDir);
    } catch (e) {
      console.error(`${req.method} ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, 500, { error: 'Server error. See the hub log.' });
      else res.destroy();
    }
  });

  return {
    server, procman, stick, token, codes, home,
    /** Start listening, then start watching for the stick. Rejects with EADDRINUSE when the port is taken. */
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        stick.start().catch((e) => console.error(`stick: ${e.message}`));
        resolve(`http://127.0.0.1:${server.address().port}/`);
      });
    }),
    /** Stop syncing, all apps and the server. */
    async close() {
      await stick.stop();
      await procman.stopAll();
      api.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

async function main() {
  let shutdown = () => {};
  const hub = await createHub({ port: Number(process.env.HUB_PORT) || HUB_PORT, shutdown: () => shutdown(0) });
  for (const e of hub.procman.list()) if (e.problems.length) console.warn(`app ${e.id}: ${e.problems.join('; ')}`);
  let url;
  try {
    url = await hub.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${HUB_PORT} is in use. Is the hub already running? Open http://127.0.0.1:${HUB_PORT}/`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`StickHub running: ${url}  (${hub.procman.list().length} apps, Ctrl+C to stop)`);

  let closing = false;
  shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    console.log('Stopping apps...');
    const force = setTimeout(() => { hub.procman.killAllNow(); process.exit(code); }, 8000);
    try { await hub.close(); } catch (e) { console.error(`shutdown: ${e.message}`); }
    clearTimeout(force);
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (e) => { console.error(e.stack || e); shutdown(1); });
  process.on('unhandledRejection', (e) => { console.error(e?.stack || e); shutdown(1); });
  // If the hub dies anyway, take the app processes with it (no orphans holding ports).
  process.on('exit', () => hub.procman.killAllNow());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
