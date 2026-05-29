// EuphoricFM service worker — killswitch.
//
// The site's PWA strategy ended up being a liability in the in-game phone
// (CEF iframe): a previously-installed SW could intercept requests and serve
// stale content, and SW lifecycle in iframes is unpredictable across CEF
// versions. The in-game phone is the primary use case, so we removed the
// SW entirely. This file stays at /sw.js so that any browser/profile that
// already registered the old SW will fetch THIS version on its next update
// check, unregister itself, and clear all caches.
//
// Net effect: after one update cycle, no SW is installed for this origin.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* ignore */ }
    try {
      await self.registration.unregister();
    } catch (_) { /* ignore */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (_) {} });
    } catch (_) { /* ignore */ }
  })());
});

// Pass every fetch through to the network — no caching, no interception.
self.addEventListener('fetch', () => {});
