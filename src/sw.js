// Service worker: caches the whole app shell so FieldSync opens with no network.
// VERSION and FILES are filled in by scripts/build.mjs.
const VERSION = '__VERSION__';
const FILES = __PRECACHE__;
const CACHE = `fieldsync-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map((f) => new Request(new URL(f, self.registration.scope), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('fieldsync-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only our own files. Supabase calls go straight to the network.
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match(new URL('index.html', self.registration.scope))) ?? fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit ?? fetch(req);
  })());
});
