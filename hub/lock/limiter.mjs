// Rate limit for unlock attempts (design 7.9): the first 5 failed unlocks are free, then each next try waits twice as
// long: 2 s after the 5th failure, 4 s after the 6th, ... at most 5 min. All callers share one count. It lives in
// ~/.stickhub/vault/attempts.json (folder 0700, file 0600, written as .tmp + fsync + rename), so a hub restart does
// not reset it; a good unlock does. The file holds a count and a time, nothing else.
// The clock is passed in (tests use a fake one). A clock that went back (the phone's time changed) never makes the
// wait longer than the step itself.

import { mkdir, chmod, readFile, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LIMITS = Object.freeze({ free: 5, firstMs: 2000, maxMs: 5 * 60_000 });

export class Limiter {
  #file; #now; #failures = 0; #last = 0; #loaded = false;

  /**
   * @param {{file: string, now?: () => number}} o  file: ~/.stickhub/vault/attempts.json
   */
  constructor(o) {
    this.#file = o.file;
    this.#now = o.now || Date.now;
  }

  /** Read the count from the file once (a missing file = no failures). A broken file counts as "past the free tries". */
  async load() {
    if (this.#loaded) return;
    let j = null;
    try {
      j = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') { this.#failures = LIMITS.free; this.#last = this.#now(); } // safe side: start waiting
    }
    if (j && Number.isSafeInteger(j.failures) && j.failures >= 0 && Number.isFinite(j.last)) { this.#failures = j.failures; this.#last = j.last; }
    this.#loaded = true;
  }

  /** The wait that follows `failures` failures (0 while they are free). */
  static stepMs(failures) {
    if (failures < LIMITS.free) return 0;
    return Math.min(LIMITS.maxMs, LIMITS.firstMs * 2 ** Math.min(30, failures - LIMITS.free));
  }

  /** @returns {number} milliseconds before the next try is allowed (0 = now). Call load() once first. */
  waitMs() {
    const step = Limiter.stepMs(this.#failures);
    if (!step) return 0;
    const since = Math.max(0, this.#now() - this.#last); // a clock that went back counts as "just now"
    return Math.max(0, Math.min(step, step - since));
  }

  /** Failed tries so far (for status and tests). */
  get failures() { return this.#failures; }

  /** A wrong passphrase or paper code. */
  async failure() {
    await this.load();
    this.#failures++;
    this.#last = this.#now();
    await this.#save();
  }

  /** A good unlock: the count starts again. */
  async success() {
    await this.load();
    if (!this.#failures) return;
    this.#failures = 0;
    this.#last = 0;
    await this.#save();
  }

  #save() { return writePrivateJson(this.#file, { failures: this.#failures, last: this.#last }); }
}

/**
 * Write a small JSON file only this user can read: folder 0700, file 0600, .tmp + fsync + rename.
 * @param {string} file
 * @param {object} value
 */
export async function writePrivateJson(file, value) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(value));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
