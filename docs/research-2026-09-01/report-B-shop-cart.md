# Audit B — Shop, PDPs, Cart (Y'allternative Living)

Environment: working tree served at http://localhost:8090 with production headers/CSP; Puppeteer 25 headless (Chrome), desktop 1280x800 and iPhone 13 emulation; `/api/*` returns 503 locally (expected). Screenshots: `/private/tmp/claude-502/-Users-steven-Documents-GitHub-yallternative-living/46c3c05a-857d-458b-94e9-ee5b588530ed/scratchpad/agentB/` (referred to as `agentB/` below). Source of truth: `assets/data/products.json` (19 products, milestones $40 Free Tracked Shipping / $60 Free Handcrafted Pocket Salve, volume rule 2+ 2oz salves at $14.99).

Note on PDPs: every `products/*.html` carries an inline `window.location.replace("../shop.html#<slug>")` (products/sleep-salve.html:35) whose sha256 is whitelisted in `_headers`, so a normal visitor never sees a PDP. To audit the PDP surface I stripped that one script tag via request interception (service worker bypassed). Findings marked "(PDP)" describe what the page does if it is ever reached (JS off, redirect removed, or the ritual/sticky code reused elsewhere); the bounce itself is reported separately.

## BLOCKERS

### B1. PDP sticky bar applies the variant price delta twice — cart charges the wrong price
- Page/viewport: `products/frankincense-salve.html`, `products/shea-butter.html` (PDP, desktop and mobile).
- Repro: scroll past the main CTA on mobile (or just use the `#pdpStickyBar` select), pick **1oz (-$6.00)** in the sticky select, click the sticky **Add to Cart**. Sticky bar shows **$13.99** (correct). Cart line renders **$7.99**, subtotal **$7.99**. Same with shea butter 8 oz: sticky **$23.00**, cart line **$28.00**.
- Evidence: `agentB/pdp2-frank-mobile-sticky-1oz.png` (sticky shows $13.99), `agentB/pdp2-frank-mobile-drawer-over-sticky.png` (cart shows $7.99), `agentB/pdp-shea-butter-desktop-cart-after-ritual.png` (8 oz at $28.00). Stored cart item: `{price: 13.99, variantDelta: -6}` / `{price: 23, variantDelta: 5}`.
- Cause: `assets/js/main.js:8444` and `:8448` (`syncVariant` in `initPdpStickyBar`) write `data-item-price = base + delta` **and** `data-item-custom1-value`, while `assets/js/cart.js:2151-2170` (`addItemFromButton`) computes `price + deltaForLabel(options, label)` again. The shop-card path (`main.js` `variantSelectHTML` change handler) leaves `data-item-price` at the base price and is correct. This is the same bug class as the recent gift-card "price doubled" fix; the gift-card sticky is now a "Configure Card" link so it is no longer affected, but every other delta variant is. The Worker re-prices server-side, so the shopper would see one price in the cart and a different total on Stripe.

### B2. Custom gift-card amount is added to the cart at $10.00 (the charge will be the real amount)
- Page/viewport: `shop.html` gift-card modal (`#giftCardModal`), desktop and mobile.
- Repro: Configure Card → **Custom** → enter 37 → fill recipient/name → **Add $37 Gift Card to Cart**. Cart line: "Digital Gift Card · Variant: Preset $37 · **$10.00**", Subtotal $10.00, Estimated total $10.00. The POSTed checkout payload is `{"id":"yallternative-gift-card","qty":1,"variant":"Preset $37",...}` and `workers/checkout.js:673-680` parses "Preset $37" and charges **$37**. Preset chips ($25/$50/…) are correct ($50 line = $50.00).
- Evidence: `agentB/cart3-gift-custom-modal.png`, `agentB/cart3-gift-custom-cartline.png`; stored item `{price:10, variantLabel:"Preset $37", variantDelta:0}`.
- Cause: `assets/js/gift-card.js:262/296` sets `data-item-custom1-value="Preset $37"` but the button's `data-item-custom1-options` only lists the six presets (`Preset $10[+0.00]|Preset $25[+15.00]|…`), so `cart.js:65 deltaForLabel()` returns 0. The custom path needs to either update `data-item-price`/options or the cart needs to parse "Preset $NN" the way the Worker does.

