# Report D -- Content pages customer-readiness audit

Scope: about, contact, events, faq, journal, reviews, policies, privacy, terms (localhost:8090, working tree, production CSP). Date assumed 2026-09-01.
Tooling: Puppeteer headless (desktop 1280x800 + iPhone 13 emulation; iPhone SE / Pixel 5 spot-checks), axe-core 4.x (wcag2a/2aa/21aa/22aa/best-practice), request interception (every non-GET to a non-localhost host was aborted; Formspree "success" was verified by *mocking* a 200 -- no real submission was ever sent; interception logs confirm `POST https://formspree.io/f/xoeqevqv` and `POST https://formspree.io/f/xzebezbl` were the only outbound POSTs and both were blocked/mocked).
Evidence dir: `/private/tmp/claude-502/-Users-steven-Documents-GitHub-yallternative-living/46c3c05a-857d-458b-94e9-ee5b588530ed/scratchpad/agentD/` (referred to as `agentD/` below). Raw data: `agentD/audit-results.json`, `agentD/behaviours.json`, `agentD/round3.json`. Scripts: `agentD/audit.js`, `behaviours.js`, `round3.js`, `mobilehdr.js`.

Environment noise (not site bugs, filtered out below): tawk.to embed script is refused by CORS for a `localhost` origin (`embed.tawk.to/...` -> `net::ERR_FAILED`) on every page; `/api/*` is 503 locally by design.

---

## BLOCKERS

### B1. events.html: "Reserve / Pick Up at This Booth" on PAST markets pre-selects Free Local Pickup at a booth that no longer exists (also accepts any arbitrary slug)
- Page/viewport: events.html, desktop + mobile (identical markup).
- Repro: load `/events.html`. Under "Recent Appearances" every past card (Spartanburg Punk Flea Market, ended 2026-08-30; Gothic Punk Night Market 2026-08-21; Summerville 2026-08-15; and all 7 after "See All Past Pop-ups") has an outlined button "Reserve / Pick Up at This Booth" -> `shop.html?pickup_market=spartanburg-punk-flea-market#shop-catalog`. Clicking it lands on the shop with a banner **"Pre-order booth pickup activated: spartanburg-punk-flea-market (Free Local Pickup pre-selected)"** and the cart's pickup checkbox is checked. `shop.html?pickup_market=not-a-real-market` produces the same banner ("...activated: not-a-real-market ...").
- Why blocker: a shopper can complete a paid order with $0 "local pickup" fulfilment at a market that already happened (or that never existed). Past cards also show the raw slug rather than the market name, because only `upcoming` names are resolved.
- Evidence: `agentD/events-desktop.png` (past cards with the button), `agentD/events-all-past.png`, `agentD/events-past-reserve-click.png`, `agentD/shop-pickup-spartanburg-punk-flea-market.png`, `agentD/round3.json -> pickup`.
- Suspected: `assets/js/main.js:4408-4470` (`eventCardHTML` emits the pickup/calendar/ics buttons unconditionally for every event, used for past cards at :3862 and :3908); `assets/js/main.js:4335-4375` (`handlePickupMarketDeepLink` never checks that the slug is an *upcoming* event -- `parsePickupMarketParam` falls through to `{matchedLabel: decoded, marketName: decoded}` at ~:4330).

---

## MAJOR

### M1. Mobile header: brand wordmark collides with the icon cluster on every page (390-393px)
- Page/viewport: all 9 pages (shared header), iPhone 13 (390px) and Pixel 5 (393px). Not at 320px (wordmark is hidden there).
- Repro: open any page at 390px. "Y'allternative" text runs underneath the wishlist-heart button. Measured: `.brand-word` right edge = 150px, first `.nav-cta` control left edge = 114px -> **36px overlap** (33px on Pixel 5).
- Evidence: `agentD/faq-mobile-header.png` (crop), `agentD/faq-mobile.png`, `agentD/events-mobile.png`, `agentD/reviews-mobile.png`, `agentD/contact-mobile.png`, `agentD/about-mobile.png` (all show "Y'allternat[icon]"). Numbers in `mobilehdr.js` output (in transcript).
- Suspected: `assets/css/styles.css:621` (`.brand-word` -- `white-space: nowrap`, `overflow: visible`); the breakpoint that hides it fires only <=320px-ish. The header markup is identical across pages (e.g. `contact.html:152-156`).

