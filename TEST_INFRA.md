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
    `*.browser.test.js` (42 suites), in a parallel worker pool, then two
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
  `scripts/*.browser.test.js` (16 suites), each on its own port or an ephemeral
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
  - `scripts/text-layout.browser.test.js` (ephemeral port): 20 pages x 6
    viewports (320-1440px), measuring the line boxes of every heading, button
    label, form label and accordion summary. Two gates: no string may be
    clipped by its own box (a hard zero -- `.btn` is `nowrap` + `overflow:
    hidden`, so an over-long label is cut at both ends rather than wrapped),
    and orphaned last lines are held to a measured budget so they cannot creep
    back after the `text-wrap: pretty` fixes.
  - The other `*.browser.test.js` suites: the challenger/adversarial harnesses
    for the PDP sticky bar, ritual cross-sells, search interaction, variant
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

---

# Translation Architecture Migration -- test coverage

Appended. The "What a passing suite has to mean" section above is not
optional context for this feature: an earlier draft of this file deleted those
three rules, and the same commit shipped a suite that violated all three
(`challenger1` Test 2.3 printed two green ticks over an empty string, from
selectors that do not exist in this repository). They are the rules this
section is held to.

## What is asserted, and where

- **`scripts/translator.test.js`** (unit pool, 10 suites). Requires the real
  `assets/js/translator.js` and `assets/js/locales-data.js` -- not a
  re-implementation -- against a mock DOM. Covers selector injection and its
  ARIA contract, the full keyboard flow, dictionary structure (6 locales x 206
  phrases), in-place translation of text nodes / `data-i18n` / `placeholder` /
  `aria-label` / `title`, glossary protection, `MutationObserver` handling,
  event dispatch, persistence and `?lang=`, fallback on an invalid code, and
  the zero-network / zero-cookie invariants. It also pins the language marking:
  `<html lang>` stays `"en"`, only fully translated elements are marked, mixed
  content is left alone, untranslated children under a marked ancestor are
  counter-marked `lang="en"`, and every mark is removed on the way back.

- **`scripts/translator-script-order.browser.test.js`** (integration pool, 20
  assertions). Loads `/?lang=es` with `locales-data.js` held back 1800ms by
  Puppeteer request interception and asserts the nav turns Spanish. Its first
  four assertions are harness controls -- the request was seen, the nav has
  links to assert over, the dictionaries are still in flight at the sample
  point, and the nav is still English at that point -- because an interception
  that silently stopped matching would make every later assertion pass for the
  wrong reason. A second scenario drives the late-`YL_LOCALES` recovery path
  directly. Reverting both halves of the fix turns 20 passed / 0 failed into
  13 passed / 7 failed.

- **`scripts/challenger1-translation-adversarial.browser.test.js`**. 768
  Node-level stress assertions plus a browser half: 18 rapid switches per page
  across three pages with a byte-identical English restoration check; brand
  and INCI preservation on two PDPs, compared by exact occurrence count
  against an asserted English baseline; and the cart drawer built *after* the
  switch to Spanish, so the `MutationObserver` is genuinely under test.

- **`scripts/translation-privacy-flow.browser.test.js`**. Zero requests to any
  Google Translate origin, zero `googtrans` cookies, cross-page persistence,
  `?lang=` initialisation, and a real offline switch through the service
  worker.

- **`scripts/puppeteer_tests.js`** section 10. Selector injection, the ARIA
  contract including `aria-controls` and the language-carrying accessible
  name, click-to-open, switch to Spanish, and clean restoration.

- **`scripts/qa-check.js`** (1008 static assertions total). For this feature:
  CSP three-way byte parity with the Google Translate origins gone, zero
  legacy Google Translate CSS, six valid dictionaries at 206 phrases each, 58
  glossary terms, `locales-data.js` and `translator.js` both precached in
  `sw.js` -- and the inverse SEO assertions: no page carries an `hreflang`
  alternate, `sitemap.xml` has zero `<xhtml:link>` and zero `?lang=`, and
  `robots.txt` carries `Disallow: /*?lang=`.

- **`scripts/a11y-check.js`**. axe-core WCAG 2.2 AA over every page in both
  themes, 0 violations allowed.

- **`scripts/i18n-new-strings.test.js`** (unit pool, 86 assertions). Pins the
  discovery half of the translation pipeline -- see below.

## The translation pipeline, and where the gate is meant to be red

