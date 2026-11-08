import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, titleFromId } from '../hub/scaffold.mjs';
import { loadApp } from '../hub/apps.mjs';
import { loadEngines } from '../hub/engines.mjs';
import { ProcessManager } from '../hub/procman.mjs';
import { isPortFree } from '../hub/ports.mjs';
import { http } from './helpers.mjs';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const NAME = 'Tom\'s "Game" <1>';

test('node-server starter: valid, saves through hubfs (plain files without the vault), stops cleanly on SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stickhub-new-'));
  const appsDir = join(root, 'apps');
  const dataDir = join(root, 'data');
  const { dir, files } = await createApp(appsDir, { id: 'my-game', engine: 'node-server', name: NAME });
  assert.deepEqual(files.sort(), ['README.md', 'app.json', 'icon.svg', 'lib/hubfs.mjs', 'public/index.html', 'server.mjs']);
  assert.equal(await readFile(join(dir, 'lib', 'hubfs.mjs'), 'utf8'), await readFile(join(import.meta.dirname, '..', 'hub', 'appkit', 'hubfs.mjs'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(dir, 'app.json'), 'utf8')).data, 'hubfs');
  assert.doesNotMatch(await readFile(join(dir, 'server.mjs'), 'utf8'), /HUB_DATA_DIR|node:fs\/promises'.*writeFile/);
  execFileSync(process.execPath, ['--check', join(dir, 'server.mjs')]);
  const { engines } = await loadEngines();
  assert.deepEqual((await loadApp(dir, 'my-game', engines)).errors, []);

  const pm = new ProcessManager({ engines, appsDir, dataDir, portRange: { from: 27190, to: 27199 } });
  await pm.reload();
  const v = await pm.start('my-game');
  try {
    const page = await http(v.port, '/');
    assert.match(page.body, /<h1>Tom&#39;s &quot;Game&quot; &lt;1&gt;<\/h1>/);
    assert.equal(JSON.parse((await http(v.port, '/api/save')).body).count, undefined);
    const put = await http(v.port, '/api/save', { method: 'PUT', body: JSON.stringify({ count: 3 }) });
    assert.equal(put.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'my-game', 'save.json'), 'utf8')), { count: 3 });
    assert.equal(JSON.parse((await http(v.port, '/api/save')).body).count, 3);
    assert.equal((await http(v.port, '/api/save', { method: 'PUT', body: '{bad' })).status, 400);
    assert.equal((await http(v.port, '/..%2f..%2fapp.json')).status !== 200, true);
    assert.ok(pm.logs('my-game').some((l) => l.text.startsWith(`${NAME} on http://127.0.0.1:${v.port}/`)));
  } finally {
    const t0 = Date.now();
    await pm.stop('my-game');
    assert.ok(Date.now() - t0 < 2500, 'stopped on SIGTERM, not killed');
    assert.ok(!pm.logs('my-game').some((l) => /killing/.test(l.text)));
  }
  assert.equal(await isPortFree(v.port), true);
});

test('node-server starter with the vault on: the save lands in the vault, nothing in a data folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stickhub-new-'));
  const appsDir = join(root, 'apps');
  await createApp(appsDir, { id: 'my-game', engine: 'node-server' });
  const t = await makeTestStore();
  const api = await createDataApi({ socketPath: join(root, 'run', 'd.sock'), getStore: () => t.store });
  const { engines } = await loadEngines();
  const pm = new ProcessManager({ engines, appsDir, dataDir: join(root, 'data'), portRange: { from: 27190, to: 27199 }, dataApi: api });
  await pm.reload();
  try {
    const v = await pm.start('my-game');
    assert.equal((await http(v.port, '/api/save', { method: 'PUT', body: JSON.stringify({ count: 5 }) })).status, 200);
    assert.deepEqual(JSON.parse(String(await t.store.read('my-game/save.json'))), { count: 5 });
    assert.equal(JSON.parse((await http(v.port, '/api/save')).body).count, 5);
    await assert.rejects(readFile(join(root, 'data', 'my-game', 'save.json')), { code: 'ENOENT' });
  } finally {
    await pm.stopAll();
    await api.close();
    await t.store.close();
    await rm(root, { recursive: true, force: true });
    await rm(t.root, { recursive: true, force: true });
  }
});

test('static starter: valid and served', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stickhub-new-'));
  const appsDir = join(root, 'apps');
  const { dir } = await createApp(appsDir, { id: 'notes', engine: 'static' });
  const { engines } = await loadEngines();
  const app = await loadApp(dir, 'notes', engines);
  assert.deepEqual(app.errors, []);
  assert.equal(app.manifest.name, 'Notes');
  assert.equal(app.manifest.data, 'none');
  const pm = new ProcessManager({ engines, appsDir, dataDir: join(root, 'data'), portRange: { from: 27190, to: 27199 } });
  await pm.reload();
  const v = await pm.start('notes');
  assert.match((await http(v.port, '/')).body, /<h1>Notes<\/h1>/);
  await pm.stop('notes');
});

test('never overwrites; checks id and engine', async () => {
  const appsDir = join(await mkdtemp(join(tmpdir(), 'stickhub-new-')), 'apps');
  const { dir } = await createApp(appsDir, { id: 'one', engine: 'static' });
  await writeFile(join(dir, 'public', 'index.html'), 'mine');
  await assert.rejects(createApp(appsDir, { id: 'one', engine: 'node-server' }), /already exists. Nothing was changed/);
  assert.equal(await readFile(join(dir, 'public', 'index.html'), 'utf8'), 'mine');
  await assert.rejects(createApp(appsDir, { id: 'Bad_Id', engine: 'static' }), /App id/);
  await assert.rejects(createApp(appsDir, { id: 'two', engine: 'python' }), /--engine/);
  assert.equal(titleFromId('deep-dig'), 'Deep Dig');
});
