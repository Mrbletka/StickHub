// Compaction (design 8.6): move the live pieces of small or mostly dead packs into new packs of about 8 MiB, so the
// vault does not end up with thousands of tiny packs. The store runs it inside its write queue, one commit per call;
// the old packs stay until a later full cleanup removes them (they are kept while the previous index uses them).
// - planCompaction (size tiers, job 2c): a pack under 50% live is a candidate any time (that frees dead space). A
//   mostly live pack under 1 MiB is in a size tier by its live bytes: tier 0 under 4 KiB, then x4 per tier (16 KiB,
//   64 KiB, 256 KiB, 1 MiB). Only a tier with at least 4 packs is merged, lowest tier first; 4 packs of a tier make a
//   pack of a higher tier, so a byte moves about once per tier and a merged pack waits until its own tier is full.
//   Worth it with a full tier, at least 4 mostly dead packs, or at least 4 MiB of dead bytes in them. Cheapest packs
//   first, up to maxBytes of live bytes and maxPacks packs per call (one call is one step of maintain()).
// - gatherPieces (job 2c): opens each chosen pack once and reads only the pieces that move, in order, so each segment
//   is decrypted at most once and segments without a moving piece are not read. Every segment is authenticated
//   (AES-GCM, STREAM); every moving piece must be listed in its pack's table of contents under its content id, offset
//   and length; when every piece of a file moves, the file's content id (HMAC) is checked too. A file that only partly
//   moves is not read whole any more, so its content id is not checked here (verify does). Stops between packs when
//   the signal is aborted.

import { createHmac } from 'node:crypto';
import { fail } from './errors.mjs';
import { usage, readPackToc } from './indexfile.mjs';
import { packPieces } from './packs.mjs';
import { Draft } from './store-ops.mjs';

/** Trash entries older than this are dropped (decision 10). */
export const TRASH_DAYS_MS = 30 * 24 * 3600 * 1000;

export const COMPACT = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxPacks: 12, target: 8 * 1024 * 1024,
  small: 1024 * 1024, tierBase: 4 * 1024, tierFactor: 4, deadShare: 0.5, minCandidates: 4, minDead: 4 * 1024 * 1024 });

/** Size tier of a mostly live pack by its live bytes: 0 under 4 KiB, 1 under 16 KiB, ... 4 under 1 MiB. */
export function tierOf(live) {
  let t = 0;
  for (let b = COMPACT.tierBase; live >= b && b < COMPACT.small; b *= COMPACT.tierFactor) t++;
  return t;
}

/**
 * Which packs to compact now, or null when it is not worth it.
 * @param {{files: Map, trash: object[], packSizes: Map<string, number>}} state
 * @param {{maxBytes?: number, maxPacks?: number}} [o]  per call: live bytes moved, packs read
 * @returns {{packs: Set<string>, liveBytes: number, livePacks: number, dead: number}|null}  livePacks (packs in use),
 *   dead (dead bytes in mostly dead packs): for the progress check of stepped maintenance (maintain.mjs)
 */
export function planCompaction(state, o = {}) {
  const maxBytes = o.maxBytes ?? COMPACT.maxBytes;
  const maxPacks = o.maxPacks ?? COMPACT.maxPacks;
  if (![maxBytes, maxPacks].every((n) => Number.isSafeInteger(n) && n >= 1)) fail('BAD_INPUT', 'compact: maxBytes and maxPacks must be whole numbers from 1');
  const live = usage(state.files, state.trash);
  const mostlyDead = [];
  const tiers = new Map();
  let dead = 0;
  let livePacks = 0;
  for (const [name, size] of state.packSizes) {
    const l = live.get(name) || 0;
    if (!l) continue;
    livePacks++;
    if (l < size * COMPACT.deadShare) {
      mostlyDead.push([name, l]);
      dead += size - l;
    } else if (l < COMPACT.small) {
      const t = tierOf(l);
      if (!tiers.has(t)) tiers.set(t, []);
      tiers.get(t).push([name, l]);
    }
  }
  const full = [...tiers.keys()].sort((a, b) => a - b).find((t) => tiers.get(t).length >= COMPACT.minCandidates);
  if (full === undefined && mostlyDead.length < COMPACT.minCandidates && dead < COMPACT.minDead) return null;
  const cand = [...mostlyDead, ...(full === undefined ? [] : tiers.get(full))];
  cand.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const packs = new Set();
  let liveBytes = 0;
  for (const [name, l] of cand) {
    if (packs.size && (liveBytes + l > maxBytes || packs.size >= maxPacks)) break;
    packs.add(name);
    liveBytes += l;
  }
  return packs.size >= 2 || dead >= COMPACT.minDead ? { packs, liveBytes, livePacks, dead } : null;
}

