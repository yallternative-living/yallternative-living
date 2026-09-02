# E2E Test Infra: Y'allternative Living E-Commerce Quick Wins Suite

## Test Philosophy
- Opaque-box, requirement-driven testing covering all 5 Quick Wins (R1-R5).
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinations + Real-World Workloads.
- No reliance on internal implementation details; assertions target user-visible DOM, events, JSON-LD schemas, and cart states.

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|----------------------|:-----------------:|:-----------------:|:---------------------:|:-------------------:|
| 1 | R1: Mobile Sticky Add-to-Cart | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | R2: Complete the Ritual Cross-Sells | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 3 | R3: Multi-Tier Shipping & Gift Progress | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 4 | R4: Recently Viewed Products Carousel | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ | ✓ |
| 5 | R5: Google Merchant Rich JSON-LD | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ | ✓ |

R5 note: the Product/Offer payload lives in `shop.html`'s `ItemList`, not on the
19 `products/*.html` pages. Those are `noindex` doorway pages that redirect to
`shop.html#<id>` and carry no JSON-LD at all -- putting rich data on pages that
canonicalise away from themselves produced no rich results and looked like
doorway spam.

## Test Architecture

Every suite is named for the pool it belongs to. `*.browser.test.js` drives a
real Chromium (Puppeteer) or all three Playwright engines; everything else is
Node-only. The naming is the contract the runners glob on, and it is why the CI
`qa` job can set `PUPPETEER_SKIP_DOWNLOAD` and still pass.

- **Unit pool** -- `npm test` -> `scripts/run-test.js`, which runs BOTH of:
  - `scripts/run-unit-tests.js`: every `scripts/*.test.js` that is not
    `*.browser.test.js` (27 suites), in a parallel worker pool, then two
    Node-only gates sequentially: `verify-pdp-metadata.js` (570 assertions on
    PDP OpenGraph/microdata) and `verify-build-reproducibility.js` (rebuilds
    the site five times and diffs every generated file).
  - `scripts/qa-check.js`: 721 static assertions -- links, images, JSON-LD,
    pricing, CSP parity across `_headers`/`netlify.toml`/`vercel.json`,
    lockfile hygiene, markup contracts.

  The two run independently and `npm test` exits non-zero if either fails. It
  used to be `unit && qa-check`, so one broken unit suite meant the static gate
  never ran at all.

- **Integration pool** -- `npm run test:integration` ->
  `scripts/run-integration-tests.js`: a fixed list of browser gates plus every
  `scripts/*.browser.test.js` (11 suites), each on its own port or an ephemeral
  one, in a worker pool. A suite on the fixed list that has gone missing is a
  hard failure, not a silent skip.
  - `scripts/puppeteer_tests.js` (8082): multi-viewport nav, link integrity,
    cart drawer, reviews filter, quiz, order status, global search.
  - `scripts/extended_qa_test.js` (8083): wishlist state, cart money math,
    site-wide link crawl, shipped bug-fix regressions.
  - `scripts/a11y-check.js` (8084): axe-core WCAG 2.2 AA on every page,
    0 violations allowed.
  - `scripts/test-m2-ugc-strip.js` (8085), `scripts/security_stress_test.js`
    (8086, XSS payloads under the real site CSP with a positive control that
    proves the policy is enforced), `scripts/reveal-check.js` (8087).
  - The `*.browser.test.js` suites: the challenger/adversarial harnesses for
    the PDP sticky bar, ritual cross-sells, search interaction, variant
    pickers, the journal, and the M1-M4 milestone stress runs.

- **Smoke gate** -- `npm run test:smoke` -> `scripts/smoke-test.js`: four
  stages in under three seconds, run on every CI push.

- **Cross-browser gate** -- `npm run test:cross-browser` ->
  `scripts/cross-browser-check.js`: Playwright across Chromium, Firefox,
  WebKit, Mobile Safari and Mobile Chrome.

- **CI** -- `.github/workflows/test.yml`. The `qa` job runs lint, format,
  smoke and `npm test`. The `browser` job installs the three Playwright
  engines and runs the integration and cross-browser gates; it runs on `main`
  and whenever the `core` paths filter matches, which includes `assets/data/**`
  and `admin/**` because a data or CMS change regenerates the pages the browser
  gates check.

## Coverage Goals
- Tier 1: >= 5 test cases per feature (Total >= 25)
- Tier 2: >= 5 boundary/corner test cases per feature (Total >= 25)
- Tier 3: Pairwise feature combination tests (Total >= 5)
- Tier 4: Realistic end-to-end shopping workflows (Total >= 5)

## What a passing suite has to mean

A test that cannot fail is worse than no test: it argues against fixing the bug
it should have caught. Three rules, each written after a real instance in this
repository:

- **Assert a count before asserting over a collection.** `[].every(...)` is
  true and `[].forEach(...)` asserts nothing, so a page that rendered none of
  the thing under test used to pass.
- **Never make an absent subject a pass.** `if (el) { ...assert... }` with no
  `else` turns a deleted element into a green run. Every such block now names
  the missing selector and fails.
- **Test against the shipped code, not a copy of it.** A suite that
  re-implements the engine it is testing, or requires it in a try/catch and
  skips when it is missing, reports only on itself.
