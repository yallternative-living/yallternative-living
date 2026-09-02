/**
 * @fileoverview Service Worker for Y'allternative Living website.
 * Provides caching of static assets and stale-while-revalidate strategy
 * for offline capabilities.
 */

/** @const {string} Cache name key, updated on assets release. */
const CACHE_NAME = "yallternative-cache-vf5e92cf9b5c5";

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
  '/reviews.html',
  '/order-status.html',
  '/thank-you.html',
  '/welcome.html',
  '/assets/css/styles.css',
  '/assets/css/cart.css',
  '/assets/js/main.js',
  '/assets/js/cart.js',
  '/assets/js/thank-you.js',
  '/assets/js/content-data.js',
  '/assets/js/products-data.js',
  '/assets/js/events-data.js',
  '/assets/js/site-reviews-data.js',
  // journal.html and the homepage/shop UGC strip render entirely from these
  // two. Precaching the pages without them meant an offline visitor who had
  // never opened journal.html online got the cached shell with an empty
  // journal grid (main.js bails on `!window.YL_JOURNAL`), and the same for
  // the social feed strip.
  '/assets/js/journal-data.js',
  '/assets/js/social-feed-data.js',
  '/assets/js/search-data.js',
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
    (async () => {
      // Navigation Preload: lets the browser start the network request for a
      // navigation *in parallel* with the service worker booting up, instead
      // of waiting for the SW to spin up before the fetch even starts. Pure
      // win for the network-first HTML path below -- shaves the SW startup
      // cost off every page load. Safe no-op where unsupported (iOS Safari).
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {
          /* not fatal -- fall back to a normal fetch */
        }
      }
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
      await self.clients.claim();
    })()
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

  const url = new URL(event.request.url);

  // Dynamic endpoints are never cached and never intercepted. /.netlify/
  // (serverless functions: gift-card balance, order status, refunds) and
  // /api/ (the Cloudflare Worker checkout proxy, see netlify.toml) return
  // per-request, often personalised, sometimes single-use payloads. Serving
  // one of those from the cache -- or writing one into it -- hands the next
  // shopper someone else's gift-card balance or a dead checkout session.
  // Returning BEFORE any caches.match/caches.put and before respondWith()
  // leaves them entirely to the network.
  if (url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/api/')) {
    return;
  }

  // Handle local same-origin assets
  if (event.request.url.startsWith(self.location.origin)) {
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
        (async () => {
          try {
            // For navigations, a preloaded response (started in parallel with
            // the SW booting -- see 'activate') is already in flight; use it
            // instead of kicking off a second fetch.
            let response = isNavigation ? await event.preloadResponse : null;
            if (!response) {
              response = await fetch(event.request);
            }
            if (response && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(cleanRequest, responseClone);
              });
            }
            return response;
          } catch (err) {
            const cached = await caches.match(cleanRequest);
            // Last-resort offline fallback for navigations so users get the
            // branded shell instead of the browser's dinosaur error page.
            return cached || (isNavigation ? caches.match('/index.html') : Response.error());
          }
        })()
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
