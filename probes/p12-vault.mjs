// Probe 12, part 2: what the apps feel of the vault through hubfs (job 3b+3c), on the phone's storage and on the stick.
// A throwaway vault (random keys, recovery slot only) behind the data API on a socket in the probe's own temp folder;
// never a real vault, never ~/.stickhub/run. Paths and note names are never printed.
// - readdir of a folder with 230 notes (one request, depth 1), and the whole subtree for comparison;
// - 100 notes read at once (Promise.all: the client keeps 8 in flight);
// - a Notebook save: the Notebook's own Vault.write (stat, ifMatch write) and the time until its change event;
// - for comparison, readdir of 230 plain files in hubfs plain-file mode (no file is read since 0b).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newDataKey, newId } from '../hub/vault/keys.mjs';
import { makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader } from '../hub/vault/header.mjs';
import { Store } from '../hub/vault/store.mjs';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { Vault } from '../apps/notebook/lib/vault.mjs';
import { Changes } from '../apps/notebook/lib/changes.mjs';

const ms = (t) => performance.now() - t;
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (xs, p) => r1([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]);
const sum = (xs) => `p50 ${pct(xs, 0.5)} ms, p95 ${pct(xs, 0.95)} ms, max ${r1(Math.max(...xs))} ms`;
const NOTE = (i) => `# Note ${i}\n${randomBytes(1000).toString('hex')}`.slice(0, 2048); // about 2 KB

/** Time fn n times. */
async function times(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); out.push(ms(t)); }
  return out;
}

/**
 * Everything on one storage (phone or stick).
 * @param {{notes?: number, reads?: number, saves?: number, runs?: number}} [n]  smaller numbers for the test
 */
export async function measureVault(r, label, base, sockDir, n = {}) {
  const notes = n.notes ?? 230;
  const root = join(base, 'vault12');
  mkdirSync(root, { recursive: true });
  const dk = newDataKey();
  const vaultId = newId();
  const { slot } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
  const store = await Store.create(join(root, 'data'), { headerText: buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [slot] }, dk), dk });
  dk.fill(0);
  const api = await createDataApi({ socketPath: join(sockDir, `${label}.sock`), getStore: () => store });
  const changes = { stop() {} };
  try {
    // the notes go in as one burst (one commit), like a sync would bring them
    await Promise.all(Array.from({ length: notes }, (_, i) => store.write(`notebook/vault/notes/n${i}.md`, NOTE(i))));
    await store.mkdir('notebook/vault/notes/sub');
    const fs = createHubFs({ socket: api.socketPath, token: api.issue('notebook') });
    let count = 0;
    await fs.readdir('vault/notes'); // warm up (first connection, JIT), not timed
    await fs.tree('vault/notes');
    const rd = await times(n.runs ?? 10, async () => { count = (await fs.readdir('vault/notes')).length; });
    r.add(`${label}: readdir of a folder with ${notes} notes (one request, depth 1)`, `${sum(rd)}; ${count} names`);
    const all = await times(n.runs ?? 10, () => fs.tree('vault/notes'));
    r.add(`${label}: the same folder as a whole tree (sizes and ids)`, sum(all));
    const k = n.reads ?? 100;
    const t = performance.now();
    const got = await Promise.allSettled(Array.from({ length: k }, (_, i) => fs.readFile(`vault/notes/n${i % notes}.md`)));
    const failed = got.filter((x) => x.status === 'rejected').length;
    r.add(`${label}: ${k} notes read at once`, `${Math.round(ms(t))} ms in all, ${failed ? `${failed} FAILED` : 'none failed'}`);

    const vault = new Vault(fs);
    const ch = new Changes(fs, { log: () => {} });
    Object.assign(changes, { stop: () => ch.stop() });
    ch.start();
    await new Promise((res) => setTimeout(res, 300)); // the watch is open
    const saves = [];
    const events = [];
    let version = (await vault.read('notes/n1.md')).version;
    for (let i = 0; i < (n.saves ?? 20); i++) {
      const { cursor } = ch.since();
      const seen = ch.wait(cursor, 5000).then((x) => ({ x, at: performance.now() }));
      const t0 = performance.now();
      const w = await vault.write('notes/n1.md', NOTE(1000 + i), version);
      saves.push(ms(t0));
      version = w.version;
      const s = await seen;
      events.push(s.x.paths.includes('notes/n1.md') ? s.at - t0 : 5000);
    }
    r.add(`${label}: Notebook save (stat, then write with ifMatch)`, sum(saves));
    r.add(`${label}: Notebook save -> its change event at the Notebook server`, sum(events));
    r.add(`${label}: verify (full)`, (await store.verify()).ok ? 'OK' : 'PROBLEMS');
  } finally {
    changes.stop();
    await api.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** For comparison: hubfs plain-file mode, readdir of a folder with 230 plain files (0b: no file is read). */
export async function measurePlain(r, label, base, n = {}) {
  const notes = n.notes ?? 230;
  const dir = join(base, 'plain12');
  mkdirSync(join(dir, 'vault', 'notes'), { recursive: true });
  try {
    for (let i = 0; i < notes; i++) writeFileSync(join(dir, 'vault', 'notes', `n${i}.md`), NOTE(i));
    const fs = createHubFs({ dir, socket: '', token: '' });
    const rd = await times(n.runs ?? 10, () => fs.readdir('vault/notes'));
    r.add(`${label}: plain files, readdir of ${notes} notes (hubfs plain-file mode)`, sum(rd));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
