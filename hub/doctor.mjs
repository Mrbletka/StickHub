// `node hub/cli.mjs doctor`: checks what StickHub needs on this device and says how to fix what is missing.
// Base for a setup guide for a new phone. Read-only: it changes nothing (except a tiny test file on the stick,
// removed at once, to see that the stick is writable).

import { access, readFile, stat, writeFile, rm, constants } from 'node:fs/promises';import { join } from 'node:path';
import { homedir } from 'node:os';
import { run } from './platform/run.mjs';
import { listVolumes } from './platform/termux.mjs';
import { findStick } from './stick.mjs';
import { createFsx } from './sync/fsx.mjs';
import { callHub, HUB_PORT } from './hubctl.mjs';
import { isPortFree } from './ports.mjs';
import { readToken } from './auth.mjs';
import { loadSettings } from './config.mjs';
import { runningWatcher } from './cli-watch.mjs';

const TERMUX_TOOLS = ['termux-open-url', 'termux-notification', 'termux-wake-lock', 'termux-clipboard-set', 'termux-toast'];

/**
 * @typedef {{name: string, state: 'ok'|'warn'|'fail'|'info', detail: string, fix?: string}} Result
 * @typedef {object} DoctorCtx  everything the checks touch (tests pass fakes)
 * @property {string} root  the clone
 * @property {string} home  ~/.stickhub
 * @property {string} userHome  the user's home folder
 * @property {object} env
 * @property {string} nodeVersion
 * @property {(cmd: string) => boolean} hasCmd
 * @property {typeof run} run
 * @property {typeof listVolumes} listVolumes
 * @property {(volumes: object[]) => Promise<object>} findStick
 * @property {(path: string, o?: object) => Promise<{status: number, body: any}|null>} callHub
 * @property {(port: number) => Promise<boolean>} isPortFree
 * @property {(home: string) => Promise<object|null>} runningWatcher
 */

/** The real device. */
export function realCtx(root, home) {
  const env = process.env;
  return {
    root, home, env, userHome: homedir(), nodeVersion: process.versions.node,
    hasCmd: (cmd) => (env.PATH || '').split(':').some((d) => d && existsSync(join(d, cmd))),
    run, listVolumes, findStick: (v) => findStick(v, createFsx()), callHub, isPortFree, runningWatcher,
  };
}

import { existsSync } from 'node:fs';

const ok = (name, detail) => ({ name, state: 'ok', detail });
const warn = (name, detail, fix) => ({ name, state: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, state: 'fail', detail, fix });
const info = (name, detail, fix) => ({ name, state: 'info', detail, ...(fix ? { fix } : {}) });
const isFile = async (p) => (await stat(p).catch(() => null))?.isFile() ?? false;

