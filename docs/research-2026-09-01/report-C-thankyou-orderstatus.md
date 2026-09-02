# Report C -- thank-you.html / order-status modal & page / 404 / welcome

Audited against the UNCOMMITTED working tree on 2026-09-01 (files re-read after they changed mid-session at 22:12-22:15: thank-you.js now POSTs `{sessionId}` to /api/order-summary and splits gift-card vs promo; that is the version tested). Server: http://localhost:8090 with production headers; `/api/*` mocked via Puppeteer request interception (response shapes taken from workers/routes/order-summary.js and order-status.js). Headless Chrome, `navigator.webdriver` overridden, all non-localhost requests blocked; **no POST ever left localhost** in any scenario. Viewports: desktop 1280x800, tablet 768x1024, mobile iPhone 13 (390x844 @3x).

Evidence dir: `/private/tmp/claude-502/-Users-steven-Documents-GitHub-yallternative-living/46c3c05a-857d-458b-94e9-ee5b588530ed/scratchpad/agentC/` (harness `audit.js`, `verify*.js`, raw data `results.json`). Paths below are relative to that dir.

Session id used: `cs_live_b1Ktx02riaWFCfaDR64ryHSJkBBumuqVNhxcAgqNdRT1hzrb5kNpsozDld` ("SID").

---

## BLOCKERS

### B1. "Track Order Status" (the new primary CTA) opens straight into a red validation error, and that error can never be hidden again -- it stays on screen beside the successful result
- **Scenario h**, all viewports (screens: `h-found-modal-after-open.png`, `h-found-modal-after-submit.png`, `h-notfound-modal-after-submit.png`, `h-mobile-modal-open.png`, `h-mobile-modal-found.png`).
- **Repro:** load `thank-you.html?session_id=SID&amount=62.00&currency=usd`, click "Track Order Status". Observed 100 ms later: modal open, reference prefilled, email empty, `#orderLookupError` visible with "Enter the email you used at checkout.", focus moved to the email field. Then type an email and submit with `/api/order-status` mocked 200 found: result "Paid, being packed / What's in it / ... / Order total: $55.80 / Shipping to Landrum, SC" renders **with the red "Enter the email you used at checkout." still visible above the button** (also with the 404 branch).
- **Why:** (1) `assets/js/thank-you.js:199-217` calls `orderForm.requestSubmit()` on every open even though the email (a required half of the credential -- see `main.js:3357-3376 validateOrderLookup`) is always empty, so the auto-submit can never succeed; it only ever produces the error. (2) `thank-you.html:270` -- `<span id="orderLookupError" ... hidden style="...; display: block;">`: the inline `display:block` beats the UA `[hidden]{display:none}` rule, so `errorEl.hidden = true` in `main.js:3611` is a no-op. Measured after the successful lookup: `hidden:true, computed display:"block", rendered height 22.4px`, text still "Enter the email you used at checkout.". Since `role="alert" aria-live="assertive"` is on that span, screen-reader users are also barked at the moment they press the primary button.
- **Impact:** every shopper who uses the primary action sees the page shout at them before they typed anything, and the error never clears. Fix both: do not auto-submit without an email (prefill + focus the email field instead), and drop the inline `display:block` (or toggle a class).

---

## MAJOR

### M1. Empty "ORDER REFERENCE" row with a dead "Copy" button, plus "Payment Received / Verified Stripe Payment / Payment confirmed" on URLs that carry no order
- **Scenario d** (no query string) and **e** (`?session_id=hello&amount=5`), desktop (`d-noparams-card.png`, `d-desktop-noparams.png`, `e-invalid-card.png`, `e-desktop-invalid.png`).
- **Observed d:** `#thankYouSessionRow` has the `hidden` attribute (JS never unhides it) yet renders: computed `display:flex`, height 50px, "ORDER REFERENCE" label with an empty `<code>` and a visible Copy button. Clicking Copy does nothing (no handler bound when the session is invalid). The card still shows the "Payment Received" badge, the "Verified Stripe Payment" pill, today's date and the "Order Placed -- Payment confirmed" step for a page with no order.
- **Observed e:** same empty reference row **and** "ORDER TOTAL $5.00" beside "Verified Stripe Payment" -- an invented, unverified total printed from a hand-typed URL. Analytics/cart-clear correctly did not fire.
- **Why:** `assets/css/styles.css:5051-5052` `.thank-you-session-row { display: flex; ... }` overrides `[hidden]` (same class of bug as B1). The amount is shown whenever `hasAmount` regardless of `isValidSession` (`thank-you.js:92-94`). The badge/pill/timeline are static markup (`thank-you.html:126-135, 156-181`).
- **Fix:** `.thank-you-session-row[hidden]{display:none}` (or a global `[hidden]{display:none!important}`); gate the URL amount on `isValidSession`; consider hiding the whole card when there is no valid session.

