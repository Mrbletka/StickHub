import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planData, planCode, codeDecision, appOf } from '../hub/sync/plan.mjs';
import { nameOk, relOk, conflictRel, CONFLICT_RE } from '../hub/sync/safe-path.mjs';

const H = (c) => c.repeat(64);
const files = (o) => new Map(Object.entries(o).map(([k, h]) => [k, { size: 1, hash: h }]));
const NOW = new Date(2026, 10, 4, 12, 0, 5);

test('names and paths', () => {
  for (const ok of ['a.json', 'zażółć.txt', '.hidden', 'a b.txt']) assert.ok(nameOk(ok), ok);
  for (const bad of ['', '.', '..', 'a:b', 'a?b', 'a\\b', 'x.', 'x ', 'CON', 'nul.txt', 'a\u0001b', 'x'.repeat(121)]) assert.ok(!nameOk(bad), bad);
  assert.ok(relOk('app/save/one.json'));
  for (const bad of ['/abs', 'a/../b', 'a//b', '', 'a/./b']) assert.ok(!relOk(bad), bad);
  assert.equal(conflictRel('game/save.json', NOW), 'game/save.conflict-20261104-120005.json');
  assert.equal(conflictRel('game/README', NOW), 'game/README.conflict-20261104-120005');
  assert.ok(CONFLICT_RE.test('game/save.conflict-20261104-120005.json'));
  assert.equal(appOf('tap-counter/x.json'), 'tap-counter');
  assert.equal(appOf('Bad_App/x.json'), null);
  assert.equal(appOf('loose.json'), null);
});

test('one side changed: copy it; same change on both: just remember', () => {
  const r = planData({
    phone: files({ 'a/new.json': H('1'), 'a/same.json': H('2'), 'a/changed.json': H('3'), 'a/both.json': H('9') }),
    stick: files({ 'a/same.json': H('2'), 'a/changed.json': H('4'), 'a/fromstick.json': H('5'), 'a/both.json': H('9') }),
    base: new Map([['a/same.json', H('2')], ['a/changed.json', H('4')], ['a/both.json', H('8')]]),
  });
  assert.deepEqual(r.ops.map((o) => [o.op, o.from, o.rel]), [
    ['put', 'phone', 'a/changed.json'], ['put', 'stick', 'a/fromstick.json'], ['put', 'phone', 'a/new.json']]);
  assert.deepEqual([...r.agreed], [['a/both.json', H('9')]]);
});

test('deletions go to the trash of the other side', () => {
  const r = planData({
    phone: files({ 'a/kept.json': H('1') }),
    stick: files({ 'a/gone-on-phone.json': H('2') }),
    base: new Map([['a/gone-on-phone.json', H('2')], ['a/kept.json', H('1')]]),
  });
  assert.deepEqual(r.ops, [
    { op: 'trash', side: 'stick', rel: 'a/gone-on-phone.json', hash: H('2') },
    { op: 'trash', side: 'phone', rel: 'a/kept.json', hash: H('1') },
  ]);
});

test('both changed: phone keeps the name, stick version kept as a conflict copy', () => {
  const r = planData({ phone: files({ 'a/s.json': H('1') }), stick: files({ 'a/s.json': H('2') }), base: new Map([['a/s.json', H('0')]]), now: NOW });
  const c = 'a/s.conflict-20261104-120005.json';
  assert.deepEqual(r.conflicts, [c]);
  assert.deepEqual(r.ops.map((o) => o.op), ['rename', 'put', 'put']);
  assert.deepEqual(r.ops[0], { op: 'rename', side: 'stick', rel: 'a/s.json', to: c, hash: H('2') });
  assert.equal(r.ops[1].from, 'stick');
  assert.equal(r.ops[1].rel, c);
  assert.equal(r.ops[2].from, 'phone');
});

test('deleted on one side, changed on the other: the change wins', () => {
  const r = planData({ phone: files({}), stick: files({ 'a/s.json': H('2') }), base: new Map([['a/s.json', H('0')]]) });
  assert.deepEqual(r.ops.map((o) => [o.op, o.from]), [['put', 'stick']]);
  const r2 = planData({ phone: files({ 'a/s.json': H('1') }), stick: files({}), base: new Map([['a/s.json', H('0')]]) });
  assert.deepEqual(r2.ops.map((o) => [o.op, o.from]), [['put', 'phone']]);
});

test('running apps are pending; bad folders are skipped', () => {
  const r = planData({
    phone: files({ 'game/s.json': H('1'), 'other/s.json': H('1') }), stick: files({ 'Bad_Dir/x': H('3'), 'loose.txt': H('3') }),
    base: new Map(), running: new Set(['game']),
  });
  assert.deepEqual(r.pending, ['game']);
  assert.deepEqual(r.ops.map((o) => o.rel), ['other/s.json']);
  assert.deepEqual(r.skipped.map((s) => s.rel), ['Bad_Dir/x', 'loose.txt']);
});

test('code decision follows the owner rules', () => {
  const head = H('a').slice(0, 40);
  const old = H('b').slice(0, 40);
  const st = (commit, codeState = 'complete') => ({ commit, codeState });
  assert.equal(codeDecision({ hasGit: false, stick: st(null, 'none') }).state, 'no-git');
  assert.equal(codeDecision({ hasGit: true, clean: true, head, stick: st(head) }).state, 'same');
  assert.equal(codeDecision({ hasGit: true, clean: false, head, stick: st(old) }).state, 'dirty');
  assert.equal(codeDecision({ hasGit: true, clean: false, head, stick: st(head) }).state, 'dirty');
  assert.equal(codeDecision({ hasGit: true, clean: true, head, stick: st(null, 'none') }).copy, true);
  assert.equal(codeDecision({ hasGit: true, clean: true, head, stick: st(head, 'partial') }).state, 'resume');
  assert.equal(codeDecision({ hasGit: true, clean: true, head, stick: st(old), relation: true }).state, 'update');
  for (const relation of [false, null]) {
    const d = codeDecision({ hasGit: true, clean: true, head, stick: st(old), relation });
    assert.equal(d.copy, false);
    assert.equal(d.state, 'different');
  }
});

test('code plan: copy changed, missing and wrong-size files; trash files the phone dropped', () => {
  const f = (h, size = 1) => ({ size, hash: h });
  const phone = new Map([['hub/a.mjs', f(H('1'))], ['hub/b.mjs', f(H('2'))], ['hub/c.mjs', f(H('3'))], ['hub/d.mjs', f(H('4'))]]);
  const index = new Map([['hub/a.mjs', f(H('1'))], ['hub/b.mjs', f(H('9'))], ['hub/c.mjs', f(H('3'))], ['hub/old.mjs', f(H('5'))], ['hub/d.mjs', f(H('4'))]]);
  const present = new Map([['hub/a.mjs', { size: 1 }], ['hub/b.mjs', { size: 1 }], ['hub/old.mjs', { size: 1 }], ['hub/d.mjs', { size: 7 }]]);
  assert.deepEqual(planCode(phone, index, present).map((o) => [o.op, o.rel]),
    [['trash', 'hub/old.mjs'], ['put', 'hub/b.mjs'], ['put', 'hub/c.mjs'], ['put', 'hub/d.mjs']]);
});
