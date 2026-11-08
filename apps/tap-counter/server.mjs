// Sample app for the node-server engine. Runs on its own too: PORT=4100 node server.mjs  (data in ./data)
// Shows the hub contract: listen on process.env.PORT (127.0.0.1), keep data only through lib/hubfs.mjs (the hub's
// vault, or plain files when it runs alone or without the vault).

import { createServer } from 'node:http';
import * as hubfs from './lib/hubfs.mjs';

const port = Number(process.env.PORT) || 4100;
const SAVE = 'count.json'; // inside this app's own data

async function load() {
  try { return JSON.parse(await hubfs.readFile(SAVE, 'utf8')).count || 0; } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

// hubfs writes are atomic (a save is never half written) and keep their order.
async function save(n) {
  await hubfs.writeFile(SAVE, JSON.stringify({ count: n, saved: new Date().toISOString() }));
}

let count = null; // read on the first request, so the server answers at once
const current = async () => (count ??= await load());

const page = (n) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000"><title>Tap Counter</title><style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:system-ui,sans-serif}
body{display:grid;place-items:center;text-align:center;touch-action:manipulation;user-select:none}
button{all:unset;width:min(70vw,320px);aspect-ratio:1;border-radius:50%;background:#0d2b1d;color:#5df2a0;
font-size:clamp(48px,18vw,96px);font-weight:700;display:grid;place-items:center;box-shadow:0 0 0 4px #1d5c3b inset}
button:active{transform:scale(.96)}p{color:#888;margin:24px}
</style></head><body><main><button id="b">${n}</button><p>Tap the circle. The count is saved.</p></main>
<script>
const b = document.getElementById('b');
b.onclick = async () => {
  const r = await fetch('tap', { method: 'POST' });
  if (r.ok) b.textContent = (await r.json()).count;
};
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/tap') {
      const n = (await current()) + 1;
      count = n;
      await save(n);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count: n }));
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page(await current()));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Error');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Tap Counter on http://127.0.0.1:${port}/`));

// The hub stops apps with SIGTERM: close cleanly.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
