# Final readiness audit — 2026-09-08

**Scope.** `main` at `482b047` (2026-09-06), which is also what production serves: `curl https://yallternativeliving.com/sw.js` and `git show origin/main:sw.js` carry the same `CACHE_NAME` (`yallternative-cache-vc752a3185648`), and the live `sitemap.xml` `<lastmod>` set matches the committed file exactly (31 × 2026-09-04, 1 × 2026-09-06).

**Method.** Every repository quality gate was run in a clean checkout; the Puppeteer pool ran against the pre-installed Chromium. Production was probed non-destructively with `curl` and the committed live-audit script. Three independent read-only reviews were made of (1) the 2026-09-01 audit's open items against current code, (2) the money path in `workers/`, `cms-auth/` and `assets/js/cart.js`, and (3) deploy configuration, CI and documentation. Every finding below names a file and line; nothing was modified except the addition of this file.

**Headline.** The site that is live today is the audited commit, all five 2026-09-01 criticals are verified fixed in code, the fast gates are green here and in CI, and the accessibility gate is at zero violations. Three defects remain in the gift-card money path that should be settled in Stripe test mode before launch, two owner-facing documents still tell the owner to put secrets in the wrong place, and the dashboard-side prerequisites cannot be verified from the repository. The recommended order is at the end.

---

## 1. Gate results

| Gate | Command | Result | Notes |
| --- | --- | --- | --- |
| Smoke | `npm run test:smoke` | PASS | |
| Unit + static QA | `npm test` | PASS | Unit pool exit 0; `qa-check.js` reports 1121 checks. |
| Lint | `npm run lint` | PASS | |
| Format | `npm run format:check` | PASS | |
| Browser pool | `npm run test:integration` | 23/26 | See below. `a11y-check.js` PASSED: 0 violations across 37 pages × 2 themes. `reveal-check.js` passed. CSP positive control fired. |
| Cross-browser | `npm run test:cross-browser` | NOT RUN | Firefox and WebKit engines are not installed in this sandbox; the gate fails by design without them. CI runs it. |
| Live sweep | `scripts/live-production-audit.js` | COULD NOT RUN | Headless Chromium in this sandbox has no route to the internet (`ERR_CONNECTION_RESET` on all 20 pages). Not a site failure. |
| CI on `main` head | `.github/workflows/test.yml` run 356 | PASS | All three jobs green on `482b047`, including the browser job. |

Caveat: the gates above ran on Node 22.22.2 because that is what the sandbox provides; `.nvmrc`, `engines` and CI all say 24. Nothing failed for that reason, but the CI result is the authoritative one.

### Browser-pool failures, classified

| Suite | Here | Classification | Evidence |
| --- | --- | --- | --- |
| `m4-adversarial-challenger.browser.test.js` | 66 passed, 3 failed | Environment | The 3 failures are `browserType.launch: Executable doesn't exist` for Chromium-headless-shell, Firefox and WebKit. Green in CI, which installs them. |
| `challenger-m2-verification.browser.test.js` | `Node is either not clickable` at `:750` under 4 parallel workers | Flake | Re-run alone, the whole Puppeteer section passed and the suite failed only at its Playwright section for the engine reason above. |
| `challenger-m3-stress.browser.test.js` | `Navigation timeout of 30000 ms` on `products/yallternative-gift-card.html` at `:484` | Environment-specific, reproduced twice | Same page loads to `networkidle0` in 2 s when loaded on its own here; green in CI on this exact commit. Not root-caused. |

