// App rules, checked on every app in the repo (apps/ folders git tracks) and on new apps from `hub new`:
// - never import or require anything from HUB_DATA_DIR (data is data, never code; it may be on the stick);
// - with the vault on, apps keep data through hubfs ("data": "hubfs" and lib/hubfs.mjs, a byte-equal copy of
//   hub/appkit/hubfs.mjs) or have none ("data": "none"); they never use HUB_DATA_DIR;
// - never browser storage for data: IndexedDB, Cache Storage, cookies and sessionStorage not at all, localStorage only
//   in the listed UI-state files (cleared on lock, design 8.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, extname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dataUse } from '../hub/manifest.mjs';
import { createApp } from '../hub/scaffold.mjs';

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
// The only files that may use localStorage, and what for (UI state, never data). Paths relative to apps/.
const UI_STATE_FILES = { 'notebook/public/js/store.mjs': 'open tabs, open folders, sort, recent notes' };
// Use of browser storage in code (not the words in a comment such as "no saves in localStorage").
const STORAGE_USE = /\bindexedDB\s*\.|\bIDBFactory\b|\bcaches\s*\.\s*open\b|\bdocument\s*\.\s*cookie\b|\bsessionStorage\s*[.[]/;
const LOCAL_STORAGE_USE = /\blocalStorage\s*[.[]/;

/**
 * The apps in the repo: the folders whose app.json git tracks. A local app that is not committed (an experiment on
 * the phone) is not checked here; the hub still shows its problems on its tile. No git (a copy without .git): every
 * folder.
 */
async function repoApps() {
  let tracked = null;
  try {
    tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', 'apps'], { cwd: ROOT, timeout: 10_000, encoding: 'utf8' })
      .split('\0').map((p) => /^apps\/([^/]+)\/app\.json$/.exec(p)?.[1]).filter(Boolean));
  } catch { tracked = null; }
  const out = [];
  for (const ent of await readdir(join(ROOT, 'apps'), { withFileTypes: true })) {
    if (ent.isDirectory() && (!tracked || tracked.has(ent.name))) out.push(join(ROOT, 'apps', ent.name));
  }
  return out;
}

/** App files a browser or the app server runs (no tests, no data, no lib/hubfs.mjs). */
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

/**
 * Every vault-mode app rule for one app folder. @returns {Promise<string[]>} problems (empty = fine)
 */
async function appProblems(dir) {
  const id = basename(dir);
  const problems = [];
  const manifest = JSON.parse(await readFile(join(dir, 'app.json'), 'utf8'));
  const copy = await readFile(join(dir, 'lib', 'hubfs.mjs')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (copy && !copy.equals(await readFile(HUBFS))) problems.push(`${id}/lib/hubfs.mjs differs: copy hub/appkit/hubfs.mjs again`);
  const use = dataUse(manifest);
  if (NOT_PORTED.has(id)) { if (use !== 'files') problems.push(`${id} is ported: take it off NOT_PORTED`); return problems; }
  if (use === 'files') problems.push(`${id}: say "data": "hubfs" (and use lib/hubfs.mjs) or "data": "none"`);
  if (use === 'hubfs' && !copy) problems.push(`${id}: lib/hubfs.mjs is missing`);
  for (const f of await appCode(dir)) {
    const rel = `${id}/${f.slice(dir.length + 1).split(sep).join('/')}`;
    const text = await readFile(f, 'utf8');
    if (/HUB_DATA_DIR/.test(text)) problems.push(`${rel} uses HUB_DATA_DIR`);
    if (STORAGE_USE.test(text)) problems.push(`${rel}: no IndexedDB, Cache Storage, cookies or sessionStorage`);
    if (LOCAL_STORAGE_USE.test(text) && !(rel in UI_STATE_FILES)) problems.push(`${rel}: localStorage only in a listed UI-state file`);
  }
  return problems;
}

test('every app in the repo follows the vault rules: hubfs (byte-equal copy) or no data, no HUB_DATA_DIR, no browser storage for data', async () => {
  const dirs = await repoApps();
  assert.ok(dirs.length >= 3, 'the sample apps and the Notebook are checked');
  for (const dir of dirs) assert.deepEqual(await appProblems(dir), [], basename(dir));
});

test('a new app from `hub new` (both starters) follows the same rules', async () => {
  const appsDir = join(await mkdtemp(join(tmpdir(), 'stickhub-rules-')), 'apps');
  try {
    for (const engine of ['node-server', 'static']) {
      const { dir } = await createApp(appsDir, { id: `fresh-${engine}`, engine });
      assert.deepEqual(await appProblems(dir), [], engine);
    }
  } finally {
    await rm(join(appsDir, '..'), { recursive: true, force: true });
  }
});

test('the rules catch what they are meant to, and not words in a comment', async () => {
  for (const bad of ['indexedDB.open("x")', 'window.indexedDB .open(n)', 'caches.open("v1")', 'document.cookie = "a=1"', "sessionStorage['k'] = 1"]) {
    assert.ok(STORAGE_USE.test(bad), bad);
  }
  for (const bad of ['localStorage.setItem("k", v)', "window.localStorage['k']", 'localStorage .getItem(k)']) assert.ok(LOCAL_STORAGE_USE.test(bad), bad);
  const comment = '// Do not keep saves in localStorage or IndexedDB: browser storage is not synced (no sessionStorage, no cookies).';
  assert.ok(!STORAGE_USE.test(comment) && !LOCAL_STORAGE_USE.test(comment), 'a warning in a comment is fine');
  // an old-style app (plain files, browser storage) is caught in full
  const dir = join(await mkdtemp(join(tmpdir(), 'stickhub-rules-')), 'old-app');
  try {
    await mkdir(join(dir, 'public'), { recursive: true });
    await writeFile(join(dir, 'app.json'), JSON.stringify({ id: 'old-app', name: 'Old', engine: 'node-server', entry: 'server.mjs' }));
    await writeFile(join(dir, 'server.mjs'), 'const d = process.env.HUB_DATA_DIR;\n');
    await writeFile(join(dir, 'public', 'index.html'), '<script>localStorage.setItem("save", "1")</script>');
    assert.deepEqual(await appProblems(dir), ['old-app: say "data": "hubfs" (and use lib/hubfs.mjs) or "data": "none"',
      'old-app/public/index.html: localStorage only in a listed UI-state file', 'old-app/server.mjs uses HUB_DATA_DIR']);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});
