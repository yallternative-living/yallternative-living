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

## Step 3: the translation step, and the bot that runs the whole thing

`scripts/i18n-translate.js` (`npm run i18n:translate`) fills es/de/fr/ja/zh and
writes all seven files -- `en.json`, the five locales and
`i18n-translation-basis.json`. Note where the English write happens: HERE, not
in step 2. `i18n:new --write` still exists and still works, but it appends
English keys the five locales cannot satisfy yet, which is why the build is red
between the two steps. Letting the translator write `en.json` means a key
reaches the dictionary only when its five translations are in hand.

    node scripts/build-site-data.js                     build the site
    npm run i18n:new -- --json /tmp/report.json         discover + key, writes nothing
    npm run i18n:translate -- --report /tmp/report.json fill five locales, write seven files
    node scripts/build-site-data.js                     the gate goes green
    npm test
    commit

**Atomicity is the rule everything else serves.** A key is written to all seven
files or to none of them -- never "English plus the four locales that worked".
A string whose German fails is not translated into four languages; it is not
translated, and the site keeps showing the English, because the runtime
translator falls back on any text it cannot match. Failed strings are listed in
the JSON summary with the locale and the rule that fired.

**The work set** is the union of three things: NEW (a writable entry in the
report), MISSING (a key in `en.json` whose value in some locale is absent -- and
only the missing locales are asked for, so a hand-tuned translation is never
overwritten), and CHANGED (a key whose English drifted from its basis digest; all
five are re-translated, which does discard hand-tuning of the superseded
English, and the commit message says so). ORPHANED `auto.*` keys are removed
from all six locales and the basis; a hand-authored orphan is reported and never
deleted.

**Every string is checked before it is written**, deterministically, in
milliseconds, with no second model reviewing the first: placeholders preserved,
protected glossary terms verbatim, non-empty, not an English passthrough, length
ratio inside 0.3x-3.5x, no Traditional character in the Simplified `zh` locale,
and no claim vocabulary the English does not license. The failure modes that
matter here are lexical and enumerable, and a grep that fails loudly beats a
reviewer that passes 99% of the time and teaches the maintainer to trust it.

### Source parity, and why the claims table moved

`scripts/lib/i18n-claims-rules.js` now holds the claims vocabulary that used to
live inside `scripts/i18n-claims.test.js`. Three things read it -- the test, the
pre-write check, and the model's own negative constraints, which are GENERATED
from the same array rather than retyped -- so the prompt, the gate and the
refusal cannot drift apart while all three report green.

It also adds **source parity**: a banned word is permitted when the key's own
English contains one of its licensed triggers. The live catalogue says "calms
the itch underneath" and "buzz off, naturally", so a faithful fr/de/zh rendering
IS apaise/beruhigt/舒缓 and a faithful ja/zh rendering IS 天然 -- under the old
rule the honest translation was the one that failed. It is not a loosening: a
claim the English does not make is still refused in every locale, `安心` and
`効能`/`疗效`/`功效` are licensed by nothing at all, and protected brand terms
are stripped from the English before the trigger search, so the product named
"Y'all Heal Now Miracle Frankincense Salve" cannot license "heilend".

Separately, and independently of the bot: two live blurbs sit on the regulatory
line. "Calms the itch" and "naturally" are choices about the ENGLISH, and the
EU/JP/CN rules apply to the English storefront too.

### Where the build gate now warns instead of failing

Rules 1 (reachability) and 4 (basis digest) in `validateDictionaryCoverage` are
WARNINGS for `auto.*` keys and hard failures for every other key. Rules 2 and 3
stay hard for all keys.

The case is real and happens on every product edit: the owner saves a blurb in
the CMS, that commit lands on main, and Netlify builds it BEFORE the bot has
re-translated. For that one deploy the old English is reachable nowhere and its
digest is stale, both on the same key, and neither is anybody's mistake. Under
the old gate that is a failed deploy and a failed-deploy email the owner cannot
tell apart from a real break. The cost of warning is one deploy cycle showing a
stale or English string; nothing renders wrong, it renders untranslated. Both
branches are pinned in `scripts/build-site-data.test.js`.

### The engine, and the environment variables

