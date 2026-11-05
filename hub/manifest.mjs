// app.json validation. Strict: unknown keys, absolute paths, ".." and odd names are errors.
// One broken manifest must never break the hub, so this returns errors instead of throwing.

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const KEYS = new Set(['id', 'name', 'icon', 'engine', 'entry', 'port', 'args', 'env', 'version', 'description', 'spa', 'health', 'atomicData', 'data']);
/** How an app keeps its data ("data" in app.json): see dataUse(). */
export const DATA_USES = ['hubfs', 'files', 'none'];

/**
 * How an app keeps its data:
 * - "hubfs": through lib/hubfs.mjs. With the vault on it gets HUB_DATA_SOCKET + HUB_DATA_TOKEN, otherwise HUB_DATA_DIR.
 * - "files": plain files in HUB_DATA_DIR (the old way). Cannot start while the vault is on.
 * - "none": no data. The default for static apps.
 * Default for other engines: "files".
 * @param {{engine: string, data?: string}} m  a checked manifest
 */
export function dataUse(m) {
  return m.data ?? (m.engine === 'static' ? 'none' : 'files');
}
const RESERVED_ENV = /^(PORT|HUB_.*|NODE_OPTIONS)$/;
// exFAT cannot store these, and they have no place in a relative path anyway.
const BAD_CHARS = /[<>:"\\|?*\u0000-\u001f]/;

/**
 * Check that p is a safe relative path inside the app folder: forward slashes, no "..", no absolute path,
 * no characters exFAT cannot store.
 * @param {unknown} p
 * @returns {string|null} error text, or null when the path is fine
 */
export function relPathError(p) {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (p.length > 200) return 'is too long';
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'must be relative';
  if (BAD_CHARS.test(p)) return 'has a character exFAT cannot store';
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '' || s === '.')) return 'must not contain "..", "." or "//"';
  return null;
}

/**
 * Validate a parsed app.json.
 * @param {unknown} m  parsed JSON
 * @param {{folder?: string, engines?: Map<string, {validate?: Function}>}} [opts]
 *   folder: the app's folder name (must equal id); engines: known engines (unknown engine = error)
 * @returns {{ok: boolean, errors: string[], manifest: object|null}} manifest has defaults filled in
 */
export function validateManifest(m, opts = {}) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['app.json must be a JSON object'], manifest: null };
  for (const k of Object.keys(m)) if (!KEYS.has(k)) errors.push(`unknown key "${k}"`);

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push('id: use a-z, 0-9 and "-" (max 40 chars)');
  else if (opts.folder !== undefined && opts.folder !== m.id) errors.push(`id "${m.id}" must match the folder name "${opts.folder}"`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) errors.push('name: 1-40 characters');
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 200)) errors.push('description: text, max 200 characters');
  if (m.icon !== undefined) {
    const e = relPathError(m.icon);
    if (e) errors.push(`icon ${e}`);
    else if (!/\.(png|svg|webp|jpg|jpeg)$/i.test(m.icon)) errors.push('icon: use .png, .svg, .webp or .jpg');
  }
  if (typeof m.engine !== 'string' || !ID_RE.test(m.engine)) errors.push('engine: missing or not a valid name');
  else if (opts.engines && !opts.engines.has(m.engine)) errors.push(`engine "${m.engine}" is not installed`);
  if (m.entry !== undefined) { const e = relPathError(m.entry); if (e) errors.push(`entry ${e}`); }
  if (m.port !== undefined && m.port !== 'auto' && !(Number.isInteger(m.port) && m.port >= 1024 && m.port <= 65535)) {
    errors.push('port: "auto" or a number 1024-65535');
  }
  if (m.args !== undefined && (!Array.isArray(m.args) || m.args.length > 20 || m.args.some((a) => typeof a !== 'string' || a.length > 200))) {
    errors.push('args: a list of up to 20 strings');
  }
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== 'object' || Array.isArray(m.env)) errors.push('env: an object of strings');
    else {
      for (const [k, v] of Object.entries(m.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) errors.push(`env: bad name "${k}"`);
        else if (RESERVED_ENV.test(k)) errors.push(`env: "${k}" is set by the hub`);
        if (typeof v !== 'string' || v.length > 1000) errors.push(`env.${k}: must be a string`);
      }
    }
  }
  if (m.version !== undefined && (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(m.version))) {
    errors.push('version: like "1.2.3"');
  }
  if (m.spa !== undefined && typeof m.spa !== 'boolean') errors.push('spa: true or false');
  // atomicData: the app only writes its data with temp file + rename, so sync may copy it while the app runs.
  if (m.atomicData !== undefined && typeof m.atomicData !== 'boolean') errors.push('atomicData: true or false');
  if (m.data !== undefined && !DATA_USES.includes(m.data)) errors.push('data: "hubfs" (lib/hubfs.mjs), "files" (HUB_DATA_DIR) or "none"');
  if (m.health !== undefined && (typeof m.health !== 'string' || !/^\/[\w\-./]*$/.test(m.health))) errors.push('health: a path like "/health"');

  if (!errors.length && opts.engines) {
    const engine = opts.engines.get(m.engine);
    for (const e of engine?.validate?.(m) || []) errors.push(e);
  }
  if (errors.length) return { ok: false, errors, manifest: null };
  return {
    ok: true,
    errors,
    manifest: { args: [], env: {}, port: 'auto', version: '0.0.0', description: '', ...m },
  };
}
