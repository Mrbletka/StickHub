// Error answers of the data API: JSON {code, message}. Store messages are fixed texts (no paths, no values);
// anything unexpected becomes a plain 500 with no details.

import { ApiError } from './paths.mjs';

/** Store error code -> HTTP status (design 8.1 has the table). */
export const STATUS = Object.freeze({
  NOT_FOUND: 404, EXISTS: 409, CONFLICT: 409, CASE_CLASH: 409,
  NOT_DIR: 400, IS_DIR: 400, BAD_INPUT: 400, BAD_PATH: 400,
  TOO_BIG: 413, TOO_MANY_PACKS: 507,
  NEEDS_REPAIR: 503, WRITE_FAILED: 503, STORE_BROKEN: 503, CLOSED: 503,
  BAD_VX: 500, BAD_INDEX: 500, PACK_MISSING: 500,
});

/** @returns {{status: number, body: {code: string, message: string}}} */
export function errorAnswer(e) {
  if (e instanceof ApiError) return { status: e.status, body: { code: e.code, message: e.message } };
  if (e?.name === 'VaultError' && STATUS[e.code]) return { status: STATUS[e.code], body: { code: e.code, message: e.message } };
  return { status: 500, body: { code: 'INTERNAL', message: 'Something went wrong in the hub.' } };
}
