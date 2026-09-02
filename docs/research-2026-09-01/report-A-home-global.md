# Audit A -- Home page (index.html) + global chrome

Server: http://localhost:8090 (working tree, production headers/CSP). Puppeteer headless Chrome, `navigator.webdriver` spoofed to false, all non-localhost POSTs blocked (3 Tawk `va.tawk.to/v1/session/start` POSTs were intercepted; nothing real was submitted). Viewports: desktop 1280x800, iPhone 13 (390x844 @3x), plus 320/360/375/768/1024/1100/1200 header sweeps.
Evidence dir: `/private/tmp/claude-502/-Users-steven-Documents-GitHub-yallternative-living/46c3c05a-857d-458b-94e9-ee5b588530ed/scratchpad/agentA/` (scripts `audit.js`, `followup.js`, `mini.js`, `wish.js`; raw data `results.json`, `followup.json`). Screenshot paths below are relative to that dir.

Console/pageerror summary: zero JS `pageerror`s on any load (home desktop, home mobile, 4 date-mocked loads, events.html x2). Only console errors are Tawk (see MINOR m8). No 4xx/5xx from localhost on the home page; `/api/*` is never called by the home page, so the local 503 never surfaces here.

---

## BLOCKERS (customer-facing broken)

### B1. Mobile header: brand name is overlapped by the wishlist (heart) button at 375-390px (every page)
- Page/viewport: index.html (global header, so every page) -- iPhone 13 (390px) and 375px.
- Repro: load any page at an iPhone width. The header now holds six controls (wishlist, search, cart, EN, theme, hamburger). `.brand-word` "Y'allternative" (rect right = 149.8px) is drawn under `#wishToggle` (rect left = 113.6px): ~36px overlap, the heart icon sits on the letters "at".
- Evidence: `mob-header-3x.png`, `mob-home-top.png`, `happening-now-mob-ticker.png` (same in light theme: `mob-home-theme-toggled.png`). At 360px/320px the word is hidden by the `max-width:360px` rule so no overlap (`mob-header-360.png`); 768/1024 fine (`header-1024.png`). The most common phone widths (375/390) are the ones that break.
- Suspected: `assets/css/styles.css` ~586-658 -- `.brand { flex-shrink:1; min-width:0 }` + `.brand-word { white-space:nowrap }` with the hide rule only at `@media (max-width:360px)`; `.nav-cta > * { flex-shrink:0 }` (~761) means the six buttons (262px) win and the nowrap word overflows into them. The wishlist button is injected by `assets/js/main.js:1623-1626`. Raise the hide breakpoint (<=430px) or drop one control.

### B2. Home page "Configure Card" (Digital Gift Card, $10) does nothing
- Page/viewport: index.html, desktop and mobile (same code path).
- Repro: scroll to "Small Batch, Big Feels", 7th card "Digital Gift Card" -> click Configure Card. URL becomes `index.html#gift-cards`; no dialog/popover opens (`dialogsOpen: []`, `popover: []`); no `#gift-cards` element exists so nothing scrolls into view. Clicking the card body is equally dead.
- Evidence: `desk-configure-card-click.png`, `mini.js` output `configureCard`.
- Suspected: `assets/js/main.js:429-480` -- the handler is inside `if (giftModal)` where `giftModal = document.getElementById("giftCardModal")`; that dialog only exists on shop.html, so on index.html the `a[href="#gift-cards"]` click handler is never registered. The home card is rendered by `main.js:1127-1129` with the same href. Render it as `shop.html#gift-cards` on non-shop pages (shop.html auto-opens the modal on that hash, line 476) or ship the dialog on the home page.

---

## MAJOR

