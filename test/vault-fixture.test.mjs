// The v1 fixture in test/fixtures/vault-v1/: a small vault made from fixed bytes. TEST ONLY keys and secrets.
// 1. Reading it must keep working in every later version (do not change or delete these files; add a new fixture
//    for a new format version instead).
// 2. Today's code must still write it byte for byte. If you change the format on purpose, bump the version, keep
//    test 1 passing, and add a new fixture. To (re)write this one: STICKHUB_WRITE_FIXTURE=1 node --test test/vault-fixture.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newDataKey, newId, subkeys } from '../hub/vault/keys.mjs';
import { makePassphraseSlot, makeRecoverySlot } from '../hub/vault/slots.mjs';
import { buildHeader, parseHeader, unlockWithPassphrase, unlockWithPaperCode } from '../hub/vault/header.mjs';
import { sealVx, openVx, newFileId, vxFileName, parseVxFileName } from '../hub/vault/vx.mjs';
import { fixedRandom } from './vault-helpers.mjs';

const DIR = join(import.meta.dirname, 'fixtures', 'vault-v1');
const SEED = 'StickHub vault v1 fixture - TEST ONLY';
const KDF = Object.freeze({ alg: 'argon2id', m: 1024, t: 1, p: 1 }); // TEST ONLY: far below the real 256 MiB
const PASSPHRASE = 'TEST ONLY fixture passphrase - not a real secret';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Build the fixture from the fixed seed. */
async function build() {
  const random = fixedRandom(SEED);
  const dk = newDataKey(random);
  const vaultId = newId(random);
  const epoch = 1;
  const ps = await makePassphraseSlot({ dk, vaultId, epoch, passphrase: PASSPHRASE, kdf: KDF, random });
  const { slot: rs, paperCode } = makeRecoverySlot({ dk, vaultId, epoch, random });
  const header = buildHeader({ vaultId, epoch, hseq: 1, slots: [ps, rs] }, dk);
  const ctx = { kFile: subkeys(dk, vaultId, epoch).file, vaultId, epoch };
  const indexId = newFileId(random);
  const packId = newFileId(random);
  const indexPayload = Buffer.from(JSON.stringify({ fixture: 'StickHub vault v1 - TEST ONLY index payload' }));
  const packPayload = random(150_000); // 3 segments
  const files = new Map([
    ['vault.json', Buffer.from(header)],
    [vxFileName(indexId), sealVx(indexPayload, ctx, { kind: 'index', fileId: indexId })],
    [vxFileName(packId), sealVx(packPayload, ctx, { kind: 'pack', fileId: packId })],
  ]);
  const inputs = {
    warning: 'TEST ONLY. Every key and secret in this folder is public test data, made from a fixed seed. Never use it for real data.',
    seed: SEED,
    dataKeyHex: dk.toString('hex'),
    vaultId: vaultId.toString('base64url'),
    epoch,
    passphrase: PASSPHRASE,
    paperCode,
    kdf: KDF,
    index: { file: vxFileName(indexId), payloadBytes: indexPayload.length, payloadSha256: sha(indexPayload) },
    pack: { file: vxFileName(packId), payloadBytes: packPayload.length, payloadSha256: sha(packPayload) },
  };
  files.set('inputs.json', Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`));
  return files;
}

const writing = process.env.STICKHUB_WRITE_FIXTURE === '1';

test('write the fixture (only with STICKHUB_WRITE_FIXTURE=1)', { skip: !writing && 'not writing' }, async () => {
  mkdirSync(DIR, { recursive: true });
  for (const [name, data] of await build()) writeFileSync(join(DIR, name), data);
});

test('the committed v1 fixture still opens: passphrase, paper code, index and pack', async () => {
  const inputs = JSON.parse(readFileSync(join(DIR, 'inputs.json'), 'utf8'));
  const h = parseHeader(readFileSync(join(DIR, 'vault.json')));
  const dk = await unlockWithPassphrase(h, inputs.passphrase);
  assert.equal(dk.toString('hex'), inputs.dataKeyHex);
  assert.equal((await unlockWithPaperCode(h, inputs.paperCode)).toString('hex'), inputs.dataKeyHex);
  assert.equal(h.vaultId.toString('base64url'), inputs.vaultId);
  const ctx = { kFile: subkeys(dk, h.vaultId, h.epoch).file, vaultId: h.vaultId, epoch: h.epoch };
  for (const kind of ['index', 'pack']) {
    const f = inputs[kind];
    const payload = openVx(readFileSync(join(DIR, f.file)), ctx, { kind, fileId: parseVxFileName(f.file) });
    assert.equal(payload.length, f.payloadBytes);
    assert.equal(sha(payload), f.payloadSha256);
  }
});

test('today\'s code still writes the v1 fixture byte for byte', { skip: writing && 'writing' }, async () => {
  for (const [name, data] of await build()) {
    assert.deepEqual(readFileSync(join(DIR, name)), data, `${name} changed: the format changed (see the note at the top)`);
  }
});
