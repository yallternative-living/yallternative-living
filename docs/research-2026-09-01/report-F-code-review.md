# Report F -- hostile code review (working tree + recent main commits)

Repo: /Users/steven/Documents/GitHub/yallternative-living, branch main, 2026-09-01.
Scope: uncommitted diff (14 files + untracked workers/routes/order-summary.js, scratch/) and commits de104db, b1cb8aa, ba984dd, 9962c00, f9f2be8, a249dc6, d90cbd7, 93d8710.
Method: every finding below was verified by reading the cited lines, running `node scripts/verify-build-reproducibility.js`, rebuilding the site data in a scratch copy, and one Puppeteer probe for the CSS focus question. Nothing in the repo was modified.

---

## BLOCKERS (must fix before deploy)

None found that would lose money or leak PII. The two MAJOR items below are the ones I would not ship without fixing, but neither is a money-path or data-leak defect.

---

## MAJOR

### M-1. CSS `visibility` transition breaks the mobile-nav focus move (a11y regression) -- CONFIRMED
- assets/css/styles.css:739-752 (new `visibility: hidden` + `transition: visibility 0.2s ease` on `.nav-links` at `max-width: 1024px`)
- assets/js/main.js:113-128 (`navToggle` click: `classList.toggle("open")` then synchronously `firstLink.focus()`)

The element at styles.css:739 is `.nav-links` (selector opens at line 659), i.e. the mobile hamburger drawer. main.js:119-127 explains why it moves focus into the first link the instant the drawer opens: the toggle sits after the drawer in DOM order, so a keyboard user who opens the menu and presses Tab would otherwise leave the menu. With `visibility` now in the transition list, a synchronous `focus()` in the same task as the class change runs while the computed `visibility` is still `hidden` (a `visibility` transition from hidden to visible evaluates to the start value at progress 0), so the call is a no-op and focus stays on the toggle. I reproduced this with a Puppeteer probe replicating the exact rule and the exact JS sequence (scratchpad/agentF/focus-probe.js): with the new CSS `document.activeElement` after click is the BUTTON and `getComputedStyle(navLinks).visibility` at the time of the focus call is `"hidden"`; with the old CSS (opacity/transform only) the first link is focused. No existing test catches this: puppeteer_tests.js:141-145 only checks `display !== "none"` after a 500 ms sleep, and cross-browser-check.js:377-406 tests the underline at desktop width.

Fix: keep `visibility: hidden` (it is a real improvement -- closed-drawer links stop being hit-testable/focusable even where `inert` is unsupported) but drop `visibility` from the `transition` shorthand and use `transition-delay` instead, so the open direction is instant and only the close direction is delayed: `transition: transform .25s ease, opacity .2s ease, visibility 0s linear .2s;` and in `&.open { transition-delay: 0s; }` -- or, in main.js, defer the focus with `requestAnimationFrame(function(){ requestAnimationFrame(...) })`. Then add an assertion to puppeteer_tests.js's mobile-menu step that `document.activeElement` is inside `.nav-links` after the click, so the focus move is pinned.

### M-2. thank-you.js paints a settled "Order Total" for a session it never checked was paid -- CONFIRMED
- assets/js/thank-you.js:114-137 (uses `summary.amountTotalCents` whenever `summary.found`, never reads `summary.paymentStatus` / `summary.status`)
- workers/routes/order-summary.js:80-81 (`paymentStatus: session.payment_status || "paid"`, `status: session.status || "complete"` -- defaults invent the good state when Stripe omits the field)
- thank-you.html:110 eyebrow "Order Confirmed · Receipt Issued", :133 "Verified Stripe Payment"

The route returns 200/found for any retrievable session, including `status: "open"` / `payment_status: "unpaid"` (the shopper closed the Stripe tab) and `status: "expired"` (the Worker itself expires sessions on ledger contention, workers/checkout.js:1393). The success_url only fires after payment, but the shopper -- or anyone who was sent the link -- can open `thank-you.html?session_id=cs_...` for an unpaid session and now sees a fetched, "verified" total under "Order Confirmed · Receipt Issued", which is exactly the fabricated-receipt failure the H-6 audit item was about. Before this diff the page at least only echoed the URL hint. The `|| "paid"` / `|| "complete"` defaults make it worse: a partial Stripe object would be reported as paid.

