// StickHub server: UI + API on 127.0.0.1:8787, starts and stops the apps.
// Run: node hub/server.mjs

import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngines } from './engines.mjs';
import { ProcessManager } from './procman.mjs';
import { createApi, json } from './api.mjs';
import { vaultRoutes } from './lock/routes.mjs';
import { serveStatic, send } from './static-files.mjs';
import { codeCommit } from './version.mjs';
import { StickService } from './sync/service.mjs';
import { loadToken, LoginCodes } from './auth.mjs';
import { stickhubHome, loadSettings, deviceId } from './config.mjs';
import { listVolumes } from './platform/termux.mjs';
import { createGit } from './platform/git.mjs';
import { findStick } from './stick.mjs';
import { LiveData } from './livedata.mjs';
import { PidFile, cleanupLeftovers } from './proc.mjs';
import { createDataApi } from './dataapi/server.mjs';
import { readPassphrase, EXIT_WRONG_PASSPHRASE } from './devvault.mjs';
import { VaultService } from './lock/service.mjs';

export const HUB_PORT = 8787;
const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HUB_DIR);

/**
 * Build the hub (does not listen yet).
 * @param {{root?: string, appsDir?: string, dataDir?: string, port?: number,
 *   portRange?: {from: number, to: number}, startTimeoutMs?: number,
 *   stick?: {listVolumes?: Function, pollMs?: number, autoSync?: boolean, device?: string, git?: object},
 *   home?: string, shutdown?: () => void, dataOnStick?: boolean | {listVolumes?: Function, pollMs?: number},
 *   vault?: {dir?: string, socketPath?: string, autoLockSeconds?: number, clock?: object, open?: Function, storeOpts?: object}}} [opts]
 *   stick: options for the stick service (tests pass fakes); home: private folder (token, app PIDs)
 *   dataOnStick: app data lives on the stick (HUB/data/<id>); the code still runs from here (see livedata.mjs)
 *   vault: the vault folder (default <home>/vault-dev) and test hooks. With a vault.json there the hub starts LOCKED:
 *   no app starts until the lock screen opens it; then apps with "data": "hubfs" get the data socket (default
 *   <home>/run/data.sock) and a token, and the plain data sync stays off. No vault.json: plain data, as before.
 */
export async function createHub(opts = {}) {
  const root = opts.root || ROOT;
  const home = opts.home || stickhubHome();
  const token = await loadToken(home);
  const codes = new LoginCodes();
  const port = opts.port ?? HUB_PORT;
  const { engines, errors: engineErrors } = await loadEngines();
  const pidPath = join(home, 'apps-running.json');
  // Apps left running by an earlier hub that was killed hard: stop them first (only if their command line matches).
  for (const line of await cleanupLeftovers(pidPath)) console.log(`leftover ${line}`);
  const vo = opts.vault || {};
  const service = await new VaultService({ dir: vo.dir || join(home, 'vault-dev'), home, clock: vo.clock, open: vo.open, storeOpts: vo.storeOpts,
    autoLockSeconds: vo.autoLockSeconds ?? opts.autoLockSeconds }).init();
  const vault = service.exists ? service : null; // no vault.json: plain data, no lock screen
  if (vault && opts.dataOnStick) {
    throw new Error(`There is a vault in ${service.dir} and data on the stick is on: they do not work together yet. `
      + 'Turn dataOnStick off in ~/.stickhub/settings.json (or start without --data-on-stick).');
  }
  const dataApi = vault ? await createDataApi({ socketPath: vo.socketPath || join(home, 'run', 'data.sock'), getStore: () => vault.store }) : null;
  const procman = new ProcessManager({
    engines, appsDir: opts.appsDir || join(root, 'apps'), dataDir: opts.dataDir || join(root, 'data'),
    portRange: opts.portRange, startTimeoutMs: opts.startTimeoutMs, pidFile: new PidFile(pidPath), dataApi,
    startBlock: vault ? () => (vault.unlocked ? null : 'The vault is locked. Unlock it on the hub page first.') : null,
  });
  await procman.reload();
  const commit = await codeCommit(root).catch(() => null);
  const dos = opts.dataOnStick ? (opts.dataOnStick === true ? {} : opts.dataOnStick) : null;
  // Data on the stick: the stick is the live storage, so the sync service only copies the code backup.
  // The vault: app data is in the vault, so the plain data sync stays away from data/ (vault sync is job 5).
  const stick = new StickService({ root, procman, ...opts.stick, ...(dos ? { autoSync: false, dataSync: false, dataSyncOff: 'data-on-stick' } : {}),
    ...(vault ? { dataSync: false, dataSyncOff: 'vault' } : {}) });
  const git = createGit(root);
  const live = dos ? new LiveData({
    procman, root, git, listVolumes: dos.listVolumes || opts.stick?.listVolumes || listVolumes, pollMs: dos.pollMs,
    device: () => opts.stick?.device || deviceId(home), onAttach: () => stick.syncNow('code'),
  }) : null;
  const mode = { mode: dos ? 'data-on-stick' : 'phone', vault: !!vault };
  const status = () => ({ name: 'StickHub', commit, engines: [...engines.keys()], engineErrors, stick: stick.status(), mode: mode.mode,
    live: live ? live.status() : { on: false }, vault: vault ? { on: true, ...vault.status() } : { on: false } });
  const api = createApi({ procman, stick, status, token, codes, mode, shutdown: () => opts.shutdown?.(),
    vaultRoutes: vault ? vaultRoutes(vault, json) : null });
  live?.on('change', () => api.broadcastStatus());
  vault?.on('change', () => api.broadcastStatus());
  procman.beforeStop = (views) => api.clearApps(views); // browser storage of the apps goes before they stop
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
    server, procman, stick, token, codes, home, mode, live, dataApi, vault,
    /** Start listening, then start watching for the stick. Rejects with EADDRINUSE when the port is taken. */
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        stick.start().catch((e) => console.error(`stick: ${e.message}`));
        live?.start().catch((e) => console.error(`data on stick: ${e.message}`));
        resolve(`http://127.0.0.1:${server.address().port}/`);
      });
    }),
    /** Stop syncing; lock the vault (it stops the apps); stop the rest, the server and the data API. */
    async close() {
      await stick.stop();
      await vault?.lock('stop');
      await procman.stopAll();
      await live?.stop();
      api.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
      await dataApi?.close();
    },
  };
}

