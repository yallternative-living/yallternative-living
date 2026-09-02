# Analytics for Y'allternative Living — options, privacy, and a recommendation

Scope: a one-person handmade body-care shop, static site on Netlify, Stripe via a Cloudflare Worker, low thousands of monthly visitors, mostly mobile. The site already ships an Umami-shaped adapter (`window.plausible()` → `umami.track()`) with four live call sites, but `site.umamiWebsiteId` is empty, so the tracking script never loads and nothing is collected. Researched 2026-09-01.

**Code facts used below** (read-only, from `assets/js/main.js`, `assets/js/cart.js`, `assets/js/thank-you.js`, `assets/js/translator.js`, `scripts/build-site-data.js`, `admin/config.yml`, `scripts/build-security-headers.js`):
- Events already firing (once an ID is set): `Newsletter Signup` (main.js:421), `Add to Cart` with a `product` prop (main.js:2552-2560), `Site Search` with `length` + `hasResults` props, debounced 1.5s, never the raw query (main.js:5142-5161), `Purchase` with a `revenue` prop on `thank-you.html` (thank-you.js:59-80), `Language Changed` (translator.js:358).
- `Purchase` is de-duplicated against double-firing on refresh/back via the Stripe `session_id` (regex-validated `cs_(live|test)_...`) written to `localStorage` (thank-you.js:33-69).
- CSP already allows the Umami Cloud script and beacon: `script-src ... https://cloud.umami.is` and `connect-src ... https://cloud.umami.is` (`scripts/build-security-headers.js:354,368`), plus a `preconnect` to `cloud.umami.is` on every page.
- The CMS (`admin/config.yml:761`) already has a validated `umamiWebsiteId` field; `scripts/build-site-data.js:2683-2705` conditionally injects `<script defer src="https://cloud.umami.is/script.js" data-website-id="...">` only when that field is non-empty — so turning analytics on is a content-only change, not a code change.
- `privacy.html` already contains accurate, pre-written Umami disclosure copy, conditioned on whether the ID is set.
- **A real bug**: the `Purchase` event sends `props: { revenue: { currency, amount } }` — a nested object. Umami's revenue report expects a **flat** `data.revenue` (number) and `data.currency` (ISO 4217 string), e.g. `{ revenue: 42.50, currency: "USD" }` [Umami docs via search cache, accessed 2026-09-01]. As shipped, `data.revenue` is an object, not a number, so it will not populate Umami's built-in Revenue report even after the website ID is set. See §6 for the fix.

---

## 1. Options and 2026 pricing/limits

