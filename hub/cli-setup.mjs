// `node hub/cli.mjs vault setup [--own]`: a new, empty vault in the vault folder (~/.stickhub/vault-dev, design 7.1
// steps 3-4; job 6 decides the final place and the migration). Plain app data is not touched.
// - The passphrase: 5 generated words (default), shown once and typed back; or with --own your own, at least 20
//   characters, typed twice. Never from argv, the environment or a file; typed with no echo.
// - The paper code: shown once; you type two of its groups back.
// - Nothing is written until every check passed; then the screen is cleared. A vault that exists is never touched.

import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { generatePassphrase } from './vault/words.mjs';
import { newDataKey, newId, zero } from './vault/keys.mjs';
import { makePassphraseSlot, makeRecoverySlot } from './vault/slots.mjs';
import { buildHeader } from './vault/header.mjs';
import { canonicalPassphrase, checkOwnPassphrase, defaultKdf } from './vault/kdf.mjs';
import { Store } from './vault/store.mjs';
import { realish, inside } from './vault/export.mjs';
import { readSecret } from './cli-prompt.mjs';

/** The vault folder (job 6 moves it to its final place). */
export const vaultDir = (home) => join(home, 'vault-dev');
const CLEAR = '\u001b[2J\u001b[3J\u001b[H'; // the screen and the scrollback: the words do not stay on the terminal

/** Refuse a folder inside this clone, on a stick, a file, or one that is not empty. @returns {Promise<string>} */
export async function checkNewVaultDir(folder, o) {
  const d = await realish(folder);
  if (inside(d, await realish(o.root))) throw new Error('The vault folder cannot be inside the StickHub folder.');
  for (const m of o.mounts) if (inside(d, await realish(m))) throw new Error('The vault folder cannot be on a stick (the stick replica comes with sync).');
  let st = null;
  try { st = await stat(d); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isDirectory()) throw new Error('The vault folder is a file.');
  if (st && (await readdir(d)).length) throw new Error(`There is a vault (or other files) in ${d} already. Nothing was changed.`);
  return d;
}

const same = (a, b) => { try { return canonicalPassphrase(a) === canonicalPassphrase(b); } catch { return false; } };
const codeGroup = (s) => String(s).toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

/**
 * @param {string[]} flags  ['--own'] or []
 * @param {{input?: object, outTTY?: boolean, out?: Function, err?: Function, prompt?: object, root: string, home: string,
 *   mounts: () => Promise<string[]>, kdf?: object, hubRunning?: () => Promise<boolean>}} d  kdf: tests only (tiny)
 * @returns {Promise<number>} exit code
 */
export async function vaultSetup(flags, d) {
  const out = d.out || ((s) => console.log(s));
  const err = d.err || ((s) => console.error(s));
  const input = d.input || process.stdin;
  const ask = (q) => readSecret(q, { input, output: d.prompt });
  if (flags.some((f) => f !== '--own')) { err('Usage: node hub/cli.mjs vault setup [--own]'); return 2; }
  if (!input.isTTY || !(d.outTTY ?? process.stdout.isTTY)) { err('vault setup shows secrets once on the terminal: run it in a terminal, without < > or |.'); return 1; }
  const dir = await checkNewVaultDir(vaultDir(d.home), { root: d.root, mounts: await d.mounts() });
  out(['This makes an encrypted vault in', `  ${dir}`, 'Your plain app data (data/ here and on the stick) is not touched. Moving it into the vault comes with the',
    'migration (a later step); until then, apps that use the vault start empty.', ''].join('\n'));

  let passphrase;
  if (flags.includes('--own')) {
    for (let i = 0; i < 3 && !passphrase; i++) {
      const a = await ask('Your passphrase (at least 20 characters): ');
      try { checkOwnPassphrase(a); } catch (e) { err(e.message); continue; }
      if (same(a, await ask('The same again: '))) passphrase = a; else err('The two were not the same.');
    }
    if (!passphrase) { err('Nothing was created.'); return 1; }
  } else {
    passphrase = generatePassphrase();
  }
  const dk = newDataKey();
  const vaultId = newId();
  try {
    const kdf = d.kdf || defaultKdf();
    out(`Making the key slots (${kdf.alg}, about 1 s)...`);
    const ps = await makePassphraseSlot({ dk, vaultId, epoch: 1, passphrase, kdf });
    const { slot: rs, paperCode } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
    const headerText = buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [ps, rs] }, dk);
    const shown = ['', 'Write these down now. They are shown only this once and saved nowhere.', ''];
    if (!flags.includes('--own')) shown.push(`  Passphrase:  ${passphrase}`);
    shown.push(`  Paper code:  ${paperCode}`, '', 'The passphrase opens the vault on the hub page. The paper code is the way back in when the passphrase is',
      'lost: keep it at home, not with the stick or the phone.', '');
    out(shown.join('\n'));
    let ok = true;
    if (!flags.includes('--own')) {
      ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        ok = same(await ask('Type the passphrase to show you saved it: '), passphrase);
        if (!ok) err(i < 2 ? 'That is not it. Try again.' : 'That is not it.');
      }
    }
    const groups = paperCode.split('-');
    for (const g of ok ? pickTwo(groups.length) : []) {
      let good = false;
      for (let i = 0; i < 3 && !good; i++) {
        good = codeGroup(await ask(`Type group ${g + 1} of the paper code (4 characters): `)) === groups[g];
        if (!good) err(i < 2 ? 'That is not it. Try again.' : 'That is not it.');
      }
      ok = good;
      if (!ok) break;
    }
    out(CLEAR);
    if (!ok) { err('Nothing was created. Run it again (new words and a new paper code).'); return 1; }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await (await Store.create(dir, { headerText, dk, autoCleanupEvery: 0 })).close();
    out(`Vault made in ${dir}. The screen was cleared.`);
    out(await d.hubRunning?.() ? 'Restart the hub so it opens locked with the vault: node hub/cli.mjs hub stop && node hub/cli.mjs open'
      : 'Start the hub: node hub/cli.mjs open (it opens locked; type the passphrase on its page)');
    return 0;
  } finally {
    zero(dk);
  }
}

/** Two different group numbers (0-based) out of n, in order. */
function pickTwo(n) {
  const a = randomInt(n);
  let b = randomInt(n - 1);
  if (b >= a) b++;
  return [a, b].sort((x, y) => x - y);
}
