// One contract for hubfs in both modes: the hub's data API (a real test Store behind a Unix socket) and plain
// files. TEST ONLY keys; temp folders only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDataApi } from '../hub/dataapi/server.mjs';
import { createHubFs } from '../hub/appkit/hubfs.mjs';
import { makeTestStore } from './vault-helpers.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hubfs-')); roots.push(d); return d; };

const modes = {
  async hub() {
    const t = await makeTestStore({ autoCleanupEvery: 0 });
    roots.push(t.root);
    const api = await createDataApi({ socketPath: join(tmp(), 'run', 'd.sock'), getStore: () => t.store });
    const fs = createHubFs({ socket: api.socketPath, token: api.issue('notebook') });
    return { fs, done: async () => { await api.close(); await t.store.close(); } };
  },
  async files() { return { fs: createHubFs({ dir: join(tmp(), 'data'), socket: '', token: '' }), done: async () => {} }; },
};

for (const [mode, make] of Object.entries(modes)) {
  test(`hubfs contract (${mode}): files, folders, errors`, async () => {
    const { fs, done } = await make();
    try {
      assert.equal(fs.mode, mode === 'hub' ? 'hub' : 'files');
      assert.deepEqual(await fs.readdir(''), []);
      const w = await fs.writeFile('notes/a.md', 'hello');
      assert.equal(typeof w.id, 'string');
      assert.equal(await fs.readFile('notes/a.md', 'utf8'), 'hello');
      assert.deepEqual(await fs.readFile('notes/a.md'), Buffer.from('hello'));
      const st = await fs.stat('notes/a.md');
      assert.deepEqual([st.isFile(), st.isDirectory(), st.size, st.id], [true, false, 5, w.id]);
      assert.equal((await fs.stat('notes')).isDirectory(), true);
      // ifMatch
      await assert.rejects(fs.writeFile('notes/a.md', 'x', { ifMatch: 'none' }), { code: 'ECONFLICT' });
      await assert.rejects(fs.writeFile('notes/a.md', 'x', { ifMatch: 'A'.repeat(43) }), { code: 'ECONFLICT' });
      const w2 = await fs.writeFile('notes/a.md', 'hello 2', { ifMatch: w.id });
      await fs.writeFile('notes/new.md', Buffer.from([1, 2, 3]), { ifMatch: 'none' });
      assert.notEqual(w2.id, w.id);
      // folders
      await fs.mkdir('x/y/z', { recursive: true });
      await assert.rejects(fs.mkdir('x/y'), { code: 'EEXIST' });
      await assert.rejects(fs.mkdir('nope/deeper'), { code: 'ENOENT' });
      await fs.mkdir('x/w');
      assert.deepEqual((await fs.readdir('x')).sort(), ['w', 'y']);
      const ents = await fs.readdir('notes', { withFileTypes: true });
      assert.deepEqual(ents.map((e) => [e.name, e.isFile()]).sort(), [['a.md', true], ['new.md', true]]);
      assert.deepEqual((await fs.tree('x')).map((e) => e.path), ['x/w', 'x/y', 'x/y/z']);
      // rename: files and folders; onto an existing name is refused (unlike node:fs)
      await fs.rename('notes/new.md', 'x/moved.bin');
      assert.deepEqual(await fs.readFile('x/moved.bin'), Buffer.from([1, 2, 3]));
      await assert.rejects(fs.rename('x/moved.bin', 'notes/a.md'), { code: 'EEXIST' });
      await fs.rename('x', 'x2');
      assert.equal((await fs.stat('x2/y/z')).isDirectory(), true);
      // rm
      await assert.rejects(fs.rm('x2'), { code: 'ENOTEMPTY' });
      await fs.rm('x2', { recursive: true });
      await assert.rejects(fs.stat('x2'), { code: 'ENOENT' });
      await fs.rm('gone', { force: true });
      await assert.rejects(fs.rm('gone'), { code: 'ENOENT' });
      // errors
      await assert.rejects(fs.readFile('missing.md'), (e) => e.code === 'ENOENT' && e.hubCode === 'NOT_FOUND');
      await assert.rejects(fs.readFile('notes'), { code: 'EISDIR' });
      await assert.rejects(fs.readdir('notes/a.md'), { code: 'ENOTDIR' });
      await assert.rejects(fs.writeFile('notes', 'x'), { code: 'EISDIR' });
      for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', 'a\u0000b', 'a/./b', '.', 'x'.repeat(300)]) {
        await assert.rejects(fs.readFile(bad), { code: 'EINVAL' }, JSON.stringify(bad));
      }
    } finally {
      await done();
    }
  });

  test(`hubfs contract (${mode}): readdir is one folder, tree takes a depth`, async () => {
    const { fs, done } = await make();
    try {
      for (const p of ['a.md', 'f/b.md', 'f/g/c.md', 'f/g/h/d.md']) await fs.writeFile(p, p);
      await fs.mkdir('empty');
      assert.deepEqual(await fs.readdir(''), ['a.md', 'empty', 'f']);
      assert.deepEqual(await fs.readdir('.'), ['a.md', 'empty', 'f']);
      assert.deepEqual((await fs.readdir('f', { withFileTypes: true })).map((e) => [e.name, e.isDirectory()]), [['b.md', false], ['g', true]]);
      assert.deepEqual(await fs.readdir('empty'), []);
      await assert.rejects(fs.readdir('nope'), { code: 'ENOENT' });
      await assert.rejects(fs.readdir('a.md'), { code: 'ENOTDIR' });
      assert.deepEqual((await fs.tree('f', { depth: 1 })).map((e) => e.path), ['f/b.md', 'f/g']);
      assert.deepEqual((await fs.tree('f', { depth: 2 })).map((e) => e.path), ['f/b.md', 'f/g', 'f/g/c.md', 'f/g/h']);
      assert.deepEqual((await fs.tree('', { depth: 1 })).map((e) => e.path), ['a.md', 'empty', 'f']);
      assert.equal((await fs.tree('')).length, 8);
      await assert.rejects(fs.tree('f', { depth: 0 }), { code: 'EINVAL' });
      const file = (await fs.tree('f')).find((e) => e.path === 'f/b.md');
      assert.deepEqual([file.kind, file.size], ['f', 6]);
      // the content id: always from stat(); tree() has it only in the hub (plain files would have to read every file)
      assert.equal(file.id, mode === 'hub' ? (await fs.stat('f/b.md')).id : undefined);
      await assert.rejects(fs.rm('f'), { code: 'ENOTEMPTY' });
    } finally {
      await done();
    }
  });

  test(`hubfs contract (${mode}): watch sees changes in order`, async () => {
    const { fs, done } = await make();
    try {
      const ac = new AbortController();
      const it = fs.watch({ signal: ac.signal, since: 0 })[Symbol.asyncIterator](); // since 0: a fresh vault
      const first = it.next(); // starts the watch
      await new Promise((r) => setTimeout(r, 50));
      await fs.writeFile('a.md', 'a');
      await fs.mkdir('d', { recursive: true });
      await fs.rename('a.md', 'd/a.md');
      const got = [(await first).value, (await it.next()).value, (await it.next()).value];
      assert.deepEqual(got.map((e) => [e.kind, e.path]), [['write', 'a.md'], ['mkdir', 'd'], ['move', 'd/a.md']]);
      assert.ok(got[0].seq < got[1].seq && got[1].seq < got[2].seq);
      ac.abort();
    } finally {
      await done();
    }
  });
}

