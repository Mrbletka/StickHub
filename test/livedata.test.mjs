import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHub } from '../hub/server.mjs';
import { initStick } from '../hub/stick.mjs';
import { readCmdline } from '../hub/proc.mjs';
import { makeApps, http } from './helpers.mjs';

// An app that saves all the time, atomically (temp file + rename), as the app rules say.
const WRITER = `
import { createServer } from 'node:http';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.env.HUB_DATA_DIR;
await mkdir(dir, { recursive: true });
let n = 0;
setInterval(async () => {
  n++;
  const body = JSON.stringify({ n, pad: 'x'.repeat(20000) });
  try { await writeFile(join(dir, 'state.json.part'), body); await rename(join(dir, 'state.json.part'), join(dir, 'state.json')); } catch { /* stick gone */ }
}, 10);
const s = createServer((q, r) => r.end('writer ' + n)).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => s.close(() => process.exit(0)));
`;
const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

async function fixture() {
  const fx = await makeApps({ writer: { 'app.json': { id: 'writer', name: 'Writer', engine: 'node-server', entry: 'server.mjs' }, 'server.mjs': WRITER } });
  const mount = join(fx.root, 'stick');
  await mkdir(mount);
  await initStick(mount, { name: 'Test' });
  let volumes = [];
  const lv = async () => ({ volumes: volumes.map((m) => ({ mountPoint: m })), error: null });
  const hub = await createHub({ root: fx.root, port: 0, home: join(fx.root, 'home'), portRange: { from: 27240, to: 27249 },
    stick: { listVolumes: lv, pollMs: 0, device: 'dev-0000000000cc' }, dataOnStick: { listVolumes: lv, pollMs: 0 } });
  const port = Number(new URL(await hub.listen()).port);
  const call = (path, method = 'GET') => http(port, path, { method, headers: { 'x-hub-token': hub.token } });
  return { fx, mount, hub, call, plug: (on) => { volumes = on ? [mount] : []; }, data: join(mount, 'HUB', 'data') };
}

test('data on the stick: no stick = no apps; pull while writing; plug back in; clean stop', async () => {
  const f = await fixture();
  try {
    await f.hub.live.poll();
    let st = JSON.parse((await f.call('/api/status')).body);
    assert.deepEqual([st.mode, st.live.on, st.live.attached, st.live.removed], ['data-on-stick', true, false, false]);
    const refused = await f.call('/api/apps/writer/start', 'POST');
    assert.equal(refused.status, 500);
    assert.match(JSON.parse(refused.body).error, /Plug in the stick/);

    f.plug(true);
    await f.hub.live.poll();
    st = JSON.parse((await f.call('/api/status')).body);
    assert.equal(st.live.attached, true);
    assert.ok(await stat(join(f.mount, 'HUB', '.running.json')), 'the stick is marked as in use');
    assert.equal((await f.call('/api/apps/writer/start', 'POST')).status, 200);
    const pid = f.hub.procman.state.get('writer').handle.pid;
    assert.ok(await until(async () => (await readFile(join(f.data, 'writer', 'state.json'), 'utf8').catch(() => '')).length > 0, 2000), 'saves land on the stick');
    await new Promise((r) => setTimeout(r, 300));

    // Pull: the folder vanishes and the volume is gone from mountinfo.
    const t0 = Date.now();
    renameSync(f.mount, `${f.mount}.pulled`);
    f.plug(false);
    await f.hub.live.poll();
    const stopped = Date.now() - t0;
    assert.ok(!(await readCmdline(pid)), 'the app process is gone');
    assert.ok(stopped < 2000, `apps stopped in ${stopped} ms`);
    console.log(`# pull -> apps stopped in ${stopped} ms`);
    st = JSON.parse((await f.call('/api/status')).body);
    assert.deepEqual([st.live.attached, st.live.removed], [false, true], 'the hub keeps running and says "Stick removed"');
    assert.equal(f.hub.procman.view('writer').status, 'stopped');
    const save = JSON.parse(await readFile(join(`${f.mount}.pulled`, 'HUB', 'data', 'writer', 'state.json'), 'utf8'));
    assert.ok(save.n > 5, 'the save is complete JSON');
    assert.match((await f.call('/api/apps/writer/start', 'POST')).body, /Plug in the stick/);

    // Plug back in (with a temp file a pull could leave): it carries on, reports the pull, starts nothing by itself.
    renameSync(`${f.mount}.pulled`, f.mount);
    await writeFile(join(f.data, 'writer', 'state.json.part'), 'half');
    f.plug(true);
    await f.hub.live.poll();
    st = JSON.parse((await f.call('/api/status')).body);
    assert.equal(st.live.attached, true);
    assert.equal(st.live.lastPull.partsRemoved, 1);
    assert.deepEqual(await readdir(join(f.data, 'writer')), ['state.json']);
    assert.equal(f.hub.procman.view('writer').status, 'stopped', 'apps start again only when tapped');
  } finally {
    await f.hub.close();
  }
  await assert.rejects(stat(join(f.mount, 'HUB', '.running.json')), 'a clean stop removes the marker');
  await f.fx.cleanup();
});

test('an interrupted sync (journal on the stick) is finished at plug-in', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.mount, 'HUB', '.journal.json'), JSON.stringify({ started: new Date().toISOString(), device: 'x' }));
    f.plug(true);
    await f.hub.live.poll();
    const st = JSON.parse((await f.call('/api/status')).body);
    assert.equal(st.live.journal.result, 'ok');
    await assert.rejects(stat(join(f.mount, 'HUB', '.journal.json')));
    assert.equal(st.live.attached, true);
  } finally {
    await f.hub.close();
    await f.fx.cleanup();
  }
});

test('the stick vanishing while the hub starts leaves a working hub that waits for it', async () => {
  const f = await fixture();
  try {
    f.plug(true);
    renameSync(f.mount, `${f.mount}.pulled`); // listed in mountinfo for a moment, but already gone
    await f.hub.live.poll();
    let st = JSON.parse((await f.call('/api/status')).body);
    assert.equal(st.live.attached, false);
    assert.match((await f.call('/api/apps/writer/start', 'POST')).body, /Plug in the stick/);
    renameSync(`${f.mount}.pulled`, f.mount);
    await f.hub.live.poll();
    st = JSON.parse((await f.call('/api/status')).body);
    assert.equal(st.live.attached, true);
  } finally {
    await f.hub.close();
    await f.fx.cleanup();
  }
});

test('the stick is watched on a timer even when pollMs is passed as undefined', async () => {
  const { LiveData } = await import('../hub/livedata.mjs');
  const fakePm = { setDataDir() {} };
  const live = new LiveData({ procman: fakePm, listVolumes: async () => ({ volumes: [] }), root: '/x', git: {}, device: async () => 'd', pollMs: undefined });
  assert.equal(live.o.pollMs, 500);
  await live.start();
  assert.ok(live.timer, 'a timer runs');
  await live.stop();
});
