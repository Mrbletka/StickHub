// StickHub command line.
//   node hub/cli.mjs stick status
//   node hub/cli.mjs stick init [--name "My stick"] [--mount <dir>] [--force]
//   node hub/cli.mjs sync status         is a stick plugged in, does the hub sync data (not with the vault on)
//   node hub/cli.mjs sync plan [all|data|code] [--mount <dir>]
//   node hub/cli.mjs sync run  [all|data|code] [--mount <dir>]
//   node hub/cli.mjs code pull-from-stick [--yes] [--mount <dir>]
//   node hub/cli.mjs login [--open]      fresh one-time login link (if the hub page says "Log in")
//   node hub/cli.mjs open [--data-on-stick]   start the hub if needed and open it (app data on the stick)
//   node hub/cli.mjs open --vault [<folder>]   DEV ONLY: ask the passphrase, start the hub with the vault open
//   node hub/cli.mjs hub stop            stop the hub and its apps
//   node hub/cli.mjs watch start|stop|status   the watcher (opens the hub when the stick is plugged in)
//   node hub/cli.mjs widget install      home-screen shortcuts for Termux:Widget
//   node hub/cli.mjs new <id> --engine node-server|static [--name "Name"]   a new app from a starter
//   node hub/cli.mjs doctor [--json]     what this device has and lacks for StickHub, and how to fix it
//   node hub/cli.mjs vault verify|export ...   check an encrypted vault folder, or export it to plain files

import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listVolumes } from './platform/termux.mjs';
import { createGit } from './platform/git.mjs';
import { createFsx } from './sync/fsx.mjs';
import { findStick, readStick, initStick } from './stick.mjs';
import { SyncRun } from './sync/runner.mjs';
import { pullCode } from './sync/pull-code.mjs';
import { deviceId, stickhubHome, loadSettings } from './config.mjs';
import { readToken } from './auth.mjs';
import { callHub, loginUrl, ensureHub, stopHub, hubRunning } from './hubctl.mjs';
import { openUrl } from './platform/termux.mjs';
import { watchCommand, widgetInstall } from './cli-watch.mjs';
import { createApp } from './scaffold.mjs';
import { runDoctor, formatReport, realCtx } from './doctor.mjs';
import { loadApp } from './apps.mjs';
import { loadEngines } from './engines.mjs';
import { vaultCommand, VAULT_USAGE } from './cli-vault.mjs';
import { devVaultDir, EXIT_WRONG_PASSPHRASE } from './devvault.mjs';
import { readSecret, PromptCancelled } from './cli-prompt.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = `Usage:
  node hub/cli.mjs stick status
  node hub/cli.mjs stick init [--name "My stick"] [--mount <dir>] [--force]
  node hub/cli.mjs sync status
  node hub/cli.mjs sync plan [all|data|code] [--mount <dir>]
  node hub/cli.mjs sync run  [all|data|code] [--mount <dir>]
  node hub/cli.mjs code pull-from-stick [--yes] [--mount <dir>]
  node hub/cli.mjs login [--open]
  node hub/cli.mjs open [--data-on-stick]
  node hub/cli.mjs open --vault [<folder>]     DEV ONLY (until the lock screen): open the hub with a vault
  node hub/cli.mjs hub stop
  node hub/cli.mjs watch start|stop|status
  node hub/cli.mjs widget install
  node hub/cli.mjs new <id> --engine node-server|static [--name "Name"]
  node hub/cli.mjs doctor [--json]
