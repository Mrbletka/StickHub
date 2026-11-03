// Probe 5: does the stick's file system behave the way safe sync needs?
// Atomic write (part + fsync + rename), replace by rename, directory fsync, O_EXCL lock files,
// case rules, forbidden names, symlinks, permission bits, mtime precision, noexec.

import { open, writeFile, readFile, rename, readdir, mkdir, rm, symlink, chmod, stat, utimes, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { run as exec } from './lib.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Write a file the safe way: name.part, fsync, close, rename. */
async function safeWrite(file, data) {
  const fh = await open(`${file}.part`, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await rename(`${file}.part`, file);
}

/** Run one check; record "ok ..." or "FAIL ..." with the error code. Never throws. */
async function check(r, name, fn) {
  try { r.add(name, `ok ${(await fn()) ?? ''}`.trim()); } catch (e) { r.add(name, `FAIL ${e.code || e.message}`); }
}

/** Run an action that is expected to fail; record the error code it gave. */
async function expectError(r, name, fn) {
  try { await fn(); r.add(name, 'allowed (no error)'); } catch (e) { r.add(name, `error ${e.code || e.message}`); }
}

/**
 * @param {import('./lib.mjs').Report} r
 * @param {string} dir  empty test folder on the target file system
 * @param {string} label
 */
export async function runIn(r, dir, label) {
  r.section(`5. File system behaviour (${label})`);
  const data = randomBytes(1 << 20);

  await check(r, 'part+fsync+rename, hash matches', async () => {
    await safeWrite(join(dir, 'a.bin'), data);
    if (sha(await readFile(join(dir, 'a.bin'))) !== sha(data)) throw new Error('hash differs');
    await access(join(dir, 'a.bin.part')).then(() => { throw new Error('.part still there'); }, () => {});
  });
  await check(r, 'rename over an existing file', async () => {
    const next = randomBytes(4096);
    await safeWrite(join(dir, 'a.bin'), next);
    if (sha(await readFile(join(dir, 'a.bin'))) !== sha(next)) throw new Error('old content kept');
  });
  await check(r, 'fsync on a directory', async () => {
    const fh = await open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  });
  await check(r, 'lock file with O_EXCL (wx)', async () => {
    await writeFile(join(dir, '.lock'), 'one', { flag: 'wx' });
    try { await writeFile(join(dir, '.lock'), 'two', { flag: 'wx' }); } catch (e) {
      if (e.code === 'EEXIST') return 'second open refused with EEXIST';
      throw e;
    }
    throw new Error('second exclusive open succeeded');
  });
  await check(r, 'case', async () => {
    await writeFile(join(dir, 'Case.txt'), 'x');
    const insensitive = await access(join(dir, 'case.txt')).then(() => true, () => false);
    await rename(join(dir, 'Case.txt'), join(dir, 'CASE.txt'));
    const names = (await readdir(dir)).filter((n) => n.toLowerCase() === 'case.txt');
    return `${insensitive ? 'insensitive' : 'sensitive'}; case-only rename gives ${JSON.stringify(names)}`;
  });
  await check(r, 'Polish + long names', async () => {
    await writeFile(join(dir, 'zażółć gęślą.txt'), 'x');
    await writeFile(join(dir, `${'n'.repeat(200)}.conflict-20261103-120000.json`), 'x');
  });
  await expectError(r, 'name with ":"', () => writeFile(join(dir, 'a:b.txt'), 'x'));
  await expectError(r, 'name with "?"', () => writeFile(join(dir, 'a?b.txt'), 'x'));
  await expectError(r, 'symlink', () => symlink('a.bin', join(dir, 'link')));
  await check(r, 'chmod 755 sticks', async () => {
    await writeFile(join(dir, 'm.sh'), '#!/system/bin/sh\necho hi\n');
    const before = (await stat(join(dir, 'm.sh'))).mode & 0o777;
    await chmod(join(dir, 'm.sh'), 0o755);
    const after = (await stat(join(dir, 'm.sh'))).mode & 0o777;
    return `mode ${before.toString(8)} -> ${after.toString(8)}`;
  });
  const ex = await exec(join(dir, 'm.sh'), [], { timeout: 5000 });
  r.add('run a script directly (noexec?)', ex.ok ? `runs: ${ex.stdout.trim()}` : `blocked: ${ex.error}`);
  await check(r, 'mtime', async () => {
    const t0 = Date.now();
    await writeFile(join(dir, 't.txt'), 'x');
    const st = await stat(join(dir, 't.txt'));
    const fixed = new Date('2020-01-02T03:04:05.678Z');
    await utimes(join(dir, 't.txt'), fixed, fixed);
    const back = (await stat(join(dir, 't.txt'))).mtimeMs;
    return `new file off by ${Math.round(st.mtimeMs - t0)} ms; set 2020-01-02T03:04:05.678Z, read back off by ${Math.round(back - fixed.getTime())} ms`;
  });
  await check(r, 'rename a folder (journal dirs)', async () => {
    await mkdir(join(dir, 'd1'));
    await writeFile(join(dir, 'd1', 'f'), 'x');
    await rename(join(dir, 'd1'), join(dir, 'd2'));
    await readFile(join(dir, 'd2', 'f'));
  });
  await check(r, 'remove a folder tree', () => rm(join(dir, 'd2'), { recursive: true }));
}
