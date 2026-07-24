# Snipcart → Stripe migration runbook

Snipcart has been **fully removed** from this codebase and replaced with an
on-site cart (`assets/js/cart.js` + `assets/css/cart.css`) that hands off to
**Stripe Checkout** via the Cloudflare Worker in `workers/checkout.js`. Result:
no $20/month Snipcart minimum — just Stripe's per-transaction fee.

This doc is kept as a record of the migration and, more importantly, as the
**remaining deploy checklist** — the code side is done, but nothing charges a
real card until the pieces below are actually deployed with real keys. (Note:
this migration was built directly on `main`, not a branch — git branch/commit
operations weren't available in the Cowork sandbox this was built in, and the
store wasn't live yet, so there was no live-checkout risk to protect against.)

---

## What's done (in the codebase now)

- `assets/js/cart.js` + `assets/css/cart.css` — cart engine + accessible
  native-popover drawer, reads the `data-item-*` attributes on the Add-to-Cart
  buttons, one-click upsells from `window.YL_PRODUCTS`, cross-tab sync,
  free-shipping meter, per-item stock cap, gift-card recipient/sender/message
  fields. Engine logic is unit-tested: `node scripts/cart-engine.test.js`
  (27 checks).
- `workers/checkout.js` — validates prices server-side against `products.json`
  (including gift-card amount clamping), never trusts a client-supplied price.
- `netlify/functions/fulfill-gift-card.js` — the `checkout.session.completed`
  webhook that emails a redeemable code once someone buys a gift card (see
  its own header comment and `workers/README.md`).
- Every page: Snipcart's loader script, preconnect, and `.snipcart-*` classes
  removed; `cart.js`/`cart.css` wired in instead.
- `scripts/build-site-data.js`, `scripts/build-security-headers.js`,
  `scripts/qa-check.js`, `sw.js`: all Snipcart-specific logic removed or
  replaced with the cart/Stripe equivalent.

**Not done yet — this is the actual remaining work:**
- Neither Worker is deployed. `workers/checkout.js` needs a real
  `STRIPE_SECRET_KEY` and a route at `/api/checkout`, or the cart's checkout
  button just fails with "Checkout unavailable."
- `fulfill-gift-card.js` needs its env vars set and to be registered as a
  Stripe webhook endpoint (see `workers/README.md`) or gift-card buyers'
  recipients never get emailed a code.
- Nothing here has been tested against a real Stripe account (test mode or
  live) — see step 10 below before trusting this with real money.

---

## The flip (each step, in order — kept for reference)

### 1. Deploy + wire the checkout Worker
- Deploy `workers/checkout.js` (see `workers/README.md`), route it at
  `/api/checkout`. Use a **test-mode** Stripe key first.
- `cart.js` already POSTs `{items:[{id,qty,variant}]}` there and redirects to the
  returned Checkout URL.

### 2. Include the cart assets on every page
- Add `<link rel="stylesheet" href="assets/css/cart.css">` after `styles.css`.
- Load `cart.js` (defer) and call `YLCart.init()` on DOMContentLoaded. Easiest:
  add it to the `sw.js` precache list and load it alongside `main.js`.

### 3. Remove Snipcart from every page — done
- Snipcart's inline `window.SnipcartSettings = {…}` + loader IIFE, and the
  `<link rel="preconnect" href="https://cdn.snipcart.com" crossorigin>` tag,
  are gone from all pages (including the new `thank-you.html`).
- Button/badge classes were renamed for real (not just "cart.js also matches
  the old ones"): `.snipcart-add-item` → `.yl-add-item`,
  `.snipcart-checkout` → dropped (just `.cart-toggle` now),
  `.snipcart-items-count` → `.cart-count`.

### 4. Gift cards — done
- Went with the "simplest" option: the Worker (`resolveGiftCardAmountCents` in
  `workers/checkout.js`) parses the custom amount for
  `id === "yallternative-gift-card"`, clamps it to $10–$500 server-side, and
  passes recipient/sender/message as Checkout `metadata`
  (`gift_card_N_recipient/_sender/_message/_amount_cents`).
- `gift-card.js` adds to `YLCart` (via the shared `.yl-add-item` click
  handler in `cart.js`) instead of setting `data-item-custom*`.
- The other half of this — actually turning that metadata into a redeemable
  code and emailing it — is `netlify/functions/fulfill-gift-card.js` (see
  step 6, and its own header comment).

### 5. Move the Purchase analytics event — done
- `main.js` no longer listens for any Snipcart event. `thank-you.html` (the
  Worker's `success_url` target) reads `amount`/`currency` off its own query
  string via `assets/js/thank-you.js` and fires
  `window.plausible("Purchase", { props: { revenue: {…} } })` (routes to
  Umami) there instead — best-effort only, see step 6.

### 6. Fulfillment = Stripe webhook, NOT the redirect — done, not deployed
- **Do not** treat the success redirect as "paid" — a dropped connection loses
  it. `thank-you.html`'s analytics ping is explicitly best-effort for this
  reason.
- `netlify/functions/fulfill-gift-card.js` is that webhook: it listens for
  `checkout.session.completed` and is what actually fulfills gift cards
  (creates a redeemable Stripe Promotion Code, emails it via Resend). It is
  **not yet registered** with Stripe — see `workers/README.md`'s deploy steps
  for this file before gift cards work end to end.
- Nothing currently fulfills *non*-gift-card orders (no inventory decrement,
  no internal order-notification email) — the webhook only handles the gift
  card case because that's the one piece that used to depend on Snipcart.
  Add more `if (stripeEvent.type === "checkout.session.completed")` handling
  to the same function if/when that's wanted.

### 7. Update the CSP — done
`scripts/build-security-headers.js` no longer references `cdn.snipcart.com` or
`*.snipcart.com` anywhere, and `Permissions-Policy` is `payment=(self)`.
`scripts/qa-check.js` has a regression-guard check ("CSP has no leftover
Snipcart references") so this can't silently drift back. Re-run
`npm run build-security-headers` after any further CSP edits.

### 8. Update the build + QA — done
- `scripts/build-site-data.js` no longer generates `snipcart-products.json`
  or injects a `snipcartApiKey`.
- `scripts/qa-check.js`'s Snipcart-specific assertions were replaced with
  cart-equivalent checks: gift-card `data-item-custom1-options` round-trip
  (was the Snipcart manifest round-trip), bundle-pricing sanity recomputed
  live from `products-data.js` (was a snipcart-products.json freshness
  check — no longer needed at all, since bundle price is now computed in
  the browser at render time, not baked into a generated file), and the
  CSP-coverage list dropped Snipcart entirely.
- `assets/data/snipcart-products.json` is deleted.

### 9. Service worker — done
`/assets/js/cart.js`, `/assets/css/cart.css`, `/assets/js/thank-you.js`, and
`/thank-you.html` are all in `sw.js`'s `ASSETS_TO_CACHE`.

### 10. Test before going live with real money
- `node scripts/cart-engine.test.js` — passing (27 checks).
- `npm test` (qa-check) — passing (258 checks).
- `npm run lint` / `npm run format:check` — passing.
- `npm run test:integration` (Puppeteer) — needs a real browser; couldn't run
  in the sandbox this was built in, but the test itself was updated to
  exercise the real `.yl-add-item` → drawer flow instead of the old Snipcart
  assertions.
- **Still needed, and this is the actual gate before trusting this with real
  money**: deploy `workers/checkout.js` and `fulfill-gift-card.js` with real
  Stripe **test-mode** keys (see `workers/README.md` for both), then manually
  run a real test-mode purchase end to end — regular product, variant
  product, and a gift card — and confirm the webhook actually fires and the
  gift-card email arrives with a working code. None of that was possible to
  verify in this sandbox (no way to receive an inbound webhook or a real
  Stripe test-mode session here). Only after that should the Workers get live
  keys.

---

## Cost after migration

| | Snipcart (before) | Stripe (now) |
| --- | --- | --- |
| Monthly minimum (under $1k/mo sales) | **$20/mo** | **$0** |
| Per transaction | 2% + gateway fee | 2.9% + 30¢, no platform fee |
| On-site cart | Snipcart-hosted | Your `cart.js` (owned, no vendor) |
| PCI scope | SAQ A | SAQ A (Stripe hosts card form) |

At low volume the $20/mo floor is the whole story — dropping it is the win.
