# E2E Test Infra: Translation Architecture Migration

## Test Philosophy
- Opaque-box, requirement-driven verification derived directly from `ORIGINAL_REQUEST.md`.
- Zero tolerance for external network leaks (assert 0 requests to Google Translate origins).
- Zero tolerance for third-party cookie pollution (assert 0 `googtrans` cookies).
- Strict Brand Glossary protection (assert proprietary terms remain uncorrupted).
- 100% passing across all quality gates (`npm test`, `npm run lint`, `npm run format:check`, `npm run test:integration`).

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Locale Dictionaries (6 languages) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | Brand Glossary Protection | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Multilingual SEO (hreflang + sitemap) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 4 | Client Runtime Language Switching | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 5 | Dynamic DOM Translation (Cart/Quiz) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 6 | Cookieless Persistence & URL Param | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 7 | CSP De-Google Hardening | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 8 | Privacy Policy Disclosure | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |

## Test Architecture
- Unit Pool (`scripts/translator.test.js`, `scripts/main.test.js`, `scripts/service-worker.test.js`): Fast Node.js assertions on dictionary structure, DOM tree walking, glossary protection, fallback behavior, offline precaching.
- Static QA Gate (`scripts/qa-check.js`): 720+ static assertions validating CSP byte-parity across `_headers`, `netlify.toml`, `vercel.json`, absence of Google Translate domains, absence of legacy CSS overrides, and presence of valid `hreflang` / `sitemap.xml` entries.
- Headless Browser Suites (`scripts/puppeteer_tests.js`, `scripts/extended_qa_test.js`, `scripts/security_stress_test.js`, `scripts/a11y-check.js`): Headless Puppeteer testing across Desktop (1200x800), Tablet (768x1024), and Mobile (375x667) for UI dropdown interactions, network request monitoring, cookie isolation, and WCAG 2.2 AA accessibility.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Spanish Shopper Journey: User opens site with `?lang=es`, browses shop, filters by "salves", reads reviews, verifies "Porch Sweep" and "Bless Your Heart" brand titles remain protected, opens cart drawer, verifies cart UI in Spanish. | F1, F2, F4, F5, F6 | High |
| 2 | Offline PWA Translation: Service worker caches `locales-data.js`, user simulates offline mode, switches language to French (`fr`), DOM translates immediately without network error. | F1, F4, F6 | Medium |
| 3 | Security & Privacy Audit: Network observer monitors all fetch/XHR/script loads during language switching to German, Japanese, Chinese; verifies 0 requests to `*.google.com`, 0 `googtrans` cookies, and byte-identical CSP headers. | F4, F6, F7, F8 | High |
| 4 | Accessibility & Responsiveness: Automated axe-core scan on open language dropdown across light and dark themes on mobile and desktop; verifies ARIA roles, focus management, 44px touch target, and 0 CLS. | F4, F8 | Medium |
