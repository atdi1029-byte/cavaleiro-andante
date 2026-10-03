// Service worker: keeps the app opening when there is no signal.
// Bump CACHE after every change to the app's files.
const CACHE = 'cavaleiro-v19';

const SHELL = [
  './', './index.html', './style.css', './manifest.json',
  './js/app.js', './js/config.js', './js/store.js', './js/sync.js',
  './js/catalog.js', './js/ui.js', './js/map.js', './js/addplace.js', './js/weather.js',
  './places.json', './logo-144.png', './icon-192.png',
];

// Libraries and fonts with a version in the URL never change, so the saved
// copy is used first
const STATIC_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Every app on atdi1029-byte.github.io shares one cache storage. Only this
  // app's old caches are removed ("ca-v13" was its name before version 14).
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => (k.startsWith('cavaleiro-') || /^ca-v\d+$/.test(k)) && k !== CACHE)
      .map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.origin === location.origin) {
    // The app's own files: fresh copy when online, saved copy when not
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }

  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
  }
  // Everything else (map tiles, photos, sync, place search) goes straight to the network
});
