// The Notebook's note operations (lib/vault.mjs) in both modes: plain files and the hub's vault (TEST ONLY keys).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Vault, MAX_FILES } from '../lib/vault.mjs';
import { Changes } from '../lib/changes.mjs';
import { nameProblem, caseClash, isConflict } from '../public/js/names.mjs';
import { MODES } from './modes.mjs';

const dones = [];
after(async () => { for (const d of dones) await d(); });

test('name rules: exFAT and Windows safe', () => {
  for (const ok of ['Idea.md', 'zażółć gęślą.md', 'a b', '.hidden', 'x'.repeat(120), 'Plan (v2).txt']) assert.equal(nameProblem(ok), null, ok);
  const bad = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b', 'end.', 'end ', ' start',
    'CON', 'con.md', 'Nul', 'COM1.txt', 'LPT9', 'x'.repeat(121), 'x.part', 'y.tmp', '.deleted'];
  for (const b of bad) assert.notEqual(nameProblem(b), null, JSON.stringify(b));
  assert.equal(caseClash(['Ideas.md'], 'ideas.MD'), true);
  assert.equal(caseClash(['Ideas.md'], 'ideas.md', 'Ideas.md'), false, 'a case-only rename of itself is fine');
  assert.ok(isConflict('save.conflict-20261104-120000.md'));
});