### M2. reviews.html: after a successful submission the review form disappears and NO confirmation is shown
- Page/viewport: reviews.html, desktop (same DOM on mobile).
- Repro: fill name + review, submit with Formspree mocked to `200 {ok:true}` (CORS headers added). `.review-form-wrap` gets `is-submitted`, the form goes `display:none`, but there is no `.review-form-confirm` element on this page, so the wrap collapses to just the heading "Used Our Goods? Leave a Review" + intro paragraph (wrap height 768px -> 242px). A customer cannot tell whether the review went through.
- Evidence: `agentD/reviews-mock-success.png`, `agentD/round3.json -> reviewsMock` (`submitted:true, confirmEl:false`).
- Suspected: `reviews.html:152-196` -- the `.review-form-wrap` lacks the `<p class="review-form-confirm">` that `shop.html:1309` has; CSS `assets/css/styles.css:1779-1786` expects it. Handler: `assets/js/main.js:495-547`.

### M3. reviews.html hero claims "4.9 out of 5 (30+ Verified Reviews)" while the page itself renders 12 reviews averaging 4.5, only 8 marked Verified Buyer
- Page/viewport: reviews.html, both.
- Repro: hero `.rating-text` = "**4.9 out of 5** (30+ Verified Reviews · 100% Handcrafted)". Grid renders 12 cards from `assets/data/site-reviews.json` (count matches the file), ratings 5,5,5,4,5,4,5,4,5,5,4,3 -> mean **4.5**; 8/12 have `verifiedBuyer:true`; 3 are labelled "(Etsy)". The 4.9/32 figure is the Etsy shop rating (`products.json shop.rating/reviewCount`), which index.html attributes to Etsy ("32 Etsy reviews") but reviews.html presents as on-site "Verified Reviews".
- Evidence: `agentD/reviews-desktop.png`, `agentD/behaviours.json -> reviews.render` (avg 4.5, verified 8).
- Suspected: `reviews.html:113` (hard-coded string); source of truth `assets/data/products.json shop.rating=4.9, reviewCount=32` vs `assets/data/site-reviews.json` (12 entries).

### M4. privacy.html describes infrastructure and forms that do not match what shipped
- Page/viewport: privacy.html, both.
- Observed vs repo:
  1. "After you pay, Stripe notifies a second small service of ours running on **Netlify Functions**, which is what issues gift card codes..." and "**Netlify** -- hosts this site, and runs the functions that issue gift card codes" (`privacy.html:213`, `:252`). `netlify.toml:35-37` says: "The Netlify Functions this site used to run are gone -- the money path is one Cloudflare Worker now (workers/checkout.js)"; the webhook is `workers/routes/stripe-webhook.js`, the ledger is D1 (`workers/state/`, commit b1cb8aa).
  2. "**Product review form** (on a product's page in the shop)" (`privacy.html:~200`): none of the 19 `products/*.html` contain a `<form>` (grep = 0). The only product review form is on `shop.html:1310`.
  3. "Every form on this site is listed here ... nothing is left off it" -- the **order-status lookup** (`shop.html:1437 #orderStatusForm`, `order-status.html:122`, posts `{sessionId,email}` to `/api/order-status`, `main.js:3311-3328`) and the **gift-card balance check** (`shop.html:1242 #giftCardBalanceForm`) are not listed.
  4. "Last updated: **September 2, 2026**" -- one day in the future relative to today (2026-09-01) (`assets/data/content.json privacy.lastUpdated`).
  5. Minor wording: "recognise" (British spelling) in the live-chat paragraph.
