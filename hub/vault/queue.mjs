// The store's write queue: one thing at a time, in order.
// - 'op' items (changes) that wait next to each other run as ONE batch: runBatch(items) commits them together (group
//   commit). Before the first item runs, the queue waits one tick (setImmediate), so changes made in the same moment
//   join the same batch.
// - 'task' items (cleanup, compaction, verify, header writes) run alone; check() runs before each one (closed/broken).
// - background(fn, onError) queues a task nobody waits for (automatic maintenance).

export class WriteQueue {
  #q = [];
  #running = null;
  #check;
  #runBatch;

  /**
   * @param {{check: () => void, runBatch: (items: {fn: Function, resolve: Function, reject: Function}[]) => Promise<void>}} o
   *   check: throws if nothing may run any more; runBatch: must resolve or reject every item and never throw
   */
  constructor(o) {
    this.#check = o.check;
    this.#runBatch = o.runBatch;
  }

  /** Queue a change (batched with its neighbours). @returns {Promise<any>} its result */
  op(fn) { return this.#add('op', fn); }

  /** Queue a task (runs alone). @returns {Promise<any>} its result */
  task(fn) { return this.#add('task', fn); }

  /** Queue a task nobody waits for; its error goes to onError. */
  background(fn, onError) {
    this.#q.push({ kind: 'task', fn, resolve: () => {}, reject: onError });
    if (!this.#running) this.#running = this.#drain();
  }

  /** Resolves when everything queued so far (and anything queued meanwhile) has run. */
  async idle() {
    while (this.#running) await this.#running;
  }

  #add(kind, fn) {
    return new Promise((resolve, reject) => {
      this.#q.push({ kind, fn, resolve, reject });
      if (!this.#running) this.#running = this.#drain();
    });
  }

  async #drain() {
    try {
      await new Promise((r) => setImmediate(r)); // changes of the same moment join one commit
      while (this.#q.length) {
        if (this.#q[0].kind === 'task') {
          const t = this.#q.shift();
          try {
            this.#check();
            t.resolve(await t.fn());
          } catch (e) {
            t.reject(e);
          }
        } else {
          const batch = [];
          while (this.#q.length && this.#q[0].kind === 'op') batch.push(this.#q.shift());
          await this.#runBatch(batch);
        }
      }
    } finally {
      this.#running = null;
    }
  }
}
