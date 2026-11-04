// Compaction (design 8.6): move the live pieces of small or mostly dead packs into new packs of about 8 MiB, so the
// vault does not end up with thousands of tiny packs. The store runs it inside its write queue, one commit per call;
// the old packs stay until a later full cleanup removes them (they are kept while the previous index uses them).
// - planCompaction: candidates = packs whose live bytes are under 50% of their size, and live packs under 1 MiB.
//   Worth it only with at least 4 candidates, or at least 4 MiB of dead bytes in them. Cheapest packs first, up to
//   maxBytes of live bytes and maxPacks packs read per call (job 2b: one call is one step of maintain()).
// - gatherPieces: reads every affected file whole through the normal checked path (content id checked at the end),
//   keeps the bytes of the pieces that move, and stops between files when the signal is aborted.

import { fail } from './errors.mjs';
import { usage } from './indexfile.mjs';
import { readChunks } from './store-read.mjs';
import { packPieces } from './packs.mjs';
import { Draft } from './store-ops.mjs';

/** Trash entries older than this are dropped (decision 10). */
export const TRASH_DAYS_MS = 30 * 24 * 3600 * 1000;

export const COMPACT = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxPacks: 12, target: 8 * 1024 * 1024,
  small: 1024 * 1024, deadShare: 0.5, minCandidates: 4, minDead: 4 * 1024 * 1024 });

/**
 * Which packs to compact now, or null when it is not worth it.
 * @param {{files: Map, trash: object[], packSizes: Map<string, number>}} state
 * @param {{maxBytes?: number, maxPacks?: number}} [o]  per call: live bytes moved, packs read
 * @returns {{packs: Set<string>, liveBytes: number, candidates: number, dead: number}|null}  candidates, dead: for the
 *   progress check of stepped maintenance (maintain.mjs)
 */
export function planCompaction(state, o = {}) {
  const maxBytes = o.maxBytes ?? COMPACT.maxBytes;
  const maxPacks = o.maxPacks ?? COMPACT.maxPacks;
  if (![maxBytes, maxPacks].every((n) => Number.isSafeInteger(n) && n >= 1)) fail('BAD_INPUT', 'compact: maxBytes and maxPacks must be whole numbers from 1');
  const live = usage(state.files, state.trash);
  const cand = [];
  let dead = 0;
  for (const [name, size] of state.packSizes) {
    const l = live.get(name) || 0;
    if (l > 0 && (l < size * COMPACT.deadShare || size < COMPACT.small)) { cand.push([name, l]); dead += size - l; }
  }
  if (cand.length < COMPACT.minCandidates && dead < COMPACT.minDead) return null;
  cand.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const packs = new Set();
  let liveBytes = 0;
  for (const [name, l] of cand) {
    if (packs.size && (liveBytes + l > maxBytes || packs.size >= maxPacks)) break;
    packs.add(name);
    liveBytes += l;
  }
  return packs.size >= 2 || dead >= COMPACT.minDead ? { packs, liveBytes, candidates: cand.length, dead } : null;
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
  const affected = new Map(); // content id -> {e, path}: one entry per content (dedupe)
  const add = (e, path) => { if (e.kind === 'f' && !affected.has(e.id) && e.x.some(([n]) => chosen.has(n))) affected.set(e.id, { e, path }); };
  for (const [p, e] of state.files) add(e, p);
  for (const t of state.trash) add(t, t.path);
  const pieces = new Map();
  for (const [id, { e, path }] of affected) {
    if (signal?.aborted) fail('CANCELLED', 'Compaction was stopped.');
    const parts = e.x.map(() => []);
    for await (const c of readChunks(pr, e, kId)) if (chosen.has(e.x[c.extent][0])) parts[c.extent].push(c.data);
    e.x.forEach(([n, off, len], i) => {
      const key = `${n}:${off}:${len}`;
      if (chosen.has(n) && !pieces.has(key)) pieces.set(key, { key, id, part: i, data: Buffer.concat(parts[i]), path });
    });
  }
  return [...pieces.values()];
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
