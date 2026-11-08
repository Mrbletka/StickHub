// UI state in localStorage (per origin: the Notebook has a fixed port). Never in the notes: UI state is not data.
// It holds note names, so it lives only as long as one run of the app: the hub clears it (Clear-Site-Data from
// /__hub/clear) before it stops the app, and checkStart() drops it when the app started anew (a crash).

/** Read a saved value (fallback when missing, broken or storage is blocked). */
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(`nb.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** Save a value; failure only costs the remembered UI state. */
export function save(key, value) {
  try { localStorage.setItem(`nb.${key}`, JSON.stringify(value)); } catch (e) { console.warn(`could not save ${key}: ${e.name}`); }
}

/** Remember a recently opened note (newest first, max 20). */
export function addRecent(path) {
  save('recent', [path, ...load('recent', []).filter((p) => p !== path)].slice(0, 20));
}

/** Change saved paths after a rename or move (expanded folders, tabs, recents). */
export function renamePaths(from, to) {
  const fix = (p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  save('expanded', load('expanded', []).map(fix));
  save('recent', load('recent', []).map(fix));
}

/**
 * Drop the UI state if the app started anew since it was saved (its start id from /__hub/start changed). Run it
 * before anything reads the state. If the server cannot say (an old server), the state stays.
 */
export async function checkStart() {
  let id;
  try { id = (await (await fetch('__hub/start', { cache: 'no-store' })).json()).startId; } catch { return; }
  if (typeof id !== 'string') return;
  try {
    if (localStorage.getItem('nb.start') === id) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith('nb.')) localStorage.removeItem(k);
    localStorage.setItem('nb.start', id);
  } catch { /* storage blocked: there is nothing to drop */ }
}
