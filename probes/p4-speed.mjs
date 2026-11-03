// Probe 4: write / fsync / rename / read speed for one big file and for many small files.

import { open, rename, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { mbps, stats } from './lib.mjs';

const MB = 1 << 20;

/** Time an async function in ms. */
async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - t0), value };
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {string} dir  empty test folder
 * @param {string} label
 * @param {{bigMb: number, small: number}} size
 */
export async function runIn(r, dir, label, size) {
  r.section(`4. Speed (${label})`);

  // One big file in 1 MB chunks: write, fsync and rename timed separately.
  const chunk = randomBytes(MB);
  const big = join(dir, 'big.bin');
  const hash = createHash('sha256');
  const fh = await open(`${big}.part`, 'w');
  let write, sync;
  try {
    write = await timed(async () => { for (let i = 0; i < size.bigMb; i++) { await fh.write(chunk); hash.update(chunk); } });
    sync = await timed(() => fh.sync());
  } finally { await fh.close(); }
  const ren = await timed(() => rename(`${big}.part`, big));
  const bytes = size.bigMb * MB;
  r.add(`big ${size.bigMb} MB`, `write ${write.ms} ms, fsync ${sync.ms} ms, rename ${ren.ms} ms = ${mbps(bytes, write.ms + sync.ms)} MB/s`);
  const read = await timed(async () => createHash('sha256').update(await readFile(big)).digest('hex'));
  r.add('big read + sha256', `${read.ms} ms = ${mbps(bytes, read.ms)} MB/s (may come from cache), hash ${read.value === hash.digest('hex') ? 'matches' : 'DIFFERS'}`);
  await rm(big);

  // Many small files, the safe way (part + fsync + rename) and the plain way.
  const small = randomBytes(2048);
  await mkdir(join(dir, 'safe'));
  await mkdir(join(dir, 'plain'));
  const per = [];
  const safe = await timed(async () => {
    for (let i = 0; i < size.small; i++) {
      const t0 = performance.now();
      const f = join(dir, 'safe', `f${i}.json`);
      const h = await open(`${f}.part`, 'w');
      try { await h.writeFile(small); await h.sync(); } finally { await h.close(); }
      await rename(`${f}.part`, f);
      per.push(performance.now() - t0);
    }
  });
  r.add(`${size.small} small (2 KB) part+fsync+rename`, `${safe.ms} ms total, per file ms ${JSON.stringify(stats(per))}`);
  const plain = await timed(async () => {
    for (let i = 0; i < size.small; i++) await writeFile(join(dir, 'plain', `f${i}.json`), small);
  });
  r.add(`${size.small} small plain writeFile`, `${plain.ms} ms total, ${Math.round(plain.ms / size.small * 10) / 10} ms per file`);
  const list = await timed(async () => (await readdir(join(dir, 'safe'))).length + (await readdir(join(dir, 'plain'))).length);
  r.add(`readdir ${list.value} files`, `${list.ms} ms`);
  const readAll = await timed(async () => {
    for (let i = 0; i < size.small; i++) createHash('sha256').update(await readFile(join(dir, 'safe', `f${i}.json`))).digest();
  });
  r.add(`read + hash ${size.small} small`, `${readAll.ms} ms`);
  const del = await timed(async () => { await rm(join(dir, 'safe'), { recursive: true }); await rm(join(dir, 'plain'), { recursive: true }); });
  r.add(`delete ${size.small * 2} small`, `${del.ms} ms`);
}