`scripts/lib/llm.js` is the repo's shared LLM client -- not this bot's private
one, because more bots are coming. One `fetch` at an OpenAI-shaped
`/chat/completions` with JSON-schema structured output, so Gemini and Groq
differ by a base URL and a model id:

    const client = llm.createClient({ provider, models, apiKey, baseUrl, maxCalls });
    const obj = await client.completeJSON({ system, user, schema, schemaName });
    client.callsRemaining();   // 0 means the per-run budget is spent
    client.fallbackWarning();  // null, or the sentence a maintainer must read

| Variable | Default | What it is |
|---|---|---|
| `GEMINI_API_KEY` | — | The AI Studio key. Free tier, no billing account. Required unless `--provider mock`. |
| `GROQ_API_KEY` | — | Optional second vendor (`--provider groq`). |
| `I18N_MODELS` | `gemini-3.8-flash,gemini-flash-latest` | Comma-separated, first is the one we mean. |
| `I18N_MAX_CALLS` | `80` | Per-run provider-call cap. 198 keys x 5 locales / 20 per call = 50. |
| `I18N_BATCH_SIZE` | `20` | Strings per locale per call. |
| `LLM_MODELS`, `LLM_MAX_CALLS`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES` | see `scripts/lib/llm.js` | The shared client's own names; the `I18N_*` ones win for this bot. |
| `LLM_MOCK_CORRUPT` | — | Test hook. With `--provider mock`, makes the mock drop protected terms from any string containing this substring, which is how the reject-and-drop path is proved offline. |

**The model list is a list on purpose.** `gemini-3.8-flash` is pinned first,
because a pinned id is the only way to know what produced a given commit.
`gemini-flash-latest` is last: Google documents it as hot-swapped with every new
release, so the day the pinned id is retired the bot keeps working instead of
dying on a 404. It is a survival path, not an upgrade -- the alias can point at
a preview model whose register differs -- so a run that used it says so in the
summary, in the step summary, in the commit message and on the tracking issue,
in the imperative: **re-pin**. Re-pinning is one line of
`.github/workflows/i18n-bot.yml`.

### Running it locally

    export GEMINI_API_KEY=...            # only for a real run
    node scripts/build-site-data.js
    npm run i18n:new -- --json /tmp/report.json > /dev/null
    npm run i18n:translate -- --report /tmp/report.json
    node scripts/build-site-data.js && npm test

`--dry-run` does everything except write. `--provider mock` needs no key at all
and writes obviously-fake `"[de] ..."` values; it is how the pipeline is proved
end to end offline and what the CI dry run uses. Never commit mock output.

**Recorded proof run, 2026-09-04**, against the real backlog on a clean tree:
the report's 198 writable NEW entries went through the mock in 50 calls, the
dictionary went from 515 to 713 keys x 6 locales, `node
scripts/build-site-data.js` reported the gate GREEN, and `npm test` passed. The
diff was an append at the end of each of the seven files with all 515 existing
keys, values, digests and their order untouched, and all six locale files
sharing one key order. Then, with `LLM_MOCK_CORRUPT` set to a fragment of the
About-page paragraph so the mock would drop `Y'allternative Living` and
`Landrum, SC` from it, the same run wrote 197 keys and listed 5 failures (one
key x five locales, reason "protected term(s) not preserved verbatim"); that key
was absent from all six locales AND from the basis -- 712 keys, not 713 -- and
the gate was still green. Both trees were reverted afterwards.

That run also found a real defect and it is worth recording why: the fixture in
`scripts/i18n-new-strings.test.js` asserted over two REAL page strings as
translation candidates, and the moment the translator wrote them into `en.json`
they classified as `in-dictionary` and the suite went red. The bot runs `npm
test` before it commits, so that would have wedged the pipeline permanently on
its first successful run. A fixture that has to be a non-candidate cannot be
made of copy the bot is about to absorb.

### The bot

`.github/workflows/i18n-bot.yml` runs the pipeline on any push to `main` that
touches a file the CMS writes, plus `workflow_dispatch` with a `dry_run` input
that defaults to true. The commit step is LAST, so a failing build, gate or test
run after the translation step has written files aborts the job and the tree
goes away with the runner -- there is no cleanup path to get wrong. No `[skip
ci]` and no `[skip netlify]`: Netlify honours both and this push has to deploy.

