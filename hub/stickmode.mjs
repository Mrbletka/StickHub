// Stick mode: run the hub and its apps straight from <stick>/HUB (code HUB/hub, apps HUB/apps, data HUB/data).
// This launcher runs from the phone's git clone (trusted code). It starts stick code only after checking that
// every file in HUB/hub and HUB/apps is exactly a commit the phone's own git knows (same git blob hashes,
// no extra files, no links). Token, settings and logs stay on the phone (~/.stickhub, logs/). No sync is needed
// in this mode: the stick is the live storage.

import { readdir, lstat, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { exists } from './sync/fsx.mjs';
import { readStick, RUNNING_MARK } from './stick.mjs';
import { SyncRun } from './sync/runner.mjs';
import { callHub, hubRunning, stopHub, openLog, HUB_PORT } from './hubctl.mjs';
import { deviceId } from './config.mjs';

export { RUNNING_MARK };
const CODE_DIRS = ['hub', 'apps'];
const MAX_CODE_FILES = 5000;

/** Git's blob hash of a file: sha1("blob <size>\0" + bytes). */
export async function gitBlobHash(file) {
  const buf = await readFile(file);
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// Every entry counts here (no ignore list): an extra file could be run as an app.
async function walk(abs, rel, out, problems) {
  for (const ent of await readdir(abs, { withFileTypes: true })) {
    const r = `${rel}/${ent.name}`;
    if (ent.isSymbolicLink()) problems.push(`${r} is a link`);
    else if (ent.isDirectory()) await walk(join(abs, ent.name), r, out, problems);
    else if (ent.isFile()) {
      if (out.size >= MAX_CODE_FILES) { problems.push('too many code files'); return; }
      out.set(r, join(abs, ent.name));
    } else problems.push(`${r} is not a file`);
  }
}

/**
 * Is the stick's code exactly a commit this phone made?
 * @param {{git: ReturnType<import('./platform/git.mjs').createGit>, hubDir: string, stick: {commit: string|null, codeState: string}}} o
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function verifyStickCode(o) {
  const problems = [];
  if (!(await o.git.available())) return { ok: false, problems: ['Stick mode needs the git clone on the phone, to check the code on the stick.'] };
  if (o.stick.codeState !== 'complete' || !o.stick.commit) {
    return { ok: false, problems: ['The code on the stick is missing or incomplete. Copy it first: node hub/cli.mjs sync run code'] };
  }
  const head = await o.git.head();
  const known = o.stick.commit === head || (await o.git.isAncestor(o.stick.commit, head)) === true;
  const blobs = known ? await o.git.treeBlobs(o.stick.commit, CODE_DIRS) : null;
  if (!blobs) {
    return { ok: false, problems: [`The stick has code (${o.stick.commit.slice(0, 7)}) that this phone did not make. Not started. Copy the phone's code to it: node hub/cli.mjs sync run code`] };
  }
  const files = new Map();
  for (const dir of CODE_DIRS) {
    const abs = join(o.hubDir, dir);
    if (await exists(abs)) await walk(abs, dir, files, problems);
  }
  for (const [rel, sha] of blobs) {
    if (!files.has(rel)) problems.push(`missing on the stick: ${rel}`);
    else if ((await gitBlobHash(files.get(rel))) !== sha) problems.push(`changed on the stick: ${rel}`);
  }
  for (const rel of files.keys()) if (!blobs.has(rel)) problems.push(`not part of the code: ${rel}`);
  return { ok: problems.length === 0, problems: problems.slice(0, 12).concat(problems.length > 12 ? [`… and ${problems.length - 12} more`] : []) };
}

/**
 * Before a start: did the last stick-mode run end with the stick pulled out? Remove its leftover temp files.
 * Only call it while no hub runs from this stick.
 * @returns {Promise<{pulled: object|null, partsRemoved: number}>}
 */
export async function checkAfterPull(hubDir) {
  let pulled = null;
  try {
    pulled = JSON.parse(await readFile(join(hubDir, RUNNING_MARK), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') pulled = { unreadable: e.message };
  }
  if (pulled) await rm(join(hubDir, RUNNING_MARK), { force: true });
  let partsRemoved = 0;
  const sweep = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, ent.name);
      if (ent.isDirectory() && !ent.isSymbolicLink()) await sweep(p);
      else if (ent.isFile() && ent.name.endsWith('.part')) { await rm(p, { force: true }); partsRemoved++; }
    }
  };
  await sweep(join(hubDir, 'data'));
  return { pulled, partsRemoved };
}

/** The error line of a crash log (Node ends it with its version, which says nothing). */
async function errorLine(file) {
  const lines = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n');
  return lines.reverse().find((l) => /error/i.test(l)) || lines[0] || '';
}

/**
 * Start the hub from the stick, ready to open.
 * @param {{root: string, home: string, mount: string, git: object, fsx: object, port?: number, log?: (m: string) => void}} o
 * @returns {Promise<{pid: number|null, already: boolean, steps: string[], ms: number}>}
 */
export async function startStickHub(o) {
  const t0 = Date.now();
  const port = o.port ?? HUB_PORT;
  const steps = [];
  const step = (m) => { steps.push(`${m} (${Date.now() - t0} ms)`); o.log?.(m); };
  let s = await readStick(o.mount, o.fsx);
  if (s.state !== 'ok') throw new Error(s.state === 'blank' ? 'This stick has no HUB yet.' : `Stick problem: ${s.error || s.state}`);

  const ping = await callHub('/api/ping', { port, timeout: 1500 });
  if (ping?.status === 200 && ping.body.mode === 'stick' && ping.body.mount === o.mount) {
    step('the hub already runs from this stick');
    return { pid: ping.body.pid, already: true, steps, ms: Date.now() - t0 };
  }

  // An interrupted phone-copy sync is finished first (its journal is on the stick).
  if (await exists(join(s.hubDir, '.journal.json'))) {
    const run = new SyncRun({ root: o.root, hubDir: s.hubDir, stick: s.info, fsx: o.fsx, git: o.git, device: await deviceId(o.home) });
    const r = await run.run();
    step(`finished an interrupted sync: ${r.result}${r.errors.length ? ` (${r.errors.join('; ')})` : ''}`);
    s = await readStick(o.mount, o.fsx);
  }
  const v = await verifyStickCode({ git: o.git, hubDir: s.hubDir, stick: s.info });
  if (!v.ok) throw Object.assign(new Error(`The code on the stick was not started:\n  ${v.problems.join('\n  ')}`), { problems: v.problems });
  step(`code on the stick checked (${s.info.commit.slice(0, 7)})`);
  const after = await checkAfterPull(s.hubDir);
  if (after.pulled) step(`the stick was pulled out during the last stick-mode run${after.partsRemoved ? `; removed ${after.partsRemoved} unfinished temp file(s)` : '; nothing was half written'}`);

  if (ping) {
    // The phone-copy hub holds the fixed port: stop it (its apps stop cleanly first).
    await stopHub(o.home, port);
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await hubRunning(port))) await new Promise((r) => setTimeout(r, 200));
    if (await hubRunning(port)) throw new Error('The phone hub did not stop. Try: node hub/cli.mjs hub stop');
    step('stopped the phone hub');
  }

  const logFile = join(o.root, 'logs', 'hub-stick.log');
  const fd = openLog(join(o.root, 'logs'), 'hub-stick.log');
  let child;
  try {
    child = spawn(process.execPath, [join(s.hubDir, 'hub', 'server.mjs')], {
      cwd: o.root, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, STICKHUB_MODE: 'stick', STICKHUB_STICK_MOUNT: o.mount, HUB_PORT: String(port) },
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    if (exited !== null) {
      if (!(await exists(join(s.hubDir, 'stick.json')).catch(() => false))) throw new Error('The stick was removed while the hub was starting. Plug it in and try again.');
      throw new Error(`The hub on the stick stopped at once: ${await errorLine(logFile)}`);
    }
    const p = await callHub('/api/ping', { port, timeout: 1000 });
    if (p?.status === 200 && p.body.mode === 'stick') { step('hub running from the stick'); return { pid: child.pid, already: false, steps, ms: Date.now() - t0 }; }
  }
  throw new Error('The hub on the stick did not start within 20 s. See logs/hub-stick.log');
}
