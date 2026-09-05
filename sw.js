// Service worker: cache the app shell so the tracker works fully offline.
// Bump VERSION on every deploy so clients pick up new files.
const VERSION = 'ct-v34';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/models.js',
  './js/label-overrides.js',
  './js/yields.js',
  './js/scanner.js',
  './zxing-wasm/zxing-reader.js',
  './zxing-wasm/zxing_reader.wasm',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the browser's HTTP cache — plain addAll can fill a
  // NEW version's cache with STALE file bytes (a still-fresh HTTP-cache copy),
  // shipping an update whose files never changed (caught live with v33)
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u => fetch(u, { cache: 'reload' }).then(r => {
      if (!r.ok) throw new Error('shell fetch failed: ' + u);
      return c.put(u, r);
    }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API calls (Open Food Facts, USDA): network only — results are cached in IndexedDB by the app
  if (url.hostname.includes('openfoodfacts.org') || url.hostname.includes('api.nal.usda.gov')) return;

  // App shell + the ZXing CDN script: cache-first, fill the cache from the network
  const cacheable = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (!cacheable) return;

  e.respondWith(
    // match ONLY this version's cache — matching across old caches can serve a
    // mixed set of module files mid-update, which breaks imports at boot
    caches.open(VERSION).then(c => c.match(req)).then(hit => {
      if (hit) return hit;
      return fetch(req).then(resp => {
        if (resp && (resp.ok || resp.type === 'opaque')) {
          const copy = resp.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => {
        // offline navigation falls back to the cached shell
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline');
      });
    })
  );
});