### B3. Every product page bounces the visitor to the shop with an image lightbox and no product in view
- Page/viewport: any `products/*.html`, desktop and mobile (real visitor path, redirect intact).
- Repro: open `products/sleep-salve.html`. Result: URL becomes `shop.html#sleep-salve`, page is at scrollY 0, and 400 ms later the **image lightbox** (`#imageLightboxModal`) opens with the product photo (`main.js:5314-5330`). Press Esc: shopper is at the top of the shop page; the Sleep Salve card is 4,784 px further down (iPhone 13) and nothing is highlighted, filtered, or scrolled to. There is no PDP experience at all for a JS-enabled visitor (no variant picker, no ritual, no sticky bar — those only exist in the never-shown PDP HTML).
- Evidence: `agentB/pdp-bounce-desktop.png`, `agentB/pdp-bounce-mobile.png`, `agentB/shop-deeplink-sleep-salve.png`, `agentB/shop-deeplink-after-esc.png`; measured `afterEsc: {scrollY:0, cardTop:4784}`.
- Suspected: `products/*.html:35` inline redirect; `assets/js/main.js:5314-5330` (deep-link opens `openLightbox` instead of scrolling to / opening the product card). Any external link, search result, "Recently Viewed" link, or ritual item link (`lavender-soak.html`) lands here.

## MAJOR

### M1. Cart drawer thumbnails and upsell images are broken on PDPs (404)
- Page/viewport: any PDP (desktop + mobile) — add via sticky bar or ritual, or open the drawer.
- Repro: on `products/sleep-salve.html` click the ritual "Add All to Cart" or the sticky Add to Cart. Every `<img>` in the drawer (line thumbnails, "You might also like" upsells) requests `http://localhost:8090/products/assets/img/*.jpg` → **HTTP 404** (10 failed requests per open). `naturalWidth` = 0 for all.
- Evidence: `agentB/pdp2-sleep-desktop-drawer-thumbs.png`, `agentB/pdp2-frank-mobile-drawer-over-sticky.png` (broken-image icons); console errors "Failed to load resource: 404" x10.
- Cause: `data-item-image="assets/img/…"` (relative, root-page paths) on the sticky button (`products/sleep-salve.html:208`) and in the recently-viewed / ritual data; `assets/js/cart.js:1464` renders `src` verbatim, so on `/products/` it resolves one directory too deep.

### M2. "Complete the Ritual" claims "✓ Unlocks Free Tracked Shipping!" below the $40 threshold
- Page/viewport: `products/frankincense-salve.html` (ritual total $37.99), `products/bug-spray.html` ($28.00; $20.00 after unchecking one item), desktop + mobile.
- Repro: load the page; the green badge is visible next to the total even though shipping is free only at $40 (`shop.shippingMilestones[0]`). Uncheck items down to $20.00: badge still visible. The cart then shows "Shipping $10.00".
- Evidence: `agentB/pdp-frankincense-salve-desktop-ritual.png` ("$37.99 ✓ Unlocks Free Tracked Shipping!"); measured `ritualUncheck: {total:"$20.00", badgeVisible:true}`.
- Cause: the static HTML ships the badge un-hidden (`products/frankincense-salve.html` `#pdpRitualShippingBadge`) and `main.js:8312-8318` only toggles the `hidden` attribute, which the badge's own `display` rule in `assets/css/styles.css:7110` (`.pdp-ritual-shipping-badge`) overrides (`[hidden]` has no site-wide rule; only `#scentFieldWrap[hidden]` and `.thank-you-hero [hidden]` exist).

### M3. Ritual "Add All" adds a Coming-Soon product to the cart
- Page/viewport: `products/shea-butter.html` (PDP), desktop + mobile.
- Repro: the ritual lists **Y'all Means All Sugar Scrub** (`comingSoon: true`, placeholder image, shop card says "Coming Soon" and is not purchasable). "Add All to Cart · $51.99" adds "Y'all Means All Sugar Scrub $14.00" to the cart. Also adds a second variant-less "Lavender Shea Body Butter $18.00" line next to the "8 oz $28.00" line from B1.
- Evidence: `agentB/pdp-shea-butter-desktop-cart-after-ritual.png`; stored items include `sugar-scrub/p14`.
- Suspected: `products/shea-butter.html:166-173` (built ritual markup includes `sugar-scrub`) / `scripts/build-site-data.js` + `main.js:8243` `initPdpRitualSection` does not filter `comingSoon`/sold-out ids (`main.js:2027` does filter them elsewhere).

