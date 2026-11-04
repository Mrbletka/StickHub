import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir, rename, symlink, stat } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { createFsx, exists } from '../hub/sync/fsx.mjs';
import { readStick, initStick } from '../hub/stick.mjs';
import { setup, makeRun, write, gitc } from './sync-helpers.mjs';

const read = (f) => readFile(f, 'utf8');

/** Every file under dir (relative), to check for leftovers. */
async function listAll(dir, pre = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = pre + e.name;
    if (e.isDirectory()) out.push(...await listAll(join(dir, e.name), `${rel}/`)); else out.push(rel);
  }
  return out.sort();
}

test('stick init never touches an existing HUB without --force', async () => {
  const fx = await setup();
  try {
    await write(join(fx.hubDir, 'mine.txt'), 'keep me');
    const before = await read(join(fx.hubDir, 'stick.json'));
    await assert.rejects(initStick(fx.mount), /already exists.*Nothing was changed/);
    assert.equal(await read(join(fx.hubDir, 'stick.json')), before);
    const info = await initStick(fx.mount, { force: true, name: 'New' });
    assert.notEqual(info.id, fx.info.id);
    assert.equal(await read(join(fx.hubDir, 'mine.txt')), 'keep me');
  } finally { await fx.cleanup(); }
});

test('first sync copies code and data; second sync copies nothing', async () => {
  const fx = await setup();
  try {
    const s1 = await (await makeRun(fx)).run();
    assert.equal(s1.result, 'ok', s1.errors.join());
    assert.equal(s1.code.state, 'update');
    assert.equal(await read(join(fx.hubDir, 'hub', 'server.mjs')), 'export const v = 1;\n');
    assert.equal(await exists(join(fx.hubDir, 'README.md')), false, 'only hub/ and apps/ go to the stick');
    assert.equal(await read(join(fx.hubDir, 'data', 'demo', 'save.json')), '{"level":1}');
    const st = await readStick(fx.mount);
    assert.equal(st.info.commit, gitc(fx.root, 'rev-parse', 'HEAD'));
    assert.equal(st.info.codeState, 'complete');
    const s2 = await (await makeRun(fx)).run();
    assert.equal(s2.copied, 0);
    assert.equal(s2.code.state, 'same');
    assert.deepEqual((await listAll(fx.hubDir)).filter((f) => /\.part$|journal|\.lock/.test(f)), []);
  } finally { await fx.cleanup(); }
});

test('changes flow both ways, deletions go to the trash, conflicts keep both', async () => {
  const fx = await setup();
  try {
    await (await makeRun(fx)).run();
    await write(join(fx.hubDir, 'data', 'demo', 'deep', 'more.txt'), 'changed on PC');
    await rm(join(fx.root, 'data', 'demo', 'save.json'));
    await write(join(fx.root, 'data', 'demo', 'new.json'), 'n');
    const s = await (await makeRun(fx)).run();
    assert.equal(s.result, 'ok', s.errors.join());
    assert.equal(await read(join(fx.root, 'data', 'demo', 'deep', 'more.txt')), 'changed on PC');
    assert.equal(await exists(join(fx.hubDir, 'data', 'demo', 'save.json')), false);
    const trash = await listAll(join(fx.hubDir, '.trash'));
    assert.ok(trash.some((f) => f.endsWith('data/demo/save.json')), trash.join());
    assert.equal(await read(join(fx.hubDir, 'data', 'demo', 'new.json')), 'n');

    await write(join(fx.root, 'data', 'demo', 'new.json'), 'phone version');
    await write(join(fx.hubDir, 'data', 'demo', 'new.json'), 'stick version');
    const c = await (await makeRun(fx, { now: () => new Date(2026, 10, 4, 9, 30, 0) })).run();
    assert.deepEqual(c.newConflicts, ['demo/new.conflict-20261104-093000.json']);
    for (const side of [join(fx.root, 'data'), join(fx.hubDir, 'data')]) {
      assert.equal(await read(join(side, 'demo', 'new.json')), 'phone version');
      assert.equal(await read(join(side, 'demo', 'new.conflict-20261104-093000.json')), 'stick version');
    }
    assert.deepEqual(c.conflicts, ['demo/new.conflict-20261104-093000.json']);
    assert.equal((await (await makeRun(fx)).run()).copied, 0, 'stable after the conflict');
  } finally { await fx.cleanup(); }
});

