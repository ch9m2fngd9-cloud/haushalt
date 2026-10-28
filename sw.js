/*
 * Service Worker: hält die App-Dateien für die Offline-Nutzung vor.
 * Es werden nur die Programmdateien zwischengespeichert, nie die eingegebenen Daten
 * (die liegen in IndexedDB). Updates werden im Hintergrund geladen und beim
 * nächsten Öffnen aktiv.
 */
const CACHE = 'steuer-belege-v4';
const FILES = [
  './',
  'index.html',
  'css/styles.css',
  'js/logic.js',
  'js/db.js',
  'js/app.js',
  'js/pdf.js',
  'js/vendor/pdf-lib.min.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request, { ignoreSearch: true });
    const update = fetch(event.request)
      .then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
      .catch(() => cached);
    return cached || update;
  }));
});
