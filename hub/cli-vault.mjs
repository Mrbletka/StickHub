// node hub/cli.mjs vault verify <vault-folder> [--quick] [--paper] [--json]
// node hub/cli.mjs vault export <vault-folder> <dest-folder> [--paper]
// node hub/cli.mjs vault setup [--own]   a new vault in ~/.stickhub/vault-dev (hub/cli-setup.mjs)
// node hub/cli.mjs vault status          locked or open, wrong tries, auto-lock (asks the running hub if there is one)
// node hub/cli.mjs vault lock            asks the running hub to lock
// The passphrase (or with --paper the paper code) is asked on the terminal with no echo, never taken from argv, the
// environment or a file. Neither command writes to the vault (the store opens with automatic cleanup off).
// Output: counts and random file names only, never a name from inside the vault. Exit 0 = ok, 1 = a problem, 2 = usage.

import { resolve, join } from 'node:path';
import { VaultError } from './vault/errors.mjs';
import { openVaultFolder } from './vault/store.mjs';
import { unlockWithPassphrase, unlockWithPaperCode } from './vault/header.mjs';
import { checkExportDest, exportVault } from './vault/export.mjs';
import { readSecret, PromptCancelled } from './cli-prompt.mjs';
import { existsSync } from 'node:fs';
import { vaultSetup, vaultDir } from './cli-setup.mjs';
import { Limiter } from './lock/limiter.mjs';

export const VAULT_USAGE = `Usage:
  node hub/cli.mjs vault verify <vault-folder> [--quick] [--paper] [--json]
  node hub/cli.mjs vault export <vault-folder> <dest-folder> [--paper]
  node hub/cli.mjs vault setup [--own]   a new vault (5 generated words, or --own: yours, 20+ characters)
  node hub/cli.mjs vault status
  node hub/cli.mjs vault lock`;

function parse(argv) {
  const words = [];
  const flags = { quick: false, paper: false, json: false };
  for (const a of argv) {
    if (a === '--quick' || a === '--paper' || a === '--json') flags[a.slice(2)] = true;
    else if (a.startsWith('--')) return null;
    else words.push(a);
  }
  return { words, flags };
}

/** Human-readable verify report: counts and random file names only. */
export function formatVerify(r) {
  const lines = [`Vault check (${r.quick ? 'quick' : 'full'}): ${r.ok ? 'OK' : 'PROBLEMS FOUND'}`];
  lines.push(`header: main ${r.header.main}, backup ${r.header.backup}, copies ${r.header.equal ? 'equal' : 'NOT equal'}`);
  lines.push(`index files: ${r.indexes.valid} valid, ${r.indexes.damaged.length} damaged, ${r.indexes.leftovers} leftover`);
  lines.push(`packs: ${r.packs.used} used, ${r.packs.missing.length} missing, ${r.packs.wrongSize.length} wrong size, ${r.packs.damaged.length} damaged`);
  if (!r.quick) lines.push(`files: ${r.files.checked} checked, ${r.files.bad} bad; trash: ${r.trash.checked} checked, ${r.trash.bad} bad`);
  for (const [what, names] of [['damaged index', r.indexes.damaged], ['missing pack', r.packs.missing], ['wrong-size pack', r.packs.wrongSize], ['damaged pack', r.packs.damaged]]) {
    for (const n of names) lines.push(`  ${what}: ${n}`);
  }
  if (r.checkedTwice) lines.push('(checked twice: the running hub changed the vault meanwhile)');
  return lines.join('\n');
}

/**
 * Run a vault command.
 * @param {string[]} argv  words after "vault"
 * @param {{input?: object, out?: (s: string) => void, err?: (s: string) => void, prompt?: object,
 *   root: string, mounts: () => Promise<string[]>, home?: string, outTTY?: boolean, kdf?: object,
 *   callHub?: Function, token?: () => Promise<string|null>}} d
 *   input: the terminal; mounts: mounted volumes (sticks); home: ~/.stickhub (the vault folder, attempts.json);
 *   callHub, token: talk to the running hub (status, lock); outTTY, kdf: tests only
 * @returns {Promise<number>} exit code
 */
