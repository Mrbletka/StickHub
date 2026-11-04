import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatReport } from '../hub/doctor.mjs';
import { initStick } from '../hub/stick.mjs';
import { findStick } from '../hub/stick.mjs';

/** A fake Termux phone where everything is set up; tests break one thing at a time. */
async function phone() {
  const base = await mkdtemp(join(tmpdir(), 'stickhub-doctor-'));
  const root = join(base, 'StickHub');
  const userHome = join(base, 'home');
  const mount = join(base, 'stick');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(userHome, 'storage', 'shared'), { recursive: true });
  await mkdir(join(userHome, '.shortcuts', 'tasks'), { recursive: true });
  await writeFile(join(userHome, '.shortcuts', 'tasks', 'StickHub'), `#!/bin/sh\ncd '${root}' || exit 1\n`);
  await chmod(join(userHome, '.shortcuts', 'tasks', 'StickHub'), 0o700);
  await mkdir(mount);
  await initStick(mount, { name: 'Test' });
  const home = join(base, 'dot-stickhub');
  await mkdir(home);
  await writeFile(join(home, 'token.json'), JSON.stringify({ token: 'a'.repeat(64) }));
  return {
    root, home, userHome, env: { TERMUX_VERSION: '0.119.0-beta.3' }, nodeVersion: '24.22.1', mount,
    hasCmd: () => true,
    run: async (cmd) => ({ ok: true, stdout: cmd === 'git' ? 'git version 2.56.0\n' : '{}', stderr: '' }),
    listVolumes: async () => ({ volumes: [{ mountPoint: mount }], error: null }),
    findStick: (v) => findStick(v),
    callHub: async () => ({ status: 200, body: { name: 'StickHub', mode: 'phone' } }),
    isPortFree: async () => false,
    runningWatcher: async () => ({ pid: 123 }),
  };
}
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('a fully set up phone: all ok', async () => {
  const c = await phone();
  const r = await runDoctor(c);
  assert.deepEqual(r.filter((x) => x.state !== 'ok').map((x) => x.name), []);
  assert.match(formatReport(r), /All good\./);
  assert.match(byName(r).Stick.detail, /"Test" at .*writable/);
});

test('each missing piece says what is wrong and how to fix it', async () => {
  const c = await phone();
  c.nodeVersion = '22.1.0';
  c.hasCmd = (cmd) => cmd !== 'termux-open-url';
  c.isPortFree = async () => false;
  c.callHub = async () => null;
  c.runningWatcher = async () => null;
  c.userHome = join(c.userHome, 'nothing-here');
  c.listVolumes = async () => ({ volumes: [], error: null });
  const r = byName(await runDoctor(c));
  assert.equal(r.Node.state, 'warn');
  assert.equal(r.Node.fix, 'pkg upgrade nodejs');
  assert.equal(r['termux-api'].state, 'fail');
  assert.equal(r['termux-api'].fix, 'pkg install termux-api');
  assert.match(r['Storage permission'].fix, /termux-setup-storage/);
  assert.match(r['Widget shortcuts'].fix, /widget install/);
  assert.equal(r.Hub.state, 'fail');
  assert.match(r.Hub.detail, /used by another program/);
  assert.match(r.Watcher.fix, /StickHub widget/);
  assert.equal(r.Stick.state, 'info');
  const text = formatReport(Object.values(r));
  assert.match(text, /\[XX\] termux-api\s+missing: termux-open-url\n\s+Fix: pkg install termux-api/);
  assert.match(text, /problem\(s\)/);
});

test('Termux:API app missing (the commands hang), a blank stick, no hub, a broken check', async () => {
  const c = await phone();
  c.run = async (cmd) => (cmd === 'git' ? { ok: true, stdout: 'git version 2.56.0' } : { ok: false, error: 'timed out after 8000 ms' });
  const blank = join(c.mount, '..', 'blank');
  await mkdir(blank);
  c.listVolumes = async () => ({ volumes: [{ mountPoint: blank }], error: null });
  c.callHub = async () => null;
  c.isPortFree = async () => true;
  c.runningWatcher = async () => { throw new Error('boom'); };
  const r = byName(await runDoctor(c));
  assert.match(r['termux-api'].fix, /Termux:API app from F-Droid/);
  assert.equal(r.Stick.state, 'warn');
  assert.match(r.Stick.fix, /stick init/);
  assert.equal(r.Hub.state, 'info');
  assert.equal(r.watcher.state, 'fail', 'a crashing check is reported, the others still run');
  assert.match(r.watcher.detail, /boom/);
});
