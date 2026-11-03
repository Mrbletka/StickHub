// Probe 2: can a Termux process open the browser while Termux is in the background?
// A tiny local server records which test URL the browser actually loaded, so no guessing.
// A: foreground (control)  B: background, after a delay  C: notification with a tap action (the fallback).

import { createServer } from 'node:http';
import { run, hasCmd, ask, waitFor, sleep } from './lib.mjs';

const PAGE = '<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#000;color:#8f8;font:20px sans-serif;padding:24px">'
  + 'StickHub probe: page opened. Go back to Termux.</body>';

/** Start the recorder on the first free port from 8790. */
async function startRecorder() {
  const hits = new Map();
  const server = createServer((req, res) => {
    const tag = (req.url || '').split('?')[0].split('/')[2] || '';
    if (!hits.has(tag)) hits.set(tag, performance.now());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  for (let port = 8790; port < 8800; port++) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, hits, base: `http://127.0.0.1:${port}/probe` };
  }
  throw new Error('no free port 8790-8799');
}

/** Wait until the browser loads /probe/<tag>; returns ms after `since`, or null. */
async function waitHit(hits, tag, since, limitMs) {
  const res = await waitFor(() => hits.get(tag), limitMs, 250);
  return res.value ? Math.round(res.value - since) : null;
}

/** @param {import('./lib.mjs').Report} r */
export async function run2(r) {
  r.section('2. Opening the browser from Termux');
  if (!hasCmd('termux-open-url')) { r.add('termux-open-url', 'not found, skipped'); return; }
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  const { server, hits, base } = await startRecorder();
  try {
    // A: control, Termux in front.
    if ((await ask('2A: Press Enter. Chrome should open a black page. Then come back to Termux. (s = skip)')) !== 's') {
      const t0 = performance.now();
      const res = await run('termux-open-url', [`${base}/A?t=${Date.now()}`], { timeout: 10_000 });
      const ms = await waitHit(hits, 'A', t0, 20_000);
      r.add('A foreground', `${res.ok ? 'command ok' : `command failed: ${res.error}`}; page ${ms === null ? 'NOT opened in 20 s' : `opened after ${ms} ms`}`);
      await ask('Back in Termux? Press Enter.');
    }
    // B: Termux in the background, like the watcher will be.
    if ((await ask('2B: Press Enter, then go to the HOME SCREEN within 10 s and wait. Come back to Termux after Chrome opens or after 40 s. (s = skip)')) !== 's') {
      await sleep(12_000);
      const t0 = performance.now();
      const res = await run('termux-open-url', [`${base}/B?t=${Date.now()}`], { timeout: 10_000 });
      const ms = await waitHit(hits, 'B', t0, 30_000);
      r.add('B background', `${res.ok ? 'command ok' : `command failed: ${res.error}`}; page ${ms === null ? 'NOT opened in 30 s' : `opened after ${ms} ms`}`);
      const seen = await ask('2B: What did you see? (c = Chrome opened by itself, p = a permission pop-up, n = nothing)');
      r.add('B you saw', seen || '(no answer)');
    }
    // C: fallback, a notification with a tap action.
    if (hasCmd('termux-notification') && (await ask('2C: Press Enter. Then pull down the notifications and tap "StickHub probe". (s = skip)')) !== 's') {
      const t0 = performance.now();
      const res = await run('termux-notification', ['--id', 'stickhub-probe', '--title', 'StickHub probe',
        '--content', 'Tap to open the test page', '--action', `termux-open-url ${base}/C?t=${Date.now()}`], { timeout: 10_000 });
      const ms = await waitHit(hits, 'C', t0, 60_000);
      r.add('C notification tap', `${res.ok ? 'notification shown' : `notification failed: ${res.error}`}; page ${ms === null ? 'NOT opened in 60 s' : `opened ${ms} ms after it was shown`}`);
      await run('termux-notification-remove', ['stickhub-probe'], { timeout: 5_000 });
      await ask('Back in Termux? Press Enter.');
    }
  } finally {
    server.close();
  }
}