test('a running app is pending and syncs after it stops', async () => {
  const fx = await setup();
  try {
    const running = new Set(['demo']);
    const s = await (await makeRun(fx, { running: () => running })).run();
    assert.deepEqual(s.pending, ['demo']);
    assert.equal(await exists(join(fx.hubDir, 'data', 'demo', 'save.json')), false);
    running.clear();
    const s2 = await (await makeRun(fx, { running: () => running })).run();
    assert.deepEqual(s2.pending, []);
    assert.equal(await read(join(fx.hubDir, 'data', 'demo', 'save.json')), '{"level":1}');
  } finally { await fx.cleanup(); }
});

test('code: dirty clone not copied, newer commit updates, unknown stick commit not overwritten', async () => {
  const fx = await setup();
  try {
    await (await makeRun(fx)).run();
    await write(join(fx.root, 'hub', 'server.mjs'), 'export const v = 2;\n');
    let s = await (await makeRun(fx, { what: { code: true } })).run();
    assert.equal(s.code.state, 'dirty');
    assert.equal(await read(join(fx.hubDir, 'hub', 'server.mjs')), 'export const v = 1;\n');
    gitc(fx.root, 'rm', '-q', 'hub/ui/app.js');
    gitc(fx.root, 'commit', '-qam', 'two');
    s = await (await makeRun(fx, { what: { code: true } })).run();
    assert.equal(s.code.state, 'update');
    assert.equal(await read(join(fx.hubDir, 'hub', 'server.mjs')), 'export const v = 2;\n');
    assert.equal(await exists(join(fx.hubDir, 'hub', 'ui', 'app.js')), false, 'removed file went to the trash');
    // A commit the phone does not know (made elsewhere): never overwritten.
    const j = JSON.parse(await read(join(fx.hubDir, 'stick.json')));
    await writeFile(join(fx.hubDir, 'stick.json'), JSON.stringify({ ...j, commit: 'f'.repeat(40) }));
    s = await (await makeRun(fx, { what: { code: true } })).run();
    assert.equal(s.code.state, 'different');
    assert.equal(s.copied, 0);
  } finally { await fx.cleanup(); }
});

test('untrusted stick content is skipped, never copied', async () => {
  const fx = await setup();
  try {
    await write(join(fx.hubDir, 'data', 'demo', 'a:b.json'), 'bad name');
    await write(join(fx.hubDir, 'data', 'Bad_App', 'x.json'), 'bad app id');
    await write(join(fx.hubDir, 'data', 'loose.json'), 'no app folder');
    await symlink('/etc/passwd', join(fx.hubDir, 'data', 'demo', 'link.json'));
    await write(join(fx.hubDir, '.index.json'), JSON.stringify({ files: { '../../evil.mjs': { size: 1, hash: 'a'.repeat(64) } } }));
    const s = await (await makeRun(fx)).run();
    assert.equal(s.result, 'ok', s.errors.join());
    const phone = await listAll(join(fx.root, 'data'));
    assert.deepEqual(phone, ['demo/deep/more.txt', 'demo/save.json']);
    const why = s.skipped.map((x) => `${x.rel}: ${x.why}`).join('\n');
    for (const bit of ['a:b.json', 'Bad_App/x.json', 'loose.json', 'link.json']) assert.match(why, new RegExp(bit.replace('.', '\\.')));
    await writeFile(join(fx.hubDir, 'stick.json'), JSON.stringify({ id: '../x', name: 'n', created: 'x' }));
    assert.equal((await readStick(fx.mount)).state, 'bad');
  } finally { await fx.cleanup(); }
});