### M4. Dispatch promise contradicts itself between shop cards and the cart drawer
- Page/viewport: `shop.html` desktop + mobile, at the same moment (Wed 00:5x ET).
- Repro: card badge reads "Order within 12h 38m for **dispatch tomorrow**"; open the cart: "Order in next 12h 37m to **ship today** from Landrum, SC!". Minutes also differ by one (13:59 vs 14:00 math).
- Evidence: `agentB/shop-mobile-grid.png` (card), `agentB/cart-desktop-1item.png` (drawer).
- Cause: `assets/js/main.js:2877-2911` hard-codes "for dispatch tomorrow" regardless of cutoff; `assets/js/cart.js:462-482` says "ship today" before the 14:00 cutoff on business days.

### M5. Mix & Match nudge says "Add $X for FREE SHIPPING!" when shipping is already free
- Page/viewport: cart drawer, desktop + mobile.
- Repro: 2x Frankincense 2oz + Hand Scrub 4 oz + Frankincense 1oz (physical $57.97, shipping line "Free"): nudge reads "Mix & Match: $14.99/ea 2oz salve volume tier applied! · **Add $2.03 for FREE SHIPPING!**" while the milestone meter correctly says "Add $2.03 more to unlock a Free Handcrafted Pocket Salve!".
- Evidence: `agentB/cart-mobile-4lines.png`.
- Cause: `assets/js/cart.js:1724-1727` appends `milestoneStatus.remaining` with a fixed "FREE SHIPPING" label even when the next milestone is the pocket salve.

## MINOR

- **Restock/notify + gift-card balance + promo code error copy with API down.** With `/api/*` 503: restock modal shows a friendly "That didn't go through. Please email us instead: y.allternative.living@gmail.com" (good, `agentB/shop-desktop-notify-after.png`). Gift-card balance check (modal) and the drawer's "Have a gift card or voucher code?" Apply both print the **raw server JSON `error` string** ("API not available in local audit server") — `assets/js/cart.js:549-560` and `gift-card.js` surface `data.error` for any non-OK status, so a production 5xx body would be shown verbatim (`agentB/shop-desktop-giftbalance.png`, `agentB/cart-desktop-checkout-after.png`).
- **Milestone pin labels are hard to read**: "$40"/"$60" labels are light text on the light orange/pink gradient pins and sit half under the pin icon (`agentB/cart-mobile-pins-zoom.png`). `styles.css` `.yl-cart-milestone-pin`.
- **Mobile drawer item list is tiny**: `#yl-cart-items` is a 178 px scroll region on iPhone 13 (about 1.3 line items visible, second line cut mid-thumbnail) while the footer gets 522 px; shoppers must scroll two nested regions to see their items (`agentB/cart-mobile-4lines.png`, `agentB/cart-mobile-overlap-zoom.png`).
- **Shop card "Add to Cart" buttons are 39 px tall on mobile** (< 44 px touch target); the gift card "Configure Card" is 43.7 px. Sticky-bar buttons/select are 44 px. (`agentB/shop-mobile-grid.png`)
- **Shop cards: sold-out size only visible in the dropdown.** Tank Top S is `soldOut` in data; card shows no badge, only "S — sold out" inside the `<select>`; button/options correctly omit S. Fine functionally, low discoverability.
- **PDP is a stub (PDP):** single image (products.json has up to 3 `images`; no thumbnails/gallery), no quantity control, no share button, no reviews, no related products, and **no `<footer>`** (`grep -c "<footer" products/sleep-salve.html` = 0). Ritual item cards on mobile are ~470 px tall with the content floating in the middle (`agentB/pdp-sleep-salve-mobile-sticky.png`).
- **Sticky select copy on the gift card PDP** reads "Preset $25 (+$15.00)" etc. — the "+$15.00" delta is meaningless to a shopper buying a $25 card (`agentB/pdp-yallternative-gift-card-mobile-sticky.png`).
- **Recently Viewed never populates for real visitors**: it is recorded only on `body.pdp-page` (`main.js:8078-8095`), and the bounce path `shop.html#slug` records nothing (`rvAfterBounce: null`). With the redirect stripped it works (3 cards after 3 PDP visits).
- **Empty cart** copy is just "Your cart is empty." with no CTA back to the shop (`agentB/cart-desktop-empty.png`).
- **Local/dev noise:** tawk.to embed script blocked by CORS on localhost (console error on every page); not a production finding.

## VERIFIED OK

