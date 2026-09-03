# Project: Y'allternative Living CMS Merchandising & Compilation Expansion

## Architecture
- **Tech Stack**: 100% Static HTML/CSS/JS with zero runtime framework dependencies.
- **Data Pipeline**:
  - Single Source of Truth in `assets/data/`: `content.json`, `products.json`, `events.json`, `site-reviews.json`, `journal/*.json` (one post per file), `quiz.json`, `social-feed.json`.
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
6. **`assets/data/quiz.json`** (merged into `YL_CONTENT.quiz` by the build):
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

---

# Project: Self-Hosted Translation Architecture Migration

Appended, not substituted. The CMS merchandising inventory and the
`content.json` ↔ `admin/config.yml` contracts above are the live description
of this codebase; an earlier draft of this section overwrote them, which is
how the announcement-banner, seasonal-notice, social-URL, ritual-default,
pre-order-batch and quiz contracts briefly stopped being written down
anywhere. Two documents, one file.

## Architecture

Google restricted the Translate widget to non-commercial use in 2019, so it
was never licensed for this shop. It is replaced by a self-hosted,
build-compiled dictionary engine.

1. **Build-time compilation (`scripts/build-site-data.js`)**
   - Canonical dictionaries `assets/data/locales/{en,es,de,fr,ja,zh}.json`
     (206 phrases each) plus `assets/data/brand-glossary.json`.
   - Compiled to `assets/js/locales-data.js` (~71KB), which sets
     `window.YL_LOCALES` and `window.YL_BRAND_GLOSSARY`.
   - `validateLocalesAndGlossary()` fails the build when a translation drops a
     protected term the English string contains.
   - `locales-data.js` and `translator.js` are added to `sw.js`
     `ASSETS_TO_CACHE`, so switching language works offline.
   - **No SEO layer.** There is deliberately no `hreflang` injection and no
     `<xhtml:link>` in `sitemap.xml`; `robots.txt` carries
     `Disallow: /*?lang=`. See "Why there is no hreflang" below.

2. **Client runtime (`assets/js/translator.js`)**
   - Zero external scripts, zero iframes, zero cookies, zero network requests.
     Verified empirically: six language switches on `shop.html` produced `[]`
     external requests and `[]` cookies.
   - In-place text-node replacement via a `TreeWalker` over
     `SHOW_ELEMENT | SHOW_TEXT`, with the original cached on
     `node.__ylOriginalText` so English restores byte-identically.
   - `MutationObserver` on `document.body` (`childList` + `subtree` only)
     translates dynamically injected DOM -- the cart drawer
     (`.yl-cart-drawer`), search results, quiz, reviews. It returns
     immediately while the language is English, so English visitors pay
     nothing.
   - Preference in `localStorage['yl-lang']`, overridable per-visit with
     `?lang=xx`. Both reads and both writes are in `try/catch`; translation
     still works with `localStorage` throwing.
   - `assets/js/main.js` injects both scripts with **`.async = false`**.
     `defer` does nothing on a dynamically created script -- the spec sets
     force-async -- and without the ordering the 28KB engine beat the 71KB
     dictionaries on 10 cold loads out of 10, translating nothing while still
     flipping the header badge. `translator.js` also re-runs `init()` if
     `YL_LOCALES` arrives late.
   - Accessible language selector in `.nav-cta`: `aria-haspopup="listbox"`,
     `aria-controls="langDropdown"`, maintained `aria-expanded`,
     ArrowUp/Down/Home/End/Escape/Tab with correct focus return, 42-44px
     targets, and an accessible name that names the current language.

3. **Security and privacy**
   - `translate.google.com`, `translate.googleapis.com` and
     `translate-pa.googleapis.com` removed from `script-src`, `img-src`,
     `style-src` and `connect-src` across `_headers`, `netlify.toml` and
     `vercel.json` via `scripts/build-security-headers.js`. No other token
     changed; three-way byte parity holds; no new inline-script hash.
   - No dictionary or glossary string ever reaches `innerHTML`. Text goes
     through `node.nodeValue` / `node.textContent`; attributes through
     `setAttribute`, and only `placeholder`, `aria-label` and `title` -- never
     `href`, `src`, `style` or `on*`. A poisoned locale can deface copy; it
     cannot execute script or create elements.
   - `?lang=` is validated against the six-code allow-list and is never
     written anywhere.
   - Legacy Google Translate CSS hacks removed from `assets/css/styles.css`;
     `privacy.html` documents the cookieless model.

## Known limitations (measured, not estimated)

These are real and they are why this is a UI-chrome translator, not a
localised site. Numbers are from the 2026-09-02 audit, re-measured after the
blocking fixes:

- **Coverage is 10-21% of text nodes**, not 100%: `/` 56/264 (21.2%),
  `/shop.html` 99/961 (10.3%) under `es`. Lookup is exact string equality on
  the trimmed text, and 58% of authored dictionary entries match no string on
  any page -- `cart.empty` is "Your cart is empty" while the DOM says "Your
  cart is empty."; `pdp.patchTest` is "Patch Test" while the DOM says "Patch
  Test:". Regenerating the dictionaries from the built markup, with a build
  gate asserting every English value appears somewhere in the site, is the
  fix.
- **`data-i18n` is not used anywhere in the shipped markup**, so the key-based
  lookup path is currently dead code and all real translation goes through the
  fragile exact-string path.