| Tool | Free tier | Paid entry | Cookieless / no banner | Revenue & funnels | Notes for this site |
|---|---|---|---|---|---|
| **Umami Cloud** | 100,000 events/mo, 3 sites, 6-month retention (Hobby, forever-free) [toolradar.com, freetier.co, canivibecodeit.com — accessed 2026-09-01] | $20/mo → 1M events/mo, unlimited sites, 5-yr retention, overage $0.00002/event | Yes — no cookies, no fingerprinting | Yes — native Revenue report (flat `revenue`+`currency` props) and closed sequential Funnel reports [search-cached Umami docs, accessed 2026-09-01] | Already wired into this site's code and CSP. Only the ID is missing. |
| **Umami self-hosted** | Free (MIT license), unlimited events — you pay hosting | ~$5/mo VPS (Node 18+, Postgres/MySQL) [hjerpbakk.com, yashagarwal.in — accessed 2026-09-01] | Yes | Same feature set as Cloud | Does **not** run natively on Cloudflare Workers (needs a Node server, not a V8 isolate) — Workers can only act as a *proxy* in front of a real host [github.com/umami-software/umami discussion, accessed 2026-09-01]. Extra moving part (DB backups, upgrades) for a one-person shop — not worth it while Cloud's free tier covers the traffic. |
| **Plausible** | None (7-day trial only) | $9/mo for 10K pageviews, $19/mo at 100K, $69/mo at 1M [seline.com, saaspricehub.io — accessed 2026-09-01]; pricing counts pageviews *and* custom events combined | Yes | Revenue goals and funnels on paid plans | No free tier at all — a real recurring cost for a hobby-scale shop. |
| **Fathom** | None (14-day trial only) | $15/mo at 100K pageviews [tldv.io, checkthat.ai — accessed 2026-09-01] | Yes | Goals with revenue value | Priced similarly to Plausible; no meaningful advantage over Umami Cloud's free tier here. |
| **Cloudflare Web Analytics** | Free, unlimited, forever | — | Yes — Performance-API beacon, "does not store any data in the browser or access storage data, cookies, IP, localStorage, IndexedDB" [developers.cloudflare.com/web-analytics/about, /faq — accessed 2026-09-01] | **No** custom/conversion events — "Not yet, but we may add support in the future" per Cloudflare's own FAQ [developers.cloudflare.com/web-analytics/faq — accessed 2026-09-01] | Works without proxying the whole site through Cloudflare's DNS — just the JS beacon. Fine as a free pageview cross-check, cannot replace event tracking. |
| **Netlify Analytics** | None | $9/site/mo, up to 250K pageviews [netlify.com press release, docs.netlify.com — accessed 2026-09-01] | Yes — server-side, reads Netlify's own edge logs, immune to ad blockers | No custom events, no revenue | $108/yr for pageview counts you can get free elsewhere; only edge worth it is ad-blocker-proof raw traffic, which Search Console + Cloudflare beacon already approximate for free. |
| **GA4** | Free, effectively unlimited for a site this size | — | **No** — sets cookies (`_ga`, `_ga_*`) by default; needs consent in EU/UK; Consent Mode v2 required for EEA ad/remarketing signals since March 2024, enforced from July 21 2025 [usercentrics.com, mbadv.agency — accessed 2026-09-01] | Yes — full e-commerce funnels, revenue, best-in-class reporting | Free and powerful, but the wrong tool for a "privacy-conscious brand voice" site — it's the exact banner-and-tracking experience this shop is positioned against. |
| **PostHog** | Free tier exists (product analytics, session replay, feature flags) [posthog.com pricing, via search cache — accessed 2026-09-01] | Usage-based beyond free tier | Cookie-based by default (session ID persisted); can be configured cookieless | Yes — full funnels, revenue via event properties | Built for product/SaaS teams; heavier than a static shop needs, and its default cookie behavior reintroduces the consent question this site is trying to avoid. |
| **Simple Analytics** | None | Paid only | Yes | Goals, limited revenue | No free tier; no functional edge over Umami Cloud's free plan for this traffic level. |

Volume check for this site: "low thousands of monthly visitors" with ~2-4 pageviews + occasional custom events each lands well under 10,000-30,000 events/month — comfortably inside Umami Cloud's 100,000/month free ceiling with headroom to spare.

## 2. Privacy: consent requirements, IP handling, ad-blocker exposure, residency

**Cookieless tools (Umami, Plausible, Fathom, Cloudflare Web Analytics) and consent law.** PECR/ePrivacy consent (UK and EU) is triggered by *storing or accessing information on the visitor's device* — cookies, localStorage, fingerprinting. A tool that does none of that falls outside Regulation 6 entirely: "cookieless analytics tools avoid PECR cookie rules because they do not store anything on the visitor's device — no cookies, no local storage, no device fingerprinting" [ICO guidance, summarized via usercentrics.com/cookiechimp.com, accessed 2026-09-01]. Separately, even cookie-based analytics can qualify for a narrower exemption (France's CNIL "audience measurement" exemption, UK's "statistical purposes" exception) if it's first-party, aggregate-only, capped at 13-month cookie life / 25-month data retention, not cross-referenced with other data, and disclosed in a privacy policy [cnil.fr "Sheet n°16", captaincompliance.com — accessed 2026-09-01]. Umami/Plausible/Fathom/Cloudflare Web Analytics don't even need that exemption — they're cookieless by design. Under **US state laws** (CCPA/CPRA, etc.), these tools generally don't count as "sale/sharing" of personal information since they collect no persistent identifiers or cross-site tracking; no consent banner is triggered.