export async function vaultCommand(argv, d) {
  const out = d.out || ((s) => console.log(s));
  const err = d.err || ((s) => console.error(s));
  if (argv[0] === 'setup') {
    try {
      return await vaultSetup(argv.slice(1), { ...d, hubRunning: async () => !!(await d.callHub?.('/api/ping', { timeout: 1500 })) });
    } catch (e) {
      if (e instanceof PromptCancelled) { err('Cancelled. Nothing was created.'); return 1; }
      err(`Error: ${e.message}`);
      return 1;
    }
  }
  if ((argv[0] === 'status' || argv[0] === 'lock') && argv.length === 1) return argv[0] === 'lock' ? vaultLock(d, out) : vaultStatus(d, out);
  const p = parse(argv);
  const [cmd, folder, dest] = p?.words || [];
  if (!p || !((cmd === 'verify' && folder && !dest) || (cmd === 'export' && folder && dest)) || p.words.length > 3 || (cmd === 'export' && (p.flags.quick || p.flags.json))) {
    err(VAULT_USAGE);
    return 2;
  }
  const input = d.input || process.stdin;
  if (!input.isTTY) { err('This needs a terminal: the passphrase is typed, never piped or passed as an argument.'); return 1; }
  const vaultDir = resolve(folder);
  let store = null;
  try {
    const target = cmd === 'export' ? await checkExportDest(dest, { vaultDir, root: d.root, mounts: await d.mounts() }) : null;
    const secret = await readSecret(p.flags.paper ? 'Paper code: ' : 'Passphrase: ', { input, output: d.prompt });
    store = await openVaultFolder(vaultDir, (h) => (p.flags.paper ? unlockWithPaperCode(h, secret) : unlockWithPassphrase(h, secret)), { autoCleanupEvery: 0 });
    if (cmd === 'verify') {
      const r = await store.verify({ quick: p.flags.quick });
      out(p.flags.json ? JSON.stringify(r, null, 1) : formatVerify(r));
      return r.ok ? 0 : 1;
    }
    const r = await exportVault(store, target);
    store = r.store;
    out(`Exported ${r.files} files (${r.bytes} bytes) and ${r.folders} folders to ${target}`);
    if (r.gone) out(`${r.gone} files were deleted by the running hub while exporting.`);
    out('These files are NOT encrypted. Keep them off the stick and delete them when you no longer need them.');
    return 0;
  } catch (e) {
    if (e instanceof PromptCancelled) { err('Cancelled.'); return 1; }
    if (!(e instanceof VaultError)) throw e;
    err(`${cmd === 'export' && e.code !== 'EXPORT_DEST' && e.code !== 'WRONG_SECRET' ? 'Export stopped: ' : ''}${e.message}`);
    if (cmd === 'export' && !['EXPORT_DEST', 'WRONG_SECRET', 'BAD_CODE', 'NO_VAULT'].includes(e.code)) err('The export folder is incomplete. Delete it and try again after "vault verify".');
    return 1;
  } finally {
    await store?.close();
  }
}

/** `vault status`: from the running hub if there is one, else from the folder and attempts.json. No names. */
async function vaultStatus(d, out) {
  const dir = vaultDir(d.home);
  if (!existsSync(join(dir, 'vault.json'))) { out(`No vault in ${dir}: the hub uses plain data. Make one: node hub/cli.mjs vault setup`); return 0; }
  const limiter = new Limiter({ file: join(d.home, 'vault', 'attempts.json') });
  await limiter.load();
  const r = await d.callHub('/api/vault', { token: await d.token(), timeout: 1500 });
  const words = { locked: 'locked', unlocking: 'locked (opening now)', unlocked: 'open', locking: 'locking' };
  const lines = [`Vault: ${dir}`];
  if (!r) lines.push('State: locked (the hub is not running)');
  else if (r.status !== 200) lines.push(`State: unknown (the hub answered ${r.status})`);
  else {
    lines.push(`State: ${words[r.body.state] || r.body.state}`, `Auto-lock: after ${r.body.autoLockSeconds} s without a visible hub page`);
    if (r.body.lastLock) lines.push(`Last lock: ${new Date(r.body.lastLock.at).toLocaleString()} (${r.body.lastLock.reason})`);
  }
  if (limiter.failures) lines.push(`Wrong tries since the last good one: ${limiter.failures}${limiter.waitMs() ? `; the next try waits ${Math.ceil(limiter.waitMs() / 1000)} s` : ''}`);
  if (existsSync(join(d.home, 'vault', 'paper-used.json'))) lines.push('The paper code was used: make a new one soon (comes with a later step).');
  out(lines.join('\n'));
  return 0;
}

/** `vault lock`: asks the running hub. */
async function vaultLock(d, out) {
  if (!existsSync(join(vaultDir(d.home), 'vault.json'))) { out('There is no vault.'); return 0; }
  const r = await d.callHub('/api/vault/lock', { method: 'POST', token: await d.token(), timeout: 20_000 });
  if (!r) { out('The hub is not running: the vault is locked.'); return 0; }
  if (r.status !== 200) { out(`The hub answered ${r.status}: ${r.body?.error || 'not locked'}`); return 1; }
  out('Locked: the apps stopped, their browser state was cleared, the keys are gone.');
  return 0;
}
