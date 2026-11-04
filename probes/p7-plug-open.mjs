// Probe 7: phase 3 end to end. Time from plugging in the stick to the hub page being open and logged in
// (the page redeems its one-time code, the hub records when). Then a few questions about what you saw.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, sleep } from './lib.mjs';
import { listVolumes } from '../hub/platform/termux.mjs';
import { findStick } from '../hub/stick.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { callHub } from '../hub/hubctl.mjs';
import { stickhubHome } from '../hub/config.mjs';
import { runningWatcher, watchCommand } from '../hub/cli-watch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const stickState = async () => (await findStick((await listVolumes()).volumes, createFsx())).state;
const lastLogin = async () => {
  const r = await callHub('/api/ping', { timeout: 1000 });
  return r?.status === 200 && r.body.lastLoginAt ? Date.parse(r.body.lastLoginAt) : null;
};

/** @param {import('./lib.mjs').Report} r */
export async function run7(r) {
  r.section('7. Plug in -> hub open (phase 3)');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  const home = stickhubHome();
  if (!(await runningWatcher(home))) {
    await watchCommand('start', ROOT, home);
    r.add('watcher', 'was not running: started it');
  } else r.add('watcher', 'running');

  if ((await stickState()) !== 'none') {
    console.log('\n>>> UNPLUG the stick now. (Waiting up to 60 s.)');
    const t = Date.now();
    while ((await stickState()) !== 'none' && Date.now() - t < 60_000) await sleep(500);
    if ((await stickState()) !== 'none') { r.add('stopped', 'the stick was not unplugged'); return; }
  }
  await sleep(3000); // let the watcher see it gone
  await ask('Press Enter, then PLUG the stick in right away and wait. Come back to Termux when the hub is open.');
  const t0 = Date.now();
  let at = null;
  while (Date.now() - t0 < 40_000) {
    const l = await lastLogin();
    if (l && l >= t0) { at = l; break; }
    await sleep(250);
  }
  r.add('plug -> hub open and logged in (ms)', at ? at - t0 : 'not within 40 s');
  const log = await readFile(join(ROOT, 'logs', 'watcher.log'), 'utf8').catch(() => '');
  const lines = log.trim().split('\n').filter((l) => Date.parse(l.slice(0, 24)) >= t0 - 1000);
  r.add('watcher log', lines.length ? `\n  ${lines.join('\n  ')}` : '(nothing new)');

  r.add('opened as', await ask('How did it open? a = installed StickHub app (no browser bar), t = Chrome tab, n = nothing') || '(no answer)');
  r.add('player', await ask('In the hub, tap Tap Counter. Full screen with a small round Home button? (y/n)') || '(no answer)');
  r.add('back = home', await ask('Inside the app, use the Android back gesture. Did it go back to the tiles? (y/n)') || '(no answer)');
  r.add('home button', await ask('Open it again and tap the round Home button. Back to the tiles? (y/n)') || '(no answer)');
  r.add('offline page', await ask('Run "node hub/cli.mjs hub stop" in a new Termux session, then reopen StickHub. "Hub is not running" page? (y/n/s = skipped)') || '(no answer)');
}
