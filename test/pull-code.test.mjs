import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pullCode } from '../hub/sync/pull-code.mjs';
import { createFsx, exists } from '../hub/sync/fsx.mjs';
import { createGit } from '../hub/platform/git.mjs';
import { readStick } from '../hub/stick.mjs';
import { setup, makeRun, write, gitc } from './sync-helpers.mjs';

const pull = async (fx, apply) => pullCode({ root: fx.root, hubDir: fx.hubDir, stick: (await readStick(fx.mount)).info,
  fsx: createFsx(), git: createGit(fx.root), apply });

test('pull-from-stick: plan first, copy only with apply, never with local changes', async () => {
  const fx = await setup();
  try {
    await assert.rejects(pull(fx), /no code yet/);
    await (await makeRun(fx)).run();
    // Someone changed the code on the stick (e.g. on a PC).
    await write(join(fx.hubDir, 'hub', 'server.mjs'), 'export const v = 99;\n');
    await write(join(fx.hubDir, 'apps', 'extra', 'app.json'), '{"id":"extra"}');
    await rm(join(fx.hubDir, 'hub', 'ui', 'app.js'));
    await write(join(fx.hubDir, 'hub', 'bad:name.mjs'), 'x');

    const plan = await pull(fx, false);
    assert.deepEqual(plan.puts, ['apps/extra/app.json', 'hub/server.mjs']);
    assert.deepEqual(plan.trash, ['hub/ui/app.js']);
    assert.match(plan.skipped.map((s) => s.rel).join(), /bad:name/);
    assert.equal(await readFile(join(fx.root, 'hub', 'server.mjs'), 'utf8'), 'export const v = 1;\n', 'plan changes nothing');

    const done = await pull(fx, true);
    assert.equal(done.done, true);
    assert.equal(await readFile(join(fx.root, 'hub', 'server.mjs'), 'utf8'), 'export const v = 99;\n');
    assert.equal(await exists(join(fx.root, 'hub', 'ui', 'app.js')), false);
    assert.equal(await exists(join(fx.root, 'hub', 'bad:name.mjs')), false);
    assert.match(gitc(fx.root, 'status', '--porcelain'), /server\.mjs/, 'git shows what came from the stick');

    await assert.rejects(pull(fx, true), /uncommitted changes/);
  } finally { await fx.cleanup(); }
});

test('pull-from-stick refuses an incomplete snapshot', async () => {
  const fx = await setup();
  try {
    await (await makeRun(fx)).run();
    const j = JSON.parse(await readFile(join(fx.hubDir, 'stick.json'), 'utf8'));
    await writeFile(join(fx.hubDir, 'stick.json'), JSON.stringify({ ...j, codeState: 'partial' }));
    await assert.rejects(pull(fx, true), /incomplete/);
  } finally { await fx.cleanup(); }
});