`.github/actions/setup-site` is Node + `npm ci` + a real Chrome, factored out
for the next bot. The order is not the obvious one: dependencies first with
`PUPPETEER_SKIP_DOWNLOAD`, THEN the Puppeteer cache restore, THEN an explicit
`npx puppeteer browsers install chrome` and a `browsers list` that fails loudly
-- downloading before the cache restore wastes the cache, and since puppeteer
25.8.0 a green `npm ci` no longer proves Chrome is on disk. `test.yml` keeps its
own setup: Playwright engines, two jobs, different browser needs.

Strings the checks refused are filed on ONE tracking issue, found by exact title
and updated rather than duplicated: key, locale, the rule that fired, the
English.

### First-run checklist (developer, once)

1. Confirm the repository secret `GEMINI_API_KEY` exists (Settings → Secrets and
   variables → Actions).
2. Actions → **i18n bot** → Run workflow, `dry_run` **true**. It translates the
   ~198-key backlog and commits nothing.
3. Download the `i18n-dry-run` artifact and read `would-be.diff`,
   `translate-summary.json` and `would-be.stat`. Check: the diff is an append at
   the end of each file; nothing in `failed` looks like a rule that is simply
   wrong; `modelWarning` is null (if it is not, the pinned model is gone --
   re-pin `I18N_MODELS` before going further); `deferredToNextRun` is 0, or plan
   for a second run.
4. Spot-check the Japanese and Chinese by eye. Machine translation quality
   numbers are all measured on longer, richer text than button labels -- treat
   them as optimistic upper bounds and budget a human read of ja.
5. Run it again with `dry_run` **false**. It commits and pushes as
   `github-actions[bot]`.
6. **Verify Netlify actually deployed that commit** -- this is the one link in
   the chain that no GitHub documentation confirms. GitHub does not start a
   *workflow run* from a `GITHUB_TOKEN` push, and the open question is whether
   the push *webhook* still fires for third parties. The case that it does is
   strong (GitHub enumerates its non-Actions suppressions one at a time and
   spells out a Pages carve-out with no equivalent for webhooks; `GITHUB_TOKEN`
   is not on the `push` webhook exclusion list; Netlify forum threads have users
   reporting duplicate builds from Actions commit-backs) but it is circumstantial,
   at roughly 90% confidence. Settle it empirically: GitHub → Settings →
   Webhooks → the Netlify hook → Recent Deliveries, and look for a `push` with
   `sender: github-actions[bot]`. If it did not fire, the fix is a Netlify build
   hook called from the workflow's last step -- five lines.
7. Only after step 6 should anyone treat the pipeline as unattended.

## The search-enrichment bot, and the two surfaces it writes to

`scripts/search-enrich.js` writes the search vocabulary the owner would not
think to write down. Nobody types "Bug Off B\*tch Natural Bug Spray"; they type
"that bug stuff". Nobody types "Digital Gift Card" in December; they type
"stocking stuffer". A fair share of everyone types "lavendar".

It never touches `assets/data/products.json`. That file is the owner's and the
CMS's; a bot editing it would put a machine's wording in the middle of her copy
and re-open the compliance review on every run. The words live in
`assets/data/search-enrichment.json`, which is bot-owned, and
`scripts/build-site-data.js` merges them into the search index and nowhere else.

### The two surfaces

This is the whole design, and it is deliberately asymmetric.

| | `keywords` (product side) | `querySynonyms` (query side) |
| --- | --- | --- |
| Where it ends up | published in `assets/js/search-data.js`, readable by anyone | merged into the synonym table that rewrites what the shopper TYPED |
| Rendered anywhere? | yes, it ships with the product | never |
| Word policy | the FULL list: treatment verbs, symptoms, conditions, pesticide claims, unsubstantiated "natural"/"organic" | a SHORT list: cure, treat, treatment, prescription, medicine, medical, diagnose, "FDA approved" |
| Symptom words (eczema, insomnia, sore muscles) | refused | **allowed, and wanted** |

