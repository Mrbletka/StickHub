// Probe 3: how heavy is `termux-usb -l`, and how cheap are the alternatives
// (reading /proc/self/mountinfo, checking the ~/storage links)?

import { readFileSync } from 'node:fs';
import { run, hasCmd, childCpuMs, stats, storageLinks } from './lib.mjs';

/** Average microseconds per call of a cheap sync function. */
function microBench(fn, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return Math.round((performance.now() - t0) * 1000 / n);
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{usbCalls: number}} opts
 */
export async function run3(r, opts) {
  r.section('3. Cost of polling termux-usb -l');
  if (!hasCmd('termux-usb')) {
    r.add('termux-usb', 'not found, skipped');
  } else {
    const wall = [];
    const cpu = [];
    let first = null;
    let failures = 0;
    for (let i = 0; i < opts.usbCalls; i++) {
      const c0 = childCpuMs();
      const res = await run('termux-usb', ['-l'], { timeout: 15_000 });
      const c1 = childCpuMs();
      if (!res.ok) { failures++; if (!first) first = `error: ${res.error} ${res.stderr.trim()}`; continue; }
      if (first === null) first = res.stdout.trim().replace(/\s+/g, ' ');
      wall.push(res.ms);
      if (c0 !== null && c1 !== null) cpu.push(c1 - c0);
    }
    r.add('output', first);
    r.add(`wall ms per call (${opts.usbCalls} calls)`, stats(wall));
    r.add('cpu ms per call in Termux (not counting the Termux:API app)', stats(cpu));
    if (failures) r.add('failed calls', failures);
    const med = stats(wall).med;
    r.add('polling every 3 s', `busy ${Math.round(med / 30 * 10) / 10}% of the time, ${Math.round(stats(cpu).med * 1200 / 1000)} s Termux cpu per hour`);
  }
  // Cheap alternatives that spawn nothing.
  const mi = (() => { try { readFileSync('/proc/self/mountinfo'); return true; } catch { return false; } })();
  r.add('read /proc/self/mountinfo', mi ? `${microBench(() => readFileSync('/proc/self/mountinfo'), 200)} us per read` : 'not readable');
  r.add('check ~/storage links', `${microBench(() => storageLinks(), 200)} us per check`);
}
