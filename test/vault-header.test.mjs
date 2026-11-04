// vault.json: strict parsing (refused before any KDF), the MAC catching any change, and unlocking. TEST ONLY secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeader, parseHeader, verifyHeaderMac, unlockWithPassphrase, unlockWithPaperCode, findSlot } from '../hub/vault/header.mjs';
import { makeTestVault, countKdfCalls } from './vault-helpers.mjs';

const v = await makeTestVault();
const outer = JSON.parse(v.text);
const body = JSON.parse(outer.body);
const text = (o = {}, b = undefined) => JSON.stringify({ ...outer, ...(b ? { body: JSON.stringify(b) } : {}), ...o });

test('build -> parse -> unlock with the passphrase or the paper code', async () => {
  const h = parseHeader(v.text);
  assert.deepEqual(h.vaultId, v.vaultId);
  assert.equal(h.epoch, 1);
  assert.equal(h.hseq, 1);
  assert.deepEqual(h.slots.map((s) => s.type), ['passphrase', 'recovery']);
  assert.deepEqual(findSlot(h, 'recovery'), v.rs);
  assert.deepEqual(await unlockWithPassphrase(h, v.passphrase), v.dk);
  assert.deepEqual(await unlockWithPaperCode(h, v.paperCode), v.dk);
  assert.deepEqual(parseHeader(Buffer.from(v.text)).body, h.body);
  await assert.rejects(unlockWithPassphrase(h, 'wrong'), { code: 'WRONG_SECRET' });
});

test('the MAC catches any change to the body', async () => {
  const h = parseHeader(v.text);
  verifyHeaderMac(h, v.dk);
  let parsedOk = 0;
  for (let i = 0; i < outer.body.length; i++) {
    for (const ch of ['0', 'A', 'z', '9', '_']) {
      if (outer.body[i] === ch) continue;
      const b = outer.body.slice(0, i) + ch + outer.body.slice(i + 1);
      let p;
      try { p = parseHeader(JSON.stringify({ ...outer, body: b })); } catch (e) { assert.match(e.code, /BAD_HEADER|UNSUPPORTED/); continue; }
      parsedOk++;
      assert.throws(() => verifyHeaderMac(p, v.dk), { code: /BAD_MAC|BAD_INPUT/ }, `change at ${i}`);
    }
  }
  assert.ok(parsedOk > 100, `many changes still parse (${parsedOk}) and the MAC catches each`);
  // same meaning, other bytes: key order, spaces
  for (const b of [JSON.stringify(body, null, 1), JSON.stringify({ hseq: body.hseq, ...body }), JSON.stringify({ ...body, slots: [...body.slots].reverse() })]) {
    assert.throws(() => verifyHeaderMac(parseHeader(JSON.stringify({ ...outer, body: b })), v.dk), { code: 'BAD_MAC' });
  }
  // a changed hseq still opens the slot, then the unlock fails on the MAC
  await assert.rejects(unlockWithPassphrase(parseHeader(text({}, { ...body, hseq: 2 })), v.passphrase), { code: 'BAD_MAC' });
  await assert.rejects(unlockWithPaperCode(parseHeader(text({}, { ...body, hseq: 99 })), v.paperCode), { code: 'BAD_MAC' });
});

test('the MAC itself: any flipped byte, or the wrong data key, fails', () => {
  const mac = Buffer.from(outer.mac, 'base64url');
  for (let i = 0; i < 32; i++) {
    const m = Buffer.from(mac);
    m[i] ^= 0x80;
    assert.throws(() => verifyHeaderMac(parseHeader(text({ mac: m.toString('base64url') })), v.dk), { code: 'BAD_MAC' });
  }
  assert.throws(() => verifyHeaderMac(parseHeader(v.text), Buffer.alloc(32, 1)), { code: 'BAD_MAC' });
});