- **shop.html grid**: 19 cards = 19 products in products.json, every name and price matches (`$19.99`, `$8.00`, … gift card `$10.00`), every card image has `naturalWidth > 0` once scrolled into view (lazy-loaded), 5 Coming-Soon products show the "Coming Soon" badge, disabled "Coming Soon" button and a working "Notify Me" restock modal; no horizontal overflow; no page errors. (`agentB/shop-desktop-grid.png`, `shop-desktop-grid2.png`, `shop-mobile-grid.png`)
- **Filters**: category pills give correct counts vs data (Apparel 2, Salves 3, Body 7, Soaks 2, Potions 1, Ritual 3, Gift Cards 1; "Gift Sets" switches the grid to the 7 bundles, "Showing 7 of 7 gift sets"); concern pills correct (Sleep 7, Sore 5, Dry 8, Outdoor 1, Glow 5); combined category+concern correct; `aria-pressed` toggles; search "salve" → 4; sort featured/price-asc/price-desc/name-asc all order correctly; `shop.html#salves|#apparel|#gift-cards` deep links select the pill (gift-cards also opens the modal); breadcrumb "Salves & Balms" from a PDP lands filtered.
- **Shop-card variant picker**: changing Frankincense to 1oz updates the card price to $13.99, keeps `data-item-price` at base and sets `custom1-value` → cart line $13.99 (correct). Gift modal presets: $25 → `Preset $25`, $50 → $50.00 line; modal opens/closes; Check Balance tab works; image click opens the lightbox and Esc closes it; wishlist toggles `aria-pressed`.
- **Cart math (desktop + mobile, all vs products.json)**: Frank 2oz $19.99 → x2 = $14.99 ea / $29.98 with "2+ for $14.99 applied" and struck $39.98; Hand Scrub 4 oz $14.00; Frank 1oz $13.99 (no volume price, correct); Shea 8 oz $23.00; Tank Top $30; mix-and-match Frank 2oz + Sleep Salve = $14.99 each. Subtotals $19.99 / $29.98 / $43.98 / $57.97 / $80.97 all exact. Shipping line $10.00 below $40, "Free" at/above. Gift card lines excluded from the physical subtotal (meter/message unchanged when a $50 card is added). Max-quantity clamp: Tank Top stops at 10 and "+" is disabled.
- **Milestone meter**: "Add $20.01 for Free Tracked Shipping!" (33%), "Add $10.02 …" (50%), first pin flips `is-reached` at $43.98 with "Add $16.02 more to unlock a Free Handcrafted Pocket Salve!" (73%), "Add $2.03 more …" (97%), "🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!" (100%, both pins reached) at $80.97; drops back correctly when lines are removed; rounding to cents correct throughout. Local pickup checkbox → "Local SC Market Pick-up Selected ($0 Shipping)", market select shows the upcoming event, shipping "Free".
- **Checkout with /api/checkout 503**: button goes "Redirecting…" + disabled while in flight (also after a quantity change mid-flight), then shows a `role="alert"` message "Sorry -- checkout isn't available right now. Please try again in a moment.", re-enables the button, stays on the page; double-click sends exactly **one** POST; a 400 with `{error}` shows the server's shopper text ("That gift card has already been used."). No spinner-forever state.
- **Persistence**: cart survives reload and appears on other pages (index.html, mobile) with badge count; removing all lines returns "Your cart is empty."; qty −/+ and per-line remove work; drawer has no horizontal overflow; on mobile the drawer (popover, top layer) covers the sticky bar and the Checkout button is reachable by scrolling `#yl-cart-foot`.
- **Mobile sticky bar (PDP, when reached)**: hidden at load (`translateY(100%)`, opacity 0, `aria-hidden=true`), `is-visible` once `.pdp-actions` scrolls above the viewport, hides again when the CTA is back in view, button 44x121 px, select 44 px, `padding-bottom: max(10px, env(safe-area-inset-bottom))` (`styles.css:7218`), z-index 90, does not cover the last page content (main has 64 px bottom padding). Sticky → main price sync works (gift card $500.00, shea $23.00, frank $13.99); no main-page select exists so the reverse direction is N/A.
- **Ritual section (PDP)**: item prices match products.json ($19.99/$10.00/$18.00 etc.), total and button text update when items are unchecked ("Add Selected (2) to Cart · $37.99"), current item is locked; "Add All" adds every checked item at the correct base price (aside from M3).
- **Internal links**: all `<a href>` on the audited PDPs (breadcrumbs, ritual item links, nav) resolve 200.
