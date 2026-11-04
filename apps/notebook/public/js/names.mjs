// File and folder name rules, shared by the server (authority) and the browser (instant feedback).
// Names must work on exFAT (the stick) and Windows: the vault syncs file by file and opens anywhere.

export const MAX_NAME = 200;
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why a new name is not allowed, or null if it is fine.
 * @param {string} name
 * @returns {string|null}
 */
export function nameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'The name is empty.';
  if (name.length > MAX_NAME) return `The name is too long (max ${MAX_NAME} characters).`;
  if (name === '.' || name === '..') return 'That name is not allowed.';
  const bad = name.match(BAD_CHARS);
  if (bad) return bad[0] < ' ' || bad[0] === '\u007f' ? 'The name has a control character.' : `The name cannot contain ${bad[0]}`;
  if (/[ .]$/.test(name)) return 'The name cannot end with a dot or a space.';
  if (/^ /.test(name)) return 'The name cannot start with a space.';
  if (RESERVED.test(name)) return `"${name}" is a reserved name on Windows.`;
  // The hub sync skips these endings, so such a file would never reach the stick.
  if (/\.(part|tmp)$/i.test(name)) return 'Names ending in .part or .tmp are not allowed.';
  if (name.toLowerCase() === '.deleted') return '".deleted" is used for deleted notes.';
  return null;
}

/** True if a new name is allowed. */
export const nameOk = (name) => nameProblem(name) === null;

/** True if a name exists in the list ignoring case (exFAT is case-insensitive), except `self`. */
export function caseClash(names, name, self = null) {
  const low = name.toLowerCase();
  return names.some((n) => n !== self && n.toLowerCase() === low);
}

/** Note names: .md and .txt open in the editor. */
export const isNote = (name) => /\.(md|txt)$/i.test(name);

/** Conflict copies made by the hub sync: name.conflict-20261104-120000.ext */
export const isConflict = (name) => /\.conflict-\d{8}-\d{6}(\.|$)/.test(name);