### M1. Mobile/tablet menu: keyboard focus never enters the open drawer (regression from the new `visibility` transition)
- Page/viewport: every page, any viewport <=1024px (iPhone 13 and 1024x768 both reproduced).
- Repro: focus the hamburger, press Enter/click. `main.js:126-127` calls `firstLink.focus()` but focus stays on the toggle (sync and 350ms later). Press Tab: focus goes "Shop Salves, Soaks & More" -> "Read Our Story" -> product-gallery buttons -- all page content behind the opaque drawer -- never Home/Shop/Events/Our Story/Contact. Shift+Tab from the toggle goes to the theme switch. A keyboard user (iPad + keyboard, laptop window <=1024px) cannot reach the nav links while the menu is open; repeated Tab scrolls the hidden page underneath.
- Root cause (verified A/B): shipped `transitionProperty` = `transform, opacity, visibility`; at the instant `.open` is added, `getComputedStyle(firstLink).visibility` is still `hidden` (a visibility transition is a discrete step resolving to the start value at p=0), so `focus()` is refused. Injecting `.nav-links{transition: transform .25s ease, opacity .2s ease}` (no `visibility`) makes `focus()` land on "Home" and Tab walk Shop -> Events -> Our Story. Same with `transition:none`.
- Evidence: `followup.json` -> `focus-mobile-asis` vs `focus-mobile-no-visibility-transition`, `focus-desk1024-asis` vs `focus-desk1024-no-transition`; `mob-nav-open-after-tabs.png`, `desk1024-nav-open.png`.
- Suspected: `assets/css/styles.css:742-753`. Fix: make the open direction instant (`transition: ..., visibility 0s` inside `&.open`, keep the 0.2s delay only when closing) or defer the focus in `main.js:126` with `requestAnimationFrame`/`transitionend`.
- The closed-state half of the change works: with the menu closed, `inert` is set, Tab from the hamburger skips to page content, links compute `visibility:hidden`, `pointer-events:none`.

### M2. "Spotted In The Wild" social-proof section is placeholder UGC presented as real customer posts
- Page/viewport: index.html, both viewports (`#homeSocialFeed`, shown because `enableSocialFeed` is true).
- What a shopper sees: "Real folks, real photos" over three posts. All three images are the shop's own product photos (`shea-butter.jpg`, `backroad-soak.jpg`, `beard-salve.jpg`); posts 2 and 3 are credited to "Landrum Local @backroad_soaker" and "Bold Hearts @night_ritual_co"; post 2 says "Landrum farmers market starts at 9am tomorrow, see y'all there!" (last Landrum Farmers Market in events.json is Aug 2025 -- stale/false); post 3 is tagged "Arnica Sleep Salve" but the photo is the Bourbon & Grit Beard Salve tin. Every "View Post" goes to the brand's Instagram profile root, not a post.
- Evidence: `desk-socialfeed-zoom.png`, `mob-socialfeed.png`; `followup.json.anchors.social`.
- Suspected: `assets/data/social-feed.json` -> `assets/js/social-feed-data.js` (posts `ugc-2`, `ugc-3`); rendered by `assets/js/main.js` ~5330+. Replace with real posts or set `site.enableSocialFeed=false`.

---

## MINOR

### m1. Countdown ticker grammar/format
- "1 DAYS, 0 HOURS" when one day out (`one-day-out-desk-ticker.png`; mock 2026-10-16T12:00Z). The events banner singularises ("1 Day"), the hero ticker does not. HTML ships `00` placeholders but JS writes unpadded `0`/`8` (`main.js:5966-5969` vs `index.html:129-132`): "45 DAYS, 8 HOURS, 0 MINS, 48 SECS".
- After the last event passes (mock 2026-10-18): badge reverts to the bolt SVG + "NEXT POP-UP:" followed by "STAY TUNED FOR NEW CONFIRMED MARKET DATES! | HANDCRAFTED IN LANDRUM, SC" -- reads oddly (`after-event-desk-ticker.png`; `main.js:5883-5888` rewrites only the timer, not the badge).

### m2. Global search input shows three "x" buttons
- Desktop and mobile: native `<input type="search">` cancel glyph + custom `#globalSearchClearBtn` + close button side by side once you type. `desk-search-salve.png`, `mob-search-salve.png`. `styles.css:6185` `.global-search-input` never hides `::-webkit-search-cancel-button` (only the shop search at :2539 touches it, with `cursor:pointer`).

### m3. Wishlist drawer "View Cart & Checkout" button renders as a squashed oval
- Desktop (`desk-wishlist-open.png`). The button injected at main.js:1655 carries class `cart-toggle`, so `styles.css:2904` applies `border-radius:50%; width/height:42px; padding:0 !important` to a 361px-wide block button. Still opens the cart; looks broken.

