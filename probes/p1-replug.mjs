// Probe 1: what happens on unplug and re-plug?
// Timeline (ms after the prompt): USB device gone/back (termux-usb), volume unmounted/mounted (/proc/self/mountinfo),
// stick root readable and writable again, old ~/storage link working again. Then: does termux-setup-storage help?
// Fast checks (mountinfo, stat) run every 250 ms; the slow termux-usb call runs in its own loop.

import { readdirSync } from 'node:fs';
import { run, hasCmd, ask, sleep, canWrite, storageLinks, linksKey, volumeMounts, volumeRoot } from './lib.mjs';

/** Mount points of removable volumes under /storage, as one string. */
function storageMounts() {
  const vm = volumeMounts();
  if (vm.error) return `unreadable ${vm.error}`;
  return vm.mounts.map((m) => m.mountPoint).filter((p) => volumeRoot(p)).join(' ') || 'none';
}

/** One USB listing as a short string. */
async function usbList() {
  const res = await run('termux-usb', ['-l'], { timeout: 10_000 });
  return res.ok ? res.stdout.replace(/\s+/g, '') : `error ${res.error}`;
}

/**
 * Watch until every named event has fired or limitMs passes.
 * @param {Record<string, () => boolean>} fast  cheap checks, run every 250 ms
 * @param {((usb: string) => boolean)|null} usbDone  check on each termux-usb result (slow loop)
 * @returns {Promise<Record<string, number|null>>} ms when each event first fired, null if never
 */
async function timeline(fast, usbDone, limitMs) {
  const t0 = performance.now();
  const seen = Object.fromEntries([...Object.keys(fast), ...(usbDone ? ['usb'] : [])].map((k) => [k, null]));
  const done = () => Object.values(seen).every((v) => v !== null) || performance.now() - t0 > limitMs;
  const fastLoop = (async () => {
    while (!done()) {
      for (const [k, check] of Object.entries(fast)) if (seen[k] === null && check()) seen[k] = Math.round(performance.now() - t0);
      await sleep(250);
    }
  })();
  const usbLoop = (async () => {
    while (usbDone && !done()) {
      if (usbDone(await usbList()) && seen.usb === null) seen.usb = Math.round(performance.now() - t0);
    }
  })();
  await Promise.all([fastLoop, usbLoop]);
  return seen;
}

/** @param {import('./lib.mjs').Report} r */
export async function run1(r) {
  r.section('1. Unplug and re-plug');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  if ((await ask('Probe 1: you will unplug and re-plug the stick. Keep it plugged in now. Enter = start, s = skip:')) === 's') {
    r.add('skipped', 'by you');
    return;
  }
  const hasUsb = hasCmd('termux-usb');
  const mountsIn = storageMounts();
  const root = mountsIn.split(' ').find((p) => volumeRoot(p)) || null;
  const usbIn = hasUsb ? await usbList() : 'no termux-usb';
  r.add('plugged', { usb: usbIn, mounts: mountsIn, root, links: linksKey() });
  if (!root) { r.add('stopped', 'no stick mounted under /storage. Plug it in and run the probe again.'); return; }
  const stickLink = storageLinks().find((l) => volumeRoot(l.target) === root);

  console.log('\n>>> UNPLUG the stick now. (Waiting up to 60 s.)');
  const out = await timeline({
    unmounted: () => !storageMounts().includes(root),
    rootGone: () => { try { readdirSync(root); return false; } catch { return true; } },
  }, hasUsb ? (u) => u !== usbIn : null, 60_000);
  r.add('unplug timeline (ms)', out);
  r.add('after unplug', { usb: hasUsb ? await usbList() : '-', mounts: storageMounts(), links: linksKey() });
  if (out.unmounted === null) { r.add('stopped', 'the stick did not unmount within 60 s'); return; }

  await sleep(2000);
  console.log('\n>>> PLUG the stick back in now. (Waiting up to 60 s.)');
  const back = await timeline({
    mounted: () => storageMounts().includes(root),
    rootReadable: () => { try { readdirSync(root); return true; } catch { return false; } },
    rootWritable: () => canWrite(root) === 'yes',
    oldLinkWorks: () => !stickLink || storageLinks().some((l) => l.name === stickLink.name && l.reachable),
  }, hasUsb ? (u) => u === usbIn : null, 60_000);
  r.add('re-plug timeline (ms)', back);
  await sleep(1000);
  r.add('after re-plug, no setup-storage', { mounts: storageMounts(), rootWritable: canWrite(root), links: linksKey() });

  if (!hasCmd('termux-setup-storage')) return;
  if ((await ask('Run termux-setup-storage now? It may show a pop-up. Enter = yes, s = skip:')) === 's') return;
  const before = linksKey();
  const t1 = performance.now();
  const res = await run('termux-setup-storage', [], { timeout: 20_000, input: 'y\n' });
  r.add('termux-setup-storage', `${res.ok ? 'exit 0' : `failed: ${res.error}`} in ${Math.round(res.ms)} ms`);
  // The Termux app rebuilds the links after the command returns: wait for the stick's link, not just any change.
  let ms = null;
  while (performance.now() - t1 < 15_000) {
    if (storageLinks().some((l) => volumeRoot(l.target) === root && l.reachable)) { ms = Math.round(performance.now() - t1); break; }
    await sleep(250);
  }
  r.add('stick link after setup-storage', ms === null ? `not back within 15 s (before: ${before}; now: ${linksKey()})` : `back after ${ms} ms: ${linksKey()}`);
  r.add('you saw', await ask('Did a dialog or screen pop up during setup-storage? (y = yes, n = no)') || '(no answer)');
}
