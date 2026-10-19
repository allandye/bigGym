// Offline support: serve the app from cache, refresh the cache in the background.
// Bump VERSION (and APP_VERSION in app.js) when files change so phones pick up the new version.
// Files are fetched past the browser's HTTP cache, because GitHub Pages lets it keep them for 10 minutes.
const VERSION = 'v3';
const DATA_CACHE = 'workout-data'; // the app's backup copy of your data; never deleted here
const FILES = ['./', 'index.html', 'styles.css', 'logic.js', 'store.js', 'app.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== DATA_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  }));
});
