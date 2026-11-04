// The player: shows a running app full screen in an iframe, with a small floating Home button.
// The app keeps its own origin (its own port), so it cannot read the hub's token or storage.
// Same host as the hub, so Chrome does not partition the app's storage (same site).
// Android back = Home (the player adds a history entry).

const POS_KEY = 'stickhub.homeButton';
// What an app may do inside the player. No top navigation: an app cannot replace the hub page.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock allow-orientation-lock allow-presentation';
const ALLOW = 'fullscreen; autoplay; gamepad; screen-wake-lock; clipboard-write; accelerometer; gyroscope';

/**
 * @param {{root: HTMLElement, onClose?: () => void}} o  root: the #player element
 */
export function createPlayer(o) {
  const home = o.root.querySelector('.home');
  let current = null;
  let frame = null;

  function open(app) {
    current = app.id;
    // A new iframe each time: changing the src of an old one would add a browser history entry,
    // and then Android back would step inside the frame instead of going Home.
    frame?.remove();
    frame = document.createElement('iframe');
    frame.title = app.name;
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', ALLOW);
    frame.src = app.url;
    o.root.prepend(frame);
    o.root.hidden = false;
    document.body.classList.add('playing');
    history.pushState({ player: app.id }, '');
    // Full screen hides the phone's status and navigation bars. It needs a recent tap, so it may be refused.
    o.root.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    frame.focus();
  }

  function close() {
    if (!current) return;
    current = null;
    frame?.remove();
    frame = null;
    o.root.hidden = true;
    document.body.classList.remove('playing');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    o.onClose?.();
  }

  /** Home: go back in history (closes via popstate), or close directly if our entry is gone. */
  function goHome() {
    if (history.state?.player) history.back(); else close();
  }

  window.addEventListener('popstate', (e) => { if (current && e.state?.player !== current) close(); });

  // The Home button can be dragged out of the way; a short tap goes home. Its place is remembered.
  let drag = null;
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) place(p.x, p.y);
  } catch { /* no saved place: default corner */ }
  function place(x, y) {
    const max = (n, size) => Math.max(4, Math.min(n, size - 52));
    home.style.left = `${max(x, innerWidth)}px`;
    home.style.top = `${max(y, innerHeight)}px`;
  }
  home.addEventListener('pointerdown', (e) => {
    const r = home.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
    home.setPointerCapture(e.pointerId);
  });
  home.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) drag.moved = true;
    if (drag.moved) place(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  home.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return goHome();
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: parseInt(home.style.left, 10), y: parseInt(home.style.top, 10) })); } catch { /* not saved: fine */ }
  });
  home.addEventListener('pointercancel', () => { drag = null; });

  return {
    open, close, goHome,
    /** The id of the app on screen, or null. */
    get current() { return current; },
  };
}
