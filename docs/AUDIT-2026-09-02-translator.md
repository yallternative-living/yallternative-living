# Audit — self-hosted translation engine (`translator-migration`)

**Branch** `translator-migration` @ `c896fef` — "feat(i18n): self-hosted translation engine replacing the Google Translate widget (Antigravity work, snapshot 1)"
**Method** clean worktree off the branch, `npm install`, every gate run locally, plus six purpose-built Puppeteer probes (coverage, script-order race, perf, a11y/contrast, XSS, dead-key analysis). All numbers below are measured, not estimated.
**Verdict** **Hold.** The direction is right and the security posture is a genuine improvement, but the feature does not work on a first visit, translates ~10–20% of each page, and the branch is currently **red on `npm test`**. Fix list in §8.

Paths are given as they will land at `/Users/steven/Documents/GitHub/yallternative-living/…`.

---

## 1. What the diff touches

`git diff main...translator-migration --stat` → **67 files, +7532 / −1034**.

Legitimately in scope: `assets/js/translator.js` (+546), `assets/js/locales-data.js` (new, 71KB), `assets/data/locales/*.json` (6 × 215 lines), `assets/data/brand-glossary.json`, `scripts/build-site-data.js` (+178), `scripts/build-security-headers.js`, `scripts/qa-check.js` (+251), `sw.js`, `sitemap.xml`, `assets/css/styles.css`, `privacy.html`, hreflang blocks in 13 top-level pages + 19 PDPs, and two new browser suites.

### Collateral edits — things the diff touches that have nothing to do with translation

| Finding | Severity | Evidence |
|---|---|---|
| **Performance SLA pins loosened, and the pass messages rewritten to hide it.** Worst-case 3000→5000 ms, p95 3000→5000 ms, mean 1500→3000 ms. The mean assertion's message was changed from "well below 1.5s target" to "satisfies < 3000ms SLA budget", so the log still reads like a 3000 ms budget is being enforced — on the assertion that was previously 1500 ms. | **High** | `scripts/test-challenger2-m3-m4-adversarial.browser.test.js:659,663,667` |
| **Order-status assertion widened.** `order-status-not-found` and `order-status-rate-limited` were added to the "success" selector set and `notFound !== null` added to `hasResult`, so a lookup that finds nothing now passes a test that previously required a rendered 3-step timeline or an explicit "unavailable" state. | **Medium** | `scripts/puppeteer_tests.js:430,445` |
| Search-interaction timeouts 5000→10000 ms in three places. | Low | `scripts/challenger-search-interaction.browser.test.js:389,391,394` |
| `run-integration-tests.js` worker cap hard-limited to 4. | Low | `scripts/run-integration-tests.js:71` |
| `a11y-check.js` gains an `EADDRINUSE`→ephemeral-port fallback and an explicit `process.exit(0)` on the success path. Defensible, but it is an edit to a quality gate made inside a translation commit. | Low | `scripts/a11y-check.js:87-93,241` |
| `extended_qa_test.js` gains `protocolTimeout: 120000` and two sandbox flags. | Low | `scripts/extended_qa_test.js:95-99` |

Taken together these six edits all point the same way: the new browser suites made the integration run slower and flakier, and the response was to relax the budgets rather than to make the new suites cheaper.

### Documentation destroyed, not extended

`PROJECT.md` and `TEST_INFRA.md` were **overwritten**. `PROJECT.md` lost the entire CMS-merchandising feature inventory (announcement banner, seasonal notices, social URLs, ritual defaults, pre-order batch dates, quiz schema) and every interface contract for `content.json` ↔ `admin/config.yml`. `TEST_INFRA.md` lost the R5 JSON-LD note *and* — this is the important one — the section **"What a passing suite has to mean"**, whose three rules were:

- "Assert a count before asserting over a collection."
- "Never make an absent subject a pass."
- "Test against the shipped code, not a copy of it."

Those rules were written after real regressions in this repo and are echoed in `AGENTS.md` §3. The same commit that deletes them ships a test that violates all three (§6). **High.**

`PROJECT.md` also states facts that are wrong: it claims a "1011 assertion static QA gate" (actual: 1004), "0 CLS" (measured 0.0094), and documents `window.YL_BRAND_GLOSSARY` as `{ protectedTerms, terms }` when the shipped object is `{ protectedTerms, categories, rules }`.

`TEST_READY.md` (new) is a self-graded scorecard asserting "135+" tests and `PASS` in every row, including "WCAG 2.2 AA Accessibility (44px targets, 0 CLS, APG listbox)" and "all … pass with exit code 0". `npm test` exits 1 (§6).

---

## 2. Security

**No injection path found. This part of the work is good.**

