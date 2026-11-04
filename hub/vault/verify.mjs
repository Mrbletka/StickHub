// `vault verify`: check a replica folder without writing anything. The report holds counts and random file names
// only, never a path or a name from inside the vault.
// quick: both header copies parse, pass the MAC and are equal; every index decrypts and passes its checks; every pack
//        a valid index uses exists with the size that index says.
// full (default): also decrypts every segment of every used pack, reads its table of contents, and checks every file
//        (and trash entry) of the newest index against its content id.
// If packs are missing and the newest index on disk changed meanwhile (the running hub cleaned up), it checks again
// once; only a second miss is reported.

import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { VaultError } from './errors.mjs';
import { parseHeader, verifyHeaderMac, HEADER_MAX_BYTES } from './header.mjs';
import { createOpenStream, parseVxFileName, vxSize } from './vx.mjs';
import { openVxReader } from './vxread.mjs';
import { readPackToc, usage } from './indexfile.mjs';
import { scanIndexes, PACK_DIR, HEADER_MAIN, HEADER_BACKUP } from './replica.mjs';
import { PackReader, readChunks } from './store-read.mjs';

const damage = (e) => e instanceof VaultError && ['BAD_VX', 'BAD_INDEX', 'TOO_BIG', 'UNSUPPORTED', 'PACK_MISSING'].includes(e.code);

async function headerState(dir, dk, vfs) {
  const texts = {};
  const state = {};
  for (const [k, name] of [['main', HEADER_MAIN], ['backup', HEADER_BACKUP]]) {
    texts[k] = (await vfs.readLimited(join(dir, name), HEADER_MAX_BYTES).catch((e) => {
      if (damage(e)) return Buffer.from('');
      throw e;
    }))?.toString('utf8') ?? null;
    if (texts[k] === null) { state[k] = 'missing'; continue; }
    try {
      verifyHeaderMac(parseHeader(texts[k]), dk);
      state[k] = 'ok';
    } catch (e) {
      if (!(e instanceof VaultError)) throw e;
      state[k] = e.code;
    }
  }
  return { ...state, equal: texts.main !== null && texts.main === texts.backup };
}

/** Decrypt every segment of a pack and read its table of contents. Throws a VaultError on damage. */
async function checkPack(dir, name, ctx, vfs) {
  const path = join(dir, PACK_DIR, `${name}.vx`);
  const fileId = parseVxFileName(`${name}.vx`);
  await pipeline(createReadStream(path), createOpenStream(ctx, { kind: 'pack', fileId }), new Writable({ write(_c, _e, cb) { cb(); } }));
  const f = await vfs.openRead(path);
  let r = null;
  try {
    r = await openVxReader(f, ctx, { kind: 'pack', fileId });
    await readPackToc(r);
  } finally {
    r?.close();
    await f.close();
  }
}

/**
 * @param {{dir: string, vfs: object, ctx: {kFile: Buffer, vaultId: Buffer, epoch: number}, dk: Buffer, kId: Buffer,
 *   quick?: boolean}} o
 * @returns {Promise<object>} {ok, quick, header, indexes, packs, files, trash, checkedTwice}
 */
export async function verifyReplica(o, again = true) {
  const { dir, vfs, ctx } = o;
  const header = await headerState(dir, o.dk, vfs);
  const scan = await scanIndexes(dir, ctx, vfs);
  const packs = { used: 0, missing: [], wrongSize: [], damaged: [] };
  const sizes = new Map();
  for (const v of scan.valid) for (const n of usage(v.state.files, v.state.trash).keys()) sizes.set(n, v.state.packSizes.get(n));
  packs.used = sizes.size;
  for (const [name, payload] of [...sizes].sort()) {
    let f;
    try {
      f = await vfs.openRead(join(dir, PACK_DIR, `${name}.vx`));
    } catch (e) {
      if (e.code === 'ENOENT') { packs.missing.push(`${name}.vx`); continue; }
      throw e;
    }
    const size = f.size;
    await f.close();
    if (size !== vxSize(payload)) packs.wrongSize.push(`${name}.vx`);
    else if (!o.quick) {
      try { await checkPack(dir, name, ctx, vfs); } catch (e) { if (!damage(e)) throw e; packs.damaged.push(`${name}.vx`); }
    }
  }
  if (packs.missing.length && again) {
    const now = await scanIndexes(dir, ctx, vfs);
    if (now.valid[0]?.name !== scan.valid[0]?.name) return { ...(await verifyReplica(o, false)), checkedTwice: true };
  }
  const files = { checked: 0, bad: 0 };
  const trash = { checked: 0, bad: 0 };
  if (!o.quick && scan.valid.length) {
    const pr = new PackReader(dir, vfs, ctx);
    const newest = scan.valid[0].state;
    for (const [count, entries] of [[files, newest.files.values()], [trash, newest.trash]]) {
      for (const e of entries) {
        if (e.kind !== 'f') continue;
        count.checked++;
        try {
          for await (const _ of readChunks(pr, e, o.kId)) { /* reading is the check */ }
        } catch (err) {
          if (!damage(err)) throw err;
          count.bad++;
        }
      }
    }
  }
  const ok = header.main === 'ok' && header.backup === 'ok' && header.equal && scan.valid.length > 0 && !scan.damaged.length
    && !packs.missing.length && !packs.wrongSize.length && !packs.damaged.length && !files.bad && !trash.bad;
  return { ok, quick: !!o.quick, header, indexes: { valid: scan.valid.length, damaged: scan.damaged, leftovers: scan.parts.length },
    packs, files, trash, checkedTwice: false };
}