### m4. Orphan grid cells
- Featured grid: 7 cards in a 3-column grid, gift card alone on row 3 (`desk-home-full.png`). Testimonials: 4 quote cards in `grid-3`, one orphan (`desk-testimonials-zoom.png`). `index.html:314-335`, featured picker in main.js.

### m5. Hero LCP image is `loading="lazy"` while also `fetchpriority="high"` + preload
- `index.html:195`. Contradictory; the preload masks it. Image loads fine (naturalWidth 1280).

### m6. Mobile drawer geometry is relative to the header, not the viewport
- `.site-header` has `backdrop-filter` (styles.css:553) so it is the containing block for the `position:fixed` `.nav-links`; with the 61px announcement bar showing, the drawer spans y=118..904 on an 844px screen (mobile `open-settled` state), bottom 60px off-screen. Harmless with 5 links (`mob-nav-open.png`), would clip a longer menu. `styles.css:728-734`.

### m7. Footer "Shop" column deep links have no anchors on shop.html
- `/shop.html#apparel|#salves|#body|#soaks|#potions|#ritual|#gift-cards` -- none of those ids exist after JS renders (`followup.json.anchors.anchors` all null). The hash is honoured as a category filter (landing on `#soaks` activates the "Soaks" pill, "Showing 2 of 19 soaks" -- `shop-footer-soaks-landing.png`) but the page stays at scrollY 0 so the shopper sees hero copy, not products, until scrolling ~600px. `#gift-cards` opens the gift dialog on shop.html (main.js:476). Under-delivers rather than broken.

### m8. Tawk.to live chat -- what actually happens
- IDs are real (`index.html:531-532`), so the embed is requested on every page (the HTML comment calling it an inert placeholder is stale). Desktop headless UA: `embed.tawk.to/...` fails CORS ("No 'Access-Control-Allow-Origin'", 3x per load = 6 console errors). iPhone UA: full widget bundle loads (twk-main/vendor/app.js, widget-settings) and POSTs `va.tawk.to/v1/session/start` (blocked by my harness). CSP permits all of it. Nothing else breaks when it fails; no visible bubble within 1.5s in either case (`tawkWidget:false`). Manually confirm in a real browser that the bubble renders and does not cover the mobile hamburger/cart.

---

## VERIFIED OK

Head / SEO
- `document.title` "Y'allternative Living | Handmade Self-Care"; meta description present; canonical `https://yallternativeliving.com/`; `<html lang="en">`; both JSON-LD blocks parse (LocalBusiness, BreadcrumbList); footer year = 2026 (main.js:295).
- No lorem/placeholder/"coming soon"/TODO/YOUR_/undefined/NaN/2020-2025 strings in visible body text (regex sweep, both viewports).

Header (desktop 1280)
- Logo link -> index.html; nav Home/Shop/Events/Our Story/Contact; active state on "Home" (`.active` + `aria-current="page"`, brighter colour) -- `desk-hero-zoom.png`.
- All 21 internal hrefs on the page return HTTP 200 on localhost. External: Instagram, TikTok, Facebook, Etsy (x2), mailto -- `target=_blank rel=noopener` with sr-only "(opens in new tab)".
- Theme toggle: dark -> light flips `data-theme`, `aria-checked` true, `localStorage.yl-theme=light`; persists across reload (`desk-home-light-top.png`, `desk-home-light-full.png`). Mobile same.
- Cart button opens `#yl-cart-drawer` popover (`:popover-open` true, 420px panel, focus on its close button, "Your cart is empty", dispatch-cutoff banner); Escape closes -- `desk-cart-open.png`, `mob-cart-open.png` (full-screen on mobile).
- Search button opens `<dialog id=global-search-modal>` with focus in the input, `aria-expanded` synced; "salve" renders 12 `role=option` rows (live region "Found 6 products, 0 articles, 4 events, and 2 FAQs for salve"), chips hide, ArrowDown sets `aria-activedescendant=search-opt-0`; Escape closes and returns focus to `#globalSearchTrigger`; the close button does the same. Shortcut is Cmd+K (Ctrl+K on non-Mac), toggles open/closed, plus bare `/` outside editable fields/open dialogs (`main.js:7449-7477`) -- both verified. Query persists across close/reopen -- `desk-search-salve.png`, `desk-search-reopened-slash.png`.
- Language dropdown: opens (6 languages), Escape closes, outside click closes, closed state `display:none` so Tab skips it -- `desk-lang-open.png`. Does not use the new visibility rule.
- Wishlist drawer opens / "Nothing saved yet" (`desk-wishlist-open.png`).
- Tab order: skip link (visible on focus, `desk-skiplink-focus.png`) -> brand -> 5 nav links -> wishlist -> search -> cart -> language -> theme -> hero CTA.
- Header sweep 768/1024/1100/1200: hamburger <=1024, inline links >=1100, no overlaps at those widths (`header-*.png`).

