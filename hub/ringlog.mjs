// Fixed-size log buffer: keeps the last N lines, numbered so clients can ask "what came after line 42".

export class RingLog {
  /** @param {number} size  max lines kept */
  constructor(size = 500) {
    this.size = size;
    this.lines = [];
    this.next = 1;
  }

  /**
   * Add a line. Long lines are cut so one noisy app cannot eat memory.
   * @param {'out'|'err'|'sys'} stream
   * @param {string} text
   * @returns {{n: number, t: number, s: string, text: string}} the stored entry
   */
  push(stream, text) {
    const entry = { n: this.next++, t: Date.now(), s: stream, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
    this.lines.push(entry);
    if (this.lines.length > this.size) this.lines.shift();
    return entry;
  }

  /** Entries with a number above `after` (all kept entries by default). */
  since(after = 0) {
    return this.lines.filter((l) => l.n > after);
  }
}