- Evidence: `agentD/privacy-desktop.png`, `agentD/privacy-mobile.png`; repo greps in transcript.
- Suspected: `privacy.html:205-260`, `assets/data/content.json:141`.

### M5. reviews.html is orphaned and carries a stale hand-copied footer
- Page/viewport: reviews.html, both.
- Repro: no `<a href="...reviews.html">` exists in the header, nav or footer of any of the 9 audited pages or index/shop (grep: only `reviews.html` itself, `order-status.html` and `sitemap.xml` link to it). Its footer differs from the shared `assets/data/footer.html`: tagline "Small-batch handmade goods from Landrum, SC..." vs "Handmade self-care for the black sheep & bold hearts...", extra links "Pop-Up Events" / "Customer Reviews", and the brand block renders as "Y'allternativeLiving" (no space).
- Cause: `scripts/build-site-data.js:2095-2108` injects `footer.html` into a fixed list of 13 pages that omits `reviews.html` (and `order-status.html`), so those two drift.
- Evidence: `agentD/reviews-desktop.png` vs `agentD/faq-desktop.png` footers; `audit-results.json -> footerExplore`.

### M6. events.html: upcoming event's "More Info / RSVP" button opens the shop's own homepage
- Page/viewport: events.html, both.
- Repro: Autumn Apothecary Faire card -> primary button "More Info / RSVP" -> `https://yallternativeliving.com/` in a new tab. That is this site. The countdown banner also links nowhere.
- Evidence: `agentD/events-desktop.png`, `behaviours.json -> events.upcoming[0].links`.
- Suspected: `assets/data/events.json` upcoming[0].url = "https://yallternativeliving.com" (CMS data); `main.js:4444-4449` renders any `url` as RSVP.

### M7. Past-event cards offer "Add to Google Calendar" / "iCal" for dates that have passed
- Page/viewport: events.html, both. All 7 past cards (3 in carousel, 7 after "See All Past Pop-ups (7)") carry calendar buttons; the .ics DTSTAMP/DTSTART are the past dates (e.g. 20260815).
- Evidence: `agentD/events-all-past.png`; link list in `audit-results.json` (data:text/calendar hrefs).
- Suspected: `assets/js/main.js:4408` (`eventCardHTML` shared by upcoming and past).

---

## MINOR