The reasoning: FDA reads intended use off "the label, the website and
advertising", and has cited a product NAME as evidence in warning letters, so a
published keyword is no safer than a name. A query synonym is different in kind
— it only routes a shopper who types "psoriasis" to the Dry, Rough Skin products
instead of an empty page, and that is not a claim that anything treats
psoriasis. The interim legal finding backing the split: FDA has said nothing
about search terms for cosmetics, and the nearest case law treats invisible
query-side input as inert and visible output as where liability lives.

The policy is **data**, in `scripts/lib/search-enrichment-rules.js`: arrays with
a one-line rationale each (`PRODUCT_SIDE_BANNED` grouped into treatment /
condition / pesticide / substantiation words, `QUERY_SIDE_BANNED`,
`QUERY_SIDE_ALLOWED`, `COMPETITOR_BRANDS`, `PREFERRED_VOCABULARY`, `LIMITS`).
A legal brief on this exact line is in progress; applying it should be an edit to
a literal, never a patch to a filter. The same arrays generate the prompt
(`promptFragment()`) and drive the filter, so the instruction the model gets and
the gate that judges its answer cannot drift — the same reasoning as
`scripts/lib/i18n-claims-rules.js`.

### TODO(legal-brief): where the build and the policy currently disagree

`SEARCH_SYNONYM_BANNED` in `scripts/build-site-data.js` throws on **wound**,
**infection** and **psoriasis** on the query side too, which this policy would
allow there. The build wins until the brief lands: the bot refuses them as well,
with a drop reason that names the conflict, so the tracking issue says exactly
what is pending. `QUERY_SIDE_BLOCKED_BY_BUILD_ONLY` is **computed** from the
build's own array rather than typed, so shortening that array is a one-commit
reconciliation and this list empties itself. `scripts/search-enrich.test.js`
pins it at exactly those three words, so it cannot go stale in silence.

### Regeneration, and why two runs make no diff

Each entry records a digest of the copy it was generated from — name, blurb,
description, ingredients, category, concerns — plus the policy version. A
product is re-enriched when it is new, when that copy changes, or when the
policy version moves. A price edit, a stock change or a new photo costs nothing.
Everything else is carried through verbatim, ids are serialised in alphabetical
order with a fixed field order, and a product deleted from `products.json` drops
out on the next run.

### The deterministic filters

There is no second model reviewing the first. Every failure mode that matters
here is lexical and enumerable, so a filter that names the word it refused beats
a reviewer that is right 99% of the time. Per item, in order: lowercase and
trim; at most 40 characters; only characters a search word should have; the
surface's banned list; competitor brands; not a duplicate of an owner keyword
(case-insensitively) or of a single token of the product's own name; not a
duplicate inside the batch. Then caps: 12 keywords and 6 synonym entries per
product. Every drop is reported as `{id, item, reason}` and goes on one issue.

### The build has the last word

Two checks, not one. Each candidate synonym is first run through the build's own
`buildSearchSynonyms()`, one entry at a time, so a word the policy missed becomes
a logged drop rather than a red deploy an hour later. Then the written file faces
a full `node scripts/build-site-data.js`: on a non-zero exit the previous bytes
are restored, the build is re-run so the generated files match what is on disk,
and the run exits 2 having changed nothing. That guard is meant to be able to
veto the bot, so the bot is written to lose the argument.

### The recorded proof run

`--provider mock`, no key, no network, against the real 20-product catalogue at
`08c131e`, in a clean worktree. The mock is deliberately dirty: it emits
`"eczema"` as a keyword, `"cures itch"` as a synonym term, a 68-character string
and a duplicate of an owner keyword, so the drop paths are exercised rather than
asserted.

```
summary: products=20 generated=20 unchanged=0 removed=[] dropped=107
         modelUsed=mock-deterministic calls=1 fallbackWarning=null

drops, by reason:
   21x  duplicates a keyword the owner already wrote
   20x  contains "eczema", which is a symptom or condition; it belongs on the query side only
   20x  contains "cures", which asserts a medical outcome
   20x  contains "psoriasis", which is refused by build-site-data.js SEARCH_SYNONYM_BANNED ...
   20x  is 68 characters, over the 40-char cap
    3x  contains characters a search word should not have
    3x  is already a word in the product's own name
```

- `assets/data/products.json` sha256 identical before and after; the run touched
  exactly `search-enrichment.json`, `search-data.js` and `sw.js`.
