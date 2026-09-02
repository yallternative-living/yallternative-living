# Project: Y'allternative Living Translation Architecture Migration

## Architecture
Migration from legacy third-party Google Translate widget to self-hosted, build-integrated hybrid localization engine:
1. **Build-Time Compilation & SEO (`scripts/build-site-data.js`)**:
   - Canonical JSON dictionaries (`assets/data/locales/*.json`) + Brand Glossary (`assets/data/brand-glossary.json`).
   - Compilation of client data bundle `assets/js/locales-data.js` (`window.YL_LOCALES`, `window.YL_BRAND_GLOSSARY`).
   - Multilingual SEO: `<link rel="alternate" hreflang="...">` injection in all 16 static HTML pages and 19 PDPs in `products/*.html`.
   - Multilingual sitemap: `sitemap.xml` with `xmlns:xhtml="http://www.w3.org/1999/xhtml"` and `<xhtml:link>` elements.
   - Offline precaching in `sw.js` `ASSETS_TO_CACHE` and sha256 cache roll.
2. **Client Runtime Engine (`assets/js/translator.js`)**:
   - Zero external scripts, zero iframes, zero `googtrans` cookies, zero network requests.
   - Fast in-place DOM translation with original text caching (`node.__ylOriginalText`).
   - Dynamic DOM observation (`MutationObserver`) for cart drawer (`#yl-cart-drawer`), search filtering, quiz, and reviews.
   - Preference persistence in `localStorage['yl-lang']` with URL query parameter support (`?lang=xx`).
   - Accessible language selector UI in header with WCAG 2.2 AA compliance and 0 CLS.
3. **Security & Privacy Hardening**:
   - Removal of `translate.google.com`, `translate.googleapis.com`, `translate-pa.googleapis.com` from CSP across `_headers`, `netlify.toml`, `vercel.json` via `scripts/build-security-headers.js`.
   - Removal of legacy Google Translate CSS hacks from `assets/css/styles.css`.
   - Documentation of tracker-free, zero-cookie model in `privacy.html`.
4. **Verification & Quality Gates**:
   - Unit test modernization (`scripts/translator.test.js`, `scripts/main.test.js`, `scripts/service-worker.test.js`).
   - Static QA assertions in `scripts/qa-check.js` (1011 assertions including CSP parity, zero GT artifacts, glossary checks).
   - Headless browser integration tests (`npm run test:integration`).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Canonical Locale Dictionaries | Author complete dictionaries for en, es, de, fr, ja, zh in `assets/data/locales/` | M1 | ORIGINAL_REQUEST §R2 |
