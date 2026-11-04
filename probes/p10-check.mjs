// Probe 10, after the pull test: open the vault the pull left on the stick. It must give the old or the new state
// (the counter is the last save that finished, or the one that was running), with no problems; a full cleanup and a
// full verify must work. Then the test vault is removed. The result is copied to the clipboard.
// Run: cd ~/StickHub && node probes/p10-check.mjs

import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report, run, hasCmd, sleep } from './lib.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPaperCode } from '../hub/vault/header.mjs';
import { PULL_RECORD, isPullRoot } from './p10-store.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

async function check(r) {
  r.section('10. Pull test: what the stick holds now');
  let rec;
  try {
    rec = JSON.parse(readFileSync(PULL_RECORD, 'utf8'));
  } catch (e) {
    r.add('record', `none (${e.code || e.message}): run the probe first: sh probes/run-all.sh --only 10`);
    return;
  }
  if (!isPullRoot(rec.root)) { // never remove a folder that is not the pull test's own
    r.add('record', 'the record looks wrong, nothing removed');
    process.exitCode = 1;
    return;
  }
  r.add('last save that finished before the pull', rec.lastDone);
  const t0 = Date.now();
  while (!existsSync(join(rec.dir, 'vault.json')) && Date.now() - t0 < 60_000) await sleep(500);
  if (!existsSync(join(rec.dir, 'vault.json'))) { r.add('stick', 'the test vault is not there: is the stick plugged in?'); return; }
  r.add('stick back after (ms)', Date.now() - t0);
  const s = await openVaultFolder(rec.dir, (h) => unlockWithPaperCode(h, rec.paperCode), { autoCleanupEvery: 0 });
  const st = s.status();
  let counter = -1;
  try {
    counter = Number((await s.read('p/counter.md')).toString().split(' ')[0]);
  } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e; // NOT_FOUND = pulled before the first save finished
  }
  const state = counter === rec.lastDone ? 'old (the last finished save)' : counter === rec.lastDone + 1 ? 'new (the save that was running)' : `WRONG: ${counter}`;
  r.add('opened', `yes, index seq ${st.seq}, ${st.indexFiles} index files`);
  r.add('state', state);
  r.add('problems', JSON.stringify(st.problems));
  const c = await s.cleanup();
  r.add('cleanup', `${c.level}, removed ${JSON.stringify(c.removed)}`);
  const v = await s.verify();
  r.add('verify (full)', v.ok ? 'OK' : `PROBLEMS ${JSON.stringify({ header: v.header, damaged: v.indexes.damaged.length, packs: v.packs })}`);
  await s.close();
  rmSync(rec.root, { recursive: true, force: true });
  rmSync(PULL_RECORD, { force: true });
  r.add('test vault', existsSync(rec.root) ? 'NOT removed' : 'removed');
}

const r = new Report();
r.add(`# StickHub probe 10 check ${new Date().toISOString()}`);
try {
  await check(r);
} catch (e) {
  r.add('check crashed', `${e.code || ''} ${e.message}`);
}
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `p10-check-${Date.now()}.txt`);
writeFileSync(file, r.toString());
if (hasCmd('termux-clipboard-set')) {
  const res = await run('termux-clipboard-set', [], { timeout: 10_000, input: r.toString() });
  console.log(res.ok ? '\nCopied to the clipboard. Paste it into the chat.' : `\nClipboard failed. Run: termux-clipboard-set < ${file}`);
}