1. **events.html duplicate heading** -- `H3 "Autumn Apothecary Faire"` appears twice (countdown banner + card). `main.js:5983-5986` and `:4423`. Evidence `audit-results.json -> dupHeadings`.
2. **events.html ZIP/pickup note** -- the upcoming event's `zip: "29356"` is never displayed; it only feeds the Maps URLs, whose destination is `"Autumn Apothecary Faire, Landrum, SC, 29356"` (venue name, not a street address -- Google may not resolve it). Past cards with a street address in `note` do get a proper destination. `main.js` `generateGoogleMapsDirUrl`.
3. **Search deep-links to `events.html#<event-id>` but cards have no `id`** -- `assets/js/search-data.js:1381-1441` emits `events.html#autumn-apothecary-faire`, `#landrum-farmers-market`, etc. Rendered events page has no such ids (`round3.json -> eventIds`: only `toggleAllPastEvents`), so the page lands at the top; for the 4 older past events the target is not even visible until "See All Past Pop-ups" is clicked. Fix in `eventCardHTML` (`main.js:4417`).
4. **faq.html is plain prose, not an accordion** -- 7 `h2`+`p` blocks, no `<details>`/buttons/`aria-expanded`, no ids, so no open/close, keyboard toggling or hash deep-linking exists (`/faq.html#...` stays at scrollY 0). Not a bug per se, but the "accordion" behaviours in the brief are N/A. FAQ JSON-LD **does** match visible Q/A exactly (7/7 questions and answers; `behaviours.json -> faq.qMatch/aMatch = true`) and `products.json.faq` is the single source.
5. **reviews.html / order-status.html theme-toggle moon icon is broken** -- console `Error: <path> attribute d: Expected arc flag ... "… 0 0 9 9 9 0 1 1-9-9Z"`, `getBBox()` = 0x0, so the dark-mode knob has no icon. `reviews.html:95` and `order-status.html:96` have `a6 6 0 0 0 9 9 9 0 1 1-9-9Z`; every other page has the correct `...9 9 9 9 0 1 1-9-9Z` (another symptom of the page not being generated). Evidence `behaviours.json -> reviewsMoon`.
6. **CSP console error on every page**: `Connecting to 'https://fonts.googleapis.com/css2?...' violates ... connect-src`. Fonts still load (`document.fonts.check` true, headings render in Gloock), so it is cosmetic, but it appears with the production CSP. Head markup `privacy.html:33-39` (preload + `media="print"` swap) is identical on all pages; `connect-src` in `_headers`/`netlify.toml`/`vercel.json` omits fonts.googleapis.com. I could not pin the exact initiator (not sw.js -- it only intercepts same-origin).
7. **Contact form has no honeypot** (`contact.html:212-227`) while the review/newsletter forms do; email validation is browser-native only (`a@b` passes; `not-an-email` is rejected with the native message). No phone / hours are shown (only "We typically respond within 24-48 hours") -- consistent with content.json.
8. **Review form client honeypot check is dead** -- `main.js:498` looks for `input[name="review_website"]` but `reviews.html:159` names it `_gotcha` (Formspree handles `_gotcha` server-side, so spam is still caught, but the early return never fires here). Honeypot itself is correctly off-screen (`.form-hp` at left:-999px, `styles.css:2078`).
9. **policies.html has no "Last updated" line** while terms (July 18, 2026) and privacy (Sept 2, 2026) do; `content.json` has no `policies.lastUpdated`.
10. **Mobile footer brand shows only "Y'allternative"** -- the footer only contains `.logo-desktop` (hidden on mobile) and `<small>Living</small>` is `display:none` on mobile, so the footer brand reads "Y'allternative" with no logo (`assets/data/footer.html:6-8`). Evidence `agentD/faq-mobile.png` footer.
11. **Footer "Shop" links use hashes that are not ids** -- `/shop.html#apparel|#salves|#body|#soaks|#potions|#ritual|#gift-cards` (7 links on every page). No element with those ids exists on the rendered shop page; `main.js:5164` treats the hash as a category filter, which does activate the right pill, but the page stays at scrollY 0 (filter row is below the fold on mobile). Works, just not as an anchor.
12. **terms.html copy**: stray comma in "your content (not including credit card information), may be transferred" (`terms.html:~171`). **about.html / events.html** use a spaced hyphen where an em-dash is meant ("mixed for you - not for a demographic", "lands first - no digging") -- house style elsewhere uses "—".
13. **journal.html** is reachable and renders "Journal Coming Soon" (flag `enableJournal:false`; `noindex,follow`; not in nav/sitemap/llms.txt; `journal.json` has 2 drafted posts that are not shown). `#post-id` and `?post=` deep links also show the placeholder. Global search does not surface journal posts (good). The "coming soon" text is the only placeholder-pattern hit across all 9 pages.

---

## VERIFIED OK

