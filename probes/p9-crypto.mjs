// Probe 9, part A: which Argon2id / scrypt / HKDF / AEAD functions this Node really has, and how fast they are here.
// Every function is checked against the published test vector (RFC 9106, 7914, 5869, 8439, GCM spec), so "ok" means
// "gives the right answer", not only "exists". Uses fixed test inputs and random throwaway data: no secrets.

import * as crypto from 'node:crypto';
import { mbps } from './lib.mjs';

const hex = (h) => Buffer.from(h, 'hex');
const SEG = 64 * 1024; // the vault design encrypts in 64 KiB segments
const SLOW_MS = 8000; // stop a timing series after the first run slower than this

/** Encrypt a known vector, compare with the published answer, then check that a changed byte is refused. */
function aeadKat(alg, key, iv, pt, aad, ctPrefix, tag) {
  const enc = crypto.createCipheriv(alg, key, iv, { authTagLength: 16 });
  if (aad) enc.setAAD(aad);
  const ct = Buffer.concat([enc.update(pt), enc.final()]);
  const t = enc.getAuthTag();
  if (!ct.subarray(0, ctPrefix.length / 2).equals(hex(ctPrefix)) || !t.equals(hex(tag))) return 'WRONG answer';
  return roundTrip(alg, key, iv, pt, aad, ct, t);
}

/** Decrypt must give pt back; with one flipped bit it must throw. */
function roundTrip(alg, key, iv, pt, aad, ct, tag) {
  const open = (c) => {
    const d = crypto.createDecipheriv(alg, key, iv, { authTagLength: 16 });
    if (aad) d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(c), d.final()]);
  };
  if (!open(ct).equals(pt)) return 'WRONG round trip';
  const bad = Buffer.from(ct);
  bad[0] ^= 1;
  try { open(bad); return 'TAMPERING NOT DETECTED'; } catch { return 'ok'; } // a throw here is the expected result
}

const KATS = {
  'argon2id (RFC 9106 5.3)': () => {
    if (typeof crypto.argon2Sync !== 'function') return 'missing';
    const k = crypto.argon2Sync('argon2id', { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4), parallelism: 4, tagLength: 32, memory: 32, passes: 3 });
    return k.equals(hex('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')) ? 'ok' : 'WRONG answer';
  },
  'scrypt (RFC 7914)': () => {
    const k = crypto.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 });
    return k.equals(hex('fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640')) ? 'ok' : 'WRONG answer';
  },
  'hkdf-sha256 (RFC 5869 A.1)': () => {
    const k = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(22, 0x0b), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42));
    return k.equals(hex('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')) ? 'ok' : 'WRONG answer';
  },
  'aes-256-gcm (GCM spec test 14)': () => aeadKat('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16), null,
    'cea7403d4d606b6e074ec5d3baf39d18', 'd0d1c8a799996bf0265b98b5d48ab919'),
  'chacha20-poly1305 (RFC 8439 2.8.2)': () => aeadKat('chacha20-poly1305',
    hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'), hex('070000004041424344454647'),
    Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."),
    hex('50515253c0c1c2c3c4c5c6c7'), 'd31a8d34648e60db7b86afbc53ef7ec2', '1ae10b594f09e26a7e902ecbd0600691'),
  'aes-256-gcm-siv (round trip only)': () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const pt = crypto.randomBytes(100);
    const enc = crypto.createCipheriv('aes-256-gcm-siv', key, iv);
    const ct = Buffer.concat([enc.update(pt), enc.final()]);
    return roundTrip('aes-256-gcm-siv', key, iv, pt, null, ct, enc.getAuthTag());
  },
};

const argon2 = (p) => new Promise((resolve, reject) => crypto.argon2('argon2id', p, (e, k) => (e ? reject(e) : resolve(k))));
const scrypt = (n) => new Promise((resolve, reject) => crypto.scrypt('probe', crypto.randomBytes(16), 32,
  { N: 2 ** n, r: 8, p: 1, maxmem: 600 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
const ms = (t) => Math.round(performance.now() - t);

/** Encrypt 32 MiB in 64 KiB segments, one cipher object per segment (as the vault would). */
function aeadSpeed(alg) {
  const key = crypto.randomBytes(32);
  const seg = crypto.randomBytes(SEG);
  const n = 512;
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(i, 8);
    const c = crypto.createCipheriv(alg, key, iv, { authTagLength: 16 });
    c.update(seg);
    c.final();
    c.getAuthTag();
  }
  return `${mbps(n * SEG, performance.now() - t)} MB/s`;
}

/** Run a timing series; stop after the first run slower than SLOW_MS. */
async function series(r, label, items, fn) {
  for (const it of items) {
    const t = performance.now();
    try {
      await fn(it);
      const took = ms(t);
      r.add(`${label} ${it.name}`, `${took} ms, peak memory so far ${peakMb()} MB`);
      if (took > SLOW_MS) { r.add(`${label}`, 'stopped: too slow for bigger settings'); return; }
    } catch (e) {
      r.add(`${label} ${it.name}`, `failed: ${e.code || e.message}`);
      return;
    }
  }
}

/**
 * Part A: Node's crypto on this phone.
 * @param {import('./lib.mjs').Report} r
 * @param {object} ans  filled in for the summary
 */
export async function runCrypto(r, ans) {
  r.add('node', `${process.version}, OpenSSL ${process.versions.openssl}`);
  const fns = ['argon2', 'argon2Sync', 'scrypt', 'scryptSync', 'hkdf', 'hkdfSync', 'createCipheriv', 'timingSafeEqual', 'randomBytes'];
  r.add('functions', fns.map((f) => `${f} ${typeof crypto[f] === 'function' ? 'yes' : 'NO'}`).join(', '));
  r.add('webcrypto.subtle', crypto.webcrypto?.subtle ? 'yes' : 'NO');
  for (const [name, check] of Object.entries(KATS)) {
    let res;
    try { res = check(); } catch (e) { res = `error: ${e.code || e.message}`; }
    r.add(name, res);
    ans[name.split(' ')[0]] = res;
  }

  if (ans.argon2id === 'ok') {
    const sets = [[19456, 2, 1], [65536, 3, 1], [65536, 3, 2], [65536, 3, 4], [131072, 3, 4], [262144, 3, 4]]
      .map(([m, t, p]) => ({ name: `m=${m / 1024} MiB t=${t} p=${p}`, m, t, p }));
    await series(r, 'argon2id', sets, (s) => argon2({ message: Buffer.from('probe passphrase'), nonce: crypto.randomBytes(16),
      parallelism: s.p, tagLength: 32, memory: s.m, passes: s.t }));
  }
  await series(r, 'scrypt', [15, 16, 17].map((n) => ({ name: `N=2^${n} r=8 p=1 (${2 ** n * 1024 / 1048576} MiB)`, n })), (s) => scrypt(s.n));

  for (const alg of ['aes-256-gcm', 'chacha20-poly1305']) {
    try { r.add(`${alg} speed`, aeadSpeed(alg)); } catch (e) { r.add(`${alg} speed`, `failed: ${e.code || e.message}`); }
  }
  const big = crypto.randomBytes(32 << 20);
  let t = performance.now();
  crypto.createHash('sha256').update(big).digest();
  r.add('sha256 speed', `${mbps(big.length, performance.now() - t)} MB/s`);
  t = performance.now();
  for (let i = 0; i < 1000; i++) crypto.hkdfSync('sha256', big.subarray(0, 32), big.subarray(32, 48), 'probe', 32);
  r.add('hkdf-sha256', `${Math.round((performance.now() - t) * 10) / 10} us each`); // 1000 runs: total ms = us each
}
