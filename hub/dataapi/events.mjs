// Change events per app for the data API: a ring buffer of the last `size` events (seq, kind, path, id) and
// long-poll waiters. Only changes made through the API land here (and what notify() adds, for sync later).

export class EventLog {
  #apps = new Map();
  #size;

  constructor(size = 1000) { this.#size = size; }

  #app(id) {
    if (!this.#apps.has(id)) this.#apps.set(id, { seq: 0, buf: [], waiters: new Set() });
    return this.#apps.get(id);
  }

  /** Add an event; wakes the app's long polls. @param {{kind: string, path: string, id?: string, from?: string}} ev */
  add(appId, ev) {
    const a = this.#app(appId);
    a.buf.push({ seq: ++a.seq, ...ev });
    if (a.buf.length > this.#size) a.buf.shift();
    for (const w of a.waiters) w();
    a.waiters.clear();
  }

  /** Events after seq n. lost: n is older than the buffer (list again). */
  since(appId, n) {
    const a = this.#app(appId);
    if (n === undefined || n >= a.seq) return { seq: a.seq, lost: false, events: [] };
    const first = a.buf.length ? a.buf[0].seq : a.seq + 1;
    if (n < first - 1) return { seq: a.seq, lost: true, events: [] };
    return { seq: a.seq, lost: false, events: a.buf.filter((e) => e.seq > n) };
  }

  /** since(), but waits up to ms for a first event when there is none yet (n given). */
  async wait(appId, n, ms) {
    const now = this.since(appId, n);
    if (n === undefined || now.lost || now.events.length || n > now.seq) return now;
    const a = this.#app(appId);
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); a.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      a.waiters.add(done);
    });
    return this.since(appId, n);
  }

  /** Wake every waiter (close()). */
  wakeAll() { for (const a of this.#apps.values()) { for (const w of [...a.waiters]) w(); } }
}
