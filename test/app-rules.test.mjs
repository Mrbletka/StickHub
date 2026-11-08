// App rules, checked on every app in apps/:
// - never import or require anything from HUB_DATA_DIR (data is data, never code; it may be on the stick);
// - with the vault on, apps keep data through hubfs ("data": "hubfs" and lib/hubfs.mjs, a byte-equal copy of
//   hub/appkit/hubfs.mjs) or have none ("data": "none"); they never use HUB_DATA_DIR;
// - never browser storage for data: IndexedDB, Cache Storage, cookies and sessionStorage not at all, localStorage only
//   in the listed UI-state files (cleared on lock, design 8.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { dataUse } from '../hub/manifest.mjs';

const ROOT = join(import.meta.dirname, '..');

async function codeFiles(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'data' || ent.name.startsWith('.')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await codeFiles(p, out);
    else if (['.js', '.mjs', '.cjs'].includes(extname(ent.name))) out.push(p);
  }
  return out;
}

test('no app and no hub file imports code from HUB_DATA_DIR', async () => {
  const bad = [];
  for (const file of [...await codeFiles(join(ROOT, 'apps')), ...await codeFiles(join(ROOT, 'hub'))]) {
    const text = await readFile(file, 'utf8');
    // import(x) / require(x) / import ... from x, where x mentions the data dir (directly or via a DATA_DIR variable)
    const dynamic = /\b(import|require)\s*\(\s*[^)]*(HUB_DATA_DIR|DATA_DIR|dataDir)/g;
    if (dynamic.test(text)) bad.push(file.slice(ROOT.length + 1));
  }
  assert.deepEqual(bad, []);
});

test('the check itself catches the patterns it is meant to', () => {
  const dynamic = /\b(import|require)\s*\(\s*[^)]*(HUB_DATA_DIR|DATA_DIR|dataDir)/;
  for (const badCode of ["await import(join(process.env.HUB_DATA_DIR, 'plugin.mjs'))", 'require(DATA_DIR + "/x.js")', 'import(path.join(dataDir, f))']) {
    assert.ok(dynamic.test(badCode), badCode);
  }
  assert.ok(!dynamic.test("const DATA_DIR = process.env.HUB_DATA_DIR || join(import.meta.dirname, 'data');"));
});

const HUBFS = join(ROOT, 'hub', 'appkit', 'hubfs.mjs');
// Not ported to hubfs yet (they cannot start while the vault is on). Empty since job 3c: keep it that way.
const NOT_PORTED = new Set([]);
// The only files that may use localStorage, and what for (UI state, never data).
const UI_STATE_FILES = { 'notebook/public/js/store.mjs': 'open tabs, open folders, sort, recent notes' };

async function apps() {
  const out = [];
  for (const ent of await readdir(join(ROOT, 'apps'), { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(ROOT, 'apps', ent.name);
    out.push({ id: ent.name, dir, manifest: JSON.parse(await readFile(join(dir, 'app.json'), 'utf8')) });
  }
  return out;
}

/** App files a browser or the app server runs (no tests, no lib/hubfs.mjs). */
async function appCode(dir) {
  const files = [];
  const walk = async (d) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) { if (!['test', 'data', 'node_modules'].includes(ent.name)) await walk(p); } else if (['.js', '.mjs', '.cjs', '.html'].includes(extname(ent.name)) && p !== join(dir, 'lib', 'hubfs.mjs')) files.push(p);
    }
  };
  await walk(dir);
  return files;
}

test('every lib/hubfs.mjs in apps/ is a byte-equal copy of hub/appkit/hubfs.mjs', async () => {
  const src = await readFile(HUBFS);
  for (const a of await apps()) {
    const copy = await readFile(join(a.dir, 'lib', 'hubfs.mjs')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (copy) assert.ok(copy.equals(src), `apps/${a.id}/lib/hubfs.mjs differs: copy hub/appkit/hubfs.mjs again`);
  }
});

test('with the vault on, every app keeps its data through hubfs or has none, and never uses HUB_DATA_DIR', async () => {
  for (const a of await apps()) {
    const use = dataUse(a.manifest);
    if (NOT_PORTED.has(a.id)) { assert.equal(use, 'files', `${a.id} is ported: take it off NOT_PORTED`); continue; }
    assert.notEqual(use, 'files', `${a.id}: say "data": "hubfs" (and use lib/hubfs.mjs) or "data": "none"`);
    if (use === 'hubfs') assert.ok(await stat(join(a.dir, 'lib', 'hubfs.mjs')).catch(() => null), `${a.id}: lib/hubfs.mjs is missing`);
    for (const f of await appCode(a.dir)) {
      assert.doesNotMatch(await readFile(f, 'utf8'), /HUB_DATA_DIR/, `${f.slice(ROOT.length + 1)} uses HUB_DATA_DIR`);
    }
  }
});

test('no app keeps data in browser storage', async () => {
  for (const a of await apps()) {
    for (const f of await appCode(a.dir)) {
      const rel = f.slice(join(ROOT, 'apps').length + 1);
      const text = await readFile(f, 'utf8');
      assert.doesNotMatch(text, /indexedDB|IDBFactory|caches\.open|document\.cookie|sessionStorage/, `${rel}: no IndexedDB, Cache Storage, cookies or sessionStorage`);
      if (!(rel in UI_STATE_FILES)) assert.doesNotMatch(text, /localStorage/, `${rel}: localStorage only in a listed UI-state file`);
    }
  }
});
