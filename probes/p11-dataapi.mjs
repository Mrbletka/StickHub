// Probe 11: the data API (job 3a) on the phone. A throwaway vault (random keys, recovery slot only) behind the API on
// a socket in the probe's own temp folder; never ~/.stickhub/run. Measures what an app feels through hubfs:
// small reads and writes, 5 MB, write -> event, and that a wrong token gets 401. Paths are never printed.

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { newDataKey, newId } from '../hub/vault/keys.mjs';
import { makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader } from '../hub/vault/header.mjs';
import { Store } from '../hub/vault/store.mjs';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';

const ms = (t) => performance.now() - t;
const pct = (xs, p) => Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)] * 10) / 10;
const sum = (xs) => `p50 ${pct(xs, 0.5)} ms, p95 ${pct(xs, 0.95)} ms, max ${Math.round(Math.max(...xs) * 10) / 10} ms`;

/** One vault folder behind the API: all measurements. */
async function measure(r, label, base, sockDir) {
  const root = join(base, 'vault11');
  mkdirSync(root, { recursive: true });
  const dk = newDataKey();
  const vaultId = newId();
  const { slot } = makeRecoverySlot({ dk, vaultId, epoch: 1 });
  const store = await Store.create(join(root, 'data'), { headerText: buildHeader({ vaultId, epoch: 1, hseq: 1, slots: [slot] }, dk), dk });
  dk.fill(0);
  const api = await createDataApi({ socketPath: join(sockDir, `${label}.sock`), getStore: () => store });
  try {
    const fs = createHubFs({ socket: api.socketPath, token: api.issue('probe') });
    const writes = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      await fs.writeFile(`n/note${i % 20}.md`, `note ${i} ${randomBytes(900).toString('hex')}`);
      writes.push(ms(t));
    }
    r.add(`${label}: 100 small writes (2 KB) through hubfs`, sum(writes));
    const reads = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await fs.readFile(`n/note${i % 20}.md`);
      reads.push(ms(t));
    }
    r.add(`${label}: 200 small reads through hubfs`, sum(reads));
    const big = randomBytes(5 * 1024 * 1024);
    let t = performance.now();
    await fs.writeFile('m/big.bin', big);
    const tw = Math.round(ms(t));
    t = performance.now();
    const back = await fs.readFile('m/big.bin');
    r.add(`${label}: 5 MB write / read`, `${tw} ms / ${Math.round(ms(t))} ms, same bytes: ${back.equals(big)}`);
    const ac = new AbortController();
    const it = fs.watch({ signal: ac.signal })[Symbol.asyncIterator]();
    const first = it.next(); // the first poll learns the current seq, the next one waits
    await new Promise((res) => setTimeout(res, 300));
    t = performance.now();
    await fs.writeFile('n/event.md', 'event');
    const te = (await first).value;
    r.add(`${label}: write -> its event`, `${Math.round(ms(t))} ms (${te?.path === 'n/event.md' ? 'right event' : 'WRONG event'})`);
    ac.abort();
    const wrong = createHubFs({ socket: api.socketPath, token: 'A'.repeat(43) });
    r.add(`${label}: wrong token`, await wrong.stat('n/note1.md').then(() => 'ANSWERED (bad)', (e) => (e.status === 401 ? '401 (good)' : `${e.status} ${e.hubCode}`)));
    r.add(`${label}: verify (full)`, (await store.verify()).ok ? 'OK' : 'PROBLEMS');
  } finally {
    await api.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {{stickDir?: string, localDir: string}} ctx  probe 0's test folders
 */
export async function run11(r, ctx) {
  r.section('11. Data API (hub/dataapi + hubfs) on the phone');
  const tmp = mkdtempSync(join(tmpdir(), 'p11-'));
  const sockDir = join(tmp, 'run');
  try {
    const api = await createDataApi({ socketPath: join(sockDir, 'x.sock'), getStore: () => null });
    r.add('socket path length (this probe)', `${Buffer.byteLength(api.socketPath)} bytes (limit 107)`);
    r.add('run dir / socket mode bits', `${(statSync(sockDir).mode & 0o777).toString(8)} / ${(statSync(api.socketPath).mode & 0o777).toString(8)} (want 700 / 600)`);
    await api.close();
    await measure(r, 'phone', ctx.localDir, sockDir);
    if (ctx.stickDir) await measure(r, 'stick', ctx.stickDir, sockDir); else r.add('stick', 'no stick test folder (is it plugged in?)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