- **`<html lang>` stays `"en"`.** Declaring the document Spanish while 79-90%
  of it is English is a WCAG 2.1 SC 3.1.1 (Level A) failure -- a screen reader
  would apply Spanish phonetics to the English majority. Only the elements
  whose text was actually replaced are marked (55 on `/`, 98 on
  `/shop.html`), with `lang="en"` counter-marks where an untranslated element
  sits under a marked one. Revisit when coverage approaches 100%.
- **Meta is never translated.** `translateTree` runs on `document.body`, so
  `<meta name="description">`, `og:title` and `og:description` stay English.
- **Search does not follow the UI language.** The index is English-only:
  under `es`, "dormir" and "pomada" both return 0 rows.
- **Checkout strings are out of reach.** `workers/checkout.js` returns English
  JSON error strings and hands Stripe English `display_name` and
  `terms_of_service_acceptance` text, with no `locale` passed.
- **CLS is not zero.** `/` measures 0.0036 and `/?lang=es` 0.0094 -- the
  injected selector adds ~0.006. Both are far below the 0.1 "good" threshold,
  but "0 CLS" was never true and is not claimed here.
- **The selector's contrast is outside the a11y gate.** Its
  `backdrop-filter: blur(16px)` over an `rgba()` background makes axe report
  7 nodes as `incomplete` for `color-contrast`, and `a11y-check.js` fails only
  on `violations`. Manually computed: ~6.9:1 light, ~9.8:1 dark.
- **No RTL locale ships.** All six declare `"dir": "ltr"`, so the RTL path is
  untested. `<html dir>` is still set document-level; an RTL locale would need
  the same per-element treatment `lang` has.

## Why there is no hreflang

The migration briefly shipped `x-default` + `en` + five `?lang=` alternates on
32 pages and 224 `<xhtml:link>` elements in `sitemap.xml` -- 165 new crawlable
URLs advertising five localised sites. Every claim was false: the alternates
serve the byte-identical English file with an English `<title>` and `<meta
description>`; each one canonicalises away from itself, which is precisely
what Google's rule forbids; the sitemap annotations were not reciprocal; and
the result was 165 duplicate URLs with nothing in `robots.txt` to stop the
crawl.

`?lang=` remains a shareable convenience. It is simply not advertised.
`npm run build-data` strips any `hreflang` tag it finds, and `qa-check.js`
asserts the absence on every page, in the sitemap, and the `Disallow` line in
`robots.txt`. Real multilingual SEO means real per-locale pages
(`/es/shop.html`) with translated titles, self-referential canonicals and
reciprocal sitemap entries -- a separate project that needs ~100% dictionary
coverage first.

## Interface Contracts (translation)

### `assets/js/locales-data.js`
```javascript
window.YL_LOCALES = {
  en: { meta: { code: "en", name: "English", dir: "ltr" }, phrases: { "nav.shop": "Shop", ... } },
  es: { meta: { code: "es", name: "Español", dir: "ltr" }, phrases: { ... } },
  de: { ... }, fr: { ... }, ja: { ... }, zh: { ... }
};

// NOTE the real shape: protectedTerms + categories + rules.
// An earlier draft of this document documented `{ protectedTerms, terms }`,
// which does not exist.
window.YL_BRAND_GLOSSARY = {
  protectedTerms: [ "Y'allternative Living", "Porch Sweep", "Calendula officinalis", ... ], // 58
  categories: { brand: [...], products: [...], bundles: [...], idioms: [...], botanicals: [...] },
  rules: {
    preserveProtectedTerms: true,
    neverTranslateBrandName: true,
    preserveINCI: true,
    preserveProprietaryScents: true,
    preserveFolkloreIdioms: true
  }
};
```

### `assets/js/translator.js` API
```javascript
window.YL_TRANSLATOR = {
  LANGUAGES: [ { code: "en", name: "English" }, ... ],          // 6
  getCurrentLanguage: function() -> string,
  setLanguage: function(langCode) -> Promise<string>,           // invalid code -> "en"
  translateTree: function(rootEl, targetLang) -> void,
  translateNode: function(node, targetLang) -> void,
  isProtectedTerm: function(term) -> boolean,
  lookupPhrase: function(phrase, targetLang) -> string,         // miss returns input unchanged
  lookupByKey: function(key, targetLang) -> string|null,
  getInitialLanguage: function() -> string,                     // ?lang= > localStorage > "en"
  initUI: function() -> void,
  init: function() -> void                                      // idempotent
};
// Dispatches on document: "yl-language-changed", detail { lang, prevLang }
```

## Code Layout (translation)
- `assets/data/locales/{en,es,de,fr,ja,zh}.json`: canonical dictionaries.
- `assets/data/brand-glossary.json`: protected terms, categories, rules.
- `assets/js/locales-data.js`: compiled browser bundle (generated -- do not hand-edit).
- `assets/js/translator.js`: client runtime and selector UI.
- `scripts/translator.test.js`: 10-suite unit gate against the shipped engine.
- `scripts/translator-script-order.browser.test.js`: script-order race regression.
- `scripts/challenger1-translation-adversarial.browser.test.js`: adversarial stress.
- `scripts/translation-privacy-flow.browser.test.js`: network/cookie/offline flow.