Fix: in order-summary.js return `paymentStatus: session.payment_status || null`, `status: session.status || null`; in thank-you.js only overwrite the amount when `summary.paymentStatus === "paid"` (or `"no_payment_required"` for the 100 %-covered case) and `summary.status === "complete"`, otherwise leave the URL hint alone or hide the amount group. Add a Test 21b with `payment_status: "unpaid", status: "open"` asserting the page-facing contract (or at minimum that the route echoes the real status).

---

## MINOR

### m-1. /api/order-summary is readable by any no-Origin caller holding a session id -- CONFIRMED (accepted by design, needs to be stated)
- workers/checkout.js:1440-1449 (GET allowed only for `/order-summary`; Origin gate passes when the header is absent)
- workers/routes/order-summary.js:72-86 (explicit allowlist: sessionId, amountTotalCents, amountSubtotalCents, amountDiscountCents, currency, paymentStatus, status)
- workers/routes/order-status.js:36-89 and workers/state/stripe-orders.js:119,139-142 (order-status requires the checkout email, byte-identical 404 on mismatch, POST-only)

A same-origin browser GET sends no Origin, and neither does curl or a top-level navigation, so anyone with a `cs_...` id can read the totals. The route body is an explicit allowlist and I confirmed no `customer_details`, `customer_email`, `shipping_details`, `line_items`, `payment_intent`, `metadata` or Stripe error strings are copied out (order-summary.js:65-82). So the leak is bounded to: subtotal, total, discount amount, currency, status. That is a deliberate trade-off (the thank-you page has no email to send), but it is the opposite of the authorisation model order-status.js:10-15 and stripe-orders.js:17-24 argue for ("knowing a session id is not authorisation -- ids sit in browser history, shared links and Referer headers"). The same id is already in the thank-you URL (`amount=` too, workers/checkout.js:1127), in Netlify/Cloudflare request logs, in browser history, and -- because the Umami snippet at scripts/build-site-data.js:2699 has no `data-exclude-search` -- in Umami's page-view URL. The marginal new disclosure is the discount amount and the live status.

Fix: document the bounded disclosure in the route header (it currently says "public-safe" without saying what the boundary is); do NOT widen the payload later (see m-3 for the one field that is safe to add). Consider `data-exclude-search="true"` on the Umami tag, which removes `session_id` and `amount` from third-party analytics for free.

### m-2. Rate limit on order-summary is fail-open and IP-keyed on a spoofable header; unbounded Stripe reads are possible -- CONFIRMED
- workers/routes/order-summary.js:22-29 (`failOpen: true`)
- workers/state/rate-limit.js:67-87 (RATE_LIMITER binding -> RATE_LIMIT_COUNTER DO -> `source: "none"` success)
- workers/routes/http.js:109-115 (`clientIp` prefers first `X-Forwarded-For` entry)
- workers/wrangler.toml:104-105 (DO bound), :150-151 (RATE_LIMITER binding commented out)

With `RATE_LIMIT_COUNTER` bound on main the DO limiter is exact, but every check is a billed DO request and the key is the first XFF entry, which a caller hitting `*.workers.dev` directly (the documented alternative endpoint) sets freely -- http.js:103-107 admits this. On branch previews the DO migration is not applied (docs/AUDIT-2026-09-01.md:129) and the route runs with no limiter at all. Result: a caller who rotates XFF gets unlimited `GET /v1/checkout/sessions/{guess}` against the live Stripe key. Stripe ids are ~60 random chars so enumeration will not find real sessions; the cost is Stripe's per-key rate limit and DO request quota, i.e. a DoS on order-status/order-summary/gift-card-balance which share the key and the DO namespace. Whether Netlify's proxy forwards the shopper's IP in `X-Forwarded-For` is asserted by the comment but not verified here (SUSPECTED); Netlify does set `x-nf-client-connection-ip` on proxied requests, which the code does not read.

Fix: read `x-nf-client-connection-ip` before XFF; consider `failOpen: false` for order-summary (unlike checkout, a 429/503 here degrades to "the URL amount is shown", which is what the page already handles) and enable the free `RATE_LIMITER` binding in wrangler.toml so a preview without the DO still has a limiter.

