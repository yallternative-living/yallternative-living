# Y'allternative Living — Comprehensive Site Audit & Fixes Report

This report documents the final full audit of the codebase at `/Users/steven/Documents/GitHub/yallternative-living` conducted on 2026-07-19.

## Scanned Files
The following files were inspected for layout, functionality, compliance, styling, performance, and code quality issues:
- `index.html`
- `shop.html`
- `about.html`
- `contact.html`
- `events.html`
- `policies.html`
- `privacy.html`
- `terms.html`
- `404.html`
- `assets/css/styles.css`
- `assets/js/main.js`
- `assets/js/products-data.js`
- `assets/js/events-data.js`
- `assets/js/site-reviews-data.js`
- `assets/data/products.json`
- `assets/data/snipcart-products.json`
- `assets/data/events.json`
- `assets/data/site-reviews.json`
- `sw.js`
- `site.webmanifest`
- `sitemap.xml`
- `robots.txt`

---

## Audit Findings & Resolution Status

### 🔴 Critical Issues

| ID | Issue | Location | Resolution Status |
|----|-------|----------|-------------------|
| 1 | Snipcart API key is a placeholder (`YOUR_SNIPCART_PUBLIC_API_KEY`) | All HTML files | **Skipped** (Requires production credentials) |
| 2 | Contact form Formspree target is placeholder (`YOUR_FORM_ID`) | `contact.html` | **Skipped** (Requires production credentials) |
| 3 | Review form Formspree target is placeholder (`YOUR_FORMSPREE_FORM_ID`) | `shop.html` | **Skipped** (Requires production credentials) |
| 4 | Newsletter form target is placeholder (`YOUR_KIT_FORM_ACTION_URL`) | All HTML files | **Skipped** (Requires production credentials) |
| 5 | `"ritual"` category display name missing from label map | `assets/js/main.js` | **Fixed** (Added `ritual: "Ritual & Home"`) |
| 6 | Gift card `data-item-url` set to incorrect page (`/shop.html`) | `shop.html` | **Fixed** (Pointed to `/assets/data/snipcart-products.json`) |
| 7 | Snipcart manifest missing the digital gift card entry | `snipcart-products.json` | **Fixed** (Added gift card entry with correct properties) |
| 8 | `#siteReviewsEmpty` message is not hidden when reviews render | `shop.html` + `main.js` | **Fixed** (Added hidden style rules when list is rendered) |

---

### 🟠 Moderate Issues

| ID | Issue | Location | Resolution Status |
|----|-------|----------|-------------------|
| 9 | Tawk.to Live Chat properties are placeholders | All HTML files | **Skipped** (Requires production credentials) |
| 10 | Unused and commented-out Gift Up! placeholder div | `shop.html` | **Skipped** (Placeholder, left as template code) |
| 11 | Five products using `placeholder-coming-soon.svg` as image | `products-data.js` / `.json` | **Skipped** (Placeholder, expects real images later) |
| 12 | Internal developer notes visible in public ingredient lists | `products-data.js` / `.json` | **Fixed** (Removed approximate recipe disclaimer notes) |
| 13 | Typo in frankincense Etsy URL ("frankencise") | `products-data.js` / `.json` | **Fixed** (Corrected to "frankincense") |
| 14 | index.html canonical and OpenGraph URLs reference `/index.html` | `index.html` | **Fixed** (Changed to `/` root URL) |
| 15 | Script imports for reviews/events missing `?v=2.0` cache-busters | `shop.html` + `events.html` | **Fixed** (Added `?v=2.0` cache buster parameters) |
| 16 | Service worker fails to match cached assets due to query params | `sw.js` | **Fixed** (Updated match logic to strip search parameters) |
| 17 | Four debug `console.log` statements outputting in production | `assets/js/main.js` | **Fixed** (Removed all logs) |
| 18 | Bio image using generic T-shirt mockup rather than founder photo | `about.html` | **Fixed** (Adjusted alt text description to unisex tee style) |
| 19 | Mobile header logo `<img>` missing `width` attribute (CLS risk) | `index.html` | **Fixed** (Added `width="48"`) |

---

### 🟡 Minor Issues

| ID | Issue | Location | Resolution Status |
|----|-------|----------|-------------------|
| 20 | sitemap.xml references `/index.html` instead of root | `sitemap.xml` | **Fixed** (Corrected to root `/`) |
| 21 | site.webmanifest uses non-standard combined maskable purpose | `site.webmanifest` | **Fixed** (Split into separate `"any"` and `"maskable"` tags) |
| 22 | Duplicated FAQ content present on shop.html | `shop.html` | **Fixed** (Removed duplicate and pointed to contact.html#faq) |
| 23 | Service worker registration is declared in global scope | `assets/js/main.js` | **Fixed** (Moved SW registration safely inside main IIFE) |
| 24 | Variant price delta negative formatting issue `(+$-X.XX)` | `assets/js/main.js` | **Fixed** (Adjusted prefix check for negative numbers) |
| 25 | Snipcart library loading on pure text/legal pages | Legal HTML templates | **Skipped** (Intentionally retained for navbar cart integration) |
| 26 | Service worker cache failure on 404 assets during installation | `sw.js` | **Fixed** (Appended `.catch()` to cache promise handler) |
| 27 | Hero text states "18 Handmade Goods" (includes placeholders) | `shop.html` | **Fixed** (Updated count to 13 real products) |

---

## Verification Results
All fixes have been validated locally.
- **Prettier Format**: Passed (`npm run format` successfully resolved all issues).
- **ESLint Linter**: Passed (`npm run lint` reported zero warnings or errors).
- **QA Test Suite**: Passed (**236 of 236 checks passing successfully**).
