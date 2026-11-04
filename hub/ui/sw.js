// Service worker: keeps the hub page available offline and shows "Hub is not running" when the hub is down.
// Network first (the hub is local and fast, so a git pull is visible at once); the cache is only the fallback.
// Bump CACHE when the SHELL list changes.

const CACHE = 'stickhub-v3';
const SHELL = ['/', '/app.css', '/app.js', '/api.js', '/player.js', '/stick.js', '/offline.html',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only our own files. The API (and its event stream) always goes straight to the network.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }
  event.respondWith(fetch(event.request)
    .then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); }
      return res;
    })
    .catch(() => caches.match(event.request).then((hit) => hit || Response.error())));
});
