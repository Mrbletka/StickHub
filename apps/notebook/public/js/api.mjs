// Calls to the Notebook server (same origin). Errors carry the server's message.

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function call(method, path, body, signal) {
  let res;
  try {
    res = await fetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, signal,
      body: body ? JSON.stringify(body) : undefined, keepalive: method !== 'GET' && body && JSON.stringify(body).length < 60_000 });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'The Notebook server is not reachable.', null);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Error ${res.status}`, data);
  return data;
}

const q = (params) => new URLSearchParams(params).toString();
export const api = {
  list: (path) => call('GET', `api/list?${q({ path })}`),
  index: () => call('GET', 'api/index'),
  note: (path) => call('GET', `api/note?${q({ path })}`),
  stat: (path) => call('GET', `api/stat?${q({ path })}`),
  deleted: () => call('GET', 'api/deleted'),
  save: (path, content, base, force = false) => call('PUT', 'api/note', { path, content, base, force }),
  create: (dir, name, type) => call('POST', 'api/create', { dir, name, type }),
  rename: (path, name) => call('POST', 'api/rename', { path, name }),
  move: (paths, to) => call('POST', 'api/move', { paths, to }),
  duplicate: (path) => call('POST', 'api/duplicate', { path }),
  remove: (paths) => call('POST', 'api/delete', { paths }),
  restore: (id) => call('POST', 'api/restore', { id }),
  emptyDeleted: () => call('POST', 'api/empty-deleted', {}),
  /** Notes changed since a cursor (waits up to 20 s): {cursor, lost, paths}. */
  changes: (cursor, signal) => call('GET', `api/changes?${q({ cursor: cursor || '' })}`, undefined, signal),
};
