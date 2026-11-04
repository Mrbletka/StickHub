// CLI parts for the phone: the watcher (start/stop/status) and the Termux:Widget home-screen shortcuts.

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startDetached } from './hubctl.mjs';
import { readCmdline, sameArgv } from './proc.mjs';

/**
 * The running watcher, or null. Checks /proc/<pid>/cmdline against the saved command line (never a PID alone).
 * @param {string} home
 * @returns {Promise<{pid: number, argv: string[], started: string}|null>}
 */
export async function runningWatcher(home) {
  let rec;
  try {
    rec = JSON.parse(await readFile(join(home, 'watcher.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
    throw e;
  }
  return Number.isInteger(rec?.pid) && sameArgv(await readCmdline(rec.pid), rec.argv) ? rec : null;
}

/** node hub/cli.mjs watch start|stop|status */
export async function watchCommand(sub, root, home) {
  const cur = await runningWatcher(home);
  if (sub === 'status') {
    console.log(cur ? `The watcher is running (pid ${cur.pid}, since ${cur.started}).` : 'The watcher is not running. Start it: node hub/cli.mjs watch start');
    const log = await readFile(join(root, 'logs', 'watcher.log'), 'utf8').catch(() => '');
    const lines = log.trim().split('\n').filter(Boolean).slice(-8);
    if (lines.length) console.log(`Last lines of logs/watcher.log:\n  ${lines.join('\n  ')}`);
    return 0;
  }
  if (sub === 'start') {
    if (cur) { console.log(`The watcher is already running (pid ${cur.pid}).`); return 0; }
    const child = startDetached(root, 'hub/watcher.mjs', 'watcher.log');
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const now = await runningWatcher(home);
      if (now) { console.log(`Watcher started (pid ${now.pid}). Log: logs/watcher.log`); return 0; }
    }
    console.log(`The watcher (pid ${child.pid}) did not report in. See logs/watcher.log`);
    return 1;
  }
  if (sub === 'stop') {
    if (!cur) { console.log('The watcher is not running.'); return 0; }
    process.kill(cur.pid, 'SIGTERM');
    console.log(`Stopping the watcher (pid ${cur.pid}). The hub keeps running; stop it with: node hub/cli.mjs hub stop`);
    return 0;
  }
  throw new Error('watch: say start, stop or status');
}

/** Single-quote a path for sh. Refuses paths with a quote or a line break (they never occur here). */
function shq(p) {
  if (/['\n]/.test(p)) throw new Error(`Path not supported for the widget: ${p}`);
  return `'${p}'`;
}

/**
 * node hub/cli.mjs widget install: two scripts for Termux:Widget in ~/.shortcuts/tasks/ (run in the background).
 *   StickHub       start the watcher and open the hub
 *   StickHub stop  stop the watcher and the hub
 */
export async function widgetInstall(root) {
  const dir = join(homedir(), '.shortcuts', 'tasks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const sh = process.env.PREFIX ? join(process.env.PREFIX, 'bin', 'sh') : '/bin/sh';
  const node = shq(process.execPath);
  const head = `#!${sh}\n# Made by: node hub/cli.mjs widget install (StickHub). Safe to delete.\ncd ${shq(root)} || exit 1\nmkdir -p logs\n`;
  const scripts = {
    StickHub: `${head}${node} hub/cli.mjs watch start > logs/widget.log 2>&1\n${node} hub/cli.mjs open >> logs/widget.log 2>&1 || termux-toast "StickHub: see logs/widget.log"\n`,
    'StickHub stop': `${head}${node} hub/cli.mjs watch stop > logs/widget.log 2>&1\n${node} hub/cli.mjs hub stop >> logs/widget.log 2>&1\ntermux-toast "StickHub stopped"\n`,
  };
  for (const [name, text] of Object.entries(scripts)) {
    const file = join(dir, name);
    await writeFile(file, text, { mode: 0o700 });
    await chmod(file, 0o700);
    console.log(`Wrote ${file}`);
  }
  console.log(`Now add the widget: long-press the home screen > Widgets > Termux:Widget, then pick "StickHub".
After a phone restart or if Android closes Termux, tap "StickHub" again: the watcher does not start by itself.`);
  return 0;
}
