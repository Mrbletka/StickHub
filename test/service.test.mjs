import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { exists } from '../hub/sync/fsx.mjs';
import { setup, write, gitc } from './sync-helpers.mjs';
import { http } from './helpers.mjs';

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

test('hub: plug-in sync, Sync now, pending while an app runs, sync after it stops, unplug', async () => {
  const fx = await setup();
  // A real (static) app in the fixture clone, committed so the clone stays clean.
  await write(join(fx.root, 'apps', 'demo', 'app.json'), JSON.stringify({ id: 'demo', name: 'Demo', engine: 'static' }));
  await write(join(fx.root, 'apps', 'demo', 'index.html'), 'demo');
  gitc(fx.root, 'add', '-A');
  gitc(fx.root, 'commit', '-qm', 'demo app');
  let volumes = [];
  const hub = await createHub({ root: fx.root, port: 0, portRange: { from: 47150, to: 47160 },
    stick: { listVolumes: async () => ({ volumes, error: null }), pollMs: 0, device: 'dev-0000000000aa' }, home: join(fx.base, 'home') });
  const port = Number(new URL(await hub.listen()).port);
  const auth = { 'x-hub-token': hub.token };
  const post = (path) => http(port, path, { method: 'POST', headers: auth });
  const stick = async () => JSON.parse((await http(port, '/api/stick', { headers: auth })).body);
  try {
    assert.equal((await stick()).state, 'none');
    assert.equal((await post('/api/sync')).status, 409);

    volumes = [{ mountPoint: fx.mount }];
    await hub.stick.poll();
    const s1 = await until(async () => { const s = await stick(); return s.last && !s.sync.running && s; });
    assert.equal(s1.state, 'connected');
    assert.equal(s1.last.result, 'ok', JSON.stringify(s1.last));
    assert.equal(s1.code.state, 'update');
    assert.equal(s1.codeState, 'complete');
    assert.equal(await readFile(join(fx.hubDir, 'data', 'demo', 'save.json'), 'utf8'), '{"level":1}');

    // Running app: its data waits.
    await post('/api/apps/demo/start');
    await write(join(fx.root, 'data', 'demo', 'save.json'), '{"level":2}');
    assert.equal((await post('/api/sync?what=data')).status, 202);
    const s2 = await until(async () => { const s = await stick(); return !s.sync.running && s.last.what === 'data' && s; });
    assert.deepEqual(s2.pending, ['demo']);
    assert.equal(await readFile(join(fx.hubDir, 'data', 'demo', 'save.json'), 'utf8'), '{"level":1}');

    // Stopping the app syncs its data by itself.
    await post('/api/apps/demo/stop');
    await until(async () => (await readFile(join(fx.hubDir, 'data', 'demo', 'save.json'), 'utf8')) === '{"level":2}');
    const s3 = await until(async () => { const s = await stick(); return !s.sync.running && s.pending.length === 0 && s; });
    assert.equal(s3.last.result, 'ok');

    assert.equal((await post('/api/sync?what=nope')).status, 400);
    volumes = [];
    await hub.stick.poll();
    assert.equal((await stick()).state, 'none');
    assert.equal(await exists(join(fx.hubDir, '.lock')), false);
  } finally {
    await hub.close();
    await fx.cleanup();
  }
});
