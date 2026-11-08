// Engine "static": serves an app's files with the hub's built-in static server, inside the hub process.
// app.json: { "engine": "static", "entry": "public" (folder, default "."), "spa": false }

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serveStatic, send } from '../static-files.mjs';
import { hubRoutes } from '../appkit/hubfs.mjs';

export default {
  id: 'static',

  /** @returns {string[]} errors */
  validate(m) {
    const errors = [];
    if (m.args?.length) errors.push('args: not used by the static engine');
    if (m.env && Object.keys(m.env).length) errors.push('env: not used by the static engine');
    return errors;
  },

  /**
   * @param {import('../procman.mjs').EngineContext} ctx
   */
  async start(ctx) {
    const root = join(ctx.app.dir, ctx.app.manifest.entry || '.');
    const st = await stat(root).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Folder "${ctx.app.manifest.entry || '.'}" not found in the app`);
    const spa = ctx.app.manifest.spa === true;
    const startId = randomBytes(9).toString('base64url'); // /__hub/start: new at every start of this app
    const server = createServer((req, res) => {
      if (hubRoutes(req, res, startId)) return; // /__hub/clear and /__hub/start, as node-server apps have them
      serveStatic(req, res, root, { spa }).catch((e) => {
        ctx.log('err', `${req.url}: ${e.message}`);
        if (!res.headersSent) send(res, 500, 'Server error'); else res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(ctx.port, '127.0.0.1', resolve);
    });
    ctx.log('out', `static files from ${ctx.app.manifest.entry || '.'} on port ${ctx.port}`);
    return {
      port: ctx.port,
      url: `http://127.0.0.1:${ctx.port}/`,
      stop: () => new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    };
  },
};
