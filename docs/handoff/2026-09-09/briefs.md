# Briefs for the two gaps not yet started (2026-09-09)

Both hook `workers/checkout.js` session creation and the webhook. Apply
`inventory.patch` first and build on it. Owner rule and gates: see
`docs/HANDOFF-2026-09-09.md`.

## Promo code preview in the cart (§3 item 11)

Today `cart.js` sends `discount_code` and `workers/checkout.js` only stores it
as session metadata; the shopper learns whether a code works on Stripe's
page. Stripe Checkout accepts ONE `discounts[0]` entry, so a promotion code
and the gift-card coupon cannot both apply.

1. `POST /api/promo-preview` (`workers/routes/promo-preview.js`, registered in
   `ROUTES`): body `{ code, items }`; validate shape (upper alnum/dash, length
   cap); rate-limit 5/min per client, failOpen; look up via
   `GET /v1/promotion_codes?code=X&active=true` with `stripeGet` (expand
   coupon); return `{ valid, code, kind: "percent"|"amount", percentOff |
   amountOffCents, minimumAmountCents, restrictions: { firstTimeOnly },
   estimatedDiscountCents }` where the estimate uses checkout.js's own pricing
   (export a minimal `priceCart(catalog, items)` if needed). Invalid ->
   `{ valid: false, reason }` with curated copy, HTTP 200; never echo Stripe
   text or coupon ids.
2. Checkout: with a validated code and NO gift card, set
   `discounts[0][promotion_code]` to the id looked up server-side at checkout
   time and drop `allow_promotion_codes`; with a gift card applied keep
   today's behaviour and return a structured field so the drawer says "one or
   the other".
3. `cart.js`: "Have a code?" disclosure beside the gift-card one; estimated
   discount line and adjusted total; persist like the gift card
   (`yl_applied_promo`); re-validate on cart change (debounced); clear with a
   clear error when invalid. Strings via `tr(...)` +
   `assets/data/i18n-runtime-strings.json` + `npm run i18n:new`.
4. CMS: `site.enablePromoCodes` (default true) in content.json +
   admin/config.yml with a hint saying codes are created in Stripe; EDITING-
   GUIDE walkthrough.
5. Tests: `scripts/worker-promo-preview.test.js` (mocked Stripe fetch, rate
   limit via RATE_LIMIT_COUNTER + makeNamespace): valid percent, valid amount,
   minimum not met, expired, unknown, malformed, rate limit, gift-card
   conflict, and that checkout sets the promotion code only when appropriate;
   cart unit tests; a `*.browser.test.js` driving the drawer (pattern:
   `scripts/gift-card-layout.browser.test.js`).

## Magic-link order history (§3 item 9)

`order-status.html` needs a session id AND email per lookup (keep it). Build a
passwordless "Your orders" page.

0. Establish storage first: read `workers/state/migrations.js` and the
   webhook. If D1 lacks a per-order record, add
   `orders(session_id, email_hash, created, amount_total, currency, status,
   line_items_json, tracking_url)` written from `checkout.session.completed`
   and updated by the ship-notice path; email stored hashed (mirror
   email_suppression).
1. `POST /api/orders/request-link { email }`: rate-limited 3/10min per client
   and per email hash; always the same neutral 200; sends a one-time signed
   link (24h, single use via `burned_tokens`, `MAGIC_LINK_SECRET`) through
   `sendEmail`; suppression respected.
2. `GET /api/orders?token=`: verify + burn; return orders (newest first,
   capped) and loyalty balance if the feature is on; `Cache-Control:
   no-store`.
3. `orders.html` (template: order-status.html; footer marker, nav, i18n
   markers, no-JS message, root-relative assets; noindex like order-status):
   email form, neutral confirmation, and with `?token=` the list: date, items
   with qty/unit price, total, status, tracking link, "Reorder" via
   `window.YLCart` (read cart.js for the add signature), loyalty balance.
   Link from order-status.html, thank-you.html and the footer help links.
   External `assets/js/orders.js` (no inline script; CSP hashes).
4. CMS: page wording (headline, lede, button labels) in content.json +
   admin/config.yml with hints; `site.enableOrderHistory` flag; EDITING-GUIDE.
5. Tests: `scripts/worker-orders.test.js` (request-link neutrality, rate
   limits, token mint/verify/burn, cross-email rejection, list shape,
   tracking merge, webhook persistence); `scripts/orders-page.browser.test.js`
   with a mocked /api; qa-check page invariants; a11y baseline for the page;
   docs that list pages/suites.
