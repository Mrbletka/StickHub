// Process manager: starts and stops apps through their engines, tracks status, ports and logs.
// Operations on one app run one after another (a start during a stop waits), so state never tangles.

import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanApps } from './apps.mjs';
import { findFreePort, isPortFree } from './ports.mjs';
import { RingLog } from './ringlog.mjs';
import { dataUse } from './manifest.mjs';

/** Shown on the tile of an app that saves plain files while the vault is on (it does not start). */
export const VAULT_FILES_ERROR = 'This app saves plain files (HUB_DATA_DIR). With the vault on it must use hubfs: '
  + 'lib/hubfs.mjs and "data": "hubfs" in app.json.';

/**
 * @typedef {object} EngineContext
 * @property {import('./apps.mjs').App} app
 * @property {number} port      the port the app must listen on (127.0.0.1)
 * @property {Record<string, string>} env  PORT, HUB_APP_ID, HUB_APP_DIR, and HUB_DATA_DIR (no vault) or
 *   HUB_DATA_SOCKET + HUB_DATA_TOKEN (vault on, apps with "data": "hubfs")
 * @property {(stream: 'out'|'err'|'sys', line: string) => void} log
 * @property {number} [startTimeoutMs]
 */

/**
 * Events: "change" (public app view), "log" ({id, entry}).
 */
export class ProcessManager extends EventEmitter {
  /**
   * @param {{engines: Map<string, object>, appsDir: string, dataDir: string,
   *   portRange?: {from: number, to: number}, startTimeoutMs?: number, pidFile?: import('./proc.mjs').PidFile,
   *   dataApi?: {socketPath: string, issue: (id: string) => string, revoke: (id: string) => void},
   *   startBlock?: () => string|null}} opts
   *   pidFile: where running app processes are remembered (for cleanup after a hard kill)
   *   dataApi: the vault is on: apps get the data socket and a fresh token per start, never HUB_DATA_DIR
   */
  constructor(opts) {
    super();
    this.engines = opts.engines;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.portRange = opts.portRange || { from: 4100, to: 4199 };
    this.startTimeoutMs = opts.startTimeoutMs;
    this.pidFile = opts.pidFile || null;
    this.dataApi = opts.dataApi || null;
    /** Called with the views of running apps right before they stop (the hub clears their browser storage). */
    this.beforeStop = opts.beforeStop || null;
    /** Returns why no app may start right now (the vault is locked), or null. */
    this.startBlock = opts.startBlock || null;
    /** @type {Map<string, import('./apps.mjs').App>} */
    this.apps = new Map();
    /** @type {Map<string, {status: string, port: number|null, url: string|null, error: string|null, startedAt: number|null, handle: any, log: RingLog}>} */
    this.state = new Map();
    this.ops = new Map();
  }

  /** Re-read apps/ from disk. Running apps keep running. */
  async reload() {
    const apps = await scanApps(this.appsDir, this.engines);
    const ids = new Set(apps.map((a) => a.id));
    for (const id of this.apps.keys()) {
      if (!ids.has(id) && !this.isActive(id)) { this.apps.delete(id); this.state.delete(id); }
    }
    for (const app of apps) {
      // A running app keeps the manifest it was started with until it stops.
      if (!this.isActive(app.id)) this.apps.set(app.id, app);
      this.#st(app.id);
    }
    return this.list();
  }

  /** Public view of every app (safe to send to the browser). */
  list() {
    return [...this.apps.values()].map((a) => this.view(a.id));
  }

