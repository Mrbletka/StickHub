// Probe 8: app data on the stick (dataOnStick). The hub and apps run from the clone; HUB_DATA_DIR is on the stick.
// Measures plug in -> hub open (compare: phone-copy mode 6.6 s), checks that a note lands on the stick,
// pulls the stick (time until the apps stop; the hub must keep running) and plugs it back in.
// Turns on dataOnStick in ~/.stickhub/settings.json for the test only and puts the file back afterwards.

import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, sleep } from './lib.mjs';
import { listVolumes } from '../hub/platform/termux.mjs';
import { findStick } from '../hub/stick.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { callHub, stopHub, hubRunning } from '../hub/hubctl.mjs';
import { stickhubHome } from '../hub/config.mjs';
import { readToken } from '../hub/auth.mjs';
import { runningWatcher, watchCommand } from '../hub/cli-watch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stick = async () => findStick((await listVolumes()).volumes, createFsx());
const ping = async () => { const r = await callHub('/api/ping', { timeout: 800 }); return r?.status === 200 ? r.body : null; };
const logSince = async (file, t0) => (await readFile(join(ROOT, 'logs', file), 'utf8').catch(() => ''))
  .trim().split('\n').filter((l) => Date.parse(l.slice(0, 24)) >= t0 - 1000);

/** Files changed after t (newest first), under dir. */
async function changedSince(dir, t, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await changedSince(p, t, out);
    else if (ent.isFile() && (await stat(p)).mtimeMs >= t) out.push(p);
  }
  return out;
}

/** @param {import('./lib.mjs').Report} r */
export async function run8(r) {
  r.section('8. App data on the stick (dataOnStick)');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  if ((await ask('This turns on dataOnStick for the test and puts your settings back after. Enter = go, s = skip')) === 's') return;
  const home = stickhubHome();
  const settingsFile = join(home, 'settings.json');
  const before = await readFile(settingsFile, 'utf8').catch(() => null);
  const live = async () => {
    const res = await callHub('/api/status', { token: await readToken(home), timeout: 800 });
    return res?.status === 200 ? res.body.live : null;
  };
  try {
    if ((await stick()).state !== 'ok') { r.add('stopped', 'plug in the stick with HUB first'); return; }
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(before || '{}'), dataOnStick: true }));
    if (await hubRunning()) { await stopHub(home); while (await hubRunning()) await sleep(200); r.add('stopped the running hub', 'to measure a cold start'); }
    if (!(await runningWatcher(home))) { await watchCommand('start', ROOT, home); r.add('watcher', 'started'); }

    console.log('\n>>> UNPLUG the stick now. (Waiting up to 60 s.)');
    for (let t = Date.now(); (await stick()).state !== 'none' && Date.now() - t < 60_000;) await sleep(300);
    await sleep(3000);
    await ask('Press Enter, then PLUG the stick in and wait. Come back to Termux when the hub is open.');
    const t0 = Date.now();
    let opened = null;
    while (Date.now() - t0 < 60_000 && opened === null) {
      const p = await ping();
      if (p?.mode === 'data-on-stick' && p.lastLoginAt && Date.parse(p.lastLoginAt) >= t0) opened = Date.parse(p.lastLoginAt) - t0;
      else await sleep(250);
    }
    r.add('plug -> hub open and logged in (ms)', opened ?? 'not within 60 s');
    r.add('watcher log', `\n  ${(await logSince('watcher.log', t0)).join('\n  ') || '(nothing)'}`);
    const l1 = await live();
    r.add('data on the stick', l1?.attached ? `yes (${l1.mount})` : JSON.stringify(l1));

    const tNote = Date.now();
    r.add('notebook', await ask('Open Notebook, write a line in a note, wait for "Saved", come back. Done? (y/n)') || '(no answer)');
    const s = await stick();
    const files = s.state === 'ok' ? await changedSince(join(s.hubDir, 'data', 'notebook'), tNote - 1000) : [];
    r.add('note files changed on the stick', files.length ? files.map((f) => f.slice(s.hubDir.length + 1)).join(', ') : 'none found');

    await ask('Leave the Notebook open, press Enter here, then PULL the stick out. Come back after a few seconds.');
    const t1 = Date.now();
    let gone = null;
    while (Date.now() - t1 < 60_000 && gone === null) { if ((await stick()).state === 'none') gone = Date.now(); else await sleep(100); }
    let l2 = null;
    while (gone && Date.now() - gone < 10_000) { l2 = await live(); if (l2?.removed && l2.stopMs !== null) break; await sleep(100); }
    r.add('pull -> hub saw it (ms after the mount vanished)', l2?.removed && gone ? Date.now() - gone : 'not seen');
    r.add('apps stopped in (ms, measured by the hub)', l2?.stopMs ?? 'unknown');
    r.add('hub still running', (await ping()) ? 'yes' : 'NO');
    r.add('"Stick removed" screen', await ask('Did the hub show "Stick removed"? (y/n)') || '(no answer)');

    await ask('PLUG the stick back in, then press Enter.');
    const t2 = Date.now();
    let l3 = null;
    while (Date.now() - t2 < 60_000) { l3 = await live(); if (l3?.attached) break; await sleep(200); }
    r.add('plug back -> data on the stick again (ms)', l3?.attached ? Date.now() - t2 : 'not within 60 s');
    r.add('pull reported at plug-in', l3?.lastPull ? `yes, ${l3.lastPull.partsRemoved} unfinished temp file(s) removed` : 'no');
    r.add('screen gone, apps not started by themselves', await ask('Is the "Stick removed" screen gone and Notebook stopped until you tap it? (y/n)') || '(no answer)');
  } finally {
    if (before === null) await rm(settingsFile, { force: true }); else await writeFile(settingsFile, before);
    r.add('settings', 'put back as they were');
    if ((await ping())?.mode === 'data-on-stick') { await stopHub(home); r.add('hub', 'stopped (the next start uses your normal settings)'); }
  }
}
