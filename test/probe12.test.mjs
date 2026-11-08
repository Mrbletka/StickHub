// Probe 12 off the phone: the vault cost part on temp folders (small numbers), and the browser part with a fake
// browser that reports what a real Chrome page would. TEST ONLY: throwaway vaults, temp folders.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Report } from '../probes/lib.mjs';
import { measureVault, measurePlain } from '../probes/p12-vault.mjs';
import { browserCheck } from '../probes/p12-browser.mjs';
import { http } from './helpers.mjs';

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'p12t-')); roots.push(d); return d; };
const text = (r) => r.toString();

test('probe 12 vault part: readdir, parallel reads, Notebook save and its event; leaves nothing behind', async () => {
  const r = new Report();
  const base = tmp();
  await measureVault(r, 'phone', base, join(tmp(), 'run'), { notes: 30, reads: 40, saves: 3, runs: 2 });
  await measurePlain(r, 'phone', base, { notes: 30, runs: 2 });
  const out = text(r);
  assert.match(out, /readdir of a folder with 30 notes \(one request, depth 1\):\s+p50 [\d.]+ ms.*; 31 names/);
  assert.match(out, /40 notes read at once:\s+\d+ ms in all, none failed/);
  assert.match(out, /Notebook save -> its change event/);
  assert.doesNotMatch(out, /5000 ms|FAILED|PROBLEMS/);
  assert.match(out, /verify \(full\):\s+OK/);
  assert.deepEqual(readdirSync(base), [], 'the probe removed its folders');
});

/** A fake browser: loads the page, finds the app address, reports like the page's frames would. */
function fakeBrowser(cleared) {
  return async (url) => {
    const page = (await http(Number(new URL(url).port), '/')).body;
    const app = /src="(http:\/\/127\.0\.0\.1:\d+\/)frame\?mode=set"/.exec(page)[1];
    const port = Number(new URL(app).port);
    const value = /localStorage\.setItem\('p12', "([^"]+)"\)/.exec((await http(port, '/frame?mode=set')).body)[1];
    const report = (stage, v) => http(port, `/report?stage=${stage}&v=${encodeURIComponent(JSON.stringify(v))}`);
    assert.equal((await http(port, '/__hub/clear')).headers['clear-site-data'], '"storage"', 'the app side is hubRoutes');
    setTimeout(async () => { await report('set', value); await report('before', value); await report('after', cleared ? null : value); }, 50);
    return { ok: true };
  };
}

test('probe 12 browser part: YES when the value is gone, NO when it stays, NO ANSWER without a tap', async () => {
  const yes = new Report();
  await browserCheck(yes, { open: fakeBrowser(true), say: () => {} });
  assert.match(text(yes), /Clear-Site-Data honoured \(localStorage gone after the hidden frame\):\s+YES/);
  assert.match(text(yes), /stored a value \(control\):\s+yes/);
  const no = new Report();
  await browserCheck(no, { open: fakeBrowser(false), say: () => {} });
  assert.match(text(no), /Clear-Site-Data honoured .*:\s+NO \(still/);
  const none = new Report();
  await browserCheck(none, { open: async () => ({ ok: true }), waitMs: 300, say: () => {} });
  assert.match(text(none), /NO ANSWER/);
  const fail = new Report();
  await browserCheck(fail, { open: async () => ({ ok: false, error: 'not found' }), say: () => {} });
  assert.match(text(fail), /could not open it/);
});
