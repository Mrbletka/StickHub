// StickHub UI. Vanilla JS: state comes from /api/events (read with fetch), actions are POSTs with the token.
// Tap a tile = start (if needed) and open it in the player. Long-press (or right-click) = menu.

import { chipFor, fillStickSheet, esc } from './stick.js';
import { api, openStream, loginFromUrl, getToken, LoginNeeded } from './api.js';
import { createPlayer } from './player.js';
import { clearAppStorage } from './clear.js';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const chip = $('#chip');
const menu = $('#menu');
const logs = $('#logs');
const stickSheet = $('#stick');

/** @type {Map<string, object>} app id -> public app view from the server */
const apps = new Map();
let menuId = null;
let hubStatus = null;
let events = null;
let logsFor = null;
const player = createPlayer({ root: $('#player'), onClose: () => render() });
const LONG_PRESS_MS = 450;


const STATUS_TEXT = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', error: 'Error' };

function iconHtml(app) {
  return app.hasIcon
    ? `<img src="/api/apps/${encodeURIComponent(app.id)}/icon" alt="" draggable="false">`
    : esc((app.name || app.id).slice(0, 1).toUpperCase());
}

function subText(app) {
  if (app.problems.length) return 'Broken: tap for details';
  if (app.status === 'error') return 'Error: tap for details';
  if (hubStatus?.stick?.pending?.includes(app.id)) return app.status === 'running' ? 'Running · data waits' : 'Data waits for sync';
  return app.status === 'stopped' ? '' : STATUS_TEXT[app.status];
}

// ---------- rendering ----------

function render() {
  const list = [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('#empty').hidden = list.length > 0;
  // Re-use tile elements so a press in progress is not lost when a status update arrives.
  const keep = new Set();
  for (const app of list) {
    let el = grid.querySelector(`[data-id="${CSS.escape(app.id)}"]`);
    if (!el) {
      el = document.createElement('button');
      el.className = 'tile';
      el.dataset.id = app.id;
      bindPress(el);
    }
    el.classList.toggle('broken', app.problems.length > 0 || app.status === 'error');
    el.setAttribute('aria-label', `${app.name}, ${STATUS_TEXT[app.status]}`);
    // Only rebuild the tile when something visible changed (keeps the icon image from reloading).
    const key = JSON.stringify([app.status, app.name, app.hasIcon, subText(app)]);
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.innerHTML = `<span class="dot ${esc(app.status)}"></span><span class="icon">${iconHtml(app)}</span>`
        + `<span class="name">${esc(app.name)}</span><span class="sub">${esc(subText(app))}</span>`;
    }
    grid.appendChild(el); // appending an existing node moves it: keeps the sort order
    keep.add(el);
  }
  for (const el of [...grid.children]) if (!keep.has(el)) el.remove();
  if (menu.open && menuId) fillMenu(apps.get(menuId));
  if (hubStatus) setChip(hubStatus);
}

function fillMenu(app) {
  if (!app) { menu.close(); return; }
  $('#menu-icon').innerHTML = iconHtml(app);
  $('#menu-name').textContent = app.name;
  $('#menu-status').textContent = [STATUS_TEXT[app.status], app.port ? `port ${app.port}` : '', app.engine, app.version ? `v${app.version}` : '']
    .filter(Boolean).join(' · ');
  const err = app.problems.length ? app.problems.join('\n') : app.error;
  $('#menu-error').hidden = !err;
  $('#menu-error').textContent = err || '';
  const busy = app.status === 'starting' || app.status === 'stopping';
  const broken = app.problems.length > 0;
  menu.querySelector('[data-act="open"]').disabled = busy || broken;
  menu.querySelector('[data-act="open"]').textContent = app.status === 'running' ? 'Open' : 'Start and open';
  menu.querySelector('[data-act="stop"]').disabled = app.status !== 'running';
  menu.querySelector('[data-act="restart"]').disabled = busy || broken || app.status !== 'running';
}

// ---------- actions ----------

