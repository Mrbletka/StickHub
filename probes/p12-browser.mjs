// Probe 12, part 1: does Chrome on the phone honour Clear-Site-Data on http://127.0.0.1:<port> (design 8.5)?
// Done the way the hub does it: a page on one port (like the hub page) shows an app frame from another port (like
// the player); the app frame stores a value in localStorage; one tap, then the page loads the app's /__hub/clear in a
// hidden sandboxed frame (hub/ui/clear.js, the same file), and the app frame reads localStorage again. The app side
// answers /__hub/clear with hubRoutes() from hub/appkit/hubfs.mjs, as every app does. Two throwaway servers on
// random ports; nothing is written to the disk.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hubRoutes } from '../hub/appkit/hubfs.mjs';

const CLEAR_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'ui', 'clear.js');

const listen = (server) => new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res(server.address().port)); });
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };

/** The app frame: "set" stores the value, every mode reports what localStorage holds. */
const framePage = (value) => `<!doctype html><meta charset="utf-8"><body style="background:#123;color:#fff;font:16px sans-serif">
<script>
const mode = new URLSearchParams(location.search).get('mode');
let v = null;
try { if (mode === 'set') localStorage.setItem('p12', ${JSON.stringify(value)}); v = localStorage.getItem('p12'); } catch (e) { v = 'ERROR ' + e.name; }
document.body.textContent = 'app frame: ' + mode + ' = ' + v;
fetch('/report?stage=' + mode + '&v=' + encodeURIComponent(JSON.stringify(v)));
</script>`;

/** The hub-like page: the app frame, one button, the hidden clear frame. */
const hubPage = (appUrl) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StickHub probe 12</title>
<body style="background:#000;color:#eee;font:18px system-ui,sans-serif;padding:16px">
<h2>StickHub probe 12</h2>
<p>Wait one second, then tap the green button once.</p>
<button id="go" style="font-size:22px;padding:18px 28px;border-radius:14px;border:0;background:#5df2a0;color:#002814">Tap here</button>
<p id="out"></p>
<iframe id="f" src="${appUrl}frame?mode=set" style="width:100%;height:80px;border:1px solid #333"></iframe>
<script type="module">
import { clearAppStorage } from '/clear.js';
const f = document.getElementById('f');
const out = document.getElementById('out');
const frame = (mode) => new Promise((done) => { f.addEventListener('load', done, { once: true }); f.src = '${appUrl}frame?mode=' + mode; });
document.getElementById('go').addEventListener('click', async () => {
  out.textContent = 'Running...';
  await frame('before');
  await clearAppStorage([{ id: 'probe', url: '${appUrl}' }]);
  await frame('after');
  out.textContent = 'Done. Go back to Termux.';
}, { once: true });
</script>`;

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{open: (url: string) => Promise<{ok: boolean, error?: string}>, waitMs?: number, say?: (s: string) => void}} o
 *   open: opens the page (termux-open-url); waitMs: how long to wait for the tap (default 120 s)
 */
export async function browserCheck(r, o) {
  const value = `probe12-${randomBytes(4).toString('hex')}`;
  const seen = {};
  let wake = () => {};
  const app = createServer((req, res) => {
    if (hubRoutes(req, res)) return;
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/frame') return html(res, framePage(value));
    if (u.pathname === '/report') {
      try { seen[u.searchParams.get('stage')] = JSON.parse(u.searchParams.get('v')); } catch { seen.bad = true; }
      res.end('ok');
      wake();
      return undefined;
    }
    res.statusCode = 404;
    return res.end();
  });
  const hub = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/clear.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await readFile(CLEAR_JS));
    }
    if (u.pathname === '/') return html(res, hubPage(appUrl));
    res.statusCode = 404;
    return res.end();
  });
  const appUrl = `http://127.0.0.1:${await listen(app)}/`;
  const pageUrl = `http://127.0.0.1:${await listen(hub)}/`;
  try {
    (o.say || console.log)('\n>>> Chrome opens a test page: wait a second, tap the green button once, then come back to Termux.');
    const opened = await o.open(pageUrl);
    if (!opened.ok) { r.add('Clear-Site-Data: page', `could not open it (${opened.error}); not measured`); return; }
    const end = Date.now() + (o.waitMs ?? 120_000);
    while (!('after' in seen) && Date.now() < end) await new Promise((res) => { wake = res; setTimeout(res, 500); });
    r.add('Clear-Site-Data: app frame stored a value (control)', seen.set === value ? 'yes' : `NO (${JSON.stringify(seen.set ?? 'no answer')})`);
    r.add('Clear-Site-Data: value still there before the clear (control)', seen.before === value ? 'yes' : `NO (${JSON.stringify(seen.before ?? 'no answer')})`);
    if (!('after' in seen)) r.add('Clear-Site-Data honoured', 'NO ANSWER: the button was not tapped in time, or the page did not open');
    else r.add('Clear-Site-Data honoured (localStorage gone after the hidden frame)', seen.after === null ? 'YES' : `NO (still ${JSON.stringify(seen.after)})`);
  } finally {
    for (const s of [app, hub]) { s.closeAllConnections(); s.close(); }
  }
}
