// Service worker: caches the whole app shell so FieldSync opens with no network.
// VERSION and FILES are filled in by scripts/build.mjs.
const VERSION = '__VERSION__';
const FILES = __PRECACHE__;
const CACHE = `fieldsync-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One file at a time, each with its own retries: a single dropped request
    // on a bad connection no longer throws the whole install away. The worker
    // still only becomes active with every file cached, because a partial
    // cache would open as a broken app when offline. If a file keeps failing,
    // the install fails and the browser tries again on the next visit.
    for (const f of FILES) {
      const url = new URL(f, self.registration.scope);
      let res = null;
      for (let attempt = 1; attempt <= 4 && !res; attempt++) {
        try {
          const r = await fetch(new Request(url, { cache: 'reload' }));
          if (r.ok) res = r;
        } catch { /* dropped: try again */ }
        if (!res && attempt < 4) await new Promise((done) => { setTimeout(done, 500 * attempt); });
      }
      if (!res) throw new Error(`could not cache ${f}`);
      await cache.put(url, res);
    }
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
