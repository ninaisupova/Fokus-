const CACHE = 'focusplus-v19-6';
const ASSETS = [
  './',
  './index.html',
  './book.html',
  './css/style.css',
  './css/calendar.css',
  './css/mobile.css',
  './css/book.css',
  './js/storage.js',
  './js/cloud-config.js',
  './js/sync.js',
  './js/calendar.js',
  './js/app.js',
  './js/book.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Сеть напрямую: облако, CDN, и JS/CSS с ?v= (обход старого кэша)
  if (
    url.hostname.includes('jsonblob.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebasedatabase.app') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('firebase') ||
    url.search.includes('v=')
  ) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