test('bad JSON or schema is refused before any KDF runs', async () => {
  const s = body.slots;
  const [ps, rs] = s;
  const big = 'x'.repeat(130 * 1024);
  const cases = [
    'not json', '[]', '{}', 'null', '"text"', big,
    text({ extra: 1 }), JSON.stringify({ stickhubVault: 1, body: outer.body }), text({ stickhubVault: '1' }), text({ stickhubVault: 0 }),
    text({ body: 42 }), text({ body: 'not json' }), text({ body: 'x'.repeat(65 * 1024) }),
    text({ mac: outer.mac.slice(1) }), text({ mac: `${outer.mac}=` }),
    text({}, { ...body, extra: 1 }), text({}, { vault: body.vault, epoch: 1, hseq: 1 }),
    text({}, { ...body, vault: body.vault.slice(2) }), text({}, { ...body, epoch: 0 }), text({}, { ...body, epoch: 1.5 }),
    text({}, { ...body, epoch: '1' }), text({}, { ...body, hseq: -1 }), text({}, { ...body, hseq: 2 ** 32 }),
    text({}, { ...body, slots: [] }), text({}, { ...body, slots: {} }), text({}, { ...body, slots: Array(11).fill(ps) }),
    text({}, { ...body, slots: [ps, { ...ps, id: rs.id }] }), // two passphrase slots
    text({}, { ...body, slots: [ps, { ...rs, id: ps.id }] }), // the same id twice
    text({}, { ...body, slots: [{ ...ps, type: 'fingerprint' }, rs] }),
    text({}, { ...body, slots: [{ ...ps, kdf: { ...ps.kdf, m: 2 * 1024 * 1024 } }, rs] }), // 2 GiB
    text({}, { ...body, slots: [{ ...ps, kdf: { ...ps.kdf, t: 1000 } }, rs] }),
    text({}, { ...body, slots: [{ ...ps, kdf: { alg: 'scrypt', N: 2 ** 22, r: 8, p: 1, salt: ps.kdf.salt } }, rs] }),
    text({}, { ...body, slots: [{ ...ps, nonce: undefined }, rs] }),
    text({}, { ...body, slots: [ps, { ...rs, salt: `${rs.salt.slice(0, -1)}+` }] }),
  ];
  const calls = await countKdfCalls(async () => {
    for (const c of cases) {
      await assert.rejects(async () => unlockWithPassphrase(parseHeader(c), v.passphrase), { code: /^(BAD_HEADER|UNSUPPORTED)$/ }, c.slice(0, 80));
    }
  });
  assert.equal(calls, 0, 'no KDF ran for any of them');
});

test('a header from a newer StickHub says so', () => {
  assert.throws(() => parseHeader(text({ stickhubVault: 2 })), { code: 'UNSUPPORTED' });
});

test('a v2 header with device slots still parses and opens with the passphrase', async () => {
  const device = { id: Buffer.alloc(16, 5).toString('base64url'), type: 'device', sign: 'SHA256withRSA',
    challenge: Buffer.alloc(32, 1).toString('base64url'), salt: Buffer.alloc(32, 2).toString('base64url'),
    nonce: Buffer.alloc(12, 3).toString('base64url'), wrapped: Buffer.alloc(48, 4).toString('base64url') };
  const t = buildHeader({ vaultId: v.vaultId, epoch: 1, hseq: 2, slots: [v.ps, device, v.rs] }, v.dk);
  const h = parseHeader(t);
  assert.equal(h.slots.length, 3);
  assert.deepEqual(await unlockWithPassphrase(h, v.passphrase), v.dk);
});

test('buildHeader refuses a broken header instead of writing it', () => {
  assert.throws(() => buildHeader({ vaultId: v.vaultId, epoch: 1, hseq: 1, slots: [v.ps, v.ps] }, v.dk), { code: 'BAD_INPUT' });
  assert.throws(() => buildHeader({ vaultId: v.vaultId, epoch: 0, hseq: 1, slots: [v.ps] }, v.dk), { code: 'BAD_INPUT' });
  assert.throws(() => buildHeader({ vaultId: Buffer.alloc(8), epoch: 1, hseq: 1, slots: [v.ps] }, v.dk), { code: 'BAD_INPUT' });
  assert.throws(() => buildHeader({ vaultId: v.vaultId, epoch: 1, hseq: 1, slots: [v.ps] }, Buffer.alloc(16)), { code: 'BAD_INPUT' });
});

test('a header without a recovery slot says so', async () => {
  const h = parseHeader(buildHeader({ vaultId: v.vaultId, epoch: 1, hseq: 1, slots: [v.ps] }, v.dk));
  await assert.rejects(unlockWithPaperCode(h, v.paperCode), { code: 'WRONG_SECRET' });
});