`scripts/i18n-new-strings.js` (`npm run i18n:new`) is step 2 of six. It assumes
the site is already built; it never builds it.

    1. node scripts/build-site-data.js       build the site
    2. npm run i18n:new -- --write           discover, key, record the basis
    3. translate step                        fills es/de/fr/ja/zh (separate)
    4. node scripts/i18n-claims.test.js      claims-drift pins
    5. node scripts/build-site-data.js       the four-rule gate goes green
    6. commit

It drives `scripts/extract-i18n-strings.js --json` in a child process to learn
what the translator can actually reach -- the lookup in `translator.js` is
exact equality on a node's trimmed text, so only a real browser knows what that
text is -- and reports three sets against `assets/data/locales/en.json`:

- **NEW** reachable, not an English value in the dictionary. Keyed
  `auto.<camelSlug>.<6 hex of the sha1 digest>`: content-derived, so the same
  string keys the same way on every run and on every machine. The extractor
  assigns no keys at all, so there was no scheme to inherit.
- **CHANGED** English that no longer matches the digest in
  `assets/data/i18n-translation-basis.json` -- copy edited after it was
  translated, i.e. five stale translations. Uses `build-site-data.js`'s own
  `digestEnglish`, imported rather than reimplemented, so this tool and
  `validateDictionaryCoverage` rule 4 can never disagree.
- **ORPHANED** dictionary keys reachable nowhere: in the render, in the runtime
  manifest, or verbatim in a built page. Reported only. Nothing is ever
  deleted.

Strings that are reachable but not for translating -- product names, INCI
ingredients, verbatim Etsy review text, prices, filled `tpl.*` templates -- are
reported under `skipped` with a reason derived from committed data
(`products.json`, `site-reviews.json`, `brand-glossary.json`), never from a
hand-kept ignore list. Two kinds of genuinely new string are reported but NOT
written: one that only JavaScript renders and that `i18n-runtime-strings.json`
does not declare (it would fail gate rule 1 forever), and one carrying a
data-derived number like "Showing 20 of 20 goods" (a dead key the day the
number moves). Both want a human -- a manifest entry, or a `tpl.*` template.

**Between steps 2 and 3 `npm run build-data` fails, and that is correct.** The
five other locales are deliberately left untouched: this step knows what needs
translating, not what the translation is, and a placeholder would satisfy rule
2 while shipping English-shaped Spanish. Rule 2's message names the new keys
and now says where they came from.

Proof run recorded 2026-09-04 (a temporary product added to
`assets/data/products.json`, built, measured, then reverted): the report gained
exactly two writable entries, the product's blurb and its PDP description,
while its name, its ingredient list, its `Enlarge photo of ...` aria-labels,
its price and its size were all skipped with reasons, and "Showing 21 of 21
goods" was deferred as volatile. `--write` appended exactly those keys to the
end of `en.json` and their digests to the end of the basis, with all 515
existing keys, values, digests and their order untouched. Editing one word of
a product blurb in both `products.json` and `en.json` put that key in CHANGED
with its previous digest, and the build refused with rule 4 naming the same
key.

Two things an unattended run has to know: the PDP countdown renders "1 Day, 08
Hours, 28 Mins", so one string differs between any two runs (it is always
deferred as runtime-only, so it never reaches a file), and the extractor serves
the tree on port 8087 -- the same port `reveal-check.js` uses -- falling back
to an ephemeral one if it is busy. `--base <url>` skips its server entirely and
renders a copy somebody else is already serving.

## What is NOT covered, and why that matters

Naming the gaps is part of the contract; a coverage table with a tick in every
cell is how the last one went wrong.

- **Dictionary coverage itself is not gated.** Nothing asserts that a
  dictionary entry corresponds to any string on any page, which is why 58% of
  entries match nothing and coverage sits at 10-21%. The single assertion that
  would catch it -- "every English dictionary value appears at least once in
  the built site" -- is not written yet.
- **The language selector's contrast is outside the a11y gate.** Its
  `backdrop-filter` makes axe report 7 nodes as `incomplete` for
  `color-contrast`, and the gate fails only on `violations`.
- **RTL is unexercised.** No shipped locale declares `dir: "rtl"`.
- **No cross-browser coverage of translation.** Every translation suite drives
  Puppeteer, i.e. Chromium only; `cross-browser-check.js` does not exercise
  the selector.
- **Worker/checkout strings are not translated and not tested as such.**