**GA4 is the odd one out.** It sets first-party cookies and is built for cross-session/cross-device identity resolution, so it needs an EU/UK consent banner before firing, plus Google's Consent Mode v2 wiring since March 2024 (enforced from July 2025) if you want any EEA ad/remarketing signal at all [usercentrics.com — accessed 2026-09-01]. GA4 anonymizes IP by default (last IPv4 octet zeroed, coarse geo derived then the raw IP discarded before EU logging) [graphed.com, bounteous.com — accessed 2026-09-01], and the 2023 EU-US Data Privacy Framework resolved the earlier Austria/France/Italy/Denmark/Finland/Norway/Sweden rulings that GA4's US data transfer was illegal — but seven national DPAs had ruled against it, and even under the DPF, consent is still required for the cookie itself [swetrix.com, plausible.io/blog — accessed 2026-09-01]. That's a banner and a legal footnote this shop doesn't currently carry anywhere else on the site.

**Do server-side tools dodge ad blockers?** Netlify Analytics reads edge logs server-side, so yes — ad blockers can't touch it. Cloudflare Web Analytics is still a client-side JS beacon (just a privacy-safe one), so it can still be blocklisted, though at much lower rates than GA. Umami/Plausible/Fathom are also client-side scripts and share that exposure (see §4).

**Data residency.** Umami Cloud's own FAQ describes both US and EU processing but no EU-only cloud tier — infrastructure spans Vercel (US), Cloudflare (US CDN), ClickHouse (US/EU), Hetzner (EU secondary) [docs.umami.is/docs/cloud/faq, via search cache — accessed 2026-09-01; note: docs.umami.is and umami.is did not resolve from this research environment, so this is secondary-sourced]. For strict EU-residency requirements the vendor's own answer is self-hosting. That's not a live concern for a US-based one-person shop.

## 3. What to actually measure, and revenue attribution

For a shop this size, five events earn their keep; three more (search, checkout start, pop-up) are situational. Ranked by decision value:

1. **Add to Cart** (already live) — earliest buying-intent signal, tells you which products people *want*, independent of whether checkout completes.
2. **Purchase, with revenue** (already live, needs the schema fix in §6) — the only number that matters for "is this working." Fire it from the thank-you page (client-side, analytics-only, already de-duplicated by `session_id`) but **never treat it as the ledger** — see below.
3. **Checkout Start** (missing) — fire when the cart hands off to Stripe Checkout (in `workers/checkout.js` client call, or in `cart.js` at the "Checkout" button click). Without it you can't compute a cart→checkout→purchase funnel or know whether people are abandoning at Stripe's page vs. never reaching it.
4. **Site Search, zero-results flagged** (already live via `hasResults: false`, no new event needed) — tells you what people are looking for that the catalogue doesn't answer; a `hasResults=false` filter *is* the zero-results report.
5. **Newsletter Signup** (already live) — the durable, non-cookie retention channel; the actual audience asset this shop owns.
6. **Product View** (missing, lower priority) — useful for a "browsed but never added to cart" funnel step, but adds an event on every shop page load; only worth it once Add-to-Cart and Purchase volumes are established as a baseline (see §6 — start without it).
7. **Pop-up / market page views + pickup selection** (missing, if this shop does in-person markets or local pickup) — a `data-umami-event="Pickup Selected"` click handler on the pickup/location picker, same pattern as Add to Cart.
8. **Review submission** (missing, if `reviews.html` has a submission form) — one event on successful submit; low volume, but shows whether the review ask actually converts.

**UTM discipline.** Umami (like Plausible/Fathom/GA4) parses standard `utm_source`/`utm_medium`/`utm_campaign` query params automatically into a Campaigns report — no code needed, just discipline on the *outbound* links: the Etsy shop bio link, the Instagram bio link, and printed market QR codes should each carry a distinct `utm_source` (e.g. `etsy`, `instagram`, `market-qr`) and a stable `utm_campaign` per specific promotion, set once and never mixed with hand-typed variants (`Instagram` vs `instagram` vs `ig` fragment the report). A link-shortener or a static redirect page per channel avoids the fat-finger risk of hand-typing query strings on a phone at a market.

**Revenue attribution when Stripe Checkout is hosted off-site.** This is already handled reasonably in `thank-you.js`, but the mechanism has a real ceiling: the thank-you-page event is a *client-side, best-effort analytics signal* — it fires only if the browser reaches the thank-you page with JS running and an intact `session_id`, and it undercounts relative to reality whenever a tab is closed before the redirect completes, an ad blocker eats the Umami request, or `localStorage` is unavailable (private browsing). The `session_id` dedup (regex-validated `cs_(live|test)_...`, checked against `localStorage`) correctly prevents *double*-counting on refresh/back, but it cannot prevent *under*-counting, and it has no visibility into refunds or failed webhooks. **Stripe's own Dashboard (webhook-backed, server-side) is the source of truth for revenue reconciliation; the Umami Purchase event is directional only** — good for "is this campaign working" trend lines, not for bookkeeping. Never let the analytics number and the Stripe number silently diverge without noticing — check both in the weekly routine (§5).