${VAULT_USAGE.replace('Usage:\n', '')}`;

/** Split argv into words and --flags. */
function parse(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '--yes' || a === '--open') flags[a.slice(2)] = true;
    else if (a === '--data-on-stick') flags.dataOnStick = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--vault') flags.vault = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true; // folder optional
    else if (a === '--name' || a === '--mount' || a === '--engine') {
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
async function runningApps() {
  const r = await callHub('/api/apps', { token: await readToken(stickhubHome()), timeout: 1500 });
  if (!r) return new Set(); // hub not running: no app runs
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`The hub answered ${r.status}; cannot tell which apps run. Stop the hub or try again.`);
  return new Set(r.body.filter((a) => a.status !== 'stopped' && a.status !== 'error' && !a.atomicData).map((a) => a.id));
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

const VAULT_NO_DATA_SYNC = 'Data: not synced. The hub runs with the vault on (DEV ONLY): app data is in the vault, and the '
  + 'plain data sync never touches data/ then. Syncing the vault with the stick comes later (job 5).';

/** True if the running hub has a vault open (then the plain data sync stays away from data/). */
async function vaultHub() {
  const r = await callHub('/api/ping', { timeout: 1500 });
  return r?.status === 200 && r.body?.vault === true;
}

/** `sync status`: the stick and whether app data is synced. */
async function syncStatus() {
  await stickStatus();
  const r = await callHub('/api/stick', { token: await readToken(stickhubHome()), timeout: 1500 });
  if (!r) { console.log('Data: synced as plain files when you run "sync run" (the hub is not running).'); return 0; }
  if (r.status !== 200) throw new Error(`The hub answered ${r.status}.`);
  const ds = r.body.dataSync || { on: true };
  if (ds.why === 'vault') console.log(VAULT_NO_DATA_SYNC);
  else if (ds.why === 'data-on-stick') console.log('Data: lives on the stick (data on the stick), so it is not synced. Code is copied.');
  else console.log('Data: synced as plain files (on plug-in, after an app stops, and with Sync now).');
  if (r.body.last) console.log(`Last sync: ${r.body.last.at} ${r.body.last.result} (${r.body.last.what})`);
  return 0;
}

async function sync(mode, what, flags) {
  if (!['all', 'data', 'code'].includes(what)) throw new UsageError(`sync ${mode}: say all, data or code`);
  if (what !== 'code' && await vaultHub()) {
    console.log(VAULT_NO_DATA_SYNC);
    if (what === 'data') return 0;
    what = 'code';
  }
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

/** Print (and with --open, open) a fresh one-time login link. */
async function login(flags) {
  const url = await loginUrl(stickhubHome());
  console.log(`${url}\nThis link works once, for about 60 s.`);
  if (flags.open) {
    const r = await openUrl(url);
    if (!r.ok) console.log(`Could not open it (${r.error}). Copy the link into Chrome.`);
  }
  return 0;
}

/**
 * DEV ONLY (job 4 replaces it): ask the vault passphrase here (no echo), start the hub with the vault open, open it.
 * The passphrase goes to the hub on its stdin (a pipe), never in argv, the environment or a file. 3 tries.
 */
async function openVault(flags) {
  const home = stickhubHome();
  const dir = resolve(flags.vault === true ? devVaultDir(home) : flags.vault);
  if (flags.dataOnStick || (await loadSettings()).dataOnStick) throw new Error('The dev vault does not work with data on the stick yet: drop --data-on-stick (or dataOnStick in settings.json).');
  if (!existsSync(join(dir, 'vault.json'))) throw new Error(`No vault in ${dir}. Make one (DEV ONLY): node hub/cli.mjs vault dev-create ${dir}`);
  const running = await callHub('/api/ping', { timeout: 1500 });
  if (running?.status === 200 && running.body?.vault === true) {
    console.log('The hub already runs with a vault open.');
    return login({ open: true });
  }
  if (!process.stdin.isTTY) throw new Error('This needs a terminal: the passphrase is typed, never piped or passed as an argument.');
  if (running) console.log('The running hub has no vault: it restarts (apps stop first).');
  for (let tries = 1; ; tries++) {
    let secret;
    try { secret = await readSecret('Vault passphrase (DEV ONLY): '); } catch (e) {
      if (e instanceof PromptCancelled) { console.log('Cancelled.'); return 1; }
      throw e;
    }
    try {
      const r = await ensureHub(ROOT, undefined, { vault: dir, secret, home });
      console.log(r.started ? `Started the hub with the vault open (pid ${r.pid}, DEV ONLY, log: logs/hub.log).` : 'The hub runs with a vault open.');
      break;
    } catch (e) {
      if (e.exitCode !== EXIT_WRONG_PASSPHRASE) throw e;
      if (tries >= 3) { console.log('Wrong passphrase. Nothing was started.'); return 1; }
      console.log('Wrong passphrase. Try again.');
    }
  }
  return login({ open: true });
}

/** Start the hub in the background if needed, then open it with a login link. */
async function open(flags) {
  if (flags.vault) return openVault(flags);
  const dataOnStick = flags.dataOnStick || (await loadSettings()).dataOnStick;
  const r = await ensureHub(ROOT, undefined, { dataOnStick, home: stickhubHome() });
  if (r.started) console.log(`Started the hub (pid ${r.pid}${dataOnStick ? ', app data on the stick' : ''}, log: logs/hub.log).`);
  else if (r.mode === 'data-on-stick') console.log('The hub runs with the app data on the stick.');
  return login({ open: true });
}

/** A new app from a starter, checked like the hub checks it; the running hub shows it at once. */
async function newApp(id, flags) {
  if (!id) throw new UsageError('new: give the app id, e.g. node hub/cli.mjs new deep-dig --engine node-server');
  if (!flags.engine) throw new UsageError('new: say --engine node-server (has a server, can save) or --engine static (files only)');
  const { dir, files } = await createApp(join(ROOT, 'apps'), { id, engine: flags.engine, name: flags.name });
  console.log(`Created apps/${id}/: ${files.join(', ')}`);
  const { engines } = await loadEngines();
  const app = await loadApp(dir, id, engines);
  if (app.errors.length) { console.log(`Problems: ${app.errors.join('; ')}`); return 1; }
  const r = await callHub('/api/apps/reload', { method: 'POST', token: await readToken(stickhubHome()) });
  console.log(r?.status === 200 ? 'The hub shows it now.' : 'Start the hub to see it: node hub/cli.mjs open');
  return 0;
}

async function main(argv) {
  if (argv[0] === 'vault') { // own options (--paper, --quick): handled before the general parser
    return vaultCommand(argv.slice(1), { root: ROOT, home: stickhubHome(), mounts: async () => (await listVolumes()).volumes.map((v) => v.mountPoint) });
  }
  const { words, flags } = parse(argv);
  const [a, b, c] = words;
  if (a === 'stick' && b === 'status') return stickStatus().then(() => 0);
  if (a === 'stick' && b === 'init') return stickInit(flags).then(() => 0);
  if (a === 'sync' && b === 'status') return syncStatus();
  if (a === 'sync' && (b === 'plan' || b === 'run')) return sync(b, c || 'all', flags);
  if (a === 'code' && b === 'pull-from-stick') return pull(flags);
  if (a === 'login') return login(flags);
  if (a === 'new') return newApp(b, flags);
  if (a === 'doctor') {
    const results = await runDoctor(realCtx(ROOT, stickhubHome()));
    console.log(flags.json ? JSON.stringify(results, null, 1) : formatReport(results));
    return results.some((r) => r.state === 'fail') ? 1 : 0;
  }
  if (a === 'watch') return watchCommand(b, ROOT, stickhubHome());
  if (a === 'widget' && b === 'install') return widgetInstall(ROOT);
  if (a === 'open') return open(flags);
  if (a === 'hub' && b === 'stop') {
    if (!(await hubRunning())) { console.log('The hub is not running.'); return 0; }
    console.log((await stopHub(stickhubHome())) ? 'The hub is stopping (apps first).' : 'The hub did not accept the stop.');
    return 0;
  }
  throw new UsageError(a ? `Unknown command: ${words.join(' ')}` : 'No command given');
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { console.error(`${e.message}\n\n${USAGE}`); process.exitCode = 2; return; }
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
