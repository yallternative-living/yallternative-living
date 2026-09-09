# World-class gap audit — 2026-09-09

**Question asked.** "What are we missing for this website to be truly world class?"

**Method.** Three independent read-only reviews of `main@66f4c1e` (front-end and
shop experience; commerce backend, operations and security; content, SEO,
performance and growth), each claim then re-checked against the code before
anything was changed. Every gate was run before and after. Nothing in this
file is estimated; the numbers are from this checkout.

This supersedes `docs/website-gap-analysis.md` (2026-07-17), which predates the
Stripe migration and still describes Snipcart features.

## 1. Claims that did not survive verification

Recorded so the next audit does not re-raise them.

| Claim | Reality |
| --- | --- |
| `site.webmanifest` references a missing `favicon-512.png` | The file exists in `assets/img/`. |
| `index.html` hardcodes a phantom "Autumn Apothecary Faire" in the countdown | It is a real entry in `assets/data/events.json`. |
| CMS commits straight to `main` | `publish_mode: editorial_workflow` has been on since 2026-09-09. |
| Zero `hreflang` is a gap | Deliberate and documented in `PROJECT.md` ("Why there is no hreflang"): the alternates would be byte-identical English pages. Real multilingual SEO needs per-locale pages, a separate project. |

## 2. Fixed in this pass

### Money path and security (`workers/`)

| Finding | Fix | Verified by |
| --- | --- | --- |
| `clientIp()` read the FIRST `X-Forwarded-For` entry, which the caller writes, so every per-IP limit (order status, gift-card balance, restock, safety report, market alerts) was a limit per string the caller chose. | Takes the last entry before Cloudflare's own append (the hop Netlify added); falls back to `CF-Connecting-IP`. `workers/routes/http.js` | New `scripts/worker-http.test.js` (10 assertions); spoof case in `worker-checkout.test.js`. |
| `/api/checkout` was the only public route with no rate limit, and the only one that creates Stripe objects on every call. | `checkRateLimit`, 12/min per client, fails open like order-status, 429 with shopper-safe copy; `cart.js` shows that copy. | `worker-checkout.test.js`: 12 pass, 13th is 429, other client unaffected, prepended XFF junk does not escape the bucket, no backend fails open. |
| Tracked `stock` was capped PER LINE. A stock-3 tee sold as Small + Medium lines shipped 6; five build-your-own boxes each holding a stock-1 salve went through with no stock check on contents. | `allocateStock()`: one allocation across the cart in order, boxes consume one unit of each content per box, a line that finds nothing left is refused by name so the drawer drops exactly that line. Volume tiers count the same allocation. | 18 new assertions in `worker-checkout.test.js`; `challenger-m1-stress` 1.7 updated (it had pinned the oversell). |
| `resolveGiftCardAmountCents` clamped: an unparseable label sold a $10 card, "Preset $999" sold a $500 one. | Returns null → "Product not purchasable". | `worker-checkout.test.js` (6 labels), `smoke-test.js` updated. |

Deliberately not added: Stripe `Idempotency-Key` on session/coupon creation.
Browsers never auto-retry the POST, and a replayed session would double the
gift-card ledger hold that is taken after the session exists.

### Content and search presence

| Finding | Fix |
| --- | --- |
| The Journal was switched off: two finished posts unpublished, `journal.html` noindexed and absent from `sitemap.xml`, `feed.xml` advertised with zero items, no structured data. | `enableJournal: true`. Build now emits `Blog` + `BlogPosting` JSON-LD on `journal.html` (empty when off). Feed has 2 items, page is in the sitemap and nav (product pages included -- their header template had no Journal slot), `llms.txt` lists the posts, the 404 rules for `/journal.html` and `/feed.xml` are gone from `netlify.toml`. |
| Switching it on surfaced a build bug: the injected nav link was `href="journal.html"` on `404.html`, which is served at any depth and must be root-absolute (C-5). | Root-absolute on `404.html`; `main.test.js` now asserts the link form instead of the marker being empty. |
| Zero `Review` structured data anywhere, on a site that owns 22 verified-buyer reviews. | Product JSON-LD carries up to 10 `Review` nodes from `site-reviews.json` for that product (9 product pages). |
| Homepage had only `LocalBusiness`. | `WebSite` with a `SearchAction` to `shop.html?q=…`, and the shop now honours `?q=`. |
| `social-feed.json` carried invented third-party handles on the shop's own studio photos, and one post captioned sleep salve pointed at the beard-salve photo. | All three are the shop's own posts; image fixed. The feed stays off until real customer content exists. |
| `seasonalNotice` said "Spring" over October dates; `logoDesktop` / `logoMobile` disagreed on a leading slash. | Fixed. |

### Front end

