// .vx files (design 6.3): round trips on buffers and streams at the edge sizes, and every kind of damage refused:
// cut at a segment edge, a flipped byte, swapped segments, swapped file names, extra bytes, wrong key or kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import {
  sealVx, openVx, createSealStream, createOpenStream, padme, paddedSize, vxSize, newFileId, vxFileName, parseVxFileName,
  SEG, TAG, HEAD, MAX_PAYLOAD,
} from '../hub/vault/vx.mjs';
import { subkeys } from '../hub/vault/keys.mjs';

const FULL = SEG + TAG;
const vaultId = randomBytes(16);
const k = subkeys(randomBytes(32), vaultId, 1);
const ctx = { kFile: k.file, vaultId, epoch: 1 };
const idA = newFileId();
const idB = newFileId();
const pack = (fileId = idA) => ({ kind: 'pack', fileId });

/** Feed chunks through a transform and collect its output. */
async function through(transform, data, chunk = 65536) {
  const parts = [];
  for (let i = 0; i < data.length; i += chunk) parts.push(data.subarray(i, i + chunk));
  const out = [];
  await pipeline(Readable.from(parts), transform, new Writable({ write(c, _e, cb) { out.push(c); cb(); } }));
  return Buffer.concat(out);
}

const refused = (file, f = pack(), c = ctx) => assert.throws(() => openVx(file, c, f), (e) => /^(BAD_VX|TOO_BIG|UNSUPPORTED)$/.test(e.code));
const refusedStream = (file, f = pack(), c = ctx) => assert.rejects(through(createOpenStream(c, f), file, 1000), (e) => /^(BAD_VX|TOO_BIG|UNSUPPORTED)$/.test(e.code));

const SIZES = [0, 1, 65531, 65532, 65533, 65535, 65536, 65537, 200_000, 3 * 1024 * 1024 + 5];

test('round trip on buffers and streams at the edge sizes; the stream gives the same bytes', async () => {
  for (const n of SIZES) {
    const payload = randomBytes(n);
    const file = sealVx(payload, ctx, pack());
    assert.equal(file.length, vxSize(n), `size for ${n}`);
    assert.deepEqual(openVx(file, ctx, pack()), payload, `buffer ${n}`);
    const streamed = await through(createSealStream(ctx, { ...pack(), size: n }), payload, 7919);
    assert.deepEqual(streamed, file, `stream seal = buffer seal for ${n}`);
    assert.deepEqual(await through(createOpenStream(ctx, pack()), file, 4093), payload, `stream open ${n}`);
  }
});

test('index files round-trip too, and kinds are not interchangeable', () => {
  const payload = Buffer.from('{"index":true}');
  const file = sealVx(payload, ctx, { kind: 'index', fileId: idA });
  assert.deepEqual(openVx(file, ctx, { kind: 'index', fileId: idA }), payload);
  refused(file, pack());
  const fake = Buffer.from(file);
  fake[5] = 'P'.charCodeAt(0);
  refused(fake, pack());
  assert.throws(() => sealVx(payload, ctx, { kind: 'blob', fileId: idA }), { code: 'BAD_INPUT' });
});

const big = randomBytes(200_000); // 4 segments: 3 full + 1 short
const bigFile = sealVx(big, ctx, pack());
const nSeg = Math.ceil((bigFile.length - HEAD) / FULL);

test('cut at every segment edge (and one byte off each): refused', async () => {
  assert.equal(nSeg, 4);
  for (let i = 0; i <= nSeg; i++) {
    for (const d of [-1, 0, 1]) {
      const len = HEAD + i * FULL + d;
      if (len >= bigFile.length || len < 0) continue;
      refused(bigFile.subarray(0, len));
      await refusedStream(bigFile.subarray(0, len));
    }
  }
  refused(bigFile.subarray(0, bigFile.length - 1));
  refused(bigFile.subarray(0, bigFile.length - TAG));
});

test('a flipped byte anywhere is refused (all edges, every tag, every 97th byte)', () => {
  const at = new Set();
  for (let i = 0; i < 64; i++) at.add(i);
  for (let s = 0; s < nSeg; s++) {
    const end = Math.min(bigFile.length, HEAD + (s + 1) * FULL);
    for (let i = end - TAG - 4; i < end + 4 && i < bigFile.length; i++) at.add(i);
  }
  for (let i = 0; i < bigFile.length; i += 97) at.add(i);
  for (let i = bigFile.length - 64; i < bigFile.length; i++) at.add(i);
  for (const i of at) {
    const f = Buffer.from(bigFile);
    f[i] ^= 1 << (i % 8);
    refused(f);
  }
  assert.ok(at.size > 2000, `${at.size} positions`);
});

test('swapped segments are refused', () => {
  const seg = (f, i) => f.subarray(HEAD + i * FULL, HEAD + (i + 1) * FULL);
  for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
    const f = Buffer.from(bigFile);
    Buffer.from(seg(bigFile, a)).copy(f, HEAD + b * FULL);
    Buffer.from(seg(bigFile, b)).copy(f, HEAD + a * FULL);
    refused(f);
  }
  const dup = Buffer.from(bigFile); // segment 0 twice
  seg(bigFile, 0).copy(dup, HEAD + FULL);
  refused(dup);
});

