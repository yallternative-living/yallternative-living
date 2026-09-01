# Project: Y'allternative Living E-Commerce Quick Wins Suite

## Architecture
The Y'allternative Living platform is a 100% static HTML/CSS/JS e-commerce application with zero runtime framework dependencies.
Data flow:
1. Canonical Single Source of Truth in `assets/data/*.json` (`products.json`, `events.json`, `content.json`, `site-reviews.json`).
2. Build compiler `scripts/build-site-data.js` compiles JSON into derived client data globals (`assets/js/products-data.js`, `assets/js/events-data.js`, etc.), updates static HTML comment markers, compiles 19 individual product detail pages (`products/*.html`), and generates sitemap/robots/llms.
3. Client runtime: `assets/js/main.js` (DOM interactions, theme, search, wishlist, carousels, sticky bar, variant switching), `assets/js/cart.js` (client-side cart state, volume discounts, multi-tier shipping/gift meters, Stripe checkout payload).
4. Cloudflare Worker: `workers/checkout.js` (server-side cart validation, tax calculation, Stripe Checkout session creation, promotion codes, and free gift metadata).
5. Testing stack: Node.js parallel unit test runners (`scripts/run-unit-tests.js`), static quality validation (`scripts/qa-check.js`), Puppeteer integration suites (`scripts/run-integration-tests.js`), axe-core WCAG 2.2 AA audit (`scripts/a11y-check.js`), and Playwright multi-browser test (`scripts/cross-browser-check.js`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R5.1 Rich Product Schema | `<script type="application/ld+json">` for Schema.org `Product` on all 19 PDPs | M1 | ORIGINAL_REQUEST §R5 |
| 2 | R5.2 Return Policy Schema | `hasMerchantReturnPolicy` (30-day returns, US, free mail returns) in Offer | M1 | ORIGINAL_REQUEST §R5 |
| 3 | R5.3 Shipping Details Schema | `shippingDetails` ($10 flat rate standard, $0 free shipping over $40 threshold) | M1 | ORIGINAL_REQUEST §R5 |
| 4 | R5.4 Stock Availability Schema | `ItemAvailability` URI (`https://schema.org/InStock`, `OutOfStock`, `PreOrder`) | M1 | ORIGINAL_REQUEST §R5 |
| 5 | R5.5 4-Tier Breadcrumb Schema | `BreadcrumbList` JSON-LD (Home > Shop > Category > Product) on all 19 PDPs | M1 | ORIGINAL_REQUEST §R5 |
| 6 | R3.1 Multi-Tier Milestone Meter | Multi-tier milestone tracker in cart drawer ($40 Free Shipping, $60 Free Pocket Salve) | M2 | ORIGINAL_REQUEST §R3 |
| 7 | R3.2 Dynamic Distance Copy | Real-time countdown: "Add $8.01 more to unlock a Free Pocket Salve!" with float precision | M2 | ORIGINAL_REQUEST §R3 |
| 8 | R3.3 Milestone Pins & Visuals | Progress track with milestone pins, icons (truck, gift), and `.is-reached` states | M2 | ORIGINAL_REQUEST §R3 |
| 9 | R3.4 Free Gift Metadata | Server-side metadata in `workers/checkout.js` (`metadata.free_gift`) | M2 | ORIGINAL_REQUEST §R3 |
| 10 | R4.1 Recently Viewed Tracking | `localStorage["yl-recently-viewed"]` tracking on PDP visit (capped at 8 items, privacy-safe) | M3 | ORIGINAL_REQUEST §R4 |
| 11 | R4.2 Scroll-Snap Carousel UI | Horizontal CSS scroll-snap carousel rendered on `shop.html` and PDPs when >= 2 items exist | M3 | ORIGINAL_REQUEST §R4 |
| 12 | R2.1 Cross-Sell Data Schema | `pairsWith` product ID arrays and `ritualTitle` strings on botanical items in `products.json` | M4 | ORIGINAL_REQUEST §R2 |
| 13 | R2.2 Ritual Section UI | "Complete the Ritual" callout section on PDPs & shop modal with bundle pricing | M4 | ORIGINAL_REQUEST §R2 |
| 14 | R2.3 1-Click Multi-Item Add | 1-click batch add to cart using `window.YLCart.addItems(itemsArray)` | M4 | ORIGINAL_REQUEST §R2 |
| 15 | R1.1 Sticky Bottom Bar DOM | Accessible `.pdp-sticky-bar` markup on PDPs (<768px) with thumb, title, price, variant, Add to Cart | M5 | ORIGINAL_REQUEST §R1 |
| 16 | R1.2 Scroll Trigger Observer | `IntersectionObserver` sliding sticky bar into view when primary CTA scrolls out of view | M5 | ORIGINAL_REQUEST §R1 |
| 17 | R1.3 Bi-directional Variant Sync | Real-time sync between sticky bar variant and main PDP details form | M5 | ORIGINAL_REQUEST §R1 |
| 18 | R1.4 Mobile Safe Area & Styling | Fixed bottom layout, iOS `env(safe-area-inset-bottom)`, touch targets >= 44x44px | M5 | ORIGINAL_REQUEST §R1 |
| 19 | Quality Gate Full Verification | 100% E2E tests, axe-core WCAG 2.2 AA (0 errors), Playwright cross-browser, lint & format | M6 | ORIGINAL_REQUEST §Quality Gates |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Google Merchant Rich Product JSON-LD (R5) | `scripts/build-site-data.js`, `scripts/build-site-data.test.js`, `scripts/qa-check.js` | None | PLANNED |
| M2 | Multi-Tier Free Shipping & Gift Progress Meter (R3) | `assets/js/cart.js`, `assets/css/cart.css`, `scripts/cart-engine.test.js`, `scripts/cart.test.js`, `workers/checkout.js` | None | PLANNED |
| M3 | "Recently Viewed Products" Carousel (R4) | `assets/js/main.js`, `assets/css/styles.css`, `shop.html`, `scripts/main.test.js` | None | PLANNED |
| M4 | "Complete the Ritual" Smart Cross-Sells (R2) | `assets/data/products.json`, `admin/config.yml`, `scripts/build-site-data.js`, `assets/js/main.js`, `assets/css/styles.css`, `scripts/pdp-merchandising.test.js` | M1, M2 | PLANNED |
| M5 | Mobile Sticky Add-to-Cart Bottom Bar on PDPs (R1) | `scripts/build-site-data.js`, `assets/js/main.js`, `assets/css/styles.css`, `scripts/main.test.js` | M1, M2 | PLANNED |
| M6 | E2E Integration, Cross-Browser & A11y Verification | `scripts/puppeteer_tests.js`, `scripts/extended_qa_test.js`, `scripts/a11y-check.js`, `scripts/cross-browser-check.js` | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts

### M1: Schema Generator Contract
- Function `generateProductJsonLd(product, domain, categoryLabel)` -> Returns JSON-LD object for Schema.org `Product` with `offers` (`AggregateOffer` or `Offer`), `hasMerchantReturnPolicy`, `shippingDetails`, `ItemAvailability`, `aggregateRating`.
- Function `generateProductBreadcrumbJsonLd(product, domain, categoryLabel)` -> Returns 4-tier Schema.org `BreadcrumbList`.

### M2: Cart Milestone Meter Contract
- Data structure in `window.YL_PRODUCTS.shop.shippingMilestones`:
  `[{ threshold: 40, reward: "Free Tracked Shipping", icon: "truck" }, { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" }]`
- Function `getShippingMilestones()` -> Array of `{ threshold: number, reward: string, icon: string }`.
- Method `YLCart.physicalSubtotal(items)` -> number of non-gift-card subtotal.
- UI elements: `.yl-cart-milestones`, `.yl-cart-milestones-track`, `.yl-cart-milestones-fill`, `.yl-cart-milestone-pin`, `.yl-cart-milestones-msg`.

### M3: Recently Viewed Contract
- Storage Key: `localStorage["yl-recently-viewed"]`
- Schema: Array of `{ id: string, name: string, price: number, priceRange?: string, image: string, category: string, timestamp: number }`, max length 8.
- Method `recordRecentlyViewed(product)`
- Container: `#recently-viewed-section` (in `shop.html`) and `#pdpRecentlyViewedSection` (in PDPs).

### M4: Ritual Cross-Sell Contract
- Data in `assets/data/products.json`: Product entries have `pairsWith: string[]` (referencing valid product IDs) and `ritualTitle: string`.
- Method `YLCart.addItems(itemsArray)` -> Adds multiple items in a single atomic batch, updates drawer, announces count.

### M5: Mobile Sticky Bar Contract
- Element: `.pdp-sticky-bar` inside PDP `<main class="container pdp-container">`.
- Trigger: `IntersectionObserver` observing `.pdp-actions` / primary purchase CTA.
- Variant synchronization: Two-way binding between `.pdp-details .variant-select` and `.pdp-sticky-variant-select`.
- Action: Click `.pdp-sticky-add-btn` invokes `YLCart.addItem(...)`.

## Code Layout
- `assets/data/products.json` — Product catalog single source of truth
- `admin/config.yml` — Sveltia CMS configuration
- `scripts/build-site-data.js` — Build compiler & static HTML generator
- `assets/js/main.js` — Client runtime for site interactions
- `assets/js/cart.js` — Cart state and drawer engine
- `assets/css/styles.css` — Global stylesheet and component styles
- `assets/css/cart.css` — Cart drawer styling
- `workers/checkout.js` — Cloudflare Worker for checkout & Stripe API
- `scripts/*.test.js` — Unit test suites
- `scripts/qa-check.js` — Static QA assertions
- `scripts/puppeteer_tests.js` — Multi-viewport Puppeteer integration tests
- `scripts/extended_qa_test.js` — Rapid click and edge case integration tests
- `scripts/a11y-check.js` — axe-core WCAG 2.2 AA accessibility verification
- `scripts/cross-browser-check.js` — Playwright cross-browser verification
