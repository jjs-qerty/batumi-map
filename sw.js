/* Keeps the app working offline and remembers map tiles you've already looked at. */
const APP_CACHE = 'niniko-app-v2';
const TILE_CACHE = 'niniko-tiles-v1';
const MAX_TILES = 3000;
const APP_FILES = ['./', 'index.html', 'app.css', 'app.js', 'poi.js', 'vendor/leaflet.css', 'vendor/leaflet.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Map tiles: use the saved copy if there is one, otherwise fetch and save it.
  if (url.hostname.endsWith('basemaps.cartocdn.com') || url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { c.put(e.request, res.clone()); if (Math.random() < 0.05) trimTiles(); }
      return res;
    }));
    return;
  }

  // App files: network first so updates arrive, fall back to the saved copy offline.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) caches.open(APP_CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
  }
});
