// Tabs and the editor: autosave 800 ms after typing stops and when the page is hidden, a save indicator,
// Edit/Preview, breadcrumbs, and a "changed elsewhere" bar when the sync changed a note you are editing.

import { api } from './api.mjs';
import { load, save, addRecent } from './store.mjs';
import { render, esc } from './markdown.mjs';
import { toast } from './dialogs.mjs';

const IDLE_MS = 800;
const $ = (id) => document.getElementById(id);
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

export class Editor {
  /** @param {{reveal: (path: string) => void, activeChanged: (path: string|null) => void}} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.tabs = [];
    this.current = null;
    this.timer = null;
    this.ta = $('editor');
    this.pv = $('preview');
    this.ta.classList.toggle('mono', load('mono', false));
    this.ta.addEventListener('input', () => this.#typed());
    $('tabs').addEventListener('click', (e) => this.#tabClick(e));
    $('crumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-dir]'); if (b) this.hooks.reveal(b.dataset.dir); });
    $('mode-btn').addEventListener('click', () => this.togglePreview());
    $('changed').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) this.#resolveConflict(b.dataset.act); });
    this.pv.addEventListener('click', (e) => this.#previewClick(e));
  }

  get tab() { return this.tabs.find((t) => t.path === this.current) || null; }

  /** Reopen the tabs from last time. */
  async restore() {
    const paths = load('tabs', []);
    for (const p of paths) await this.open(p, { quiet: true, activate: false });
    const active = load('active', null);
    this.activate(this.tabs.some((t) => t.path === active) ? active : this.tabs[0]?.path ?? null);
  }

  /** Open a note in a tab (or switch to it). */
  async open(path, { quiet = false, activate = true } = {}) {
    if (!this.tabs.some((t) => t.path === path)) {
      try {
        const n = await api.note(path);
        this.tabs.push({ path, content: n.content, version: n.version, dirty: false, conflict: false, preview: false, scroll: 0, sel: [0, 0], state: '' });
      } catch (e) {
        if (!quiet) toast(e.message, true);
        return;
      }
    }
    addRecent(path);
    if (activate) this.activate(path);
    this.#persist();
  }

  /** Show a tab. */
  activate(path) {
    const old = this.tab;
    if (old) { old.scroll = (old.preview ? this.pv : this.ta).scrollTop; old.sel = [this.ta.selectionStart, this.ta.selectionEnd]; }
    this.current = path;
    const t = this.tab;
    $('empty').hidden = !!t;
    this.ta.hidden = !t || t.preview;
    this.pv.hidden = !t || !t.preview;
    $('mode-btn').hidden = !t;
    $('note-more').hidden = !t;
    if (t) {
      this.ta.value = t.content;
      if (t.preview) this.#renderPreview(); else { this.ta.setSelectionRange(...t.sel); }
      (t.preview ? this.pv : this.ta).scrollTop = t.scroll;
    }
    this.#drawTabs();
    this.#drawCrumbs();
    this.#drawStatus();
    $('changed').hidden = !t?.conflict;
    $('mode-btn').textContent = t?.preview ? 'Edit' : 'Preview';
    this.hooks.activeChanged(path);
    this.#persist();
  }

