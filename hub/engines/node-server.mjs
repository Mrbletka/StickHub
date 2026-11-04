// Engine "node-server": runs the app's entry file with the hub's own Node (process.execPath),
// waits until its port accepts TCP, then does one HTTP health check.
// app.json: { "engine": "node-server", "entry": "server.mjs", "args": [], "env": {}, "health": "/" }

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { waitForPort } from '../ports.mjs';

const STOP_GRACE_MS = 3000;

export default {
  id: 'node-server',

  /** @returns {string[]} errors */
  validate(m) {
    if (!m.entry) return ['entry: the file to run, e.g. "server.mjs"'];
    if (!/\.(mjs|cjs|js)$/.test(m.entry)) return ['entry: must be a .mjs, .cjs or .js file'];
    return [];
  },

  /**
   * @param {import('../procman.mjs').EngineContext} ctx
   */
  async start(ctx) {
    const { app, port } = ctx;
    const entry = join(app.dir, app.manifest.entry);
    if (!(await stat(entry).catch(() => null))?.isFile()) throw new Error(`Entry file "${app.manifest.entry}" not found`);

    // Never a shell: process.execPath + argument array. The app sees only its own HUB_* values.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HUB_')));
    Object.assign(env, app.manifest.env, ctx.env);
    const argv = [process.execPath, entry, ...app.manifest.args];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: app.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });

    let exited = false;
    const exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
      child.once('error', (e) => { ctx.log('err', `could not start: ${e.message}`); exited = true; resolve({ code: null, signal: null, error: e }); });
    });
    for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => ctx.log(name, line));
    }

    const stop = async () => {
      if (exited) return exit;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!exited) { ctx.log('sys', 'did not stop in 3 s, killing'); child.kill('SIGKILL'); } }, STOP_GRACE_MS);
      const result = await exit;
      clearTimeout(timer);
      return result;
    };

    const open = await waitForPort(port, { timeoutMs: ctx.startTimeoutMs ?? 15_000, alive: () => !exited });
    if (!open) {
      const why = exited ? 'the app quit while starting (see the log)' : `nothing answered on port ${port} in time. Does the app use process.env.PORT?`;
      await stop();
      throw new Error(why);
    }
    const health = await healthCheck(port, app.manifest.health || '/');
    if (!health.ok) {
      await stop();
      throw new Error(`health check failed: ${health.error}`);
    }
    // argv: the exact command line, so leftovers can be recognised after a hard hub kill (hub/proc.mjs).
    return { port, url: `http://127.0.0.1:${port}/`, stop, exit, pid: child.pid, argv };
  },
};

/**
 * One HTTP GET. Any answer below 500 counts as healthy (404 on "/" is fine for an API server).
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
function healthCheck(port, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode < 500 ? { ok: true, status: res.statusCode } : { ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'no answer in 5 s' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}
