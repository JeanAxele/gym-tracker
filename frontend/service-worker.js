const { cache, files } = __BUILD_CONFIG__;
const precache = new Set(files);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cache).then((storage) => storage.addAll(
    files.map((file) => new Request(file, { cache: 'reload' })),
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('gym-shell-') && key !== cache) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  const path = event.request.mode === 'navigate' ? '/index.html' : url.pathname;
  if (!precache.has(path)) return;
  event.respondWith((async () => {
    const storage = await caches.open(cache);
    return (await storage.match(path)) ?? fetch(event.request);
  })());
});
