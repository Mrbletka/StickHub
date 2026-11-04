// UI state in localStorage (per origin: the Notebook has a fixed port, so this survives restarts).
// Never in vault files: those would sync to the stick.

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
