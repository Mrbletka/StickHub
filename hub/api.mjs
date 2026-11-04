// JSON + SSE API under /api/. No framework: a small route table.

import { serveStatic, send } from './static-files.mjs';
import { ID_RE } from './manifest.mjs';

/**
 * Create the API handler.
 * @param {{procman: import('./procman.mjs').ProcessManager, stick: import('./sync/service.mjs').StickService, status: () => object}} hub
 * @returns {{handle: (req, res, path: string) => Promise<void>, close: () => void}}
 */
export function createApi(hub) {
  const { procman, stick } = hub;
  const clients = new Set();
  let heartbeat = null;

  // Push every app change and (for clients that asked) log lines over SSE.
  procman.on('change', (app) => broadcast('app', app));
  stick.on('change', () => broadcast('status', hub.status()));
  procman.on('log', ({ id, entry }) => {
    for (const c of clients) if (c.logsFor === id) sse(c.res, 'log', { id, ...entry });
  });

  function broadcast(event, data) {
    for (const c of clients) sse(c.res, event, data);
  }

  function openEvents(req, res, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const logsFor = url.searchParams.get('logs');
    const client = { res, logsFor: logsFor && ID_RE.test(logsFor) ? logsFor : null };
    clients.add(client);
    sse(res, 'apps', procman.list());
    sse(res, 'status', hub.status());
    if (client.logsFor) for (const entry of procman.logs(client.logsFor)) sse(res, 'log', { id: client.logsFor, ...entry });
    // One shared heartbeat keeps proxies and the phone from dropping idle streams; it runs only while someone listens.
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
        return json(res, 500, { error: e.message, app: procman.view(m[1]) });
      }
    }
    if (m && req.method === 'GET' && m[2] === 'logs') {
      return json(res, 200, procman.logs(m[1], Number(url.searchParams.get('after')) || 0));
    }
    if (m && req.method === 'GET' && m[2] === 'icon') {
      const app = procman.apps.get(m[1]);
      if (!app.manifest?.icon) return send(res, 404, 'No icon');
      // The icon path was validated as relative without ".."; serveStatic checks again that it stays inside the app.
      return serveStatic(req, res, app.dir, { urlPath: `/${app.manifest.icon}`, cache: 'no-cache' });
    }
    if (path.startsWith('/api/')) return json(res, m ? 405 : 404, { error: m ? 'Method not allowed' : 'Not found' });
  }

  return {
    handle,
    close() {
      for (const c of clients) c.res.end();
      clients.clear();
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
  };
}

/** Send JSON. */
export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
