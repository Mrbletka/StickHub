// The unlock rate limit (hub/lock/limiter.mjs, design 7.9) with a fake clock: no Argon2id here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Limiter, LIMITS } from '../hub/lock/limiter.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const fileIn = () => { const d = mkdtempSync(join(tmpdir(), 'limiter-')); roots.push(d); return join(d, 'vault', 'attempts.json'); };

test('5 failures are free, then 2 s, 4 s, 8 s ... capped at 5 min', async () => {
  let now = 1_000_000;
  const l = new Limiter({ file: fileIn(), now: () => now });
  await l.load();
  for (let i = 0; i < 5; i++) { assert.equal(l.waitMs(), 0, `try ${i + 1} is free`); await l.failure(); }
  assert.equal(l.waitMs(), 2000, 'after the 5th failure: 2 s');
  now += 1500;
  assert.equal(l.waitMs(), 500, 'the wait counts down');
  now += 500;
  assert.equal(l.waitMs(), 0);
  await l.failure();
  assert.equal(l.waitMs(), 4000);
  await l.failure();
  assert.equal(l.waitMs(), 8000);
  assert.deepEqual([5, 6, 7, 8, 13, 14, 40].map(Limiter.stepMs), [2000, 4000, 8000, 16000, 300000, 300000, 300000]);
  assert.equal(Limiter.stepMs(LIMITS.free - 1), 0);
});

test('the count survives a restart (a new Limiter on the same file); a good unlock resets it', async () => {
  let now = 5_000_000;
  const file = fileIn();
  const a = new Limiter({ file, now: () => now });
  await a.load();
  for (let i = 0; i < 7; i++) await a.failure();
  const b = new Limiter({ file, now: () => now }); // the hub restarted
  await b.load();
  assert.equal(b.failures, 7);
  assert.equal(b.waitMs(), 8000);
  now += 8000;
  await b.success();
  const c = new Limiter({ file, now: () => now });
  await c.load();
  assert.deepEqual([c.failures, c.waitMs()], [0, 0]);
});

test('the file: folder 0700, file 0600, only a count and a time, no .tmp left', async () => {
  const file = fileIn();
  const l = new Limiter({ file, now: () => 42 });
  await l.load();
  await l.failure();
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { failures: 1, last: 42 });
  assert.deepEqual(readdirSync(join(file, '..')), ['attempts.json']);
});

test('a broken file counts as past the free tries; a clock that went back never makes the wait longer', async () => {
  const file = fileIn();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{not json');
  let now = 10_000;
  const l = new Limiter({ file, now: () => now });
  await l.load();
  assert.equal(l.waitMs(), 2000, 'the free tries count as used: the first wait starts now');
  now += 2000;
  await l.failure();
  assert.equal(l.waitMs(), 4000);
  now -= 3_600_000; // the phone's clock went back an hour
  assert.equal(l.waitMs(), 4000, 'at most the step itself');
});
