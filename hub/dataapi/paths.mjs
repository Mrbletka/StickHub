// App paths for the data API (design 8.1). An app names files relative to its own folder; the server checks the
// path, then prefixes "<appId>/". An app can never name another app's folder: ".." and absolute paths are refused,
// and a path that starts with another app's id simply lands inside the caller's folder.

import { relOk, LIMITS } from '../sync/safe-path.mjs';

/** App ids the API accepts (the hub's app folder names). */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An error the API answers with: HTTP status, a code and a fixed message (never a path or a value). */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badPath = () => { throw new ApiError(400, 'BAD_PATH', 'That is not a valid path.'); };

/**
 * The vault path for an app path.
 * @param {string} appId
 * @param {unknown} rel  e.g. "notes/a.md"
 * @returns {string} e.g. "notebook/notes/a.md"
 */
export function toVault(appId, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > LIMITS.path - appId.length - 1) badPath();
  if (rel.startsWith('/') || rel.includes('\\') || /[\u0000-\u001f\u007f]/.test(rel)) badPath();
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) badPath();
  const full = `${appId}/${rel}`;
  if (!relOk(full)) badPath();
  return full;
}

/** The app path for a vault path inside the app's folder. */
export const fromVault = (appId, p) => p.slice(appId.length + 1);
