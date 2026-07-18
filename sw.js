const CACHE_NAME = 'yallternative-cache-v1';
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
        return cache.addAll(ASSETS_TO_CACHE);
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
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const networkFetch = fetch(event.request).then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        }).catch(() => {
          // If network fails and no cache, maybe return offline page?
          // Not needed here since we cache all html.
        });
        
        return cachedResponse || networkFetch;
      })
    );
  }
});
