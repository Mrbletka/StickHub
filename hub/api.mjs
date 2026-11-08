// JSON + event-stream API under /api/. No framework: a small route table.
// Every route needs the X-Hub-Token header except: GET /api/ping, POST /api/auth/exchange (the one-time code is the
// credential) and GET /api/apps/<id>/icon (images cannot send headers; icons are harmless).

import { serveStatic, send } from './static-files.mjs';
import { ID_RE } from './manifest.mjs';
import { tokenMatches } from './auth.mjs';

const MAX_BODY = 4096;
/** How long a stop waits after asking the open hub pages to clear the apps' browser storage (design 8.5). */
export const CLEAR_WAIT_MS = 400;

/**
 * Create the API handler.
 * @param {{procman: import('./procman.mjs').ProcessManager, stick: import('./sync/service.mjs').StickService,
 *   status: () => object, token: string, codes: import('./auth.mjs').LoginCodes, shutdown?: () => void,
 *   vaultRoutes?: (req, res, path: string) => Promise<boolean>}} hub  vaultRoutes: /api/vault* (hub/lock/routes.mjs)
 * @returns {{handle: (req, res, path: string) => Promise<void>, close: () => void}}
 */
export function createApi(hub) {
  const { procman, stick } = hub;
  const clients = new Set();
  let heartbeat = null;
  let lastLoginAt = null;

  // Push every app change and (for clients that asked) log lines to the open event streams.
  procman.on('change', (app) => broadcast('app', app));
  stick.on('change', () => broadcast('status', hub.status()));
  procman.on('log', ({ id, entry }) => {
    for (const c of clients) if (c.logsFor === id) event(c.res, 'log', { id, ...entry });
  });

  function broadcast(name, data) {
    for (const c of clients) event(c.res, name, data);
  }

  // Server-sent events format, read by the page with fetch() (EventSource cannot send the token header).
  function openEvents(req, res, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const logsFor = url.searchParams.get('logs');
    const client = { res, logsFor: logsFor && ID_RE.test(logsFor) ? logsFor : null };
    clients.add(client);
    event(res, 'apps', procman.list());
    event(res, 'status', hub.status());
    if (client.logsFor) for (const entry of procman.logs(client.logsFor)) event(res, 'log', { id: client.logsFor, ...entry });
    // One shared heartbeat keeps the phone from dropping idle streams; it runs only while someone listens.
    if (!heartbeat) heartbeat = setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25_000);
    req.on('close', () => {
      clients.delete(client);
      if (!clients.size && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    });
  }

  async function handle(req, res, path) {
    const url = new URL(req.url || '/', 'http://x');
    const m = /^\/api\/apps\/([^/]+)\/(start|stop|restart|logs|icon)$/.exec(path);
    if (m && !ID_RE.test(m[1])) return json(res, 400, { error: 'Bad app id' });
    if (m && !procman.apps.has(m[1])) return json(res, 404, { error: `No app "${m[1]}"` });

    // Open routes.
    if (req.method === 'GET' && path === '/api/ping') {
      return json(res, 200, { name: 'StickHub', pid: process.pid, lastLoginAt, mode: hub.mode?.mode || 'phone', vault: !!hub.mode?.vault });
    }
    if (req.method === 'POST' && path === '/api/auth/exchange') {
      const body = await readJson(req).catch(() => null);
      if (!body || !hub.codes.consume(body.code)) {
        return json(res, 401, { error: 'This login link is old or was already used. In Termux run: cd ~/StickHub && node hub/cli.mjs login --open' });
      }
      lastLoginAt = new Date().toISOString();
      return json(res, 200, { token: hub.token });
    }
    if (m && req.method === 'GET' && m[2] === 'icon') {
      const app = procman.apps.get(m[1]);
      if (!app.manifest?.icon) return send(res, 404, 'No icon');
      // The icon path was validated as relative without ".."; serveStatic checks again that it stays inside the app.
      return serveStatic(req, res, app.dir, { urlPath: `/${app.manifest.icon}`, cache: 'no-cache' });
    }

    if (!tokenMatches(req.headers['x-hub-token'], hub.token)) {
      return json(res, 401, { error: 'Not logged in. In Termux run: cd ~/StickHub && node hub/cli.mjs login --open', login: true });
    }

    if (hub.vaultRoutes && await hub.vaultRoutes(req, res, path)) return undefined; // /api/vault*: unlock, lock, status

    if (req.method === 'POST' && path === '/api/auth/code') {
      const code = hub.codes.create();
      return json(res, 200, { code, url: `http://127.0.0.1:${req.socket.localPort}/?code=${code}` });
    }
    if (req.method === 'POST' && path === '/api/hub/stop') {
      json(res, 202, { stopping: true });
      if (hub.shutdown) setImmediate(hub.shutdown);
      return;
    }
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, hub.status());
    if (req.method === 'GET' && path === '/api/apps') return json(res, 200, procman.list());
    if (req.method === 'POST' && path === '/api/apps/reload') return json(res, 200, await procman.reload());
    if (req.method === 'GET' && path === '/api/events') return openEvents(req, res, url);
    if (req.method === 'GET' && path === '/api/stick') return json(res, 200, stick.status());
    if (req.method === 'POST' && path === '/api/sync') {
      const what = url.searchParams.get('what') || 'all';
      if (!['all', 'data', 'code'].includes(what)) return json(res, 400, { error: 'what: all, data or code' });
      const started = stick.syncNow(what);
      return json(res, started ? 202 : 409, started ? stick.status() : { error: 'No stick with a HUB is connected.', stick: stick.status() });
    }
    if (req.method === 'POST' && path === '/api/sync/cancel') { stick.cancel(); return json(res, 200, stick.status()); }
    if (m && req.method === 'POST' && ['start', 'stop', 'restart'].includes(m[2])) {
      try {
        return json(res, 200, await procman[m[2]](m[1]));
      } catch (e) {
        return json(res, e.code === 'LOCKED' ? 423 : 500, { error: e.message, app: procman.view(m[1]) });
      }
    }
    if (m && req.method === 'GET' && m[2] === 'logs') {
      return json(res, 200, procman.logs(m[1], Number(url.searchParams.get('after')) || 0));
    }
    return json(res, m ? 405 : 404, { error: m ? 'Method not allowed' : 'Not found' });
  }

  return {
    handle,
    /** Push the hub status to every open page now. */
    broadcastStatus: () => broadcast('status', hub.status()),
    /**
     * Before apps stop (stop, restart, stick pulled, hub stop; job 4: lock): every open hub page loads each app's
     * /__hub/clear in a hidden frame (Clear-Site-Data). Waits CLEAR_WAIT_MS, and only when a page is connected.
     * @param {{id: string, url: string|null}[]} views
     */
    async clearApps(views) {
      const apps = views.filter((v) => v.url).map((v) => ({ id: v.id, url: v.url }));
      if (!apps.length || !clients.size) return;
      broadcast('clear', apps);
      await new Promise((r) => setTimeout(r, CLEAR_WAIT_MS));
    },
    close() {
      for (const c of clients) c.res.end();
      clients.clear();
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
  };
}

/** Read a small JSON body. Rejects when it is too big or not JSON. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** Send JSON. */
export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function event(res, name, data) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
