const CACHE = 'focusplus-v19-3';
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
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
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

  // Облако и CDN — никогда не кэшировать, всегда напрямую в сеть
  if (
    url.hostname.includes('jsonblob.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebasedatabase.app') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('firebase')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Только файлы своего сайта
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
