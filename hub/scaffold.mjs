// `node hub/cli.mjs new <id> --engine node-server|static [--name "Name"]`: a new app in apps/<id>/
// that follows the app rules. Never overwrites: an existing folder is an error.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ID_RE } from './manifest.mjs';

export const SCAFFOLD_ENGINES = ['node-server', 'static'];

/** Escape text for HTML. */
const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "deep-dig" -> "Deep Dig" */
export function titleFromId(id) {
  return id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Placeholder icon: a colored rounded square with the first letter. Color comes from the id. */
export function placeholderIcon(id, name) {
  const hue = createHash('sha256').update(id).digest()[0] * 360 / 256;
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="hsl(${Math.round(hue)} 45% 14%)"/>`
    + `<text x="48" y="64" font-family="sans-serif" font-size="46" font-weight="700" text-anchor="middle" fill="hsl(${Math.round(hue)} 85% 68%)">${letter}</text></svg>\n`;
}

const PAGE_STYLE = `  html, body { margin: 0; height: 100%; background: #000; color: #f2f2f2; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; text-align: center; touch-action: manipulation; user-select: none;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p { color: #8a8a8a; }
  button { all: unset; margin-top: 20px; padding: 16px 28px; border-radius: 16px; background: #5df2a0; color: #002814; font-weight: 700; font-size: 18px; }
  button:active { transform: scale(.97); }`;

function nodeServerFiles(id, name) {
  return {
    'server.mjs': `// ${id}: StickHub app (engine node-server). Runs on its own too:  PORT=4100 node server.mjs
// App rules: listen on process.env.PORT at 127.0.0.1, keep saves in process.env.HUB_DATA_DIR,
// stop cleanly on SIGTERM. Node built-ins only.

import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';

const NAME = ${JSON.stringify(name)};
const PORT = Number(process.env.PORT) || 4100;
const DATA_DIR = process.env.HUB_DATA_DIR || join(import.meta.dirname, 'data'); // own data/ when run alone
const PUBLIC = join(import.meta.dirname, 'public');
const SAVE = join(DATA_DIR, 'save.json');
const MAX_SAVE = 1 << 20;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };

/** Read the save (an empty object when there is none yet). */
async function loadSave() {
  try { return JSON.parse(await readFile(SAVE, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/** Write the save atomically: temp file, then rename. A save is never half written. */
async function writeSave(data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(\`\${SAVE}.tmp\`, JSON.stringify(data));
  await rename(\`\${SAVE}.tmp\`, SAVE);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_SAVE) { reject(Object.assign(new Error('save too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Serve a file from public/, never outside it. */
async function serveFile(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath); } catch { return send(res, 400, 'Bad path', 'text/plain'); }
  const file = normalize(join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return send(res, 403, 'Forbidden', 'text/plain');
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/save' && req.method === 'GET') return send(res, 200, await loadSave());
    if (path === '/api/save' && req.method === 'PUT') {
      const data = JSON.parse(await readBody(req));
      await writeSave(data);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') return await serveFile(res, path);
    send(res, 405, 'Method not allowed', 'text/plain');
  } catch (e) {
    console.error(\`\${req.method} \${req.url}: \${e.message}\`);
    if (!res.headersSent) send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(\`\${NAME} on http://127.0.0.1:\${PORT}/ (saves in \${DATA_DIR})\`));

// The hub stops apps with SIGTERM (then SIGKILL after 3 s): finish open requests and exit.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 2000).unref();
});
`,
    'public/index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>${esc(name)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<main>
  <h1>${esc(name)}</h1>
  <p>Starter app. Saved count: <b id="count">…</b></p>
  <button id="add">+1 and save</button>
</main>
<script type="module">
  // Saves go to the app's own server (PUT /api/save), which keeps them in HUB_DATA_DIR: they sync with the stick.
  // Do not keep saves in localStorage or IndexedDB: browser storage is not synced.
  const out = document.getElementById('count');
  let save = await (await fetch('api/save')).json();
  out.textContent = save.count ?? 0;
  document.getElementById('add').onclick = async () => {
    save = { ...save, count: (save.count ?? 0) + 1 };
    out.textContent = save.count;
    const r = await fetch('api/save', { method: 'PUT', body: JSON.stringify(save) });
    if (!r.ok) out.textContent = 'save failed';
  };
</script>
</body>
</html>
`,
  };
}

function staticFiles(name) {
  return {
    'public/index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>${esc(name)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<main>
  <h1>${esc(name)}</h1>
  <p>Starter static app. The hub serves the files in public/.</p>
  <p>A static app has no server, so it cannot save. Need saves? Make it a node-server app.</p>
</main>
</body>
</html>
`,
  };
}

function readme(id, name, engine) {
  const rules = engine === 'node-server'
    ? `- Listen on \`process.env.PORT\` at 127.0.0.1 (the hub picks the port).
- Keep saves in \`process.env.HUB_DATA_DIR\` through this server (\`PUT /api/save\` in the starter). They sync with the stick.
- Browser storage (localStorage, IndexedDB) is NOT synced: do not keep saves there.
- Never import or require anything from \`HUB_DATA_DIR\`: data is data, never code (it may live on the stick).
- Stop cleanly on SIGTERM (the hub kills after 3 s).
- Node built-ins only. Run alone: \`PORT=4100 node server.mjs\`.`
    : `- Files in \`public/\` are served as they are. \`"spa": true\` in app.json sends unknown paths to index.html.
- No server, so no saves. Browser storage (localStorage, IndexedDB) is NOT synced.`;
  return `# ${name}

StickHub app \`${id}\` (engine \`${engine}\`). Made with \`node hub/cli.mjs new\`.

## Rules
${rules}
- Opens full screen in the hub player (an iframe on its own port). Phone first: about 423x930 CSS px, touch, no hover.
- Replace \`icon.svg\` with your own icon (svg, png or webp).
`;
}

/**
 * Create apps/<id>/ from a starter.
 * @param {string} appsDir
 * @param {{id: string, engine: string, name?: string}} o
 * @returns {Promise<{dir: string, files: string[]}>}
 */
export async function createApp(appsDir, o) {
  if (!ID_RE.test(o.id || '')) throw new Error('App id: use a-z, 0-9 and "-" (max 40 characters), e.g. deep-dig');
  if (!SCAFFOLD_ENGINES.includes(o.engine)) throw new Error(`--engine: ${SCAFFOLD_ENGINES.join(' or ')}`);
  const name = (o.name || titleFromId(o.id)).trim().slice(0, 40);
  if (!name) throw new Error('--name is empty');
  const dir = join(appsDir, o.id);
  if (await stat(dir).catch(() => null)) throw new Error(`apps/${o.id} already exists. Nothing was changed.`);

  const manifest = { id: o.id, name, description: '', icon: 'icon.svg', engine: o.engine,
    ...(o.engine === 'node-server' ? { entry: 'server.mjs', port: 'auto' } : { entry: 'public' }), version: '0.1.0' };
  const files = {
    'app.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'icon.svg': placeholderIcon(o.id, name),
    'README.md': readme(o.id, name, o.engine),
    ...(o.engine === 'node-server' ? nodeServerFiles(o.id, name) : staticFiles(name)),
  };
  await mkdir(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), text, { flag: 'wx' });
  }
  return { dir, files: Object.keys(files) };
}
