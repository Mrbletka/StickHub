// Probe 1: what happens on unplug and re-plug, and does `termux-setup-storage` refresh the ~/storage links?
// Records a timeline: when the USB device shows up, when the volume is mounted, when the links work again.

import { run, hasCmd, ask, waitFor, sleep, storageLinks, linksKey, volumeMounts } from './lib.mjs';

/** Snapshot of everything we can see about the stick, without spawning anything except termux-usb. */
async function snapshot() {
  const usb = hasCmd('termux-usb') ? await run('termux-usb', ['-l'], { timeout: 10_000 }) : null;
  const vm = volumeMounts();
  return {
    usb: usb ? (usb.ok ? usb.stdout.trim().replace(/\s+/g, ' ') : `error ${usb.error}`) : 'no termux-usb',
    mounts: vm.error ? `unreadable ${vm.error}` : vm.mounts.map((m) => m.mountPoint).join(' ') || 'none',
    links: linksKey(),
  };
}

/** @param {import('./lib.mjs').Report} r */
export async function run1(r) {
  r.section('1. Unplug and re-plug');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  if ((await ask('Probe 1 needs you to unplug and re-plug the stick. Enter = start, s = skip:')) === 's') {
    r.add('skipped', 'by you');
    return;
  }
  const plugged = await snapshot();
  r.add('plugged', plugged);

  await ask('UNPLUG the stick now. Wait 5 s, then press Enter.');
  const out = await snapshot();
  r.add('unplugged', out);

  await ask('Press Enter, then PLUG the stick back in right away.');
  const t0 = performance.now();
  const seen = { usb: null, mounts: null, links: null };
  await waitFor(async () => {
    const s = await snapshot();
    const t = Math.round(performance.now() - t0);
    for (const k of Object.keys(seen)) if (seen[k] === null && s[k] !== out[k]) seen[k] = { ms: t, now: s[k] };
    return seen.usb && seen.mounts && seen.links;
  }, 40_000, 1000);
  r.add('after plug-in, first change seen (ms from Enter)', seen);
  const before = linksKey();
  r.add('links before setup-storage', before);
  r.add('links work without setup-storage', storageLinks().every((l) => l.reachable) ? 'yes' : 'no');

  if (!hasCmd('termux-setup-storage')) { r.add('termux-setup-storage', 'not found'); return; }
  r.add('note', 'running termux-setup-storage (answers "y" to its question)');
  const t1 = performance.now();
  const res = await run('termux-setup-storage', [], { timeout: 20_000, input: 'y\n' });
  r.add('termux-setup-storage', `${res.ok ? 'exit 0' : `failed: ${res.error}`} in ${Math.round(res.ms)} ms; said: ${(res.stdout + res.stderr).trim().replace(/\s+/g, ' ').slice(0, 300)}`);
  // The links are rebuilt by the Termux app after the command returns, so watch for a change for a while.
  const changed = await waitFor(() => (linksKey() !== before ? linksKey() : null), 15_000, 250);
  r.add('links after setup-storage', changed.value
    ? `changed after ${Math.round(performance.now() - t1)} ms: ${changed.value}`
    : `no change within 15 s: ${linksKey()}`);
  await sleep(2000); // the rebuild may still be in progress right after the first change
  r.add('links 2 s later', linksKey());
  r.add('all links work now', storageLinks().every((l) => l.reachable) ? 'yes' : 'no');
  r.add('you saw', await ask('Did a dialog or screen pop up during setup-storage? (y/n)') || '(no answer)');
}