| 2 | Brand Glossary Authoring | Define protected brand terms, product titles, Appalachian folklore, Southern idioms in `assets/data/brand-glossary.json` | M1 | ORIGINAL_REQUEST §R2 |
| 3 | Build Pipeline Compilation | Compile `assets/js/locales-data.js` with glossary validation in `scripts/build-site-data.js` | M1 | ORIGINAL_REQUEST §R2 |
| 4 | Multilingual `hreflang` Injection | Inject `<link rel="alternate" hreflang="...">` for 6 locales + x-default on all static pages and PDPs | M1 | ORIGINAL_REQUEST §R2 |
| 5 | Multilingual `sitemap.xml` | Add `xmlns:xhtml` and `<xhtml:link rel="alternate">` entries to `sitemap.xml` | M1 | ORIGINAL_REQUEST §R2 |
| 6 | Service Worker Precache | Add `locales-data.js` to `sw.js` `ASSETS_TO_CACHE` and roll SHA256 cache name | M1 | ORIGINAL_REQUEST §R1 |
| 7 | Retire Google Translate Script | Remove `loadGoogleScript()`, script injection, `#google_translate_element`, `.goog-te-combo` manipulation | M2 | ORIGINAL_REQUEST §R1 |
| 8 | Remove `googtrans` Cookie | Eliminate all `document.cookie = "googtrans=..."` reads and writes | M2 | ORIGINAL_REQUEST §R1 |
| 9 | In-Place DOM Translation Engine | Fast text-node replacement, placeholder/aria-label translation, and glossary protection guard | M2 | ORIGINAL_REQUEST §R1 |
| 10 | Dynamic Mutation Translation | `MutationObserver` handling `#yl-cart-drawer`, product search, quiz, and review elements | M2 | ORIGINAL_REQUEST §R1 |
| 11 | Cookieless Persistence & URL Param | `localStorage['yl-lang']` persistence, `?lang=xx` URL support, custom event `yl-language-changed` | M2 | ORIGINAL_REQUEST §R1 |
| 12 | Accessible Language Switcher UI | WCAG 2.2 AA keyboard-navigable listbox UI in `.nav-cta` with 0 CLS | M2 | ORIGINAL_REQUEST §R1 |
| 13 | CSP De-Google Hardening | Remove Google Translate origins from `scripts/build-security-headers.js` and sync headers | M3 | ORIGINAL_REQUEST §R3 |
| 14 | CSS Legacy Workaround Removal | Delete `.skiptranslate`, `#google_translate_element`, `translated-ltr` overrides from `assets/css/styles.css` | M3 | ORIGINAL_REQUEST §R3 |
| 15 | Privacy Policy Update | Update `privacy.html` to document self-hosted, cookieless translation model | M3 | ORIGINAL_REQUEST §R3 |
| 16 | Unit Test Suite (`translator.test.js`) | Comprehensive 10-suite unit test verifying self-hosted engine, glossary, DOM, fallbacks, 0 cookies, 0 network | M4 | ORIGINAL_REQUEST §R4 |
| 17 | Static QA Gate Alignment | Update `scripts/qa-check.js` to assert zero GT in CSP, zero GT CSS, valid dictionaries, and hreflang tags | M4 | ORIGINAL_REQUEST §R4 |
| 18 | Browser Integration & Quality Gates | Verify full suite pass: `npm run build-data`, `npm test`, `npm run lint`, `npm run format:check`, `npm run test:integration` | M4 | ORIGINAL_REQUEST §R4 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Build-Time Data & SEO | `assets/data/locales/`, `assets/data/brand-glossary.json`, `scripts/build-site-data.js`, `sw.js` | none | DONE |
| M2 | Self-Hosted Translation Engine | `assets/js/translator.js` | M1 | DONE |
| M3 | Security, Privacy & CSS Cleanup | `scripts/build-security-headers.js`, `_headers`, `netlify.toml`, `vercel.json`, `assets/css/styles.css`, `privacy.html` | none | DONE |
| M4 | Test Suite & Quality Gates | `scripts/translator.test.js`, `scripts/main.test.js`, `scripts/qa-check.js`, integration test runs | M1, M2, M3 | DONE |

---

## Interface Contracts
### `assets/js/locales-data.js` (compiled by M1, consumed by M2 & M4)
```javascript
window.YL_LOCALES = {
  en: { meta: { name: "English", code: "en" }, phrases: { ... } },
  es: { meta: { name: "Español", code: "es" }, phrases: { ... } },
  de: { meta: { name: "Deutsch", code: "de" }, phrases: { ... } },
  fr: { meta: { name: "Français", code: "fr" }, phrases: { ... } },
  ja: { meta: { name: "日本語", code: "ja" }, phrases: { ... } },
  zh: { meta: { name: "中文", code: "zh" }, phrases: { ... } }
};
window.YL_BRAND_GLOSSARY = {
  protectedTerms: [ "Y'allternative Living", "Y'allternative", "Porch Sweep", "Cathedral Dust", "Bless Your Heart", "Unbothered", ... ],
  terms: { ... }
};
```

### `assets/js/translator.js` API (implemented by M2, consumed by `main.js`, UI, and tested by M4)
```javascript
window.YL_TRANSLATOR = {
  LANGUAGES: [ { code: 'en', name: 'English' }, ... ],
  getCurrentLanguage: function() -> string,
  setLanguage: function(langCode) -> Promise<string> (or synchronous with event dispatch),
  translateNode: function(node, targetLang) -> void,
  translateTree: function(rootEl, targetLang) -> void,
  isProtectedTerm: function(term) -> boolean,
  init: function() -> void
};
// Dispatches: 'yl-language-changed' with detail: { lang: 'es', prevLang: 'en' }
```

---

## Code Layout
- `assets/data/locales/{en,es,de,fr,ja,zh}.json`: Canonical translation dictionary sources.
- `assets/data/brand-glossary.json`: Immutable protected brand terms & glossary rules.
- `scripts/build-site-data.js`: SSG compiler, glossary validator, hreflang injector, sitemap generator.
- `assets/js/locales-data.js`: Compiled browser bundle for translation dictionaries.
- `assets/js/translator.js`: Self-hosted client translation runtime and UI controller.
- `scripts/build-security-headers.js`: CSP security header synchronization generator.
- `_headers`, `netlify.toml`, `vercel.json`: Byte-identical deployment configuration files.
- `assets/css/styles.css`: Stylesheet with language selector UI and cleaned legacy CSS.
- `privacy.html`: Privacy policy documentation for cookieless translation.
- `scripts/translator.test.js`: Comprehensive 10-suite unit test suite for translation engine.
- `scripts/qa-check.js`: 1011 assertion static QA gate.
