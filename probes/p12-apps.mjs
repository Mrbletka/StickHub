// Probe 12: the vault wired into the hub (job 3b+3c). Part 1 (p12-browser.mjs): does Chrome honour Clear-Site-Data on
// http://127.0.0.1:<port>, done the way the hub does it (one tap). Part 2 (p12-vault.mjs): vault costs through hubfs
// on the phone's storage and on the stick. Temp files only in the probe's own folders (probe 0's test folders and
// one temp folder for the sockets); never a real vault, never ~/.stickhub/run.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, hasCmd } from './lib.mjs';
import { browserCheck } from './p12-browser.mjs';
import { measureVault, measurePlain } from './p12-vault.mjs';

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{stickDir?: string, localDir: string}} ctx  probe 0's test folders
 */
export async function run12(r, ctx) {
  r.section('12. The vault in the hub: Clear-Site-Data in Chrome, vault costs through hubfs');
  if (hasCmd('termux-open-url')) {
    await browserCheck(r, { open: (url) => run('termux-open-url', [url], { timeout: 10_000 }) });
  } else {
    r.add('Clear-Site-Data', 'termux-open-url not found: not measured');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'p12-'));
  try {
    await measureVault(r, 'phone', ctx.localDir, join(tmp, 'run'));
    await measurePlain(r, 'phone', ctx.localDir);
    if (ctx.stickDir) {
      await measureVault(r, 'stick', ctx.stickDir, join(tmp, 'run'));
      await measurePlain(r, 'stick', ctx.stickDir);
    } else {
      r.add('stick', 'NO STICK PLUGGED IN: nothing was measured on the stick. Plug it in and run again for those numbers.');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
