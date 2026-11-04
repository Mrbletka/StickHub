// Process manager: starts and stops apps through their engines, tracks status, ports and logs.
// Operations on one app run one after another (a start during a stop waits), so state never tangles.

import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanApps } from './apps.mjs';
import { findFreePort, isPortFree } from './ports.mjs';
import { RingLog } from './ringlog.mjs';

/**
 * @typedef {object} EngineContext
 * @property {import('./apps.mjs').App} app
 * @property {number} port      the port the app must listen on (127.0.0.1)
 * @property {Record<string, string>} env  PORT, HUB_APP_ID, HUB_APP_DIR, HUB_DATA_DIR
 * @property {(stream: 'out'|'err'|'sys', line: string) => void} log
 * @property {number} [startTimeoutMs]
 */

/**
 * Events: "change" (public app view), "log" ({id, entry}).
 */
export class ProcessManager extends EventEmitter {
  /**
   * @param {{engines: Map<string, object>, appsDir: string, dataDir: string,
   *   portRange?: {from: number, to: number}, startTimeoutMs?: number, pidFile?: import('./proc.mjs').PidFile}} opts
   *   pidFile: where running app processes are remembered (for cleanup after a hard kill)
   */
  constructor(opts) {
    super();
    this.engines = opts.engines;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.portRange = opts.portRange || { from: 4100, to: 4199 };
    this.startTimeoutMs = opts.startTimeoutMs;
    this.pidFile = opts.pidFile || null;
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
      atomicData: a?.manifest?.atomicData === true,
      status: s.status, port: s.port, url: s.url, error: s.error, startedAt: s.startedAt,
      problems: a?.errors || [],
    };
  }

  /** Recent log lines of an app. */
  logs(id, after = 0) {
    return this.state.get(id)?.log.since(after) || [];
  }

  /** Running apps whose data sync must wait (apps with atomicData: true do not block sync). */
  syncBlockers() {
    return new Set([...this.apps.keys()].filter((id) => this.isActive(id) && this.apps.get(id).manifest?.atomicData !== true));
  }

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
      const engine = this.engines.get(app.manifest.engine);
      if (!engine) throw new Error(`Engine "${app.manifest.engine}" is not installed`);

      this.#set(id, { status: 'starting', error: null });
      try {
        const port = await this.#pickPort(app);
        const dataDir = join(this.dataDir, id);
        await mkdir(dataDir, { recursive: true });
        this.#log(id, 'sys', `starting on port ${port}`);
        const handle = await engine.start({
          app, port, startTimeoutMs: this.startTimeoutMs,
          env: { PORT: String(port), HUB_APP_ID: id, HUB_APP_DIR: app.dir, HUB_DATA_DIR: dataDir },
          log: (stream, line) => this.#log(id, stream, line),
        });
        this.#set(id, { status: 'running', port: handle.port, url: handle.url, startedAt: Date.now(), handle });
        if (handle.pid && handle.argv) await this.pidFile?.add(id, handle.pid, handle.argv);
        this.#log(id, 'sys', `running at ${handle.url}`);
        handle.exit?.then((r) => this.#onExit(id, handle, r));
        return this.view(id);
      } catch (e) {
        this.#log(id, 'sys', `start failed: ${e.message}`);
        this.#set(id, { status: 'error', error: e.message, port: null, url: null, handle: null });
        throw e;
      }
    });
  }

  /** Stop an app (no-op if it is not running). graceMs: time after SIGTERM before SIGKILL (default 3 s). */
  stop(id, graceMs) {
    return this.#queue(id, async () => {
      const s = this.state.get(id);
      if (!s || s.status !== 'running') return this.view(id);
      this.#set(id, { status: 'stopping' });
      try {
        await s.handle.stop(graceMs);
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

  /** Stop every app (used on hub exit). Errors are logged, never thrown. */
  async stopAll(graceMs) {
    await Promise.all([...this.state.keys()].map((id) => this.stop(id, graceMs).catch(() => {})));
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
    this.pidFile?.remove(id);
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit code ${r.code}`;
    this.#log(id, 'sys', `the app stopped by itself (${why})`);
    this.#set(id, { status: r.code === 0 ? 'stopped' : 'error', error: r.code === 0 ? null : `Stopped by itself (${why})`,
      port: null, url: null, startedAt: null, handle: null });
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
