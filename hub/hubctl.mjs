// Talk to a running hub from the CLI or the watcher: ping, login URL, stop, start in the background.

import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, statSync, renameSync } from 'node:fs';
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
 */
export function startDetached(root, script, log) {
  const fd = openLog(join(root, 'logs'), log);
  try {
    const child = spawn(process.execPath, [join(root, script)], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Start the hub in the background if it is not running; wait until it answers (max ~10 s). */
export async function ensureHub(root, port = HUB_PORT) {
  if (await hubRunning(port)) return { started: false };
  const pid = startDetached(root, 'hub/server.mjs', 'hub.log');
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    if (await hubRunning(port)) return { started: true, pid };
  }
  throw new Error('The hub did not start within 10 s. See logs/hub.log');
}
