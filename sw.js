const CACHE = 'ca-v12';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // External APIs — network only, no caching
  if (url.includes('nominatim') || url.includes('overpass') ||
      url.includes('wikipedia') || url.includes('unsplash') ||
      url.includes('unpkg')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App JS/CSS/HTML — network first, fall back to cache
  // This ensures updates always get through
  if (url.includes('app.js') || url.includes('style.css') ||
      url.includes('index.html') || url.includes('places.js')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else — cache first
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
