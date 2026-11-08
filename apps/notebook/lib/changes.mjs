// "Changed somewhere else" (design 8.5): the Notebook server follows hubfs.watch() and keeps the last note changes
// for its page. GET /api/changes?cursor=<c> answers {cursor, lost, paths} and waits up to 20 s for a first change.
// lost = list again and check every open note: the server restarted (the cursor names another run), the buffer ran
// over, or the hub said so (its own restart). In plain-file mode watch() sees only this server's own changes, so the
// page keeps its check on focus as well.

import { randomBytes } from 'node:crypto';
import { ROOT } from './vault.mjs';

export class Changes {
  #run = randomBytes(4).toString('hex'); // this server run: a cursor from another run is "lost"
  #seq = 0;
  #buf = []; // {seq, paths: string[] | null (null = lost)}
  #waiters = new Set();
  #ac = new AbortController();

  /** @param {object} fs  a hubfs; @param {{max?: number, retryMs?: number, log?: (s: string) => void}} [o] */
  constructor(fs, o = {}) {
    this.fs = fs;
    this.max = o.max ?? 500;
    this.retryMs = o.retryMs ?? 5000;
    this.log = o.log ?? ((s) => console.error(s));
  }

  /** Follow the changes until stop(). A watch that fails (locked, token gone) is tried again after retryMs. */
  async start() {
    while (!this.#ac.signal.aborted) {
      try {
        for await (const ev of this.fs.watch({ signal: this.#ac.signal })) {
          if (ev.kind === 'lost') { this.#add(null); continue; }
          const paths = [ev.path, ev.from].filter((p) => typeof p === 'string' && p.startsWith(`${ROOT}/`)).map((p) => p.slice(ROOT.length + 1));
          if (paths.length) this.#add(paths);
        }
      } catch (e) {
        if (this.#ac.signal.aborted) return;
        this.log(`changes: the watch stopped (${e.code || 'error'}); trying again`);
        this.#add(null);
        await new Promise((r) => { const t = setTimeout(r, this.retryMs); this.#ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
      }
    }
  }

  #add(paths) {
    this.#buf.push({ seq: ++this.#seq, paths });
    if (this.#buf.length > this.max) this.#buf.shift();
    for (const w of this.#waiters) w();
    this.#waiters.clear();
  }

  /** What changed after a cursor. No cursor: just the current one. */
  since(cursor) {
    const now = `${this.#run}:${this.#seq}`;
    if (!cursor) return { cursor: now, lost: false, paths: [] };
    const m = /^([0-9a-f]{8}):(\d{1,15})$/.exec(cursor);
    const n = m ? Number(m[2]) : -1;
    const first = this.#buf.length ? this.#buf[0].seq : this.#seq + 1;
    if (!m || m[1] !== this.#run || n > this.#seq || n < first - 1) return { cursor: now, lost: true, paths: [] };
    const after = this.#buf.filter((e) => e.seq > n);
    if (after.some((e) => e.paths === null)) return { cursor: now, lost: true, paths: [] };
    return { cursor: now, lost: false, paths: [...new Set(after.flatMap((e) => e.paths))] };
  }

  /** since(), but waits up to ms for a first change when there is none yet. */
  async wait(cursor, ms = 20_000) {
    const r = this.since(cursor);
    if (!cursor || r.lost || r.paths.length || this.#ac.signal.aborted) return r;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.#waiters.add(done);
    });
    return this.since(cursor);
  }

  /** Stop following; open waits answer at once. */
  stop() {
    this.#ac.abort();
    for (const w of [...this.#waiters]) w();
  }
}