**The pool is not deterministic.** The one red run on `main` in the last two weeks (run 353, merge of PR #80) failed a fourth suite, `challenger-r2-r5-adversarial.browser.test.js`, and the very next push was green with no relevant change. PR #77's message records a fifth instance (`challenger-m2-verification`, byte-identical trees failing once and passing once). Nobody should read a single red browser job as a real regression, and nobody should read a single green one as proof either; that cuts both ways for a launch.

## 2. Production state (probed 2026-09-08 18:18 UTC)

| Check | Result |
| --- | --- |
| Deployed commit = `main` | Yes (`CACHE_NAME` and sitemap match) |
| Security headers on `/` | CSP, HSTS (`preload`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP all present and equal to `_headers` |
| `/api/checkout` → Cloudflare Worker | Up. `GET` → 405 JSON; empty `POST` → 400 `Cart is empty or invalid.` |
| `/api/gift-card-balance` | Up. Bad code → 404 `Invalid code format` |
| `/admin/` | 200 (Sveltia CMS shell; token sign-in) |
| `/docs/AUDIT-2026-09-01.md`, `/scripts/etsy-snapshot.json`, `/TEST_INFRA.md`, `/.nvmrc`, `/.github/workflows/test.yml`, `/node_modules/sharp/package.json` | All 404 (forced `404.html`, 24501 bytes) |
| `/.netlify/functions/redeem-points` (C-1) | 404 |
| `/assets/data/products.json` | 200 (intended; the shop reads it) |

## 3. Follow-up on the 2026-09-01 audit

### Criticals: all five verified fixed in code

| ID | Evidence at HEAD |
| --- | --- |
| C-1 redeem-points | `netlify/` no longer exists; live endpoint 404s. The audit says "410 at the edge"; it is a 404, which is fine. |
| C-2 gift card never debited | `workers/checkout.js:1726` reserves on the Durable Object ledger; `workers/routes/stripe-webhook.js:731` commits, `:841` releases on `checkout.session.expired`; D1 binding is uncommented with a real id at `workers/wrangler.toml:212-215`. |
| C-3 SW served one shopper's card to the next | `sw.js:254` bypasses `/api/` and `/.netlify/`; every Worker JSON reply is `Cache-Control: no-store` (`workers/routes/http.js`). |
| C-4 CSP hash generator certified CMS text | `scripts/build-security-headers.js:306-312,385-408` compares against the committed `scripts/inline-script-hashes.json` and exits 1 on an unapproved hash. |
| C-5 `404.html` broken off-root | Every `src`/`href` is root-absolute. |

### Still open from that audit

| ID | What | Where |
| --- | --- | --- |
| M-cms | CMS commits straight to `main` (no `publish_mode: editorial_workflow`); every Save is a production build. | `admin/config.yml:53-60` |
| M-cms | `/api/*` proxies to the `*.workers.dev` hostname rather than a custom route. | `netlify.toml:78-79` |
| M-deps | `workers/README.md:119` still says `cp wrangler.toml.example wrangler.toml`, which would overwrite the committed config. | `workers/README.md:119` |
| L-crawl | 233 external links use `rel="noopener"` only, none `noreferrer`. | all pages |
| DI-14 | `protection-keychain-alt1-800.{avif,webp}` exist and nothing references them. | `assets/img/` |
| DI-15 | Size labels mix `"2oz"`/`"2 oz"`, `"1oz"`/`"10 oz"`. | `assets/data/products.json` |
| DI-16 | The five `comingSoon` products are listed in `llms.txt:34-38` with prices and no availability marker. | `llms.txt` |
| Accepted | Loyalty fields remain in `admin/config.yml:1358-1389`; loyalty is now partly wired (`stripe-webhook.js:1105`, `/loyalty-balance`), so "display-only" no longer describes it. Re-decide rather than leave. | |

Resolved since: L-logo (50 KB, `<picture>` with AVIF/WebP), DI-11 (bundle variants), the Gift Up! placeholder container (removed from `shop.html`), and all eight blocking items of `docs/AUDIT-2026-09-02-translator.md`.

### Deploy prerequisites that only a dashboard can confirm

| # | Item | Repo evidence |
| --- | --- | --- |
| 1 | D1 database created, id pasted | **Done** — `workers/wrangler.toml:212-215` |
| 2 | Worker secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` (+ `MAGIC_LINK_SECRET`) set in Cloudflare | Unverifiable. No dated confirmation anywhere in the repo. |
| 3 | Stripe webhook pointed at the Worker, subscribed to exactly `checkout.session.completed`, `checkout.session.expired`, `charge.refunded` | Unverifiable. Code handles all three. |
| 4 | Resend domain shows Verified for `gifts@yallternativeliving.com` | Unverifiable. Without it gift-card emails fail silently (`workers/README.md:349`). |
| 5 | Old Netlify env vars deleted | Unverifiable. |
| 6 | Cloudflare Workers Builds: branch control + watch paths scoped to `workers/*` | Unverifiable; recorded as dashboard-only in `workers/wrangler.toml` header. |

A live `POST /api/checkout` with a real cart, in Stripe **test mode**, is the only thing that proves items 2 and 3 at once. It has not been done in this audit because it would create a real Checkout Session on the live account.

## 4. New findings

### Money path

| Sev | What | Where | Why it matters |
| --- | --- | --- | --- |
| **High** | The gift-card hold is `min(total + shipping, balance)` and is handed to Stripe as a line-item `amount_off` coupon of that size. The webhook commits the **reserved** amount, never the session's actual `total_details.amount_discount`. | `workers/checkout.js:1600-1605`; `workers/routes/stripe-webhook.js:722-760`, `:463` | Stripe documents coupons as discounting the purchase subtotal. If the coupon does not cover the shipping rate, a $50 card on a $30 + $10-shipping order is debited $40 while the shopper also pays $10 shipping by card. No test covers gift card + shipping. Confirm in test mode; if confirmed, cap the reservation at `totalCents` or reconcile the commit to the session's real discount. |
| **High** | `charge.refunded` restores `min(applied, refunded)` to the card on **any** cash refund. | `workers/routes/stripe-webhook.js:872-900` | $50 order paid $20 card + $30 cash; owner refunds $10 cash in the Dashboard; the shopper receives $10 cash **and** $10 back on the card. Restore should be `max(0, refunded − cashPaid)` or an explicit owner action. |
| **High (conditional)** | `settleRedemption` and `issuePurchasedCards` run on `checkout.session.completed` without checking `payment_status`; the order email and revenue report do check it. `payment_method_types` is deliberately omitted, so any delayed-notification method enabled in the Dashboard (ACH, SEPA) fires `completed` with `payment_status: "unpaid"`. | `workers/routes/stripe-webhook.js:722,764` vs `:690,1022`; `workers/checkout.js:1380-1390` | Cards would be minted and emailed before money arrives; there is no `async_payment_failed` handler to claw back. Safe only while no async method is enabled. Gate both on `isFulfillable()`. |
| Medium | Bundle and custom-box **components** are never checked for `inStock === false` / `stock <= 0`; only the bundle's own flag is. | `workers/checkout.js:685-702, 943-975, 1190` | Latent: no component is sold out today. |
| Medium | Loyalty points accrue on `amount_subtotal`, i.e. before gift-card and promo discounts. | `workers/routes/stripe-webhook.js:988-994` | Dormant: `enableLoyaltyPoints` is `false`. |
| Low | Volume-price tiers count the client `qty` before the stock cap. | `workers/checkout.js:1121-1127` vs `:1213-1218` | Only tracked-stock salves; none today. |
| Low | If `expireSession` fails after a ledger refusal, the session stays payable with a live coupon; the webhook logs `reservation_not_found` and does not retry. | `workers/checkout.js:1738`; `stripe-webhook.js:733` | Narrow, logged. |
| Low | `/api/gift-note` HMAC does not enforce the ≥16-char secret length the other `hmacKey` path does. | `workers/routes/gift-note.js:41-52` | Cosmetic if README's 32+ chars is followed. |

Verified solid, for the record: every unit price is recomputed from the fetched catalog and unknown or sold-out variants fail closed; the webhook verifies HMAC-SHA-256 with a 300 s tolerance and claims each event in D1 before side effects; gift-card double-spend is prevented by a per-code Durable Object with a conditional `UPDATE ... WHERE balance_cents >= ?` and a `CHECK` constraint; CORS is an allow-list with `Vary: Origin`; no secret is committed; every `env.*` the Worker reads is either declared in `wrangler.toml` or documented as a dashboard Secret; `cms-auth` binds `state` to an HttpOnly cookie, fixes the scope server-side, and `postMessage`s the token only to an origin matching `ALLOWED_DOMAINS`.

### Documentation the owner will follow

| Sev | What | Where |
| --- | --- | --- |
| **High** | `docs/SETUP-GUIDE.md` twice tells the owner to add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `RESEND_API_KEY` to **Netlify** environment variables. The Worker reads them from **Cloudflare**; Netlify has no functions any more. Following the guide as written leaves checkout unable to talk to Stripe. | `docs/SETUP-GUIDE.md:112-114, 185-187` |
| **High** | `docs/DEVELOPMENT.md` still instructs pointing the Stripe webhook at `/.netlify/functions/fulfill-gift-card`, which 404s, and describes Netlify Functions as live in 12 places across `DEVELOPMENT.md` and `SETUP-GUIDE.md`. The 2026-09-01 audit marked this corrected (H-21/H-22); it was not. | `docs/DEVELOPMENT.md:602-605` and `grep -n "netlify/functions" docs/*.md` |
| Medium | `vercel.json` is not a functional fallback: it carries the two Umami rewrites and headers only, none of the `/api/*` proxy, the forced 404s, or the cache rules. A Vercel deploy would break checkout and serve `docs/AUDIT-*.md`. Either generate it to parity from `build-security-headers.js` or delete it and say so. | `vercel.json` vs `netlify.toml:64-160` |
| Low | `scripts/live-production-audit.js` prints `COMPLETED` and exits 0 after 20/20 page failures, and writes its results to a hard-coded path under one developer's home directory. It is the "check that stops checking" shape `AGENTS.md` warns about. | `scripts/live-production-audit.js:679` and the summary block |

### Deploy configuration and CI

| Sev | What | Where |
| --- | --- | --- |
| Low | The `core` paths filter that gates the browser job omits `assets/fonts/**`, `.github/actions/**`, `robots.txt`, `site.webmanifest`, `.well-known/**`; a PR touching only those never runs the browser/a11y pool. Pushes to `main` always run it. | `.github/workflows/test.yml:26-46` |
| Low | `test.yml` uses `npm install` rather than `npm ci`, and floating `@v7`/`@v6` tags for checkout/setup-node/cache. The write-token bots are SHA-pinned. | `test.yml:21,55,59,77,79` |
| Low | The i18n bot's commit messages and tracking issue still say "six dictionaries" / "en + 5 locales"; there are nine. Every bot commit on `main` states the wrong count. | `.github/workflows/i18n-bot.yml:229,251,299` |
| Info | `sw.js` runtime-caches `/admin/*` navigations and `admin/config.yml` (network-first). No secret is involved; just unnecessary. | `sw.js:254-270, 312` |

Verified clean: `netlify.toml`, `_headers` and `vercel.json` security headers are byte-identical; all 50 `sw.js` precache paths exist and `offline.html` is among them; `sitemap.xml` lists 32 URLs that all exist and none blocked; `robots.txt` disallows `/admin/`, `/cms-auth/`, `/*?lang=`; `security.txt` expires 2027-06-01; every indexable page has a title, description, self-canonical, existing `og:image`, `lang`, and one `<h1>`; `admin/config.yml` points at the right repo and branch and every collection file exists.

## 5. Documentation drift (numbers stated vs. counted)

| Claim | Where | Actual |
| --- | --- | --- |
| "27 `scripts/*.test.js` suites" | `README.md:58`, `AGENTS.md:66` | 46 non-browser suites (`ls scripts/*.test.js \| grep -v browser \| wc -l`) |
| "42 suites" / "48 suites" | `TEST_INFRA.md:32`, `:827` | 46 |
| "16 `*.browser.test.js`" / "11 challenger browser suites" | `TEST_INFRA.md:46`, `README.md:68` | 20 browser suites; the runner executes all 20 |
| "570 assertions" (PDP metadata) | `README.md:61`, `TEST_INFRA.md:33` | 797 |
| "721 static assertions" (`qa-check.js`) | `README.md:64`, `AGENTS.md:66`, `TEST_INFRA.md:36` | 1121 (`TEST_INFRA.md:178` says 1122) |
| "34 pages (15 top-level plus 19 product pages)" | `README.md:72`, `scripts/a11y-check.js:23` | 37 (17 top-level + 20 products; gift-card PDP added 2026-09-04) |
| a11y gate "is not at zero right now: 23 serious `color-contrast` violations" | `AGENTS.md` §3 | Gate PASSED with 0 violations across 74 scans on this commit |
| lint scope "`eslint scripts assets/js workers cms-auth netlify`" | `AGENTS.md:67` | `package.json` has no `netlify`; the directory does not exist |
| "9 locales", "three CI jobs", "32 sitemap URLs" | `TEST_INFRA.md:122`, `AGENTS.md:72`, `PROJECT.md:225` | Correct |

## 6. Recommended order before launch

1. **Stripe test mode, one afternoon.** Place four test orders through the live `/api/checkout`: (a) plain card; (b) gift card with balance greater than subtotal plus a shipped item; (c) partial gift card + cash, then refund part of the cash in the Dashboard; (d) a purchased gift card. (b) and (c) decide the two High money findings; (d) proves the webhook, the secrets and the Resend domain in one go. Record the session ids in this file.
2. **Fix what (b) and (c) show.** Cap the reservation at `totalCents` or reconcile the commit to `total_details.amount_discount`; change the refund restore to `max(0, refunded − cashPaid)`. Add a unit test for gift card + shipping and for partial cash refund in `scripts/worker-checkout.test.js` / the webhook suite. Gate card minting on `isFulfillable()` regardless.
3. **Correct the two owner documents** (`SETUP-GUIDE.md`, `DEVELOPMENT.md`) so the secrets and the webhook URL point at Cloudflare. This is the document the owner will actually follow.
4. **Decide `vercel.json`**: parity or deletion.
5. **One sweep of the counts** in `README.md`, `AGENTS.md`, `TEST_INFRA.md`, `a11y-check.js:23` and the i18n-bot strings, and delete the stale "a11y gate is red" paragraph from `AGENTS.md`.
6. **Confirm the dashboard items** in §3 and write the date next to each in `AGENTS.md` §2.7, the way the Netlify branch-deploy setting was recorded on 7 September.
7. Optional, after launch: the still-open list in §3, the `core` filter additions, `npm ci`, and either fixing or deleting `live-production-audit.js`.

Items 3 to 5 are doc-only or generated-file changes and cost no Netlify build under the `[build] ignore` rule, except `a11y-check.js:23` which is a comment.

---

## Remediation status (2026-09-08, same day)

Landed on the follow-up branch after the report merged. Everything in-repo
from §6 is done except the `vercel.json` decision, which is the owner's call
and is left as it was; steps 1 and 6 need the Stripe and Cloudflare
dashboards and are still the owner's.

| Finding | Status | What changed |
| --- | --- | --- |
| High: hold includes shipping | **Fixed** | `workers/checkout.js` caps the gift-card coupon at the goods subtotal (`totalCents`), never goods + shipping. `assets/js/cart.js` estimates the same way, so the drawer no longer promises a discount checkout cannot honour. |
| High: hold not reconciled to the real discount | **Fixed** | `GiftCardLedger.commit()` accepts `cents`: a settlement below the hold commits that much and returns the rest to the card in the same transaction; zero releases the hold. `settleRedemption()` passes `total_details.amount_discount` when the session carries it. |
| High: partial cash refund also refunds the card | **Fixed** | `handleChargeRefunded()` restores the card share only when the charge is refunded in full (`charge.refunded`, or `amount_refunded >= amount`). A partial cash refund restores nothing to the card. |
| High (conditional): cards minted before payment clears | **Fixed** | `processStripeEvent()` defers the whole fulfilment when `payment_status` is not `paid`/`no_payment_required`, and handles `checkout.session.async_payment_succeeded` (same steps) and `checkout.session.async_payment_failed` (as an expiry). The Stripe webhook must now be subscribed to five events; `workers/README.md` and `docs/DEVELOPMENT.md` list them. |
| High: owner docs send secrets to Netlify | **Fixed** | `docs/SETUP-GUIDE.md` steps 3 and 6 and `docs/DEVELOPMENT.md` §8 now put every secret on the Cloudflare Worker and point the webhook at `/api/stripe-webhook`. All remaining `netlify/functions` references in the guides are retired. |
| Medium: `vercel.json` not a functional fallback | **Open, owner's call** | Parity or deletion; nothing changed. |
| Low: `live-production-audit.js` exits 0 on total failure | **Fixed** | Results go to `tmp/live-audit-results.json` (or `LIVE_AUDIT_RESULTS`); the process exits 1 when any page fails or nothing was checked. |
| Low: `core` paths filter gaps | **Fixed** | `assets/fonts/**`, `robots.txt`, `site.webmanifest`, `.well-known/**` and `.github/actions/**` added to `.github/workflows/test.yml`. |
| Low: i18n-bot says "six" | **Fixed** | Commit and issue strings now say nine. |
| M-deps: README tells you to overwrite `wrangler.toml` | **Fixed** | `workers/README.md` Option B step 2. |
| Docs drift (counts) | **Fixed** | `README.md`, `AGENTS.md`, `TEST_INFRA.md`, `scripts/a11y-check.js` carry 46 / 20 / 797 / 1121 / 37, the a11y gate is described as green, and the lint scope no longer names `netlify`. |

Tests added or changed: `scripts/worker-state.test.js` (partial and zero
settlement on the ledger; settle-below-hold through the webhook; unpaid
completion deferred, `async_payment_succeeded` fulfils, `async_payment_failed`
releases; refund restores on full refund only), `scripts/worker-checkout.test.js`
(cap at goods with shipping still charged; small card applied in full), and the
cap expectations in `cart.test.js`, `backend-functions.test.js`,
`m1-adversarial-challenger.test.js` and `adversarial-stress.test.js`.

Still the owner's, in order: the four Stripe test-mode orders in §6 step 1
(now also proving the five-event webhook subscription), then the dashboard
confirmations in §3 written into `AGENTS.md` with a date.
