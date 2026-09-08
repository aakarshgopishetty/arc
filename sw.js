// ARC PWA Service Worker
// Strategy: cache-first for the app shell (HTML/CSS/JS/icons/manifest),
// network-first (no caching) for everything else — especially API calls
// to Gemini, since those are dynamic and must never be served stale
// or stored in a cache that could linger with sensitive data.

const CACHE_VERSION = 'arc-shell-v2'; // bump this string on every deploy that changes cached files
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

// Hosts that should NEVER be cached (API calls, dynamic data)
const NEVER_CACHE_HOSTS = [
  'generativelanguage.googleapis.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // activate new SW as soon as it's installed
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // take control of open tabs immediately
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept non-GET requests (POST to your future backend, etc.)
  if (event.request.method !== 'GET') return;

  // Never cache API calls — always go to network
  if (NEVER_CACHE_HOSTS.some((host) => url.hostname.includes(host))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: cache-first, falling back to network, and updating the
  // cache in the background so the next load picks up changes.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          // Only cache successful, same-origin responses
          if (response && response.ok && url.origin === self.location.origin) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached -> nothing we can do

      return cached || networkFetch;
    })
  );
});