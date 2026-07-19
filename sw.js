const CACHE_NAME = "yallternative-cache-v10";
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/shop.html',
  '/about.html',
  '/contact.html',
  '/events.html',
  '/privacy.html',
  '/404.html',
  '/assets/css/styles.css',
  '/assets/js/main.js',
  '/assets/js/products-data.js',
  '/assets/js/events-data.js',
  '/assets/js/site-reviews-data.js',
  '/assets/js/image-manifest.js',
  '/site.webmanifest',
  '/favicon.ico',
  '/assets/img/logo.png',
  '/assets/img/favicon-32.png',
  '/assets/img/favicon-192.png',
  '/assets/img/favicon-512.png',
  '/assets/img/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(ASSETS_TO_CACHE).catch(err => console.warn('Cache addAll error', err));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  
  // Stale-while-revalidate for local assets
  if (event.request.url.startsWith(self.location.origin)) {
    const url = new URL(event.request.url);
    url.search = "";
    const cleanRequest = new Request(url.toString());

    event.respondWith(
      caches.match(cleanRequest).then(cachedResponse => {
        const networkFetch = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(cleanRequest, responseClone);
            });
          }
          return response;
        }).catch(() => {
          // Ignore network errors
        });
        
        return cachedResponse || networkFetch;
      })
    );
  }
});