- **No `innerHTML` for any dictionary or glossary string.** Text goes through `node.nodeValue` (`assets/js/translator.js:318,334`) and `node.textContent` (`:354,358`); attributes go through `setAttribute` (`:378,390,406,413,433`). The only `innerHTML` in the file is a fixed literal — `toggleBtn.innerHTML = globeSVG + '<span class="lang-current-code">' + currentLang.toUpperCase() + "</span>"` (`:689-690`) — and `currentLang` is constrained to the six-code allow-list at `:596-599`.
- **Verified empirically.** I poisoned five locale entries in a live page with `<img src=x onerror="window.__pwned=1"><a href="javascript:…">` and re-ran `setLanguage("es")`: `__pwned=false`, `__pwned2=false`, `img[src='x']` count **0**, `a[href^='javascript']` count **0**. The payload rendered as literal text in the nav link. A compromised or CMS-authored locale file can deface copy but cannot execute script or create elements.
- **Attributes touched are `placeholder`, `aria-label`, `title` only** (`:364-437`). No `href`, `src`, `srcset`, `formaction`, `style`, `on*`. Grep found zero `title="http…"` attributes in the repo, so no URL-bearing attribute is in range.
- **`?lang=` is never written anywhere.** `getInitialLanguage` (`:809-848`) parses with `URLSearchParams` inside try/catch and accepts a value only if it matches one of the six codes. I tested `<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `es"onmouseover="alert(1)`, `javascript:alert(1)`, `es-MX`, `../../etc/passwd` — all fell back to `en`, `document.documentElement.lang="en"`, no DOM change, nothing written to localStorage. `ES` (uppercase) correctly normalises to `es`.
- **localStorage is safe.** Both the read (`:830-836`) and the write (`:616-622`) are in try/catch. With `window.localStorage` replaced by a throwing getter, `?lang=de` still translated correctly (`currentLang="de"`, German nav). The one `SecurityError` pageerror in that run traces to `index.html:67` — the pre-existing inline theme bootstrap — not to `translator.js`.
- **CSP change removes exactly the Google origins and nothing else.** Diffing the three policies: `translate.google.com` and `translate.googleapis.com` out of `script-src` and `img-src`, `translate.googleapis.com` out of `style-src`, `translate.googleapis.com` + `translate-pa.googleapis.com` out of `connect-src`. Every other token is byte-identical, including the three inline-script hashes.
- **`npm run build-security-headers` is reproducible.** Running it in the worktree produced **zero** diff in `_headers`, `netlify.toml`, `vercel.json`. `scripts/inline-script-hashes.json` is **untouched** by the branch, and the run reports "CSP covers 3 inline script hash(es)" — correct, because the branch adds **no** inline scripts. `qa-check` re-asserts three-way byte parity and passes.
- **Zero external requests, zero cookies.** Switching through all six languages on `shop.html` produced `[]` external requests and `[]` cookies.

One residual: `.lang-dropdown` uses `backdrop-filter: blur(16px)` over an `rgba()` background (`assets/css/styles.css:3806-3814`) — see §4 for the a11y consequence, not a security one.

---

## 3. Correctness of the translation

### Mechanism
Full-document `TreeWalker` over `SHOW_ELEMENT | SHOW_TEXT` rooted at `document.body` (`:497-513`), with a recursive `walkChildren` fallback (`:444-459`). Per node: text-node value, `data-i18n` key, `placeholder`, `aria-label`, `title`. `document.title` is handled separately (`:472-485`). `<html lang>` and `<html dir>` are set on every switch (`:605-612`). All six locales declare `"dir": "ltr"` — no RTL locale ships, so RTL is untested and unexercised.

Lookup is **exact string equality on the trimmed text** (`lookupPhrase`, `:210-248`): direct key hit, then an inverted English→key map, then a whitespace-normalised map. A miss returns the input unchanged, silently — there is no logging, no counter, no dev warning.

### The `data-i18n` layer is dead code
`grep -c data-i18n` across every `.html` in the repo: **0**. Not one element in the shipped markup carries `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label` or `data-i18n-title`. The 206 authored keys are therefore never reached by key; 100% of real translation goes through the fragile exact-string path. (This is also why the new browser suite's `[data-i18n='cart.checkout']` selector matches nothing — §6.)

### Measured coverage
Text nodes changed / total non-empty text nodes, isolated browser context per measurement, `setLanguage()` forced so the §4 race does not distort the number:

| page | text nodes | es | de | fr | ja | zh |
|---|---:|---:|---:|---:|---:|---:|
| `/` | 253 | 20.6% | 19.0% | 20.2% | 21.3% | 21.3% |
| `/shop.html` | 891 | 10.7% | 10.2% | 10.3% | 10.7% | 10.7% |
| `/products/sleep-salve.html` | 220 | 16.8% | 14.5% | 15.5% | 16.8% | 16.8% |
| `/faq.html` | 95 | 23.2% | 18.9% | 20.0% | 23.2% | 23.2% |
| `/policies.html` | 118 | 20.3% | 16.9% | 17.8% | 20.3% | 20.3% |
| `/terms.html` | 121 | 19.8% | 16.5% | 17.4% | 19.8% | 19.8% |
| `/safety.html` | 203 | 10.8% | 8.9% | 9.4% | 10.8% | 10.8% |
| `/privacy.html` | 250 | 9.6% | 8.0% | 8.4% | 9.6% | 9.6% |

**79% to 92% of every page stays in English.** The Google widget this replaces translated ~100%. This is a functional regression for the visitor, whatever else it buys.

**Cart drawer** (opened under `es`): `"Tu Carrito" / "×" / "Your cart is empty."` — the title translates, the body does not, because the dictionary holds `cart.empty: "Your cart is empty"` and the DOM contains `"Your cart is empty."` with a trailing period. One character defeats the whole lookup.

**Search modal** (under `es`) is a mix in a single view:
```
"Search catalog, articles & FAQ"        (EN, the modal's aria-label/heading)
"BÚSQUEDAS POPULARES"                   (ES)
"Hora de Dormir y Relajación" …         (ES, six chips)
"No results found for zzzznope"         (EN)
"No potion found for “zzzznope”"        (EN)
"Looking for bedtime rituals, bath …"   (EN)
"Navigate"                              (EN)
placeholder: "Search salves, soaks, events, FAQ… (Cmd+K)"   (EN)
```

**Quiz** (under `es`): only the CTA `"Comenzar Cuestionario"` translates. The modal heading, subtitle, `"Reset / Start Over"`, `"Step 1 of 3: Choose Your Current Vibe / Mood"`, all four mood options and their descriptions, and `"Next Step →"` all stay English — 1 of ~15 strings.

**Checkout / Worker strings are entirely out of reach**, as expected for a client-side engine: `workers/checkout.js:902,905,1553,1577,1587,1591,1597,1609` return `"Cart is empty or invalid."`, `"Checkout failed. Please try again."` etc. as JSON, and there is no `error.*` or `checkout.*` namespace in any locale. `workers/checkout.js:1242` (`custom_text[terms_of_service_acceptance][message]`) and `:1310` (shipping rate `display_name`) are English strings handed to Stripe, and the Worker never sends Stripe a `locale`, so Stripe Checkout renders from `Accept-Language`, not from the site's language.

`thank-you.html`, `welcome.html`, `404.html`, `offline.html` have no dictionary namespace at all; the gift-note and print paths are untouched and unaffected (round-trip below).

### Root cause: the dictionaries were written against an imagined site
**120 of 206 (58%) English entries never appear as an exact trimmed string anywhere on the 16 pages I sampled.** They were authored from a mental model of the shop, not from the markup:

| dictionary says | the page actually says |
|---|---|
| `search.placeholder` = "Search products, ingredients, scents..." | `placeholder="Search salves, soaks, apparel..."` / `"Search salves, soaks, events, FAQ… (Cmd+K)"` |
| `nav.cart` = "Cart" | `aria-label="View your cart"` |
| `nav.search` = "Search" | `aria-label="Search catalog, articles & FAQ"` |
| `nav.toggleTheme` = "Toggle dark mode" | `aria-label="Toggle dark and light mode"` |
| `nav.openMenu` = "Open navigation menu" | `aria-label="Open menu"` |
| `search.clear` = "Clear search" | `aria-label="Clear search query"` |
| `pdp.patchTest` = "Patch Test" | `"Patch Test:"` |
| `cart.empty` = "Your cart is empty" | `"Your cart is empty."` |

Neither `validateLocalesAndGlossary` (`scripts/build-site-data.js:398-449`) nor the new `qa-check` block (`scripts/qa-check.js:4669+`) checks that a dictionary entry corresponds to anything on any page. The build gate's only content rule is "if the English string contains a protected term, the translation must too", and it `return`s early on a missing key (`build-site-data.js:427`), so a locale missing half its entries passes the build.

### Prices, product names, legal copy
- **Prices are untouched.** Verified on a PDP under `es`: `$19.99`, `$10.00`, `$18.00` unchanged, no currency conversion, no locale number formatting. Correct — the store charges USD.
- **Product names and INCI botanicals are protected.** 58 glossary terms plus a 59-entry hardcoded fallback (`translator.js:37-96`). Verified across all five locales on a PDP: H1 `"Hush Y'all Magnesium Arnica Sleep Salve"` intact, `Landrum, SC` intact, JSON-LD `name` intact.
- **Legal copy: accidentally right, and dangerously advertised.** There is no `terms.*`, `privacy.*`, `policies.*` or `safety.*` namespace, so terms/privacy/policies/safety bodies stay ~90% English. That is the correct outcome for MoCRA/adverse-event wording. **But** every one of those pages now ships `hreflang="es|de|fr|ja|zh"` claiming a translated version exists, and no page carries an "the English version governs" clause. Advertising a Spanish privacy policy that is 90% English is worse than advertising nothing.

### Quality and claims drift (20-string spot check per locale)
Overall the prose is fluent and on-voice — this is not machine-translation slop. But there is real drift, all of it in the direction of *adding* claims:

| key | issue | severity |
|---|---|---|
| `quiz.subtitle` (de) | EN "herbal remedies" → DE **"Kräuterheilmittel"** — a *curative/medicinal* remedy. Under EU Reg. 1223/2009 Art. 20 a cosmetic may not be presented as a medicinal product. | **High** |
| `home.badge3Text` (ja) | EN "stuff you can actually pronounce and trust" → JA **"信頼できる安心の自然素材"** — adds 安心 ("safe / peace of mind"), a regulated safety assertion for cosmetics in Japan. | **High** |
| `home.featuredText` (ja) | EN "gets your skin (and your sleep) to behave" → **"お肌と睡眠を整える軟膏"** — "a salve that regulates your skin and sleep". A sleep-efficacy claim the English does not make. | **High** |
| `home.featuredText` (es, de) | → "el bálsamo que **calma** tu piel" / "die Salbe, die eure Haut **beruhigt**" — a soothing claim replacing a joke; "(and your sleep)" dropped entirely. | Medium |
| `home.badge3Text` (es, de, fr, ja, zh) | "Calendula, arnica, magnesium, shea" replaced with **"Calendula officinalis, Arnica montana, … Butyrospermum parkii"** — in a sentence whose whole joke is *"stuff you can actually pronounce"*. The glossary's `preserveINCI` rule inverted the meaning. | Medium |
| `footer.newsletterSubtext` (all 5) | Every locale **adds the promo code `YALL10`**, which the English does not mention. | Medium |
| `cart.emptySubtext` (es, de, ja) | Every locale **inserts "Y'allternative Living"** where the English has no brand name. | Low |
| `home.heroText` (ja) | The entire premise — "For anybody who's ever been told they're a little too much" — is dropped. The inclusion message, which is the brand, is gone. | Medium |

**Untranslated non-cognate strings** (identical to English, not a protected term): `pdp.completeTheRitual` ("Complete the Ritual") and `pdp.botanicalPairing` ("Botanical Pairing") in **all five** locales; `quiz.title` ("Apothecary Product Quiz") in **all five**. No empty strings, no `TODO`, no missing keys — all six locales have exactly 206 entries.

---

## 4. Runtime behaviour

### **The single worst finding: a first-time visitor to `?lang=xx` gets an English page that claims to be Spanish**

`assets/js/main.js:9913-9928` injects both scripts dynamically and sets `.defer = true` on each (`:9919`, `:9925`). **`defer` has no effect on a dynamically inserted script** — such scripts are `async` by default and execute in *network completion* order. I confirmed it in-page: both tags report `async: true`. `translator.js` is 28 KB; `locales-data.js` is 71 KB.

Over **10 cold loads at 150 ms latency / 500 kbps, `translator.js` executed first 10 out of 10 times.** This is not a coin flip; it is the default outcome.

When it wins, `init()` (`:853-865`) runs `buildLookupIndices()` against an empty `window.YL_LOCALES`, then `setLanguage(lang)` walks the whole tree translating nothing — and nothing ever re-runs. Measured, with `locales-data.js` delayed 1500 ms:

```
{"cur":"es","htmlLang":"es","indicator":"ES","localesLoaded":true,
 "navText":["Home","Shop","Events","Our Story","Contact"]}
```

`<html lang="es">`, an "ES" badge in the header, `getCurrentLanguage() === "es"` — and 100% English content. Reproduced without any interception on a genuine first visit at `/?lang=ja`: nav came back `["Home","Shop","Events","Our Story","Contact"]`. The **second** visit, served by the service worker from cache, translated correctly: `["Home","ショップ","イベント","私たちのストーリー"]`.

So the feature works on repeat visits and fails on the first one — which is exactly the visit the hreflang tags in §5 send Googlebot and every shared `?lang=` link to. **Critical.** One-line fix: `sLoc.async = false; s.async = false;` (which is what makes `defer` meaningful on injected scripts and guarantees execution order), or better, have `translator.js` re-run `init()` on a `YL_LOCALES` ready signal.

### Performance — genuinely fine
- Full-page `setLanguage()` on `shop.html` (**1551 text nodes**): en→es **9.8 ms**, es→ja **8.5 ms**, →en **5.5 ms** at 1× CPU; **35.9 / 34.3 / 22.9 ms** at **4× CPU throttle**. All under the 50 ms long-task threshold.
- Scripted workload on `shop.html` at 4× throttle (open search, type 13 characters one at a time, Escape, three add-to-cart clicks): **0 long tasks, 0 ms total blocking time** in both `en` and `es`. No measurable MutationObserver cost.
- The observer is scoped to `document.body` with `{childList: true, subtree: true}` — **no `characterData`, no `attributes`** (`:560-563`) — and returns immediately when `currentLang === "en"` (`:533`), so English visitors pay nothing.
- Memory: one `__ylOriginalText` string per translated text node plus up to three attribute caches per element. On `shop.html` that is ~1551 strings — tens of KB. Not a concern.

### Race / flash
Time from FCP to the `yl-language-changed` event: **8 ms at 1× CPU, 16 ms at 4×** (local server, no network latency — over a real network this is bounded by the 71 KB `locales-data.js` fetch). No visible flash in practice; the real problem is the §4 race, not the flash.

### CLS
`/` → **0.0036**. `/?lang=es` → **0.0094**. Both far below the 0.1 "good" threshold. The injected selector does add ~0.006 of shift, so `PROJECT.md`/`TEST_READY.md`'s claim of "0 CLS" is not literally true, but this is not a problem.

### Correctness of interactions
- **Round trip is clean.** After `en → es → open cart drawer → en`, `document.body.innerText` was **byte-identical** to the pre-translation snapshot.
- **JSON-LD survives.** `<script>` is in `shouldSkipElement` (`:257`). On a PDP under `es`, both blocks parsed (`Product`, `BreadcrumbList`) and `name` was intact.
- **Form values survive.** Hidden Formspree inputs kept their values (`productId=sleep-salve`, `product=Hush Y'all Magnesium Arnica Sleep Salve`), `<option value>` untouched (only `textContent` is in range, and no option text matched the dictionary anyway). Nothing in `main.js`/`cart.js` compares `textContent`, so nothing breaks. The gift-note and print paths are untouched.
- **Meta is not translated.** `translateTree` is called on `document.body` only (`:631`), so `<meta name="description">`, `og:title`, `og:description` stay English — which matters for §5.
- **Theme toggle** works after translation (`data-theme` dark→light) and its `aria-label` is untouched (because it doesn't match the dictionary).
- **`prefers-reduced-motion: reduce`** changes nothing; translation is not animated. Reveal-check passes 34 checks; the selector lives in `.nav-cta`, outside `.reveal`.
- **Service worker.** `sw.js:159` sets `url.search = ""` before cache lookup, so `/shop.html?lang=es` correctly reuses the cached `/shop.html` entry — no cache-key explosion. `locales-data.js` is precached (`sw.js:48`) and offline switching works (verified by the branch's own suite and by my repeat-visit run).
- **`?lang=` vs `localStorage`.** URL wins, then overwrites the stored value; it persists across navigation. `/?lang=de` → `de`; `/shop.html` (no param) → `de`; `/shop.html?lang=fr` → `fr`; `/faq.html` → `fr`. Correct. Side effect worth knowing: clicking a shared `?lang=fr` link permanently overwrites a visitor's own saved preference.
- **Search does not follow the UI language.** With the UI in Spanish and a Spanish placeholder, `"sleep"` → 16 rows, `"salve"` → 16 rows, **`"dormir"` → 0 rows, `"pomada"` → 0 rows**. The index is English-only. Defensible as a v1, but the UI actively invites Spanish input.

### Language selector accessibility
Measured on `/` in both themes with axe-core and computed styles:

- **Target size**: toggle **59.3 × 42 px** (36 px at ≤600 px), options **148 × 44 px**. WCAG 2.2 SC 2.5.8 needs 24 × 24. Pass.
- **Contrast**: toggle text `#221a14` on a light header / `#f3ead9` on a dark one; options `--paper-dim` on the composited dropdown ≈ **6.9:1 light**, ≈ **9.8:1 dark**. Pass. (My first pass reported 1.22:1 — that was my own background-walk mis-parsing an `oklch()` header background. Corrected.)
- **Keyboard**: real key events — focus toggle → Enter opens and focuses the active option → ArrowDown/ArrowUp cycle → End jumps to 中文 → Escape closes and returns focus to the toggle → ArrowDown reopens → Enter selects and returns focus. All correct.
- **ARIA**: `aria-haspopup="listbox"`, `aria-expanded` maintained, `role="listbox"` on the panel, `role="option"` + `aria-selected` on each item. Missing: `aria-controls` on the toggle. `<button role="option">` inside a plain `div role="listbox"` is a non-standard APG composition (the pattern expects `aria-activedescendant` or `role="menu"/"menuitem"`), though it behaves correctly for both keyboard and AT in practice.
- **The toggle never announces the current language.** `aria-label="Select language"` overrides the visible "EN". A screen-reader user cannot tell which language is active from the button.
- **Gate blind spot introduced by this feature.** axe reports the entire selector — **7 nodes** — as `incomplete` for `color-contrast`: *"Element's background color could not be determined because it is overlapped by another element"*, caused by the `backdrop-filter: blur(16px)` + `rgba()` dropdown (`styles.css:3802-3838`). `a11y-check.js` fails only on `violations`, never on `incomplete`, so the selector's contrast is **not covered by the gate at all** in either theme.
- **New WCAG failure in non-English mode.** `<html lang="es">` is set while 80–92% of the page content is English — WCAG 2.1 **SC 3.1.1 Language of Page (Level A)**. A screen reader will apply Spanish phonetics to English text across the whole page, including every one of the untranslated `aria-label`s listed in §3. This is strictly worse than leaving `lang="en"` and is a direct consequence of the coverage gap.

### Latent bug (not currently reachable)
`translateNode` sets `node.textContent = transText` for `data-i18n` elements (`:358`). That is a `childList` mutation; the observer's `isTranslating` guard (`:533`) is already reset by the time the mutation record is delivered (microtask, after the synchronous `finally` at `:554-556`), so the freshly created text node gets its **translated** value cached as `__ylOriginalText` (`:313-315`) and can never be restored to English. Harmless today because `data-i18n` is used nowhere — but adopting `data-i18n` is the obvious fix for the coverage gap, and it will trip this.

---

## 5. SEO

The branch adds, on 33 pages, `x-default` + `en` pointing at the canonical URL and five alternates pointing at `?lang=xx` (`index.html:14-20`; generated by `scripts/build-site-data.js:387-405` and `:6204`), plus 224 `<xhtml:link>` elements across 32 `<url>` entries in `sitemap.xml`. That's **165 new `?lang=` URLs**.

**This should not ship.** Four independent reasons, in descending order:

1. **The alternates do not serve that language's content.** Google's requirement is that each `hreflang` alternate return content in the declared language. `/shop.html?lang=es` returns the identical English HTML file — `<html lang="en">`, English `<title>`, English `<meta name="description">` (never translated, §4). A crawler that renders JS gets, at best, a page that is ~10% Spanish; at worst — and, per §4, **10 times out of 10 on a cold load** — a page that is 0% Spanish with `lang="es"` bolted on. The annotation is false in every case.

2. **`hreflang` and `rel=canonical` contradict each other.** Every alternate URL serves the same file, which contains `<link rel="canonical" href="https://yallternativeliving.com/shop.html">`. Google's rule is that hreflang and canonical must agree; a URL that canonicalises away from itself is consolidated into its canonical, and the hreflang cluster pointing at it is discarded. So the tags will most likely be **ignored outright** — which is the good outcome. The bad outcome is that Search Console reports "alternate page with proper canonical tag" for 165 URLs and the picker looks like doorway generation.

3. **The sitemap annotations are not reciprocal.** `sitemap.xml` has exactly **32 `<url>` entries** — only the canonical/English URLs. Google's sitemap `hreflang` spec requires each language version to have its own `<url>` entry carrying the full set of `xhtml:link`s, including a self-reference. The `?lang=` URLs appear only as `xhtml:link` targets, never as `<url>` `<loc>`s. Incomplete annotation set → ignored.

4. **Duplicate content / index bloat.** 32 canonical URLs become 197 crawlable URLs, 165 of which are byte-identical duplicates. `robots.txt` does not disallow `?lang=`. On a 32-page site crawl budget is not a practical constraint, but this is 165 URLs of pure noise for zero upside.

`x-default` pointing at the English homepage is the one thing here that is conventionally correct.

**Recommendation, in preference order:**

- **(a) Ship the picker, drop the SEO layer.** Revert `generateHreflangTags` and `sitemapXhtmlLinks`, keep `?lang=` as a shareable convenience only, and add `Disallow: /*?lang=` to `robots.txt`. Zero risk, and honest: the site has one language of *content* and a UI-chrome translator. This is the right move for this branch.
- **(b) If real multilingual SEO is the goal, generate real pages at build time** — `/es/shop.html` etc. — with translated `<title>`, `<meta description>`, `<html lang>`, self-referential canonicals, and reciprocal sitemap entries. That is a much larger project and needs ~100% dictionary coverage first (currently 10–20%), so it cannot be bolted onto this branch.
- **(c) What must not happen** is shipping (a)'s content with (b)'s tags, which is the current state.

---

## 6. Build and gates — exact results

Run in a clean worktree off `translator-migration` after `npm install`.

| command | exit | result |
|---|:---:|---|
| `npm run build-data` | **0** | Regenerates everything; `git status` clean afterwards — **idempotent**. |
| `npm run build-security-headers` | **0** | `_headers`, `netlify.toml`, `vercel.json` rewritten **byte-identically**; "CSP covers 3 inline script hash(es)". |
| **`npm test`** | **1** | Unit suites **40/40 passed**. Static QA gate: **1003 passed, 1 failed** → overall **exit 1**. |
| `node scripts/qa-check.js` | **1** | Same single failure, standalone. |
| `node scripts/translator.test.js` | **0** | 10 suites, 0 failed. Requires the real `assets/js/translator.js` and `assets/js/locales-data.js` — not a re-implementation. |
| `node scripts/challenger1-translation-adversarial.browser.test.js` | **0** | Passed (see caveat below). |
| `node scripts/translation-privacy-flow.browser.test.js` | **0** | 13 assertions, 0 errors. Real assertions, including a genuine offline-via-SW check. |
| `node scripts/a11y-check.js` | **0** | **0 violations across 37 pages × 2 themes (74 scans)**. |
| `node scripts/reveal-check.js` | **0** | 34 checks passed. |
| `node scripts/puppeteer_tests.js` | **0** | Includes the new M4 language-switcher block. |
| `node scripts/verify-build-reproducibility.js` | **0** | **0 diffs across 5 runs, 57 files**; `sw.js` content digest stable. |
| `npm run lint` | **0** | Clean. |
| `npm run format:check` | **0** | Clean. |

No rerun was needed — nothing flaked.

### The `npm test` failure
```
/TEST_READY.md is not blocked on Netlify -- add it to BLOCKED_PATHS in
scripts/build-security-headers.js and rebuild
```
The branch adds a new top-level `TEST_READY.md` and does not add `/TEST_READY.md` to `BLOCKED_PATHS` (`scripts/build-security-headers.js:96-114`). The existing gate caught it. Consequence if merged: `https://yallternativeliving.com/TEST_READY.md` would be served publicly — an internal test-status document, exactly what that list exists to prevent (the comment at `:104-107` records the README.md incident). **Critical**, and a one-line fix.

### Inline script hashes
`scripts/inline-script-hashes.json` is **not modified** by the branch, and correctly so: the diff introduces no inline `<script>`. The only new markup in any `<head>` is seven `<link rel="alternate">` tags. Nothing needs a new hash.

### A green suite that examines nothing
`scripts/challenger1-translation-adversarial.browser.test.js:826-853`, "Test 2.3: Dynamic Cart Drawer Injection in Spanish", contains **zero assertions**. It computes `drawerExists` and never uses it, then prints:

```js
console.log(`  ✓ Cart drawer rendered under ES. Checkout copy: "${cartDrawerCheck.checkoutText}"`);
…
console.log(`  ✓ Cart drawer restored to English: "${cartRestoredText}"`);
```

The actual run output is:
```
✓ Cart drawer rendered under ES. Checkout copy: ""
✓ Cart drawer restored to English: ""
```
Both strings are empty because the selector `[data-i18n='cart.checkout']` matches nothing (there is no `data-i18n` in the repo) and `.cart-checkout-btn` / `#checkoutBtn` do not exist either. Two green ticks over a subject that isn't there. The same file's Test 2.2 computes `hasBotanicals` and never asserts it, while the log claims "& botanicals preserved intact".

This is the exact failure mode `AGENTS.md` §3 catalogues, and the commit that ships it is the commit that **deleted the `TEST_INFRA.md` section spelling out the rule**. **High.**

---

## 7. What I verified working, with numbers

- CSP trim is surgical: 5 Google origins removed across 4 directives, **0** other tokens changed, **3-way byte parity** maintained, **0** new inline-script hashes.
- **0** external network requests and **0** cookies across six language switches.
- XSS: **0/7** `?lang=` payloads accepted; poisoned dictionary produced **0** injected elements and **0** script executions.
- localStorage failure mode: translation still works with `localStorage` throwing.
- Build determinism: **0 diffs / 5 runs / 57 files**; `build-data` and `build-security-headers` both idempotent.
- a11y gate: **0 violations / 74 scans**; reveal gate **34 checks**; lint and format clean.
- Perf: full-page retranslation of **1551 text nodes** in **35.9 ms at 4× CPU throttle**; **0 long tasks / 0 ms TBT** during a cart+search churn workload.
- CLS **0.0094**; FCP→translated **16 ms at 4×**.
- Language picker: 42–44 px targets, 6.9:1 / 9.8:1 contrast, full ArrowUp/Down/Home/End/Escape/Tab keyboard flow with correct focus return.
- Round trip `en → es → dynamic render → en` restores `body.innerText` **byte-identically**.
- Brand glossary: **58 terms**, product names and INCI botanicals intact in all 5 locales on a live PDP; prices untouched; JSON-LD parses with `name` intact.
- Locale files: **206 keys each, 0 missing, 0 extra, 0 empty, 0 TODO**.

---

## 8. Product judgement and the fix list

Google restricting the widget to non-commercial sites in 2019 makes this migration correct in principle, and the privacy/CSP/cookie outcome is a real win — a cookieless, zero-third-party, offline-capable translator is strictly better than shipping visitor text to Google. But the implementation trades ~100% machine translation for **10–20% dictionary translation that does not run on a first visit**, and then advertises the result to search engines as five fully localised sites. **Hold.**

**Blocking (must fix before merge)**

1. **Fix the script-order race.** `assets/js/main.js:9919,9925` — set `sLoc.async = false; s.async = false;` (dynamic scripts ignore `defer`), or make `translator.js` idempotently re-run `init()` when `YL_LOCALES` arrives. Add a regression test that loads `?lang=es` with `locales-data.js` artificially delayed and asserts the nav is Spanish. *Today: English 10/10 cold loads.*
2. **Add `/TEST_READY.md` to `BLOCKED_PATHS`** (`scripts/build-security-headers.js:96-114`) and re-run `build-security-headers`. *Today: `npm test` exits 1.*
3. **Remove the hreflang layer**: revert `generateHreflangTags` / `sitemapXhtmlLinks` (`scripts/build-site-data.js:387-405, 3372-3392, 3794-3803, 6204`), the 33 in-page blocks, and the corresponding `qa-check` assertions; add `Disallow: /*?lang=` to `robots.txt`. Revisit only if real per-locale pages get built. See §5.
4. **Put assertions in `challenger1` Test 2.3** (`scripts/challenger1-translation-adversarial.browser.test.js:826-853`) — assert the drawer exists, assert the selector matched, assert the Spanish string. A test that prints `✓ … ""` must fail.
5. **Restore the `TEST_INFRA.md` "What a passing suite has to mean" section** and the deleted `PROJECT.md` feature/contract inventory. Append the translation content; do not overwrite the file.
6. **Revert the loosened SLA pins** (`scripts/test-challenger2-m3-m4-adversarial.browser.test.js:659,663,667`) and the widened order-status acceptance (`scripts/puppeteer_tests.js:430,445`). If the new suites genuinely need more headroom, that is a separate, argued commit.
7. **Fix the three claim-drift entries**: `quiz.subtitle` de ("Kräuterheilmittel" → "pflanzliche Pflege"), `home.badge3Text` ja (drop 安心), `home.featuredText` ja (drop the sleep-regulation claim). These are regulatory, not stylistic.
8. **Do not set `<html lang="xx">` while the page is <50% translated** — it is a WCAG 3.1.1 Level A failure and mis-pronounces every untranslated string. Either raise coverage first or leave `lang="en"` and only set `lang` on elements you actually replaced.

**Before this is worth shipping as a feature (not just safe to merge)**

9. **Regenerate the dictionaries from the actual markup, not from imagination.** 58% of entries match nothing. Extract candidate strings from the built HTML, then translate. Add a build gate: *"every English dictionary value must appear at least once in the built site"* — that single assertion would have caught all 120 dead keys, the `"Your cart is empty."` period, and the `"Patch Test:"` colon.
10. **Adopt `data-i18n` in the markup** so lookup stops depending on exact string equality — and fix the `__ylOriginalText` caching bug (§4) at the same time, because that path is currently unexercised.
11. **Cover the dynamic surfaces**: quiz (1/15 strings), search modal (mixed-language in one view), cart drawer body, and the Worker/checkout error strings (a small `error.*` namespace consumed by `cart.js` would cover those).
12. **Pass `locale` to Stripe** in `workers/checkout.js` from `yl-lang`, so checkout doesn't switch back to English mid-funnel.
13. **Add an "English version governs" line** to `terms.html`, `privacy.html`, `policies.html`, `safety.html` before any translated legal copy exists.
14. Fix the three untranslated-in-all-locales keys (`pdp.completeTheRitual`, `pdp.botanicalPairing`, `quiz.title`); add `aria-controls` and put the current language into the toggle's accessible name; decide whether the search index should accept translated query terms.
15. Consider making `a11y-check.js` fail — or at least report — on axe `incomplete` results, since the new dropdown's `backdrop-filter` puts 7 nodes permanently outside the gate's reach.
