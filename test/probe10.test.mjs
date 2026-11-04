// Probe 10's pull check removes only the pull test's own folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPullRoot } from '../probes/p10-store.mjs';

test('only the pull test folder counts as removable', () => {
  assert.equal(isPullRoot('/storage/ABCD-1234/.stickhub-probe10-pull'), true);
  for (const bad of ['/storage/ABCD-1234', '/storage/ABCD-1234/HUB', '/storage/ABCD-1234/.stickhub-probe10-pull/data',
    '/storage/ABCD-1234/.stickhub-probe10-pull-x', '/', '', null, 42]) assert.equal(isPullRoot(bad), false, String(bad));
});
