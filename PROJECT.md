# Project: 2026 SOTA Global Search Suite

## Architecture
- **Zero-Runtime-Framework Static Architecture**: Vanilla HTML5, CSS3 with modern CSS custom properties, and modular vanilla JavaScript.
- **Single Source of Truth**: Canonical JSON in `assets/data/` (`products.json`, `journal.json`, `events.json`, `content.json`).
- **Compilation Pipeline (`scripts/build-site-data.js`)**: Compiles normalized client search index `assets/js/search-data.js` (`window.YL_SEARCH_INDEX`), injects header `.nav-search-btn` and `<dialog id="global-search-modal">` into all 15 top-level HTML pages and 19 generated `products/*.html` pages.
- **Offline & Service Worker Support (`sw.js`)**: Cached search index enables instant in-memory client-side searches even when offline.
- **W3C ARIA Combobox 1.2 / 1.3 & Dialog Pattern**: Native `<dialog>` element with `showModal()`, focus trapping, `Escape` key close, focus restoration to search trigger, and polite live regions (`aria-live="polite"`).
- **Brand & Aesthetic Invariants**:
  - Color Tokens: `var(--paper)`, `var(--ink)`, `var(--whiskey)` (`#d97736`), `var(--hide)`, `var(--cream)`.
  - Dark & Light theme translucent backdrop blur (`rgba(28, 23, 19, 0.85)` / warm parchment).
  - Warm terracotta/gold focus glow rings, never browser default blue outlines.
  - Southern botanical apothecary voice in placeholder and zero-result recovery states.
  - Pill badges, rounded thumbnails (`8px`), 0 horizontal overflow.
  - 100% Monoline Vector SVGs across all search triggers, chips, segment headers, event badges, and empty states.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Global Header 🔍 Trigger & Spotlight Modal | Accessible search button in header `.nav-cta` and native `<dialog id="global-search-modal">` modal with glassmorphic backdrop. | M1, M2 | Survey / R1 |
| 2 | Keyboard Shortcuts (`Cmd+K`, `/`, `Escape`) | Global spotlight shortcuts (`Cmd+K`/`Ctrl+K`, `/` guarded against inputs, `Escape` dismiss and focus restoration). | M2 | Survey / R1 |
| 3 | Popular Search Quick Chips | Zero-state 1-tap chips (`[Bedtime & Sleep]`, `[Sore Muscles]`, `[Dry Skin & Eczema]`, `[Bug Defense]`, `[Pop-Up Markets]`, `[Gift Cards]`) with instant execution. | M2 | Survey / R2 |
| 4 | Instant Floating Autocomplete with Live Thumbnails | Debounced (150ms) live matching results with thumbnails, price, in-stock badges, and arrow-key navigation (`ArrowDown`/`ArrowUp`/`Enter`). | M3 | Survey / R3 |
| 5 | 1-Click Add to Cart Action | Inline `[ + Add to Cart ]` on product search results, variant resolution, cart count badge increment, and drawer coordination. | M3 | Survey / R3 |
| 6 | Universal Cross-Content Search (4 Domains) | Simultaneous search across Products, Journal, Markets & Events (`events.json`), and FAQ with segmented headers & counters. | M3 | Survey / R4 + User Req |
| 7 | Two-Tier Synonym & Intent Engine | Botanical synonyms (lavender, magnesium, arnica, calendula, shea) + skin concern/intent mappings (sleep, eczema, sore muscles, bug defense, gift cards). | M3 | Survey / R4 |
| 8 | Search Data Compilation Pipeline | `scripts/build-site-data.js` compiles `assets/js/search-data.js` (including events) and updates all static HTML and `products/*.html` templates. | M1 | Survey / Architecture |
| 9 | Dedicated Unit Test Suite | `scripts/global-search.test.js` covering 4-domain search, tokenization, synonym expansion, chips, keyboard navigation, ARIA states, and cart payload. | M4 | Survey / Testing |
| 10 | Static QA Rule Assertions | `scripts/qa-check.js` asserting search trigger and modal markup across all 32+ pages. | M4 | Survey / Testing |
| 11 | Headless Browser Integration Tests | `scripts/puppeteer_tests.js` multi-viewport tests across Desktop (1200x800), Tablet (768x1024), and Mobile (375x667). | M4 | Survey / Testing |
| 12 | WCAG 2.2 AA Accessibility & Cross-Browser Gate | `scripts/a11y-check.js` (0 axe-core violations across 34 pages) + `scripts/cross-browser-check.js` (Chromium, Firefox, WebKit, Mobile Safari, Mobile Chrome). | M5 | Survey / Gate |
| 13 | Test Runner Parallelization | `scripts/run-unit-tests.js`, `scripts/cross-browser-check.js`, `scripts/run-integration-tests.js` parallelized across CPU cores. | M4/M5 | User Directive |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Build Compiler & Markup Foundation | `scripts/build-site-data.js` (search data index generator for Products, Journal, Events, FAQ, header `.nav-search-btn` injection, `<dialog id="global-search-modal">` template injection in static pages & `products/*.html`), `sw.js` cache update. | none | DONE |
| M2 | Modal CSS, Dialog Lifecycle, Popular Chips & Shortcuts | `assets/css/styles.css` (modal styles, backdrop blur, search input, chips, results list, footer hints), `assets/js/main.js` (`openSearchModal`, `closeSearchModal`, `Cmd+K`, `/`, `Escape`, focus trap & restoration, popular chips click). | M1 | DONE |
| M3 | Search Engine, Cross-Domain Autocomplete & 1-Click Cart | `assets/js/main.js` (tokenizer, 2-tier synonym engine, Products + Journal + Events + FAQ matching, debounced input, live thumbnail rendering, arrow key navigation, 1-click cart action integration with `assets/js/cart.js`, `aria-live` polite announcements). | M1, M2 | DONE |
| M4 | Unit Tests, QA Assertions & Integration Tests | `scripts/global-search.test.js`, `scripts/qa-check.js`, `scripts/puppeteer_tests.js` search integration suite across Desktop, Tablet, and Mobile viewports. | M1, M2, M3 | DONE |
| M5 | Multi-Agent Review, Challenger, Forensic Audit & Final Gate | Full verification pipeline (`npm run build-data`, `npm test`, `npm run lint`, `npm run format:check`, `npm run test:integration`, `scripts/a11y-check.js`, `npm run test:cross-browser`), Reviewers, Challenger, Forensic Auditor. | M1, M2, M3, M4 | DONE |

