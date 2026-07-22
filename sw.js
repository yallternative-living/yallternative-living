/**
 * @fileoverview Service Worker for Y'allternative Living website.
 * Provides caching of static assets and stale-while-revalidate strategy
 * for offline capabilities.
 */

/** @const {string} Cache name key, updated on assets release. */
const CACHE_NAME = "yallternative-cache-v20260722231542";

/** @const {!Array<string>} Array of absolute URLs to be cached on installation. */
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/shop.html',
  '/about.html',
  '/contact.html',
  '/events.html',
  '/faq.html',
  '/policies.html',
  '/terms.html',
  '/privacy.html',
  '/404.html',
  '/journal.html',
  '/assets/css/styles.css',
  '/assets/js/main.js',
  '/assets/js/products-data.js',
  '/assets/js/events-data.js',
  '/assets/js/site-reviews-data.js',
  '/assets/js/image-manifest.js',
  '/assets/js/translator.js',
  '/assets/js/gift-card.js',
  '/site.webmanifest',
  '/favicon.ico',
  '/assets/img/logo.png',
  '/assets/img/favicon-32.png',
  '/assets/img/favicon-192.png',
  '/assets/img/favicon-512.png',
  '/assets/img/apple-touch-icon.png'
];

/**
 * Event listener for service worker 'install' phase.
 * Opens the cache and adds all required static assets to it.
 *
 * @param {!ExtendableEvent} event The install event object.
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(ASSETS_TO_CACHE).catch(err => {
          console.warn('Cache addAll error during service worker install:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

/**
 * Event listener for service worker 'activate' phase.
 * Deletes old caches that do not match the current CACHE_NAME.
 *
 * @param {!ExtendableEvent} event The activate event object.
 */
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

/**
 * Event listener for service worker 'fetch' phase.
 * Implements a stale-while-revalidate strategy for same-origin requests.
 * Strips query parameters from the cache key to avoid mismatching.
 *
 * @param {!FetchEvent} event The fetch event object.
 */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  
  // Handle local same-origin assets
  if (event.request.url.startsWith(self.location.origin)) {
    const url = new URL(event.request.url);
    url.search = "";
    const cleanRequest = new Request(url.toString());

    // Determine if the request is an HTML page navigation or a code asset (JS, CSS)
    const isNavigation = event.request.mode === 'navigate' || 
                         (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'));
    const isCodeAsset = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

    if (isNavigation || isCodeAsset) {
      // Network-First strategy for HTML and code assets: prefer live server data when online,
      // fall back to cache only when offline or connection is lost.
      event.respondWith(
        fetch(event.request)
          .then(response => {
            if (response && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(cleanRequest, responseClone);
              });
            }
            return response;
          })
          .catch(() => {
            return caches.match(cleanRequest);
          })
      );
    } else {
      // Stale-While-Revalidate strategy for other static assets (images, fonts, etc.):
      // serve instantly from cache, update cache from network in background.
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
          });
          
          if (cachedResponse) {
            networkFetch.catch(() => {
              // Ignore background network errors when cache is available.
            });
            return cachedResponse;
          }
          
          return networkFetch;
        })
      );
    }
  }
});
