// Clear the apps' browser storage (design 8.5): load each app's /__hub/clear in a hidden frame. The app answers with
// Clear-Site-Data: "storage", so Chrome drops that origin's localStorage, IndexedDB and the rest (UI state with note
// names). The hub asks for this (SSE "clear") right before it stops apps; job 4 calls the same function on lock.
// Best effort: a frame that does not load in 1.5 s is given up. The app page also drops its state when the app's
// start id changed (/__hub/start), for apps that crashed and never got this.

const GIVE_UP_MS = 1500;

/**
 * @param {{id: string, url: string}[]} apps  url: the app's own origin, e.g. "http://127.0.0.1:4110/"
 * @returns {Promise<void>} when every frame loaded or was given up
 */
export function clearAppStorage(apps) {
  return Promise.all(apps.map((a) => new Promise((done) => {
    let url;
    try { url = new URL('__hub/clear', a.url); } catch { done(); return; }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { done(); return; } // only our own app ports
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('sandbox', ''); // the answer is a header; no scripts needed
    const end = () => { clearTimeout(timer); frame.remove(); done(); };
    const timer = setTimeout(end, GIVE_UP_MS);
    frame.addEventListener('load', end, { once: true });
    frame.src = url.href;
    document.body.append(frame);
  }))).then(() => {});
}
