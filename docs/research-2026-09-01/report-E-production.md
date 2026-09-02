# Agent E -- Production customer-readiness audit (READ-ONLY)

Target: https://yallternativeliving.com, audited 2026-09-02 ~04:57-05:20 UTC.
Method: headless Puppeteer (repo's node_modules), one fresh browser context per page load so the
service worker could not mask HTTP status/bytes; request interception aborted EVERY non-GET/HEAD/OPTIONS
request and any navigation to checkout.stripe.com. Desktop 1280x800 and iPhone 13 emulation.
Exactly 4 API curls were made (3a-3d below); no form was submitted, no Stripe session created,
no newsletter/contact/review/restock request left the browser (the only blocked POSTs were
`POST /api/checkout` from the deliberate cart test and Tawk's own `va.tawk.to/v1/session/start`).
Evidence files: scratchpad/agentE/ (results2.json, shot-*.png, prod-*.html/js, headers-index.txt).

## BLOCKERS (live and customer-facing right now)

None found. The money path is intact: cart works, `/api/checkout` is reachable through the Netlify
proxy, `/api/order-status` answers JSON with the right CORS/anti-enumeration behaviour, CSP has zero
violations on every page at both viewports, and the checkout-failure UI degrades gracefully (see 5).

## MAJOR

### M1. Bare /thank-you.html (no session_id) renders a fully "confirmed" order
- URL: https://yallternativeliving.com/thank-you.html (no query string). Both viewports.
- Repro: open the URL directly. Screenshots: shot-desktop-thank_you_html.png, shot-mobile-thank_you_html.png.
- Evidence: page shows "ORDER CONFIRMED · RECEIPT ISSUED", green "Payment Received" pill, "Sep 1, 2026",
  a "Verified Stripe Payment" badge, an empty "Reference ID:" box, and the progress tracker with
  "Order Placed / Payment confirmed" ticked. Nothing on the page was verified -- there is no session.
- Why it matters: anyone landing here from history/bookmark/shared link sees a confirmation with no order.
  A customer whose Stripe redirect failed could also believe they paid.
- Suspected cause: deployed thank-you.js is the pre-order-summary version (0 references to
  `/api/order-summary`; repo working tree has 68 differing lines and fetches
  `/api/order-summary?session_id=`). The deployed page shows static "confirmed" copy regardless of input.
  This is the exact thing the pending thank-you/order-summary work fixes; it is not deployed (see DEPLOYED-VS-PENDING).

### M2. /README.md is served (200 text/markdown, 6458 B) despite the `/*.md` block rule
- URL: https://yallternativeliving.com/README.md -> HTTP 200, content-type text/markdown.
- Repro: `curl -o /dev/null -w "%{http_code}" https://yallternativeliving.com/README.md`
- Compare: /TEST_INFRA.md -> 404 (it has its own explicit rule), /docs/AUDIT-2026-09-01.md -> 404 (via /docs/*),
  /package.json -> 404, /scripts/qa-check.js -> 404, /workers/checkout.js -> 404 (all correct).
- Suspected cause: Netlify redirect rules only support a trailing `*` splat; `from = "/*.md"` in
  netlify.toml does not match. Every top-level .md without an explicit rule is exposed
  (README.md confirmed; AGENTS.md, PROJECT.md, ui_ux_report.md exist in the publish root and are
  likely exposed too -- not fetched, to stay within the polite-request budget). Fix: add explicit rules
  per file, or move the docs out of the publish root.

### M3. Malformed SVG path on reviews.html and order-status.html (console error, broken theme-toggle moon icon)
- URLs: /reviews.html, /order-status.html. Both viewports.
- Evidence: console `Error: <path> attribute d: Expected arc flag ('0' or '1'), "… 0 0 9 9 9 0 1 1-9-9Z".`
- Source: repo reviews.html:95 and order-status.html:96, `<path d="M12 3a6 6 0 0 0 9 9 9 0 1 1-9-9Z"/>`
  in the dark-mode toggle knob (`icon-moon`). The arc command is missing a parameter, so the moon icon
  does not draw. Other pages use a different (valid) markup. Cosmetic + a hard console error on two
  customer pages; identical in repo and production.

## MINOR

### m1. Preload of unisex-tshirt-800.avif unused within load window (desktop home)
- URL: / desktop only. Console: `The resource .../assets/img/unisex-tshirt-800.avif was preloaded using
  link preload but not used within a few seconds from the window's load event.`
- Suspected cause: hero `<link rel=preload>` targets the 800w variant while the rendered `<picture>` picks
  a different candidate at 1280px DPR1 (or the image is lazy). Wasted bytes on the LCP path, not a break.

### m2. "Deprecated API for given entry type." warning on every page
- Source: assets/js/main.js:235-239 (`PerformanceObserver.supportedEntryTypes` / `getEntriesByType("paint")`).
  Harmless Chrome deprecation warning, but it appears in every customer console.

### m3. Product detail pages are client-side redirected to shop anchors
- /products/sleep-salve.html and /products/yallternative-gift-card.html return HTTP 200 with a full
  product page (title "Hush Y'all Magnesium Arnica Sleep Salve | ..."), then line 35
  `window.location.replace("../shop.html#" + slug)` sends the visitor to /shop.html#sleep-salve.
  Same in the repo. Observed final URL in both viewports: https://yallternativeliving.com/shop.html#sleep-salve.
  Not a bug per se (appears intentional) but: search engines index the PDP HTML while humans never see it,
  and the redirect costs a second full page load (38-42 requests vs 30 for /shop.html directly).

### m4. Umami and Google Translate are not actually deployed
- Every page: `umamiTag=false`, `translateEl=false`. Production index.html line 71 is the empty
  `<!--YL:site.umamiWebsiteId--><!--/YL:site.umamiWebsiteId-->` placeholder; no umami script tag,
  no translate element, no request to cloud.umami.is or translate.google.com was made on any page.
  The "EN" globe button in the header is present but there is no translate widget behind it (not clicked).
  CSP allow-lists them anyway (harmless). Analytics are therefore collecting nothing.

### m5. Service-worker cache name differs from the working tree (expected)
- Production sw.js: `CACHE_NAME = "yallternative-cache-v0daa6d3d47d6"`; repo working tree:
  `"yallternative-cache-va7550d704d13"`. The SW registers and activates on first load on every page
  (scope https://yallternativeliving.com/, active sw.js, state "activated"), `caches.keys()` =
  ["yallternative-cache-v0daa6d3d47d6"]. sw.js itself is served with
  `cache-control: public,max-age=0,must-revalidate` (good -- updates will be picked up).

### m6. Tawk.to embed script fails ONLY under a HeadlessChrome user-agent (not customer-facing)
- Desktop Puppeteer runs logged `Access to script at 'https://embed.tawk.to/6a9687f6.../1k1e066pc' ...
  blocked by CORS policy: No 'Access-Control-Allow-Origin' header`. With the iPhone 13 emulated UA the
  same interception config loaded all 11 Tawk requests OK. curl with a real desktop Chrome UA and an
  iPhone UA both return 200 + `access-control-allow-origin: *`; curl with a `HeadlessChrome/131` UA
  returns 403 text/html with no ACAO. Conclusion: Tawk bot-blocks headless Chrome; real customers are
  not affected. Noted so the next auditor does not chase it.

## DEPLOYED-VS-PENDING

Production was compared against the repo working tree (git status shows 14 modified files + untracked
workers/routes/order-summary.js). Netlify post-processing rewrites `x.html` links to pretty URLs
(`/shop`, `/events` ...) and single-quotes attributes, which accounts for ~44-50 of the differing lines in
every page; all pretty URLs resolve 200 (/shop, /events, /about, /faq, /contact). Ignoring that noise:

| Item | Production | Working tree | Status |
|---|---|---|---|
| assets/js/cart.js | identical | identical | deployed |
| index.html, shop.html, events.html | content identical (links rewritten only) | -- | deployed |
| thank-you.html layout | old: "Thank You, Y'all!", "Reference ID:" label, no Copy button, Keep Shopping primary | new: "Thanks, Y'all!", "Order Reference" + Copy button, `#thankYouAmount`, Track Order Status primary, "← Back To Home" sub-link | PENDING (86 diff lines) |
| assets/js/thank-you.js | no `/api/order-summary` call | fetches `/api/order-summary?session_id=` (68 diff lines) | PENDING |
| workers/routes/order-summary.js (GET) | Worker answers `404 {"error":"Not Found"}`; OPTIONS advertises `POST, OPTIONS` only | untracked new route | PENDING (uncommitted) |
| Events emoji | events-data.js lacks `"emoji": "✨"` | present | PENDING (1 line) |
| assets/js/main.js | 34 differing lines | -- | PENDING |
| assets/css/styles.css | 150 differing lines (thank-you styles etc.) | -- | PENDING |
| sw.js CACHE_NAME | v0daa6d3d47d6 | va7550d704d13 | PENDING (bumps on deploy) |
| order-status.html + Worker order-status route | deployed and live (real lookup, 404 for unknown) | -- | deployed |

Note: deploying thank-you.js before workers/routes/order-summary.js is live would make every real
thank-you page hit a 404 JSON; ship the Worker route first (or together) and verify with 3a/3b again.

## VERIFIED OK

### 1. Page loads (all 11 URLs x 2 viewports; results2.json)
- HTTP: all 200; /404-does-not-exist -> 404 with the branded "Well, This Trail Went Cold" page (title
  "Page Not Found | Y'allternative Living"). Titles correct on every page. No `pageerror` on any page.
- CSP: 0 "Content Security Policy"/"Refused to" console messages on any page, either viewport.
- Failed subresources: none other than the headless-only Tawk case (m6). Google Fonts: 3/3 stylesheet/font
  requests OK on every page (5 requested incl. preconnects). Kit newsletter form present (`app.kit.com`
  action) -- not submitted. No Stripe request was ever made.
- Timing (desktop, cold context): TTFB 354-390 ms, DOMContentLoaded 0.82-0.92 s, load 0.91-1.01 s
  (home 1011 ms). Mobile: load 0.86-1.11 s. Redirected PDPs: 436-563 ms for the second hop.
- Transferred bytes (encoded, all requests): desktop 454-668 KB (home 652 KB, shop 577 KB, gift-card
  redirect 668 KB); mobile 684-851 KB (higher because Tawk's ~200 KB widget actually loads there).
- No horizontal overflow at 390px on any page (`scrollWidth <= clientWidth`).
- Visual check (screenshots): home, shop, events, order-status, 404 render correctly at both viewports;
  dark theme, countdown banner ("NEXT POP-UP: 45 DAYS ... AUTUMN APOTHECARY FAIRE"), star rating, filters,
  concern chips, Track Order Status button all present.
- Service worker registers and activates on every page at both viewports (m5 for the name).

### 2. Response headers on / (headers-index.txt) vs repo `_headers`
- Content-Security-Policy: byte-identical to `_headers` / netlify.toml (1089 chars, same 5 script hashes).
- Strict-Transport-Security: `max-age=63072000; includeSubDomains; preload` -- matches.
- X-Frame-Options: DENY; CSP `frame-ancestors 'none'` -- matches.
- Referrer-Policy: strict-origin-when-cross-origin -- matches.
- Permissions-Policy: `geolocation=(), microphone=(), camera=(), usb=(), payment=(self)` -- matches.
- X-Content-Type-Options: nosniff; Cross-Origin-Opener-Policy: same-origin-allow-popups -- match.
- Cache-Control: HTML `public,max-age=0,must-revalidate` + ETag; /assets/css/* and /assets/js/*
  `public,max-age=604800`; sw.js `max-age=0,must-revalidate`. Matches netlify.toml intent. No drift.
- /api/* responses (from the Worker) carry `cache-control: no-store`, `vary: Origin`, HSTS max-age=31536000
  (Cloudflare's), and no CSP -- appropriate for JSON.

### 3. API surface (exactly 4 curls)
- a) `OPTIONS /api/order-summary` (Origin yallternativeliving.com, ACRM GET) -> **204**,
  `access-control-allow-methods: POST, OPTIONS`, `access-control-allow-origin: https://yallternativeliving.com`,
  `access-control-allow-headers: Content-Type`, cache-control no-store. (GET not advertised -- route not deployed.)
- b) `GET /api/order-summary?session_id=cs_test_000000000000` -> **404** `application/json`
  `{"error":"Not Found"}` with the Worker's CORS headers and `netlify-vary: query`. Netlify's /api/* proxy
  DOES forward GET to the Worker (this is the Worker's JSON, not a Netlify HTML 404 page).
- c) `POST /api/order-status` same-origin, body `{"sessionId":"cs_test_000000000000","email":"nobody@example.com"}`
  (field name per workers/routes/order-status.js: `sessionId`/`session_id` + `email`; `orderId` is not read)
  -> **404** `{"found":false,"error":"not_found"}`, cache-control no-store, ACAO = site origin, vary Origin.
  Matches the route's anti-enumeration contract.
- d) same POST with `Origin: https://evil.example` -> **403** `{"error":"Forbidden origin"}`. Correct.
- Blocked source paths: /scripts/qa-check.js 404, /docs/AUDIT-2026-09-01.md 404, /package.json 404,
  /workers/checkout.js 404, /TEST_INFRA.md 404 (all serve the branded 404.html, 21288 B). /README.md 200 (M2).
- /admin/ -> 200 text/html (2301 B) -- the CMS shell is reachable as intended (not interacted with).

### 5. Cart drawer + Checkout under a simulated Worker outage (POST /api/checkout aborted client-side)
- Repro (desktop, /shop.html): clicked the real "Add to Cart" button for sleep-salve
  (`.yl-add-item[data-item-id="sleep-salve"]`, $19.99). Drawer opened automatically, count=1, line
  "Hush Y'all Magnesium Arnica Sleep Salve  -1+  $19.99", dispatch note "Order in next 12h 47m to ship today
  from Landrum, SC!", cross-sell row, Mix & Match nudge, Alt-Points wallet, gift/pick-up toggles, free-shipping
  meter "Add $20.01 for Free Tracked Shipping!", Subtotal $19.99 / Shipping $10.00 / Estimated total $29.99.
  (shot-cart-1-drawer.png, shot-cart-3-footer-before.png)
- Clicked "Checkout". Interception aborted `POST https://yallternativeliving.com/api/checkout`
  (the only POST attempted; no navigation, URL stayed on /shop.html, no Stripe request).
- What the customer sees: an inline red-bordered box under the Share button, `role="alert"`:
  "Sorry -- checkout isn't available right now. Please try again in a moment." The Checkout button is
  re-enabled ("Checkout", disabled=false) and the cart still holds the item (count=1), so a retry is possible.
  The aria-live region also announced "Checkout error: Sorry -- checkout isn't available right now...".
  (shot-cart-4-checkout-error.png). This matches cart.js GENERIC_CHECKOUT_ERROR. Note the error box renders at
  the bottom of the drawer's scroll area; if the customer had scrolled up to the items it is below the fold.
- Cleanup: `YLCart.clear()` -> count 0, localStorage `yl-cart-v1` = `{"version":1,"items":[]}`. Test repeated
  once (cart2.js) with the same outcome. Cart.js is byte-identical between production and the repo.
