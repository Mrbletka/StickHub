import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, relPathError } from '../hub/manifest.mjs';

const engines = new Map([['node-server', { validate: (m) => (m.entry ? [] : ['entry: needed']) }], ['static', {}]]);
const good = { id: 'deep-dig', name: 'Deep Dig', icon: 'icon.png', engine: 'node-server', entry: 'server.js', port: 'auto', args: [], env: {}, version: '0.1.0' };

test('the example manifest from the guide is valid and gets defaults', () => {
  const v = validateManifest(good, { folder: 'deep-dig', engines });
  assert.deepEqual(v.errors, []);
  assert.equal(v.manifest.port, 'auto');
  const min = validateManifest({ id: 'a', name: 'A', engine: 'static' }, { engines });
  assert.ok(min.ok);
  assert.deepEqual(min.manifest.args, []);
});

test('bad ids, folders, engines and keys are errors', () => {
  const cases = [
    [{ ...good, id: 'Deep_Dig' }, /id:/],
    [{ ...good, id: '-x' }, /id:/],
    [{ ...good }, /match the folder/, 'other'],
    [{ ...good, engine: 'python' }, /not installed/],
    [{ ...good, extra: 1 }, /unknown key "extra"/],
    [{ ...good, name: '' }, /name/],
    [{ ...good, port: 80 }, /port/],
    [{ ...good, args: ['a', 1] }, /args/],
    [{ ...good, env: { PORT: '1' } }, /set by the hub/],
    [{ ...good, env: { HUB_DATA_DIR: '/x' } }, /set by the hub/],
    [{ ...good, env: { A: 1 } }, /env.A/],
    [{ ...good, version: 'one' }, /version/],
    [{ ...good, entry: undefined }, /entry: needed/],
    [[], /JSON object/],
    [null, /JSON object/],
  ];
  for (const [m, re, folder] of cases) {
    const v = validateManifest(m, { folder: folder ?? m?.id, engines });
    assert.equal(v.ok, false, JSON.stringify(m));
    assert.match(v.errors.join('\n'), re);
  }
});

test('paths must stay inside the app and be storable on exFAT', () => {
  assert.equal(relPathError('icon.png'), null);
  assert.equal(relPathError('img/icon.png'), null);
  for (const p of ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a:b', 'a?b', '', 5]) {
    assert.notEqual(relPathError(p), null, String(p));
  }
  const v = validateManifest({ ...good, icon: '../../secret.png' }, { folder: 'deep-dig', engines });
  assert.match(v.errors.join(), /icon/);
});
