// Sample app for the node-server engine. Runs on its own too: PORT=4100 node server.mjs
// Shows the hub contract: listen on process.env.PORT (127.0.0.1), keep saves in HUB_DATA_DIR.

import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.env.PORT) || 4100;
const dataDir = process.env.HUB_DATA_DIR || join(import.meta.dirname, 'data');
const saveFile = join(dataDir, 'count.json');

async function load() {
  try { return JSON.parse(await readFile(saveFile, 'utf8')).count || 0; } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

// Write a temp file, then rename: a save is never half written.
async function save(count) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${saveFile}.tmp`, JSON.stringify({ count, saved: new Date().toISOString() }));
  await rename(`${saveFile}.tmp`, saveFile);
}

let count = await load();

const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000"><title>Tap Counter</title><style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:system-ui,sans-serif}
body{display:grid;place-items:center;text-align:center;touch-action:manipulation;user-select:none}
button{all:unset;width:min(70vw,320px);aspect-ratio:1;border-radius:50%;background:#0d2b1d;color:#5df2a0;
font-size:clamp(48px,18vw,96px);font-weight:700;display:grid;place-items:center;box-shadow:0 0 0 4px #1d5c3b inset}
button:active{transform:scale(.96)}p{color:#888;margin:24px}
</style></head><body><main><button id="b">${count}</button><p>Tap the circle. The count is saved.</p></main>
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
      count++;
      await save(count);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count }));
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Error');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Tap Counter on http://127.0.0.1:${port}/ (saves in ${dataDir})`));

// The hub stops apps with SIGTERM: close cleanly.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