Mobile menu (iPhone 13)
- Closed: `visibility:hidden`, `opacity:0`, `pointer-events:none`, `inert`; Tab from hamburger skips to page content.
- Open animates cleanly: 40ms opacity 0.22 / visibility already visible; settled at 400ms -- `mob-nav-opening-40ms.png`, `mob-nav-open.png`. Icon swaps to X, `aria-expanded=true`.
- Close by button: 60ms still visible & fading (opacity 0.59), fully hidden at 400ms, nothing stuck -- `mob-nav-closing-60ms.png`, `mob-nav-closed-after-btn.png`. Close by Escape (focus returns to hamburger) and by clicking the header outside the drawer both verified; clicking empty space inside the drawer keeps it open; clicking "Shop" closes it and navigates.

Countdown ticker / banner
- Home badge = `<span class="ticker-emoji">✨</span>NEXT POP-UP:` -- exactly one icon, the static bolt SVG is replaced not duplicated; emoji renders as a real glyph (16x16) with 4px margin -- `desk-ticker-zoom.png`. Timer counts down (48 -> 46 secs over 2.1s) and names "Autumn Apothecary Faire (Landrum, SC)". Mobile: free-shipping segment hidden <=1100px by design; bar wraps to 3 lines (61px) without overflow.
- HAPPENING NOW (Date mocked to 2026-10-17T14:00Z, desktop + mobile): badge `✨HAPPENING NOW:`, timer "AUTUMN APOTHECARY FAIRE IS IN PROGRESS TODAY!", one icon, zero pageerrors -- `happening-now-desk-ticker.png`, `happening-now-mob-ticker.png`.
- events.html `#eventsCountdownBanner`: "✨ NEXT LIVE APPEARANCE / Autumn Apothecary Faire / 45 Days, 7 Hours... until pop-up / Landrum, SC" and, mocked, "✨ HAPPENING NOW / Pop-up in progress today!" -- both styled cards, no errors -- `events-banner-normal.png`, `events-banner-happening.png`.

Body sections
- Hero: heading, lede, both CTAs, rating line, founder photo (AVIF, naturalWidth 1280 desktop / 390 mobile), no clipping.
- Value strip (4), featured grid (7 products with prices, selects, dispatch pill, Add to Cart), story teaser, 4 testimonials, "We Pop Up In The Wild" band -- all render; no text overflow (scrollWidth sweep found only `.sr-only`); no horizontal page scroll at 390 or 1280.
- Images: after scrolling the whole page every visible `<img>` is complete with naturalWidth > 0 on both viewports; the only naturalWidth-0 img is the hidden lightbox `<img src="">`.
- Scroll-reveal: 28 `.reveal`/stagger elements all at opacity 1 after scrolling to the bottom on both viewports.
- Sticky/fixed: announcement bar + header sticky; dialog and cart drawer fixed. Nothing else floats.
- Newsletter (not submitted): `required` + `type=email` rejects "notanemail", accepts a valid address; birthday `pattern` rejects "13/40", accepts "06/14"; confirmation is `display:none` until success; honeypot `.form-hp` is at left:-999px 1x1 `tabindex=-1`. Submit POSTs to `https://app.kit.com/forms/9867317/subscriptions` via fetch (main.js:300-380) with an honest failure fallback; CSP `form-action`/`connect-src` allow app.kit.com.
- Footer: brand, Explore, Shop, Say Hey (mailto, Etsy), 4 social icons with aria-labels, disclaimer, (c) 2026 + Shipping/Terms/Privacy -- `desk-footer-zoom.png`, `mob-footer-full.png`.
- No cookie/consent banner (Umami cookieless; the `<!--YL:site.umamiWebsiteId-->` placeholder is empty so no analytics script loads locally).
