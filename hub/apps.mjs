// Finds the apps: one folder per app in apps/, each with an app.json.
// A broken app is returned with an error (shown on its tile); it never stops the others.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest, ID_RE } from './manifest.mjs';

/**
 * @typedef {object} App
 * @property {string} id       folder name (= manifest id when valid)
 * @property {string} dir      absolute app folder
 * @property {object|null} manifest  validated manifest with defaults, null when broken
 * @property {string[]} errors  why the app cannot run (empty when fine)
 */

/**
 * Scan appsDir for apps.
 * @param {string} appsDir
 * @param {Map<string, object>} engines
 * @returns {Promise<App[]>} sorted by name
 */
export async function scanApps(appsDir, engines) {
  let entries;
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const apps = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    apps.push(await loadApp(join(appsDir, ent.name), ent.name, engines));
  }
  return apps.sort((a, b) => (a.manifest?.name || a.id).localeCompare(b.manifest?.name || b.id));
}

/**
 * Read and validate one app folder.
 * @returns {Promise<App>}
 */
export async function loadApp(dir, folder, engines) {
  const app = { id: folder, dir, manifest: null, errors: [] };
  if (!ID_RE.test(folder)) {
    app.errors.push('folder name: use a-z, 0-9 and "-" only');
    return app;
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir, 'app.json'), 'utf8'));
  } catch (e) {
    app.errors.push(e.code === 'ENOENT' ? 'app.json is missing' : `app.json: ${e.code || e.message}`);
    return app;
  }
  const v = validateManifest(raw, { folder, engines });
  if (!v.ok) app.errors.push(...v.errors);
  else app.manifest = v.manifest;
  return app;
}
