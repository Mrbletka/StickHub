// Watcher (phone, runs in Termux): when the stick with HUB/stick.json appears, start the hub if needed and open it
// with a one-time login link. Reads /proc/self/mountinfo every 2 s (~0.7 ms); no termux-usb polling.
// Start it with one tap on the "StickHub" home-screen widget, or: node hub/cli.mjs watch start
// It does not survive a phone reboot or Termux being killed: tap the widget again (Termux:Boot is not installed).

import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listVolumes as realListVolumes, openUrl, notify, wakeLock, wakeUnlock } from './platform/termux.mjs';
import { createGit } from './platform/git.mjs';
import { findStick } from './stick.mjs';
import { createFsx } from './sync/fsx.mjs';
import { ensureHub, loginUrl } from './hubctl.mjs';
import { stickhubHome, loadSettings } from './config.mjs';
import { readCmdline, sameArgv } from './proc.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POLL_MS = 2000;
// Termux runs a notification action through a shell, so only plain paths may go into it.
const PLAIN_PATH = /^[\w./-]+$/;

/**
 * The watcher's logic, with every outside effect passed in (tests use fakes).
 * @param {{listVolumes: Function, ensureHub: Function, loginUrl: Function, openUrl: Function, notify: Function,
 *   settings: () => Promise<{autoPull: boolean}>, pull?: Function, log: (msg: string) => void, loginAction?: string|null}} d
 */
export class Watcher {
  constructor(d) {
    this.d = d;
    this.present = null;
    this.busy = false;
  }

  /** Look once. Opens the hub when a stick with HUB appears (not again while it stays plugged in). */
  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { volumes, error } = await this.d.listVolumes();
      if (error) this.d.log(`warning: ${error}`);
      const s = await findStick(volumes, createFsx());
      const key = s.state === 'ok' ? `${s.info.id}@${s.mount}` : null;
      if (key && key !== this.present) await this.#plugged(s);
      else if (!key && this.present) this.d.log('stick removed');
      if (!key && s.state === 'blank' && this.lastBlank !== s.mount) this.d.log(`a stick without HUB at ${s.mount} (run: node hub/cli.mjs stick init)`);
      this.lastBlank = s.state === 'blank' ? s.mount : null;
      this.present = key;
    } catch (e) {
      this.d.log(`error: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async #plugged(s) {
    const t0 = Date.now();
    this.d.log(`stick "${s.info.name}" found at ${s.mount}`);
    const settings = await this.d.settings();
    if (settings.autoPull && this.d.pull) {
      const r = await this.d.pull();
      this.d.log(`autoPull: ${r}`);
    }
    const hub = await this.d.ensureHub();
    this.d.log(hub.started ? `hub started (${Date.now() - t0} ms)` : 'hub was already running');
    const url = await this.d.loginUrl();
    const r = await this.d.openUrl(url);
    if (r.ok) {
      this.d.log(`hub opened ${Date.now() - t0} ms after the stick was found`);
      return;
    }
    // Opening from the background failed: a notification the user can tap instead.
    this.d.log(`could not open the browser (${r.error}); showing a notification`);
    const n = await this.d.notify({ id: 'stickhub', title: 'Stick connected', content: 'Tap to open StickHub',
      ...(this.d.loginAction ? { action: this.d.loginAction } : {}) });
    if (!n.ok) this.d.log(`notification failed too: ${n.error}`);
  }
}

// ---------- the real watcher process ----------

async function main() {
  const home = stickhubHome();
  const pidFile = join(home, 'watcher.json');
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  // The exact command line of this process, as /proc shows it, so `watch stop` can recognise it safely.
  const argv = await readCmdline(process.pid) || process.argv;

  try {
    const prev = JSON.parse(await readFile(pidFile, 'utf8'));
    if (prev.pid !== process.pid && sameArgv(await readCmdline(prev.pid), prev.argv)) {
      log(`already running (pid ${prev.pid})`);
      return;
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(`${pidFile}.tmp`, JSON.stringify({ pid: process.pid, argv, started: new Date().toISOString() }), { mode: 0o600 });
  await rename(`${pidFile}.tmp`, pidFile);

  const lock = await wakeLock();
  if (!lock.ok) log(`warning: termux-wake-lock failed (${lock.error}); Android may pause the watcher`);
  const cli = join(ROOT, 'hub', 'cli.mjs');
  const loginAction = PLAIN_PATH.test(process.execPath) && PLAIN_PATH.test(cli) ? `${process.execPath} ${cli} login --open` : null;
  const git = createGit(ROOT);
  const watcher = new Watcher({
    listVolumes: realListVolumes, openUrl, notify, log, loginAction,
    ensureHub: () => ensureHub(ROOT),
    loginUrl: () => loginUrl(home),
    settings: () => loadSettings(home),
    pull: () => git.pullFastForward(),
  });
  log(`watcher started (pid ${process.pid}), checking every ${POLL_MS / 1000} s`);

  let timer = null;
  const stop = async (sig) => {
    clearInterval(timer);
    log(`watcher stopping (${sig})`);
    await wakeUnlock();
    try {
      const cur = JSON.parse(await readFile(pidFile, 'utf8'));
      if (cur.pid === process.pid) await rm(pidFile, { force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') log(`pid file: ${e.message}`);
    }
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(sig));
  await watcher.check();
  timer = setInterval(() => watcher.check(), POLL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`${new Date().toISOString()} watcher crashed: ${e.stack || e.message}`); process.exit(1); });
}
