// Fixtures for sync tests: a git clone with code and data, and a folder that acts as the stick.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createGit } from '../hub/platform/git.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { initStick, readStick } from '../hub/stick.mjs';
import { SyncRun } from '../hub/sync/runner.mjs';

export async function write(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Run git in a folder (test only). */
export function gitc(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
}

/** A clone with hub/ and apps/ committed, and data/ (not tracked). Plus a stick folder with HUB/. */
export async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'stickhub-sync-'));
  const root = join(base, 'phone');
  const mount = join(base, 'stick');
  await mkdir(mount);
  await write(join(root, 'hub', 'server.mjs'), 'export const v = 1;\n');
  await write(join(root, 'hub', 'ui', 'app.js'), 'console.log(1);\n');
  await write(join(root, 'apps', 'demo', 'app.json'), '{"id":"demo"}\n');
  await write(join(root, 'README.md'), 'not code\n');
  await write(join(root, '.gitignore'), 'data/\nsync-state.json\n.trash/\n');
  gitc(root, 'init', '-q', '-b', 'main');
  gitc(root, 'add', '-A');
  gitc(root, 'commit', '-qm', 'one');
  await write(join(root, 'data', 'demo', 'save.json'), '{"level":1}');
  await write(join(root, 'data', 'demo', 'deep', 'more.txt'), 'more');
  const info = await initStick(mount, { name: 'Test stick' });
  return { base, root, mount, hubDir: join(mount, 'HUB'), info, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** Build a run with the current stick.json. */
export async function makeRun(fx, opts = {}) {
  const st = await readStick(fx.mount);
  if (st.state !== 'ok') throw new Error(`stick: ${st.state} ${st.error || ''}`);
  return new SyncRun({ root: fx.root, hubDir: fx.hubDir, stick: st.info, fsx: opts.fsx || createFsx(), git: createGit(fx.root),
    device: opts.device || 'dev-000000000001', running: opts.running, what: opts.what || { data: true, code: true }, now: opts.now });
}
