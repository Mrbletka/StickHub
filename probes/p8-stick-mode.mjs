// Probe 8: stick mode on the real stick. Plug in -> hub open from the stick (compare: phone-copy mode 6.6 s),
// then pull the stick while it runs: how fast the apps stop, and what the next plug-in reports.
// Turns on runFromStick in ~/.stickhub/settings.json for the test only and puts the file back afterwards.

import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, sleep } from './lib.mjs';
import { listVolumes } from '../hub/platform/termux.mjs';
import { createGit } from '../hub/platform/git.mjs';
import { findStick } from '../hub/stick.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { SyncRun } from '../hub/sync/runner.mjs';
import { callHub, stopHub, hubRunning } from '../hub/hubctl.mjs';
import { stickhubHome, deviceId } from '../hub/config.mjs';
import { verifyStickCode } from '../hub/stickmode.mjs';
import { runningWatcher, watchCommand } from '../hub/cli-watch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stick = async () => findStick((await listVolumes()).volumes, createFsx());
const ping = async () => { const r = await callHub('/api/ping', { timeout: 800 }); return r?.status === 200 ? r.body : null; };
const logSince = async (file, t0) => (await readFile(join(ROOT, 'logs', file), 'utf8').catch(() => ''))
  .trim().split('\n').filter((l) => Date.parse(l.slice(0, 24)) >= t0 - 1000);

/** @param {import('./lib.mjs').Report} r */
export async function run8(r) {
  r.section('8. Stick mode (hub and apps run from the stick)');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  if ((await ask('This turns on runFromStick for the test and puts your settings back after. Enter = go, s = skip')) === 's') return;
  const home = stickhubHome();
  const settingsFile = join(home, 'settings.json');
  const before = await readFile(settingsFile, 'utf8').catch(() => null);
  try {
    let s = await stick();
    if (s.state !== 'ok') { r.add('stopped', 'plug in the stick with HUB first'); return; }
    const git = createGit(ROOT);
    if (!(await verifyStickCode({ git, hubDir: s.hubDir, stick: s.info })).ok) {
      const run = await new SyncRun({ root: ROOT, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git, device: await deviceId(home), what: { code: true } }).run();
      r.add('copied the phone code to the stick first', `${run.result}, ${run.copied} files`);
      s = await stick();
    }
    const v = await verifyStickCode({ git, hubDir: s.hubDir, stick: s.info });
    r.add('code check', v.ok ? `ok (${s.info.commit.slice(0, 7)})` : v.problems.join('; '));
    if (!v.ok) return;
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(before || '{}'), runFromStick: true }));
    if (await hubRunning()) { await stopHub(home); while (await hubRunning()) await sleep(200); r.add('stopped the running hub', 'to measure a cold start'); }
    if (!(await runningWatcher(home))) { await watchCommand('start', ROOT, home); r.add('watcher', 'started'); }

    console.log('\n>>> UNPLUG the stick now. (Waiting up to 60 s.)');
    for (let t = Date.now(); (await stick()).state !== 'none' && Date.now() - t < 60_000;) await sleep(300);
    await sleep(3000);
    await ask('Press Enter, then PLUG the stick in and wait. Come back to Termux when the hub is open.');
    const t0 = Date.now();
    let opened = null;
    while (Date.now() - t0 < 60_000 && !opened) {
      const p = await ping();
      if (p?.mode === 'stick' && p.lastLoginAt && Date.parse(p.lastLoginAt) >= t0) opened = Date.parse(p.lastLoginAt) - t0;
      else await sleep(250);
    }
    r.add('plug -> hub open from the stick, logged in (ms)', opened ?? 'not within 60 s');
    r.add('watcher log', `\n  ${(await logSince('watcher.log', t0)).join('\n  ') || '(nothing)'}`);
    r.add('notebook from stick', await ask('Open Notebook and write a line. Did it work? (y/n)') || '(no answer)');

    await ask('Now PULL the stick out while the hub is open, then come back. Press Enter first.');
    const t1 = Date.now();
    let gone = null;
    while (Date.now() - t1 < 60_000 && gone === null) { if ((await stick()).state === 'none') gone = Date.now(); else await sleep(100); }
    let hubGone = null;
    while (gone && Date.now() - gone < 10_000 && hubGone === null) { if (!(await ping())) hubGone = Date.now(); else await sleep(100); }
    const log = await readFile(join(ROOT, 'logs', 'hub-stick.log'), 'utf8').catch(() => '');
    r.add('pull -> hub stopped (ms after the mount vanished)', hubGone && gone ? hubGone - gone : 'not seen');
    const last = [...log.matchAll(/apps stopped in (\d+) ms/g)].pop();
    r.add('apps stopped in (ms, from the hub log)', last ? Number(last[1]) : '(not in logs/hub-stick.log)');
    r.add('"Stick removed" screen', await ask('Did the hub show "Stick removed"? (y/n)') || '(no answer)');

    await ask('PLUG the stick back in and wait for the hub. Then press Enter.');
    const t2 = Date.now();
    await sleep(1000);
    r.add('next plug-in', `\n  ${(await logSince('watcher.log', t2 - 30_000)).filter((l) => /stick mode|pulled|temp file/.test(l)).join('\n  ') || '(nothing about the pull)'}`);
  } finally {
    if (before === null) await rm(settingsFile, { force: true }); else await writeFile(settingsFile, before);
    r.add('settings', 'put back as they were');
    if ((await ping())?.mode === 'stick') { await stopHub(home); r.add('hub', 'stopped the stick-mode hub (next start is phone copy again)'); }
  }
}