### m-3. Gift-card redemptions will be labelled "Coupon / Promo Applied" -- CONFIRMED
- workers/checkout.js:1285-1306 (gift card applied as a single-use Stripe coupon; `metadata.gift_card_amount_applied_cents` written on the session)
- workers/routes/order-summary.js:67-70 (only `total_details.amount_discount` is read)
- assets/js/thank-you.js:130-132 (label text hardcoded)

Stripe folds the ephemeral gift-card coupon into `total_details.amount_discount` (present without `expand[]`; only `total_details.breakdown` needs expansion), so a $62 order paid entirely with a gift card renders as "Order Total $0.00" plus "Coupon / Promo Applied (-$62.00)". The session's own metadata (`gift_card_amount_applied_cents`, checkout.js:1306) is on the default session object, so the route can distinguish the two without another Stripe call and without exposing the code (`gift_card_redeemed_code` must stay server-side).

Fix: in order-summary.js add `giftCardAppliedCents: Number(session.metadata && session.metadata.gift_card_amount_applied_cents) || 0` and have thank-you.js say "Gift card applied (-$X)" / "Coupon applied (-$Y)" where Y = amountDiscount - giftCardApplied. Also reconsider "Order Total $0.00" for the fully-covered case -- "Paid today: $0.00 -- covered by your gift card" is what the customer actually did.

### m-4. Test 21 is a happy-path-only test and does not prove the route talks to Stripe correctly -- CONFIRMED
- scripts/worker-checkout.test.js:1007-1046

Only the 200 path is asserted. Nothing tests: GET without an Origin header (the case the browser actually sends), the POST body form, `invalid_session_id` -> 400, Stripe 404 -> 404, rate-limited -> 429, missing `STRIPE_SECRET_KEY` -> 500, or that a session carrying `customer_details`/`line_items`/`metadata.gift_card_redeemed_code` comes back without them (the mock at :1018-1027 does not even include those fields, so nothing proves the allowlist). The `fetchImpl` mock ignores its second argument, so the `Authorization: Bearer` header and `Stripe-Version` are never asserted -- per AGENTS.md "checks that stop checking", if someone dropped the headers the test would still be green.

Fix: capture `(url, init)` in the mock and assert `init.headers.Authorization === "Bearer sk_test_mock"` and `init.headers["Stripe-Version"]` equals the shared constant; feed a mock session with `customer_details.email`, `shipping_details`, `line_items`, `metadata.gift_card_redeemed_code` and assert `JSON.stringify(body)` contains none of them; add the 400/404/429/500 cases; send one request with no Origin header.

### m-5. `STRIPE_API_VERSION` now has three copies -- CONFIRMED
- workers/routes/stripe.js:6-17 (exported constant, comment says the Netlify functions "each pinned ... in their own const" and this was the fix)
- workers/state/stripe-orders.js:35, workers/routes/order-summary.js:14 (local re-declarations)

All three are `"2026-06-24.dahlia"` today, so there is no version mismatch, but the new route re-creates the drift the stripe.js header explains it removed; the next version bump in stripe.js silently leaves the two read paths on the old version. scripts/qa-check.js:1538 only checks that checkout.js contains the string `Stripe-Version`.

Fix: `import { STRIPE_API_VERSION } from "./stripe.js"` in both files; add a qa-check assertion that `"2026-06-24.dahlia"` (or the regex `/\d{4}-\d{2}-\d{2}\.\w+/`) appears in exactly one file under workers/.

### m-6. `!res.ok` -> 404 masks Stripe auth/rate-limit/5xx as "not found" -- CONFIRMED
- workers/routes/order-summary.js:56-58

A 401 (wrong/rotated key), 429 (Stripe rate limit) or 5xx is returned as `{found:false,error:"not_found"}`; the page silently keeps the URL hint and nothing is logged, so a broken key on this route is invisible. stripe-orders.js:131-134 does this correctly (404/400 -> not found, else throw -> router logs + generic 500).

Fix: mirror stripe-orders.js: `if (res.status === 404 || res.status === 400) return 404; throw new Error(...)` and let the router's catch log it.

