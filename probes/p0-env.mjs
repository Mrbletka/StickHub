// Probe 0: environment facts and where the stick is. Picks the folders the other probes write to.

import { mkdirSync, writeFileSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem, freemem } from 'node:os';
import { hasCmd, storageLinks, volumeMounts, volumeRoot } from './lib.mjs';

const TOOLS = ['termux-usb', 'termux-open-url', 'termux-notification', 'termux-notification-remove', 'termux-toast',
  'termux-clipboard-set', 'termux-wake-lock', 'termux-setup-storage', 'termux-battery-status'];

/**
 * Try to create (and remove) a test file in dir.
 * @returns {string} 'yes' or the error code
 */
function canWrite(dir) {
  const f = join(dir, `.stickhub-probe-${process.pid}.tmp`);
  try { writeFileSync(f, 'x'); rmSync(f); return 'yes'; } catch (e) { return e.code || e.message; }
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{dir?: string}} opts  dir forces the "stick" folder (for testing off the phone)
 * @param {object} ctx  filled in: stickDir, localDir, links
 */
export async function run(r, opts, ctx) {
  r.section('0. Environment');
  r.add('node', process.version);
  r.add('platform', `${process.platform} ${process.arch}, ${cpus().length} cpus`);
  r.add('memory', `${Math.round(freemem() / 1048576)} MB free of ${Math.round(totalmem() / 1048576)} MB`);
  r.add('termux', process.env.TERMUX_VERSION || 'not detected');
  r.add('missing tools', TOOLS.filter((t) => !hasCmd(t)).join(', ') || 'none');

  const links = storageLinks();
  ctx.links = links;
  r.add('storage links', links.map((l) => `${l.name} -> ${l.target} (${l.reachable ? 'ok' : l.error})`).join('; ') || 'none');

  const vm = volumeMounts();
  r.add('volume mounts', vm.error ? `mountinfo unreadable: ${vm.error}`
    : vm.mounts.map((m) => `${m.mountPoint} ${m.fsType} [${m.mountOpts}]`).join('; ') || 'none');

  // Candidate stick roots: from the links (the brief's method) and from mountinfo.
  const roots = new Set();
  for (const l of links) if (l.target && volumeRoot(l.target)) roots.add(volumeRoot(l.target));
  for (const m of vm.mounts) if (volumeRoot(m.mountPoint)) roots.add(m.mountPoint);
  for (const root of roots) {
    let free = '?';
    try { const s = statfsSync(root); free = `${Math.round(s.bavail * s.bsize / 1e9)} GB free of ${Math.round(s.blocks * s.bsize / 1e9)} GB`; } catch (e) { free = e.code; }
    r.add(`root ${root}`, `writable: ${canWrite(root)}, ${free}`);
  }
  for (const l of links) if (l.target && l.reachable) r.add(`app dir ${l.name}`, `writable: ${canWrite(l.target)}`);

  // Where the speed and file-system probes write. The stick's root is where HUB/ will live.
  const stamp = Date.now().toString(36);
  let base = opts.dir || [...roots].find((root) => canWrite(root) === 'yes')
    || links.find((l) => l.reachable && canWrite(l.target) === 'yes')?.target;
  if (base) {
    ctx.stickDir = join(base, `.stickhub-probe-${stamp}`);
    mkdirSync(ctx.stickDir, { recursive: true });
    r.add('stick test dir', ctx.stickDir);
  } else {
    r.add('stick test dir', 'NONE: no writable stick found (is it plugged in? did you run termux-setup-storage?)');
  }
  ctx.localDir = join(process.env.TMPDIR || tmpdir(), `stickhub-probe-${stamp}`);
  mkdirSync(ctx.localDir, { recursive: true });
  r.add('phone test dir', ctx.localDir);
}