### M2. Mobile: the discount note box is jammed against the "Verified Stripe Payment" pill (0 px gap) and the pill wraps to 2-3 lines
- **Scenario a / c3**, mobile 390px (`a-mobile-card.png`, `a-mobile-amount-row.png`, `c3-giftcard-mobile-amount-row.png`, `c3-mixed-mobile-amount-row.png`).
- **Measured:** promo note right edge 193.4 = pill left edge 193.4 (gap **0 px**); gift-card note right 185.3 = pill left 185.3 (gap 0). Note wraps to two lines ("Promo code applied: / -$6.20"), pill wraps to "Verified Stripe / Payment"; in the mixed case the pill becomes three lines ("Verified / Stripe / Payment") because the amount group grows. Two bordered boxes touching each other reads as a layout bug on the most common viewport. Desktop/tablet are fine (148 px gap).
- **Why:** `.thank-you-amount-row` (`styles.css:~5005-5010`) is `display:flex; justify-content:space-between; align-items:flex-end` with no `gap`, `flex-wrap` or `min-width:0`, and `.receipt-discount-note` is `inline-block` inside the flex item so it can't shrink below its own text. Add `gap: 12px; flex-wrap: wrap` (and let the pill drop below on <600px), or stack the notes under the total full-width.

### M3. "Not found" tells the shopper the order system is unreachable
- **Scenario h (not found) and order-status.html (404)** (`h-notfound-modal-after-submit.png`, `os-desktop-notfound.png`).
- **Observed text, in this order:** "We couldn't find an order with that reference and email." then "We look this one up by hand -- We couldn't reach the order system just now -- every batch is made and boxed by one person..." The system was reached and answered; the most likely cause is a typo in the email, but the copy tells them the lookup is down and to email support -- so nobody retries.
- **Why:** `assets/js/main.js:3646-3658` renders `orderStatusFallbackHTML()` (`main.js:3696-3712`, whose first sentence asserts unreachability) under the not-found line. Needs a not-found-specific paragraph ("Check the email you used at checkout -- the reference alone isn't enough. Still stuck? Email us...").

### M4. Copy button: no screen-reader feedback, and silent no-op when the clipboard API is unavailable; on mobile only 22 of 66 characters of the reference are visible
- **Scenario g** (`g-desktop-copied-row.png`, `g-desktop-focus-row.png`, `g-mobile-session-row.png`).
- **Observed:** clipboard write works (readText === SID), label flips "Copy" -> "Copied!" and back after 2 s, Enter key works, focus ring is a visible 2 px whiskey outline. But: `aria-label` stays "Copy order reference ID", no `aria-live` region anywhere in the card, no `aria-pressed` -- the "Copied!" change is invisible to AT. With `navigator.clipboard` undefined (http origin, some in-app browsers) or a rejected write (permission denied), the click does nothing: no label change, no fallback (`execCommand('copy')` / selecting the text), no message (`thank-you.js:181-195`, both branches swallow). On mobile `.session-code` is capped at `max-width:180px` (`styles.css:5237-5239`) so the shopper sees `cs_live_b1Ktx02riaWFCf...` -- 8 of those 22 visible chars are the constant `cs_live_` prefix -- and cannot read the rest without copying. (It is recoverable via the modal input and the Stripe email, which is why this is MAJOR not BLOCKER.)

### M5. Printing the page produces no receipt at all
- **Scenario k**, desktop, `emulateMediaType('print')` + `page.pdf` (`k-print-emulated.png`, `k-print-page1.png`, `k-print-bg-page1.png`, `k-print.pdf` = 2 pages).
- **Observed:** the printout is: eyebrow "ORDER CONFIRMED - RECEIPT ISSUED", "Thanks, Y'all!", the lede, "<- Back To Home", then page 2 is the "Join The Birthday Club" box. No order total, no reference, no date, no timeline, no support email. With backgrounds on, page 1 is a solid dark hero block.
- **Why:** the site-wide print block at `assets/css/styles.css:3815-3832` lists `.thank-you-card, .thank-you-actions, .thank-you-support-callout, .thank-you-badge-wrap` under `display:none !important`; nothing hides `#birthday-club-reward`; `.thank-you-hero` keeps its dark gradient. Since the page literally says "Receipt Issued", the card is the one thing that should print.

