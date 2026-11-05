// DEV ONLY (job 3b). A temporary way to make a vault and to start the hub with it open, until job 4 brings the lock
// screen. Nothing here is the real setup (design 7.1) or the real unlock (design 7.2).
// - devCreate: `node hub/cli.mjs vault dev-create [<folder>]`: a new vault with a generated 5-word passphrase and a
//   paper code. Both are shown ONCE on the terminal (never written to a file, argv or the environment); the person
//   types the passphrase back to show it was saved; only then the vault is written. The screen is cleared after.
// - The hub side: `node hub/cli.mjs open --vault [<folder>]` asks for the passphrase on the terminal and starts the
//   hub with HUB_DEV_VAULT=<folder> (a HUB_ name, so apps never see it) and the passphrase on its stdin (a pipe).
//   readPassphrase() reads it there; openDevVault() opens the store, which then lives only in the hub's memory.

import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { generatePassphrase } from './vault/words.mjs';
import { newDataKey, newId, zero } from './vault/keys.mjs';
import { makePassphraseSlot, makeRecoverySlot } from './vault/slots.mjs';
import { buildHeader, unlockWithPassphrase } from './vault/header.mjs';
import { canonicalPassphrase } from './vault/kdf.mjs';
import { Store, openVaultFolder } from './vault/store.mjs';
import { realish, inside } from './vault/export.mjs';
import { readSecret } from './cli-prompt.mjs';

/** Where the dev vault goes when no folder is named (outside the clone, never on the stick). */
export const devVaultDir = (home) => join(home, 'vault-dev');

/** Exit code of the hub when the passphrase does not open the vault (the CLI asks again). */
export const EXIT_WRONG_PASSPHRASE = 3;

// Clear the screen and the scrollback, so the words do not stay on the terminal.
const CLEAR = '\u001b[2J\u001b[3J\u001b[H';

/**
 * Refuse a folder that is inside this clone (git, plain data sync), on a stick (dev vaults stay on the phone), a file,
 * or not empty. @returns {Promise<string>} the folder as an absolute path
 */
export async function checkNewVaultDir(folder, o) {
  const d = await realish(folder);
  if (inside(d, await realish(o.root))) throw new Error('The vault folder cannot be inside the StickHub folder. Use ~/.stickhub/vault-dev.');
  for (const m of o.mounts) if (inside(d, await realish(m))) throw new Error('The dev vault cannot be on a stick (job 5 brings the stick replica).');
  let st = null;
  try { st = await stat(d); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isDirectory()) throw new Error('The vault folder is a file.');
  if (st && (await readdir(d)).length) throw new Error('The vault folder must be empty or not exist yet.');
  return d;
}

const same = (typed, pass) => {
  try { return canonicalPassphrase(typed) === canonicalPassphrase(pass); } catch { return false; } // empty or not text
};

/**
 * `vault dev-create`. DEV ONLY.
 * @param {string} folder
 * @param {{input?: object, outTTY?: boolean, out?: (s: string) => void, err?: (s: string) => void, prompt?: object,
 *   root: string, mounts: () => Promise<string[]>, kdf?: object}} d  kdf: tests only (tiny settings)
 * @returns {Promise<number>} exit code
 */
export async function devCreate(folder, d) {
  const out = d.out || ((s) => console.log(s));
  const err = d.err || ((s) => console.error(s));
  const input = d.input || process.stdin;
  if (!input.isTTY || !(d.outTTY ?? process.stdout.isTTY)) {
    err('dev-create shows the passphrase once on the terminal: run it in a terminal, without < > or |.');
    return 1;
  }
  const dir = await checkNewVaultDir(folder, { root: d.root, mounts: await d.mounts() });
  const passphrase = generatePassphrase();
  const dk = newDataKey();
  const vaultId = newId();
  try {
    out('DEV ONLY: a test vault until the lock screen comes (job 4). Making the key slots (about 1 s)...');
    const ps = await makePassphraseSlot({ dk, vaultId, epoch: 1, passphrase, kdf: d.kdf });
    const { slot: rs, paperCode } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
    const headerText = buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [ps, rs] }, dk);
    out(['', 'Write these down now. They are shown only this once and saved nowhere.', '',
      `  Passphrase:  ${passphrase}`, `  Paper code:  ${paperCode}`, '',
      'The passphrase opens the vault at every hub start. The paper code is the way back in if the passphrase is lost', '(not usable yet).', ''].join('\n'));
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      ok = same(await readSecret('Type the passphrase to show you saved it: ', { input, output: d.prompt }), passphrase);
      if (!ok) err(i < 2 ? 'That is not it. Try again.' : 'That is not it.');
    }
    out(CLEAR);
    if (!ok) { err('Nothing was created. Run it again for new words.'); return 1; }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const store = await Store.create(dir, { headerText, dk, autoCleanupEvery: 0 });
    await store.close();
    out(`Vault created in ${dir} (DEV ONLY). The screen was cleared.\nStart the hub with it: node hub/cli.mjs open --vault ${dir}`);
    return 0;
  } finally {
    zero(dk);
  }
}

/**
 * The passphrase for the hub: typed with no echo on a terminal, or the first line of a pipe (`open --vault`).
 * Never from argv, the environment or a file.
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string>}
 */
export function readPassphrase(stdin) {
  if (stdin.isTTY) return readSecret('Vault passphrase (DEV ONLY): ', { input: stdin });
  return new Promise((ok, fail) => {
    const dec = new StringDecoder('utf8');
    let text = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.off('end', done);
      stdin.destroy(); // nothing else comes this way
      const nl = text.indexOf('\n');
      ok((nl >= 0 ? text.slice(0, nl) : text).replace(/\r$/, ''));
      text = '';
    };
    const onData = (b) => { text += dec.write(b); if (text.includes('\n') || text.length > 4096) done(); };
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.once('error', fail);
  });
}

/**
 * Open the dev vault in this process (Argon2id: about 1 s and 310 MB on the phone). The store keeps the data key in
 * memory only. Wrong passphrase: VaultError WRONG_SECRET.
 * @param {string} dir
 * @param {string} passphrase
 */
export function openDevVault(dir, passphrase) {
  return openVaultFolder(resolve(dir), (h) => unlockWithPassphrase(h, passphrase));
}