async function main() {
  const settings = await loadSettings();
  // Data on the stick: the setting, or `node hub/cli.mjs open --data-on-stick` (sets STICKHUB_DATA_ON_STICK=1).
  const dataOnStick = settings.dataOnStick || process.env.STICKHUB_DATA_ON_STICK === '1';
  // Cartridge feel: with requireStick, no stick = no hub.
  if (settings.requireStick) {
    const s = await findStick((await listVolumes()).volumes);
    if (s.state !== 'ok') {
      console.error('requireStick is on (~/.stickhub/settings.json) and no stick with HUB is plugged in. Plug it in and try again.');
      process.exit(1);
    }
  }
  // DEV ONLY until the lock screen (job 4, commit 3 removes it): `node hub/cli.mjs open --vault` sets HUB_DEV_VAULT (a
  // folder) and sends the passphrase on stdin; the hub then unlocks through the vault service.
  const vaultDir = process.env.HUB_DEV_VAULT;
  delete process.env.HUB_DEV_VAULT;
  const devPass = vaultDir ? await readPassphrase(process.stdin) : null;
  let shutdown = () => {};
  const hub = await createHub({ port: Number(process.env.HUB_PORT) || HUB_PORT, shutdown: () => shutdown(0), dataOnStick,
    ...(vaultDir ? { vault: { dir: vaultDir } } : {}), autoLockSeconds: settings.autoLockSeconds });
  if (devPass !== null) {
    if (!hub.vault) { console.error('Vault (dev): there is no vault in that folder.'); process.exit(1); }
    try {
      await hub.vault.unlock('passphrase', devPass);
    } catch (e) {
      console.error(`Vault (dev): ${e.code === 'WRONG' ? 'wrong passphrase.' : e.message}`);
      await hub.dataApi?.close();
      process.exit(e.code === 'WRONG' ? EXIT_WRONG_PASSPHRASE : 1);
    }
  }
  for (const e of hub.procman.list()) if (e.problems.length) console.warn(`app ${e.id}: ${e.problems.join('; ')}`);
  let url;
  try {
    url = await hub.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${HUB_PORT} is in use. Is the hub already running? Open http://127.0.0.1:${HUB_PORT}/`);
      await hub.vault?.lock('stop');
      await hub.dataApi?.close();
      process.exit(1);
    }
    throw e;
  }
  console.log(`StickHub running: ${url}  (${hub.procman.list().length} apps${dataOnStick ? ', data on the stick' : ''}${hub.vault ? `, vault ${hub.vault.state}` : ''}, Ctrl+C to stop)`);

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
