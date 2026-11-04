// App rule: never import or require anything from HUB_DATA_DIR (data is data, never code; it may be on the stick).
// Checks every app in apps/ and the hub itself for an import(), require() or import ... from that mentions the data dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

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