| Finding | Fix |
| --- | --- |
| Filter, concern, scent, sort and search never reached the URL: nothing on the shop could be shared, bookmarked or returned to with Back. | `syncShopUrl()` mirrors the toolbar with `replaceState` (armed after the first render so an arrival URL is never rewritten); `?sort=`, `?scent=`, `?q=` deep links validated against the controls. |
| PDP gallery: no swipe, no arrow keys, four tab stops per gallery. | Swipe on the photo, Arrow/Home/End across thumbnails. |
| Lightbox loaded the JPEG originals (≈2× the AVIF bytes on the most-used interaction), one static `alt` for every photo, no announcement on navigation. | Renders through `pictureHTML()` (AVIF/WebP via the manifest), per-photo alt naming the product and position, `aria-live` status. |
| `flex-wrap` at ≤360px sat on `.pdp-sticky-bar`, not the flex container. | Moved to `.pdp-sticky-inner`. |
| `syncStickyReserve` never cleared the phone reserve once the bar was `display:none` at ≥768px: ~100px dead space after a rotate. | Zero height clears it. |
| Concern filter row was `role="region"` (a landmark) for a set of buttons. | `role="group"`. |

Verified in a browser (Puppeteer, 20 assertions) plus the repo's own gates:
`npm test` (47 unit suites, verify-pdp-metadata, reproducibility, 1125 QA
assertions), `npm run test:smoke`, `extended_qa_test.js`, `puppeteer_tests.js`,
`challenger-r2-r5-adversarial.browser.test.js`, and `a11y-check.js` (zero
violations; the journal's incomplete budget now scales per post, as events
already did per button).

## 3. Still missing, in order of impact

These are the real distance to world class. None is a bug; each is a
capability the shop does not have. Effort is a guess; impact is not.

1. **Error monitoring and alerting -- nothing exists.** Every failure in
   `workers/` is a `console.error` into Cloudflare's ephemeral tail: the
   gift-card unwind that could not expire a session (`checkout.js`), a
   Resend outage, a webhook 500ing for Stripe's three-day retry window while
   paid-for gift cards go unsent, the tax probe failing open to "no tax". The
   careful "log loudly and let a human fix it" decisions throughout the
   Worker are only as good as someone reading the log. Cheapest real fix: a
   Worker `tail_consumers` or Logpush target plus one owner alert e-mail
   through the Resend helper that already exists, sent from the catch blocks
   that currently only log.
2. **Inventory is not authoritative and never decrements.** `stock` in
   `products.json` is the only count, nothing writes it back on sale, and the
   Etsy sync copies ratings only. The same jars sell on Etsy and here with no
   shared number, and a sell-out takes a CMS save → PR → merge → build → CDN
   → Worker 300s cache to take effect. The `GiftCardLedger` Durable Object is
   the pattern: reserve at session creation, decrement in the webhook, and an
   owner alert at zero.
3. **No staging, no previews, no rollback.** Every `main` commit goes
   straight to production bound to the live Stripe key. A test-mode Worker
   plus Cloudflare gradual deployments is cheap.
4. **Mobile shop is a wall of chips.** Nine category pills, six concern pills,
   two selects and a button before the first product; `.shop-toolbar`
   reserves 544-628px of `min-height` on phones. A single sticky
   "Filter (2) · Sort" row opening a bottom sheet is the highest-conversion
   change left on the site.
5. **No express checkout on the site.** Apple Pay / Google Pay / Link appear
   only on Stripe's hosted page. An express button on the PDP and in the
   drawer is the standard mobile-conversion lift.
6. **Product photography.** Seven of twenty products have no photo (five are
   coming soon; `miracle-balm` is on sale with none). The homepage hero is a
   catalog product shot, and there is no lifestyle imagery anywhere. The
   copy is distinctive; the imagery is not carrying it.
7. **Reviews are one-sourced and stale.** All 22 are Etsy imports, newest
   2026-06-16, thirteen products have none, no photo reviews. The
   post-purchase e-mail timers exist (`retention-emails.js`); a review ask
   with a photo upload is the missing piece.
8. **Journal posts are fragments.** `journal.html#post-<id>` is one page to a
   crawler; per-post pages (`/journal/<slug>.html`) with their own titles and
   `BlogPosting` are what makes the content investment rank.
9. **No customer accounts or order history.** `MAGIC_LINK_SECRET` and the
   loyalty ledger exist; a magic-link "your orders" page is small work.
10. **Shipped JS is unminified.** `main.js` is 475 KB (134 KB gzip) on every
    page, `cart.js` 142 KB, no bundler or minifier in the Netlify build.
    Adding a minify step in `netlify.toml`'s build command is a
    self-contained change; splitting the search index and cart off the
    homepage is the bigger win.
11. **Discount codes are invisible in the cart.** Captured as metadata only;
    the shopper learns whether a code works on Stripe's page, after the
    drawer total already lied.
12. **Design system.** 52 distinct `font-size` values and 143 `padding`
    shorthands in `styles.css`, no `--space-*` or `--font-size-*` tokens. The
    result is competent, not composed.

Out of scope by the shop's own decisions (subscriptions, wholesale, RTL
locales, hreflang) are documented in `docs/research-2026-09-01/` and
`PROJECT.md` and are not counted above.