  /** Close a tab (saves it first). */
  async close(path) {
    const t = this.tabs.find((x) => x.path === path);
    if (!t) return;
    if (t.dirty && !t.conflict) await this.save(t);
    if (t.dirty && !t.conflict && t.state === 'error') { toast('Not saved yet, so the tab stays open.', true); return; }
    const i = this.tabs.indexOf(t);
    this.tabs.splice(i, 1);
    if (this.current === path) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]?.path ?? null);
    else this.#drawTabs();
    this.#persist();
  }

  togglePreview() {
    const t = this.tab;
    if (!t) return;
    t.preview = !t.preview;
    this.activate(t.path);
  }

  setMono(on) { save('mono', on); this.ta.classList.toggle('mono', on); }

  // ---------- saving ----------

  #typed() {
    const t = this.tab;
    if (!t) return;
    t.content = this.ta.value;
    if (!t.dirty) { t.dirty = true; this.#drawTabs(); }
    t.state = 'typing';
    this.#drawStatus();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(t), IDLE_MS);
  }

  /** Save one tab if it has changes. A note changed elsewhere is not overwritten unless force. */
  async save(t, force = false) {
    if (!t.dirty || (t.conflict && !force)) return;
    if (t.saving) { t.again = true; return t.saving; }
    const sent = t.content;
    t.state = 'saving';
    this.#drawStatus();
    t.saving = api.save(t.path, sent, t.version, force).then((r) => {
      t.version = r.version;
      t.conflict = false;
      if (t.content === sent) { t.dirty = false; t.state = 'saved'; } else t.state = 'typing';
    }).catch((e) => {
      if (e.status === 409) { t.conflict = true; t.state = 'conflict'; } else { t.state = 'error'; t.error = e.message; }
    }).finally(() => {
      t.saving = null;
      if (t.path === this.current) { $('changed').hidden = !t.conflict; }
      this.#drawTabs();
      this.#drawStatus();
      if (t.again || (t.dirty && t.state === 'typing')) { t.again = false; clearTimeout(this.timer); this.timer = setTimeout(() => this.save(t), IDLE_MS); }
    });
    return t.saving;
  }

  /** Save everything now (page hidden, closing, Ctrl+S). */
  saveAll() {
    clearTimeout(this.timer);
    return Promise.all(this.tabs.filter((t) => t.dirty).map((t) => this.save(t)));
  }

  // ---------- changes from outside (the sync, another device) ----------

  /** Compare open notes with the files. Clean notes reload; edited ones get the "changed elsewhere" bar. */
  async checkOutside() {
    for (const t of [...this.tabs]) {
      if (t.saving) continue;
      let s;
      try { s = await api.stat(t.path); } catch { continue; } // server busy or gone: try next time
      if (!s.exists) {
        if (!t.dirty) { toast(`"${nameOf(t.path)}" is gone (deleted or moved elsewhere).`); await this.close(t.path); }
        continue;
      }
      if (s.version === t.version) continue;
      if (t.dirty) { t.conflict = true; t.state = 'conflict'; } else {
        const n = await api.note(t.path).catch(() => null);
        if (!n) continue;
        t.content = n.content;
        t.version = n.version;
        if (t.path === this.current) {
          const [a, b] = [this.ta.selectionStart, this.ta.selectionEnd];
          this.ta.value = n.content;
          this.ta.setSelectionRange(Math.min(a, n.content.length), Math.min(b, n.content.length));
          if (t.preview) this.#renderPreview();
        }
      }
    }
    const t = this.tab;
    $('changed').hidden = !t?.conflict;
    this.#drawTabs();
    this.#drawStatus();
  }

  async #resolveConflict(act) {
    const t = this.tab;
    if (!t) return;
    if (act === 'mine') { t.dirty = true; await this.save(t, true); return; }
    const n = await api.note(t.path).catch((e) => { toast(e.message, true); return null; });
    if (!n) return;
    Object.assign(t, { content: n.content, version: n.version, dirty: false, conflict: false, state: 'saved' });
    this.activate(t.path);
  }

  // ---------- paths changed in the Explorer ----------

  /** A file or folder was renamed or moved. */
  renamed(from, to) {
    for (const t of this.tabs) {
      if (t.path === from || t.path.startsWith(`${from}/`)) {
        const np = to + t.path.slice(from.length);
        if (this.current === t.path) this.current = np;
        t.path = np;
      }
    }
    this.#drawTabs();
    this.#drawCrumbs();
    this.#persist();
  }

  /** Files or folders were deleted: close their tabs without saving. */
  removed(paths) {
    for (const p of paths) {
      for (const t of this.tabs.filter((x) => x.path === p || x.path.startsWith(`${p}/`))) {
        t.dirty = false;
        this.close(t.path);
      }
    }
  }

  // ---------- drawing ----------

  #drawTabs() {
    $('tabs').innerHTML = this.tabs.map((t) => `<button class="tab${t.path === this.current ? ' active' : ''}" role="tab" data-path="${esc(t.path)}" title="${esc(t.path)}">`
      + `<span class="tn">${esc(nameOf(t.path))}</span><span class="tx" data-close="1" aria-label="Close">`
      + `${t.dirty ? '<span class="dot"></span>' : '<svg><use href="#i-close"/></svg>'}</span></button>`).join('');
    $('tabs').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  #tabClick(e) {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (e.target.closest('[data-close]')) this.close(tab.dataset.path); else this.activate(tab.dataset.path);
  }

  #drawCrumbs() {
    const t = this.tab;
    if (!t) { $('crumbs').innerHTML = ''; return; }
    const parts = t.path.split('/');
    $('crumbs').innerHTML = parts.map((p, i) => (i === parts.length - 1 ? `<span class="cur">${esc(p)}</span>`
      : `<button data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button><span class="s">›</span>`)).join('');
  }

  #drawStatus() {
    const t = this.tab;
    const el = $('status');
    const text = !t ? '' : { typing: 'Editing…', saving: 'Saving…', saved: 'Saved', conflict: 'Changed elsewhere', error: 'Not saved' }[t.state] || '';
    el.textContent = text;
    el.title = t?.state === 'error' ? t.error : '';
    el.className = `status${t?.state === 'error' || t?.state === 'conflict' ? ' bad' : t?.state === 'saved' ? ' ok' : ''}`;
  }

  #renderPreview() {
    const t = this.tab;
    const md = /\.md$/i.test(t.path);
    this.pv.classList.toggle('plain', !md);
    this.pv.innerHTML = md ? render(t.content) : esc(t.content);
  }

  // Checkboxes change their source line; note links open the note (relative to this note's folder).
  #previewClick(e) {
    const t = this.tab;
    const box = e.target.closest('input[type=checkbox][data-line]');
    if (box && t) {
      const lines = t.content.split('\n');
      const i = Number(box.dataset.line);
      lines[i] = lines[i].replace(/\[( |x|X)\]/, box.checked ? '[x]' : '[ ]');
      this.ta.value = lines.join('\n');
      this.#typed();
      this.#renderPreview();
      return;
    }
    const a = e.target.closest('a[data-note]');
    if (a && t) {
      e.preventDefault();
      const base = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')).split('/') : [];
      for (const part of a.dataset.note.split('#')[0].split('/')) {
        let p = part;
        try { p = decodeURIComponent(part); } catch { /* not %-encoded: use as written */ }
        if (p === '..') base.pop(); else if (p && p !== '.') base.push(p);
      }
      this.open(base.join('/'));
    }
  }

  #persist() {
    save('tabs', this.tabs.map((t) => t.path));
    save('active', this.current);
  }
}
