# Project: Y'allternative Living CMS Merchandising & Compilation Expansion

## Architecture
- **Tech Stack**: 100% Static HTML/CSS/JS with zero runtime framework dependencies.
- **Data Pipeline**:
  - Single Source of Truth in `assets/data/`: `content.json`, `products.json`, `events.json`, `site-reviews.json`, `journal.json`, `social-feed.json`.
  - Sveltia CMS configuration in `admin/config.yml`.
  - Compiler `scripts/build-site-data.js` transforms JSON files into derived JS data objects (`assets/js/*-data.js`), replaces HTML comment markers (`<!--YL:...-->`), compiles `assets/data/footer.html` into all 15 HTML pages, compiles `products/*.html`, and updates SEO/discovery files (`sitemap.xml`, `llms.txt`).
  - Client-side runtime in `assets/js/main.js` and `assets/js/cart.js`.

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | Sitewide Announcement Banner CMS & Compilation | Configurable banner text, link URL, background accent theme in `content.json.site.announcement` and `admin/config.yml`, compiled into client data and rendered in header with WCAG 2.2 AA contrast. | M1, M2 | R1 | DONE |
| 2 | Seasonal Workshop / Shipping Notices | Owner-controlled notice message, link, and toggles in `content.json.site.seasonalNotice` and `admin/config.yml`, rendered in cart drawer (`assets/js/cart.js`) and header. | M1, M2 | R1 | DONE |
| 3 | Social Media Profile URLs in CMS & Footer | Owner-controlled profile URLs (Instagram, TikTok, Facebook, Etsy, Pinterest, YouTube) in `content.json.site.social` and `admin/config.yml`, dynamically compiled into `footer.html`, all 15 static HTML pages, Schema.org `sameAs` JSON-LD, and `llms.txt`. | M1 | R2 | DONE |
| 4 | Global Ritual Defaults | Fallback title and subtitle in `content.json.site.ritualDefaults` and `admin/config.yml`, consumed by `build-site-data.js` and `main.js` when product `ritualTitle` is omitted. | M1, M2 | R3 | DONE |
| 5 | Pre-Order Batch Dates Merchandising | Optional `estimatedBatchDate` field in `products.json` and `admin/config.yml`, rendered on PDPs, catalog cards, and reflected in Schema.org `PreOrder` availability. | M1, M2 | R3 | DONE |
| 6 | Apothecary Product Quiz Schema & Dynamic Engine | Decouple questions, symptom options, recommendation maps, and scoring weights into `content.json.quiz` (and `admin/config.yml`), dynamically rendered by `main.js` with full backward compatibility and 100% test contract preservation. | M1, M2 | R4 | DONE |
| 7 | Static QA Assertions & Unit Test Expansion | Expand `scripts/qa-check.js` with assertions for new CMS fields, regex guards, contrast tokens, social link sanitization, and referential integrity. Expand `scripts/build-site-data.test.js`, `scripts/main.test.js`, `scripts/cart.test.js`, `scripts/pdp-merchandising.test.js`. | M3 | QA Gates | DONE |
| 8 | E2E Integration, a11y & Adversarial Verification | Full Puppeteer integration verification, axe-core WCAG 2.2 AA scans across all pages in light/dark themes, lint, format check, and forensic audit. | M4 | QA Gates | DONE |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | CMS Schema, Canonical Data & Build Pipeline | `admin/config.yml`, `assets/data/content.json`, `assets/data/products.json`, `scripts/build-site-data.js`, `assets/data/footer.html` | none | DONE |
| M2 | Frontend Client Runtime & Merchandising Rendering | `assets/js/main.js`, `assets/js/cart.js`, `assets/css/styles.css`, `assets/css/cart.css`, `shop.html` | M1 | DONE |
| M3 | Static QA Assertions & Unit Test Expansion | `scripts/qa-check.js`, `scripts/*.test.js` | M1, M2 | DONE |
| M4 | E2E Integration, a11y & Adversarial Verification | `scripts/puppeteer_tests.js`, `scripts/extended_qa_test.js`, `scripts/a11y-check.js`, `scripts/run-test.js` | M1, M2, M3 | DONE |

## Interface Contracts

### `content.json` ↔ `admin/config.yml` ↔ `build-site-data.js` ↔ `main.js`/`cart.js`
1. **`site.announcement`**:
   - `enabled`: boolean
   - `text`: string
   - `link`: string (optional URL/path)
   - `accent`: enum ("default", "whiskey", "moss", "lavender", "rust")
2. **`site.seasonalNotice`**:
   - `enabled`: boolean
   - `text`: string
   - `link`: string (optional)
   - `showInCart`: boolean
   - `showInHeader`: boolean
3. **`site.social`**:
   - `instagram`: string (URL)
   - `tiktok`: string (URL)
   - `facebook`: string (URL)
   - `etsy`: string (URL)
   - `pinterest`: string (URL, optional)
   - `youtube`: string (URL, optional)
4. **`site.ritualDefaults`**:
   - `title`: string ("Botanical Pairing")
   - `subtitle`: string ("Pair this item with complementary botanicals crafted to work together.")
5. **`products[].estimatedBatchDate`**:
   - string (e.g. "Late October 2026", optional)
6. **`content.json.quiz`**:
   - `title`: string
   - `subtitle`: string
   - `eyebrow`: string
   - `steps`: array of step objects with `step` (int), `id` (string), `heading` (string), `paramName` (string), `options` (array of objects with `value`, `label`, `description`, `recommendedProductIds`, `categories`, `matchBundles`, `matchFeatured`, `scoreWeight`).

## Code Layout
- `admin/config.yml`: Sveltia CMS schema definitions and widgets.
- `assets/data/content.json`: Canonical content store.
- `assets/data/products.json`: Canonical product catalog.
- `assets/data/footer.html`: Canonical footer markup template.
- `scripts/build-site-data.js`: Compiler pipeline.
- `assets/js/main.js`: Core client controller and quiz engine.
- `assets/js/cart.js`: Cart drawer controller and notice rendering.
- `assets/css/styles.css`: Sitewide styles, announcement accents, quiz styles.
- `assets/css/cart.css`: Cart drawer styles and seasonal notice styles.
- `scripts/qa-check.js`: Static assertion gate.
- `scripts/*.test.js`: Unit test suites.