test('swapped file names are refused', async () => {
  const fileB = sealVx(randomBytes(1000), ctx, pack(idB));
  const nameA = vxFileName(idA);
  const nameB = vxFileName(idB);
  assert.deepEqual(parseVxFileName(nameA), idA);
  refused(bigFile, pack(parseVxFileName(nameB))); // A's bytes stored under B's name
  refused(fileB, pack(parseVxFileName(nameA)));
  await refusedStream(fileB, pack(idA));
});

test('extra bytes at the end are refused', async () => {
  const last = bigFile.subarray(HEAD + (nSeg - 1) * FULL);
  for (const extra of [Buffer.alloc(1), Buffer.alloc(TAG), bigFile.subarray(HEAD, HEAD + FULL), last]) {
    refused(Buffer.concat([bigFile, extra]));
    await refusedStream(Buffer.concat([bigFile, extra]));
  }
});

test('the wrong vault id, epoch or key is refused', () => {
  refused(bigFile, pack(), { ...ctx, vaultId: randomBytes(16) });
  refused(bigFile, pack(), { ...ctx, epoch: 2 });
  refused(bigFile, pack(), { ...ctx, kFile: subkeys(randomBytes(32), vaultId, 1).file });
});

test('header checks: magic, version, kind, reserved bytes', () => {
  const v2 = Buffer.from(bigFile);
  v2[4] = 2;
  assert.throws(() => openVx(v2, ctx, pack()), { code: 'UNSUPPORTED' });
  for (const [i, val] of [[0, 0x58], [4, 0], [6, 1], [7, 1]]) {
    const f = Buffer.from(bigFile);
    f[i] = val;
    assert.throws(() => openVx(f, ctx, pack()), { code: 'BAD_VX' });
  }
});

test('size limits: payload, whole file, and the streams', async () => {
  assert.throws(() => sealVx(Buffer.alloc(MAX_PAYLOAD.index + 1), ctx, { kind: 'index', fileId: idA }), { code: 'TOO_BIG' });
  assert.throws(() => createSealStream(ctx, { kind: 'index', fileId: idA, size: MAX_PAYLOAD.index + 1 }), { code: 'TOO_BIG' });
  assert.throws(() => openVx(Buffer.alloc(vxSize(MAX_PAYLOAD.index) + 1), ctx, { kind: 'index', fileId: idA }), { code: 'TOO_BIG' });
  assert.throws(() => openVx(Buffer.alloc(100), ctx, pack()), { code: 'BAD_VX' });
  const maxIndex = sealVx(Buffer.alloc(MAX_PAYLOAD.index, 1), ctx, { kind: 'index', fileId: idA });
  assert.equal(openVx(maxIndex, ctx, { kind: 'index', fileId: idA }).length, MAX_PAYLOAD.index);
  await assert.rejects(through(createOpenStream(ctx, { kind: 'index', fileId: idA }), Buffer.concat([maxIndex, Buffer.alloc(FULL)])), { code: 'TOO_BIG' });
  await assert.rejects(through(createSealStream(ctx, { ...pack(), size: 10 }), Buffer.alloc(11)), { code: 'TOO_BIG' });
  await assert.rejects(through(createSealStream(ctx, { ...pack(), size: 10 }), Buffer.alloc(9)), { code: 'BAD_INPUT' });
  await assert.rejects(through(createOpenStream(ctx, pack()), Buffer.alloc(5)), { code: 'BAD_VX' });
});

test('Padme: known values, at most 12% extra, never smaller, stable', () => {
  assert.equal(padme(65537), 67584);
  assert.equal(paddedSize(0), 65536);
  assert.equal(paddedSize(65532), 65536);
  assert.equal(paddedSize(65533), padme(65537));
  for (let n = 65536; n < 40e6; n = Math.floor(n * 1.37) + 1) {
    const p = padme(n);
    assert.ok(p >= n && (p - n) / n <= 0.12, `n=${n}`);
    assert.equal(padme(p), p, `stable at ${n}`);
  }
});

test('file names: canonical lower-case base32 only', () => {
  const name = vxFileName(idA);
  assert.match(name, /^[a-z2-7]{26}\.vx$/);
  for (const bad of [name.toUpperCase(), name.slice(1), `${name.slice(0, 25)}7.vx`, name.replace('.vx', '.part'), 'x.vx', null]) {
    assert.throws(() => parseVxFileName(bad), { code: 'BAD_VX' }, String(bad));
  }
  for (let i = 0; i < 200; i++) { const id = newFileId(); assert.deepEqual(parseVxFileName(vxFileName(id)), id); }
});

test('the plaintext never shows in the file', () => {
  const secret = Buffer.from('TEST ONLY recognisable plaintext 0123456789');
  const f = sealVx(Buffer.concat([secret, secret, secret]), ctx, pack());
  assert.equal(f.indexOf(secret.subarray(0, 12)), -1);
});
