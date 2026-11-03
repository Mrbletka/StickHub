// Unit tests for the pure helpers the phone probes use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMountinfo, volumeRoot, stats, mbps, run } from '../probes/lib.mjs';

test('parseMountinfo reads mount point, type and options', () => {
  const text = '36 35 0:30 / /storage/ABCD-1234 rw,nosuid,nodev,noexec,noatime shared:5 - fuse /dev/fuse rw,user_id=0\n'
    + '40 35 0:31 / /storage/My\\040Disk rw - vfat /dev/block/x rw\n';
  const m = parseMountinfo(text);
  assert.equal(m.length, 2);
  assert.equal(m[0].mountPoint, '/storage/ABCD-1234');
  assert.equal(m[0].fsType, 'fuse');
  assert.match(m[0].mountOpts, /noexec/);
  assert.equal(m[1].mountPoint, '/storage/My Disk');
});

test('volumeRoot finds the removable volume and ignores internal storage', () => {
  assert.equal(volumeRoot('/storage/ABCD-1234/Android/data/com.termux/files'), '/storage/ABCD-1234');
  assert.equal(volumeRoot('/storage/ABCD-1234'), '/storage/ABCD-1234');
  assert.equal(volumeRoot('/storage/emulated/0/Download'), null);
  assert.equal(volumeRoot('/data/data/com.termux/files/home'), null);
  assert.equal(volumeRoot(null), null);
});

test('stats and mbps', () => {
  assert.deepEqual(stats([3, 1, 2]), { n: 3, min: 1, med: 2, max: 3 });
  assert.deepEqual(stats([]), { n: 0, min: 0, med: 0, max: 0 });
  assert.equal(mbps(10 * 1048576, 1000), 10);
  assert.equal(mbps(1, 0), 0);
});

test('run times out and reports it instead of hanging', async () => {
  const res = await run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 });
  assert.equal(res.ok, false);
  assert.match(res.error, /timeout/);
});

test('run passes stdin and returns stdout', async () => {
  const res = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
  assert.equal(res.ok, true);
  assert.equal(res.stdout, 'hello');
});
