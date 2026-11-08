// `vault setup|status|lock` (hub/cli-setup.mjs, hub/cli-vault.mjs). TEST ONLY KDF settings; temp folders only; the
// running hub is faked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultCommand } from '../hub/cli-vault.mjs';
import { openVaultFolder } from '../hub/vault/store.mjs';
import { unlockWithPaperCode, unlockWithPassphrase } from '../hub/vault/header.mjs';
import { SMALL_KDF } from './vault-helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'vsetup-')); roots.push(d); return d; };

function tty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

/**
 * Run a vault command on a fake terminal. answer(question, seen) returns what the person types (seen: what was shown).
 * @returns {Promise<{code, out, err, passphrase, paper}>}
 */
async function run(args, answer = () => '', o = {}) {
  const input = tty();
  const out = [];
  const err = [];
  const seen = { text: '' };
  const prompt = new Writable({ write(c, _e, cb) { // a question gets an answer; the newline after it does not
    const q = String(c);
    if (q.trim()) setImmediate(() => input.write(`${answer(q, seen) ?? ''}\r`));
    cb();
  } });
  const code = await vaultCommand(args, { input, prompt, outTTY: o.outTTY ?? true, kdf: SMALL_KDF, root: ROOT, home: o.home, mounts: async () => o.mounts || [],
    callHub: o.callHub || (async () => null), token: async () => 'TEST-token',
    out: (s) => { out.push(s); seen.text += `${s}\n`; }, err: (s) => err.push(s) });
  const text = out.join('\n');
  return { code, out: text, err: err.join('\n'), passphrase: /Passphrase: {2}(.+)/.exec(text)?.[1] ?? null, paper: /Paper code: {2}(.+)/.exec(text)?.[1] ?? null };
}

/** The right answers: the shown words, and the asked groups of the shown paper code. */
const right = (wrongFirst = 0) => {
  let n = 0;
  return (q, seen) => {
    if (n++ < wrongFirst) return 'TEST ONLY wrong';
    if (/Type the passphrase/.test(q)) return /Passphrase: {2}(.+)/.exec(seen.text)[1];
    const g = /Type group (\d) of the paper code/.exec(q);
    if (g) return /Paper code: {2}(.+)/.exec(seen.text)[1].split('-')[Number(g[1]) - 1].toLowerCase();
    return '';
  };
};

test('setup: 5 words and a paper code shown once, the words and two groups typed back; the vault opens with either', async () => {
  const home = join(tmp(), 'home');
  const r = await run(['setup'], right(1), { home });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.passphrase.split(' ').length, 5);
  assert.match(r.paper, /^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  assert.equal(r.out.split(r.passphrase).length, 2, 'the passphrase is shown exactly once');
  assert.equal(r.out.split(r.paper).length, 2, 'the paper code is shown exactly once');
  assert.match(r.err, /That is not it\. Try again\./);
  assert.match(r.out, /plain app data .* is not touched/);
  assert.match(r.out, /\u001b\[2J\u001b\[3J/, 'the screen is cleared after');
  const dir = join(home, 'vault-dev');
  await (await openVaultFolder(dir, (h) => unlockWithPassphrase(h, r.passphrase))).close();
  await (await openVaultFolder(dir, (h) => unlockWithPaperCode(h, r.paper))).close();
  for (const f of readdirSync(dir, { recursive: true })) {
    if (!f.includes('.')) continue;
    const text = readFileSync(join(dir, f), 'latin1');
    for (const w of [...r.passphrase.split(' ').filter((x) => x.length > 3), r.paper]) assert.ok(!text.includes(w), f);
  }
  const again = await run(['setup'], right(), { home });
  assert.deepEqual([again.code, /vault \(or other files\)/.test(again.err)], [1, true], 'a vault that exists is never touched');
});

test('setup --own: at least 20 characters, typed twice; a wrong paper code group writes nothing', async () => {
  const home = join(tmp(), 'home');
  const own = 'TEST ONLY my own long passphrase';
  const answers = ['too short', own, 'not the same', own, own];
  let i = 0;
  const r = await run(['setup', '--own'], (q, seen) => (/Your passphrase|The same again/.test(q) ? answers[i++] : right()(q, seen)), { home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /at least 20/);
  assert.match(r.err, /not the same/);
  assert.equal(r.passphrase, null, 'your own passphrase is never shown');
  await (await openVaultFolder(join(home, 'vault-dev'), (h) => unlockWithPassphrase(h, own))).close();
  const home2 = join(tmp(), 'home');
  const bad = await run(['setup'], (q, seen) => (/group/.test(q) ? 'ZZZZ' : right()(q, seen)), { home: home2 });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Nothing was created/);
  assert.equal(existsSync(join(home2, 'vault-dev')), false);
});

test('setup refuses a pipe, a vault folder inside the clone or on a stick, and unknown options', async () => {
  const base = tmp();
  assert.match((await run(['setup'], right(), { home: join(base, 'a'), outTTY: false })).err, /run it in a terminal/);
  assert.match((await run(['setup'], right(), { home: join(ROOT, 'data', 'x') })).err, /inside the StickHub folder/);
  assert.match((await run(['setup'], right(), { home: join(base, 'stick', 'h'), mounts: [join(base, 'stick')] })).err, /on a stick/);
  assert.equal((await run(['setup', '--nope'], right(), { home: join(base, 'b') })).code, 2);
});

test('status and lock: no vault, the hub not running, the hub answering; wrong tries from the file', async () => {
  const home = join(tmp(), 'home');
  assert.match((await run(['status'], undefined, { home })).out, /No vault in .*vault setup/);
  assert.match((await run(['lock'], undefined, { home })).out, /There is no vault/);
  mkdirSync(join(home, 'vault-dev'), { recursive: true });
  writeFileSync(join(home, 'vault-dev', 'vault.json'), '{}');
  mkdirSync(join(home, 'vault'), { recursive: true });
  writeFileSync(join(home, 'vault', 'attempts.json'), JSON.stringify({ failures: 7, last: Date.now() }));
  const off = await run(['status'], undefined, { home });
  assert.match(off.out, /State: locked \(the hub is not running\)/);
  assert.match(off.out, /Wrong tries since the last good one: 7; the next try waits \d+ s/);
  assert.match((await run(['lock'], undefined, { home })).out, /not running: the vault is locked/);
  const calls = [];
  const callHub = async (path, o) => {
    calls.push([path, o.method || 'GET', o.token]);
    return path === '/api/vault' ? { status: 200, body: { state: 'unlocked', autoLockSeconds: 300, lastLock: null } } : { status: 200, body: { state: 'locked' } };
  };
  assert.match((await run(['status'], undefined, { home, callHub })).out, /State: open\nAuto-lock: after 300 s/);
  assert.match((await run(['lock'], undefined, { home, callHub })).out, /Locked: the apps stopped/);
  assert.deepEqual(calls, [['/api/vault', 'GET', 'TEST-token'], ['/api/vault/lock', 'POST', 'TEST-token']]);
});