---

## MINOR

### m1. Layout shift after first paint when the settled total arrives
- **Scenario a/c** (`c-desktop-before-fetch.png` vs `c-desktop-after-fetch.png`). The amount changes $62.00 -> $55.80 and the injected note (28 px + 6 px margin desktop, 48 px mobile) pushes the reference row and timeline down after load; no space is reserved. `thank-you.js:133-170`.

### m2. When the summary call fails (503/429/500/404-on-a-real-order), a promo shopper sees the pre-discount URL amount under a "Verified Stripe Payment" pill
- **Scenario b / c3** (`b-desktop-503.png`, `c3-rate_limited-desktop.png`). Graceful (no visible error, only the browser's own "Failed to load resource" line), but the $62.00 shown is exactly the figure the redesign set out to correct; the static pill implies it is verified. Consider a "Total per your Stripe receipt" wording until the settled figure arrives. `thank-you.js:122-124` treats every non-2xx the same.

### m3. Mobile modal: the close "x" overlaps the title
- **Scenario h**, mobile (`h-mobile-modal-open.png`). Measured overlap of `#closeOrderStatusModalBtn` with `#orderStatusModalTitle`: 24.6 x 25.2 px ("Look Up Order Statu[x]"). `dialog.gift-modal` / `.gift-modal-close` at `styles.css:3870-3930` with a 32 px h2 and no right padding on the header.

### m4. order-status.html: malformed SVG path in the theme toggle -> console error on every load
- `order-status.html` icon-moon path is `M12 3a6 6 0 0 0 9 9 9 0 1 1-9-9Z` (a "9" is missing; thank-you.html has the correct `...0 0 9 9 9 9 0 1 1-9-9Z`). Chrome logs `Error: <path> attribute d: Expected arc flag ('0' or '1')` on order-status.html (observed in every order-status run; absent on thank-you/404/welcome).

### m5. thank-you.html logs a CSP violation for the injected speculation rules
- Observed on every scenario-a load (desktop/tablet/mobile): "Applying inline speculation rules violates the following Content Security Policy directive 'script-src ...'". Source: `assets/js/main.js:5829` appends `<script type="speculationrules">`; the header does carry `'inline-speculation-rules'` but Chrome still reports the block with the served headers. Pre-existing, site-wide, out of this diff -- but it is a red console error on the confirmation page.

### m6. order-status.html page form and the modal form validate differently
- Page form has no `novalidate`, so empty fields show native browser bubbles ("Please fill out this field.", `os-desktop-empty-submit.png`, `os-mobile-error.png`), while the modal (`novalidate`) shows the custom copy. Garbage reference + email correctly shows "That doesn't look like an order reference. It starts with cs_ ...". Cosmetic inconsistency only.

### m7. /api/order-summary is re-requested on every reload of the same session
- **Scenario f:** 2 loads -> 2 POSTs; dedupe (`yl-thankyou-session`) only covers analytics/cart. Rate limit is 10/min/IP, so ~10 refreshes yield a 429 and the discount note silently disappears (falls back to m2). Low likelihood.

### m8. Local server serves 404.html with HTTP 200
- `curl -sI /404.html` -> 200 (Netlify will serve it as a 404 for unknown paths; this is a local-harness note, not a page defect).

---

## VERIFIED OK

**thank-you.html**
- a) Mocked found summary (`status:"complete", paymentStatus:"paid", amountTotalCents:5580, amountDiscountCents:620`): amount updates $62.00 -> $55.80; note "Promo code applied: -$6.20"; request is `POST /api/order-summary {"sessionId": SID}` (matches the rewritten route, and the service worker ignores non-GET so it is not cached). Desktop/tablet layout of the note is fine (`a-desktop-card.png`, `a-tablet-card.png`). Gift-card labelling now answers the brief's concern: `giftCardAppliedCents:620` -> "Gift card applied: -$6.20" (`c3-giftcard-desktop.png`); mixed 1000/620 -> both "Gift card applied: -$6.20" and "Promo code applied: -$3.80" (`c3-mixed-desktop.png`); 100 % gift card (`no_payment_required`, total 0) -> "$0.00" + "Gift card applied: -$62.00" (`c3-free-desktop.png`); `giftCardAppliedCents > amountDiscountCents` is clamped; `status:"open"/unpaid` summary is ignored; `amountTotalCents:null` keeps the URL amount. No console noise from any of these.
- b) Unmocked 503: falls back to $62.00, no note, no visible error, console only the browser's own 503 resource line (`b-desktop-503.png`).
- c) session_id only + found: amount group hidden on first paint, then appears with $55.80 + note (`c-desktop-before-fetch.png` / `c-desktop-after-fetch.png`). c2) session_id only + 404: amount group stays hidden, reference row shown, page otherwise sensible (`c2-desktop-404.png`).
- e) `?session_id=hello&amount=5`: no Purchase event, no cart clear, no summary request, reference row not populated (but see M1).
- f) Reload: Purchase not re-fired, cart not re-cleared, amount + note still shown (`f-desktop-after-reload.png`).
- g) Copy writes the full 66-char id; "Copied!" for 2 s then "Copy"; keyboard Enter works; visible focus ring (see M4 for the gaps).
- h) Modal: `dialog.open` true, reference prefilled; Tab cycles order-id-input -> email -> Look Up Order -> close -> order-id-input (never leaves the dialog); Shift+Tab stays inside; Escape closes and focus returns to `#openOrderStatusBtn`; found result renders status/items/total/city-state; `POST /api/order-status {"sessionId","email"}`; not-found mailto subject carries the reference. Mobile modal fits without horizontal scroll (`h-mobile-modal-found.png`).
- i) "Keep Shopping" -> /shop.html (200), "<- Back To Home" -> /index.html (200), arrow is U+2190 and renders; hover: home link -> whiskey + underline, copy button -> whiskey border/text; support callout text and `mailto:y.allternative.living@gmail.com` correct; date "Sep 1, 2026" equals `toLocaleDateString` today. Timeline desktop: connector lines (y 766.4-768.4) are centred on the 30 px markers (cy 767.4), `a-desktop-timeline.png`. Mobile: `.thank-you-timeline::before` centre x = 56.0 = all three marker centres x = 56.0; runs from y 740.9 to 867.9 (first marker top 743.3, last marker centre 871.6) -- ends inside the opaque markers, nothing pokes above/below, not visible through the translucent current marker (`i-mobile-timeline-col-4x.png`, `a-mobile-timeline.png`). Badge check icon centred (dx 0, dy 0) at all viewports.
- j) Cart (real catalog item "tank-top" via the shop.html add button): fresh session -> cart 0, Purchase fired once; re-add then land again with the same session -> cart keeps 1, no second Purchase; session-only URL (no amount) -> cart untouched. (My first attempt with synthetic ids was pruned by cart.js `load()` "Removed N unavailable item(s)" -- harness artefact, not a page bug.)
- l) axe-core (wcag2a/2aa/21aa/22aa/best-practice): **0 violations** on thank-you.html (scenario a) with the modal closed and open, and **0 violations** on order-status.html.
- No horizontal overflow at any viewport; no `pageerror` in any scenario.

**order-status.html**
- Validation: garbage reference -> "That doesn't look like an order reference. It starts with cs_ and is on your confirmation page and receipt email." with focus on the reference; bad email -> native email bubble; `?session_id=` prefills the reference only, never the email. Loading state: button "Looking up..." and disabled during the request (`os-desktop-loading.png`). Found renders (`os-desktop-found.png`); not found (see M3); 429 -> "Too many lookups; try again in a minute." (`os-desktop-ratelimited.png`); 503 -> "We look this one up by hand" hand-off with mailto (`os-desktop-unavailable.png`). Mobile: no horizontal scroll (390/390), form and result readable (`os-mobile-initial.png`, `os-mobile-found.png`).

**404.html / welcome.html**
- Both render, titles "Page Not Found | ..." / "Welcome To The List | ...", all 21 / 26 internal links answer 200 (externals skipped), no console errors, no pageerrors, mobile 390/390 no overflow (`404-desktop.png`, `404-mobile.png`, `welcome-desktop.png`, `welcome-mobile.png`).
