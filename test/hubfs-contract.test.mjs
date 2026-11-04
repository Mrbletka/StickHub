// One contract for hubfs in both modes: the hub's data API (a real test Store behind a Unix socket) and plain
// files. TEST ONLY keys; temp folders only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

  test(`hubfs contract (${mode}): watch sees changes in order`, async () => {
    const { fs, done } = await make();
    try {
      const ac = new AbortController();
      const it = fs.watch({ signal: ac.signal })[Symbol.asyncIterator]();
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
