// The vault in the hub (design 7.2, 7.3, 7.9): one vault folder, its state, unlock, lock and auto-lock.
// - state: 'none' (no vault.json in the folder: the hub works with plain data, no lock screen), 'locked', 'unlocking'
//   (only while locked and an unlock runs), 'unlocked', 'locking'. The hub always starts locked when a vault exists;
//   the keys only ever live in this process, so a crash or a kill is locked too.
// - unlock(method, secret): one at a time (a second one: 429 busy); the rate limit (limiter.mjs) first; Argon2id runs
//   on Node's async API, so the hub keeps answering meanwhile. A lock while it runs wins: the store that opens late is
//   closed at once. A wrong passphrase and a wrong paper code get the same answer (WRONG). A paper code typo (its check
//   characters) is caught before any key work and is not counted.
// - lock(reason): refuse new data calls (store -> null: the data API answers 423), finish the commit in progress,
//   stop the apps (the hub clears their browser state first, job 3), revoke every token and close the data API
//   sessions, close the store (zeroes the keys), then 'locked'. Never throws; each step's failure is logged by code.
// - auto-lock: lock when no heartbeat came for autoLockMs (the page sends one every 30 s while visible). The clock
//   and the timers are passed in (tests use fake ones).
// Never logs, stores or returns a passphrase or a paper code; errors are fixed texts.

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openVaultFolder } from '../vault/store.mjs';
import { unlockWithPassphrase, unlockWithPaperCode } from '../vault/header.mjs';
import { HEADER_MAIN } from '../vault/replica.mjs';
import { Limiter, writePrivateJson } from './limiter.mjs';

/** The one answer for a wrong passphrase and a wrong paper code. */
export const WRONG = 'That did not open the vault.';
export const SECRET_MAX = 1024;

/** An unlock that did not happen: HTTP status, a code for the page, a fixed message, extras (retryAfter). */
export class UnlockError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

const realClock = { now: Date.now, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout: (t) => clearTimeout(t) };

export class VaultService extends EventEmitter {
  #state; #store = null; #gen = 0; #inflight = false; #lockP = null; #timer = null; #lastBeat = 0;

  /**
   * @param {{dir: string, home: string, autoLockSeconds?: number, clock?: object, open?: Function, storeOpts?: object,
   *   limiter?: Limiter, log?: (s: string) => void}} o
   *   dir: the vault folder; home: ~/.stickhub (attempts.json, paper-used.json in its vault/ folder);
   *   open: (dir, unlock, storeOpts) => Store (tests: a slow one); storeOpts: Store options (tests: guard)
   */
  constructor(o) {
    super();
    this.dir = o.dir;
    this.autoLockMs = (o.autoLockSeconds ?? 300) * 1000;
    this.clock = o.clock || realClock;
    this.open = o.open || openVaultFolder;
    this.storeOpts = o.storeOpts || {};
    this.log = o.log || ((s) => console.error(s));
    this.limiter = o.limiter || new Limiter({ file: join(o.home, 'vault', 'attempts.json'), now: () => this.clock.now() });
    this.paperFile = join(o.home, 'vault', 'paper-used.json');
    this.#state = existsSync(join(this.dir, HEADER_MAIN)) ? 'locked' : 'none';
    this.paperUsed = existsSync(this.paperFile);
    this.lastLock = null;
    this.hooks = {};
  }

