// Probe 9: inputs for the encrypted vault (docs/VAULT-DESIGN.md).
// Part A (p9-crypto.mjs): which Argon2id / scrypt / HKDF / AEAD functions Node really has here, and how fast.
// Part B (here): termux-keystore, the Android Keystore through Termux:API.
//   - Does termux-keystore exist, and does the Termux:API app answer?
//   - Can it make a key that needs the fingerprint (or the pattern)?
//   - Does an RSA signature of a fixed challenge always come out the same (so it can feed a key derivation)?
//   - Is the auth asked on every use, or only for N seconds after an unlock? Does termux-fingerprint open that window?
// Safety: prints only sha256 prefixes of signatures, never a signature or key material, and no key names but its own.
// Its test keys are named stickhub-p9-*: deleted at the end, and leftovers of an interrupted run are deleted at the start.

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, hasCmd, ask, sleep } from './lib.mjs';
import { runCrypto } from './p9-crypto.mjs';

const PREFIX = 'stickhub-p9-';
const VALID_S = 15; // auth window of the test key (-u)
const WAIT_S = VALID_S + 4; // wait this long so the last unlock is outside the window
const CH1 = createHash('sha256').update('StickHub probe 9 challenge 1').digest();
const CH2 = createHash('sha256').update('StickHub probe 9 challenge 2').digest();
const ks = (args, o = {}) => run('termux-keystore', args, { timeout: 30_000, ...o });
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const digest = (b) => createHash('sha256').update(b).digest('hex');
const isSig = (s) => s?.out.kind === 'sig';