### m-7. Docs say "nine 404 blocking rules"; the generator and netlify.toml have eleven -- CONFIRMED
- docs/AUDIT-2026-09-01.md:130, docs/STATE-LAYER.md:268 ("nine")
- scripts/build-security-headers.js:96-108 (`BLOCKED_PATHS` has 11 entries), netlify.toml (11 `status = 404` rules: /scripts/*, /docs/*, /workers/*, /cms-auth/*, /netlify/*, /package.json, /package-lock.json, /*.md, /.eslintrc.json, /run-launch-checks.command, /TEST_INFRA.md)

The old text said "four 410 rules"; the replacement is also wrong, and its parenthetical list omits `run-launch-checks.command` and `TEST_INFRA.md`. On vercel.json: build-security-headers.js:456-484 writes headers only; vercel.json carries zero 404/blocking rules, so a Vercel deploy would serve /scripts/*, /docs/*, /workers/* publicly. The docs do not claim vercel parity for the *blocking rules* (AUDIT:285 claims header byte-parity only, which qa-check enforces), so that statement is true but the gap is real if Vercel is ever the deploy target.

Fix: say "eleven" (or better, "the `BLOCKED_PATHS` list in scripts/build-security-headers.js") in both docs; add one sentence noting vercel.json has no equivalent path blocks.

### m-8. Emoji field: unvalidated, undocumented length, and the CMS hint over-promises -- CONFIRMED
- admin/config.yml:547 (plain `string` widget, no `pattern`, hint says "displayed in the countdown ticker and events banner"), :562 (same field on `past` events)
- scripts/build-site-data.js:888 (`emoji: evt.emoji` copied verbatim)
- assets/js/main.js:5914-5917, 5933-5936, 5989-5992 (escaped via `attrEsc` before `innerHTML`, so no XSS)

`attrEsc` (main.js:673-682) escapes `& < > " ' \``, so HTML injection is closed. But nothing limits length: a 200-character string is rendered inline in the hero ticker badge with `margin-right:4px`, ahead of "NEXT POP-UP:" -- the ticker is single-line and would wrap or push the countdown off. The "events banner" is `#eventsCountdownBanner` (index.html and events.html), which is fine, but the events.html *list* (main.js:3778, 4341) never reads `emoji`, and the `past` collection gets the field with no consumer at all -- an editor filling it on a past event sees nothing. The Worker's `loadEvents`/`findPickupEvent`/`resolvePickupAddress` (checkout.js:232-247, 379-396) only read name/location/zip and ignore extra keys -- tolerant. No test covers the field: events-engine.test.js fixtures (:116-128) and build-site-data.test.js do not mention `emoji`.

Fix: add `pattern: ['^.{0,8}$', "One emoji, please."]` (or a grapheme-aware check in build-site-data.js that fails the build past ~8 code points) and a `.ticker-emoji` rule (none exists in styles.css); drop the field from `past` or wire it; reword the hint to "shown in the home-page countdown and the events-page countdown card"; add the field to one events-engine/build-site-data fixture so the pass-through is asserted.

### m-9. Netlify proxy + GET query string -- SUSPECTED OK, unverified here
- netlify.toml:40-43 (`/api/*` -> workers.dev `/:splat`, status 200, force)
- workers/checkout.js:825-830 (`routeOf` strips `/api`, matches on `pathname` only, so `?session_id=` survives)

Netlify's documented behaviour is that proxied rewrites forward the original query string to the destination; I did not exercise a live deploy. `routeOf` is correct for `/order-summary?session_id=...` because it only receives `pathname`. If the query were ever dropped, the route answers 400 `invalid_session_id` and the page keeps the URL hint -- fail-safe, but the feature would be silently dead. The POST body path (order-summary.js:36-37) exists but thank-you.js only uses GET.

Fix: after deploy, curl `https://yallternativeliving.com/api/order-summary?session_id=cs_test_x` and expect 404/400 JSON, not a 405 or the Worker's 400 for a missing id. Or switch thank-you.js to POST `{sessionId}`, which order-status.js already argues is the right shape ("never GET: a reference in a query string lives in history and Referer").

### m-10. scratch/ is untracked, not ignored, and 1.1 MB of PNGs sit in the publish root -- CONFIRMED
- scratch/test-render-thank-you.js (starts a static server on 8089 serving the repo root), 3 PNGs (1.1 MB)
- .gitignore: `tmp/` and `*.tmp` are ignored; `scratch/` is not

Netlify publishes `.` (build-security-headers.js:90-95), so if scratch/ were ever committed, the screenshots and the script become public URLs and there is no 404 rule for `/scratch/*`. The script also hardcodes a live-looking `cs_live_...` id in a URL.

Fix: add `scratch/` to .gitignore (or delete the directory); if it stays, add `/scratch/*` to `BLOCKED_PATHS`.

---

## NITS

### n-1. `Access-Control-Allow-Methods: GET, POST, OPTIONS` is advertised for every route -- CONFIRMED, harmless
- workers/routes/http.js:56; router workers/checkout.js:1440 still 405s GET on everything except `/order-summary`

A same-origin GET never preflights, so the change has no effect on the thank-you page; cross-origin GETs are still 403'd by the Origin gate. Only scripts/backend-functions.test.js:115 pins the header (`includes("POST")`), so nothing broke. Cosmetic inaccuracy for four routes.

### n-2. Session-id regexes disagree between client and route -- CONFIRMED
- assets/js/thank-you.js:43 `/^cs_(live|test)_[A-Za-z0-9]+$/`; workers/routes/order-summary.js:40 `/^cs_(live|test)_[A-Za-z0-9_]{8,255}$/`; workers/state/stripe-orders.js:44 `/^cs_[A-Za-z0-9_]{8,255}$/`

Three shapes for the same id. Harmless today; pick one and export it.

### n-3. thank-you.js unhides the amount group from the fetch even when `hasAmount` was false -- CONFIRMED, intended
- assets/js/thank-you.js:92-98 (sync: hides group), :118-123 (async: shows it)

No race: the sync path runs first, the fetch resolves later and overwrites. That is the intended "settled total wins" behaviour, and it also revives the receipt block for a hand-typed URL with no `amount=` -- which is fine only once M-2 is fixed. `Number(summary.amountDiscountCents) || 0` (:124) is robust to null/undefined/strings (NaN -> 0). All new DOM writes are `textContent` (:117, :130, :150, :152); the only `innerHTML` writes are in main.js and are `attrEsc`-wrapped.

### n-4. Rate-limit check runs before id validation -- CONFIRMED, fine
- workers/routes/order-summary.js:22-42
A burst of malformed ids consumes the caller's own budget and a DO request each. Acceptable; noting so nobody "optimises" it the other way round.

### n-5. `.session-code` ellipsis works -- CONFIRMED (the attack premise was wrong)
- assets/css/styles.css:5054-5060 (`.session-label-group { display:flex; flex-direction:column; overflow:hidden }`), :5068-5075 (`.session-code` nowrap/ellipsis/max-width 360px), :5226-5228 (180px at <=600px)

`<code>` is inline by default, but as a child of a column flexbox it is a flex item and therefore blockified, so `text-overflow: ellipsis` applies. Truncating a 66-character reference to ~360px does mean the visible text is not the full id; the Copy button (thank-you.html:144) copies `sessionId` from the JS variable, not the truncated text, so that is fine.

### n-6. `thank-you.js:200` still refers to a "digital gift-certificate renderer that used to live here" -- CONFIRMED, comment-only
Not a stale selector (93d8710's qa-check guard at scripts/qa-check.js checks `.gift-cert-` in styles.css, and nothing in HTML/JS uses the retired classes). Just historical narration; fine to keep.

---

## VERIFIED OK

- **Build reproducibility / derived-file drift (angle 8).** `node scripts/verify-build-reproducibility.js`: 53 tracked files byte-identical across 5 runs; `sw.js CACHE_NAME` is the content digest `yallternative-cache-va7550d704d13` and unchanged by rebuild. Independent rebuild in a scratch copy (`rsync` minus node_modules/.git/scratch, `node scripts/build-site-data.js`) then `diff -rq` against the working tree: **zero differences** -- events-data.js, products-data.js, search-data.js, sw.js, products/*.html, sitemap.xml, feed.xml all agree with assets/data/. The working-tree sw.js digest bump is correct.
- **sw.js never caches /api/ (angle 8).** sw.js:128-130 returns before any `caches.match`/`respondWith` for `/api/` and `/.netlify/`; http.js:64-73 adds `Cache-Control: no-store` to every JSON response. The GET is not cached.
- **Router method gate (angle 6).** workers/checkout.js:1440: GET is accepted only when `route === "/order-summary"`; `/checkout`, `/gift-card-balance`, `/stripe-webhook`, `/order-status`, `/restock` still 405 on GET. Origin gate at :1445-1447 unchanged.
- **order-status route (angle 12).** workers/routes/order-status.js + workers/state/stripe-orders.js: requires `sessionId` AND email (stripe-orders.js:119), compares against `customer_details.email` case-insensitively (:139-142), identical 404 for unknown session and wrong email (:41,132,137,142), rate-limited 5/min (order-status.js:29,37-40). Returns status, payment status, total, line names/quantities, shipping city/state only; `trackingUrl` is http(s)-filtered (:52-60). Stripe errors are `throw new Error(...)` (:121,133) which the router (checkout.js:1454-1460) turns into a generic 500 -- no Stripe string reaches the client. No-Origin callers can reach it too, but the email requirement is the credential, so that is fine. Consistent with its own doc header; the *inconsistency* is that order-summary.js relaxes that model (m-1).
- **Gift-card price doubling fix, ba984dd (angle 13).** main.js:6786-6795 `formatVariantChipLabel`: a label matching `/\$\s*\d/` is returned as-is. Root cause (label already states the price) is addressed generally, not special-cased to gift cards; the only labels in products.json containing `$` are the six `Preset $NN` gift-card options, so the regex cannot misfire today. No other doubling path: cart.js:290-300 sends only the variant label and the Worker re-derives the amount; search-data.js:1090-1110 carries the labels with `priceDelta` for search display only; build-site-data.js:1445-1475 emits `Preset $NN[+delta]` for the Snipcart-style attribute and validates the label shape at build time (exit 1 on mismatch).
- **b1cb8aa D1 binding.** wrangler.toml:128-131 binds `STATE_DB` with a concrete id; comments rewritten to match. Nothing else in the diff. Correct as long as the id is real (cannot verify offline).
- **d90cbd7 CSP baseline probe.** build-security-headers.js:161-166 `SECURITY_HEADERS_EXTRA_PAGES` can only append pages; :229-231 `path.resolve` so absolute probe paths are not re-rooted; test asserts the probe is present with the var and absent without it. The gate cannot be narrowed through the hook.
- **93d8710 CSS cleanup.** qa-check.js now fails if `.packing-slip-`, `.order-status-card`, `.reorder-past-order-btn`, `.gift-cert-` reappear in styles.css; grep of *.html and assets/js confirms no live markup uses them.
- **Search test commits a249dc6 / f9f2be8 / 9962c00.** Replace fixed sleeps with bounded `waitForFunction`/`waitForSelector` on real modal state (`#global-search-modal[open]`, focused input), and the failure message now dumps the modal state. The 5 s waits are wrapped in try/catch but the assertion below still reports the real count, so a timeout cannot pass vacuously.
- **XSS surface (angle 3).** All new thank-you.js DOM writes use `textContent`; main.js emoji goes through `attrEsc` (main.js:673-682) which escapes `& < > " ' \``.
- **`total_details.amount_discount` (angle 4).** Present on the default Checkout Session object; only `total_details.breakdown` requires `expand[]`. The route's read at order-summary.js:67-70 is correct without expansion.
- **No line items, email, address or metadata in the order-summary payload (angle 1).** order-summary.js:72-82 is a hand-built object; confirmed by reading, not by test (see m-4).
- **`npm test`, `npm run lint`, `npm run format:check`** -- reported green by the coordinator; not re-run here beyond the reproducibility verifier.

## Angle index
1 -> m-1, M-2, VERIFIED OK · 2 -> m-2 · 3 -> n-3, VERIFIED OK · 4 -> m-3 · 5 -> m-4, m-5 · 6 -> n-1, VERIFIED OK · 7 -> m-9 · 8 -> VERIFIED OK · 9 -> m-8 · 10 -> M-1, n-5 · 11 -> m-7 · 12 -> VERIFIED OK (+ m-6 contrast) · 13 -> VERIFIED OK · 14 -> m-10
