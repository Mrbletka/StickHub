// Probe 9 must never print a signature: only a sha256 prefix. These tests feed its output classifier
// the shapes termux-keystore may print (base64, raw bytes, error text) and check the report lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { classifyOutput, fmt, redact } from '../probes/p9-keystore.mjs';
import { run } from '../probes/lib.mjs';

/** True if line contains any 16-char piece of the secret in base64, base64url or hex. */
function leaks(line, secret) {
  for (const enc of ['base64', 'base64url', 'hex']) {
    const s = secret.toString(enc);
    for (let i = 0; i + 16 <= s.length; i += 8) if (line.includes(s.slice(i, i + 16))) return true;
  }
  return false;
}

const line = (out) => fmt({ ms: 1234, code: 'exit 0', err: '', out });

test('a base64 signature becomes a sha256 prefix', () => {
  const sig = randomBytes(256);
  const o = classifyOutput(Buffer.from(`${sig.toString('base64')}\n`));
  assert.equal(o.kind, 'sig');
  assert.equal(o.enc, 'base64');
  assert.equal(o.bytes, 256);
  assert.match(o.id, /^[0-9a-f]{12}$/);
  assert.ok(o.raw.equals(sig));
  assert.equal(leaks(line(o), sig), false);
  assert.match(line(o), /^ok: signature \(base64, 256 bytes\) sha256 [0-9a-f]{12}\.\.\., 1\.2 s$/);
});

test('raw signature bytes become a sha256 prefix', () => {
  const sig = randomBytes(256);
  sig[0] = 0; // surely not text
  const o = classifyOutput(sig);
  assert.equal(o.kind, 'sig');
  assert.equal(o.enc, 'raw');
  assert.equal(leaks(line(o), sig), false);
});

test('same signature gives the same digest, another one a different digest', () => {
  const a = randomBytes(256).toString('base64');
  const b = randomBytes(256).toString('base64');
  assert.equal(classifyOutput(Buffer.from(a)).digest, classifyOutput(Buffer.from(a)).digest);
  assert.notEqual(classifyOutput(Buffer.from(a)).digest, classifyOutput(Buffer.from(b)).digest);
});

test('an error message is shown as text', () => {
  const o = classifyOutput(Buffer.from('android.security.keystore.UserNotAuthenticatedException: User not authenticated\n'));
  assert.equal(o.kind, 'text');
  assert.match(line({ ...o }), /refused \(exit 0\): "android\.security\.keystore\.UserNotAuthenticatedException: User not authenticated"/);
});

test('long tokens inside text are hidden', () => {
  const secret = randomBytes(48);
  const o = classifyOutput(Buffer.from(`Error: bad data ${secret.toString('base64url')} here`));
  assert.equal(o.kind, 'text');
  assert.equal(leaks(line(o), secret), false);
  assert.match(o.text, /<long token hidden>/);
  assert.equal(redact(`x ${'a'.repeat(31)} y`), `x ${'a'.repeat(31)} y`);
});

test('printable output with no spaces that is not a signature is still only hashed', () => {
  const secret = Buffer.from('k'.repeat(40));
  const o = classifyOutput(Buffer.from(`${secret}!`));
  assert.equal(o.kind, 'unknown');
  assert.equal(leaks(line(o), secret), false);
});

test('empty output', () => {
  assert.equal(classifyOutput(Buffer.alloc(0)).kind, 'empty');
  assert.equal(classifyOutput(Buffer.from(' \n')).kind, 'empty');
  assert.equal(line({ kind: 'empty' }), 'no output (exit 0), 1.2 s');
});

test('run can return binary output as a Buffer', async () => {
  const res = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0, 255, 1]))'], { encoding: 'buffer' });
  assert.equal(res.ok, true);
  assert.ok(Buffer.isBuffer(res.stdout));
  assert.deepEqual([...res.stdout], [0, 255, 1]);
});
