// The two ways the Notebook keeps notes, for its tests: plain files (hubfs plain-file mode) and the hub (a TEST ONLY
// vault behind the data API). Each mode gives a hubfs, put() to change notes "from somewhere else" (the sync, another
// device: no event through this hubfs), and done() to clean up.

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHubFs } from '../lib/hubfs.mjs';
import { createDataApi } from '../../../hub/dataapi/server.mjs';
import { makeTestStore } from '../../../test/vault-helpers.mjs';

export const MODES = {
  async files() {
    const base = await mkdtemp(join(tmpdir(), 'notebook-'));
    const dir = join(base, 'data');
    return {
      mode: 'files', base, dir, fs: createHubFs({ dir, socket: '', token: '' }),
      async put(files) {
        for (const [p, data] of Object.entries(files)) {
          const f = join(dir, ...p.split('/'));
          await mkdir(dirname(f), { recursive: true });
          await writeFile(f, data);
        }
      },
      done: () => rm(base, { recursive: true, force: true }),
    };
  },
  async hub() {
    const t = await makeTestStore({ autoCleanupEvery: 0 });
    const base = await mkdtemp(join(tmpdir(), 'notebook-hub-'));
    const api = await createDataApi({ socketPath: join(base, 'run', 'd.sock'), getStore: () => t.store });
    const token = api.issue('notebook');
    return {
      mode: 'hub', base, store: t.store, api, token, fs: createHubFs({ socket: api.socketPath, token }),
      async put(files) { await Promise.all(Object.entries(files).map(([p, d]) => t.store.write(`notebook/${p}`, d))); },
      async done() {
        await api.close();
        await t.store.close();
        await rm(base, { recursive: true, force: true });
        await rm(t.root, { recursive: true, force: true });
      },
    };
  },
};