  /** Public view of one app. */
  view(id) {
    const a = this.apps.get(id);
    const s = this.#st(id);
    return {
      id, name: a?.manifest?.name || id, description: a?.manifest?.description || '',
      engine: a?.manifest?.engine || null, version: a?.manifest?.version || null, hasIcon: !!a?.manifest?.icon,
      atomicData: a?.manifest?.atomicData === true, data: a?.manifest ? dataUse(a.manifest) : null,
      status: s.status, port: s.port, url: s.url, error: s.error, startedAt: s.startedAt,
      problems: [...(a?.errors || []), ...(this.#vaultBlocks(a) ? [VAULT_FILES_ERROR] : [])],
    };
  }

  /** Recent log lines of an app. */
  logs(id, after = 0) {
    return this.state.get(id)?.log.since(after) || [];
  }

  /** Forget every app's log lines (on lock: app output can hold names from the vault). */
  clearLogs() {
    for (const s of this.state.values()) s.log = new RingLog(500);
  }

  /** Running apps whose data sync must wait (apps with atomicData: true do not block sync). */
  syncBlockers() {
    return new Set([...this.apps.keys()].filter((id) => this.isActive(id) && this.apps.get(id).manifest?.atomicData !== true));
  }

  /**
   * Where app data lives: data/<id> under this folder. null = nowhere right now (data on the stick, stick not
   * plugged in): no app may start.
   */
  setDataDir(dir) { this.dataDir = dir; }

  /** True while an app is starting, running or stopping. */
  isActive(id) {
    const s = this.state.get(id)?.status;
    return s === 'starting' || s === 'running' || s === 'stopping';
  }

  /**
   * Start an app (no-op if it already runs). Resolves with its view; rejects with a readable message.
   * @param {string} id
   */
  start(id) {
    return this.#queue(id, async () => {
      const app = this.apps.get(id);
      if (!app) throw new Error(`No app "${id}"`);
      const s = this.#st(id);
      if (s.status === 'running') return this.view(id);
      if (!app.manifest) throw new Error(`App "${id}" has problems: ${app.errors.join('; ')}`);
      const blocked = this.startBlock?.(); // the vault is locked: no app starts (the app is not marked as failed)
      if (blocked) throw Object.assign(new Error(blocked), { code: 'LOCKED' });
      const engine = this.engines.get(app.manifest.engine);
      if (!engine) throw new Error(`Engine "${app.manifest.engine}" is not installed`);
      // One app that still wants plain files never breaks the hub: it shows why on its tile and does not start.
      if (this.#vaultBlocks(app)) { this.#set(id, { status: 'error', error: VAULT_FILES_ERROR }); throw new Error(VAULT_FILES_ERROR); }
      // Data on the stick and no stick: refuse without marking the app as failed.
      if (!this.dataApi && !this.dataDir) throw new Error('Plug in the stick: the app data is on it.');

      this.#set(id, { status: 'starting', error: null });
      try {
        const port = await this.#pickPort(app);
        const env = { PORT: String(port), HUB_APP_ID: id, HUB_APP_DIR: app.dir, ...(await this.#dataEnv(app)) };
        this.#log(id, 'sys', `starting on port ${port}`);
        const handle = await engine.start({ app, port, startTimeoutMs: this.startTimeoutMs, env, log: (stream, line) => this.#log(id, stream, line) });
        this.#set(id, { status: 'running', port: handle.port, url: handle.url, startedAt: Date.now(), handle });
        if (handle.pid && handle.argv) await this.pidFile?.add(id, handle.pid, handle.argv);
        this.#log(id, 'sys', `running at ${handle.url}`);
        handle.exit?.then((r) => this.#onExit(id, handle, r));
        return this.view(id);
      } catch (e) {
        this.dataApi?.revoke(id);
        this.#log(id, 'sys', `start failed: ${e.message}`);
        this.#set(id, { status: 'error', error: e.message, port: null, url: null, handle: null });
        throw e;
      }
    });
  }

  /**
   * Stop an app (no-op if it is not running). graceMs: time after SIGTERM before SIGKILL (default 3 s).
   * beforeStop runs first (o.cleared: stopAll already ran it for every app).
   */
  stop(id, graceMs, o = {}) {
    return this.#queue(id, async () => {
      const s = this.state.get(id);
      if (!s || s.status !== 'running') return this.view(id);
      if (!o.cleared) await this.#beforeStop([this.view(id)]);
      this.#set(id, { status: 'stopping' });
      try {
        await s.handle.stop(graceMs);
        this.dataApi?.revoke(id);
        await this.pidFile?.remove(id);
        this.#log(id, 'sys', 'stopped');
        this.#set(id, { status: 'stopped', port: null, url: null, startedAt: null, handle: null, error: null });
      } catch (e) {
        this.#log(id, 'sys', `stop failed: ${e.message}`);
        this.#set(id, { status: 'error', error: `Could not stop: ${e.message}` });
        throw e;
      }
      return this.view(id);
    });
  }

  /** Stop, then start. */
  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  /** Stop every app (hub exit, stick pulled): one beforeStop for all, then all at once. Errors are logged, never thrown. */
  async stopAll(graceMs) {
    const running = [...this.state.keys()].filter((id) => this.state.get(id).status === 'running');
    if (running.length) await this.#beforeStop(running.map((id) => this.view(id)));
    await Promise.all([...this.state.keys()].map((id) => this.stop(id, graceMs, { cleared: true }).catch(() => {})));
  }

  /** beforeStop never blocks a stop: a failure is logged. */
  async #beforeStop(views) {
    try { await this.beforeStop?.(views); } catch (e) { this.#log(views[0].id, 'sys', `before stop: ${e.message}`); }
  }

  /** Last resort on process exit: kill child processes synchronously. */
  killAllNow() {
    for (const s of this.state.values()) {
      if (s.handle?.pid) {
        try { process.kill(s.handle.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') console.error(`kill ${s.handle.pid}: ${e.message}`); }
      }
    }
  }

  // An app process ended. If we did not ask for it, show it as an error with the exit code.
  #onExit(id, handle, r) {
    const s = this.state.get(id);
    if (!s || s.handle !== handle || s.status !== 'running') return;
    this.dataApi?.revoke(id);
    this.pidFile?.remove(id);
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit code ${r.code}`;
    this.#log(id, 'sys', `the app stopped by itself (${why})`);
    this.#set(id, { status: r.code === 0 ? 'stopped' : 'error', error: r.code === 0 ? null : `Stopped by itself (${why})`,
      port: null, url: null, startedAt: null, handle: null });
  }

  /** True if the vault is on and this app still wants plain files. */
  #vaultBlocks(app) {
    return !!(this.dataApi && app?.manifest && dataUse(app.manifest) === 'files');
  }

  /**
   * Where the app's data lives. Vault on: the data socket and a fresh token for hubfs apps (the old token stops
   * working), nothing for apps without data. Vault off: HUB_DATA_DIR = data/<id>, as before. The token goes only
   * into the app's environment: never into a log line, the status or the pid file.
   */
  async #dataEnv(app) {
    if (this.dataApi) return dataUse(app.manifest) === 'hubfs' ? { HUB_DATA_SOCKET: this.dataApi.socketPath, HUB_DATA_TOKEN: this.dataApi.issue(app.id) } : {};
    const dataDir = join(this.dataDir, app.id);
    await mkdir(dataDir, { recursive: true });
    return { HUB_DATA_DIR: dataDir };
  }

  async #pickPort(app) {
    if (Number.isInteger(app.manifest.port)) {
      if (!(await isPortFree(app.manifest.port))) throw new Error(`Port ${app.manifest.port} is already in use`);
      return app.manifest.port;
    }
    // Fixed ports of other apps are never handed out automatically, even while those apps are stopped.
    const taken = new Set([...this.state.values()].map((s) => s.port).filter(Boolean));
    for (const a of this.apps.values()) if (a.id !== app.id && Number.isInteger(a.manifest?.port)) taken.add(a.manifest.port);
    return findFreePort(this.portRange, taken);
  }

  // Run fn after any earlier operation on the same app has finished.
  #queue(id, fn) {
    const prev = this.ops.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.ops.set(id, next);
    next.finally(() => { if (this.ops.get(id) === next) this.ops.delete(id); }).catch(() => {});
    return next;
  }

  #st(id) {
    if (!this.state.has(id)) {
      this.state.set(id, { status: 'stopped', port: null, url: null, error: null, startedAt: null, handle: null, log: new RingLog(500) });
    }
    return this.state.get(id);
  }

  #set(id, patch) {
    Object.assign(this.#st(id), patch);
    this.emit('change', this.view(id));
  }

  #log(id, stream, line) {
    const entry = this.#st(id).log.push(stream, line);
    this.emit('log', { id, entry });
  }
}
