import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../hub/platform/git.mjs';
import { createFsx } from '../hub/sync/fsx.mjs';
import { initStick, readStick } from '../hub/stick.mjs';
import { SyncRun } from '../hub/sync/runner.mjs';
import { verifyStickCode, startStickHub, checkAfterPull } from '../hub/stickmode.mjs';
import { callHub } from '../hub/hubctl.mjs';
import { readCmdline } from '../hub/proc.mjs';

const PORT = 47231;
// An app that saves all the time, atomically (temp file + rename), like a real app should.
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
  try { await writeFile(join(dir, 'state.json.part'), body); await rename(join(dir, 'state.json.part'), join(dir, 'state.json')); } catch (e) { /* stick gone */ }
}, 10);
const s = createServer((q, r) => r.end('writer ' + n)).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => s.close(() => process.exit(0)));
`;

let base, root, mount, home, git;
const gitc = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const ping = () => callHub('/api/ping', { port: PORT, timeout: 500 });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'stickhub-stickmode-'));
  root = join(base, 'phone');
  mount = join(base, 'stick');
  home = join(base, 'home');
  await mkdir(join(root, 'apps', 'writer'), { recursive: true });
  await mkdir(mount);
  await cp(join(import.meta.dirname, '..', 'hub'), join(root, 'hub'), { recursive: true });
  await writeFile(join(root, 'apps', 'writer', 'app.json'), JSON.stringify({ id: 'writer', name: 'Writer', engine: 'node-server', entry: 'server.mjs' }));
  await writeFile(join(root, 'apps', 'writer', 'server.mjs'), WRITER);
  gitc('init', '-q', '-b', 'main');
  gitc('add', '-A');
  gitc('commit', '-qm', 'code');
  git = createGit(root);
  await initStick(mount, { name: 'Test' });
  const st = await readStick(mount);
  const r = await new SyncRun({ root, hubDir: st.hubDir, stick: st.info, fsx: createFsx(), git, device: 'dev-0000000000bb', what: { code: true } }).run();
  assert.equal(r.result, 'ok', r.errors.join());
  process.env.STICKHUB_MOUNTS = mount; // the hub on the stick finds its stick this way
  process.env.STICKHUB_HOME = home;
});
after(async () => {
  delete process.env.STICKHUB_MOUNTS;
  delete process.env.STICKHUB_HOME;
  await rm(base, { recursive: true, force: true });
});

test('only code that is exactly a commit of this phone may run', async () => {
  const st = await readStick(mount);
  assert.deepEqual(await verifyStickCode({ git, hubDir: st.hubDir, stick: st.info }), { ok: true, problems: [] });
  const file = join(st.hubDir, 'hub', 'api.mjs');
  const orig = await readFile(file);
  await writeFile(file, `${orig}\n// changed elsewhere`);
  await mkdir(join(st.hubDir, 'apps', 'evil'));
  await writeFile(join(st.hubDir, 'apps', 'evil', 'app.json'), '{}');
  const v = await verifyStickCode({ git, hubDir: st.hubDir, stick: st.info });
  assert.equal(v.ok, false);
  assert.match(v.problems.join('\n'), /changed on the stick: hub\/api\.mjs/);
  assert.match(v.problems.join('\n'), /not part of the code: apps\/evil\/app\.json/);
  await assert.rejects(startStickHub({ root, home, mount, git, fsx: createFsx(), port: PORT }), /not started/);
  assert.equal(await ping(), null, 'nothing was started');
  await writeFile(file, orig);
  await rm(join(st.hubDir, 'apps', 'evil'), { recursive: true });
  const unknown = verifyStickCode({ git, hubDir: st.hubDir, stick: { ...st.info, commit: 'f'.repeat(40) } });
  assert.match((await unknown).problems[0], /did not make/);
});

test('pulling the stick while an app writes: apps stop within 2 s, files stay whole, next start reports it', async () => {
  const r = await startStickHub({ root, home, mount, git, fsx: createFsx(), port: PORT });
  assert.equal(r.already, false);
  const p = await ping();
  assert.equal(p.body.mode, 'stick');
  const token = JSON.parse(await readFile(join(home, 'token.json'), 'utf8')).token;
  const started = await callHub('/api/apps/writer/start', { method: 'POST', token, port: PORT });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const pids = JSON.parse(await readFile(join(home, 'apps-running.json'), 'utf8'));
  const appPid = pids.writer.pid;
  await new Promise((res) => setTimeout(res, 400)); // let it write for a while
  assert.ok(JSON.parse(await readFile(join(mount, 'HUB', 'data', 'writer', 'state.json'), 'utf8')).n > 5);

  const t0 = Date.now();
  renameSync(mount, `${mount}.pulled`); // the stick is gone
  assert.ok(await until(async () => !(await readCmdline(appPid)), 2500), 'the app stopped within 2.5 s of the pull');
  const appGone = Date.now() - t0;
  assert.ok(await until(async () => !(await ping()), 3000), 'the hub stopped too');
  const log = await readFile(join(root, 'logs', 'hub-stick.log'), 'utf8');
  const stopped = Number(/apps stopped in (\d+) ms/.exec(log)?.[1]);
  assert.ok(stopped < 2000, `apps stopped in ${stopped} ms`);
  console.log(`# pull -> app gone ${appGone} ms (stop took ${stopped} ms)`);

  // On the pulled stick: the save is complete JSON (never half written); the marker says "pulled while running".
  const save = JSON.parse(await readFile(join(`${mount}.pulled`, 'HUB', 'data', 'writer', 'state.json'), 'utf8'));
  assert.ok(save.n > 5);
  renameSync(`${mount}.pulled`, mount); // plug it back in
  await writeFile(join(mount, 'HUB', 'data', 'writer', 'state.json.part'), 'half'); // as if cut mid-write
  const check = await checkAfterPull(join(mount, 'HUB'));
  assert.ok(check.pulled?.pid, 'the next start sees the pull');
  assert.equal(check.partsRemoved, 1);
  assert.deepEqual((await readdir(join(mount, 'HUB', 'data', 'writer'))).sort(), ['state.json']);
});

test('pulling the stick while the hub is starting leaves nothing running', async () => {
  const starting = startStickHub({ root, home, mount, git, fsx: createFsx(), port: PORT });
  // Pull as soon as the hub process exists (it is loading its code from the stick).
  await new Promise((res) => setTimeout(res, 60));
  renameSync(mount, `${mount}.pulled`);
  const outcome = await starting.then(() => 'started', (e) => e.message);
  // Either it never came up, or it came up and saw the stick gone: in both cases it must be gone soon.
  assert.ok(await until(async () => !(await ping()), 4000), `hub still answering (start said: ${outcome})`);
  console.log(`# pulled while starting -> ${outcome.split('\n')[0]}`);
  renameSync(`${mount}.pulled`, mount);
  const r = await startStickHub({ root, home, mount, git, fsx: createFsx(), port: PORT });
  assert.equal((await ping()).body.mode, 'stick', 'starts fine after re-plugging');
  const token = JSON.parse(await readFile(join(home, 'token.json'), 'utf8')).token;
  await callHub('/api/hub/stop', { method: 'POST', token, port: PORT });
  assert.ok(await until(async () => !(await ping()), 8000));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await checkAfterPull(join(mount, 'HUB'))).pulled, null, 'a clean stop removes the marker');
  void r;
});
