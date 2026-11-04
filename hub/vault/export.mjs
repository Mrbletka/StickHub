// `vault export`: decrypt every live file of a vault into plain files in a folder. The plain files are NOT encrypted.
// - checkExportDest (before any passphrase is asked): the folder must be missing or empty, and not inside the vault
//   folder, not inside this clone, not on a stick (a mounted volume).
// - exportVault: folders first, then each file as <name>.part, renamed only after its content id matched; every path is
//   checked again and must stay inside the destination. If a pack is missing because the running hub cleaned up since
//   the store opened, the store is reopened once with the same data key and the file is read again; a second miss is
//   damage. Messages never contain a name from the vault.

import { open, rename, unlink, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import { VaultError, fail } from './errors.mjs';
import { checkPath } from './store-ops.mjs';

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Real path of p, or of its nearest existing parent plus the rest (p itself may not exist yet). */
async function realish(p) {
  const abs = resolve(p);
  const rest = [];
  for (let cur = abs; ; cur = dirname(cur)) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' || dirname(cur) === cur) throw e;
      rest.push(cur.slice(dirname(cur).length).replace(/^[/\\]/, ''));
    }
  }
}

/**
 * Throw EXPORT_DEST with a plain reason unless dest is a safe place for plain files.
 * @param {string} dest
 * @param {{vaultDir: string, root: string, mounts: string[]}} o  root: this clone; mounts: mounted volumes (sticks)
 * @returns {Promise<string>} the destination as an absolute path
 */
export async function checkExportDest(dest, o) {
  const d = await realish(dest);
  if (inside(d, await realish(o.vaultDir))) fail('EXPORT_DEST', 'The export folder cannot be inside the vault folder.');
  if (inside(d, await realish(o.root))) fail('EXPORT_DEST', 'The export folder cannot be inside the StickHub folder (it could end up in git).');
  for (const m of o.mounts) {
    if (inside(d, await realish(m))) fail('EXPORT_DEST', 'The export folder cannot be on a stick: plain files must not travel.');
  }
  let st = null;
  try { st = await stat(d); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isDirectory()) fail('EXPORT_DEST', 'The export folder is a file.');
  if (st && (await readdir(d)).length) fail('EXPORT_DEST', 'The export folder must be empty or not exist yet.');
  return d;
}

async function writeFile(store, path, target) {
  const part = `${target}.part`;
  const fh = await open(part, 'wx');
  let bytes = 0;
  try {
    for await (const chunk of store.readChunks(path)) { await fh.write(chunk); bytes += chunk.length; }
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(part); // never leave half a file
    throw e;
  }
  await fh.close();
  await rename(part, target); // only now: the content id matched
  return bytes;
}

/**
 * Export every live file and folder of `store` into dest (already checked; created here).
 * @param {import('./store.mjs').Store} store
 * @param {string} dest  absolute, from checkExportDest
 * @returns {Promise<{files: number, folders: number, bytes: number, gone: number, store: object}>}
 *   gone: files deleted by another process while exporting; store: the store in use at the end (maybe reopened)
 */
export async function exportVault(store, dest) {
  await mkdir(dest, { recursive: true });
  const out = { files: 0, folders: 0, bytes: 0, gone: 0 };
  let s = store;
  let reopened = false;
  const target = (p) => {
    checkPath(p);
    const t = join(dest, ...p.split('/'));
    if (!inside(t, dest) || t === dest) fail('BAD_PATH', 'A path would leave the export folder.');
    return t;
  };
  const entries = s.tree('');
  for (const e of entries.filter((x) => x.kind === 'd')) { await mkdir(target(e.path), { recursive: true }); out.folders++; }
  for (const e of entries.filter((x) => x.kind === 'f')) {
    const t = target(e.path);
    await mkdir(dirname(t), { recursive: true });
    for (;;) {
      try {
        out.bytes += await writeFile(s, e.path, t);
        out.files++;
        break;
      } catch (err) {
        if (err instanceof VaultError && err.code === 'NOT_FOUND' && reopened) { out.gone++; break; }
        if (!(err instanceof VaultError) || err.code !== 'PACK_MISSING' || reopened) throw err;
        s = await s.reopen(); // the running hub cleaned up since we opened: once, same key
        reopened = true;
      }
    }
  }
  return { ...out, store: s };
}
