// The Explorer tree: lazy folders, remembered expand state, sort, name filter, select mode, inline rename,
// long-press menu and drag and drop. Renders visible rows as one HTML string (fast for 500+ rows).

import { api } from './api.mjs';
import { load, save } from './store.mjs';
import { esc } from './markdown.mjs';
import { nameProblem, isConflict } from './names.mjs';
import { Dnd } from './dnd.mjs';

const LONG_MS = 450;
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const icon = (name) => (/\.md$/i.test(name) ? 'i-md' : /\.txt$/i.test(name) ? 'i-txt' : 'i-file');

export class Tree {
  /**
   * @param {HTMLElement} el
   * @param {{open: (path: string) => void, menu: (entry: object|null) => void, move: (paths: string[], dir: string) => void,
   *   rename: (path: string, name: string, isNew: boolean) => Promise<boolean>, selection: (n: number) => void, error: (msg: string) => void}} hooks
   */
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks;
    this.children = new Map();
    this.expanded = new Set(load('expanded', []));
    this.sort = load('sort', 'name');
    this.filter = '';
    this.index = null;
    this.selectMode = false;
    this.selected = new Set();
    this.active = null;
    this.renaming = null;
    this.press = null;
    this.dnd = new Dnd(el, document.getElementById('ghost'), {
      canDrop: (paths, dir) => paths.every((p) => dir !== p && !dir.startsWith(`${p}/`)),
      drop: (paths, dir) => hooks.move(paths, dir),
      expand: (dir) => this.toggle(dir, true),
    });
    this.#bindPress();
  }

  /** First load: the top level and every remembered open folder. */
  async init() {
    await this.load('');
    for (const dir of [...this.expanded].sort()) {
      await this.load(dir).catch(() => this.expanded.delete(dir)); // gone since last time
    }
    this.#saveExpanded();
    this.render();
  }

  async load(dir) {
    const r = await api.list(dir);
    this.children.set(dir, r.entries);
  }

  /** Reload every loaded folder (files may have changed through the sync). */
  async refresh() {
    await Promise.all([...this.children.keys()].map((d) => this.load(d).catch((e) => {
      if (e.status !== 404 && e.status !== 400) throw e;
      this.children.delete(d);
      this.expanded.delete(d);
    })));
    if (this.filter) this.index = await api.index();
    this.#saveExpanded();
    this.render();
  }

  /** The entry for a path, if its folder is loaded. */
  entry(path) {
    return (this.children.get(parentOf(path)) || []).find((e) => e.path === path) || null;
  }

  /** Names in a loaded folder (for picking a free name). */
  names(dir) { return (this.children.get(dir) || []).map((e) => e.name); }

  /** Open or close a folder. */
  async toggle(dir, open = !this.expanded.has(dir)) {
    if (open) {
      this.expanded.add(dir);
      if (!this.children.has(dir)) {
        this.render(); // shows "Loading"
        await this.load(dir).catch((e) => { this.expanded.delete(dir); this.hooks.error(e.message); });
      }
    } else {
      this.expanded.delete(dir);
    }
    this.#saveExpanded();
    this.render();
  }

  /** Close every folder. */
  collapseAll() { this.expanded.clear(); this.#saveExpanded(); this.render(); }

  /** Open the folders above a path, mark it and scroll it into view. */
  async reveal(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      this.expanded.add(dir);
      if (!this.children.has(dir)) await this.load(dir).catch(() => {}); // missing: shows what exists
    }
    this.#saveExpanded();
    if (this.filter) this.setFilter('');
    this.render();
    const row = this.el.querySelector(`.row[data-path="${CSS.escape(path)}"]`);
    if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); }
  }

  setActive(path) { this.active = path; this.render(); }

  async setFilter(text) {
    this.filter = text.trim();
    if (this.filter && !this.index) { this.render(); this.index = await api.index().catch((e) => { this.hooks.error(e.message); return null; }); }
    if (!this.filter) this.index = null;
    this.render();
  }

  setSort(sort) { this.sort = sort; save('sort', sort); this.render(); }

  setSelectMode(on, first = null) {
    this.selectMode = on;
    this.selected = new Set(on && first ? [first] : []);
    this.hooks.selection(this.selected.size);
    this.render();
  }

  /** Show an input instead of the name. isNew: a just-made note (Enter keeps it, an empty name too). */
  startRename(path, isNew = false) {
    const name = nameOf(path);
    this.renaming = { path, isNew, value: name };
    this.render();
  }

  #sorted(entries) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return this.sort === 'modified' && a.type === 'file' ? b.mtime - a.mtime || byName(a, b) : byName(a, b);
    });
  }

  #rows() {
    if (this.filter) {
      if (!this.index) return [{ hint: 'Loading…' }];
      const f = this.filter.toLowerCase();
      const out = [];
      for (const [type, list] of [['dir', this.index.dirs], ['file', this.index.files]]) {
        for (const path of list) {
          const name = nameOf(path);
          const i = name.toLowerCase().indexOf(f);
          if (i >= 0) out.push({ path, name, type, depth: 0, sub: parentOf(path), hl: [i, i + f.length], conflict: isConflict(name) });
          if (out.length >= 300) break;
        }
      }
      return out.length ? out : [{ hint: 'No names match.' }];
    }
    const out = [];
    const walk = (dir, depth) => {
      const kids = this.children.get(dir);
      if (!kids) { out.push({ hint: 'Loading…', depth }); return; }
      for (const e of this.#sorted(kids)) {
        out.push({ ...e, depth });
        if (e.type === 'dir' && this.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk('', 0);
    return out.length ? out : [{ hint: 'Empty. Use the buttons above to make a note or a folder.' }];
  }

  render() {
    const html = this.#rows().map((r) => {
      if (r.hint) return `<div class="hint" style="padding-left:${16 + (r.depth || 0) * 16}px">${esc(r.hint)}</div>`;
      const open = r.type === 'dir' && this.expanded.has(r.path) && !this.filter;
      const cls = ['row', r.type, open ? 'open' : '', this.selected.has(r.path) ? 'sel' : '', r.path === this.active ? 'active' : ''].join(' ');
      const ic = r.type === 'dir' ? (open ? 'i-folder-open' : 'i-folder') : icon(r.name);
      let name = esc(r.name);
      if (r.hl) name = `${esc(r.name.slice(0, r.hl[0]))}<mark>${esc(r.name.slice(r.hl[0], r.hl[1]))}</mark>${esc(r.name.slice(r.hl[1]))}`;
      const label = this.renaming?.path === r.path
        ? `<input class="rename" value="${esc(this.renaming.value)}" spellcheck="false" autocomplete="off" enterkeyhint="done" aria-label="New name">`
        : `<span class="nm">${name}</span>${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}`;
      return `<div class="${cls}" data-path="${esc(r.path)}" data-type="${r.type}" style="--depth:${r.depth}" role="treeitem"${r.type === 'dir' ? ` aria-expanded="${open}"` : ''}>`
        + `${this.selectMode ? '<span class="ck"></span>' : ''}<svg class="tw"><use href="#i-chev"/></svg><svg class="ic"><use href="#${ic}"/></svg>`
        + `${label}${r.conflict ? '<svg class="cf" aria-label="Conflict copy"><use href="#i-warn"/></svg>' : ''}</div>`;
    }).join('');
    this.el.innerHTML = html;
    if (this.renaming) this.#wireRename();
  }

  #wireRename() {
    const input = this.el.querySelector('input.rename');
    if (!input) { this.renaming = null; return; }
    const r = this.renaming;
    input.focus();
    const dot = r.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 && this.entry(r.path)?.type !== 'dir' ? dot : r.value.length);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      let name = input.value.trim();
      this.renaming = null;
      if (commit && name && name !== nameOf(r.path)) {
        const ok = await this.hooks.rename(r.path, name, r.isNew);
        if (!ok) { this.renaming = { ...r, value: name }; } // keep editing after an error
      } else if (r.isNew) {
        this.hooks.open(r.path);
      }
      this.render();
    };
    input.addEventListener('input', () => {
      r.value = input.value;
      const problem = input.value.trim() ? nameProblem(input.value.trim()) : null;
      input.classList.toggle('bad', !!problem);
      input.title = problem || '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  #saveExpanded() { save('expanded', [...this.expanded]); }

  // ---------- touch and mouse ----------

  #bindPress() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const row = e.target.closest('.row');
      this.dragged = false;
      this.press = { row, path: row?.dataset.path ?? null, type: row?.dataset.type, x: e.clientX, y: e.clientY, id: e.pointerId,
        kind: e.pointerType, armed: false, dragging: false };
      row?.classList.add('pressed');
      this.press.timer = setTimeout(() => {
        const p = this.press;
        if (!p) return;
        p.armed = true;
        p.row?.classList.replace('pressed', 'lifted');
        navigator.vibrate?.(15);
      }, LONG_MS);
    });
    // Moves and the lift are watched on the window: during a drag the finger leaves rows (and rows are redrawn).
    window.addEventListener('pointermove', (e) => {
      const p = this.press;
      if (!p || e.pointerId !== p.id) return;
      if (p.dragging) { this.dnd.move(e.clientX, e.clientY); return; }
      const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.row && ((p.armed && d > 8) || (p.kind === 'mouse' && d > 6))) this.#startDrag(e);
      else if (!p.armed && d > 10) this.#endPress(); // the finger is scrolling the list
    });
    window.addEventListener('pointerup', (e) => {
      const p = this.press;
      if (!p || e.pointerId !== p.id) return;
      this.#endPress();
      if (p.dragging) return this.dnd.end();
      if (p.armed) return this.hooks.menu(p.path ? this.#entryOf(p) : null);
      if (p.row) this.#tap(p);
    });
    window.addEventListener('pointercancel', (e) => {
      if (this.press?.id !== e.pointerId) return;
      if (this.press.dragging) this.dnd.cancel();
      this.#endPress();
    });
    // While a long-press is armed or dragging, the list must not scroll under the finger.
    el.addEventListener('touchmove', (e) => { if (this.press?.armed || this.press?.dragging) e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // touch: the long-press above handles it; mouse: right-click opens the menu
      if (this.lastKind !== 'mouse') return;
      const row = e.target.closest('.row');
      this.hooks.menu(row ? this.#entryOf({ path: row.dataset.path, type: row.dataset.type }) : null);
    });
    el.addEventListener('pointerdown', (e) => { this.lastKind = e.pointerType; }, true);
  }

  #entryOf(p) { return this.entry(p.path) || { path: p.path, name: nameOf(p.path), type: p.type }; }

  #endPress() {
    const p = this.press;
    if (!p) return;
    clearTimeout(p.timer);
    p.row?.classList.remove('pressed', 'lifted');
    this.press = null;
  }

  #startDrag(e) {
    const p = this.press;
    clearTimeout(p.timer);
    p.dragging = true;
    this.dragged = true; // main.mjs: a drag is not a swipe
    p.row?.classList.remove('pressed', 'lifted');
    const paths = this.selectMode && this.selected.has(p.path) ? [...this.selected] : [p.path];
    this.dnd.start(paths, paths.length > 1 ? `${paths.length} items` : nameOf(p.path), e.clientX, e.clientY);
  }

  #tap(p) {
    if (this.selectMode) {
      if (this.selected.has(p.path)) this.selected.delete(p.path); else this.selected.add(p.path);
      this.hooks.selection(this.selected.size);
      this.render();
    } else if (p.type === 'dir') {
      if (this.filter) this.reveal(p.path); else this.toggle(p.path);
    } else {
      this.hooks.open(p.path);
    }
  }
}