for (const cut of [2, 9, 25, 40]) test(`pulling the stick at write step ${cut} is safe and the next run finishes the work`, async () => {
  const fx = await setup();
  try {
    for (let i = 0; i < 12; i++) await write(join(fx.root, 'data', 'demo', `f${i}.json`), `file ${i}`);
    let writes = 0;
    const gone = join(fx.base, 'stick-pulled');
    // After `cut` write steps on the stick, the stick "disappears" (folder moved away) and the write fails with EIO.
    const fsx = createFsx({ guard: (op, path) => {
      if (!path.startsWith(fx.mount)) return;
      if (++writes === cut) { renameSync(fx.mount, gone); throw Object.assign(new Error('I/O error'), { code: 'EIO' }); }
    } });
    const s1 = await (await makeRun(fx, { fsx })).run();
    assert.equal(s1.result, 'interrupted', JSON.stringify(s1));
    await rename(gone, fx.mount); // plug it back in
    // Pulled before the journal was written: nothing to resume, the next run simply starts over.
    const journal = await exists(join(fx.hubDir, '.journal.json'));
    if (cut > 5) assert.equal(journal, true, 'journal left behind');
    const s2 = await (await makeRun(fx)).run();
    assert.equal(s2.result, 'ok', s2.errors.join());
    assert.equal(s2.resumed, journal);
    for (let i = 0; i < 12; i++) assert.equal(await read(join(fx.hubDir, 'data', 'demo', `f${i}.json`)), `file ${i}`);
    assert.equal((await readStick(fx.mount)).info.codeState, 'complete');
    assert.deepEqual((await listAll(fx.hubDir)).filter((f) => /\.part$|journal|\.lock/.test(f)), []);
    assert.equal((await (await makeRun(fx)).run()).copied, 0);
  } finally { await fx.cleanup(); }
});

test('cancel stops cleanly and a new run resumes', async () => {
  const fx = await setup();
  try {
    for (let i = 0; i < 8; i++) await write(join(fx.root, 'data', 'demo', `f${i}.json`), `file ${i}`);
    const run = await makeRun(fx);
    run.on('progress', (p) => { if (p.phase === 'data' && p.done === 3) run.cancel(); });
    const s1 = await run.run();
    assert.equal(s1.result, 'cancelled');
    assert.ok(s1.copied > 0 && s1.copied < 10);
    assert.equal(await exists(join(fx.hubDir, '.lock')), false, 'lock released');
    const s2 = await (await makeRun(fx)).run();
    assert.equal(s2.result, 'ok');
    for (let i = 0; i < 8; i++) assert.equal(await read(join(fx.hubDir, 'data', 'demo', `f${i}.json`)), `file ${i}`);
  } finally { await fx.cleanup(); }
});

test('the lock: another device blocks, a stale lock is taken over', async () => {
  const fx = await setup();
  try {
    await writeFile(join(fx.hubDir, '.lock'), JSON.stringify({ device: 'dev-other0000000', time: new Date().toISOString() }));
    assert.equal((await (await makeRun(fx)).run()).result, 'locked');
    assert.match(await read(join(fx.hubDir, '.lock')), /dev-other/, 'foreign lock untouched');
    await writeFile(join(fx.hubDir, '.lock'), JSON.stringify({ device: 'dev-other0000000', time: new Date(Date.now() - 3600_000).toISOString() }));
    assert.equal((await (await makeRun(fx)).run()).result, 'ok');
  } finally { await fx.cleanup(); }
});

test('dry run changes nothing', async () => {
  const fx = await setup();
  try {
    const before = await listAll(fx.hubDir);
    const s = await (await makeRun(fx)).run({ dry: true });
    assert.ok(s.plan.data.length > 0 && s.plan.code.length > 0);
    assert.deepEqual(await listAll(fx.hubDir), before);
    assert.equal(await exists(join(fx.root, 'sync-state.json')), false);
    void stat;
  } finally { await fx.cleanup(); }
});
