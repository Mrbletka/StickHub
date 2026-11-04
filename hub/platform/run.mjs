// Run an external command: argument array (never a shell), hard timeout, output captured.

import { execFile } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeout?: number, input?: string}} [o]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error?: string}>}
 */
export function run(cmd, args = [], o = {}) {
  const timeout = o.timeout ?? 10_000;
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, code: 0, stdout, stderr });
      const why = err.killed ? `timed out after ${timeout} ms` : err.code === 'ENOENT' ? `${cmd} not found` : String(err.code ?? err.message);
      resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, stdout, stderr, error: why });
    });
    child.stdin.end(o.input);
  });
}