- Owner's keywords still lead every list: bug-spray kept its 12 words in order
  and gained 5; sleep-salve kept its 9 and gained 4.
- No condition or treatment word reached the published surface; `synonyms.dry_skin`
  still gained `eczema`. That asymmetry, end to end, is the point.
- A previously-empty query now hits: `"secret santa"` returned **NONE** before
  and six products after.
- Second run: 0 calls, 0 generated, byte-identical file.
- Veto path against the real build: a hand-poisoned entry
  (`{key:"skin", terms:["treats wounds"]}`) was refused, the file restored
  byte-for-byte, the generated files rebuilt, and the summary carried the
  build's own sentence rather than its stack trace.

### What is NOT covered here

- **No live-model run.** There is no API key on the development machine, so
  every run recorded above is `--provider mock`. What a real model actually
  proposes — and therefore the true drop rate — is unmeasured. The filters are
  proved; the model's taste is not.
- **The workflow has never executed.** `.github/workflows/search-enrich.yml` is
  unverified in CI: the `queue: max` concurrency, the rebase-and-retry push (it
  and the i18n bot fire on the same `products.json` push), and whether Netlify's
  webhook fires for a `GITHUB_TOKEN` push are all first-run questions. Run it
  once with `dry_run: true` and read the artifact before trusting it.
- **Search quality is not gated.** Nothing fails if the bot writes twelve words
  nobody would ever type. The gate is that it writes nothing dangerous.

## What is NOT covered, and why that matters

Naming the gaps is part of the contract; a coverage table with a tick in every
cell is how the last one went wrong.

- **~~Dictionary coverage itself is not gated.~~** Fixed: that assertion is
  now rule 1 of `validateDictionaryCoverage`, and rules 2-4 came with it. What
  remains uncovered is the number the audit actually cared about -- the SHARE
  of a rendered page that ends up translated. The gate proves every dictionary
  entry is reachable; nothing proves the reachable text is mostly in the
  dictionary. `scripts/i18n-new-strings.js` measures the gap (338 new strings
  against 515 entries on 2026-09-04) but no suite fails on it.
- **The language selector's contrast is outside the a11y gate.** Its
  `backdrop-filter` makes axe report 7 nodes as `incomplete` for
  `color-contrast`, and the gate fails only on `violations`.
- **RTL is unexercised.** No shipped locale declares `dir: "rtl"`.
- **No cross-browser coverage of translation.** Every translation suite drives
  Puppeteer, i.e. Chromium only; `cross-browser-check.js` does not exercise
  the selector.
- **Worker/checkout strings are not translated and not tested as such.**

# The copy claims reviewer

`scripts/claims-review.js` reads the wording the owner just changed in the CMS
and, if any of it reads as a regulated claim, leaves her a note. It is the
second unattended bot in this repo and the only one that writes nothing at all:
no commit, no file, no edit to her copy, and no ability to fail a deploy.

The reason it exists is narrow and worth stating. The 1-2 September 2026
compliance review found that the shop's real exposure is not the catalogue --
that was audited once and the decisions are with the owner -- it is the next
sentence she writes alone at eleven at night. "Brings the itch right down" is a
drug claim under the FD&C Act and no regex will ever see it.

## What it reads, and what it deliberately does not

