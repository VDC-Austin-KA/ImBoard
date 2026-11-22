// App-shell cache for offline use; map tiles and APIs pass through.
const CACHE = 'imboard-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'longboard.brf', 'icon.svg', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  ...['main', 'util', 'terrain', 'routing', 'charts', 'cues', 'nav', 'ar', 'parks', 'cruise', 'pavement'].map((m) => `js/${m}.js`)];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network-first so fixes reach riders immediately; cache keeps the app working offline
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
