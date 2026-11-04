// Bottom sheets: menus, confirm, folder picker, quick open; and the toast.
// Each open sheet adds a history entry, so Android back closes the sheet instead of leaving the app.

import { esc } from './markdown.mjs';

const layer = document.getElementById('sheet-layer');
const sheet = document.getElementById('sheet');
let closeCurrent = null;

/**
 * Push a history entry for an overlay; Android back calls onBack.
 * Returns remove(): goes back one entry and resolves when that has happened, so a new overlay opened
 * afterwards is not closed by the late back step.
 */
export function backLayer(onBack) {
  // Overlays stack (drawer, then a sheet on top). Each one closes only when history goes below its own entry,
  // so closing a sheet does not also close the drawer under it.
  const depth = (history.state?.nbLayer || 0) + 1;
  history.pushState({ nbLayer: depth }, '');
  let done = false;
  const pop = () => {
    if (done || (history.state?.nbLayer || 0) >= depth) return;
    done = true;
    window.removeEventListener('popstate', pop);
    onBack();
  };
  window.addEventListener('popstate', pop);
  return () => new Promise((resolve) => {
    if (done) return resolve();
    done = true;
    window.removeEventListener('popstate', pop);
    const fin = () => { window.removeEventListener('popstate', fin); clearTimeout(t); resolve(); };
    const t = setTimeout(fin, 600); // safety net if no popstate arrives
    window.addEventListener('popstate', fin);
    history.back();
  });
}

/** Open a sheet with HTML; returns { close, root }. setup(root, close) wires the buttons; onClose runs once when it goes. */
export function openSheet(html, setup, onClose) {
  closeCurrent?.(true);
  sheet.innerHTML = html;
  layer.hidden = false;
  let unhook = null;
  const close = (quiet) => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    layer.hidden = true;
    sheet.innerHTML = '';
    if (quiet) onClose?.();
    else unhook().then(() => onClose?.());
  };
  closeCurrent = close;
  unhook = backLayer(() => close(true));
  setup?.(sheet, close);
  return { close, root: sheet };
}

// A tap on the dark area closes the sheet (only if the press started there).
let downOnLayer = false;
layer.addEventListener('pointerdown', (e) => { downOnLayer = e.target === layer; });
layer.addEventListener('click', (e) => { if (e.target === layer && downOnLayer) closeCurrent?.(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeCurrent) { e.preventDefault(); closeCurrent(); } });

/** True while a sheet is open. */
export const sheetOpen = () => !layer.hidden;

/**
 * A menu. items: [{label, act, danger?}] -> resolves with the chosen act or null.
 * @returns {Promise<string|null>}
 */
export function menu(title, items, sub = '') {
  return new Promise((resolve) => {
    let chosen = null;
    const html = `<h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<div class="items">${items.map((it) =>
      `<button class="item${it.danger ? ' danger' : ''}" data-act="${esc(it.act)}">${esc(it.label)}</button>`).join('')}</div>`;
    openSheet(html, (root, close) => {
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (b) { chosen = b.dataset.act; close(); }
      });
    }, () => resolve(chosen));
  });
}

/** Yes/no question. */
export function confirm(title, text, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    let answer = false;
    openSheet(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p><div class="row2"><button data-a="no">Cancel</button>`
      + `<button data-a="yes" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>`, (root, close) => {
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (b) { answer = b.dataset.a === 'yes'; close(); }
      });
    }, () => resolve(answer));
  });
}

/**
 * A searchable list (folder picker, quick open, recently deleted).
 * @param {{title: string, placeholder: string, items: (query: string) => {html: string, value: string}[], footer?: string,
 *   onFooter?: (act: string, close: Function) => void}} o
 * @returns {Promise<string|null>} the chosen value
 */
export function pick(o) {
  return new Promise((resolve) => {
    let chosen = null;
    openSheet(`<h2>${esc(o.title)}</h2><input type="search" placeholder="${esc(o.placeholder)}" autocomplete="off" spellcheck="false" enterkeyhint="go">`
      + `<div class="items"></div>${o.footer || ''}`, (root, close) => {
      const input = root.querySelector('input');
      const list = root.querySelector('.items');
      let focus = 0;
      const draw = () => {
        const rows = o.items(input.value.trim());
        focus = Math.min(focus, Math.max(0, rows.length - 1));
        list.innerHTML = rows.length ? rows.map((r, i) => `<button class="item${i === focus ? ' focus' : ''}" data-v="${esc(r.value)}">${r.html}</button>`).join('')
          : '<div class="none">Nothing found.</div>';
      };
      input.addEventListener('input', () => { focus = 0; draw(); });
      input.addEventListener('keydown', (e) => {
        const n = list.querySelectorAll('.item').length;
        if (e.key === 'ArrowDown') { focus = Math.min(n - 1, focus + 1); draw(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { focus = Math.max(0, focus - 1); draw(); e.preventDefault(); }
        if (e.key === 'Enter') { const b = list.querySelectorAll('.item')[focus]; if (b) { chosen = b.dataset.v; close(); } }
      });
      root.addEventListener('click', (e) => {
        const b = e.target.closest('.item[data-v]');
        if (b) { chosen = b.dataset.v; close(); return; }
        const f = e.target.closest('[data-footer]');
        if (f) o.onFooter?.(f.dataset.footer, close);
      });
      draw();
      if (matchMedia('(pointer: fine)').matches) input.focus(); // no keyboard pop-up on phones until tapped
    }, () => resolve(chosen));
  });
}

/**
 * Fuzzy match: the query's letters in order. Returns a score (higher is better) and the matched positions, or null.
 */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let last = -1;
  const pos = [];
  for (const ch of q) {
    const i = t.indexOf(ch, last + 1);
    if (i < 0) return null;
    score += i === last + 1 ? 5 : 1; // letters next to each other
    if (i === 0 || /[\s/._-]/.test(t[i - 1])) score += 3; // word starts
    pos.push(i);
    last = i;
  }
  return { score: score - t.length / 100, pos };
}

/** Text with the matched positions highlighted (escaped). */
export function highlight(text, pos) {
  const set = new Set(pos);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join('');
}

let toastTimer = null;
/** A short message at the bottom. */
export function toast(text, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3000);
}
document.getElementById('toast').addEventListener('click', (e) => { e.currentTarget.hidden = true; });
