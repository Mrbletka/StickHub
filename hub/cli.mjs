// StickHub command line.
//   node hub/cli.mjs stick status
//   node hub/cli.mjs stick init [--name "My stick"] [--mount <dir>] [--force]
//   node hub/cli.mjs sync plan [all|data|code] [--mount <dir>]
//   node hub/cli.mjs sync run  [all|data|code] [--mount <dir>]
//   node hub/cli.mjs code pull-from-stick [--yes] [--mount <dir>]

import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVolumes } from './platform/termux.mjs';
import { createGit } from './platform/git.mjs';
import { createFsx } from './sync/fsx.mjs';
import { findStick, readStick, initStick } from './stick.mjs';
import { SyncRun } from './sync/runner.mjs';
import { pullCode } from './sync/pull-code.mjs';
import { deviceId } from './config.mjs';
import { HUB_PORT } from './server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = `Usage:
  node hub/cli.mjs stick status
  node hub/cli.mjs stick init [--name "My stick"] [--mount <dir>] [--force]
  node hub/cli.mjs sync plan [all|data|code] [--mount <dir>]
  node hub/cli.mjs sync run  [all|data|code] [--mount <dir>]
  node hub/cli.mjs code pull-from-stick [--yes] [--mount <dir>]`;

/** Split argv into words and --flags. */
function parse(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '--yes') flags[a.slice(2)] = true;
    else if (a === '--name' || a === '--mount') {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`Unknown option ${a}`);
    else words.push(a);
  }
  return { words, flags };
}

class UsageError extends Error {}

/** The stick to use: --mount, else the first volume with a valid HUB. */
async function pickStick(flags) {
  const fsx = createFsx();
  if (flags.mount) {
    const r = await readStick(flags.mount, fsx);
    if (r.state !== 'ok') throw new Error(`${flags.mount}: ${r.state === 'blank' ? 'no HUB/stick.json (run: stick init)' : r.error || 'not found'}`);
    return { mount: flags.mount, ...r };
  }
  const { volumes, error } = await listVolumes();
  if (error) console.warn(`warning: ${error}`);
  const s = await findStick(volumes, fsx);
  if (s.state === 'none') throw new Error('No stick found. Plug it in (or pass --mount <dir>).');
  if (s.state === 'blank') throw new Error(`The stick at ${s.mount} has no HUB yet. Run: node hub/cli.mjs stick init`);
  if (s.state === 'bad') throw new Error(`The stick at ${s.mount} has a broken HUB/stick.json: ${s.error}`);
  return s;
}

/** Ids of apps the running hub has started (empty if the hub is not running). */
function runningApps() {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: HUB_PORT, path: '/api/apps', timeout: 1500,
      headers: { host: `127.0.0.1:${HUB_PORT}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(new Set(JSON.parse(body).filter((a) => a.status !== 'stopped' && a.status !== 'error').map((a) => a.id))); } catch { resolve(new Set()); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(new Set()); });
    req.on('error', () => resolve(new Set())); // hub not running: no app runs
    req.end();
  });
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function stickStatus() {
  const { volumes, error } = await listVolumes();
  if (error) console.warn(`warning: ${error}`);
  if (!volumes.length) return console.log('No stick plugged in.');
  for (const v of volumes) {
    const r = await readStick(v.mountPoint);
    const what = r.state === 'ok' ? `"${r.info.name}" (${r.info.id}), code ${r.info.commit?.slice(0, 7) || 'none'} ${r.info.codeState}`
      : r.state === 'blank' ? 'no HUB yet (run: node hub/cli.mjs stick init)' : `${r.state}${r.error ? `: ${r.error}` : ''}`;
    console.log(`${v.mountPoint}: ${what}`);
  }
}

async function stickInit(flags) {
  let mount = flags.mount;
  if (!mount) {
    const { volumes } = await listVolumes();
    if (volumes.length !== 1) {
      throw new Error(volumes.length ? `More than one volume: pick one with --mount (${volumes.map((v) => v.mountPoint).join(', ')})` : 'No stick found. Plug it in (or pass --mount <dir>).');
    }
    mount = volumes[0].mountPoint;
  }
  const info = await initStick(mount, { name: flags.name, force: flags.force });
  console.log(`Created ${join(mount, 'HUB', 'stick.json')}: "${info.name}" (${info.id}). Now run: node hub/cli.mjs sync run`);
}

