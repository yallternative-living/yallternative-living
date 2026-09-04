/**
 * @fileoverview Service Worker for Y'allternative Living website.
 * Provides caching of static assets and stale-while-revalidate strategy
 * for offline capabilities.
 */

/** @const {string} Cache name key, updated on assets release. */
const CACHE_NAME = "yallternative-cache-v3c9122362de1";

/**
 * The site not-found page is deliberately NOT on this list. A host answers a
 * direct request for it with a 404 status -- correctly, that is what it is for
 * -- and cache.add() rejects on any non-2xx. Under the old cache.addAll() that
 * one entry rejected the whole batch, so NOTHING was precached in production:
 * verified on the live site 2026-09-03, where addAll of the shell plus that
 * page rejected with "Request failed" and cached 0 of 2, and the live cache
 * held only pages the visitor had already opened. The offline fallback page --
 * the one asset this worker exists to have ready -- was never in it. The
 * install handler is per-asset now as well, so re-adding a bad path can only
 * lose that path.
 *
 * Keep prose in this block, not inside the array below: scripts/smoke-test.js
 * and scripts/qa-check.js both parse the array by pulling every single-quoted
 * run out of it, so an apostrophe in an inline comment reads as the start of a
 * cached path.
 *
 * @const {!Array<string>} Array of absolute URLs to be cached on installation.
 */
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/offline.html',
  '/shop.html',
  '/about.html',
  '/contact.html',
  '/safety.html',
  '/events.html',
  '/faq.html',
  '/policies.html',
  '/terms.html',
  '/privacy.html',
  /* The not-found page is deliberately absent -- see the note above. */
  '/reviews.html',
  '/order-status.html',
  '/thank-you.html',
  '/welcome.html',
  '/assets/css/styles.css',
  '/assets/css/cart.css',
  '/assets/js/main.js',
  '/assets/js/porch-light.js',
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
  '/assets/js/locales-data.js',
  '/assets/js/gift-card.js',
  // Self-hosted webfonts (2026-09 perf pass). Precaching them is cheap -- 69KB
  // of WOFF2 all told -- and it is what makes an offline repeat visit render
  // in the real typefaces instead of the metric-matched fallback stack. They
  // were never cacheable while they came from fonts.gstatic.com: those are
  // opaque cross-origin responses.
  '/assets/fonts/gloock-400.woff2',
  '/assets/fonts/dm-sans-400.woff2',
  '/assets/fonts/dm-sans-500.woff2',
  '/assets/fonts/dm-sans-700.woff2',
  '/site.webmanifest',
  '/favicon.ico',
  // The header/footer mark, as the variants a browser actually picks out of
  // its <picture> (sizes="48px", so 48w at 1x, 96w at 2x, 144w at 3x). The
  // 512x512 assets/img/logo.png behind them is deliberately NOT precached any
  // more: it is only the <picture> fallback for a browser with neither AVIF
  // nor WebP, plus the JSON-LD and order-email brand image, and precaching it
  // spent 201KB of every install budget on a 48px icon (live audit
  // 2026-09-02, H-1). A DPR-4 screen picks logo-192.* and gets it from the
  // runtime stale-while-revalidate cache instead.
  '/assets/img/logo-48.avif',
  '/assets/img/logo-96.avif',
  '/assets/img/logo-144.avif',
  '/assets/img/logo-48.webp',
  '/assets/img/logo-96.webp',
  '/assets/img/logo-144.webp',
  '/assets/img/favicon-32.png',
  '/assets/img/favicon-192.png',
  '/assets/img/favicon-512.png',
  '/assets/img/apple-touch-icon.png'
];

/**
 * The absolute-last-resort offline page: served only when /offline.html
 * ITSELF is missing from the cache (a failed precache add at install that
 * the 'activate' retry below has not yet run or has also failed). The old
 * fallback for this case was caches.match('/index.html'), but index.html's
 * asset links are root-RELATIVE ("assets/css/styles.css", no leading
 * slash) -- fine at "/", broken under any other path (a product page, a
 * typo), where the browser resolves them against the wrong directory and
 * the page renders raw and unstyled. This string is the entire response:
 * no stylesheet, script or image request it could ever fail to resolve, so
 * no request path can break it. Kept in sync with offline.html's tone, not
 * its markup -- this is the fallback for when THAT page is unavailable.
 *
 * @const {string}
 */