Only the strings that were **added or edited** between two git refs of the five
CMS-written data files plus the journal:

    assets/data/products.json    name, blurb, description, ingredients, scent,
                                 usage guide, tags, keywords, bundle and deal
                                 copy, FAQ answers, filter labels
    assets/data/content.json     page copy, the announcement, notices, the
                                 automated-email intros
    assets/data/events.json      event names, types and notes
    assets/data/quiz.json        every question and answer
    assets/data/site-reviews.json  review text (its own category -- see below)
                                 and the owner's replies
    assets/data/journal/*.json   title, excerpt, body, tags

An unchanged blurb is never reviewed, on any run, ever. A reviewer that
re-reports the whole catalogue on every price edit is a reviewer she stops
reading, and the report becomes wallpaper. Identity for the diff is the
object's `id`, not its array index, so reordering the catalogue is zero changed
strings rather than twenty.

Everything a pattern matches is filtered again by `looksLikeCopy()`, which
keeps image paths, URLs, analytics ids, config placeholders and ISO dates out
of a report about wording.

## Two passes, and why the second one cannot be the only one

1. **The rule table** -- `scripts/lib/copy-claims-rules.js`, deterministic,
   offline, free. It owns every hard term the compliance review named across
   three categories (drug/treatment, pesticide/FIFRA, unsubstantiated
   marketing). A hit is a **definite** finding. It does not depend on a model
   being reachable or paid for.
2. **One batched model call** through the shared `scripts/lib/llm.js` --
   the same client the i18n bot uses, one `/chat/completions` with JSON-schema
   structured output, retries, the pinned-to-alias fallback and the per-run
   call cap. It is handed the rule table (so it does not re-report pass 1), the
   brand voice, and the standing instruction that puffery -- "Miracle", "the
   one y'all keep re-ordering" -- is not a claim. Its findings are **likely**
   or **possible**, never definite.

If the second pass fails, is skipped, or has no key, the run still reports the
deterministic findings and says in the report that the second read-through did
not happen. That is the whole point of doing it in that order.

Findings are merged and deduplicated: a model finding is dropped when the rule
table already reported a term for the same string and category and that term
appears inside the model's quote. A model finding whose quote is not literally
present in the string, or whose id was never sent, is dropped -- a
schema-conformant hallucination is the realistic failure mode, not a 500.

## The pending decisions, which are never findings

The wording the review already put in front of the owner -- "Y'all Heal Now
Miracle Frankincense Salve", "Hush Y'all Magnesium Arnica Sleep Salve",
"Backroad Recovery Epsom Salt Soak", and the bug spray's name and blurb -- is
masked out of the scan and listed separately as "already on your list". The
phrases are read from the live `assets/data/products.json` at run time, so the
day she renames a product the entry disappears without anybody editing code.
A claim in the sentence *around* a pending name is still reported: a brand name
is a name, not a licence, which is the same rule
`scripts/lib/i18n-claims-rules.js` applies to protected terms.

A republished customer review that makes a claim is its own category
(compliance review section 4b): the wording is the customer's, but the claim is
the shop's, and the fix is different -- leave it on Etsy, or move it off the
product page.

## The rule table's shape, and updating it from a research brief

`CLAIM_TABLE` is data, not code: a list of categories, each with an id, a
label, a citation tag matching the review's own section numbers (`S1`, `S3`,
`S4`, `S4B`), a default severity and a list of `{term, reason}` entries. A
later brief changes the word lists **without touching code** by supplying a
JSON overlay, named by `COPY_CLAIMS_TABLE` or passed to `loadTable()`:

    {
      "categories": {
        "drug":      { "add": [{ "term": "detox", "reason": "..." }],
                       "remove": ["pain"] },
        "marketing": { "add": ["clean"] }
      },
      "rewordings": [{ "when": ["detox"], "try": ["a long soak, nothing more"] }]
    }

`add` appends, `remove` filters, a bare string inherits the category's default
reason, and an unknown category id is an **error** rather than a silent no-op,
because a typo in a research brief must not quietly disable a rule. The suite
asserts that every term in the table -- including one an overlay adds -- has a
rewording to offer, so a finding is never a complaint without a suggestion.

## How the owner actually hears about it

She will not open a GitHub issue, so a run with findings emails her. The
provider is Resend, the one the site already uses in `workers/submit-form.js`:
one POST to `https://api.resend.com/emails` with the key in an `Authorization`
header, never a URL. The recipient is read from `content.json` `contact.email`
at run time, never hard-coded, so changing it in the CMS changes it here.

- One email per run, never per finding.
- **Findings only.** A run whose only output is the standing pending-decisions
  list emails nothing: "still those same four names" every time she edits a
  price is an email she filters.
- Rendering and the send/skip decision are unit-tested offline; the network
  call is a separate CLI mode (`--send-email`) so the workflow can hold
  `RESEND_API_KEY` on one step and nowhere else.
- A missing secret is a **visible skip**, written to the run summary, not a
  silent one; a Resend failure is logged and the run stays green. The issue
  carries the same text either way.

## Environment

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | secret | none | The second pass. Absent, the run is deterministic-only and says so. |
| `CLAIMS_MODELS` | env/var | `gemini-3.8-flash,gemini-flash-latest` | Pinned id first, rolling alias last. Re-pinning is this one line. |
| `CLAIMS_MAX_CALLS` | env | `6` | One call plus the shared client's retries. |
| `COPY_CLAIMS_TABLE` | env | none | Path to a JSON overlay for the word lists. |
| `RESEND_API_KEY` | secret | none | **New.** Sends the note. Absent, the email is skipped with a notice. |
| `FROM_EMAIL` | variable | none | **New.** A sender address VERIFIED in the Resend account. An unverified sender is rejected outright, which is why this is a repository variable and not a literal. |
| `OWNER_GITHUB_LOGIN` | variable | none | **New, optional.** When set, the issue body @-mentions it so GitHub emails her too. When unset, no mention is rendered. |

`RESEND_API_KEY` and `FROM_EMAIL` are the two settings a maintainer has to add
for the email half to work at all. Until they are added the workflow is fully
functional and simply says, in the run summary, that the note was not emailed.

## Running it locally

    # against the last commit, no key needed, deterministic pass only
    node scripts/claims-review.js --dry-run

    # the full two-pass run offline, with the mock provider
    node scripts/claims-review.js --provider mock

    # a specific range, JSON and Markdown to disk
    node scripts/claims-review.js --base <ref> --head <ref> \
      --json /tmp/review.json --markdown /tmp/review.md

    # a synthetic head from a directory (how the proof run works -- it never
    # writes to the repo)
    node scripts/claims-review.js --provider mock --base-dir . --head-dir /tmp/head

    # render the email offline and inspect it; sends nothing
    node scripts/claims-review.js --provider mock --email-preview /tmp/mail.json

Exit code is 0 whether or not there are findings. Exit 2 is a real error only:
a bad flag, an unreadable ref, malformed JSON in a data file.

## The recorded proof run (2026-09-04, `--provider mock`, no key)

A synthetic head was built in a temp directory from the live catalogue: one
added product whose blurb reads "Brings the itch right down and keeps bites
away, all natural and safe for the whole family", and one existing blurb
(`hand-scrub`) edited harmlessly. Every other data file was copied byte for
byte. The repo was not modified.

- **6 changed strings in 1 file.** The other four data files and both journal
  entries were byte-identical and cost one read each and produced nothing. The
  beard salve's live "calms the itch underneath" -- the marginal case the
  review names -- was not reviewed, because it did not change.
- **3 deterministic findings**, all definite: `all natural` (S3), `bites` (S4),
  `safe` (S3).
- **1 second-pass finding**, at `likely`: "brings the itch right down", the
  implied drug claim the word list cannot express. The mock's second finding
  ("keeps bites away") was **dropped by the merge** because the rule table had
  already reported `bites` on the same sentence and category.
- **5 known-pending entries**, resolved from the live catalogue, all with
  `touchedThisChange: false` -- the three product names, the bug spray's name
  and its blurb appear under "already on your list" and **not** under findings.
- The email envelope rendered with `send: true`, subject "A note about your
  wording on Porch Night Salve", recipient `y.allternative.living@gmail.com`
  read from `content.json`. Nothing was sent: no key on the machine.
- `--dry-run` on the same head returned the 3 deterministic findings and 0
  model findings, with the report stating the second read-through did not run.

`npm test` (48 suites), `npm run lint` and `npm run format:check` were verified
green in a clean worktree at HEAD with these files added.

## What this one does NOT do

- **It never edits her copy, and it never blocks a deploy.** Netlify does not
  wait on this workflow, the workflow never pushes, and the review step is
  `|| true`.
- **It does not re-audit the catalogue.** Only what changed. The standing
  compliance review is a document, not a bot, and the pending decisions are
  hers.
- **It does not check Etsy.** The review's findings about the Etsy titles
  ("Muscle Relief", "muscle soak") are outside this repo entirely.
- **It does not read printed labels, the safety file or the reaction log.**
  Those are MoCRA duties on the owner, section 2 of the review.
- **The second pass is unverified against a real model.** Every model branch
  in the suite is driven through an injected client, and the proof run used the
  mock provider; nobody has yet watched `gemini-3.8-flash` answer this prompt
  with a real key. What IS proved is that the run survives whatever it says.
