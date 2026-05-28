// EuphoricFM service worker — minimal offline shell.
//
// Strategy:
// - Bump CACHE_VERSION on every meaningful asset change to invalidate clients.
// - HTML pages: network-first with cache fallback so users always get fresh
//   builds when online but the shell still loads when offline.
// - Same-origin static assets (fonts, _astro/*, icons, manifest): cache-first
//   so the shell is instant after the first visit.
// - Anything cross-origin (AzuraCast API, the audio stream, Discord webhooks):
//   pass straight through — never cache live data.

const CACHE_VERSION = 'efm-v1';

const PRECACHE_URLS = [
  '/',
  '/favicon.svg',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  // Never cache the runtime-config endpoint — it carries env-derived secrets.
  if (url.pathname.startsWith('/efm-runtime-config.js')) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
