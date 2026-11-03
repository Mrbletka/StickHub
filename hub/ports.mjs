// Port helpers: find a free port in the app range, wait until a port accepts TCP connections.

import { createServer, connect } from 'node:net';

/**
 * True if nothing listens on 127.0.0.1:port right now (we can bind it).
 * @param {number} port
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * First free port in [from, to] that is not in `taken`.
 * @param {{from: number, to: number}} range
 * @param {Set<number>} taken  ports the hub already gave out
 * @returns {Promise<number>}
 */
export async function findFreePort(range, taken = new Set()) {
  for (let p = range.from; p <= range.to; p++) {
    if (!taken.has(p) && await isPortFree(p)) return p;
  }
  throw new Error(`No free port between ${range.from} and ${range.to}. Stop an app and try again.`);
}

/** One TCP connection attempt; resolves true if it connects. */
function tryConnect(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Wait until 127.0.0.1:port accepts connections.
 * @param {number} port
 * @param {{timeoutMs?: number, stepMs?: number, alive?: () => boolean}} [opts]  alive: stop early when it returns false
 * @returns {Promise<boolean>} true when the port is open
 */
export async function waitForPort(port, opts = {}) {
  const { timeoutMs = 15_000, stepMs = 150, alive = () => true } = opts;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!alive()) return false;
    if (await tryConnect(port)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
