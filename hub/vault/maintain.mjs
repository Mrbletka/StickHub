// Maintenance in small steps (design 8.6, job 2b). A chain is what one maintain(), one cleanup() or one automatic
// maintenance is doing. step() runs inside the store's write queue and does at most ONE unit of work:
//   a due trash purge (one commit), one compaction call (one commit), or one capped cleanup run.
// The caller queues the next step only after this one finished, so saves that arrived meanwhile go first.
// A chain ends when nothing is left, when a cleanup run is blocked, busy (reads in progress) or fails, or when the
// store is closing. It never spins: compaction steps go on only while the number of packs in use or the dead bytes
// go down; cleanup steps do at most as much work as the chain's first cleanup run saw (saves that arrive all the
// time make new leftovers: the next maintenance takes them); and a chain stops after MAX_STEPS steps.

import { VaultError } from './errors.mjs';
import { planCompaction } from './compact.mjs';
import { noRemovals } from './cleanup.mjs';

export const MAX_STEPS = 50_000;

/** A merged cleanup result (summed over its runs). */
export function emptyCleanup() {
  return { done: true, level: 'none', reasons: [], removed: noRemovals(), indexFiles: null, more: false, left: 0, steps: 0 };
}

/** Add one cleanup run to a merged result. */
export function mergeCleanup(acc, r) {
  acc.done = r.done;
  acc.level = r.level;
  acc.reasons = [...new Set([...acc.reasons, ...r.reasons])];
  for (const k of ['indexParts', 'indexes', 'packs', 'headerParts']) acc.removed[k] += r.removed[k];
  acc.removed.headerBackup ||= r.removed.headerBackup;
  acc.indexFiles = r.indexFiles;
  acc.more = r.more;
  acc.left = r.left;
  acc.steps++;
  return acc;
}

/** Units of work a cleanup run did: deleted files, and the header backup completion. */
const units = (removed) => removed.indexParts + removed.indexes + removed.packs + removed.headerParts + (removed.headerBackup ? 1 : 0);

function mergeCompaction(acc, r) {
  const c = acc || { done: false, packs: 0, newPacks: 0, bytes: 0, steps: 0 };
  c.steps++;
  if (r.done) {
    c.done = true;
    c.packs += r.packs;
    c.newPacks += r.newPacks;
    c.bytes += r.bytes;
  } else {
    c.reason = r.reason;
    if (r.error) c.error = r.error;
  }
  return c;
}

/**
 * A new chain.
 * @param {'maintain'|'cleanup'} kind  cleanup: capped cleanup runs only, at least one
 */
export function newChain(kind) {
  return {
    kind,
    phase: kind === 'cleanup' ? 'cleanup' : 'purge',
    lastPlan: null,
    started: false,
    budget: null, // units the cleanup steps may still do: set by the first cleanup run
    steps: 0,
    out: kind === 'cleanup' ? emptyCleanup() : { purged: 0, compacted: null, cleanup: null, steps: 0 },
  };
}

/**
 * Do the next unit of work of a chain. Runs inside the store's write queue.
 * @param {ReturnType<typeof newChain>} chain
 * @param {{closing: () => boolean, state: () => object, problems: () => string[], purgeDue: () => boolean,
 *   purge: () => Promise<number>, compact: () => Promise<object>, cleanupRun: () => Promise<object>,
 *   needsCleanup: () => boolean}} io  the store's side
 * @returns {Promise<boolean>} true = work is left: queue another step
 */
export async function step(chain, io) {
  if (io.closing() || chain.steps >= MAX_STEPS) return false;
  const count = () => { chain.steps++; if (chain.kind === 'maintain') chain.out.steps = chain.steps; };
  if (chain.phase === 'purge') {
    chain.phase = 'compact';
    if (io.purgeDue()) {
      chain.out.purged += await io.purge();
      count();
      return true;
    }
  }
  if (chain.phase === 'compact') {
    const plan = io.problems().length ? null : planCompaction(io.state());
    const progress = plan && (!chain.lastPlan || plan.livePacks < chain.lastPlan.livePacks || plan.dead < chain.lastPlan.dead);
    if (progress) {
      chain.lastPlan = plan;
      let r;
      try {
        r = await io.compact();
      } catch (e) { // e.g. a damaged pack: note it, skip compaction, still clean up (a failed write stops the chain)
        if (!(e instanceof VaultError) || ['WRITE_FAILED', 'STORE_BROKEN', 'CLOSED'].includes(e.code)) throw e;
        chain.failed = e;
        r = { done: false, reason: 'failed', error: e.code };
      }
      chain.out.compacted = mergeCompaction(chain.out.compacted, r);
      count();
      if (r.done) return true;
      if (r.error) { chain.phase = 'cleanup'; chain.started = true; return true; } // the cleanup phase runs once at least
    }
    chain.phase = 'cleanup';
  }
  if (chain.kind === 'maintain' && !chain.started && !io.needsCleanup()) return false; // nothing to clean: no I/O
  chain.started = true;
  const r = await io.cleanupRun();
  if (chain.kind === 'maintain') chain.out.cleanup = mergeCleanup(chain.out.cleanup || emptyCleanup(), r);
  else mergeCleanup(chain.out, r);
  count();
  if (!r.done) return false;
  chain.budget = (chain.budget ?? units(r.removed) + r.left) - units(r.removed);
  return r.more && chain.budget > 0;
}

/**
 * Who runs chains in a store: explicit ones (maintain(), cleanup(): the caller waits) and the automatic one (nobody
 * waits). The automatic chain gives way to an explicit one: it does not start while one runs, and a running one ends
 * (its next step is dropped, or it queues none), so a save never waits behind steps of two chains.
 */
export class Maintenance {
  #queue; #io; #onError; #auto = null; #explicit = 0;

  /**
   * @param {{task: Function, background: Function, dropBackground: () => number}} queue  the store's write queue
   * @param {() => object} io  the store's side (see step)
   * @param {(e: Error) => void} onError  errors of automatic steps go here, never to a save
   */
  constructor(queue, io, onError) { this.#queue = queue; this.#io = io; this.#onError = onError; }

  /** True while the automatic chain has a step queued or running. */
  get active() { return this.#auto !== null; }

  /**
   * Run an explicit chain to its end: each step its own queue task, queued after the previous one finished.
   * @param {'maintain'|'cleanup'} kind
   */
  async run(kind) {
    const chain = newChain(kind);
    this.#explicit++;
    if (this.#auto && this.#queue.dropBackground()) this.#auto = null; // its next step had not started
    try {
      while (await this.#queue.task(() => step(chain, this.#io())));
      if (chain.failed) this.#onError(chain.failed); // recorded in status().lastCleanup as well
      return chain.out;
    } finally {
      this.#explicit--;
    }
  }

  /** Start the automatic chain, unless it runs already or an explicit chain runs. */
  auto() {
    if (this.#auto || this.#explicit) return;
    this.#auto = newChain('maintain');
    this.#next();
  }

  #next() {
    const chain = this.#auto;
    this.#queue.background(async () => {
      const more = await step(chain, this.#io());
      if (more && !this.#explicit && !this.#io().closing()) return this.#next();
      this.#auto = null;
      if (chain.failed) this.#onError(chain.failed);
    }, (e) => { this.#auto = null; this.#onError(e); });
  }
}
