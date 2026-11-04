// The byte-for-byte code check for the future portable mode (phase 4). Not used by the hub yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyStickCode, gitBlobHash } from '../hub/portable-check.mjs';
import { createGit } from '../hub/platform/git.mjs';
import { readStick } from '../hub/stick.mjs';
import { setup, makeRun, gitc } from './sync-helpers.mjs';

test('gitBlobHash equals git hash-object', async () => {
  const fx = await setup();
  try {
    const f = join(fx.root, 'hub', 'server.mjs');
    assert.equal(await gitBlobHash(f), gitc(fx.root, 'hash-object', f));
  } finally { await fx.cleanup(); }
});

test('only code that is exactly a commit of this clone passes; differences are listed', async () => {
  const fx = await setup();
  try {
    const git = createGit(fx.root);
    let st = await readStick(fx.mount);
    assert.match((await verifyStickCode({ git, hubDir: fx.hubDir, stick: st.info })).problems[0], /missing or incomplete/);
    await (await makeRun(fx, { what: { code: true } })).run();
    st = await readStick(fx.mount);
    assert.deepEqual(await verifyStickCode({ git, hubDir: fx.hubDir, stick: st.info }), { ok: true, problems: [] });

    const file = join(fx.hubDir, 'hub', 'server.mjs');
    await writeFile(file, `${await readFile(file, 'utf8')}// changed elsewhere\n`);
    await mkdir(join(fx.hubDir, 'apps', 'evil'));
    await writeFile(join(fx.hubDir, 'apps', 'evil', 'app.json'), '{}');
    await symlink('/etc/passwd', join(fx.hubDir, 'hub', 'link.mjs'));
    const v = await verifyStickCode({ git, hubDir: fx.hubDir, stick: st.info });
    assert.equal(v.ok, false);
    const text = v.problems.join('\n');
    assert.match(text, /changed on the stick: hub\/server\.mjs/);
    assert.match(text, /not part of the code: apps\/evil\/app\.json/);
    assert.match(text, /hub\/link\.mjs is a link/);
    const unknown = await verifyStickCode({ git, hubDir: fx.hubDir, stick: { ...st.info, commit: 'f'.repeat(40) } });
    assert.match(unknown.problems[0], /does not know/);
  } finally { await fx.cleanup(); }
});