async function sync(mode, what, flags) {
  if (!['all', 'data', 'code'].includes(what)) throw new UsageError(`sync ${mode}: say all, data or code`);
  const s = await pickStick(flags);
  const running = await runningApps();
  const run = new SyncRun({ root: ROOT, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git: createGit(ROOT), device: await deviceId(),
    running: () => running, what: { data: what !== 'code', code: what !== 'data' } });
  run.on('warn', (w) => console.warn(`warning: ${w}`));
  if (mode === 'plan') {
    const r = await run.run({ dry: true });
    if (r.code) console.log(`Code: ${r.code.message}`);
    for (const op of r.plan.code) console.log(`  code ${op.op === 'put' ? 'copy ' : 'trash'} ${op.rel}`);
    for (const op of r.plan.data) console.log(`  data ${op.op === 'put' ? `copy ${op.from === 'phone' ? '->' : '<-'} stick` : `${op.op} on ${op.side}`}: ${op.rel}${op.to && op.to !== op.rel ? ` -> ${op.to}` : ''}`);
    report(r);
    console.log(`Plan: ${r.plan.code.length} code and ${r.plan.data.length} data steps. Nothing was changed. Run it with: node hub/cli.mjs sync run ${what}`);
    return 0;
  }
  let last = 0;
  run.on('progress', (p) => {
    if (Date.now() - last < 300 && p.phase !== 'done') return;
    last = Date.now();
    const line = `${p.phase} ${p.done}/${p.total} ${mb(p.bytes)}/${mb(p.totalBytes)} ${p.current}`.slice(0, 100);
    if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(100)}`); else console.log(line);
  });
  let stops = 0;
  process.on('SIGINT', () => {
    if (++stops > 1) process.exit(130);
    console.log('\nStopping after the current file... (Ctrl+C again to quit at once)');
    run.cancel();
  });
  const r = await run.run();
  if (process.stdout.isTTY) process.stdout.write('\n');
  if (r.code) console.log(`Code: ${r.code.message}`);
  report(r);
  const words = { ok: 'Sync done', cancelled: 'Sync cancelled. Run it again to finish.', interrupted: 'The stick was removed. Plug it in and sync again to finish.', locked: 'Stick busy', failed: 'Sync failed' };
  console.log(`${words[r.result]}${r.resumed ? ' (finished an interrupted sync)' : ''}: ${r.copied} copied, ${r.trashed} to trash.`);
  for (const e of r.errors) console.log(`  error: ${e}`);
  return r.result === 'ok' ? 0 : 3;
}

/** Print pending apps, conflicts and skipped files. */
function report(r) {
  if (r.pending.length) console.log(`Pending (app running, syncs when it stops): ${r.pending.join(', ')}`);
  for (const c of r.newConflicts) console.log(`Conflict: both sides changed it. Stick version kept as ${c}`);
  if (r.conflicts?.length) console.log(`Conflict copies on the phone: ${r.conflicts.length} (look in data/, delete the one you do not need)`);
  for (const s of r.skipped) console.log(`Skipped ${s.rel}: ${s.why}`);
}

async function pull(flags) {
  const s = await pickStick(flags);
  const r = await pullCode({ root: ROOT, hubDir: s.hubDir, stick: s.info, fsx: createFsx(), git: createGit(ROOT), apply: flags.yes });
  for (const rel of r.puts) console.log(`  copy from stick: ${rel}`);
  for (const rel of r.trash) console.log(`  not on stick (to .trash): ${rel}`);
  for (const x of r.skipped) console.log(`  skipped ${x.rel}: ${x.why}`);
  if (!r.puts.length && !r.trash.length) { console.log('The phone already has the same code as the stick.'); return 0; }
  if (!r.done) { console.log(`Nothing changed yet. To copy the stick's code (${s.info.commit?.slice(0, 7)}) into this clone, add --yes`); return 0; }
  console.log(`Copied ${r.puts.length} files from the stick. Nothing was run. See the changes: git status, git diff. Undo: git checkout . && git clean -fd hub apps`);
  return 0;
}

async function main(argv) {
  const { words, flags } = parse(argv);
  const [a, b, c] = words;
  if (a === 'stick' && b === 'status') return stickStatus().then(() => 0);
  if (a === 'stick' && b === 'init') return stickInit(flags).then(() => 0);
  if (a === 'sync' && (b === 'plan' || b === 'run')) return sync(b, c || 'all', flags);
  if (a === 'code' && b === 'pull-from-stick') return pull(flags);
  throw new UsageError(a ? `Unknown command: ${words.join(' ')}` : 'No command given');
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { console.error(`${e.message}\n\n${USAGE}`); process.exitCode = 2; return; }
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