const OFFLINE_FALLBACK_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<meta name="robots" content="noindex, nofollow">' +
  "<title>You're offline | Y'allternative Living</title>" +
  "<style>" +
  "body{margin:0;min-height:100vh;display:flex;flex-direction:column;" +
  "align-items:center;justify-content:center;padding:48px 20px;" +
  "background:#17130f;color:#f3ead9;" +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
  "text-align:center;box-sizing:border-box}" +
  "@media (prefers-color-scheme:light){body{background:#faf5ea;color:#1b1712}}" +
  "h1{font-size:1.5rem;margin:0 0 12px}" +
  "p{max-width:40ch;margin:0 0 24px;line-height:1.5}" +
  "a{color:inherit;font-weight:700;text-decoration:underline}" +
  "</style></head><body>" +
  "<h1>You're offline right now</h1>" +
  "<p>This page isn't saved on your device yet, so we can't show it without " +
  "a connection. Everything comes back the moment you're online.</p>" +
  '<p><a href="/">Go home</a></p>' +
  "</body></html>";

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
        /* Per-asset add(), never addAll(). addAll() is all-or-nothing: one URL
           the host answers with a non-2xx status rejects the entire batch, and
           the .catch() that used to sit here turned that into a console warning
           nobody reads -- the worker still installed, still called skipWaiting,
           and reported healthy with an empty precache. Runtime
           stale-while-revalidate hid it, because pages a visitor had already
           opened were cached anyway; the hole only showed up offline, where
           /offline.html was missing. A failure now costs exactly one asset. */
        return Promise.all(
          ASSETS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('Service worker could not precache ' + url + ':', err);
            })
          )
        );
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
      // Self-heal a precache that came up without /offline.html -- the one
      // asset this worker exists to have ready, and the one whose absence
      // the fetch handler above has to synthesize a page around. install's
      // per-asset add() already logs a failure here; this gives it another
      // chance every time the worker activates, rather than only at the one
      // moment the original install ran.
      try {
        const cache = await caches.open(CACHE_NAME);
        const hasOfflinePage = await cache.match('/offline.html');
        if (!hasOfflinePage) {
          await cache.add('/offline.html').catch(err => {
            console.warn('Service worker could not precache /offline.html on retry:', err);
          });
        }
      } catch (err) {
        /* not fatal -- the fetch handler's synthesized fallback still covers this */
      }
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

  // The analytics proxy (scripts/lib/analytics-proxy.js). Same-origin paths,
  // but not this site's code: they are rewritten straight through to Umami
  // Cloud by netlify.toml. Left entirely to the browser.
  //
  // The send endpoint is a POST and the method guard above already skips it.
  // The SCRIPT is the reason this rule exists: it ends in .js, so without it
  // the network-first branch below would fetch it with `cache: "reload"` --
  // bypassing the browser's HTTP cache on EVERY page load, turning a script
  // Umami serves with `max-age=86400` into a real origin round trip per view
  // -- and would then write a third-party file into this site's own cache,
  // where the offline branch would keep serving it after a deploy.
  if (url.pathname.startsWith('/porch-light/')) {
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
              // cache: "reload" bypasses the *browser's* HTTP cache for this
              // leg. Without it the network-first strategy was only
              // network-first in name for code assets: netlify.toml serves
              // /assets/js/* and /assets/css/* with `max-age=604800` at a
              // static URL (`main.js?v=2.0` -- a hand-set string, not a
              // per-deploy hash), so a shopper who visited in the last seven
              // days had this fetch() silently satisfied from their own disk
              // cache. The service worker then wrote those stale bytes into
              // the freshly-rotated CACHE_NAME, defeating the whole point of
              // the content digest build-site-data.js computes. `reload` still
              // writes the fresh response back into the HTTP cache, so the
              // next non-SW consumer benefits too. Navigations are unaffected
              // either way (Netlify forces must-revalidate on HTML) and the
              // preloaded response above is used untouched when present.
              response = await fetch(event.request, { cache: "reload" });
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
            // A non-precached URL (any product page, a typo) used to get
            // index.html's markup under the requested path, where its
            // relative asset links 404 and it renders unstyled. offline.html
            // uses root-absolute paths and says what is going on.
            if (cached) return cached;
            if (!isNavigation) return Response.error();
            const offlinePage = await caches.match('/offline.html');
            if (offlinePage) return offlinePage;
            // /offline.html itself is missing from the cache -- see
            // OFFLINE_FALLBACK_HTML above for why this no longer falls
            // through to index.html.
            return new Response(OFFLINE_FALLBACK_HTML, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
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
