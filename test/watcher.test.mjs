import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watcher } from '../hub/watcher.mjs';
import { initStick } from '../hub/stick.mjs';

async function fakes({ openOk = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'stickhub-watch-'));
  const stick = join(base, 'stick');
  const blank = join(base, 'blank');
  await mkdir(stick);
  await mkdir(blank);
  await initStick(stick, { name: 'Test' });
  const calls = { ensure: 0, open: [], notify: [], pull: 0 };
  const logs = [];
  let volumes = [];
  let settings = { autoPull: false, requireStick: false };
  const w = new Watcher({
    listVolumes: async () => ({ volumes: volumes.map((m) => ({ mountPoint: m })), error: null }),
    ensureHub: async () => { calls.ensure++; return { started: calls.ensure === 1 }; },
    loginUrl: async () => `http://127.0.0.1:8787/?code=c${calls.open.length}`,
    openUrl: async (url) => { calls.open.push(url); return openOk ? { ok: true } : { ok: false, error: 'blocked' }; },
    notify: async (n) => { calls.notify.push(n); return { ok: true }; },
    settings: async () => settings,
    pull: async () => { calls.pull++; return 'ok'; },
    log: (m) => logs.push(m),
    loginAction: '/usr/bin/node /x/hub/cli.mjs login --open',
  });
  return { w, calls, logs, stick, blank, plug: (...m) => { volumes = m; }, setSettings: (s) => { settings = s; } };
}

test('plug-in opens the hub once; re-plugging opens it again', async () => {
  const f = await fakes();
  await f.w.check();
  assert.equal(f.calls.open.length, 0);
  f.plug(f.stick);
  await f.w.check();
  await f.w.check();
  assert.equal(f.calls.ensure, 1);
  assert.deepEqual(f.calls.open, ['http://127.0.0.1:8787/?code=c0']);
  assert.match(f.logs.join('\n'), /hub started[\s\S]*hub opened \d+ ms after the stick was found/);
  f.plug();
  await f.w.check();
  assert.match(f.logs.at(-1), /stick removed/);
  f.plug(f.stick);
  await f.w.check();
  assert.equal(f.calls.open.length, 2);
  assert.equal(f.calls.pull, 0, 'never pulls unless autoPull is on');
});

test('if the browser cannot be opened, a notification with a login action is shown', async () => {
  const f = await fakes({ openOk: false });
  f.plug(f.stick);
  await f.w.check();
  assert.equal(f.calls.notify.length, 1);
  assert.equal(f.calls.notify[0].action, '/usr/bin/node /x/hub/cli.mjs login --open');
});

test('a stick without HUB is reported once and never opens the hub; autoPull runs only when set', async () => {
  const f = await fakes();
  f.plug(f.blank);
  await f.w.check();
  await f.w.check();
  assert.equal(f.calls.open.length, 0);
  assert.equal(f.logs.filter((l) => /without HUB/.test(l)).length, 1);
  f.setSettings({ autoPull: true, requireStick: false });
  f.plug(f.stick);
  await f.w.check();
  assert.equal(f.calls.pull, 1);
});