for (const [mode, make] of Object.entries(MODES)) {
  const fresh = async () => {
    const m = await make();
    dones.push(m.done);
    return { ...m, vault: new Vault(m.fs) };
  };

  test(`[${mode}] paths stay inside the vault; links are never followed`, async () => {
    const { vault, base, dir } = await fresh();
    await writeFile(join(base, 'outside.md'), 'secret');
    if (mode === 'files') { // the hub's vault has no links
      await mkdir(join(dir, 'vault'), { recursive: true });
      await symlink(base, join(dir, 'vault', 'link'));
      await symlink(join(base, 'outside.md'), join(dir, 'vault', 'out.md'));
    }
    for (const p of ['../outside.md', 'a/../../outside.md', '/etc/passwd', 'a\\..\\b', 'x\0y', '.deleted/x', 'link/outside.md', 'out.md']) {
      await assert.rejects(vault.read(p), (e) => e.status >= 400 && e.status < 500, p);
    }
    assert.deepEqual((await vault.list('')).map((e) => e.name), [], 'links are not listed');
    if (mode === 'files') await assert.rejects(vault.write('link/new.md', 'x'), /Links are not followed/);
    assert.equal(await readFile(join(base, 'outside.md'), 'utf8'), 'secret');
  });

  test(`[${mode}] atomic write leaves no .part and never rewrites unchanged content`, async () => {
    const { vault, fs, put, dir } = await fresh();
    await put({ 'vault/a.md': 'one' });
    const w1 = await vault.write('a.md', 'two', (await vault.read('a.md')).version);
    assert.equal(w1.written, true);
    assert.deepEqual(await fs.readdir('vault'), ['a.md']);
    if (mode === 'files') assert.deepEqual(await readdir(join(dir, 'vault')), ['a.md'], 'no .part left on the disk');
    const before = (await fs.stat('vault/a.md')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const w2 = await vault.write('a.md', 'two', w1.version);
    assert.equal(w2.written, false);
    assert.equal((await fs.stat('vault/a.md')).mtimeMs, before, 'file untouched');
    // Changed elsewhere (e.g. the sync): refused unless forced.
    await put({ 'vault/a.md': 'from the stick' });
    await assert.rejects(vault.write('a.md', 'mine', w1.version), (e) => e.status === 409 && !!e.version);
    assert.equal((await vault.write('a.md', 'mine', w1.version, true)).written, true);
    await assert.rejects(vault.write('big.md', 'x'.repeat(1024 * 1024 + 1)), (e) => e.status === 413);
    await assert.rejects(vault.write('script.js', 'x'), /Only .md and .txt/);
  });

  test(`[${mode}] tree: create, rename (also case only), move, duplicate`, async () => {
    const { vault, fs } = await fresh();
    await vault.create('', 'Projects', 'dir');
    await vault.create('Projects', 'Idea.md', 'file');
    await assert.rejects(vault.create('Projects', 'idea.MD', 'file'), /already exists/);
    await assert.rejects(vault.create('', 'bad:name.md', 'file'), /cannot contain :/);
    await assert.rejects(vault.create('Nope', 'x.md', 'file'), (e) => e.status === 404);
    assert.deepEqual(await vault.rename('Projects/Idea.md', 'idea.md'), { path: 'Projects/idea.md' });
    assert.deepEqual(await fs.readdir('vault/Projects'), ['idea.md']);
    await vault.create('', 'Archive', 'dir');
    const m = await vault.move(['Projects/idea.md', 'Projects'], 'Archive');
    assert.deepEqual(m.results, [{ from: 'Projects/idea.md', to: 'Archive/idea.md' }, { from: 'Projects', to: 'Archive/Projects' }]);
    const self = await vault.move(['Archive'], 'Archive/Projects');
    assert.match(self.results[0].error, /inside itself/);
    assert.deepEqual(await vault.duplicate('Archive/idea.md'), { path: 'Archive/idea copy.md' });
    assert.deepEqual(await vault.duplicate('Archive/idea.md'), { path: 'Archive/idea copy 2.md' });
    assert.deepEqual(await vault.duplicate('Archive'), { path: 'Archive copy' });
    const idx = await vault.index();
    assert.ok(idx.files.includes('Archive copy/idea copy.md'));
  });

  test(`[${mode}] delete goes to .deleted; restore puts it back (folders made again, clashes renamed); empty`, async () => {
    const { vault, fs } = await fresh();
    await vault.create('', 'A', 'dir');
    await vault.create('A', 'B', 'dir');
    await vault.write('A/B/note.md', 'hello');
    await vault.remove(['A/B/note.md']);
    assert.deepEqual(await vault.list('A/B'), []);
    assert.ok(!(await vault.index()).files.length, '.deleted is hidden');
    const { items } = await vault.listDeleted();
    assert.equal(items.length, 1);
    assert.equal(items[0].original, 'A/B/note.md');
    await vault.remove(['A']); // the parent folder goes too
    await vault.write('A2.md', 'x');
    const back = await vault.restore(items[0].id);
    assert.equal(back.path, 'A/B/note.md', 'folders made again');
    assert.equal(await fs.readFile('vault/A/B/note.md', 'utf8'), 'hello');
    const folder = (await vault.listDeleted()).items.find((i) => i.name === 'A');
    assert.equal((await vault.restore(folder.id)).path, 'A (restored)');
    assert.equal((await vault.listDeleted()).items.length, 0);
    await vault.remove(['A2.md']);
    assert.equal((await vault.emptyDeleted()).removed, 1);
    await assert.rejects(fs.stat('vault/.deleted'));
  });

  test(`[${mode}] the vault holds at most 5000 files`, async () => {
    const { vault, put } = await fresh();
    await put(Object.fromEntries(Array.from({ length: MAX_FILES }, (_, i) => [`vault/many/n${i}.md`, ''])));
    await assert.rejects(vault.create('', 'one-more.md', 'file'), /vault is full/);
    await assert.rejects(vault.write('new.md', 'x'), /vault is full/);
  });

  test(`[${mode}] list and index are one tree() call each; a long path is refused with a clear message`, async () => {
    const { vault, fs, put } = await fresh();
    await put({ 'vault/a.md': 'a', 'vault/f/b.md': 'b', 'vault/f/g/c.md': 'c' });
    const calls = [];
    const spy = new Vault({ ...fs, tree: (p, o) => { calls.push([p, o?.depth ?? null]); return fs.tree(p, o); },
      readdir: () => { throw new Error('readdir is not used for a listing'); } });
    assert.deepEqual((await spy.list('f')).map((e) => [e.name, e.type]), [['b.md', 'file'], ['g', 'dir']]);
    assert.deepEqual((await spy.index()).files, ['a.md', 'f/b.md', 'f/g/c.md']);
    assert.deepEqual(calls, [['vault/f', 1], ['vault', null]]);
    await assert.rejects(vault.write(`${'d'.repeat(100)}/${'n'.repeat(100)}.md`, 'x'), /path is too long \(max 194/);
    await vault.create('', 'd'.repeat(100), 'dir');
    await assert.rejects(vault.create('d'.repeat(100), `${'n'.repeat(100)}.md`, 'file'), /path is too long \(max 194/);
  });

  test(`[${mode}] changes: a write through the data shows up for the page; a cursor from another run is lost`, async () => {
    const { vault, fs } = await fresh();
    const ch = new Changes(fs, { retryMs: 50, log: () => {} });
    const running = ch.start();
    try {
      const { cursor } = ch.since();
      await new Promise((r) => setTimeout(r, 100)); // the watch is open
      const waiting = ch.wait(cursor, 5000);
      await vault.create('', 'n', 'dir');
      await vault.write('n/a.md', 'hello');
      const r = await waiting;
      assert.equal(r.lost, false);
      assert.ok(r.paths.includes('n') || r.paths.includes('n/a.md'), JSON.stringify(r.paths));
      await new Promise((res) => setTimeout(res, 100));
      const both = ch.since(cursor);
      assert.deepEqual(both.paths.sort(), ['n', 'n/a.md']);
      await vault.rename('n/a.md', 'b.md');
      await new Promise((res) => setTimeout(res, 100));
      assert.deepEqual(ch.since(both.cursor).paths.sort(), ['n/a.md', 'n/b.md']);
      assert.equal(ch.since('00000000:1').lost, true, 'another server run');
      assert.equal(ch.since('nonsense').lost, true);
    } finally {
      ch.stop();
      await running;
    }
  });
}

test('[hub] rename and move of a folder are index operations: no new pack, one commit', async () => {
  const m = await MODES.hub();
  dones.push(m.done);
  const vault = new Vault(m.fs);
  await m.put(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`vault/big/n${i}.md`, `note ${i}`])));
  await vault.create('', 'Archive', 'dir');
  const s0 = m.store.status();
  await vault.rename('big', 'Big folder');
  await vault.move(['Big folder'], 'Archive');
  const s1 = m.store.status();
  assert.deepEqual([s1.seq - s0.seq, s1.packs], [2, s0.packs]);
  assert.equal((await vault.read('Archive/Big folder/n7.md')).content, 'note 7');
});

test('[hub] errors never show the vault folder, the socket or the token', async () => {
  const m = await MODES.hub();
  dones.push(m.done);
  const vault = new Vault(m.fs);
  await vault.write('a.md', 'x');
  await m.api.close(); // the hub is gone
  const errs = [];
  for (const f of [() => vault.list(''), () => vault.read('a.md'), () => vault.write('a.md', 'y'), () => vault.index()]) {
    errs.push(await f().then(() => null, (e) => e));
  }
  for (const e of errs) {
    assert.equal(e?.status, 503, e?.message);
    for (const secret of [m.api.socketPath, m.token, m.base, 'data.sock']) assert.ok(!e.message.includes(secret), e.message);
  }
});
