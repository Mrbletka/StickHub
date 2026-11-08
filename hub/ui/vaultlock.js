// The vault's lock screen, the heartbeat and the Lock button (design 7.2, 7.3, 7.9).
// The field follows 7.9 exactly, so Chrome has nothing to offer to save and Gboard nothing to learn: type=password,
// autocomplete/autocapitalize/autocorrect off, spellcheck false, a random name and id per page load, no <form> and no
// username field. The value is read by script, the field is cleared at once, the secret goes out with fetch() and the
// reference is dropped (strings cannot be zeroed in JavaScript). Only this screen ever asks for it, never an app.

import { api, LoginNeeded } from './api.js';

const HEARTBEAT_MS = 30_000;
const TEXT = {
  passphrase: { label: 'Passphrase', hint: 'The words you chose when the vault was made.' },
  paper: { label: 'Paper code', hint: '28 characters from the paper code. Dashes and spaces do not matter.' },
};
const rid = () => `f${[...crypto.getRandomValues(new Uint32Array(3))].map((n) => n.toString(36)).join('')}`;

/**
 * @param {{root: HTMLElement, lockButton: HTMLElement, onLocked: () => void, onUnlocked: () => void,
 *   onLogin: () => void, toast: (s: string) => void}} o
 *   root: the #vault section; onLocked: close the player and the sheets, hide the tiles; onLogin: the token was refused
 */
export function createVaultLock(o) {
  const $ = (sel) => o.root.querySelector(sel);
  let mode = 'passphrase';
  let state = 'none';
  let waitUntil = 0;
  let countdown = null;
  let beat = null;
  let sending = false;
  let tick = null;

  // The field: made by script, with a random name and id for this page load.
  const input = document.createElement('input');
  input.type = 'password';
  input.name = rid();
  input.id = rid();
  for (const [k, v] of [['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) input.setAttribute(k, v);
  input.maxLength = 1024;
  input.className = 'vault-input';
  $('#vault-field').append(input);

  function setMode(m) {
    mode = m;
    for (const b of o.root.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    input.setAttribute('aria-label', TEXT[m].label);
    input.placeholder = TEXT[m].label;
    $('#vault-hint').textContent = TEXT[m].hint;
    input.value = '';
    say('');
  }

  function say(text, cls = 'error-text') {
    const el = $('#vault-msg');
    el.textContent = text;
    el.className = cls;
  }

  function busy(on) {
    sending = on;
    $('#vault-unlock').disabled = on || Date.now() < waitUntil;
    $('#vault-unlock').textContent = on ? 'Opening…' : 'Unlock';
  }

  // "Too many wrong tries": a countdown, the button waits.
  function wait(seconds) {
    clearInterval(countdown);
    waitUntil = Date.now() + seconds * 1000;
    tick = () => {
      const left = Math.ceil((waitUntil - Date.now()) / 1000);
      if (left <= 0) { clearInterval(countdown); countdown = null; say(''); busy(false); return; }
      say(`Too many wrong tries. Try again in ${left} s.`);
      $('#vault-unlock').disabled = true;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  async function unlock() {
    if (sending || Date.now() < waitUntil) return;
    let secret = input.value;
    input.value = ''; // cleared at once, before anything else
    if (!secret.trim()) { say(mode === 'paper' ? 'Type the paper code.' : 'Type the passphrase.'); input.focus(); return; }
    busy(true);
    say('');
    let r;
    try {
      r = await api('/api/vault/unlock', { method: 'POST', body: { method: mode, secret } });
    } catch (e) {
      if (e instanceof LoginNeeded) { o.onLogin(); return; }
      say('The hub is not reachable.');
      return;
    } finally {
      secret = null;
      busy(false);
    }
    if (r.ok) { show(r.body); return; }
    if (r.body.code === 'WAIT') wait(r.body.retryAfter || 2);
    else if (r.body.code === 'WRONG' && countdown) tick(); // the hub already said how long to wait: show that
    else say(r.body.error || `Error ${r.status}`);
    input.focus();
  }

  // Heartbeat: while the page is visible and the vault is open. A hidden, closed or frozen page sends nothing,
  // so the hub locks after autoLockSeconds (design 7.3).
  async function heartbeat() {
    if (state !== 'unlocked' || document.hidden) return;
    try { await api('/api/vault/heartbeat', { method: 'POST' }); } catch (e) { if (e instanceof LoginNeeded) o.onLogin(); }
  }
  function beats(on) {
    clearInterval(beat);
    beat = on ? setInterval(heartbeat, HEARTBEAT_MS) : null;
    if (on) heartbeat();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });

  /** The vault status from the hub (the `vault` part of /api/status or an unlock answer). */
  function show(v) {
    const prev = state;
    state = v?.state || 'none';
    const open = state === 'unlocked' || state === 'none';
    o.root.hidden = open;
    o.lockButton.hidden = state !== 'unlocked';
    if (prev !== state) beats(state === 'unlocked');
    if (!open) {
      if (prev === 'unlocked' || prev === 'none') o.onLocked();
      $('#vault-title').textContent = state === 'locking' ? 'Locking…' : 'StickHub is locked';
      $('#vault-paper').hidden = !v.paperUsed;
      if (v.unlocking || state === 'unlocking') busy(true); else if (!sending) busy(false);
      if (v.retryAfter > 0 && !countdown) wait(v.retryAfter);
      if (prev !== state && !sending) setTimeout(() => input.focus(), 50);
    } else if (prev !== state && state === 'unlocked') {
      o.onUnlocked();
      if (v.paperUsed) o.toast('Paper code used. Make a new one soon.');
    }
  }

  async function lock() {
    o.lockButton.disabled = true;
    try { show((await api('/api/vault/lock', { method: 'POST' })).body); } catch (e) { if (e instanceof LoginNeeded) o.onLogin(); else o.toast('The hub is not reachable.'); } finally { o.lockButton.disabled = false; }
  }

  for (const b of o.root.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('#vault-unlock').addEventListener('click', unlock);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
  o.lockButton.addEventListener('click', lock);
  setMode('passphrase');

  return { show, get state() { return state; } };
}
