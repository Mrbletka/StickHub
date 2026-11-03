// Shared helpers for the phone probes. Node built-ins only.
// Probes measure the real phone; they never change anything outside their own temp folders.

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, statSync, accessSync, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

/**
 * Run a command with an argument array (never a shell) and a hard timeout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeout?: number, input?: string}} [opts]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, ms: number, error?: string}>}
 */
export function run(cmd, args = [], opts = {}) {
  const timeout = opts.timeout ?? 10_000;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const ms = performance.now() - t0;
      if (err) {
        const why = err.killed ? `timeout after ${timeout} ms` : (err.code ?? err.message);
        resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, stdout, stderr, ms, error: String(why) });
      } else {
        resolve({ ok: true, code: 0, stdout, stderr, ms });
      }
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * True if an executable with this name is on PATH (checked without spawning anything).
 * @param {string} name
 */
export function hasCmd(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { /* not in this dir: keep looking */ }
  }
  return false;
}

/**
 * CPU time (ms) used by this process's finished children, from /proc/self/stat (cutime + cstime).
 * Assumes 100 clock ticks per second, which is the Linux/Android default. Returns null if unreadable.
 */
export function childCpuMs() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    // Fields after the ")" of the command name; cutime and cstime are fields 16 and 17 (1-based).
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(rest[13]) + Number(rest[14])) * 10;
  } catch (e) {
    return null;
  }
}

/**
 * Parse /proc/self/mountinfo text into mount entries.
 * @param {string} text
 * @returns {{mountPoint: string, root: string, fsType: string, source: string, mountOpts: string, superOpts: string}[]}
 */
export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const l = left.split(' ');
    const r = right.split(' ');
    out.push({ root: unescapeMount(l[3]), mountPoint: unescapeMount(l[4]), mountOpts: l[5] || '',
      fsType: r[0] || '', source: r[1] || '', superOpts: r[2] || '' });
  }
  return out;
}

// mountinfo escapes space, tab, newline and backslash as octal (\040 ...).
function unescapeMount(s = '') {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * Mounts that look like removable volumes: /storage/<id> or /mnt/media_rw/<id>, not the internal "emulated" one.
 * @returns {{mounts: ReturnType<typeof parseMountinfo>, error?: string}}
 */
export function volumeMounts() {
  try {
    const all = parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'));
    const mounts = all.filter((m) => /^\/(storage|mnt\/media_rw|mnt\/user\/\d+)\/[^/]+$/.test(m.mountPoint)
      && !/\/(emulated|self|pass_through|default|read|write|full|installer|androidwritable)$/.test(m.mountPoint));
    return { mounts };
  } catch (e) {
    return { mounts: [], error: e.code || e.message };
  }
}

/**
 * The volume root for a path on a removable volume: /storage/ABCD-1234/Android/data/x -> /storage/ABCD-1234.
 * Returns null for internal storage or unknown shapes.
 * @param {string} p
 */
export function volumeRoot(p) {
  const m = /^(\/storage\/[^/]+)(\/|$)/.exec(p || '');
  if (!m || m[1] === '/storage/emulated' || m[1] === '/storage/self') return null;
  return m[1];
}

/**
 * The ~/storage/external-* links, their targets, and whether each target is reachable now.
 * @returns {{name: string, target: string|null, reachable: boolean, error?: string}[]}
 */
export function storageLinks() {
  const dir = join(homedir(), 'storage');
  let names;
  try { names = readdirSync(dir).filter((n) => n.startsWith('external')).sort(); } catch (e) {
    return [{ name: '~/storage', target: null, reachable: false, error: e.code || e.message }];
  }
  return names.map((name) => {
    let target = null;
    try { target = readlinkSync(join(dir, name)); } catch (e) {
      return { name, target, reachable: false, error: e.code || e.message };
    }
    try { statSync(target); return { name, target, reachable: true }; } catch (e) {
      return { name, target, reachable: false, error: e.code || e.message };
    }
  });
}

/** Short fingerprint of the links, to see when they change. */
export function linksKey(links = storageLinks()) {
  return links.map((l) => `${l.name}=${l.target}:${l.reachable ? 'ok' : 'gone'}`).join(' ');
}

/**
 * Ask a question on the terminal. Returns '' at once when stdin is not a terminal.
 * @param {string} question
 */
export async function ask(question) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(`\n>>> ${question} `, (a) => resolve(a.trim().toLowerCase())));
  } finally {
    rl.close();
  }
}

/** Wait ms milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll check() every stepMs until it returns a truthy value or limitMs passes.
 * @returns {Promise<{value: any, ms: number}>} value is null on timeout
 */
export async function waitFor(check, limitMs, stepMs = 500) {
  const t0 = performance.now();
  for (;;) {
    const value = await check();
    const ms = performance.now() - t0;
    if (value) return { value, ms };
    if (ms >= limitMs) return { value: null, ms };
    await sleep(stepMs);
  }
}

/** min / median / max of numbers, rounded. */
export function stats(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return { n: 0, min: 0, med: 0, max: 0 };
  const r = (x) => Math.round(x * 10) / 10;
  return { n: s.length, min: r(s[0]), med: r(s[Math.floor(s.length / 2)]), max: r(s[s.length - 1]) };
}

/** Megabytes per second, one decimal. */
export const mbps = (bytes, ms) => (ms > 0 ? Math.round((bytes / 1048576) / (ms / 1000) * 10) / 10 : 0);

/** Collects report lines and echoes them live. */
export class Report {
  constructor() { this.lines = []; }
  /** Start a section. */
  section(title) { this.add(''); this.add(`## ${title}`); }
  /** Add a "key: value" line (or a plain line if value is undefined). */
  add(key, value) {
    const line = value === undefined ? String(key) : `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    this.lines.push(line);
    console.log(line);
  }
  toString() { return this.lines.join('\n') + '\n'; }
}
