// Notebook: wires the Explorer, the editor, the drawer and the menus together.

import { api } from './api.mjs';
import { Tree } from './tree.mjs';
import { Editor } from './editor.mjs';
import { menu, confirm, pick, fuzzy, highlight, toast, backLayer } from './dialogs.mjs';
import { load, renamePaths, checkStart } from './store.mjs';
import { esc } from './markdown.mjs';
import { nameProblem } from './names.mjs';

await checkStart(); // a new run of the app: forget the old UI state (it holds note names) before anything reads it

const $ = (id) => document.getElementById(id);
const app = $('app');
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

// ---------- soft keyboard: keep the layout inside the visible area, so the cursor is never hidden ----------
const vv = window.visualViewport;
function fit() {
  document.documentElement.style.setProperty('--vvh', `${Math.round(vv ? vv.height : innerHeight)}px`);
  if (scrollY || (vv && vv.offsetTop)) window.scrollTo(0, 0);
}
vv?.addEventListener('resize', fit);
vv?.addEventListener('scroll', fit);
addEventListener('resize', fit);
fit();

// ---------- drawer (portrait) / sidebar (wide) ----------
const wide = matchMedia('(min-width: 720px), (orientation: landscape) and (min-width: 600px)');
let drawerBack = null;
function openDrawer() {
  if (wide.matches || app.classList.contains('drawer-open')) return;
  app.classList.add('drawer-open');
  $('backdrop').hidden = false;
  drawerBack = backLayer(() => closeDrawer(true)); // Android back closes the drawer
}
function closeDrawer(fromBack = false) {
  if (!app.classList.contains('drawer-open')) return;
  app.classList.remove('drawer-open');
  $('backdrop').hidden = true;
  const back = drawerBack;
  drawerBack = null;
  if (!fromBack) back?.();
}
$('drawer-btn').addEventListener('click', openDrawer);
$('backdrop').addEventListener('click', () => closeDrawer());
wide.addEventListener('change', () => { if (wide.matches) closeDrawer(); });
// Swipe right from the left edge opens it, swipe left on it closes it. (The very edge is Android's back gesture.)
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const open = app.classList.contains('drawer-open');
  swipe = e.touches.length === 1 && !wide.matches && ((!open && t.clientX < 48) || (open && $('explorer').contains(e.target)))
    ? { x: t.clientX, y: t.clientY, open } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = Math.abs(t.clientY - swipe.y);
  if (!swipe.open && dx > 50 && dy < 60) openDrawer();
  if (swipe.open && dx < -70 && dy < 60 && !tree.dragged && !tree.renaming) closeDrawer();
  swipe = null;
}, { passive: true });

// ---------- Explorer and editor ----------
const tree = new Tree($('tree'), {
  open: (path) => { editor.open(path); closeDrawer(); },
  menu: (entry) => entryMenu(entry),
  move: (paths, dir) => moveItems(paths, dir),
  rename: (path, name, isNew) => renameItem(path, name, isNew),
  selection: (n) => { $('select-count').textContent = `${n} selected`; },
  error: (m) => toast(m, true),
});
const editor = new Editor({
  reveal: (dir) => { openDrawer(); tree.reveal(dir); },
  activeChanged: (path) => tree.setActive(path),
});

/** A free name in a folder: "Untitled.md", "Untitled 2.md", ... */
async function freeName(dir, stem, ext) {
  if (!tree.children.has(dir)) await tree.load(dir);
  const taken = tree.names(dir).map((n) => n.toLowerCase());
  let name = `${stem}${ext}`;
  for (let i = 2; taken.includes(name.toLowerCase()); i++) name = `${stem} ${i}${ext}`;
  return name;
}

