import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHub } from '../hub/server.mjs';
import { readCmdline, cleanupLeftovers } from '../hub/proc.mjs';
import { isPortFree } from '../hub/ports.mjs';
import { makeApps, GOOD_SERVER } from './helpers.mjs';

const NO_STICK = { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 };
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test('after a hard kill of the hub, the next hub stops the leftover app', async () => {
  const fx = await makeApps({ good: { 'app.json': { id: 'good', name: 'Good', engine: 'node-server', entry: 'server.mjs' }, 'server.mjs': GOOD_SERVER } });
  const home = join(fx.root, 'home');
  // A hub in its own process starts the app, then gets SIGKILL (no clean-up code can run).
  const script = join(fx.root, 'run-hub.mjs');
  await writeFile(script, `
    import { createHub } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'hub', 'server.mjs')).href)};
    const hub = await createHub({ root: ${JSON.stringify(fx.root)}, port: 0, home: ${JSON.stringify(home)},
      portRange: { from: 27170, to: 27179 }, stick: { listVolumes: async () => ({ volumes: [], error: null }), pollMs: 0 } });
    const v = await hub.procman.start('good');
    console.log(JSON.stringify({ pid: hub.procman.state.get('good').handle.pid, port: v.port }));
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.ok(await readCmdline(info.pid), 'the app outlived its hub');
  assert.equal(await isPortFree(info.port), false);

  const hub = await createHub({ root: fx.root, port: 0, home, stick: NO_STICK });
  try {
    assert.ok(await until(async () => !(await readCmdline(info.pid))), 'leftover stopped');
    assert.ok(await until(() => isPortFree(info.port)), 'port freed');
  } finally {
    await hub.close();
    await fx.cleanup();
  }
});

test('a saved PID that now runs another program is never touched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stickhub-proc-'));
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const file = join(dir, 'apps-running.json');
    await writeFile(file, JSON.stringify({
      reused: { pid: other.pid, argv: [process.execPath, '/some/app/server.mjs'] },
      gone: { pid: 999999, argv: ['x'] },
      bad: { pid: 'x' },
    }));
    const report = await cleanupLeftovers(file);
    assert.match(report.join('\n'), /reused: pid \d+ is now another program, not touched/);
    assert.match(report.join('\n'), /gone: pid 999999 already gone/);
    assert.match(report.join('\n'), /bad: bad record/);
    assert.deepEqual(await readCmdline(other.pid), ['sleep', '30']);
  } finally {
    other.kill();
  }
});