## Interface Contracts

### Data Index Contract (`assets/js/search-data.js` ↔ `assets/js/main.js`)
- `window.YL_SEARCH_INDEX`:
  - `products`: Array of `{ id, name, category, categoryLabel, price, formattedPrice, image, inStock, comingSoon, featured, blurb, tags, concerns, scent, ingredients, keywords, url, variants }`
  - `journal`: Array of `{ id, title, date, formattedDate, image, readTime, tags, excerpt, featuredProductId, url }`
  - `events`: Array of `{ id, title, date, formattedDate, location, city, description, tags, url }`
  - `faq`: Array of `{ id, question, answer, category, keywords, url }`
  - `synonyms`: Object mapping canonical terms to synonym lists.

### Modal UI & Event Contract
- **Trigger**: `<button class="nav-search-btn" id="globalSearchTrigger" type="button" aria-label="Search catalog, articles & FAQ" title="Search (Cmd+K)" aria-haspopup="dialog" aria-expanded="false" aria-controls="global-search-modal">`
- **Dialog**: `<dialog id="global-search-modal" class="global-search-modal gift-modal" aria-labelledby="globalSearchModalTitle" aria-modal="true">`
- **Input**: `<input type="search" id="globalSearchInput" class="global-search-input" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="globalSearchResultsList" aria-activedescendant="" placeholder="Search salves, soaks, journal, FAQ, events… (Cmd+K)">`
- **Results List**: `<div id="globalSearchResultsList" class="global-search-results-list" role="listbox" aria-label="Search results" tabindex="-1">`
- **Option Item**: `<div id="search-opt-${index}" class="search-result-item" role="option" aria-selected="false" data-item-type="product|journal|event|faq">`
- **Cart Button**: `<button type="button" class="btn btn-primary btn-sm yl-add-item search-add-btn" data-item-id="${id}" data-item-name="${name}" data-item-price="${price}" data-item-image="${image}">+ Add to Cart</button>`
- **Live Status**: `<div id="globalSearchResultCount" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>`

## Code Layout
- `assets/data/`: Single source of truth JSON files (`products.json`, `journal.json`, `events.json`, `content.json`).
- `scripts/build-site-data.js`: Main data compilation script.
- `assets/js/search-data.js`: Generated static search index.
- `assets/js/main.js`: Modal lifecycle, search controller, tokenizer, keyboard listeners.
- `assets/js/cart.js`: Cart integration and event delegation.
- `assets/css/styles.css`: Site-wide styles including `/* GLOBAL SEARCH SUITE */`.
- `scripts/global-search.test.js`: Dedicated unit test suite.
- `scripts/qa-check.js`: Static quality assertions.
- `scripts/puppeteer_tests.js`: Headless browser integration tests.
- `scripts/a11y-check.js`: Axe-core WCAG 2.2 AA accessibility scanner.
- `scripts/cross-browser-check.js`: Playwright cross-browser test runner.
- `scripts/run-unit-tests.js`: Parallel unit test runner.
- `scripts/run-integration-tests.js`: Parallel integration test runner.