async function post(id, action) {
  const { ok, status, body } = await api(`/api/apps/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  if (body.app || body.id) apps.set(id, body.app || body);
  render();
  if (!ok) throw new Error(body.error || `HTTP ${status}`);
  return body;
}

async function openApp(id) {
  const app = apps.get(id);
  if (!app) return;
  if (app.problems.length) { showMenu(id); return; }
  try {
    const view = app.status === 'running' ? app : await post(id, 'start');
    player.open(view);
  } catch (e) {
    if (e instanceof LoginNeeded) return showLocked();
    toast(`${app.name} did not start: ${e.message}`);
  }
}

async function act(action) {
  const id = menuId;
  if (!id) return;
  if (action === 'close') return menu.close();
  if (action === 'open') { menu.close(); return openApp(id); }
  if (action === 'logs') { menu.close(); return showLogs(id); }
  try { await post(id, action); } catch (e) { if (e instanceof LoginNeeded) showLocked(); else toast(e.message); }
}

function showMenu(id) {
  menuId = id;
  fillMenu(apps.get(id));
  if (!menu.open) menu.showModal();
  navigator.vibrate?.(12);
}

// ---------- logs ----------

function showLogs(id) {
  const app = apps.get(id);
  $('#logs-name').textContent = `Logs: ${app?.name || id}`;
  $('#logs-text').innerHTML = '';
  logs.showModal();
  connect(id); // a second stream that also carries this app's log lines
}

function addLogLine(entry) {
  const pre = $('#logs-text');
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  const time = new Date(entry.t).toTimeString().slice(0, 8);
  pre.insertAdjacentHTML('beforeend', `<span class="${esc(entry.s)}">${time} ${esc(entry.text)}</span>\n`);
  // Each line is a <span> plus a newline text node: drop both for the oldest lines.
  while (pre.childElementCount > 600) { pre.firstElementChild.remove(); if (pre.firstChild?.nodeType === Node.TEXT_NODE) pre.firstChild.remove(); }
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

// ---------- server events ----------

function connect(forApp = null) {
  events?.close();
  logsFor = forApp;
  events = openStream(forApp ? `/api/events?logs=${encodeURIComponent(forApp)}` : '/api/events', onEvent, (state) => {
    if (state === 'login') showLocked();
    else if (state === 'down') { chip.textContent = 'Hub not reachable'; chip.className = 'chip bad'; }
  });
}

function onEvent(name, data) {
  if (name === 'clear') { clearAppStorage(data); return; } // the hub stops these apps in a moment
  if (name === 'apps') {
    apps.clear();
    for (const a of data) apps.set(a.id, a);
    render();
  } else if (name === 'app') {
    apps.set(data.id, data);
    // The app on screen stopped (crash, Stop from elsewhere): leave the player and say why.
    if (player.current === data.id && data.status !== 'running' && data.status !== 'stopping') {
      player.goHome();
      toast(`${data.name} stopped${data.error ? `: ${data.error}` : '.'}`);
    }
    render();
  } else if (name === 'status') {
    const prev = hubStatus?.stick?.state;
    hubStatus = data;
    showLive(data.live);
    if (prev && prev !== 'connected' && hubStatus.stick?.state === 'connected') flashChip();
    render();
    if (stickSheet.open) fillStickSheet($, hubStatus.stick);
  } else if (name === 'log') {
    if (logs.open && data.id === logsFor) addLogLine(data);
  }
}

// Data on the stick: without the stick no app can run. "Stick removed" after a pull, "Plug in the stick" before
// the first plug-in. The hub keeps running, so this screen goes away by itself when the stick is back.
function showLive(live) {
  const show = !!live?.on && !live.attached;
  $('#removed').hidden = !show;
  if (!show) return;
  player.close();
  for (const d of [menu, logs, stickSheet]) if (d.open) d.close();
  $('#removed-title').textContent = live.removed ? 'Stick removed' : 'Plug in the stick';
  $('#removed-text').textContent = live.removed
    ? 'Your app data is on the stick, so the apps were stopped. Apps save in one step (temp file, then rename), so no file is left half written.'
    : 'Your app data is on the stick. Plug it in to start your apps.';
}

function showLocked(message) {
  events?.close();
  events = null;
  player.close();
  for (const d of [menu, logs, stickSheet]) if (d.open) d.close();
  $('#locked').hidden = false;
  $('#app-main').hidden = true;
  chip.textContent = 'Locked';
  chip.className = 'chip warn';
  if (message) $('#locked-error').textContent = message;
}

function setChip(status) {
  const running = [...apps.values()].filter((a) => a.status === 'running').length;
  const { text, cls } = chipFor(status.stick, running, status.live);
  chip.textContent = text;
  chip.className = `chip ${cls}${chip.classList.contains('flash') ? ' flash' : ''}`;
}

// Short "Stick connected" animation on plug-in.
function flashChip() {
  chip.classList.remove('flash');
  void chip.offsetWidth; // restart the CSS animation
  chip.classList.add('flash');
  setTimeout(() => chip.classList.remove('flash'), 1500);
}

async function stickAction(act) {
  if (act === 'close') return stickSheet.close();
  try {
    const { ok, status, body } = await api(act === 'sync' ? '/api/sync' : '/api/sync/cancel', { method: 'POST' });
    if (!ok) toast(body.error || `HTTP ${status}`);
  } catch (e) {
    if (e instanceof LoginNeeded) showLocked(); else throw e;
  }
}

// ---------- press handling: tap vs long-press, touch and mouse ----------

function bindPress(el) {
  let timer = null;
  let long = false;
  let x = 0, y = 0;
  const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('pressed'); };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    long = false; x = e.clientX; y = e.clientY;
    el.classList.add('pressed');
    timer = setTimeout(() => { long = true; cancel(); showMenu(el.dataset.id); }, LONG_PRESS_MS);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, () => { if (timer) cancel(); });
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (long) { long = false; return; } // the long-press already opened the menu
    openApp(el.dataset.id);
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); long = true; showMenu(el.dataset.id); });
}

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// A tap on the backdrop closes a sheet, but only if the press also started there: the finger that
// long-pressed a tile lifts on top of the new backdrop and must not close the menu it just opened.
function closeOnBackdrop(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && downOnBackdrop) dialog.close();
    downOnBackdrop = false;
  });
}
closeOnBackdrop(menu);
closeOnBackdrop(logs);
closeOnBackdrop(stickSheet);

chip.addEventListener('click', () => {
  if (!getToken()) return;
  fillStickSheet($, hubStatus?.stick);
  stickSheet.showModal();
});
stickSheet.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) stickAction(btn.dataset.act).catch((err) => toast(err.message));
});

menu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) act(btn.dataset.act);
});
menu.addEventListener('close', () => { menuId = null; });
logs.addEventListener('click', (e) => {
  if (e.target.closest('button[data-act="close"]')) logs.close();
});
logs.addEventListener('close', () => connect()); // back to the stream without logs
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

// Coming back to the page from the bfcache: reconnect.
window.addEventListener('pageshow', (e) => { if (e.persisted && getToken()) connect(); });

// Installable app + offline page. Works on http://127.0.0.1 (counts as a secure origin).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn(`service worker: ${e.message}`));
}

async function start() {
  const error = await loginFromUrl().catch((e) => e.message);
  if (!getToken()) return showLocked(error);
  connect();
}
start();
