// Names and paths that sync accepts. Everything read from the stick is untrusted, so every relative path
// is checked here before it is joined to a real folder.

// exFAT and Windows cannot store these; control characters have no place in a file name.
const BAD_CHARS = /[<>:"\\|?*\u0000-\u001f\u007f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export const LIMITS = {
  segment: 120,      // characters per file or folder name
  path: 240,         // characters per relative path
  files: 20_000,     // files per scanned tree
  depth: 16,         // folder depth
  dataFile: 256 * 1024 * 1024,
  codeFile: 20 * 1024 * 1024,
};

/** Matches the conflict copies sync creates: name.conflict-20261104-120000.ext */
export const CONFLICT_RE = /\.conflict-\d{8}-\d{6}(\.[^/]*)?$/;

/**
 * True if s is a file or folder name sync accepts.
 * @param {string} s
 */
export function nameOk(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= LIMITS.segment && s !== '.' && s !== '..'
    && !BAD_CHARS.test(s) && !/[ .]$/.test(s) && !WIN_RESERVED.test(s);
}

/**
 * True if rel is a safe relative path: forward slashes, every part a good name, not too long or deep.
 * @param {string} rel
 */
export function relOk(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > LIMITS.path || rel.startsWith('/')) return false;
  const parts = rel.split('/');
  return parts.length <= LIMITS.depth && parts.every(nameOk);
}

/** Names sync never copies: temp files, VCS folders, dependency folders, OS clutter. */
export function isIgnored(name) {
  return name === '.git' || name === 'node_modules' || name === '.DS_Store' || name === 'Thumbs.db'
    || name.endsWith('.part') || name.endsWith('.tmp');
}

/**
 * The name for the second copy of a file both sides changed: keeps the extension last so the file still opens.
 * @param {string} rel  e.g. "game/save.json"
 * @param {Date} date
 * @returns {string} e.g. "game/save.conflict-20261104-120000.json"
 */
export function conflictRel(rel, date) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const slash = rel.lastIndexOf('/');
  const dir = rel.slice(0, slash + 1);
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${dir}${name.slice(0, dot)}.conflict-${stamp}${name.slice(dot)}` : `${dir}${name}.conflict-${stamp}`;
}

/** Today's trash folder name, e.g. "2026-11-04". */
export function trashDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
