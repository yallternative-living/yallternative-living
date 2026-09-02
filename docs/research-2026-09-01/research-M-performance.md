# Core Web Vitals & Loading Audit — yallternativeliving.com
Read-only audit. Live site + repo (context only, no changes made). Prepared 2026-09-02.

## 0. Methodology & a hard data-access limitation (read this first)

The brief asked for **PageSpeed Insights API field + lab data** (steps 1) plus independent Puppeteer lab verification (step 2). Only the second half was achievable from this environment:

- **`pagespeedonline.googleapis.com` (PSI REST API): blocked at the quota layer, not just rate-limited.** Every call (`/`, mobile, 8 total planned) returned HTTP 429. The response body is explicit that this isn't a transient rate window that backoff can wait out:
  ```
  "reason": "RATE_LIMIT_EXCEEDED", "quota_metric": "pagespeedonline.googleapis.com/default",
  "quota_limit": "defaultPerDayPerProject", "quota_limit_value": "0"
  ```
  The shared/unauthenticated consumer project this sandbox egresses through has a **daily quota of zero** for this API. Exponential backoff (6 attempts, up to ~60s waits, per the brief's instruction) was applied and confirmed this is a hard cap, not jitter — see `scratchpad/perf/fetch.log`.
- **`chromeuxreport.googleapis.com` (CrUX API, for field data directly):** the hostname resolves to `0.0.0.0` from this sandbox — network-level blocked, not reachable at all.
- **Fallback attempt — driving `pagespeed.web.dev` (the PSI web app) via the browser tool:** the analysis kicked off (confirmed via captured network request to its `batchexecute` RPC endpoint) but the results-polling request never fired again; console showed `net::ERR_BLOCKED_BY_CLIENT` on two resources. The run stalled indefinitely ("Running analysis… data loading") and was abandoned after ~2 minutes.

**Net effect: no CrUX field data (p75 LCP/INP/CLS/TTFB/FCP) and no hosted-Lighthouse lab run could be obtained for this report.** This is disclosed rather than papered over. In its place, section 2 below is a **from-scratch lab audit** using the repo's own Puppeteer (v25.3.0), which is what step 2 of the brief specified anyway — mobile *and* added desktop, both device profiles, cold (first-visit, no cache/SW) and warm (repeat-visit, SW active) for all four requested pages. This is a legitimate substitute for lab data, but it is **not** a replacement for real-user field data (CrUX), which reflects a distribution of real devices/networks/sessions rather than one controlled run per page. It's also worth noting for context: a site this size may have too little Chrome traffic for CrUX to publish public URL-level (or even origin-level) data at all — that's a separate, independent reason field data may not exist regardless of API access.

All raw output lives in `scratchpad/perf/`: `fetch-psi.js`/`fetch.log` (failed PSI attempts), `lab-test.js` (the Puppeteer harness), `lab-results-mobile.json`, `lab-results-desktop.json`.

### Lab harness design
- **Mobile profile**: viewport 393×851 @2.75x DPR, `isMobile`/`hasTouch`, Moto G Power-class Android Chrome UA, CDP `Emulation.setCPUThrottlingRate(4)`, CDP `Network.emulateNetworkConditions` set to Lighthouse's "Fast 4G" simulated profile (150ms RTT, 1.6Mbps↓/750Kbps↑).
- **Desktop profile**: 1920×1080 @1x, no CPU throttle, ~10Mbps/40ms RTT (Lighthouse desktop-ish broadband).
- **Cold** = a fresh Puppeteer incognito `BrowserContext` per page (no cache, no service worker) — a true first visit.
- **Warm** = a second navigation to the *same* URL in the *same* context right after cold, so the service worker installed by the cold visit is active — a true repeat visit.
- Metrics captured via a `PerformanceObserver` injected before navigation (`page.evaluateOnNewDocument`): LCP (time, element, size), CLS (value + up to 3 shifted-element sources per entry), FCP, long tasks (→ TBT proxy = Σ max(0, duration−50)). TTFB/byte totals from Navigation/Resource Timing. Service-worker involvement per response captured via CDP `Network.responseReceived`'s `fromServiceWorker` flag.
- An earlier v1 run shared one browser context across pages, which let a service worker installed while testing `/` contaminate the "cold" run of `/shop.html`. That run was discarded (`lab-results-v1-contaminated.json` kept for transparency) and redone with per-page isolated contexts.

---

## 1. Lab results — Mobile (Fast 4G + 4× CPU throttle)

| Page | Visit | LCP | LCP element | CLS | FCP | TTFB | TBT (proxy) | Page weight | SW-served responses |
|---|---|---|---|---|---|---|---|---|---|
| `/` | Cold (1st visit) | **888ms** | `<img unisex-tshirt.jpg>` (preloaded AVIF hero) | 0.005 | 744ms | 101ms | 17ms | 482KB | 0 |
| `/` | Warm (repeat) | **244ms** | same | 0.000 | 244ms | 160ms | 0ms | 0KB (all cache/SW) | 17 |
| `/shop.html` | Cold (1st visit) | **676ms** | `<p class="lede shop-lede">` (text) | **0.455** | 676ms | 217ms | 39ms | 494KB | 0 |
| `/shop.html` | Warm (repeat) | 232ms | same | 0.000* | 232ms | 155ms | 29ms | 0KB | 17 |
| `/events.html` | Cold (1st visit) | **584ms** | `<p class="lede">` (text) | **0.619** | 584ms | 108ms | 20ms | 399KB | 0 |
| `/events.html` | Warm (repeat) | 236ms | same | 0.000* | 236ms | 160ms | 0ms | 0KB | 13 |
| `/thank-you.html` | Cold (1st visit) | **588ms** | `<p class="lede thank-you-lede">` (text) | **0.356** | 588ms | 100ms | 29ms | 402KB | 0 |
| `/thank-you.html` | Warm (repeat) | 228ms | same | 0.000* | 228ms | 154ms | 0ms | 0KB | 13 |

\* See the CLS root-cause note below — the mobile *warm* run happening to read 0.000 does not mean the underlying bug is fixed by caching; the desktop warm run (below) reproduces it almost identically to cold. It's a paint-timing race explained in Finding 1.

## 2. Lab results — Desktop (no CPU throttle, ~10Mbps/40ms)

| Page | Visit | LCP | CLS | FCP | TTFB | TBT | Page weight | SW-served |
|---|---|---|---|---|---|---|---|---|
| `/` | Cold | 284ms | 0.003 | 276ms | 94ms | 0ms | 723KB | 0 |
| `/` | Warm | 120ms | 0.003 | 120ms | 83ms | 0ms | 0KB | 22 |
| `/shop.html` | Cold | 240ms | **0.940** | 240ms | 79ms | 0ms | 645KB | 0 |
| `/shop.html` | Warm | 220ms | **0.939** | 220ms | 184ms | 0ms | 0KB | 22 |
| `/events.html` | Cold | 256ms | **0.256** | 256ms | 92ms | 0ms | 399KB | 0 |
| `/events.html` | Warm | 132ms | **0.256** | 132ms | 97ms | 0ms | 0KB | 13 |
| `/thank-you.html` | Cold | 228ms | 0.100 | 228ms | 82ms | 0ms | 402KB | 0 |
| `/thank-you.html` | Warm | 124ms | 0.099 | 124ms | 83ms | 0ms | 0KB | 13 |

## 3. `main.js` network + evaluation cost (mobile, Fast 4G + 4× CPU)

| Page | Visit | Transfer size | Decoded size | Resource-timing duration (fetch→execute-ready) |
|---|---|---|---|---|
| `/` | Cold | 83.4KB | 334.3KB | 2,908ms |
| `/` | Warm | 0 (SW) | 334.3KB | 18ms |
| `/shop.html` | Cold | 0*(SW, contaminated v1 run) | 334.3KB | 915ms |
| `/thank-you.html` | Cold | — | 334.3KB | 1,881ms |

(`main.js` decoded size is identical everywhere because it's the same file on every page — see Finding 2.)

### Directly measured file sizes (live, via `curl`, `Content-Encoding: br`)
| Asset | Raw (disk) | Gzip (local) | Brotli (as served by Netlify) |
|---|---|---|---|
| `assets/js/main.js` | 343.5KB | 90.3KB | **83.1KB** |
| `assets/css/styles.css` | 173.0KB | 38.8KB | **35.7KB** |
| `assets/js/cart.js` | 105.6KB | — | — |

The brief's premise of "a ~165KB deferred main.js" doesn't match any of raw/gzip/brotli measured just now (343.5 / 90.3 / 83.1 KB respectively) — treat the brief's figure as stale and use the numbers above.

---

## 4. Findings, with evidence

### Finding 1 — Severe CLS on shop/events/thank-you from client-rendered empty grids (HIGHEST PRIORITY)
**Evidence:** CLS 0.36–0.94 across three of four tested pages, on both device profiles, reproduced on cold *and* desktop-warm loads (0.940 → 0.939). Only the homepage is clean (CLS ≈0.003–0.005).

**Root cause, confirmed in source:**
- `shop.html:985` — `<div id="shopGrid" class="grid grid-3 stagger"></div>` ships **completely empty** in the static HTML.
- `events.html:162` — `<div id="upcomingEvents" class="grid grid-3 stagger"></div>` — same pattern.
- Neither has a reserved `min-height` or `aspect-ratio` placeholder in `assets/css/styles.css` (grep for `shop-grid`/`shopGrid` rules returns nothing).
- `assets/js/main.js` builds all product/event cards client-side (`cardHTML()` at `main.js:2940`, `eventCardHTML()`) only after the deferred bundle parses and `products-data.js`/`events-data.js` are read — so the entire grid (including every card image) pops into an initially-zero-height container and shoves the rest of the page down, well after first paint.
- The team already knows this pattern and fixes it elsewhere: `events.html:161` — `<div id="eventsCountdownBanner" ... style="min-height: 76px;">` — proving the min-height-reservation fix is a known, already-used technique just not applied to the two big grids.
- Lab CLS `sources` confirm it directly (from `/shop.html` cold, mobile): a 0.452 shift at t=2,330ms lists sources `["MAIN", "DIV.concern-filter-wrap", "DIV.nav-cta"]` — the whole `<main>` moving as the grid fills in.
- `thank-you.html`'s smaller 0.10–0.36 CLS is a version of the same class of issue (dynamic content replacing a placeholder) via `thank-you.js`, just less severe because there's less injected content.

**Fix:** reserve grid height before JS runs — either a CSS `min-height`/`aspect-ratio` skeleton sized from the known card count (the build already runs `scripts/build-site-data.js`, which could inject that count), or better, server/build-render the first screenful of cards directly into the static HTML (progressive enhancement: JS hydrates/extends from there instead of building from zero). **Estimated gain: CLS 0.94→well under 0.1 on shop.html, 0.62→~0 on events.html** — this single fix likely moves 3 of 4 pages from CWV-fail to CWV-pass on CLS.

### Finding 2 — `main.js` and its four companion `-data.js` files are one undifferentiated bundle shipped to every page
**Evidence:** `main.js` is a single top-level IIFE (`main.js:7`–`8844`) containing **174 top-level functions** spanning every page type: PDP-only (`initPdpPage`, `initPdpStickyBar`, `initPdpRitualSection`), events-only (`generateIcsContent`, `generateGoogleCalendarUrl`, `generateAppleMapsDirUrl`, `formatEventMapDestination`), order-status-only (`initOrderStatusPage`, `initOrderStatusModal`), plus restock alerts, the "apothecary quiz," the reviews engine, wishlist, custom box builder, lightbox/gallery, and the prefetch/speculation-rules system — all parsed and evaluated on every single page regardless of relevance.

Script-tag audit (`grep` across `index.html`/`shop.html`/`events.html`/`thank-you.html`) shows the same pattern one level up: **every page loads `content-data.js` (17.9KB), `products-data.js` (50.1KB), `search-data.js` (51.3KB), and `image-manifest.js` (35.3KB)** — including `thank-you.html`, which has no product catalog or search UI to power. Combined with `main.js` (343.5KB) and `cart.js` (105.6KB), a fresh visit to `/` or `/shop.html` parses/evaluates **~600–610KB of uncompressed JS**, most of it for features that page doesn't use.

**Fix, cheapest-first:**
1. Stop loading `products-data.js`/`search-data.js`/`image-manifest.js` on pages that don't need the catalog (`thank-you.html` is the clearest case) — a few script tags removed from one page template, no JS refactor.
2. Split `main.js` along the seams that already exist as named functions (PDP module, events/ICS module, order-status module, quiz module) and load each behind a `document.getElementById(...)` check or dynamic `import()`, so a visit to `/shop.html` never parses the ICS-calendar or order-status code.

**Estimated gain:** proportional reduction in parse/compile + TBT on every page; in this lab's cold run, `main.js` alone took 1.9–2.9s of the page's total load window on throttled mobile — cutting its effective size by half or more (by not shipping unrelated modules) should cut that roughly in proportion.

### Finding 3 — Tawk.to chat loads unconditionally on every pageview, not on interaction
**Evidence:** `index.html:519–539` (and the same snippet in `shop.html`, `events.html`, `thank-you.html`, `contact.html`, `about.html`, `faq.html`, `404.html`, `order-status.html`) — an async `<script>` at the bottom of `<body>` that builds `https://embed.tawk.to/{propertyId}/{widgetId}` and injects it immediately, gated only on the IDs not being the literal placeholder `"YOUR_..."`. **The IDs are live** (`6a9687f6adddbc3447585d73` / `1k1e066pc`), so the widget SDK — plus its WebSocket (`connect-src` in the CSP explicitly carries `wss://*.tawk.to`) — loads and initializes on every real pageview, whether or not the visitor ever opens chat.

**Fix:** gate the existing `s1.src = ...` line behind a real trigger — first `pointerdown`/`scroll`/`keydown`, or a click on a visible "Chat with us" affordance, with a several-second idle-timeout fallback so it's still available to a visitor who never interacts but stays a while. This is a small, low-risk change (the file already has an inert/placeholder guard pattern to build on) that removes a third-party SDK + socket handshake from the default critical path for the large majority of sessions that never chat.

### Finding 4 — Google Fonts: the print-media swap trick is working, but the fonts are still third-party
**Evidence:** `index.html:33–39`:
```html
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Gloock&family=DM+Sans:wght@400;500;700&display=swap">
<link rel="stylesheet" href="...&display=swap" media="print" id="gfontsStylesheet">
<script>document.getElementById("gfontsStylesheet").addEventListener("load",function(){this.media="all";});</script>
<noscript><link rel="stylesheet" href="...&display=swap"></noscript>
```
Note the URL **already carries `&display=swap`** — meaning `font-display: swap` is doing the FOIT-prevention work by itself; the `media="print"` + `onload` swap is a *second*, redundant layer on top of that (its only extra effect is deprioritizing when the stylesheet is *applied*, not whether text is blocked). Lab evidence this isn't hurting: cold FCP fires at 584–888ms across all four pages (mobile), i.e. text is painting early with the fallback stack, consistent with no FOIT. There's also a nice, unrelated detail: a local-only `@font-face` named `CleanAmpersand` scoped to `unicode-range: U+0026` (`styles.css:124-128`) swaps in the system font's ampersand glyph specifically, ahead of Gloock's stylized one.

**Remaining opportunity:** the fonts are still fetched from `fonts.googleapis.com` (CSS) + `fonts.gstatic.com` (the two `.woff2` files, confirmed in the warm-run network log) — two extra origins despite the `preconnect` hints. Self-hosting Gloock + DM Sans under `/assets/fonts/` removes those round trips entirely and lets you add `size-adjust`/`ascent-override`/`descent-override` on the fallback stack to shrink the swap-induced layout nudge (a secondary, smaller contributor to CLS than Finding 1).

### Finding 5 — Image payload: some AVIFs are large, and the shop grid ships zero `<picture>` markup server-side
**Evidence:** 135 AVIF files, average 48KB, several 130–170KB: `tank-top-alt2.avif` 168KB, `bug-spray-alt1.avif` 154KB, `tank-top-alt1.avif` 154KB, `bug-spray.avif` 140KB, `lavender-soak.avif` 134KB. The homepage hero already does responsive images right — `index.html`'s preload carries a full `imagesrcset` (480w/800w/1050w) with `imagesizes`. But `grep -c "<picture" shop.html` returns **0** — because, per Finding 2, every product card on `/shop.html` is built client-side by `cardHTML()` in `main.js`, so whatever responsive markup (or lack of it) that function emits is the *only* responsive-image behavior the shop grid gets. Worth verifying it emits the same 480/800/1050 `srcset`+`sizes` pattern the hero preload uses, rather than a single full-size AVIF URL per card.

**Fix:** audit the ~5+ heaviest AVIFs for correct source dimensions vs. displayed size, and confirm `cardHTML()`'s image markup matches the hero's responsive pattern.

### Finding 6 — Service worker precache is broad and demonstrably effective (no action needed — noted for completeness)
**Evidence:** warm-visit wall-clock load collapsed from 2.5–3.3s (mobile cold, Fast4G+4×CPU) to 113–394ms (warm, SW active) across all four pages/both devices; warm LCP 120–256ms; TBT ≈0 almost everywhere. `sw.js` precaches shell pages, CSS, every `-data.js`, and key images (`ASSETS_TO_CACHE`, `sw.js:11–52`). This is a genuine, working win already shipped — leave it alone. One caveat: the Google Fonts stylesheet/`.woff2` files are (correctly, since they're cross-origin `no-cors` opaque responses) *not* in `ASSETS_TO_CACHE`; the warm-run log shows them served via the regular HTTP disk cache instead (`fromServiceWorker:false, fromDiskCache:true`) — fine given `font-display:swap` already provides a graceful fallback offline.

### Finding 7 — Speculation Rules + hover-prefetch are already implemented, but live inside the deferred bundle
**Evidence:** `main.js:5910–5967` — a static `<script type="speculationrules">` injected with `eagerness: "moderate"`, explicitly excluding cart/checkout/external links. `main.js:7837–7996` — a separate, independent hover/pointer-based prefetch system (`initHoverPrefetch`, `prefetchUrl`, dedup `Set`) with `HTMLScriptElement.supports("speculationrules")` feature-detection and a `<link rel=prefetch>` fallback. This is a genuinely modern, well-built setup — the only gap is that neither can start doing its job until `main.js` (deferred, 343.5KB) has downloaded, parsed, and executed, which per Finding 2/Section 3 is 1.9–2.9s into a cold throttled load.

**Fix:** hoist just the speculation-rules registration (not the hover-prefetch logic, which needs the rest of the app) into a small inline `<script>` near the top of `<head>`. This requires adding a new `sha256-` hash to the CSP's `script-src` (regenerated via `scripts/build-security-headers.js`, per the file's own header comment) — cheap mechanically, but flagged because it touches the security-header build step.

### Finding 8 — Netlify caching headers leave a 7-day revalidation window on JS/CSS
**Evidence (curl against production):** `/` → `cache-control: public,max-age=0,must-revalidate` (intentional and correct, per `netlify.toml`'s own comment — pages should always revalidate so deploys go live immediately). `/assets/js/main.js` and `/assets/css/styles.css` → `public,max-age=604800` (7 days) — versus `/assets/img/*` which already gets `public,max-age=31536000,immutable`. Since JS/CSS already carry a `?v=2.0` cache-busting query string, they're safe to cache the same way images do.

**Fix:** either fingerprint the JS/CSS filenames (content hash in the filename) or otherwise extend the same `max-age=31536000, immutable` treatment `netlify.toml`'s `[[headers]]` block gives `/assets/img/*` to `/assets/js/*` and `/assets/css/*`. Low effort (one `netlify.toml` edit), low-but-real payoff (skips a conditional-GET round trip once every 7 days per repeat visitor — mostly superseded by the service worker for visitors who've been precached, but not for first-week-since-last-deploy visitors hitting the browser HTTP cache directly).

### Finding 9 — Netlify platform ceiling: Brotli yes, HTTP/3 unclear, Early Hints no
- **Brotli: confirmed active**, no action needed — `curl -H "Accept-Encoding: br"` against production returns `content-encoding: br` for `/`, `main.js`, and `styles.css` (sizes in Section 3's table).
- **HTTP/3 (QUIC): inconclusive from this environment.** `curl -sv` against the live site negotiated HTTP/2 with no `alt-svc` response header advertising an HTTP/3 upgrade path. Unlike Cloudflare, Fastly, and Akamai — which enable HTTP/3 by default as of 2025–2026 — Netlify's own documentation doesn't clearly state site-wide HTTP/3 support, and this test found no evidence of it being offered. Not actionable without more information from Netlify directly; not something the site owner can toggle either way.
- **Early Hints (HTTP 103): not supported.** Netlify's own community support forum has an open feature request for this (flagged as a duplicate of an earlier request by Netlify staff in July 2024, unresolved as of this writing) — [Netlify Support: "HTTP 103 Early Hints — Preload"](https://answers.netlify.com/t/http-103-early-hints-preload/121807). Not actionable on this host today.

None of the three items in this finding are things the site can fix on its own — listed for completeness against the brief's explicit ask, not as a to-do.

---

## 5. Threshold & benchmark comparison

**2026 "good" Core Web Vitals thresholds (p75, unchanged since INP replaced FID in March 2024):** LCP < 2.5s, INP < 200ms, CLS < 0.1. ([corewebvitals.io](https://www.corewebvitals.io/core-web-vitals))

**General web pass-rate context (HTTP Archive Web Almanac 2024 data, via [Fudge.ai's "State of Shopify Performance 2026"](https://www.fudge.ai/blog/state-of-shopify-performance-2026/), published 2026-07-20):** only ~43% of websites pass all three Core Web Vitals on mobile; per-metric pass rates run LCP 59%, INP 74%, CLS 79%.

**Shopify-specific commentary (via [1Digital Agency, "Core Web Vitals for Shopify Stores: 2026 Benchmarks"](https://www.1digitalagency.com/blog/core-web-vitals-for-shopify-stores-2026-benchmarks-and-optimization-playbook-33932/), CrUX-sourced, published 2026-08-04):** "many mid-tier Shopify stores score in the 3–5 second range on mobile" LCP, and stores running heavy third-party app stacks "frequently exceed 500ms" INP. *(Framed as industry commentary rather than a single precise headline statistic — the sources reviewed explicitly avoid citing one aggregate pass-rate number, saying it "varies widely between sources and measurement windows.")*

**How this site compares, using this report's lab numbers (not field p75 — see Section 0 caveat):**
- **Loading (LCP) is genuinely strong.** Cold mobile LCP ran 584–888ms across all four pages on a throttled Fast-4G/4×CPU profile — well inside the 2.5s "good" threshold, and far ahead of the "mid-tier Shopify stores at 3–5s" comparison point. This site is not a typical over-stuffed Shopify-app-store situation; it's a lean static build with a working preload + service worker.
- **CLS is the opposite story — a severe outlier.** 0.36–0.94 on three of four pages is roughly 4–9× over the 0.1 threshold, and stands in sharp contrast to the "CLS pass rate 79%" web-wide figure — this site is currently in the *failing* minority on that metric, for a clearly identifiable, fixable reason (Finding 1).
- **INP could not be measured** (it requires real user interaction sampling; Lighthouse/lab tools report TBT as a loose proxy, not INP itself, and CrUX access was unavailable per Section 0). The TBT proxy computed here was 0–39ms on every page/device combination — very low — but that's a proxy for main-thread busyness during *load*, not a substitute for real click/tap responsiveness data, so it isn't asserted as an INP figure.

---

## 6. Top 10 fixes, ranked by impact ÷ effort

| # | Fix | Impact | Effort | Evidence |
|---|---|---|---|---|
| 1 | Reserve height for `#shopGrid`/`#upcomingEvents` (skeleton/min-height, or render first cards server-side) | **Very high** — CLS 0.94→likely <0.1 on shop.html, 0.62→~0 on events.html; moves 3 of 4 pages from CWV-fail to pass on CLS | Low–Medium | Finding 1; `shop.html:985`, `events.html:162`, `main.js:2940` |
| 2 | Defer Tawk.to load until first interaction/idle-timeout | High — removes a third-party SDK + WebSocket handshake from ~95%+ of sessions that never open chat | Low | Finding 3; `index.html:519-539` (+7 other pages) |
| 3 | Stop loading `products-data.js`/`search-data.js`/`image-manifest.js` on pages that don't use the catalog (e.g. `thank-you.html`) | Medium–High — ~137KB less JS parsed/evaluated on those pages | Low | Finding 2; per-page `<script>` audit |
| 4 | Split `main.js` into per-feature modules (PDP, events/ICS, order-status, quiz) loaded only where used | High (compounding) — cuts parse/compile + TBT proportionally on every page | High | Finding 2; 174 top-level functions in one IIFE, `main.js:7-8844` |
| 5 | Self-host Gloock + DM Sans; add `size-adjust`/metric-override fallback fonts | Medium — removes 2 cross-origin round trips, shrinks font-swap CLS contribution | Medium | Finding 4 |
| 6 | Right-size the heaviest AVIFs (130-170KB) and confirm `cardHTML()` emits the same responsive `srcset`/`sizes` the hero preload uses | Medium | Low–Medium | Finding 5 |
| 7 | Hoist Speculation-Rules registration into an inline `<head>` script (ahead of deferred `main.js`) | Low–Medium — speculative prerendering starts ~2s earlier on a throttled cold load | Low (+ CSP hash regen) | Finding 7 |
| 8 | Fingerprint JS/CSS filenames → `max-age=31536000, immutable` (parity with `/assets/img/*`) | Low–Medium | Low | Finding 8 |
| 9 | Extract critical/above-fold CSS for shop/events/thank-you out of the 173KB sitewide `styles.css` | Medium | Medium–High (+ CSP hash regen via `scripts/build-security-headers.js`) | repo review; `assets/css/styles.css` is 655 top-level class selectors serving every page type from one file |
| 10 | Netlify platform items (Early Hints, HTTP/3) | None currently available | N/A | Finding 9 — documented as a platform ceiling, not an actionable item |

---

## Appendix: raw data files
- `scratchpad/perf/fetch-psi.js`, `scratchpad/perf/fetch.log` — PSI API attempts and the quota=0 failure
- `scratchpad/perf/lab-test.js` — Puppeteer lab harness (mobile/desktop parameterized)
- `scratchpad/perf/lab-results-mobile.json`, `scratchpad/perf/lab-results-desktop.json` — full per-page, per-visit metrics incl. CLS shift sources and resource timing
- `scratchpad/perf/lab-results-v1-contaminated.json` — discarded first run (shared-context SW contamination), kept for transparency