## 4. Reliability

**Ad-blocker exposure by tool**, roughly consistent across the sources checked: GA4 sees 15-30% of visitors blocked outright (up to ~58% on tech-heavy audiences, per the widely-cited Plausible/Hacker News study) because EasyList/EasyPrivacy specifically target Google's tracking domains. Privacy-first tools (Umami, Plausible, Fathom) are blocked far less often because they set no cookies and feed no ad network, but their *default* shared script domain (`cloud.umami.is`, `plausible.io/js/script.js`) can still be caught by aggressive blocklists [dev.to/alanwest, getsleek.io, kissmetrics.io — accessed 2026-09-01].

**Proxying through your own domain**: the standard mitigation — point a subdomain or path (`stats.yourdomain.com`, or a same-origin `/js/script.js` rewrite) at the vendor's script via a reverse proxy — is explicitly documented by Umami itself ("Bypass ad blockers," `docs.umami.is/docs/bypass-ad-blockers`, referenced via search cache) and by community Cloudflare Worker proxies [github.com/elliott-diy/Umami-Proxy — accessed 2026-09-01]. It's a supported pattern, not a ToS gray area, for both self-hosted and Cloud. For this site specifically it would mean either a Netlify redirect/rewrite rule proxying `/stats.js` → `cloud.umami.is/script.js`, or a small Cloudflare Worker doing the same — a nontrivial addition to a static site that currently has zero server-side proxying for analytics. Not worth it at launch; worth revisiting only if the blocked-visitor gap actually matters once real numbers exist.

**CSP implications**: none outstanding. `scripts/build-security-headers.js` already whitelists `https://cloud.umami.is` in both `script-src` and `connect-src`, and every page already carries a `preconnect` to it — this was clearly built for Umami Cloud specifically and is ready to go without touching the CSP. If a proxy is added later, `connect-src`/`script-src` shrink to `'self'` for that path instead — a strict-CSP improvement, not a complication.

## 5. Complementary free data (no analytics tool needed)

- **Google Search Console** (free) — which queries bring people in, click-through rate, indexing errors; check weekly, it's the earliest signal of an SEO problem.
- **Bing Webmaster Tools** (free) — same idea for Bing/Copilot traffic; can import the Search Console sitemap directly, ~10 minutes to set up once [skycodetalks.com, cadrant.ai — accessed 2026-09-01].
- **Stripe Dashboard** (free, already the system of record) — revenue, refunds, payment failures, disputes; this is the number that reconciles against the Purchase event, not the other way around.
- **Etsy Stats** (free, if Etsy is a sales channel) — views, favorites, conversion rate on that storefront, independent of the main site.
- **Instagram Insights** (free, if used) — reach, profile visits, link-in-bio taps; pairs with the `utm_source=instagram` discipline above.
- **Kit (ConvertKit) reports** (free tier includes basic reporting) — open/click rates on the newsletter, which is the retention channel Newsletter Signup is feeding.

**A 15-minute weekly routine**: Monday morning — Stripe Dashboard for the week's revenue and any failed/disputed payments (2 min) → Umami overview for visitors, Add to Cart, Purchase counts and the Campaigns/UTM breakdown (5 min) → Site Search report filtered to `hasResults=false` for "what are people asking for that we don't sell" (3 min) → Search Console performance tab for any ranking or indexing surprise (3 min) → Kit open/click trend (2 min). Skip Etsy/Instagram unless those channels are active that week.

## 6. Recommendation for this site

**Keep Umami Cloud.** Everything is already built for it — the adapter, the CSP, the conditional script injection, the CMS field, the privacy-policy copy. The free Hobby tier (100K events/month, 6-month retention) covers this traffic with a wide margin, and the code already assumes Umami's event shape. Switching tools would mean rewriting five call sites and the CSP for no functional gain — Plausible and Fathom cost real money for the same feature set, Cloudflare Web Analytics can't do custom events, GA4 reopens the consent-banner question this brand is positioned against.

