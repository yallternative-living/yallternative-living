# Project: Y'allternative Living — Full Feature Implementation & Quality Overhaul

## Architecture
- 100% Static HTML/CSS/JS with zero runtime framework dependencies.
- Single Source of Truth in `assets/data/*.json` (`products.json`, `events.json`, `journal.json`, `site-reviews.json`, `content.json`).
- Build pipeline (`scripts/build-site-data.js`, `scripts/build-security-headers.js`) compiles JSON into derived JS data objects (`assets/js/*-data.js`), static HTML comment markers, `products/*.html`, `feed.xml`, `sitemap.xml`, and syncs CSP across `_headers`, `netlify.toml`, and `vercel.json`.
- Client engines: `assets/js/main.js` (UI routing, modals, search, reviews, journal, calendar, maps), `assets/js/cart.js` (cart drawer, checkout payload, loyalty wallet, share cart, gifting), `workers/checkout.js` (Cloudflare Worker Stripe Checkout session).
- Comprehensive quality gates: Unit test suite (`scripts/*.test.js`), Static QA assertions (`scripts/qa-check.js`), Puppeteer integration (`scripts/puppeteer_tests.js`), Axe-core WCAG 2.2 AA (`scripts/a11y-check.js`), and Playwright cross-browser (`scripts/cross-browser-check.js`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Cart Gifting Integration | "This order is a gift" checkbox and optional gift note textarea in cart drawer passed to Stripe Checkout metadata | M1 | Survey R1 |
| 2 | Share Cart Short URL | "Share Cart" link button generating shareable URLs that restore cart state upon opening | M1 | Survey R1 |
| 3 | Alt-Points Loyalty Wallet | Stored-value loyalty wallet integration (100 pts = $5 off promo voucher) with balance carryover | M1 | Survey R1 |
| 4 | 1-Click Add to Calendar | .ics downloadable data URI and Google Calendar links on `events.html` | M2 | Survey R2 |
| 5 | Booth Pickup Deep-linking | "Reserve / Pick Up at This Booth" button deep-linking to `shop.html` with pickup pre-selected | M2 | Survey R2 |
| 6 | Maps Directions Navigation | Direct links to Google Maps / Apple Maps directions on event cards | M2 | Survey R2 |
| 7 | Structured Scent Profiles | Scent notes (Top, Heart, Base) and intensity indicator on apothecary products | M3 | Survey R3 |
| 8 | Expandable Usage Accordions | "<details>" accordions ("How to Apply", "Storage & Shelf Life", "Patch Test Guidelines") on PDPs | M3 | Survey R3 |
| 9 | Freshness Trust Badge | "Poured in Landrum, SC · Small-Batch Promise" trust badge on PDPs and cards | M3 | Survey R3 |
| 10| Journal Mini-Product Card | Inline mini-product card with 1-click Add to Cart on journal posts | M4 | Survey R4 |
| 11| Journal Reading Time & Tags | Estimated reading time (⏱️ X min read) and topical tags on journal posts | M4 | Survey R4 |
| 12| Valid RSS Feed (feed.xml) | Valid RSS 2.0 feed.xml generated in build-site-data.js and linked in <head> of all pages | M4 | Survey R4 |
| 13| Reviews Instant Search & Filter| Keyword search and star rating filter chips (5★, 4★, etc.) on `reviews.html` | M5 | Survey R5 |
| 14| Verified Buyer Badges | Highlight verified buyer badges on reviews | M5 | Survey R5 |
| 15| Standalone Order Status Page | `/order-status.html` supporting URL query lookup and 1-click "Reorder Past Order" | M6 | Survey R6 |
| 16| Printable Packing Slip | Printable fulfillment packing slip formatting gift message without item prices | M6 | Survey R6 |
| 17| Universal SVG Icon Harmonization | Replace UI system emojis with monoline inline vector SVGs (aria-hidden, stroke=currentColor) | M7 | Survey R7 |
| 18| Full Quality Gates Verification | 100% green across build-data, test, lint, format:check, test:integration, test:cross-browser | M7 | Survey R7 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Cart, Checkout, Gifting & Loyalty Integration | F1, F2, F3: Cart drawer gifting UI, Stripe metadata in `workers/checkout.js`, share cart URL hydration, Alt-Points wallet & vouchers | none | DONE |
| 2 | Events & Pop-up Calendar Experience | F4, F5, F6: Add to calendar (.ics & Google Cal), booth pickup deep-linking to `shop.html`, maps navigation links | none | DONE |
| 3 | Product Detail Pages (PDP) & Merchandising | F7, F8, F9: Scent notes & intensity, usage accordions, freshness badge in `products.json`, `build-site-data.js`, `products/*.html` | none | DONE |
| 4 | Apothecary Journal & Content Hub | F10, F11, F12: Featured product mini-cards, reading time, tags, RSS feed.xml, `<head>` RSS links | M1, M3 | DONE |
| 5 | Reviews & Social Proof Search & Filter | F13, F14: Dedicated `reviews.html` with live search, star rating chips, verified buyer badges in `site-reviews.json` | none | PLANNED |
| 6 | Self-Service Order Status & Packing Slips | F15, F16: Standalone `order-status.html`, URL lookup, reorder button, printable gift packing slip without prices | M1 | PLANNED |
| 7 | Universal SVG Icon Harmonization & Quality Gates | F17, F18: Inline vector SVGs replacing emojis, update test suites, verify all 5 quality gates | M1, M2, M3, M4, M5, M6 | PLANNED |

## Interface Contracts
### Cart Engine ↔ Stripe Checkout (`assets/js/cart.js` ↔ `workers/checkout.js`)
- `toCheckoutPayload(items, pickupMarket, giftCardCode, isGiftOrder, giftMessage)`
- POST payload sends `{ items, pickup_market, gift_card_code, is_gift_order, gift_message }`
- Worker creates Stripe Checkout session with `metadata: { is_gift_order: "true", gift_message: "...", ... }`

### Shared Cart Link (`assets/js/cart.js`)
- URL format: `shop.html?cart=slug1:qty,slug2:qty` or JSON base64 / URL encoded
- On `init()`, parse `?cart=`, add valid products from `products-data.js`, open cart drawer with toast notification.

### Event Cards ↔ Shop Pickup (`assets/js/main.js` ↔ `assets/js/cart.js`)
- Link on event card: `shop.html?pickup_market=<market-id>#shop-catalog`
- `shop.html` loads `events-data.js` and activates market pickup in `cart.js`.

### Journal Posts ↔ Mini Product Cards (`assets/js/main.js` ↔ `assets/js/cart.js`)
- Post data contains `featuredProductId`
- Mini card renders `<button class="btn btn-sm yl-add-item" data-item-id="..." data-item-name="..." data-item-price="..."> + Add to Cart </button>`

### Order Status ↔ Cart Reorder (`order-status.html` ↔ `assets/js/cart.js`)
- "Reorder Past Order" loops through past items, calls `window.YLCart.addItem(id, qty)`, and opens `#yl-cart-drawer`.

## Code Layout
- HTML pages: `index.html`, `shop.html`, `about.html`, `events.html`, `thank-you.html`, `contact.html`, `faq.html`, `journal.html`, `reviews.html`, `order-status.html`, `404.html`, `policies.html`, `privacy.html`, `terms.html`, `products/*.html`.
- Styles: `assets/css/styles.css`, `assets/css/cart.css`.
- Scripts & Engine: `assets/js/main.js`, `assets/js/cart.js`, `workers/checkout.js`, `assets/js/*-data.js`.
- Build & Test Scripts: `scripts/build-site-data.js`, `scripts/build-security-headers.js`, `scripts/qa-check.js`, `scripts/*.test.js`, `scripts/puppeteer_tests.js`, `scripts/a11y-check.js`, `scripts/cross-browser-check.js`.
- Data Files: `assets/data/products.json`, `assets/data/events.json`, `assets/data/journal.json`, `assets/data/site-reviews.json`, `assets/data/content.json`, `admin/config.yml`.
