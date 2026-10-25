/* HK Bus Finder — offline shell.
   Only the app shell is cached. The live transport feeds are deliberately
   left alone: a stale arrival time is worse than no arrival time, and the
   data layer in ./data already caches upstream responses with short,
   honest TTLs. */

const CACHE = 'hkbus-shell-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './data/api.mjs',
  './data/domain.mjs',
  './data/upstream.mjs',
  './data/storage.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Cross-origin calls are the live transport feeds; never intercept them.
  if (url.origin !== self.location.origin) return;

  // Network first so an updated build is picked up straight away, with the
  // cached shell as the offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match('./index.html')),
      ),
  );
});