/** All checks, in the order a new phone would set them up. */
export const CHECKS = [
  async function node(c) {
    const major = Number(c.nodeVersion.split('.')[0]);
    return major >= 24 ? ok('Node', `v${c.nodeVersion}`)
      : warn('Node', `v${c.nodeVersion}; StickHub is made for Node 24`, c.env.TERMUX_VERSION ? 'pkg upgrade nodejs' : 'Install Node 24 from nodejs.org');
  },
  async function git(c) {
    const r = await c.run('git', ['--version'], { timeout: 5000 });
    if (!r.ok) return fail('git', 'not found', c.env.TERMUX_VERSION ? 'pkg install git' : 'Install git');
    const clone = await stat(join(c.root, '.git')).then(() => true, () => false);
    return clone ? ok('git', `${r.stdout.trim().replace('git version ', 'v')}, ${c.root} is a clone`)
      : warn('git', `${r.stdout.trim()}, but ${c.root} is not a git clone (code sync needs one)`,
        'cd ~ && git clone https://github.com/Mrbletka/StickHub StickHub');
  },
  async function termux(c) {
    return c.env.TERMUX_VERSION ? ok('Termux', `${c.env.TERMUX_VERSION}`) : info('Termux', 'not running in Termux (fine on a PC; the phone checks below are skipped)');
  },
  async function termuxApi(c) {
    if (!c.env.TERMUX_VERSION) return info('termux-api', 'skipped (not Termux)');
    const missing = TERMUX_TOOLS.filter((t) => !c.hasCmd(t));
    if (missing.length) return fail('termux-api', `missing: ${missing.join(', ')}`, 'pkg install termux-api');
    // The commands talk to the Termux:API app; without the app they hang, hence the timeout.
    const r = await c.run('termux-battery-status', [], { timeout: 8000 });
    return r.ok ? ok('termux-api', 'commands and the Termux:API app answer')
      : fail('termux-api', `the Termux:API app does not answer (${r.error})`, 'Install the Termux:API app from F-Droid (same source as Termux), open it once, then run doctor again');
  },
  async function storage(c) {
    if (!c.env.TERMUX_VERSION) return info('Storage permission', 'skipped (not Termux)');
    const shared = join(c.userHome, 'storage', 'shared');
    const can = await access(shared, constants.R_OK).then(() => true, () => false);
    return can ? ok('Storage permission', 'granted (~/storage/shared is readable)')
      : fail('Storage permission', 'not granted: Termux cannot reach the stick', 'termux-setup-storage   (once; tap Allow)');
  },
  async function widget(c) {
    if (!c.env.TERMUX_VERSION) return info('Widget shortcuts', 'skipped (not Termux)');
    const file = join(c.userHome, '.shortcuts', 'tasks', 'StickHub');
    if (!(await isFile(file))) {
      return warn('Widget shortcuts', 'no StickHub shortcut in ~/.shortcuts/tasks',
        'node hub/cli.mjs widget install, then long-press the home screen > Widgets > Termux:Widget > StickHub (needs the Termux:Widget app)');
    }
    const text = await readFile(file, 'utf8');
    const exec = await access(file, constants.X_OK).then(() => true, () => false);
    if (!exec || !text.includes(`'${c.root}'`)) return warn('Widget shortcuts', exec ? 'the shortcut points to another folder' : 'the shortcut is not executable', 'node hub/cli.mjs widget install');
    return ok('Widget shortcuts', 'StickHub and StickHub stop are installed');
  },
  async function stick(c) {
    const { volumes, error } = await c.listVolumes();
    if (error) return fail('Stick', `cannot read the list of mounted volumes: ${error}`, 'Run doctor in Termux on the phone');
    const s = await c.findStick(volumes);
    if (s.state === 'none') return info('Stick', volumes.length ? `${volumes.length} volume(s), none with HUB` : 'no stick plugged in', 'Plug in the stick, then run doctor again');
    if (s.state === 'blank') return warn('Stick', `${s.mount} has no HUB yet`, 'node hub/cli.mjs stick init --name "My stick"');
    if (s.state === 'bad') return fail('Stick', `${s.mount}: ${s.error}`, 'Look at HUB/stick.json on the stick, or: node hub/cli.mjs stick init --force');
    const probe = join(s.hubDir, `.doctor-${process.pid}.tmp`);
    let writable = true;
    try { await writeFile(probe, 'x'); await rm(probe); } catch { writable = false; } // the answer is the check
    const code = s.info.commit ? `code ${s.info.commit.slice(0, 7)} ${s.info.codeState}` : 'no code copied yet';
    return writable ? ok('Stick', `"${s.info.name}" at ${s.mount}, writable, ${code}`)
      : fail('Stick', `"${s.info.name}" at ${s.mount} is not writable`, 'termux-setup-storage, then unplug and plug the stick in again');
  },
  async function hub(c) {
    const p = await c.callHub('/api/ping', { timeout: 1500 });
    if (p?.status === 200 && p.body?.name === 'StickHub') return ok('Hub', `running on port ${HUB_PORT} (${p.body.mode === 'data-on-stick' ? 'app data on the stick' : 'phone copy'})`);
    if (await c.isPortFree(HUB_PORT)) return info('Hub', 'not running', 'node hub/cli.mjs open   (or tap the StickHub widget)');
    return fail('Hub', `port ${HUB_PORT} is used by another program`, 'Stop that program; the hub needs this fixed port');
  },
  async function watcher(c) {
    if (!c.env.TERMUX_VERSION) return info('Watcher', 'skipped (not Termux)');
    const w = await c.runningWatcher(c.home);
    return w ? ok('Watcher', `running (pid ${w.pid})`)
      : warn('Watcher', 'not running: plugging in the stick will not open the hub', 'Tap the StickHub widget, or: node hub/cli.mjs watch start (again after a phone restart)');
  },
  async function login(c) {
    const token = await readToken(c.home).catch(() => null);
    let settings;
    try { settings = await loadSettings(c.home); } catch (e) { return fail('Settings', e.message, `Fix or delete ${join(c.home, 'settings.json')}`); }
    const on = Object.entries(settings).filter(([, v]) => v).map(([k]) => k);
    return token ? ok('Token and settings', `token present; settings on: ${on.length ? on.join(', ') : 'none'}`)
      : info('Token and settings', 'no token yet (the hub makes one on its first start)', 'node hub/cli.mjs open');
  },
];

/** Run every check; a check that throws becomes a failure, so one broken check never hides the others. */
export async function runDoctor(c) {
  const results = [];
  for (const check of CHECKS) {
    try { results.push(await check(c)); } catch (e) { results.push(fail(check.name, `check crashed: ${e.message}`)); }
  }
  return results;
}

const MARK = { ok: '[ok]', warn: '[! ]', fail: '[XX]', info: '[--]' };

/** Readable report. */
export function formatReport(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = ['StickHub doctor', ''];
  for (const r of results) {
    lines.push(`${MARK[r.state]} ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.fix) lines.push(`${' '.repeat(width + 7)}Fix: ${r.fix}`);
  }
  const fails = results.filter((r) => r.state === 'fail').length;
  const warns = results.filter((r) => r.state === 'warn').length;
  lines.push('', fails || warns ? `${fails} problem(s), ${warns} warning(s). Fix them from the top down, then run doctor again.` : 'All good.');
  return lines.join('\n');
}