- **HTTP/links**: every internal `a[href]` on all 9 pages returns 200 (footer, nav, breadcrumbs, CTAs, `mailto:y.allternative.living@gmail.com`); `#main-content` skip-link targets exist. No 4xx/5xx responses, no `pageerror`s on any page/viewport. External links (all `target=_blank rel=noopener`): Etsy shop, Instagram, TikTok, Facebook page, Google/Apple Maps + Google Calendar per event, and the privacy page's Formspree/Stripe/Cloudflare/Netlify/Resend/Kit/Etsy/Google/Umami/Tawk links.
- **Images**: all visible images load (`naturalWidth>0`), have alt text, correct aspect ratio (AVIF served via `<picture>`); contact image is intentionally `object-fit:cover`. The apparently empty second frame on about.html in a full-page capture was a lazy-load capture artefact -- in-viewport capture `agentD/about-community-viewport.png` shows the beard-salve photo.
- **Layout**: no horizontal scroll on mobile on any page (`scrollWidth == innerWidth`), no reveal elements left hidden after stepped scroll (0/N on all pages), no section overlaps, no clipped non-sr-only text, no multi-line-wrapped buttons at either viewport.
- **axe-core**: **0 violations** on all 9 pages (desktop, tags wcag2a/2aa/21aa/22aa/best-practice).
- **Contrast (measured, effective composite colours)** -- `button[data-concern="all"]` (shop.html): dark 5.61:1 (#d69b5c on #3a2c1d), light 5.08:1 (#7f4a13 on #e4d6c3). `.dispatch-badge` (shop.html & index.html): dark 5.92:1 (#d69b5c on #34281d), light 5.05:1 (#7f4a13 on #e3d6c0). Both pass WCAG AA 4.5:1 at 11.8-12.5px/600-700 -- the earlier a11y flag is not reproducible with the current `--whiskey:#7f4a13` (`styles.css:75`). Neither element exists on reviews.html. Reviews rating chips: `.filter-pill.active` 7.37:1, inactive 10.35:1 (dark) / 7.5:1 (light).
- **Content consistency**: free-shipping threshold $40 agrees across promo bar, FAQ, `content.json`, `products.json shop.freeShippingThreshold`, and `workers/checkout.js:806`. Contact email `y.allternative.living@gmail.com` identical on all pages, footer, LocalBusiness JSON-LD, content.json. Location "Landrum, SC" consistent. Return policy consistent: FAQ (opened goods final sale, sealed/apparel exchangeable) vs policies (14-day exchange window, 7-day damage window, 5-10 business-day refunds) -- FAQ omits the windows but does not contradict them. Processing time consistently "varies by product". Footer year renders 2026. No lorem/TODO/[insert/YOUR_ placeholders in visible text (the `YOUR_TAWKTO_*` strings are inside a script comment/guard only). No mojibake (â€™) anywhere.
- **events.html split**: upcoming = only Autumn Apothecary Faire (2026-10-17, 45-day countdown, ✨ shown in banner as "✨ Next Live Appearance"); past = 7 events newest-first, none of the 6 August-and-earlier events leak into upcoming; "See All Past Pop-ups (7)" expands to all 7 and "Show Carousel" collapses. The `emoji:"✨"` field **is** rendered on events.html (`#eventsCountdownBanner`) and in the index.html hero ticker badge ("✨NEXT POP-UP:"); it is *not* shown on the upcoming card itself. Maps directions links present on every card.
- **contact.html**: required-field validation fires (3 invalid, focus moves to Name, native "Please fill out this field."), bad email rejected, blocked network -> inline `role=alert` "Message sending failed -- your message was not sent. Please email us directly at y.allternative.living@gmail.com" with the typed message preserved; mocked success -> form + description hidden, confirmation "Thanks, y'all! Your message has been sent. I'll get back to you within 24-48 hours." shown (`agentD/contact-mock-success.png`). Formspree ID is real (`xoeqevqv`), LocalBusiness + Breadcrumb JSON-LD valid.
- **reviews.html behaviours**: 12/12 reviews render newest-first with correct star glyphs + sr-only "Rated N out of 5 stars."; 5★/4★/3★ filters (7/4/1), keyword search ("knuckles" -> 1), empty state + "Clear Filters" reset, `aria-pressed` toggles correctly; product select populated with 19 products + "General"; required-field and email validation work; blocked network shows the failure fallback. No photo reviews exist in the data (none rendered).
- **policies/privacy/terms**: no TOC/anchors exist (so nothing to break); effective dates present on terms/privacy; no references to `/.netlify/functions` or the old Etsy checkout flow in customer-facing copy other than the privacy paragraphs flagged in M4; Etsy is still linked only as a "second storefront", consistent with footer.
- **Forms safety**: interception logs show zero real outbound POSTs -- only the two Formspree POSTs, both aborted or locally mocked.
