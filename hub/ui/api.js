// Talking to the hub: the token (localStorage, sent as X-Hub-Token), the one-time login code from the URL,
// JSON calls, and the event stream read with fetch() (EventSource cannot send headers).

const KEY = 'stickhub.token';

/** Thrown when the hub wants a login. */
export class LoginNeeded extends Error {
  constructor(msg = 'Not logged in') { super(msg); this.login = true; }
}

/** The saved token, or null. */
export function getToken() {
  try { return localStorage.getItem(KEY); } catch { return null; } // storage blocked: behave as logged out
}

function setToken(token) {
  try { localStorage.setItem(KEY, token); } catch (e) { throw new Error(`This browser cannot save the login (${e.name}).`); }
}

/** Forget the token (it was refused). */
export function clearToken() {
  try { localStorage.removeItem(KEY); } catch { /* nothing saved, nothing to clear */ }
}

/**
 * If the URL has ?code=..., swap it for the token and remove it from the address bar.
 * @returns {Promise<string|null>} an error message to show, or null
 */
export async function loginFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return null;
  params.delete('code');
  history.replaceState(history.state, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  const res = await fetch('/api/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.token) { setToken(body.token); return null; }
  // An old link does not matter if we are already logged in.
  return getToken() ? null : (body.error || `Login failed (HTTP ${res.status})`);
}

/**
 * Call the API with the token.
 * @returns {Promise<{ok: boolean, status: number, body: any}>}
 */
export async function api(path, { method = 'GET' } = {}) {
  const token = getToken();
  if (!token) throw new LoginNeeded();
  const res = await fetch(path, { method, headers: { 'x-hub-token': token }, cache: 'no-store' });
  if (res.status === 401) { clearToken(); throw new LoginNeeded(); }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Read a server-sent event stream with fetch, reconnecting with back-off.
 * @param {string} path
 * @param {(name: string, data: any) => void} onEvent
 * @param {(state: 'open'|'down'|'login') => void} onState
 * @returns {{close: () => void}}
 */
export function openStream(path, onEvent, onState) {
  const ac = new AbortController();
  let stopped = false;
  let delay = 1000;
  (async () => {
    while (!stopped) {
      try {
        const token = getToken();
        if (!token) { onState('login'); return; }
        const res = await fetch(path, { headers: { 'x-hub-token': token }, signal: ac.signal, cache: 'no-store' });
        if (res.status === 401) { clearToken(); onState('login'); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState('open');
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let name = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) name = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) onEvent(name, JSON.parse(data)); // lines starting with ":" are heartbeats
          }
        }
        throw new Error('stream ended');
      } catch (e) {
        if (stopped) return;
        onState('down');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
      }
    }
  })();
  return { close() { stopped = true; ac.abort(); } };
}
