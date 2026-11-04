import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, MAX_FILES } from '../lib/vault.mjs';
import { atomicWrite } from '../lib/atomic.mjs';
import { nameProblem, caseClash, isConflict } from '../public/js/names.mjs';

async function fresh() {
  const base = await mkdtemp(join(tmpdir(), 'notebook-'));
  await writeFile(join(base, 'outside.md'), 'secret');
  return { base, vault: await Vault.open(join(base, 'vault')) };
}

test('name rules: exFAT and Windows safe', () => {
  for (const ok of ['Idea.md', 'zażółć gęślą.md', 'a b', '.hidden', 'x'.repeat(200), 'Plan (v2).txt']) assert.equal(nameProblem(ok), null, ok);
  const bad = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b', 'end.', 'end ', ' start',
    'CON', 'con.md', 'Nul', 'COM1.txt', 'LPT9', 'x'.repeat(201), 'x.part', 'y.tmp', '.deleted'];
  for (const b of bad) assert.notEqual(nameProblem(b), null, JSON.stringify(b));
  assert.equal(caseClash(['Ideas.md'], 'ideas.MD'), true);
  assert.equal(caseClash(['Ideas.md'], 'ideas.md', 'Ideas.md'), false, 'a case-only rename of itself is fine');
  assert.ok(isConflict('save.conflict-20261104-120000.md'));
});

test('paths stay inside the vault; links are never followed', async () => {
  const { base, vault } = await fresh();
  await symlink(base, join(vault.root, 'link'));
  await symlink(join(base, 'outside.md'), join(vault.root, 'out.md'));
  for (const p of ['../outside.md', 'a/../../outside.md', '/etc/passwd', 'a\\..\\b', 'x\0y', '.deleted/x', 'link/outside.md', 'out.md']) {
    await assert.rejects(vault.read(p), (e) => e.status >= 400 && e.status < 500, p);
  }
  assert.deepEqual((await vault.list('')).map((e) => e.name), [], 'links are not listed');
  await assert.rejects(vault.write('link/new.md', 'x'), /Links are not followed/);
  assert.equal(await readFile(join(base, 'outside.md'), 'utf8'), 'secret');
});

test('atomic write leaves no .part and never rewrites unchanged content', async () => {
  const { vault } = await fresh();
  await atomicWrite(join(vault.root, 'a.md'), 'one');
  assert.deepEqual(await readdir(vault.root), ['a.md']);
  const w1 = await vault.write('a.md', 'two', (await vault.read('a.md')).version);
  assert.equal(w1.written, true);
  const before = (await stat(join(vault.root, 'a.md'))).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const w2 = await vault.write('a.md', 'two', w1.version);
  assert.equal(w2.written, false);
  assert.equal((await stat(join(vault.root, 'a.md'))).mtimeMs, before, 'file untouched');
  // Changed elsewhere (e.g. the sync): refused unless forced.
  await writeFile(join(vault.root, 'a.md'), 'from the stick');
  await assert.rejects(vault.write('a.md', 'mine', w1.version), (e) => e.status === 409 && !!e.version);
  assert.equal((await vault.write('a.md', 'mine', w1.version, true)).written, true);
  await assert.rejects(vault.write('big.md', 'x'.repeat(1024 * 1024 + 1)), (e) => e.status === 413);
  await assert.rejects(vault.write('script.js', 'x'), /Only .md and .txt/);
});

test('tree: create, rename (also case only), move, duplicate', async () => {
  const { vault } = await fresh();
  await vault.create('', 'Projects', 'dir');
  await vault.create('Projects', 'Idea.md', 'file');
  await assert.rejects(vault.create('Projects', 'idea.MD', 'file'), /already exists/);
  await assert.rejects(vault.create('', 'bad:name.md', 'file'), /cannot contain :/);
  await assert.rejects(vault.create('Nope', 'x.md', 'file'), (e) => e.status === 404);
  assert.deepEqual(await vault.rename('Projects/Idea.md', 'idea.md'), { path: 'Projects/idea.md' });
  assert.deepEqual(await readdir(join(vault.root, 'Projects')), ['idea.md']);
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

test('delete goes to .deleted; restore puts it back (folders made again, clashes renamed); empty', async () => {
  const { vault } = await fresh();
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
  assert.equal(await readFile(join(vault.root, 'A/B/note.md'), 'utf8'), 'hello');
  const folder = (await vault.listDeleted()).items.find((i) => i.name === 'A');
  assert.equal((await vault.restore(folder.id)).path, 'A (restored)');
  assert.equal((await vault.listDeleted()).items.length, 0);
  await vault.remove(['A2.md']);
  assert.equal((await vault.emptyDeleted()).removed, 1);
  await assert.rejects(stat(join(vault.root, '.deleted')));
});

test('the vault holds at most 5000 files', async () => {
  const { vault } = await fresh();
  await mkdir(join(vault.root, 'many'));
  for (let i = 0; i < MAX_FILES; i++) await writeFile(join(vault.root, 'many', `n${i}.md`), '');
  await assert.rejects(vault.create('', 'one-more.md', 'file'), /vault is full/);
  await assert.rejects(vault.write('new.md', 'x'), /vault is full/);
});
