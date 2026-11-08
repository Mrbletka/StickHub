import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEngines } from '../hub/engines.mjs';
import { ProcessManager } from '../hub/procman.mjs';
import { isPortFree } from '../hub/ports.mjs';
import { makeApps, http, GOOD_SERVER } from './helpers.mjs';

const RANGE = { from: 27100, to: 27120 };
let fx, pm;

before(async () => {
  fx = await makeApps({
    good: { 'app.json': { id: 'good', name: 'Good', engine: 'node-server', entry: 'server.mjs' }, 'server.mjs': GOOD_SERVER },
    site: { 'app.json': { id: 'site', name: 'Site', engine: 'static', entry: 'www' }, 'www/index.html': 'static ok' },
    crash: { 'app.json': { id: 'crash', name: 'Crash', engine: 'node-server', entry: 'server.mjs' },
      'server.mjs': 'console.error("boom: missing config"); process.exit(3);' },
    deaf: { 'app.json': { id: 'deaf', name: 'Deaf', engine: 'node-server', entry: 'server.mjs' },
      'server.mjs': 'setInterval(() => {}, 1000);' },
    stubborn: { 'app.json': { id: 'stubborn', name: 'Stubborn', engine: 'node-server', entry: 'server.mjs' },
      'server.mjs': GOOD_SERVER.replace("process.on('SIGTERM', () => s.close(() => process.exit(0)));", "process.on('SIGTERM', () => console.log('ignoring TERM'));") },
    later: { 'app.json': { id: 'later', name: 'Later', engine: 'node-server', entry: 'server.mjs' },
      'server.mjs': GOOD_SERVER + 'setTimeout(() => process.exit(7), 300);' },
    badjson: { 'app.json': '{ nope' },
    'Bad_Folder': { 'app.json': { id: 'x', name: 'X', engine: 'static' } },
    mismatch: { 'app.json': { id: 'other', name: 'M', engine: 'static' } },
    noengine: { 'app.json': { id: 'noengine', name: 'N', engine: 'python' } },
    atomic: { 'app.json': { id: 'atomic', name: 'Atomic', engine: 'static', atomicData: true }, 'index.html': 'a' },
    fixed: { 'app.json': { id: 'fixed', name: 'Fixed', engine: 'static', port: 27100 }, 'index.html': 'f' },
  });
  const { engines } = await loadEngines();
  pm = new ProcessManager({ engines, appsDir: fx.appsDir, dataDir: fx.dataDir, portRange: RANGE, startTimeoutMs: 6000 });
  await pm.reload();
});
after(async () => { await pm.stopAll(); await fx.cleanup(); });

test('broken apps are listed with their problems; good ones are fine', () => {
  const byId = Object.fromEntries(pm.list().map((a) => [a.id, a]));
  assert.deepEqual(byId.good.problems, []);
  assert.match(byId.badjson.problems.join(), /app.json/);
  assert.match(byId.Bad_Folder.problems.join(), /folder name/);
  assert.match(byId.mismatch.problems.join(), /match the folder/);
  assert.match(byId.noengine.problems.join(), /not installed/);
});

test('node-server: start, env, data dir, logs, stop frees the port', async () => {
  const v = await pm.start('good');
  assert.equal(v.status, 'running');
  assert.ok(v.port >= RANGE.from && v.port <= RANGE.to);
  const r = await http(v.port, '/');
  assert.equal(r.body, `hello good ${join(fx.dataDir, 'good')}`);
  assert.ok(pm.logs('good').some((l) => l.text === `up on ${v.port}`));
  assert.equal((await pm.start('good')).port, v.port, 'second start is a no-op');
  await pm.stop('good');
  assert.equal(pm.view('good').status, 'stopped');
  assert.equal(await isPortFree(v.port), true);
});

test('static engine: start, serve, stop frees the port', async () => {
  const v = await pm.start('site');
  assert.equal((await http(v.port, '/')).body, 'static ok');
  await pm.stop('site');
  assert.equal(await isPortFree(v.port), true);
});

test('two apps get different ports; restart works', async () => {
  const [a, b] = await Promise.all([pm.start('good'), pm.start('site')]);
  assert.notEqual(a.port, b.port);
  const again = await pm.restart('good');
  assert.equal(again.status, 'running');
  assert.equal((await http(again.port, '/')).status, 200);
  await pm.stopAll();
  assert.equal(pm.view('good').status, 'stopped');
  assert.equal(pm.view('site').status, 'stopped');
});

test('an app that quits while starting shows the error and its log', async () => {
  await assert.rejects(pm.start('crash'), /quit while starting/);
  assert.equal(pm.view('crash').status, 'error');
  assert.ok(pm.logs('crash').some((l) => l.s === 'err' && /boom/.test(l.text)));
});

test('an app that never opens its port is stopped after the timeout', async () => {
  await assert.rejects(pm.start('deaf'), /nothing answered on port/);
  assert.equal(pm.view('deaf').status, 'error');
});

test('an app that ignores SIGTERM is killed', async () => {
  const v = await pm.start('stubborn');
  const t0 = Date.now();
  await pm.stop('stubborn');
  assert.ok(Date.now() - t0 >= 2900, 'waited the grace time');
  assert.equal(await isPortFree(v.port), true);
  assert.ok(pm.logs('stubborn').some((l) => /killing/.test(l.text)));
});

test('an app that dies by itself turns into an error', async () => {
  await pm.start('later');
  await new Promise((r) => setTimeout(r, 800));
  const v = pm.view('later');
  assert.equal(v.status, 'error');
  assert.match(v.error, /exit code 7/);
});

test('broken and unknown apps cannot start', async () => {
  await assert.rejects(pm.start('badjson'), /has problems/);
  await assert.rejects(pm.start('nope'), /No app/);
});

test('the sample app saves into its data dir', async () => {
  const { engines } = await loadEngines();
  const real = new ProcessManager({ engines, appsDir: join(import.meta.dirname, '..', 'apps'), dataDir: fx.dataDir, portRange: RANGE });
  await real.reload();
  const v = await real.start('tap-counter');
  const r = await http(v.port, '/tap', { method: 'POST' });
  assert.equal(JSON.parse(r.body).count, 1);
  assert.equal(JSON.parse(await readFile(join(fx.dataDir, 'tap-counter', 'count.json'), 'utf8')).count, 1);
  const t = await real.start('pocket-timer');
  assert.match((await http(t.port, '/')).body, /Pocket Timer/);
  await real.stopAll();
});

test('atomicData apps do not block sync; fixed ports are kept free for their app', async () => {
  const a = await pm.start('atomic');
  const g = await pm.start('good');
  assert.deepEqual([...pm.syncBlockers()], ['good']);
  assert.equal(pm.view('atomic').atomicData, true);
  assert.notEqual(g.port, 27100, 'the fixed port of "fixed" is not handed out');
  const f = await pm.start('fixed');
  assert.equal(f.port, 27100);
  await pm.stopAll();
  void a;
});
