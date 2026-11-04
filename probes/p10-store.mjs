// Probe 10 (store part): the encrypted vault store on the real exFAT stick, with the phone's own storage as control.
// It checks the cost estimates of docs/VAULT-DESIGN.md 8.3. Throwaway vaults only: a header with just a recovery slot,
// random keys, nothing real. Paths are never printed (they hold the stick's volume id).
// Then a pull test (needs Fabian): saves run in a loop on the stick; he pulls it; afterwards p10-check.mjs opens what
// was left: the old or the new state, no problems, cleanup works; then it removes that test vault.

import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { stats, sleep } from './lib.mjs';
import { newDataKey, newId } from '../hub/vault/keys.mjs';
import { makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader, unlockWithPaperCode } from '../hub/vault/header.mjs';
import { Store, openVaultFolder } from '../hub/vault/store.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
export const PULL_RECORD = join(OUT, 'p10-pull.json');
export const PULL_DIR_NAME = '.stickhub-probe10-pull';

/** True if root is the pull test's own folder (p10-check.mjs removes nothing else). */
export function isPullRoot(root) {
  return typeof root === 'string' && basename(root) === PULL_DIR_NAME;
}
const ms = (t) => Math.round(performance.now() - t);
const NOTE = (i) => `note ${i} ${randomBytes(1000).toString('hex')}`.slice(0, 2048); // about 2 KB

/** A throwaway vault: recovery slot only, random keys. TEST ONLY. */
function throwawayHeader() {
  const dk = newDataKey();
  const vaultId = newId();
  const { slot, paperCode } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
  return { dk, paperCode, headerText: buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [slot] }, dk) };
}
const openWith = (dir, code) => openVaultFolder(dir, (h) => unlockWithPaperCode(h, code), { autoCleanupEvery: 0 });

async function dirFsync(dir) {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
    return 'works';
  } catch (e) {
    return `fails: ${e.code || e.message}`;
  } finally {
    await fh?.close();
  }
}

/** All measurements on one folder. */
async function measure(r, label, base) {
  const root = join(base, 'vault10');
  const dir = join(root, 'data');
  mkdirSync(root, { recursive: true });
  try {
    const h = throwawayHeader();
    let t = performance.now();
    const s0 = await Store.create(dir, { headerText: h.headerText, dk: h.dk, autoCleanupEvery: 0 });
    r.add(`${label}: create vault`, `${ms(t)} ms`);
    await s0.close();
    t = performance.now();
    let s = await openWith(dir, h.paperCode);
    r.add(`${label}: open (empty)`, `${ms(t)} ms`);

    const each = [];
    for (let i = 0; i < 30; i++) { t = performance.now(); await s.write(`n/single${i}.md`, NOTE(i)); each.push(performance.now() - t); }
    const st = stats(each);
    const p95 = Math.round([...each].sort((a, b) => a - b)[Math.ceil(each.length * 0.95) - 1]);
    r.add(`${label}: 30 single 2 KB saves`, `median ${st.med} ms, p95 ${p95} ms, min ${st.min}, max ${st.max}`);

    t = performance.now();
    const c = await s.cleanup();
    r.add(`${label}: cleanup after them`, `${ms(t)} ms, level ${c.level}, removed ${c.removed.indexes} index + ${c.removed.packs} pack files`);

    const seq = s.status().seq;
    t = performance.now();
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.write(`n/burst${i}.md`, NOTE(100 + i))));
    r.add(`${label}: burst of 50 writes in one tick`, `${ms(t)} ms, ${s.status().seq - seq} commit(s)`);

    const big = randomBytes(5 * 1024 * 1024);
    t = performance.now();
    await s.write('m/big.bin', big);
    const tw = ms(t);
    t = performance.now();
    const back = await s.read('m/big.bin');
    r.add(`${label}: 5 MB write / read`, `${tw} ms / ${ms(t)} ms, same bytes: ${back.equals(big)}`);

    for (let i = 0; s.status().files < 205;) {
      await Promise.all(Array.from({ length: 50 }, () => s.write(`n/more${i}.md`, NOTE(i++))));
    }
    await s.cleanup();
    await s.close();
    t = performance.now();
    s = await openWith(dir, h.paperCode);
    r.add(`${label}: open with ${s.status().files - 3} notes`, `${ms(t)} ms`);
    const size = (sub) => readdirSync(join(dir, sub)).map((n) => statSync(join(dir, sub, n)).size).sort((a, b) => a - b);
    const packs = size('_packs');
    r.add(`${label}: file sizes`, `index ${size('_index').join(', ')} bytes; packs ${packs.length} files, smallest ${packs[0]}, largest ${packs[packs.length - 1]} bytes`);
    r.add(`${label}: problems`, JSON.stringify(s.status().problems));
    await s.close();
    r.add(`${label}: folder fsync`, await dirFsync(dir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The pull test: saves in a loop until the stick is pulled. */
async function pullTest(r, stickRoot, ask) {
  const root = join(stickRoot, PULL_DIR_NAME);
  rmSync(root, { recursive: true, force: true });
  const dir = join(root, 'data');
  mkdirSync(root, { recursive: true });
  const h = throwawayHeader();
  const s0 = await Store.create(dir, { headerText: h.headerText, dk: h.dk, autoCleanupEvery: 0 });
  await s0.close();
  const s = await openWith(dir, h.paperCode);
  mkdirSync(OUT, { recursive: true });
  const record = { note: 'TEST ONLY: a throwaway vault with random keys, for p10-check.mjs', root, dir, paperCode: h.paperCode, lastDone: -1 };
  writeFileSync(PULL_RECORD, JSON.stringify(record));
  await ask('Pull test. Press Enter to start the saves.');
  console.log('\nSaves are running on the stick now.\n\n>>> PULL THE STICK NOW.\n');
  const t0 = Date.now();
  let i = 0;
  let error = null;
  while (Date.now() - t0 < 120_000) {
    try {
      await s.write('p/counter.md', `${i} ${NOTE(i)}`);
    } catch (e) {
      error = e.code || 'error';
      break;
    }
    record.lastDone = i++;
    writeFileSync(PULL_RECORD, JSON.stringify(record)); // on the phone, not the stick
  }
  r.add('pull test: saves done before the pull', `${record.lastDone + 1}, then ${error || 'no error within 120 s (not pulled?)'}`);
  await s.close(); // broken after the failed save: close only forgets the keys
  console.log('\n>>> Plug the stick back in. Then run:\n    cd ~/StickHub && node probes/p10-check.mjs\n');
  r.add('pull test: next', 'plug the stick back in, run: node probes/p10-check.mjs');
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{stickDir?: string, localDir?: string}} ctx  probe 0's test folders
 * @param {(q: string) => Promise<string>} ask
 */
export async function run10(r, ctx, ask) {
  r.section('10. Vault store on the stick (and the phone as control)');
  if (ctx.stickDir) await measure(r, 'stick', ctx.stickDir); else r.add('stick', 'no stick test folder (is it plugged in?)');
  await measure(r, 'phone', ctx.localDir);
  if (!ctx.stickDir) return;
  if (!process.stdin.isTTY) { r.add('pull test', 'skipped: needs you at the phone'); return; }
  rmSync(ctx.stickDir, { recursive: true, force: true }); // measurements done: nothing of ours left in it before the pull
  await sleep(100);
  await pullTest(r, dirname(ctx.stickDir), ask);
}