/** Hide anything long enough to be a key or a signature, flatten whitespace, keep it short. */
export function redact(text) {
  return String(text).replace(/[A-Za-z0-9+/=_-]{32,}/g, '<long token hidden>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * What did `termux-keystore sign` print? The bytes themselves are never meant for the report:
 * print only kind, enc, bytes, id (a 12-hex sha256 prefix) or text (an error message, redacted).
 * @param {Buffer} out
 * @returns {{kind: 'empty'} | {kind: 'text', text: string}
 *   | {kind: 'sig'|'unknown', enc?: 'base64'|'raw', bytes: number, raw: Buffer, digest: string, id: string}}
 *   raw and digest are for comparing and verifying only
 */
export function classifyOutput(out) {
  const s = out.toString('latin1');
  const t = s.trim();
  if (!t) return { kind: 'empty' };
  const printable = /^[\t\n\r\x20-\x7e]*$/.test(s);
  const pack = (kind, enc, raw) => { const d = digest(raw); return { kind, enc, bytes: raw.length, raw, digest: d, id: d.slice(0, 12) }; };
  if (printable && t.length >= 64 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return pack('sig', 'base64', Buffer.from(t, 'base64'));
  if (printable && /\s/.test(t)) return { kind: 'text', text: redact(t) };
  if (!printable) return pack('sig', 'raw', out);
  return pack('unknown', undefined, out);
}

/** One line for the report: never the signature itself. */
export function fmt(s) {
  const o = s.out;
  const why = s.err ? ` stderr "${s.err}"` : '';
  if (o.kind === 'sig') return `ok: signature (${o.enc}, ${o.bytes} bytes) sha256 ${o.id}..., ${secs(s.ms)}`;
  if (o.kind === 'text') return `refused (${s.code}): "${o.text}"${why}, ${secs(s.ms)}`;
  if (o.kind === 'empty') return `no output (${s.code})${why}, ${secs(s.ms)}`;
  return `unknown output (${o.bytes} bytes, sha256 ${o.id}...)${why}, ${secs(s.ms)}`;
}

async function sign(alias, alg, msg) {
  const res = await ks(['sign', alias, alg], { input: msg, encoding: 'buffer', timeout: 45_000 });
  const e = classifyOutput(res.stderr || Buffer.alloc(0));
  return { ms: res.ms, code: res.ok ? 'exit 0' : res.error, out: classifyOutput(res.stdout || Buffer.alloc(0)),
    printed: res.stdout, err: e.kind === 'text' ? e.text : e.kind === 'empty' ? '' : `${e.bytes} bytes, not text` };
}

/** Check a signature with termux-keystore verify (the file is private and removed at once). */
async function verify(alias, alg, msg, s) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), PREFIX));
  try {
    const tryFile = async (bytes) => {
      const f = join(dir, 'sig');
      writeFileSync(f, bytes, { mode: 0o600 });
      return redact((await ks(['verify', alias, alg, f], { input: msg })).stdout);
    };
    const asPrinted = await tryFile(s.printed);
    if (asPrinted === 'true') return 'true (file as sign printed it)';
    if (s.out.enc === 'base64' && (await tryFile(s.out.raw)) === 'true') return 'true (file with the decoded bytes)';
    return `not verified (answer: ${asPrinted || 'none'})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function generate(alias, extra) {
  const res = await ks(['generate', alias, ...extra], { timeout: 90_000 });
  const note = redact(`${res.stdout}${res.stderr}`);
  return { ok: res.ok, ms: res.ms, why: note || res.error || '' };
}

const aliasOf = (k) => (typeof k === 'string' ? k : k?.alias);

async function listKeys(detail) {
  const res = await ks(detail ? ['list', '-d'] : ['list']);
  if (!res.ok) return { error: res.error || 'failed', ms: res.ms };
  try {
    const j = JSON.parse(res.stdout);
    return { keys: Array.isArray(j) ? j : [], ms: res.ms };
  } catch {
    return { error: `not JSON: ${redact(res.stdout)}`, ms: res.ms };
  }
}

/** The key's parameters (algorithm, size, auth settings, secure hardware), long values hidden. */
async function detail(alias) {
  const l = await listKeys(true);
  if (l.error) return `list -d failed: ${l.error}`;
  const k = l.keys.find((x) => aliasOf(x) === alias);
  if (!k) return 'key not in the list';
  if (typeof k === 'string') return 'no details';
  const { alias: _a, ...rest } = k;
  return JSON.stringify(rest, (key, v) => (typeof v === 'string' && v.length > 48 ? `<${v.length} chars hidden>` : v));
}

async function fingerprint() {
  const res = await run('termux-fingerprint', [], { timeout: 60_000 });
  let j = null;
  try { j = JSON.parse(res.stdout); } catch { j = null; } // not JSON: reported as text below
  if (!j) return { ok: false, text: `no answer (${res.error || redact(res.stdout) || 'empty'}), ${secs(res.ms)}` };
  const errs = Array.isArray(j.errors) && j.errors.length ? `, errors: ${redact(j.errors.join(' '))}` : '';
  return { ok: j.auth_result === 'AUTH_RESULT_SUCCESS', text: `${j.auth_result}, failed attempts ${j.failed_attempts ?? '?'}${errs}, ${secs(res.ms)}` };
}

function usage(res) {
  const lines = `${res.stdout}${res.stderr}`.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 40);
  return lines.length ? `\n    ${lines.join('\n    ')}` : `(nothing printed, ${res.error || 'exit 0'})`;
}

async function wait(s, why) {
  console.log(`\n... waiting ${s} s (${why}). Do not lock or unlock the phone.`);
  for (let left = s; left > 0; left -= 5) {
    await sleep(Math.min(5, left) * 1000);
    if (left > 5) console.log(`    ${left - 5} s left`);
  }
}

/** Keys with no auth: does it work at all, is RSA deterministic, is ECDSA (expected: not). */
async function plainKeys(r, ans, alias) {
  const g = await generate(alias.rsa, ['-a', 'RSA', '-s', '2048']);
  r.add('RSA-2048 key, no auth: generate', g.ok ? `ok, ${secs(g.ms)}` : `FAILED: ${g.why}`);
  if (!g.ok) { ans.deterministic = 'unknown (could not make a key)'; return; }
  r.add('  details', await detail(alias.rsa));
  const s1 = await sign(alias.rsa, 'SHA256withRSA', CH1);
  const s2 = await sign(alias.rsa, 'SHA256withRSA', CH1);
  const s3 = await sign(alias.rsa, 'SHA256withRSA', CH2);
  r.add('  sign challenge 1', fmt(s1));
  r.add('  sign challenge 1 again', fmt(s2));
  r.add('  sign challenge 2', fmt(s3));
  ans.deterministic = ![s1, s2, s3].every(isSig) ? 'unknown (sign gave no signatures)'
    : s1.out.digest === s2.out.digest && s1.out.digest !== s3.out.digest ? 'yes (SHA256withRSA)' : 'NO';
  r.add('  same input -> same signature', ans.deterministic);
  if (isSig(s1)) r.add('  verify', await verify(alias.rsa, 'SHA256withRSA', CH1, s1));

  const e = await generate(alias.ec, ['-a', 'EC', '-s', '256']);
  if (!e.ok) { r.add('EC-256 key: generate', `failed: ${e.why}`); return; }
  const e1 = await sign(alias.ec, 'SHA256withECDSA', CH1);
  const e2 = await sign(alias.ec, 'SHA256withECDSA', CH1);
  r.add('EC-256 key, no auth: sign challenge 1', fmt(e1));
  r.add('  same input -> same signature', isSig(e1) && isSig(e2)
    ? (e1.out.digest === e2.out.digest ? 'yes' : 'no (expected: ECDSA is random, so EC keys cannot feed a key derivation)')
    : `unknown: ${fmt(e2)}`);
}

/** A key that needs the user: when does it sign, and what opens it? Needs Fabian at the phone. */
async function authKey(r, ans, alias) {
  r.add('');
  const g = await generate(alias, ['-a', 'RSA', '-s', '2048', '-u', String(VALID_S)]);
  r.add(`RSA-2048 key with -u ${VALID_S} (needs an unlock): generate`, g.ok ? `ok, ${secs(g.ms)}` : `FAILED: ${g.why}`);
  if (!g.ok) { ans.authKey = `cannot make one: ${g.why}`; return; }
  r.add('  details', await detail(alias));
  console.log('\nBelow, "fingerprint box" = the system window that asks for your finger (or pattern).'
    + '\nIf one ever pops up by itself, use it and say so at the next question.');
  const signs = [];
  const step = async (label) => {
    const s = await sign(alias, 'SHA256withRSA', CH1);
    signs.push(s);
    r.add(`  ${label}`, fmt(s));
    return s;
  };

  await wait(WAIT_S, `so your last unlock is older than ${VALID_S} s`);
  const a0 = await step(`${WAIT_S} s after the last unlock`);
  await ask('Lock the phone (power button). Unlock it with your FINGERPRINT, come back here and press Enter at once.');
  const a1 = await step('right after a fingerprint unlock');
  await step('again at once');
  const prompted = await ask('After your Enter it signed twice. Did a fingerprint box pop up during that? (y/n)');
  r.add('  fingerprint box while signing', prompted || '(no answer)');
  await wait(WAIT_S, 'the window should close');
  const a3 = await step(`${WAIT_S} s later, no unlock`);

  if (hasCmd('termux-fingerprint')) {
    await ask('Press Enter: a fingerprint box opens here. Touch the sensor.');
    const f = await fingerprint();
    r.add('  termux-fingerprint', f.text);
    const a4 = await step('sign right after termux-fingerprint');
    ans.fingerprintOpens = !f.ok ? 'unclear (the fingerprint was not accepted)'
      : isSig(a3) ? 'unclear (the window was still open)' : isSig(a4) ? 'yes' : 'no';
    r.add('  fingerprint box has a pattern button', await ask('In that fingerprint box, was there a button to use the pattern instead (e.g. "Use pattern")? (y/n)') || '(no answer)');
    await wait(WAIT_S, 'the window should close');
  }
  await ask('Lock the phone. Unlock it with the PATTERN (swipe up, draw it; not the finger), come back and press Enter at once.');
  const a5 = await step('right after a pattern unlock');
  ans.patternOpens = isSig(a5) ? 'yes' : 'no';

  if (hasCmd('termux-fingerprint')) {
    await wait(WAIT_S, 'the window should close');
    await ask('Press Enter, then switch to the StickHub app within 5 s and wait there. A fingerprint box will open: touch the sensor, then come back here.');
    await sleep(6000);
    const f = await fingerprint();
    r.add('  termux-fingerprint from the background', f.text);
    const a6 = await step('sign right after it');
    const where = await ask('Where did the fingerprint box show? s = on top of StickHub, a = it switched to the Termux:API app or Termux, n = no box');
    const after = await ask('After the touch, what was in front? s = StickHub, t = Termux or Termux:API, o = something else');
    r.add('  where the fingerprint box showed', where || '(no answer)');
    r.add('  in front after the touch', after || '(no answer)');
    ans.background = `box: ${where || '?'}, after the touch: ${after || '?'}, fingerprint ${f.ok ? 'ok' : 'not ok'}, sign ${isSig(a6) ? 'ok' : 'refused'}`;
  }

  const sigs = signs.filter(isSig);
  r.add('  same signature every time', sigs.length < 2 ? 'not enough signatures to tell'
    : sigs.every((s) => s.out.digest === sigs[0].out.digest) ? `yes (${sigs.length} signatures)` : 'NO');
  if (prompted === 'y') ans.window = 'asked on every use (a prompt showed while signing)';
  else if (isSig(a0) && isSig(a3)) ans.window = `NOT enforced: it signed ${WAIT_S} s after the last unlock`;
  else if (!isSig(a0) && isSig(a1) && !isSig(a3)) ans.window = `time window only: signs for ${VALID_S} s after an unlock, no prompt on use`;
  else ans.window = 'unclear: see the steps above';
  ans.authKey = !isSig(a0) && (isSig(a1) || isSig(a5)) ? 'yes: refuses until a fingerprint or pattern unlock'
    : isSig(a0) ? 'made, but it signs without a recent unlock' : 'made; unclear (see the steps)';
}

async function keystore(r, ans) {
  r.add('');
  if (!hasCmd('termux-keystore')) {
    r.add('termux-keystore', 'MISSING');
    ans.keystore = 'missing (pkg install termux-api, plus the Termux:API app)';
    return;
  }
  const pkg = await run('dpkg-query', ['-W', '-f=${Version}', 'termux-api'], { timeout: 10_000 });
  r.add('termux-api package', pkg.ok ? String(pkg.stdout).trim() : `version unknown (${pkg.error})`);
  r.add('termux-keystore usage', usage(await ks([], { timeout: 10_000 })));
  r.add('termux-fingerprint usage', hasCmd('termux-fingerprint') ? usage(await run('termux-fingerprint', ['-h'], { timeout: 10_000 })) : 'MISSING');

  const first = await listKeys(false);
  if (first.error) {
    r.add('Termux:API answers', `NO: ${first.error} after ${secs(first.ms)}`);
    ans.keystore = 'installed, but the Termux:API app does not answer';
    return;
  }
  r.add('Termux:API answers', `yes, "list" took ${secs(first.ms)}`);
  const left = first.keys.map(aliasOf).filter((a) => typeof a === 'string' && a.startsWith(PREFIX));
  r.add('keys already there', `${first.keys.length - left.length} (names not shown)`);
  for (const a of left) await ks(['delete', a]);
  if (left.length) r.add('test keys left by an earlier run', `${left.length}, deleted now`);
  ans.keystore = 'yes';

  const tag = randomBytes(3).toString('hex');
  const alias = { rsa: `${PREFIX}${tag}-rsa`, ec: `${PREFIX}${tag}-ec`, auth: `${PREFIX}${tag}-auth` };
  console.log('\n(If you stop this probe early, its next run deletes the test keys.)');
  try {
    await plainKeys(r, ans, alias);
    if (process.stdin.isTTY) await authKey(r, ans, alias.auth);
    else r.add('key that needs the fingerprint', 'skipped: needs you at the phone (no terminal)');
  } finally {
    for (const a of Object.values(alias)) await ks(['delete', a]); // a key that was never made just gives an error
    const after = await listKeys(false);
    const still = after.error ? null : after.keys.map(aliasOf).filter((a) => typeof a === 'string' && a.startsWith(PREFIX));
    r.add('test keys deleted', still === null ? `could not check (${after.error})` : still.length ? `NO, still there: ${still.join(', ')}` : 'yes');
  }
}

/** @param {import('./lib.mjs').Report} r */
export async function run9(r) {
  r.section('9. Keystore and crypto (vault design)');
  const ans = {};
  await runCrypto(r, ans);
  await keystore(r, ans);
  r.add('');
  r.add('answers');
  r.add('  termux-keystore exists', ans.keystore ?? 'not checked');
  r.add('  key that needs fingerprint or pattern', ans.authKey ?? 'not tested');
  r.add('  fixed challenge -> same RSA signature', ans.deterministic ?? 'not tested');
  r.add('  auth asked', ans.window ?? 'not tested');
  r.add('  termux-fingerprint opens the window', ans.fingerprintOpens ?? 'not tested');
  r.add('  pattern unlock opens the window', ans.patternOpens ?? 'not tested');
  r.add('  fingerprint box from the background', ans.background ?? 'not tested');
  r.add('  node', ['argon2id', 'scrypt', 'hkdf-sha256', 'aes-256-gcm', 'chacha20-poly1305', 'aes-256-gcm-siv']
    .map((k) => `${k} ${ans[k] ?? '?'}`).join(', '));
}
