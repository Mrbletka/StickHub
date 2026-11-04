// Sync planning: pure functions, no file access. Given what each side has, decide what to copy.
//
// Data (data/<app-id>/...): three-way by hash against the last synced state (the base).
//   only one side changed -> copy it (a deletion moves the other side's file to .trash)
//   both changed the same way -> nothing to copy, just remember it
//   both changed differently -> the phone's version keeps the name; the stick's version is kept as
//     name.conflict-<time> on both sides
//   one side deleted, the other changed -> the changed file wins
// Code (hub/, apps/): git decides; see codeDecision().

import { ID_RE } from '../manifest.mjs';
import { relOk, conflictRel, CONFLICT_RE } from './safe-path.mjs';

/**
 * @typedef {{op: 'put', from: 'phone'|'stick', rel: string, to?: string, hash: string, size: number}} PutOp
 *   copy `rel` from one side to the other (to `to` when given, else the same name)
 * @typedef {{op: 'trash', side: 'phone'|'stick', rel: string, hash: string}} TrashOp
 *   move the file at `rel` on `side` into that side's .trash (only if it still has `hash`)
 * @typedef {{op: 'rename', side: 'stick', rel: string, to: string, hash: string}} RenameOp
 * @typedef {PutOp|TrashOp|RenameOp} Op
 */

const ORDER = { trash: 0, rename: 1, put: 2 };

/** App id of a data path ("tap-counter/count.json" -> "tap-counter"), or null if not a valid app folder. */
export function appOf(rel) {
  const slash = rel.indexOf('/');
  const id = slash > 0 ? rel.slice(0, slash) : null;
  return id && ID_RE.test(id) ? id : null;
}

/**
 * Plan a data sync.
 * @param {{phone: Map<string, {size: number, hash: string}>, stick: Map<string, {size: number, hash: string}>,
 *   base: Map<string, string>, running?: Set<string>, now?: Date}} s
 * @returns {{ops: Op[], agreed: Map<string, string|null>, pending: string[], conflicts: string[], skipped: {rel: string, why: string}[]}}
 *   agreed: base updates that need no copying (both sides already equal; null = forget)
 */
export function planData(s) {
  const now = s.now || new Date();
  const running = s.running || new Set();
  const ops = [];
  const agreed = new Map();
  const pending = new Set();
  const conflicts = [];
  const skipped = [];
  const all = new Set([...s.phone.keys(), ...s.stick.keys(), ...s.base.keys()]);
  for (const rel of [...all].sort()) {
    const app = appOf(rel);
    if (!app || !relOk(rel)) { skipped.push({ rel, why: 'not inside an app folder with a valid id' }); continue; }
    const p = s.phone.get(rel);
    const st = s.stick.get(rel);
    const b = s.base.get(rel) ?? null;
    const ph = p?.hash ?? null;
    const sh = st?.hash ?? null;
    if (ph === sh) {
      if (b !== ph) agreed.set(rel, ph);
      continue;
    }
    if (running.has(app)) { pending.add(app); continue; }
    const phoneChanged = ph !== b;
    const stickChanged = sh !== b;
    if (phoneChanged && !stickChanged) {
      ops.push(ph ? { op: 'put', from: 'phone', rel, hash: ph, size: p.size } : { op: 'trash', side: 'stick', rel, hash: sh });
    } else if (stickChanged && !phoneChanged) {
      ops.push(sh ? { op: 'put', from: 'stick', rel, hash: sh, size: st.size } : { op: 'trash', side: 'phone', rel, hash: ph });
    } else if (!ph) {
      ops.push({ op: 'put', from: 'stick', rel, hash: sh, size: st.size }); // phone deleted, stick changed: keep it
    } else if (!sh) {
      ops.push({ op: 'put', from: 'phone', rel, hash: ph, size: p.size }); // stick deleted, phone changed: keep it
    } else {
      const to = conflictRel(rel, now);
      conflicts.push(to);
      ops.push({ op: 'rename', side: 'stick', rel, to, hash: sh });
      ops.push({ op: 'put', from: 'stick', rel: to, to, hash: sh, size: st.size });
      ops.push({ op: 'put', from: 'phone', rel, hash: ph, size: p.size });
    }
  }
  // Stable sort keeps a conflict's rename before its puts.
  ops.sort((x, y) => ORDER[x.op] - ORDER[y.op]);
  return { ops, agreed, pending: [...pending].sort(), conflicts, skipped };
}

/** Conflict copies that exist in a file list (they stay until the user deletes them). */
export function listConflicts(files) {
  return [...files.keys()].filter((rel) => CONFLICT_RE.test(rel)).sort();
}

/**
 * Should the phone copy its code to the stick?
 * @param {{hasGit: boolean, clean?: boolean, head?: string, stick: {commit: string|null, codeState: string},
 *   relation?: boolean|null}} s  relation: is stick.commit an ancestor of head (null = unknown commit)
 * @returns {{copy: boolean, state: string, message: string}}
 *   state: no-git | dirty | same | update | resume | different
 */
export function codeDecision(s) {
  if (!s.hasGit) return { copy: false, state: 'no-git', message: 'This copy is not a git clone, so code is not copied.' };
  const { commit, codeState } = s.stick;
  if (!s.clean) return { copy: false, state: 'dirty', message: 'The phone has uncommitted changes, so code was not copied. Commit them, then sync.' };
  if (commit === s.head && codeState === 'complete') return { copy: false, state: 'same', message: 'Stick has the same code as the phone.' };
  if (!commit || codeState === 'none') return { copy: true, state: 'update', message: 'Copying the code to the stick.' };
  if (commit === s.head) return { copy: true, state: 'resume', message: 'Finishing an unfinished code copy.' };
  if (s.relation === true) return { copy: true, state: 'update', message: 'Stick has older code: updating it.' };
  return { copy: false, state: 'different',
    message: `Stick has different code (${commit.slice(0, 7)}), not older than the phone's. Not overwritten.` };
}

/**
 * Plan a code copy phone -> stick: changed or new files, and files the phone no longer has (to .trash).
 * @param {Map<string, {size: number, hash: string}>} phone  tracked files on the phone
 * @param {Map<string, {size: number, hash: string}>} index  what the stick's index says it has
 * @param {Map<string, {size: number}>} present  files really on the stick (sizes only)
 * @returns {Op[]}
 */
export function planCode(phone, index, present) {
  const ops = [];
  for (const [rel, f] of [...index].sort()) {
    if (!phone.has(rel) && present.has(rel)) ops.push({ op: 'trash', side: 'stick', rel, hash: f.hash });
  }
  for (const [rel, f] of [...phone].sort()) {
    const known = index.get(rel);
    const there = present.get(rel);
    if (!known || known.hash !== f.hash || !there || there.size !== f.size) ops.push({ op: 'put', from: 'phone', rel, hash: f.hash, size: f.size });
  }
  return ops;
}