test('plain-file mode: readdir and tree never read a file', async () => {
  const fs = createHubFs({ dir: join(tmp(), 'data'), socket: '', token: '' });
  for (let i = 0; i < 30; i++) await fs.writeFile(`notes/n${i}.md`, 'x'.repeat(1000));
  const orig = { readFile: fsp.readFile, open: fsp.open };
  let reads = 0;
  fsp.readFile = (...a) => { reads++; return orig.readFile(...a); };
  fsp.open = (...a) => { reads++; return orig.open(...a); };
  try {
    assert.equal((await fs.readdir('notes')).length, 30);
    assert.equal((await fs.readdir('', { withFileTypes: true })).length, 1);
    assert.equal((await fs.tree('')).length, 31);
    assert.equal(reads, 0);
    await fs.stat('notes/n1.md');
    assert.equal(reads, 1, 'stat reads the file for its id');
  } finally {
    Object.assign(fsp, orig);
  }
});

test('plain-file mode: links are never followed, listed or written through', async () => {
  const { symlink, writeFile: put, mkdir: md } = fsp;
  const base = tmp();
  const dir = join(base, 'data');
  await md(join(base, 'outside'), { recursive: true });
  await put(join(base, 'outside', 'secret.md'), 'secret');
  await md(dir);
  await symlink(join(base, 'outside'), join(dir, 'linkdir'));
  await symlink(join(base, 'outside', 'secret.md'), join(dir, 'link.md'));
  const fs = createHubFs({ dir, socket: '', token: '' });
  for (const p of ['linkdir/secret.md', 'link.md']) {
    await assert.rejects(fs.readFile(p), (e) => e.code === 'EINVAL' || e.code === 'ENOENT', p);
    await assert.rejects(fs.stat(p), (e) => e.code === 'EINVAL' || e.code === 'ENOENT', p);
  }
  await assert.rejects(fs.writeFile('linkdir/new.md', 'x'), { code: 'EINVAL' });
  await assert.rejects(fs.mkdir('linkdir/sub', { recursive: true }), { code: 'EINVAL' });
  await assert.rejects(fs.readdir('linkdir'), { code: 'EINVAL' });
  await fs.writeFile('real.md', 'mine');
  await assert.rejects(fs.rename('real.md', 'linkdir/real.md'), { code: 'EINVAL' });
  assert.deepEqual(await fs.readdir(''), ['real.md'], 'links are not listed');
  assert.deepEqual((await fs.tree('')).map((e) => e.path), ['real.md']);
  assert.deepEqual((await fsp.readdir(join(base, 'outside'))).sort(), ['secret.md'], 'nothing written outside');
});
