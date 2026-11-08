// Talk to a running hub from the CLI or the watcher: ping, login URL, stop, start in the background.

import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, statSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readToken } from './auth.mjs';

export const HUB_PORT = 8787;

/**
 * One HTTP call to the hub on 127.0.0.1.
 * @returns {Promise<{status: number, body: any}|null>} null when the hub is not running
 */
export function callHub(path, { method = 'GET', token = null, port = HUB_PORT, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const headers = { host: `127.0.0.1:${port}`, ...(token ? { 'x-hub-token': token } : {}) };
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body = text;
        try { body = JSON.parse(text); } catch { /* not JSON: keep the text */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null)); // connection refused = hub not running
    req.end();
  });
}

/** True if a StickHub answers on the port. */
export async function hubRunning(port = HUB_PORT) {
  const r = await callHub('/api/ping', { port, timeout: 1500 });
  return r?.status === 200 && r.body?.name === 'StickHub';
}

/**
 * A fresh one-time login URL from the running hub.
 * @param {string} home
 */
export async function loginUrl(home, port = HUB_PORT) {
  const token = await readToken(home);
  if (!token) throw new Error('No token yet. Start the hub once (it creates one).');
  const r = await callHub('/api/auth/code', { method: 'POST', token, port });
  if (!r) throw new Error('The hub is not running. Start it: node hub/cli.mjs open');
  if (r.status !== 200) throw new Error(`The hub said ${r.status}: ${r.body?.error || r.body}`);
  return r.body.url;
}

/** Ask the running hub to stop its apps and exit. */
export async function stopHub(home, port = HUB_PORT) {
  const r = await callHub('/api/hub/stop', { method: 'POST', token: await readToken(home), port });
  return !!r && r.status === 202;
}

/**
 * Open a log file for a background process; a log over 1 MB is moved to <name>.old first.
 * @returns {number} file descriptor (the caller closes it after spawning)
 */
export function openLog(logsDir, name) {
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, name);
  try { if (statSync(file).size > 1 << 20) renameSync(file, `${file}.old`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return openSync(file, 'a');
}

/**
 * Start a Node script in the background (detached, output to logs/<log>). Returns its pid.
 * @param {string} root  repo root
 * @param {string} script  e.g. "hub/server.mjs"
 * @param {string} log  e.g. "hub.log"
 * @param {object} [env]
 */
export function startDetached(root, script, log, env = {}) {
  const fd = openLog(join(root, 'logs'), log);
  try {
    const child = spawn(process.execPath, [join(root, script)], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

/** Last non-empty line of a log file (for error messages). */
function lastLine(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n').pop() || ''; } catch { return ''; }
}

/**
 * Start the hub in the background if it is not running; wait until it answers (max ~10 s).
 * @param {{dataOnStick?: boolean, home?: string}} [o]  dataOnStick: app data on the stick (a hub running the other
 *   way is restarted); home: ~/.stickhub (for the token to stop it). A failed start throws with exitCode.
 *   With a vault the hub starts locked: its page asks for the passphrase (never the terminal).
 */
export async function ensureHub(root, port = HUB_PORT, o = {}) {
  const ping = await callHub('/api/ping', { port, timeout: 1500 });
  if (ping?.status === 200 && ping.body?.name === 'StickHub') {
    if (!o.dataOnStick || ping.body.mode === 'data-on-stick') return { started: false, mode: ping.body.mode, vault: ping.body.vault === true };
    // Running with app data on the phone, but data on the stick is wanted: restart (apps stop cleanly first).
    await stopHub(o.home, port);
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await hubRunning(port))) await new Promise((r) => setTimeout(r, 200));
    if (await hubRunning(port)) throw new Error('The running hub did not stop. Try: node hub/cli.mjs hub stop');
  }
  const child = startDetached(root, 'hub/server.mjs', 'hub.log', o.dataOnStick ? { STICKHUB_DATA_ON_STICK: '1' } : {});
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    if (exited !== null) throw Object.assign(new Error(`The hub stopped at once: ${lastLine(join(root, 'logs', 'hub.log'))}`), { exitCode: exited });
    if (await hubRunning(port)) return { started: true, pid: child.pid, mode: o.dataOnStick ? 'data-on-stick' : 'phone' };
  }
  throw new Error('The hub did not start within 10 s. See logs/hub.log');
}
