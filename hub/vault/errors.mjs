// Errors from the vault crypto. A message is fixed text plus field names or counts: never a key, a passphrase, a
// paper code, a salt, a nonce or any other value from the input. Callers may show `message` and log `code`.

/**
 * Error codes:
 *   BAD_INPUT        a caller passed something of the wrong type or size (a bug, not bad data)
 *   BAD_HEADER       vault.json is not valid (JSON, schema, sizes); checked before any key work
 *   UNSUPPORTED      made by a newer StickHub (a version this code does not know)
 *   KDF_LIMITS       KDF settings outside the limits (refused before running the KDF)
 *   KDF_FAILED       the KDF itself failed (for example out of memory)
 *   WRONG_SECRET     the passphrase or paper code does not open this slot (or the slot was changed)
 *   BAD_MAC          the header was changed after it was written
 *   BAD_CODE         the paper code has a typo or a wrong character (caught before any key work)
 *   WEAK_PASSPHRASE  an own passphrase that is too short
 *   BAD_VX           an encrypted file is damaged, cut short, renamed or not for this key
 *   TOO_BIG          more data than the limit allows
 * The store (step 2) adds:
 *   NO_VAULT, NO_INDEX  no header / no readable index in the folder; BAD_INDEX  an index failed its checks
 *   NOT_FOUND, EXISTS, CONFLICT (ifMatch), NOT_DIR, IS_DIR, BAD_PATH, CASE_CLASH  file operations
 *   TOO_MANY_PACKS   compaction needed; WRITE_FAILED  a write failed (stick pulled?): the store is now broken
 *   STORE_BROKEN     a write failed earlier: open the vault again; CLOSED  the store was closed (locked)
 */
export class VaultError extends Error {
  /**
   * @param {string} code  one of the codes above
   * @param {string} message  safe text for the user
   */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * Throw a VaultError.
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
export function fail(code, message) {
  throw new VaultError(code, message);
}

/**
 * A file-system error (a pulled stick, a full disk) as a VaultError WRITE_FAILED. Only the error code is kept: the
 * original message holds a file path. VaultErrors pass through unchanged.
 * @param {unknown} e
 * @returns {VaultError}
 */
export function ioError(e) {
  if (e instanceof VaultError) return e;
  const err = new VaultError('WRITE_FAILED', 'Saving to the vault failed (was the stick pulled?). Open the vault again.');
  err.cause = { code: e?.code };
  return err;
}