/** New note or folder in dir, then rename it in place. */
async function newItem(dir, type) {
  try {
    if (tree.filter) { $('filter').value = ''; await tree.setFilter(''); }
    const name = await freeName(dir, type === 'file' ? 'Untitled' : 'New folder', type === 'file' ? '.md' : '');
    const { path } = await api.create(dir, name, type);
    await tree.load(dir);
    if (dir) await tree.toggle(dir, true);
    openDrawer();
    tree.startRename(path, type === 'file');
  } catch (e) {
    toast(e.message, true);
  }
}

/** Rename from the inline input. Returns false to keep editing. */
async function renameItem(path, name, isNew) {
  if (isNew && !/\.[^.\s]+$/.test(name)) name += '.md'; // a new note without an extension becomes Markdown
  const problem = nameProblem(name);
  if (problem) { toast(problem, true); return false; }
  try {
    const r = await api.rename(path, name);
    renamePaths(path, r.path);
    editor.renamed(path, r.path);
    await tree.load(parentOf(path));
    if (isNew) { editor.open(r.path); closeDrawer(); }
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

async function moveItems(paths, dir) {
  try {
    const { results } = await api.move(paths, dir);
    const bad = results.filter((r) => r.error);
    for (const r of results) if (!r.error && r.from !== r.to) { renamePaths(r.from, r.to); editor.renamed(r.from, r.to); }
    if (dir) tree.expanded.add(dir);
    if (tree.selectMode) tree.setSelectMode(false);
    await tree.refresh();
    if (bad.length) toast(bad.map((r) => `${nameOf(r.from)}: ${r.error}`).join(' '), true);
    else toast(`Moved to ${dir || 'the top level'}.`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function pickFolder(title, exclude = []) {
  let index;
  try { index = await api.index(); } catch (e) { toast(e.message, true); return null; }
  const dirs = ['', ...index.dirs].filter((d) => !exclude.some((x) => d === x || d.startsWith(`${x}/`)));
  const chosen = await pick({
    title, placeholder: 'Find a folder',
    items: (q) => dirs.filter((d) => !q || d.toLowerCase().includes(q.toLowerCase())).slice(0, 200)
      .map((d) => ({ value: d || '/', html: d ? `${esc(nameOf(d))}<span class="p">${esc(parentOf(d))}</span>` : '<b>Top level</b>' })),
  });
  return chosen === null ? null : chosen === '/' ? '' : chosen;
}

async function deleteItems(paths) {
  const what = paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`;
  if (!(await confirm(`Delete ${what}?`, 'It moves to Recently deleted, where you can restore it.', 'Delete', true))) return;
  try {
    const { results } = await api.remove(paths);
    editor.removed(results.filter((r) => !r.error).map((r) => r.from));
    if (tree.selectMode) tree.setSelectMode(false);
    await tree.refresh();
    const bad = results.filter((r) => r.error);
    toast(bad.length ? bad.map((r) => r.error).join(' ') : 'Moved to Recently deleted.', bad.length > 0);
  } catch (e) {
    toast(e.message, true);
  }
}

async function entryMenu(entry) {
  if (!entry) {
    const act = await menu('Vault', [{ label: 'New note', act: 'note' }, { label: 'New folder', act: 'folder' }]);
    if (act) newItem('', act === 'note' ? 'file' : 'dir');
    return;
  }
  if (tree.selectMode && tree.selected.size) {
    const n = tree.selected.size;
    const act = await menu(`${n} selected`, [{ label: 'Move to…', act: 'move' }, { label: 'Delete', act: 'delete', danger: true }, { label: 'Done', act: 'done' }]);
    if (act === 'move') selMove();
    if (act === 'delete') deleteItems([...tree.selected]);
    if (act === 'done') tree.setSelectMode(false);
    return;
  }
  const isDir = entry.type === 'dir';
  const items = [
    ...(isDir ? [{ label: 'New note here', act: 'note' }, { label: 'New folder here', act: 'folder' }] : [{ label: 'Open', act: 'open' }]),
    { label: 'Rename', act: 'rename' }, { label: 'Duplicate', act: 'duplicate' }, { label: 'Move to…', act: 'move' },
    { label: 'Select several', act: 'select' }, { label: 'Delete', act: 'delete', danger: true },
  ];
  const act = await menu(entry.name, items, parentOf(entry.path) || 'Top level');
  const p = entry.path;
  if (act === 'note' || act === 'folder') newItem(p, act === 'note' ? 'file' : 'dir');
  if (act === 'open') { editor.open(p); closeDrawer(); }
  if (act === 'rename') tree.startRename(p);
  if (act === 'select') tree.setSelectMode(true, p);
  if (act === 'delete') deleteItems([p]);
  if (act === 'duplicate') {
    try { await api.duplicate(p); await tree.load(parentOf(p)); tree.render(); } catch (e) { toast(e.message, true); }
  }
  if (act === 'move') {
    const dir = await pickFolder(`Move "${entry.name}" to…`, isDir ? [p] : []);
    if (dir !== null) moveItems([p], dir);
  }
}

async function selMove() {
  const paths = [...tree.selected];
  if (!paths.length) return toast('Nothing selected.');
  const dir = await pickFolder(`Move ${paths.length} items to…`, paths);
  if (dir !== null) moveItems(paths, dir);
}

async function quickOpen() {
  let index;
  try { index = await api.index(); } catch (e) { return toast(e.message, true); }
  const files = index.files.filter((f) => /\.(md|txt)$/i.test(f));
  const recent = load('recent', []).filter((p) => files.includes(p));
  const path = await pick({
    title: 'Open a note', placeholder: 'Type part of a name',
    items: (q) => {
      if (!q) return recent.map((p) => ({ value: p, html: `${esc(nameOf(p))}<span class="p">${esc(parentOf(p))}</span>` }));
      const hits = [];
      for (const f of files) {
        const name = nameOf(f);
        const m = fuzzy(q, name) || fuzzy(q, f);
        if (m) hits.push({ f, m, onName: !!fuzzy(q, name) });
      }
      hits.sort((a, b) => (b.onName - a.onName) || (b.m.score - a.m.score));
      return hits.slice(0, 40).map(({ f, m, onName }) => ({ value: f,
        html: `${onName ? highlight(nameOf(f), m.pos) : esc(nameOf(f))}<span class="p">${esc(parentOf(f))}</span>` }));
    },
  });
  if (path) { editor.open(path); closeDrawer(); }
}

async function recentlyDeleted() {
  let items;
  try { ({ items } = await api.deleted()); } catch (e) { return toast(e.message, true); }
  const id = await pick({
    title: 'Recently deleted', placeholder: 'Find by name',
    items: (q) => items.filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()))
      .map((i) => ({ value: i.id, html: `${esc(i.name)}<span class="p">${esc(parentOf(i.original) || 'top level')} · ${esc(i.when)}</span>` })),
    footer: items.length ? '<div class="row2"><button data-footer="empty" class="danger">Empty Recently deleted</button></div>' : '',
    onFooter: async (act, close) => {
      close();
      if (act !== 'empty') return;
      if (!(await confirm('Empty Recently deleted?', `${items.length} items will be gone for good.`, 'Empty', true))) return;
      try { await api.emptyDeleted(); toast('Recently deleted is empty.'); } catch (e) { toast(e.message, true); }
    },
  });
  if (!id) return;
  try {
    const r = await api.restore(id);
    await tree.refresh();
    tree.reveal(r.path);
    toast(`Restored to ${r.path}.`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- buttons ----------
$('explorer').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'new-note') newItem('', 'file');
  if (act === 'new-folder') newItem('', 'dir');
  if (act === 'quick-open') quickOpen();
  if (act === 'sel-move') selMove();
  if (act === 'sel-delete') { if (tree.selected.size) deleteItems([...tree.selected]); else toast('Nothing selected.'); }
  if (act === 'sel-done') tree.setSelectMode(false);
  if (act === 'sort') {
    const s = await menu('Sort', [{ label: `${tree.sort === 'name' ? '✓ ' : ''}By name`, act: 'name' }, { label: `${tree.sort === 'modified' ? '✓ ' : ''}By last change`, act: 'modified' }]);
    if (s) tree.setSort(s);
  }
  if (act === 'explorer-more') {
    const m = await menu('Explorer', [{ label: 'Select several', act: 'select' }, { label: 'Recently deleted', act: 'deleted' },
      { label: 'Close all folders', act: 'collapse' }, { label: 'Refresh', act: 'refresh' }]);
    if (m === 'select') tree.setSelectMode(true);
    if (m === 'deleted') recentlyDeleted();
    if (m === 'collapse') tree.collapseAll();
    if (m === 'refresh') tree.refresh().catch((err) => toast(err.message, true));
  }
});
// The select bar follows the tree's select mode.
new MutationObserver(() => { $('selectbar').hidden = !tree.selectMode; }).observe($('tree'), { childList: true });

let filterTimer = null;
$('filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => tree.setFilter($('filter').value), 150); });
$('empty-new').addEventListener('click', () => newItem('', 'file'));
$('note-more').addEventListener('click', async () => {
  const t = editor.tab;
  if (!t) return;
  const mono = load('mono', false);
  const act = await menu(nameOf(t.path), [{ label: mono ? 'Normal font' : 'Monospace font', act: 'mono' }, { label: 'Show in Explorer', act: 'reveal' },
    { label: 'Close tab', act: 'close' }, { label: 'Close other tabs', act: 'others' }]);
  if (act === 'mono') editor.setMono(!mono);
  if (act === 'reveal') { openDrawer(); tree.reveal(t.path); }
  if (act === 'close') editor.close(t.path);
  if (act === 'others') for (const o of editor.tabs.filter((x) => x.path !== t.path)) await editor.close(o.path);
});

// Ctrl/Cmd+S save, Ctrl/Cmd+P quick open, Ctrl/Cmd+E edit/preview.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); editor.saveAll(); }
  if (k === 'p') { e.preventDefault(); quickOpen(); }
  if (k === 'e') { e.preventDefault(); editor.togglePreview(); }
});

// ---------- outside changes and leaving ----------
let lastCheck = 0;
async function checkOutside() {
  if (Date.now() - lastCheck < 1500) return;
  lastCheck = Date.now();
  try { await tree.refresh(); await editor.checkOutside(); } catch (e) { toast(e.message, true); }
}
addEventListener('focus', checkOutside);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { editor.saveAll(); live?.abort(); } else { checkOutside(); follow(); }
});
addEventListener('pagehide', () => editor.saveAll());

// Changes from the hub while the page is visible (design 8.5): one long poll at a time; a change or "lost" (list
// again) runs the same check as a focus. Without the hub (plain files) this sees only this Notebook's own saves,
// so the focus check above stays.
let cursor = null;
let live = null;
async function follow() {
  if (live || document.hidden) return;
  const ac = new AbortController();
  live = ac;
  try {
    while (!ac.signal.aborted) {
      const r = await api.changes(cursor, ac.signal);
      const first = cursor === null;
      cursor = r.cursor;
      if (!first && (r.lost || r.paths.length)) { lastCheck = 0; await checkOutside(); }
    }
  } catch {
    // the server is away (restarting?) or the page went hidden: try again in 5 s while the page is visible
    if (!ac.signal.aborted) setTimeout(follow, 5000);
  } finally {
    if (live === ac) live = null;
  }
}

// ---------- start ----------
(async () => {
  try {
    await tree.init();
    await editor.restore();
    if (!editor.tabs.length && !wide.matches) openDrawer();
    follow();
  } catch (e) {
    $('tree').innerHTML = `<div class="hint">Could not load the vault: ${esc(e.message)}</div>`;
  }
})();
