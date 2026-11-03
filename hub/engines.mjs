// Loads every engine in hub/engines/. Adding an engine = adding one file there.
// Contract: export default { id, validate(manifest) -> string[] errors, async start(ctx) -> { port, url, stop() } }

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'engines');

/**
 * @param {string} [dir]  engines folder (tests pass their own)
 * @returns {Promise<{engines: Map<string, object>, errors: string[]}>} a broken engine file is reported, not fatal
 */
export async function loadEngines(dir = DIR) {
  const engines = new Map();
  const errors = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.mjs')).sort()) {
    try {
      const mod = (await import(pathToFileURL(join(dir, name)).href)).default;
      if (!mod || typeof mod.id !== 'string' || typeof mod.start !== 'function') throw new Error('needs a default export with id and start()');
      if (`${mod.id}.mjs` !== name) throw new Error(`id "${mod.id}" must match the file name`);
      engines.set(mod.id, mod);
    } catch (e) {
      errors.push(`engine ${name}: ${e.message}`);
    }
  }
  return { engines, errors };
}