/**
 * The pieces that move, read and checked.
 * @param {{files: Map, trash: object[]}} state
 * @param {Set<string>} chosen  pack names
 * @param {import('./store-read.mjs').PackReader} pr
 * @param {Buffer} kId  content-id key
 * @param {AbortSignal} [signal]
 * @returns {Promise<{key: string, id: string, part: number, data: Buffer, path: string}[]>}
 */
export async function gatherPieces(state, chosen, pr, kId, signal) {
  const pieces = new Map(); // "pack:offset:length" -> piece (a piece shared by several files moves once)
  const whole = new Map(); // content id -> extents, for files whose every piece moves
  const add = (e, path) => {
    if (e.kind !== 'f' || !e.x.some(([n]) => chosen.has(n))) return;
    e.x.forEach(([pack, off, len], part) => {
      const key = `${pack}:${off}:${len}`;
      if (chosen.has(pack) && !pieces.has(key)) pieces.set(key, { key, id: e.id, part, path, pack, off, len, data: null });
    });
    if (e.x.every(([n]) => chosen.has(n))) whole.set(e.id, e.x);
  };
  for (const [p, e] of state.files) add(e, p);
  for (const t of state.trash) add(t, t.path);
  const byPack = new Map();
  for (const p of pieces.values()) {
    if (!byPack.has(p.pack)) byPack.set(p.pack, []);
    byPack.get(p.pack).push(p);
  }
  for (const [pack, list] of byPack) {
    if (signal?.aborted) fail('CANCELLED', 'Compaction was stopped.');
    list.sort((a, b) => a.off - b.off);
    await pr.withPack(pack, async (r) => {
      for (const p of list) p.data = await r.read(p.off, p.len); // in order: each segment once
      const toc = new Set((await readPackToc(r)).map((b) => `${b.id}:${b.off}:${b.len}`));
      for (const p of list) if (!toc.has(`${p.id}:${p.off}:${p.len}`)) fail('BAD_VX', 'A pack does not hold what the index says.');
    }, Infinity);
  }
  for (const [id, x] of whole) {
    const h = createHmac('sha256', kId);
    for (const [pack, off, len] of x) h.update(pieces.get(`${pack}:${off}:${len}`).data);
    if (h.digest('base64url') !== id) fail('BAD_VX', 'A file in the vault does not match its content id.');
  }
  return [...pieces.values()].map(({ key, id, part, data, path }) => ({ key, id, part, data, path }));
}

/**
 * One compaction commit (inside the store's write queue). Not while there are problems: full cleanup is refused then,
 * so new packs would only fill the disk.
 * @param {{state: object, problems: string[], pr: object, kId: Buffer, ctx: object, random: Function, now: number,
 *   signal?: AbortSignal, maxBytes?: number, maxPacks?: number, commit: (d: Draft, now: number) => Promise<void>}} s
 * @returns {Promise<{done: boolean, reason?: string, packs?: number, newPacks?: number, bytes?: number}>}
 */
export async function compactStore(s) {
  if (s.problems.length) return { done: false, reason: 'problems' };
  const plan = planCompaction(s.state, { maxBytes: s.maxBytes, maxPacks: s.maxPacks });
  if (!plan) return { done: false, reason: 'not worth it' };
  let pieces;
  try {
    pieces = await gatherPieces(s.state, plan.packs, s.pr, s.kId, s.signal);
  } catch (e) {
    if (e.code === 'CANCELLED') return { done: false, reason: 'cancelled' };
    throw e;
  }
  if (s.signal?.aborted) return { done: false, reason: 'cancelled' };
  const built = packPieces(pieces, s.ctx, s.random, s.now, COMPACT.target);
  const d = new Draft(s.state);
  d.remap(built.map);
  d.extraPacks = built.packs;
  d.extraSizes = built.sizes;
  await s.commit(d, s.now);
  return { done: true, packs: plan.packs.size, newPacks: built.packs.length, bytes: plan.liveBytes };
}
