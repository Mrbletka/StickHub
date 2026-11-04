// Probe 6: phase 2 sync on the real stick. Measures a full sync, a data sync of 120 files, a cancel,
// an unplug in the middle of a sync (and the resume after it), then cleans up its test files.
// Test files live in data/stickhub-probe/ on the phone; at the end they go to the stick's .trash.

import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, sleep } from './lib.mjs';
import { listVolumes } from '../hub/platform/termux.mjs';
import { createGit } from '../hub/platform/git.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { findStick, initStick } from '../hub/stick.mjs';
import { SyncRun } from '../hub/sync/runner.mjs';
import { deviceId } from '../hub/config.mjs';
import { isPortFree } from '../hub/ports.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_APP = 'stickhub-probe';
const N = 120;

async function stick() {
  const { volumes } = await listVolumes();
  return findStick(volumes, createFsx());
}

/** Write N random files (2-20 KB) into data/stickhub-probe/. */
async function writeTestFiles(count = N) {
  const dir = join(ROOT, 'data', TEST_APP);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) await writeFile(join(dir, `f${i}.bin`), randomBytes(2048 + Math.floor(Math.random() * 18432)));
}

/** One sync run with timing. onProgress may return 'cancel'. */
async function sync(s, device, what, onProgress) {
  const run = new SyncRun({ root: ROOT, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git: createGit(ROOT), device,
    what: { data: what !== 'code', code: what !== 'data' } });
  run.on('progress', (p) => { if (onProgress?.(p) === 'cancel') run.cancel(); });
  const t0 = performance.now();
  const r = await run.run();
  return { ...r, ms: Math.round(performance.now() - t0) };
}

const short = (r) => ({ result: r.result, resumed: r.resumed, copied: r.copied, trashed: r.trashed, ms: r.ms,
  code: r.code?.state, pending: r.pending, skipped: r.skipped.length, errors: r.errors });

/** @param {import('./lib.mjs').Report} r */
export async function run6(r) {
  r.section('6. Sync on the real stick (phase 2)');
  if (!process.stdin.isTTY) { r.add('skipped', 'needs you at the phone (no terminal)'); return; }
  if (!(await isPortFree(8787))) { r.add('stopped', 'the hub is running. Stop it (Ctrl+C in its window) and run this again.'); return; }
  let s = await stick();
  if (s.state === 'none') { r.add('stopped', 'no stick found. Plug it in and run again.'); return; }
  if (s.state === 'blank') {
    if ((await ask(`The stick (${s.mount}) has no HUB yet. Create HUB/ there now? (y = yes)`)) !== 'y') { r.add('stopped', 'no HUB, not created'); return; }
    const info = await initStick(s.mount, { name: 'My stick' });
    r.add('stick init', `created HUB/stick.json (${info.id})`);
    s = await stick();
  }
  if (s.state !== 'ok') { r.add('stopped', `stick problem: ${s.error}`); return; }
  const device = await deviceId();
  r.add('stick', `${s.info.name} (${s.info.id}), code ${s.info.commit?.slice(0, 7) || 'none'} ${s.info.codeState}`);

  const full = await sync(s, device, 'all');
  r.add('A full sync (code + data)', short(full));
  s = await stick();

  await writeTestFiles();
  const data = await sync(s, device, 'data');
  r.add(`B ${N} new files to the stick`, { ...short(data), msPerFile: Math.round(data.ms / Math.max(1, data.copied)) });

  await writeTestFiles(40);
  const cancelled = await sync(s, device, 'data', (p) => (p.phase === 'data' && p.done >= 10 ? 'cancel' : null));
  const after = await sync(s, device, 'data');
  r.add('C cancel after 10 files', short(cancelled));
  r.add('C next sync finishes', short(after));

  if ((await ask('D: unplug test. Enter = start, s = skip. When you see "UNPLUG NOW", pull the stick out.')) !== 's') {
    await writeTestFiles();
    let told = false;
    const running = sync(s, device, 'data', (p) => {
      if (!told && p.phase === 'data' && p.done >= 15) { told = true; console.log('\n>>> UNPLUG NOW <<<\n'); }
    });
    const res = await Promise.race([running, sleep(90_000).then(() => null)]);
    r.add('D sync when unplugged', res ? short(res) : 'did not stop within 90 s after start (hang?)');
    console.log('\n>>> PLUG the stick back in. (Waiting up to 60 s.)');
    const t0 = Date.now();
    let back = null;
    while (Date.now() - t0 < 60_000 && !back) {
      const x = await stick();
      if (x.state === 'ok' && x.info.id === s.info.id) back = x;
      else await sleep(500);
    }
    if (!back) { r.add('D stopped', 'stick not back within 60 s'); return; }
    r.add('D stick back after (ms)', Date.now() - t0);
    await sleep(1000);
    const resumed = await sync(back, device, 'data');
    r.add('D sync after re-plug', short(resumed));
    const check = await sync(back, device, 'data');
    r.add('D one more sync (should copy 0)', short(check));
    const left = (await readdir(join(back.hubDir, 'data', TEST_APP)).catch(() => [])).filter((n) => n.endsWith('.part'));
    r.add('D leftover .part files', left.length);
    s = back;
  }

  await rm(join(ROOT, 'data', TEST_APP), { recursive: true, force: true });
  const clean = await sync(s, device, 'data');
  r.add('E test files removed (moved to the stick .trash)', short(clean));
}
