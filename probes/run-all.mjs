// Runs the phone probes, saves the result in probes/out/ (git-ignored) and copies it to the clipboard.
// Usage: node probes/run-all.mjs [--only 0,3,4,5,6,7,8] [--dir <folder>] [--big-mb 64] [--small 500] [--usb-calls 10] [--no-clip]

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report, run, hasCmd } from './lib.mjs';
import * as p0 from './p0-env.mjs';
import { runIn as p5 } from './p5-fs-semantics.mjs';
import { runIn as p4 } from './p4-speed.mjs';
import { run3 } from './p3-usb-poll.mjs';
import { run2 } from './p2-open-url.mjs';
import { run1 } from './p1-replug.mjs';
import { run6 } from './p6-sync.mjs';
import { run7 } from './p7-plug-open.mjs';
import { run8 } from './p8-stick-mode.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Parse the small set of flags this runner knows. Unknown flags stop with an error. */
function parseArgs(argv) {
  const o = { only: null, dir: undefined, bigMb: 64, small: 500, usbCalls: 10, clip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--only') o.only = new Set(val().split(',').map(Number));
    else if (a === '--dir') o.dir = val();
    else if (a === '--big-mb') o.bigMb = Math.max(1, Number(val()) | 0);
    else if (a === '--small') o.small = Math.max(1, Number(val()) | 0);
    else if (a === '--usb-calls') o.usbCalls = Math.max(1, Number(val()) | 0);
    else if (a === '--no-clip') o.clip = false;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Run one probe; an error is written into the report and the next probe still runs. */
async function step(r, n, opts, fn) {
  if (opts.only && !opts.only.has(n)) return;
  try { await fn(); } catch (e) { r.add(`probe ${n} crashed`, e.stack || String(e)); }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = new Report();
  r.add(`# StickHub probes ${new Date().toISOString()}`);
  const ctx = {};
  await p0.run(r, opts, ctx); // always: it picks the test folders
  try {
    await step(r, 5, opts, async () => {
      if (ctx.stickDir) { const d = join(ctx.stickDir, 'fs'); mkdirSync(d); await p5(r, d, 'stick'); }
    });
    await step(r, 4, opts, async () => {
      const size = { bigMb: opts.bigMb, small: opts.small };
      if (ctx.stickDir) { const d = join(ctx.stickDir, 'speed'); mkdirSync(d); await p4(r, d, 'stick', size); }
      const d = join(ctx.localDir, 'speed'); mkdirSync(d); await p4(r, d, 'phone, for comparison', size);
    });
  } finally {
    // Remove our temp folders before probe 1 asks you to pull the stick.
    for (const d of [ctx.stickDir, ctx.localDir]) {
      if (!d) continue;
      try { rmSync(d, { recursive: true, force: true }); } catch (e) { r.add('cleanup failed', `${d}: ${e.code || e.message}`); }
    }
  }
  await step(r, 3, opts, () => run3(r, opts));
  await step(r, 2, opts, () => run2(r));
  await step(r, 1, opts, () => run1(r));
  await step(r, 6, opts, () => run6(r));
  await step(r, 7, opts, () => run7(r));
  await step(r, 8, opts, () => run8(r));

  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `result-${Date.now()}.txt`);
  writeFileSync(file, r.toString());
  console.log(`\nSaved: ${file}`);
  if (opts.clip && hasCmd('termux-clipboard-set')) {
    const res = await run('termux-clipboard-set', [], { timeout: 10_000, input: r.toString() });
    console.log(res.ok ? 'Copied to the clipboard. Paste it into the chat.' : `Clipboard failed (${res.error}). Run: termux-clipboard-set < ${file}`);
  }
  // A probe may leave a stuck file operation behind (e.g. a pulled stick): do not wait for it.
  process.exit(0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exitCode = 1; });