  /** Read the attempt count (once, before the first status). */
  async init() { if (this.#state !== 'none') await this.limiter.load(); return this; }

  /** What the lock does besides the store: {stopApps(): Promise, revokeAll(): void}. */
  attach(hooks) { this.hooks = { ...this.hooks, ...hooks }; }

  get state() { return this.#state; }
  get exists() { return this.#state !== 'none'; }
  get unlocked() { return this.#state === 'unlocked'; }
  /** The open store for the data API, or null (then every data call answers 423). */
  get store() { return this.#state === 'unlocked' ? this.#store : null; }

  /** For the page and the CLI: no names, no counts from inside the vault. */
  status() {
    if (this.#state === 'none') return { state: 'none' };
    return { state: this.#state, unlocking: this.#inflight, retryAfter: Math.ceil(this.limiter.waitMs() / 1000),
      autoLockSeconds: this.autoLockMs / 1000, paperUsed: this.paperUsed, lastLock: this.lastLock };
  }

  /**
   * Open the vault. Throws UnlockError: 403 WRONG, 429 BUSY or WAIT (extra.retryAfter in s), 400 TYPO, EMPTY or BAD,
   * 409 UNLOCKED, LOCKING or LOCKED (a lock came while it ran), 404 NO_VAULT, 500/503 (fixed texts).
   * @param {'passphrase'|'paper'} method
   * @param {string} secret  typed by the user; never kept
   */
  async unlock(method, secret) {
    if (this.#state === 'none') throw new UnlockError(404, 'NO_VAULT', 'There is no vault.');
    if (this.#inflight) throw new UnlockError(429, 'BUSY', 'The vault is being opened. Wait a moment.');
    if (this.#state === 'unlocked') throw new UnlockError(409, 'UNLOCKED', 'The vault is open already.');
    if (this.#state === 'locking') throw new UnlockError(409, 'LOCKING', 'The vault is locking. Try again in a moment.');
    if (method !== 'passphrase' && method !== 'paper') throw new UnlockError(400, 'BAD', 'Say passphrase or paper code.');
    if (typeof secret !== 'string' || !secret.trim() || secret.length > SECRET_MAX) {
      throw new UnlockError(400, 'EMPTY', method === 'paper' ? 'Type the paper code.' : 'Type the passphrase.');
    }
    const wait = this.limiter.waitMs();
    if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      throw new UnlockError(429, 'WAIT', `Too many wrong tries. Try again in ${s} s.`, { retryAfter: s });
    }
    const gen = ++this.#gen;
    this.#inflight = true;
    this.#state = 'unlocking';
    this.emit('change');
    try {
      let store;
      try {
        store = await this.open(this.dir, (h) => (method === 'paper' ? unlockWithPaperCode(h, secret) : unlockWithPassphrase(h, secret)), this.storeOpts);
      } catch (e) {
        if (e?.code === 'WRONG_SECRET') { await this.limiter.failure().catch((x) => this.log(`vault: attempts file: ${x.code || 'error'}`)); throw new UnlockError(403, 'WRONG', WRONG); }
        if (e?.code === 'BAD_CODE') throw new UnlockError(400, 'TYPO', e.message); // the check characters: no key work was done
        this.log(`vault: unlock failed (${e?.code || 'error'})`);
        throw new UnlockError(e?.code === 'KDF_FAILED' ? 503 : 500, e?.code || 'ERROR', e?.name === 'VaultError' ? e.message : 'The vault could not be opened. See the hub log.');
      }
      await this.limiter.success().catch((x) => this.log(`vault: attempts file: ${x.code || 'error'}`));
      if (gen !== this.#gen) { // a lock came while the key was being derived: lock wins
        await store.close().catch(() => {});
        throw new UnlockError(409, 'LOCKED', 'The vault was locked while it was opening.');
      }
      this.#store = store;
      this.#state = 'unlocked';
      if (method === 'paper' && !this.paperUsed) {
        this.paperUsed = true; // job 6 makes a new paper code; until then the lock screen reminds
        await writePrivateJson(this.paperFile, { at: new Date(this.clock.now()).toISOString() }).catch((x) => this.log(`vault: paper note: ${x.code || 'error'}`));
      }
      this.#lastBeat = this.clock.now();
      this.#arm();
      return this.status();
    } finally {
      this.#inflight = false;
      if (this.#state === 'unlocking') this.#state = 'locked';
      this.emit('change');
    }
  }

  /** The page is visible (every 30 s): pushes the auto-lock back. */
  heartbeat() {
    if (this.#state === 'unlocked') this.#lastBeat = this.clock.now();
  }

  /**
   * Lock (Lock button, `vault lock`, auto-lock, hub stop). Waits until it is done; never throws.
   * @param {string} [reason]  'button' | 'cli' | 'auto' | 'stop'
   */
  lock(reason = 'button') {
    if (this.#lockP) return this.#lockP;
    this.#gen++; // an unlock that is still deriving its key ends locked
    this.#disarm();
    if (this.#state !== 'unlocked') {
      if (this.#state === 'unlocking') { this.#state = 'locked'; this.lastLock = { reason, at: this.clock.now() }; this.emit('change'); }
      return Promise.resolve();
    }
    this.#lockP = this.#lockSteps(reason).finally(() => { this.#lockP = null; });
    return this.#lockP;
  }

  async #lockSteps(reason) {
    const store = this.#store;
    const step = async (name, fn) => { try { await fn(); } catch (e) { this.log(`vault: lock step "${name}" failed (${e?.code || 'error'})`); } };
    this.#state = 'locking'; // 1. this.store is null now: every new data call answers 423
    this.emit('change');
    await step('finish the commit', () => store.flush()); // 2. the commit in progress lands
    await step('stop the apps', () => this.hooks.stopApps?.()); // 3. browser state cleared first (job 3), then SIGTERM
    await step('revoke tokens', () => this.hooks.revokeAll?.()); // 4. tokens, open data API sessions, change events
    await step('close the store', () => store.close()); // 5. the keys are zeroed
    this.#store = null;
    this.lastLock = { reason, at: this.clock.now() };
    this.#state = 'locked'; // 6. the page shows the lock screen and drops the player
    this.emit('change');
  }

  #arm() {
    this.#disarm();
    const due = this.#lastBeat + this.autoLockMs;
    this.#timer = this.clock.setTimeout(() => this.#tick(), Math.max(0, due - this.clock.now()));
  }

  #disarm() {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #tick() {
    this.#timer = null;
    if (this.#state !== 'unlocked') return;
    if (this.clock.now() - this.#lastBeat >= this.autoLockMs) this.lock('auto');
    else this.#arm();
  }
}