**Setup steps:**
1. Sign up at Umami Cloud, create a site, get the Website ID (a UUID).
2. Paste it into the `Website analytics ID` field in the Sveltia CMS (`admin/config.yml:761`, backed by `content.json`'s `site.umamiWebsiteId`) — do **not** hand-edit the HTML comments; `scripts/build-site-data.js` regenerates the `<script>` tag from that one field across every page.
3. Confirm `scripts/main.test.js:1601-1605` passes post-deploy — it already asserts the privacy-policy Umami copy only appears once the ID is real (not the placeholder `YOUR_UMAMI_WEBSITE_ID`).
4. **Fix the revenue bug before relying on the Revenue report.** In `assets/js/thank-you.js:71-79`, change:
   ```js
   window.plausible("Purchase", {
     props: { revenue: { currency: currency, amount: amount } }
   });
   ```
   to a flat shape matching Umami's expected `data.revenue` (number) / `data.currency` (string):
   ```js
   window.plausible("Purchase", {
     props: { revenue: amount, currency: currency }
   });
   ```
   This is a one-line, low-risk change — the adapter and dedup logic don't need to move.
5. Add a **Checkout Start** event where the cart hands off to Stripe (in `cart.js`'s checkout-button handler, mirroring the existing Add to Cart pattern) so the Add to Cart → Checkout Start → Purchase funnel is measurable from day one.
6. Leave Product View, pickup-selection, and review-submission events for later — add them only if/when the pop-up/market or reviews features are active and the baseline events show a gap worth filling. Instrumenting everything on day one produces a dashboard nobody reads.
7. No CSP change needed. No self-hosting, no proxy, no consent banner.

**What to keep as-is:** Add to Cart, Site Search (already privacy-scrubbed to length + hasResults, don't add the raw query), Newsletter Signup, Language Changed (low-value but harmless, no reason to remove).

**What to add, in order:** Checkout Start (now) → the revenue-schema fix (now) → Product View / pickup / review events (later, only if a specific decision needs them).

**Cost per year: $0.** Umami Cloud's free Hobby tier, Search Console, Bing Webmaster Tools, and Stripe's built-in reporting are all free at this traffic level. The only paid alternative that would functionally match this setup (Plausible or Fathom, ~$9-19/mo) would cost roughly **$108-228/year** for capability the site already has wired up for free — not worth it unless the free tier's 100K-event ceiling is actually approached, which would itself be a good problem (it implies real traffic growth).

---

### Sources
- [Umami Pricing 2026: Plans, Hidden Costs & Cheaper Alternatives](https://toolradar.com/tools/umami/pricing) — accessed 2026-09-01
- [Umami free tier - 100K Events Free](https://freetier.co/directory/products/umami) — accessed 2026-09-01
- [Umami Cloud pricing 2026: plans, free tier, and our verdict](https://canivibecodeit.com/umami-cloud) — accessed 2026-09-01
- [Umami vs Plausible: why I switched — Loopwerk](https://www.loopwerk.io/articles/2026/umami-vs-plausible/) — accessed 2026-09-01
- [Self-hosting Umami with Cloudflare, Fly, and Supabase](https://hjerpbakk.com/blog/2026/07/11/self-hosting-umami) — accessed 2026-09-01
- [Self-hosting Umami with Cloudflare Workers as Proxy](https://www.yashagarwal.in/notes/self-hosting-umami-with-cloudflare-workers-as-proxy/) — accessed 2026-09-01
- [umami-software/umami discussion #1026 — Cloudflare Worker ad-blocker bypass](https://github.com/umami-software/umami/discussions/1026) — accessed 2026-09-01
- [elliott-diy/Umami-Proxy — Cloudflare Workers proxy](https://github.com/elliott-diy/Umami-Proxy) — accessed 2026-09-01
- [Plausible Analytics Pricing: How Much Does Plausible Cost in 2026?](https://seline.com/blog/plausible-analytics-pricing) — accessed 2026-09-01
- [Plausible pricing 2026 — $9/mo, 4 plans](https://saaspricehub.io/tools/plausible) — accessed 2026-09-01
- [Do ad blockers block Plausible Analytics? — Plausible](https://plausible.io/blog/do-ad-blockers-block-plausible-analytics) — accessed 2026-09-01 (title/summary via search cache; direct fetch blocked in this environment)
- [Is Google Analytics illegal? Several European DPAs say so — Plausible](https://plausible.io/blog/google-analytics-illegal) — accessed 2026-09-01
- [Fathom Pricing: Is It Worth It in 2026?](https://tldv.io/blog/fathom-cost/) — accessed 2026-09-01
- [Fathom Pricing 2026: Plans, Costs & Comparison](https://checkthat.ai/brands/fathom/pricing) — accessed 2026-09-01
- [Cloudflare Web Analytics · docs](https://developers.cloudflare.com/web-analytics/about/) — fetched directly 2026-09-01
- [Cloudflare Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/) — fetched directly 2026-09-01
- [Web Analytics usage and billing | Netlify Docs](https://docs.netlify.com/manage/monitoring/web-analytics/usage-and-billing/) — fetched directly 2026-09-01
- [Netlify Analytics press release](https://www.netlify.com/press/netlify-analytics-delivers-comprehensive-privacy-focused-web-traffic-analysis-with-no-performance-overhead/) — accessed 2026-09-01
- [Google's March Deadline for Consent Mode & Ads Privacy Compliance — Usercentrics](https://usercentrics.com/knowledge-hub/googles-march-deadline-for-consent-mode-and-ads-privacy-compliance/) — accessed 2026-09-01
- [Consent Mode v2 in GTM: Signals, Setup and EEA Compliance](https://www.mbadv.agency/google-tag-manager/consent-mode-and-privacy) — accessed 2026-09-01
- [Google Tag Platform: Consent guide](https://developers.google.com/tag-platform/security/guides/consent) — fetched directly 2026-09-01
- [Does Google Analytics 4 Anonymize IP Addresses by Default? — Graphed](https://www.graphed.com/blog/does-google-analytics-4-anonymize-ip-addresses-by-default) — accessed 2026-09-01
- [IP Addresses and Google Analytics 4 — Bounteous](https://www.bounteous.com/insights/2023/09/14/ip-addresses-and-google-analytics-4-what-you-should-know/) — accessed 2026-09-01
- [Is Google Analytics 4 GDPR Compliant in 2026? — Swetrix](https://swetrix.com/blog/is-google-analytics-4-gdpr-compliant) — accessed 2026-09-01
- [ICO PECR Cookies Guidance: Compliance Explained for 2026 — Usercentrics](https://usercentrics.com/knowledge-hub/ico-pecr-cookie-guidance/) — accessed 2026-09-01
- [Do Analytics Cookies Require Consent? The 2026 Answer — CookieChimp](https://cookiechimp.com/blog/do-analytics-cookies-require-consent) — accessed 2026-09-01
- [Sheet n°16: Use analytics on your websites and applications — CNIL](https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications) — accessed 2026-09-01 (found via search cache; direct fetch of ICO's own cookie guidance returned HTTP 403 to this tool)
- [CNIL Clarifies When Analytics Cookies Can Be Used Without Consent — Captain Compliance](https://captaincompliance.com/education/cnil-clarifies-when-analytics-cookies-can-be-used-without-consent/) — accessed 2026-09-01
- [Ad Blockers and Analytics: How Much Traffic You Lose — Kissmetrics](https://kissmetrics.io/blog/ad-blocker-analytics-impact) — accessed 2026-09-01
- [Google Analytics Alternatives: Umami vs Plausible vs Fathom in 2026 — DEV](https://dev.to/alanwest/google-analytics-alternatives-umami-vs-plausible-vs-fathom-in-2026-280i) — accessed 2026-09-01
- [Umami revenue/funnel/event-properties feature references (Track events, Revenue, Funnel guide, Reports) — docs.umami.is](https://docs.umami.is/docs/revenue) — content via search cache only; **docs.umami.is and umami.is did not resolve from this research environment** (DNS failure on every attempt), so these specific claims (event payload shape, Cloud FAQ on data residency, bypass-ad-blockers guide) are secondary-sourced and should be spot-checked against the live docs before shipping the schema fix in §6.
- Codebase (read-only): `assets/js/main.js`, `assets/js/cart.js`, `assets/js/thank-you.js`, `assets/js/translator.js`, `scripts/build-site-data.js`, `scripts/build-security-headers.js`, `admin/config.yml`, `privacy.html`, `scripts/main.test.js` — inspected 2026-09-01.
