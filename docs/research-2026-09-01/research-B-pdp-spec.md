# State-of-the-Art PDP Spec (2026) — Small Handmade Body-Care Brand

Context assumed: static HTML/CSS/vanilla JS site, Stripe Checkout (hosted, not custom Elements integration unless noted), client-side cart (localStorage), mostly mobile traffic. Product mix: salves, soaks, body butter, sprays (cosmetics, no variants or simple scent/size variants), two apparel SKUs (size variants), one digital gift card.

Priority key: **Must** = evidence-backed, load-bearing for conversion/compliance/legal risk on this exact site profile. **Should** = evidence-backed, meaningful lift, do after Must. **Nice** = real but marginal, or expensive relative to payoff for a small shop. **⚠ Folklore** = commonly repeated but not evidence-backed for this context; flagged, not recommended as a priority.

---

## 1. Page anatomy & mobile above-the-fold ordering

**Must**
- Put price, one clear variant control (scent/size), quantity, and a single primary "Add to cart" button all within the first mobile viewport, above any long description — 62% of e-commerce sites have "mediocre or worse" product-page UX, and mobile scores lower (38% "decent+") than desktop (48%) largely on exactly this kind of information hierarchy. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux) (updated Mar 18, 2026)
- Use button-style (not `<select>`) controls for variant/size selection. 57% of benchmarked sites still hide options in a dropdown, which measurably slows selection and hides out-of-stock states. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- Ship a sticky mobile add-to-cart bar (price + variant status + buy button) that appears once the primary ATC button scrolls out of view, via `IntersectionObserver`. Mobile PDP sessions routinely scroll 70–80% past the original button position, and Baymard explicitly recommends surrounding a sticky button with whitespace rather than a full-bleed bar. — [Baymard, "35 Data-Driven Ecommerce Best Practices"](https://baymard.com/learn/ecommerce-ux-best-practices); pattern write-up: [laioutr, "Sticky Add-to-Cart on Mobile PDPs" (2026)](https://www.laioutr.com/en/blog/sticky-add-to-cart-mobile-pdp-2026)
- Surface the fully-loaded price (including estimated shipping) or free-shipping threshold near the buy button. Unexpected costs at checkout are the #1 documented abandonment driver (48% of shoppers abandon when shipping/tax/fees first appear at checkout; 39% cite extra charges specifically). Showing the threshold on the PDP, not just at cart, prevents this late surprise. — [Baymard, "How to Reduce Cart Abandonment"](https://baymard.com/learn/reduce-cart-abandonment); corroborating industry stat: [eMarketer, "Extra costs are the No. 1 reason consumers abandon online carts"](https://www.emarketer.com/content/extra-costs-are-the-top-reason-consumers-abandon-online-carts)
- Show return-policy terms directly on the PDP or one tap away, not buried in a footer link. 44% of benchmarked sites fail this; 60% of users specifically look for return info on the product page itself, and its absence measurably drives abandonment. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)

**Should**
- Offer express-pay buttons (Apple Pay / Google Pay) near the primary CTA if using Stripe's Express Checkout Element (the successor to the now-legacy Payment Request Button element) rather than routing every purchase through a full Checkout redirect first. Stripe reports material conversion lift from surfacing wallet options early, and one-click wallets remove the address/card-entry step that is the single biggest source of mobile checkout friction. — [Stripe Docs, "Express Checkout Element"](https://docs.stripe.com/elements/express-checkout-element); [Stripe, "Payment Request Button" marked legacy in favor of Express Checkout Element](https://docs.stripe.com/stripe-js/elements/payment-request-button)
  - Note: for a purely static site funneling to Stripe **Checkout** (hosted page), Apple Pay/Google Pay already appear automatically on the Checkout page itself if enabled in the Stripe Dashboard — no client-side Payment Request/Express Checkout Element integration is required to get wallet buttons; that only matters if you want the wallet button to appear *on the PDP itself* before redirect.
- Give reviews a rating summary (stars + count) near the title, since it is one of the first trust signals users scan for, per NN/g's product-page guideline set (108 guidelines drawn from 5 rounds of usability studies across 350+ sites). — [NN/g, "Ecommerce UX: Product Pages"](https://www.nngroup.com/reports/ecommerce-ux-product-pages-including-reviews/)
- For apparel, put a "Size Guide" link directly adjacent to the size selector, not in a separate nav/help page. Only 17% of desktop and 13% of mobile sites provide sufficient sizing info, and sizing uncertainty is a named, recurring cause of PDP abandonment in Baymard's qualitative testing (370 sessions). — [Baymard, "Apparel: 10 Best Practices on Sizing"](https://baymard.com/blog/apparel-size-information); [Baymard, "87 'Size Guide' Design Examples"](https://baymard.com/ecommerce-design-examples/size-guide)
- Gallery: allow swipe (touch) *and* visible manual controls (arrows/dots) on mobile — don't rely on swipe alone, since not all users discover it, and it's a documented usability gap. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- For products where scale is ambiguous (jars, tins, bottles), include at least one "in-scale" reference image (hand holding jar, item next to a common object). 42% of users try to judge size from images alone and 37% of sites provide no scale reference at all. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)

**Nice**
- Thumbnail strip *and* swipe (desktop-style thumbnails are rare on mobile per Baymard, and NN/g doesn't treat this as high-priority for small catalogs); a single well-executed swipeable gallery with 4–6 images per product (packaging, in-use, ingredients close-up, scale shot) is sufficient for a small handmade-goods catalog — no primary source specifies an exact "must-have" image count; treat any specific number (e.g. "8 images minimum") you see in marketing blogs as **⚠ folklore**.
- Zoom-on-tap for texture/ingredient close-ups (salves/butters are texture-driven purchases) — reasonable given the category, but not something the cited research isolates as a measured lift; implement as effort allows, not as a priority blocker.

**⚠ Folklore**
- Specific "optimal number of product images" (e.g., "always show 5+ images") — no cited source gives a fixed number; Baymard's findings are about presence/absence of specific image *types* (scale, human model, in-use), not a magic count.
- "Video always increases conversion X%" — no primary 2025/2026 source in this research surfaced a controlled figure for video on PDPs; treat generic conversion-lift percentages from vendor blogs as marketing claims, not evidence.

---

## 2. Content blocks

**Must**
- Full ingredient list for every cosmetic product (salves, soaks, body butter, sprays), in descending order of predominance, conspicuously placed. This is a binding FDA labeling requirement under 21 CFR 701.3, not just a UX nicety — omitting it, or hiding it where it's not "likely to be read at the time of purchase," is a compliance gap for products sold for retail personal-care use. — [FDA, "Summary of Cosmetics Labeling Requirements"](https://www.fda.gov/cosmetics/cosmetics-labeling-regulations/summary-cosmetics-labeling-requirements); [FDA, "Cosmetic Ingredient Names"](https://www.fda.gov/cosmetics/cosmetics-labeling/cosmetic-ingredient-names)
- Net weight/volume and identity statement on every cosmetic product page (mirrors what must physically be on the label; showing it online reduces returns from size mismatch expectations and satisfies MoCRA-adjacent transparency norms). — [FDA, "Summary of Cosmetics Labeling Requirements"](https://www.fda.gov/cosmetics/cosmetics-labeling-regulations/summary-cosmetics-labeling-requirements)
- Direct contact information (already required on physical labels since Dec 2024 under MoCRA) should also appear somewhere reachable from the PDP (e.g., linked contact/about page) so customers can report adverse reactions — this is a real regulatory obligation, not optional trust copy. — [Wiley Law, "Time's Up! Cosmetic Facilities Must Comply With FDA's New Registration Requirements"](https://www.wiley.law/alert-Times-Up-Cosmetic-Facilities-Must-Comply-With-FDAs-New-Registration-Requirements-by-July-1); [Morgan Lewis, "FDA Cosmetic Updates" (Dec 2024)](https://www.morganlewis.com/pubs/2024/12/fda-cosmetic-updates-new-qas-for-mocra-facility-registration-product-listing-delayed-timelines-for-gmps-and-more)
- Patch-test / safety guidance for topical products (salves, body butter, sprays applied to skin) as a short, plain-text block — not a legal requirement of MoCRA itself, but standard due-diligence practice for small handmade cosmetic brands and consistent with FDA's general adulteration/misbranding framework (a product must be safe under labeled conditions of use). Treat as Must given the product category's skin-contact risk profile, even though no single cited source mandates the exact wording.

**Should**
- MoCRA context for the operator (not customer-facing copy, but a Must for internal compliance): if average annual gross cosmetic sales are under $1M, the business is exempt from **facility registration and product listing**, but **not** exempt from adverse-event reporting, safety substantiation, or labeling rules — so the "we're MoCRA-exempt" claim some small brands put on PDPs is only partially true and should not be used to imply zero regulatory obligation. — [Morgan Lewis, Dec 2024 update](https://www.morganlewis.com/pubs/2024/12/fda-cosmetic-updates-new-qas-for-mocra-facility-registration-product-listing-delayed-timelines-for-gmps-and-more); [Cosmeservice, "MoCRA: FDA Compliance for Cosmetics in the US"](https://cosmeservice.com/cosmetic-regulations/mocra-fda/)
- How-to-use block (application, frequency, storage) — supported generically by NN/g's product-page guideline set as one of the core information categories users look for beyond marketing copy. — [NN/g, "Ecommerce UX: Product Pages"](https://www.nngroup.com/reports/ecommerce-ux-product-pages-including-reviews/)
- Reviews with photo carousel: if you add reviews at all, let users browse reviewer-submitted photos without leaving the review context — 63% of sites fail to do this, and photo reviews are a documented trust signal in the same benchmark. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- Respond visibly to negative reviews rather than hiding/deleting them — 89% of sites don't, and Baymard frames the absence as a missed trust opportunity, not neutral. — [Baymard, Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- Cross-sells/"frequently bought with" bundles: reasonable for a small catalog with natural pairings (salve + soak), consistent with NN/g's general product-page guidance, but keep modest — a large catalog-scale recommendation engine is not warranted at this scale.

**Nice**
- "Recently viewed" — genuinely useful only once catalog size and repeat traffic justify it; for a small catalog this is low-value engineering effort. No cited source treats it as a priority for small stores specifically.
- Scent notes / "made in" brand story — valuable brand-differentiation content for a handmade goods brand, but this is a content/marketing decision rather than a research-backed UX requirement; place below the fold, don't let it block or delay the purchase path.
- FAQ block on-page: keep it (good for on-page SEO/content and for AI agents reading the page, see §6) but don't build it *for* Google's FAQPage rich-result feature — see §3.

**⚠ Folklore**
- "Batch/freshness codes must be shown online" — this is a physical-label practice (and good practice generally for handmade cosmetics with shelf life), but no FDA source in this research requires it to appear *on the web page specifically*; treat as a nice-to-have trust signal, not a compliance requirement for the PDP itself.

---

## 3. Structured data

**Must**
- `Product` + `Offer` JSON-LD on every PDP with, at minimum: `name`, `image`, and either `review`, `aggregateRating`, or `offers` (Google requires at least one of these three for Product snippet eligibility). Within `Offer`: `price` (or `priceSpecification.price`) is required; `priceCurrency` is required for `AggregateOffer`. — [Google Search Central, "How To Add Product Snippet Structured Data"](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
- `availability` (ItemAvailability enum: InStock/OutOfStock/BackOrder/etc.) — recommended by Google's own docs, and functionally necessary so shoppers (and shopping agents, see §6) don't act on stale stock data. — [Google Search Central, Product Snippet docs](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
- `shippingDetails` (via `OfferShippingDetails`) and `hasMerchantReturnPolicy` (via `MerchantReturnPolicy`) on the `Offer` — these are explicitly called out as **Merchant Listing** eligibility requirements (separate, stricter feature from basic Product snippets) and can alternatively be set once at the `Organization` level in late-2025 Google updates so you don't have to repeat them on every product. — [Google Search Central, "Merchant Shipping Policy Structured Data"](https://developers.google.com/search/docs/appearance/structured-data/shipping-policy); [PEMAVOR, "New Ways to Add Shipping & Return Policies in Google Search" (Nov 2025)](https://www.pemavor.com/news/google-shipping-returns-update-november-2025/)
- `BreadcrumbList` on the PDP reflecting the typical user path (Home → Category → Product), not the raw URL structure. Doesn't affect ranking directly but improves SERP presentation and is low-effort for a static site. — [Google Search Central, "How To Add Breadcrumb (BreadcrumbList) Markup"](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)
- Product images meeting Google's minimum resolution: **500×500px minimum**, with warnings starting April 14, 2026 and enforcement from January 31, 2027 — this is a near-term deadline, not a someday concern. — [ALM Corp, "Google Merchant Center Product Data Specification Update 2026"](https://almcorp.com/blog/google-merchant-center-product-data-specification-update-2026/)
- For apparel sizes: use `ProductGroup` with `variesBy: "size"` and `hasVariant` pointing to individual `Product`/`Offer` entries per size, rather than one `Product` with an ad-hoc size list — this is the schema.org-sanctioned pattern Google's Feb 2024 variant support is built on. — [Schema.org, `ProductGroup`](https://schema.org/ProductGroup); Google's Feb 2024 variant support noted in [MagsTags, "E-commerce Schema Markup" roundup](https://www.magstags.com/notes/ecommerce-structured-data-serp-features/)

**Should**
- `AggregateRating`/`Review` markup — but **only with real, non-incentivized (or clearly disclosed) reviews you don't fully author yourself**. Google explicitly disallows "self-serving" reviews for Organization/LocalBusiness types where the entity controls its own review content, and separately prohibits undisclosed incentivized reviews in structured data. For Product-type markup this is more permissive than for Organization, but the same anti-fabrication rule applies: never hand-author fake ratings into the JSON-LD. — [Google Search Central, "Review Snippet (Review, AggregateRating) Structured Data"](https://developers.google.com/search/docs/appearance/structured-data/review-snippet); [Google Search Central Blog, "Making Review Rich Results more helpful" (2019, still governing policy)](https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful)
- `priceValidUntil` on `Offer` if you ever run time-bound sale pricing (recommended, ISO 8601 date) — otherwise omit; don't fabricate an artificial "sale ends" date, which would be both structured-data misuse and a dark pattern (see §7).

**Do NOT build for (deprioritize)**
- `FAQPage` structured data for the rich-result snippet itself: Google restricted FAQ rich results in April/August 2023 to "well-known, authoritative government and health sites" only, and has since been **fully deprecating** FAQ rich results and the associated Search Console report (dropping June 2026). Keep an on-page FAQ block for users and for AI agent readability (§6), but do not invest engineering time chasing the FAQPage rich-result feature — it will not render for a small commerce site and Google is retiring the report entirely. — [Google Search Central Blog announcement coverage, Search Engine Journal, "Google Drops FAQ Rich Results From Search"](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/); [GetPassionfruit, "FAQ Rich Results Deprecated: Google's May 2026 Change"](https://www.getpassionfruit.com/blog/what-changed-with-google-drops-faq-rich-results-and-what-to-do-now)

**Nice**
- `itemCondition` (NewCondition) — trivial to add, Google's own docs list it among Merchant Listing fields, but low marginal value for a brand that only sells new handmade goods (there's no ambiguity to resolve).

---

## 4. Performance

**Must**
- Preload the LCP hero product image with `<link rel="preload" fetchpriority="high">` and mark the `<img>` itself `fetchpriority="high"`; do **not** lazy-load it. This is one of the highest-leverage, cheapest LCP fixes available and is directly documented by Chrome's own team, including a measured Google Flights case study (2.6s → 1.9s LCP). — [web.dev, "Optimize Largest Contentful Paint"](https://web.dev/articles/optimize-lcp); [web.dev, "Optimize resource loading with the Fetch Priority API"](https://web.dev/articles/fetch-priority)
- Limit `<link rel="preload">` use to at most ~2 images and 2–3 fonts per page — over-preloading creates bandwidth contention and can *worsen* LCP. Since a PDP typically only needs the one hero image preloaded, this is easy to satisfy but easy to violate by accident (e.g. preloading every gallery thumbnail). — [web.dev, "Optimize Largest Contentful Paint"](https://web.dev/articles/optimize-lcp)
- Serve hero/gallery images as AVIF with WebP fallback via `<picture>` (AVIF ≈94% global support in 2026; 15–30% smaller than WebP at matched quality for photographic content, which is what product photography is). — [DEV/FileMint-class 2026 format comparisons, cross-checked against MDN/caniuse browser-support consensus](https://dev.to/serhii_kalyna_730b636889c/avif-vs-webp-vs-heic-vs-jpeg-xl-which-image-format-should-you-use-in-2026-4gn0)
- Reserve layout space for every gallery/thumbnail image with explicit `width`/`height` or CSS `aspect-ratio`, so the browser allocates space before the image decodes — this is the standard, uncontroversial CLS fix and applies directly to a swipeable mobile gallery where images load progressively. — [web.dev, "Optimize Cumulative Layout Shift"](https://web.dev/articles/optimize-cls); [web.dev, "The CSS aspect-ratio property"](https://web.dev/articles/aspect-ratio)
- Keep "Add to cart" JS handlers lean and use optimistic UI (update the cart badge/sticky-bar state immediately, don't block the paint on a synchronous computation) — INP thresholds are "good" ≤200ms / "poor" >500ms, and add-to-cart/variant-selection interactions are named by multiple sources as common e-commerce INP failure points because of heavy handlers on the main thread. — [web.dev-aligned industry guidance cross-referenced; e.g. Hashmeta, "Interaction to Next Paint (INP): Complete Optimization Guide for 2025"](https://hashmeta.com/blog/interaction-to-next-paint-inp-complete-optimization-guide-for-2025/) — *(secondary source; corroborates but is not itself web.dev/Chrome primary documentation — verify INP thresholds against [web.dev's own INP article](https://web.dev/articles/inp) before treating exact ms figures as canonical.)*

**Should**
- Add Speculation Rules API (`prerender`/`prefetch`) for the category → PDP and PDP → PDP (related product) navigation paths. This is in active production use (Astro ships it, Chrome added a "prerender until script" middle-ground trial starting Chrome 144 in 2025) and is a natural fit for a static HTML site since it needs no server logic — just a JSON rules block. Feature-detect and no-op gracefully on non-Chromium browsers. — [Chrome for Developers, "Speculation rules prerender until script origin trial"](https://developer.chrome.com/blog/prerender-until-script-origin-trial); [MDN, "Speculation Rules API"](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API)
- Cross-document View Transitions (native `@view-transition` CSS) between the category grid and PDP, as a progressive enhancement only. Supported in Chrome/Edge 126+ and Safari 18.2+, but **not yet shipped in Firefox** (expected sometime in 2026) and MDN explicitly marks it "Limited availability," not Baseline. Wrap in a feature check; never make it load-bearing for navigation. — [Chrome for Developers, "What's new in view transitions (2025 update)"](https://developer.chrome.com/blog/view-transitions-in-2025); [MDN, `ViewTransition`](https://developer.mozilla.org/docs/Web/API/ViewTransition)

**Nice**
- Service worker precaching of PDP shell/CSS/JS for repeat visits — genuinely useful for a mostly-mobile audience on inconsistent connections, but this is general PWA hygiene rather than something the cited PDP-specific research calls out as a conversion driver; treat as infrastructure polish, not a PDP-ranked priority. Be careful that any cached cart/price data is revalidated against Stripe at checkout time — never let a stale service-worker cache serve an outdated price.

**⚠ Folklore**
- "Video hero image always improves LCP/engagement" — no primary source in this research supports video-first heroes; video, if used, should load after the LCP image, not compete with it.

---

## 5. Accessibility (WCAG 2.2 AA)

**Must**
- **Target Size (Minimum) — SC 2.5.8 (AA):** all interactive controls (variant swatches, quantity stepper, sticky ATC button, gallery arrows) must be at least 24×24 CSS px, or have equivalent spacing if visually smaller — directly relevant to small tap targets like size-swatch buttons and gallery dot indicators. — [WCAG 2.2 SC 2.5.8, summarized via AudioEye/TestParty WCAG 2.2 guides, cross-referenced against W3C's SC list](https://www.audioeye.com/post/wcag-22/)
- **Focus Not Obscured (Minimum) — SC 2.4.11 (AA):** a sticky mobile add-to-cart bar (recommended in §1) must not fully cover a keyboard-focused element beneath it — e.g., tabbing to a form field or link near the bottom of the viewport must not land the focus ring under the sticky bar with no visible indication. This is a direct interaction between two recommendations in this spec (sticky ATC bar + keyboard navigation) and needs explicit testing. — [W3C WCAG 2.2, SC 2.4.11, summarized via AudioEye/TestParty](https://www.audioeye.com/post/wcag-22/)
- Announce "added to cart" via `aria-live="polite"` (not `assertive`) with `aria-atomic="true"`, so screen-reader users get a short, non-interrupting confirmation ("Lavender Salve added to cart") without derailing whatever they were doing next. — [Sara Soueidan, "Accessible notifications with ARIA Live Regions"](https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-1/); [marcus.io, "Building accessible-app.com: shopping cart and aria-live"](https://marcus.io/blog/a11y-app-shopping-cart-with-aria-live)
- Variant selection (size/scent) must use real, labeled form semantics (radio-group pattern with visually-styled buttons, e.g. hidden `<input type="radio">` + styled `<label>`, or `role="radiogroup"`/`radio` if custom-built) — not `<div onclick>` soup — so screen readers and keyboard users can perceive selection state (`aria-checked`/`:checked`) and out-of-stock options.
- Respect `prefers-reduced-motion` for any gallery auto-advance, view-transition, or entrance animation; if any gallery auto-plays, it must be pausable per WCAG 2.2.2 (carried over from 2.1) regardless of the reduced-motion query, since that SC protects all users, not just those with the OS setting enabled. — [Pope Tech, "Design accessible animation and movement" (Dec 2025)](https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/); WCAG 2.2.2 background via [wcag.dock.codes summary](https://wcag.dock.codes/documentation/wcag222/)

**Should**
- Gallery must be fully keyboard-operable: arrow keys or tab-reachable prev/next controls, visible focus indicator, and correct `alt` text per image (not just the product name repeated) — a general WCAG 2.2 carousel requirement, and directly testable on a swipe-only mobile gallery that has no keyboard equivalent.
- On apparel size selection, make the size guide reachable and operable via keyboard/screen reader too (not an image-only modal) — ties §1's "size guide adjacent to selector" recommendation to an accessibility requirement, not just a UX one.

---

## 6. Agentic-commerce readiness (2026)

**What's real and already shippable**

- **Schema.org structured data completeness (§3) is the actual foundation** every agentic protocol below builds on or complements — a PDP with correct `Product`/`Offer`/`ProductGroup`/`shippingDetails`/`hasMerchantReturnPolicy` is already more machine-legible than most competitors, independent of any agent-specific protocol. This is the highest-leverage, lowest-risk agentic-commerce investment for a small site: **do §3 well, and you've already done most of what agentic commerce needs.**
- **OpenAI's Agentic Commerce Protocol (ACP)**, built with Stripe, is real, live, and versioned: released Sept 29, 2025, Apache-2.0 licensed, with a documented Product Feed Specification (67 fields across 15 groups) so ChatGPT can ingest catalog data via file upload or API. This is genuinely adopted (not just proposed) infrastructure, and given this site already uses Stripe, ACP is the most natural agentic-commerce integration path if/when the brand wants ChatGPT-surfaced shopping. — [OpenAI Developers, "Agentic Commerce Protocol"](https://developers.openai.com/commerce); [GitHub, agentic-commerce-protocol/agentic-commerce-protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
- **Google's Agent Payments Protocol (AP2)** (announced Sept 2025, 60+ partners including PayPal/Mastercard/Amex, v0.2.0 shipped April 2026) and the complementary **Universal Commerce Protocol (UCP)** (unveiled at I/O 2026 alongside "Universal Cart") are also real and moving fast, but this is a **much bigger, more consequential integration** than ACP for a solo/small operator — it involves cryptographically signed "Mandates" and payment-agnostic infrastructure. Track it; don't build against it yet unless Google Shopping traffic becomes material. — [Google Cloud Blog, "Announcing Agent Payments Protocol (AP2)"](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol); [Google Developers Blog, "Under the Hood: Universal Commerce Protocol (UCP)"](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/)

**Should (low effort, real payoff)**

- Keep the same clean structured-data + plain HTML content that benefits SEO also benefiting agent crawlers: clear price, availability, ingredient/description text in real DOM text (not canvas/image-only), and stable, crawlable URLs per product. Every agentic protocol above ultimately still needs either structured data or a feed derived from it — there is no protocol that substitutes for having accurate underlying product data.
- If/when the brand wants ChatGPT shopping surfacing specifically, generate an ACP-compatible product feed export from the same JSON that drives `assets/data/events.json`-style product data already used to build the site (i.e., treat it as a build-step export, not a new data source).

**Should not prioritize / is folklore-adjacent**

- **`llms.txt`**: this is **not** a standards-body specification — no W3C/IETF backing — and adoption/impact data as of mid-2026 shows only ~9–10% of even top-1000 sites publish one, with major crawlers (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended) largely **not fetching it in production** as of Q1 2026, and no major AI company publicly committed to honoring it. It's cheap to add (a few minutes of effort) and harmless, but **do not treat it as agentic-commerce infrastructure** or expect it to affect discoverability — that's marketing folklore outrunning the evidence. If added at all, treat it as a nice-to-have footnote, not a checklist item that matters. — [Rankability, "LLMS.txt Adoption: 8.7% of the Top 1,000 (June 2026)"](https://www.rankability.com/data/llms-txt-adoption/)

**⚠ Folklore**
- Any claim that a specific "AI SEO" markup, meta tag, or `llms.txt` file will make ChatGPT/Gemini "prefer" your products absent the actual commerce protocols (ACP/AP2/UCP) above — the real leverage is structured product data + (optionally) a compliant feed, not novel meta tags.

---

## 7. Anti-patterns to avoid

**Must avoid**
- **Fake urgency/scarcity**: countdown timers that reset, or "Only 2 left!" messages not driven by real inventory counts. This isn't just bad UX — the FTC's 2022 dark-patterns report and subsequent enforcement activity treat fabricated urgency/scarcity as a Section 5 deceptive-practice violation; state guidance (e.g., CalPrivacy, Sept 2024) has specifically told businesses to audit for this. If you ever show "X left in stock," it must be wired to real inventory data, and any sale countdown must reflect a real end date matching `priceValidUntil` in structured data (see §3) — not a marketing-only timer. — [Reed Smith, "Dark patterns lead to enforcement spotlight"](https://www.reedsmith.com/articles/dark-patterns-lead-to-enforcement-spotlight-key-compliance-steps-for-businesses/); [Arnall Golden Gregory, "The FTC Blacklists Dark Patterns"](https://www.agg.com/news-insights/publications/the-ftc-blacklists-dark-patterns/)
- **Invented/incentivized reviews without disclosure**: don't hand-write "customer" reviews into content or JSON-LD, and don't solicit reviews with an undisclosed benefit (discount, free product) — this is explicitly called out as a violation in Google's own review-structured-data policy, independent of any general truth-in-advertising concern. — [Google Search Central, "Review Snippet (Review, AggregateRating) Structured Data"](https://developers.google.com/search/docs/appearance/structured-data/review-snippet)
- **Hidden fees revealed only at checkout**: given that this is the single most cited abandonment driver in the research (48% abandon when shipping/tax/fees first appear at checkout, per Baymard's synthesis), showing a shipping-cost estimate or free-shipping threshold on the PDP (§1) is the direct anti-pattern fix, not optional polish. — [Baymard, "How to Reduce Cart Abandonment"](https://baymard.com/learn/reduce-cart-abandonment)
- **Disabled buttons with no explanation**: an ATC button that's disabled (e.g., because no size/scent is selected) must communicate *why* — via inline text, `aria-describedby`, or a live-region message — not just sit inert. This is both a conversion anti-pattern (users don't know what to fix) and an accessibility failure (a disabled control with no explanation gives screen-reader users no path forward).
- **Modal-only critical content**: ingredients, return policy, and size guide must be reachable without depending on a JS modal as the *only* access path — if the modal fails to open (JS error, ad blocker, slow connection) the content must degrade to something reachable (e.g., an in-page `<details>`/expandable section, or a real anchor-linked section) rather than becoming completely inaccessible. This also matters for the accessibility requirements in §5 (keyboard/focus handling is much harder to get right in custom modals) and for agentic crawlers in §6 (agents reading rendered HTML need the content in the DOM, not gated behind a click-triggered fetch).

**Should avoid**
- Auto-playing gallery/video with no pause control (ties to WCAG 2.2.2 in §5, and is broadly disliked in UX research as an unrequested motion/attention cost).
- Burying the ingredient list behind extra clicks when it's a legal labeling element (§2) — treat friction here as a compliance risk, not just a UX inconvenience.

---

## Summary table

| # | Item | Priority | Category |
|---|------|----------|----------|
| 1 | Price + variant + qty + ATC above the fold on mobile | Must | Layout |
| 2 | Button-style (not dropdown) variant selectors | Must | Layout |
| 3 | Sticky mobile ATC bar | Must | Layout |
| 4 | Fully-loaded price / free-shipping threshold visible pre-checkout | Must | Layout / Anti-pattern |
| 5 | Return policy visible/linked from PDP | Must | Layout |
| 6 | Full INCI/ingredient list, descending order | Must | Content / Legal |
| 7 | Net weight + identity statement | Must | Content / Legal |
| 8 | Contact info reachable (MoCRA adverse-event reporting) | Must | Content / Legal |
| 9 | Patch-test/safety note for topical products | Must | Content |
| 10 | `Product`/`Offer` JSON-LD with required fields | Must | Structured data |
| 11 | `shippingDetails` + `hasMerchantReturnPolicy` | Must | Structured data |
| 12 | `BreadcrumbList` | Must | Structured data |
| 13 | 500×500px+ product images (2026 Google deadline) | Must | Structured data |
| 14 | `ProductGroup`/`hasVariant`/`variesBy` for apparel sizes | Must | Structured data |
| 15 | Preload + `fetchpriority="high"` LCP hero image | Must | Performance |
| 16 | AVIF w/ WebP fallback | Must | Performance |
| 17 | `aspect-ratio`/explicit dimensions on gallery images | Must | Performance |
| 18 | Lean, optimistic-UI ATC handler for INP | Must | Performance |
| 19 | Target size ≥24×24px on all controls | Must | Accessibility |
| 20 | Sticky bar must not obscure keyboard focus | Must | Accessibility |
| 21 | `aria-live="polite"` ATC confirmation | Must | Accessibility |
| 22 | Real radio-group semantics for variant selection | Must | Accessibility |
| 23 | Respect `prefers-reduced-motion`; pausable motion | Must | Accessibility |
| 24 | No fake urgency/scarcity | Must | Anti-pattern / Legal |
| 25 | No invented/undisclosed-incentive reviews | Must | Anti-pattern / Legal |
| 26 | Disabled buttons explain why | Must | Anti-pattern |
| 27 | No modal-only critical content | Must | Anti-pattern |
| 28 | Express-pay (Apple/Google Pay) on PDP or Checkout | Should | Layout |
| 29 | Rating summary near title | Should | Layout |
| 30 | Size guide adjacent to size selector | Should | Layout / Accessibility |
| 31 | Swipe + visible manual gallery controls | Should | Layout |
| 32 | In-scale reference image | Should | Content |
| 33 | Reviews with browsable photo carousel | Should | Content |
| 34 | Respond to negative reviews | Should | Content |
| 35 | `AggregateRating`/`Review` markup (real reviews only) | Should | Structured data |
| 36 | `priceValidUntil` if running real time-bound sales | Should | Structured data |
| 37 | Speculation Rules API prefetch/prerender | Should | Performance |
| 38 | Cross-document View Transitions (progressive enhancement) | Should | Performance |
| 39 | Keyboard-operable gallery with real `alt` text | Should | Accessibility |
| 40 | Clean crawlable HTML + structured data for agent readiness | Should | Agentic |
| 41 | ACP-compatible feed export (if pursuing ChatGPT shopping) | Should | Agentic |
| 42 | Zoom-on-tap for texture close-ups | Nice | Layout |
| 43 | Cross-sells/bundles for natural pairings | Nice | Content |
| 44 | Scent notes / brand story | Nice | Content |
| 45 | Recently viewed | Nice | Content |
| 46 | Service-worker precaching of PDP shell | Nice | Performance |
| 47 | `itemCondition` markup | Nice | Structured data |
| 48 | `llms.txt` | Nice (low-effort footnote only) | Agentic |
| — | `FAQPage` rich-result markup | **Deprioritize** — feature deprecated by Google | Structured data |

---

## Flagged as marketing folklore (not prioritized above)

1. **Fixed "optimal" image counts** ("always show 8 photos") — no primary source specifies a number; Baymard's findings are about image *types* present/absent, not counts.
2. **Generic "video increases conversion X%" claims** — no 2025/2026 primary source in this research substantiates a controlled figure for PDP video.
3. **`llms.txt` as meaningful agentic-commerce infrastructure** — real adoption is ~9-10% of top sites and major AI crawlers largely ignore it in production as of Q1 2026; treat as harmless but not load-bearing.
4. **"MoCRA-exempt" as a blanket claim for sub-$1M cosmetic brands** — exemption applies only to facility registration/product listing, not to adverse-event reporting, safety substantiation, or labeling; framing it as full exemption on marketing copy would itself be a minor accuracy problem.
5. **Batch/freshness codes "must" appear on the web page** — good practice, but not a documented FDA web-specific requirement; it's a physical-label practice that's reasonable to mirror online, not a compliance mandate for the PDP.

---

## Sources consulted (primary/near-primary, with access context)

- Baymard Institute — [Product Page UX Best Practices 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux) (updated Mar 18, 2026), [Apparel sizing best practices](https://baymard.com/blog/apparel-size-information), [Size Guide design examples](https://baymard.com/ecommerce-design-examples/size-guide), [Reduce Cart Abandonment](https://baymard.com/learn/reduce-cart-abandonment), [35 Data-Driven Best Practices](https://baymard.com/learn/ecommerce-ux-best-practices)
- Nielsen Norman Group — [Ecommerce UX: Product Pages](https://www.nngroup.com/reports/ecommerce-ux-product-pages-including-reviews/)
- Google Search Central — [Product structured data intro](https://developers.google.com/search/docs/appearance/structured-data/product), [Product Snippet](https://developers.google.com/search/docs/appearance/structured-data/product-snippet), [Review Snippet policy](https://developers.google.com/search/docs/appearance/structured-data/review-snippet), [Merchant Shipping Policy](https://developers.google.com/search/docs/appearance/structured-data/shipping-policy), [Breadcrumb](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb), [2019 review-snippet policy blog post](https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful)
- Schema.org — [ProductGroup](https://schema.org/ProductGroup)
- FDA — [Summary of Cosmetics Labeling Requirements](https://www.fda.gov/cosmetics/cosmetics-labeling-regulations/summary-cosmetics-labeling-requirements), [Cosmetic Ingredient Names](https://www.fda.gov/cosmetics/cosmetics-labeling/cosmetic-ingredient-names)
- Law-firm MoCRA analyses — [Wiley Law](https://www.wiley.law/alert-Times-Up-Cosmetic-Facilities-Must-Comply-With-FDAs-New-Registration-Requirements-by-July-1), [Morgan Lewis, Dec 2024](https://www.morganlewis.com/pubs/2024/12/fda-cosmetic-updates-new-qas-for-mocra-facility-registration-product-listing-delayed-timelines-for-gmps-and-more)
- web.dev / Chrome for Developers — [Optimize LCP](https://web.dev/articles/optimize-lcp), [Fetch Priority API](https://web.dev/articles/fetch-priority), [Optimize CLS](https://web.dev/articles/optimize-cls), [CSS aspect-ratio](https://web.dev/articles/aspect-ratio), [Speculation rules prerender-until-script trial](https://developer.chrome.com/blog/prerender-until-script-origin-trial), [View Transitions in 2025](https://developer.chrome.com/blog/view-transitions-in-2025)
- MDN — [Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API), [ViewTransition](https://developer.mozilla.org/docs/Web/API/ViewTransition)
- W3C — [Payment Request API, Candidate Recommendation 2024](https://www.w3.org/news/2024/w3c-invites-implementations-of-payment-request-api/)
- Stripe Docs — [Express Checkout Element](https://docs.stripe.com/elements/express-checkout-element), [Payment Request Button (legacy)](https://docs.stripe.com/stripe-js/elements/payment-request-button)
- WCAG 2.2 / WAI-adjacent — SC 2.5.8 and 2.4.11 summarized via [AudioEye](https://www.audioeye.com/post/wcag-22/) and [TestParty](https://testparty.ai/blog/wcag-22-new-success-criteria) WCAG 2.2 guides (secondary summaries of the W3C spec — verify exact criterion wording against [w3.org/TR/WCAG22](https://www.w3.org/TR/WCAG22/) before citing in compliance-facing documentation)
- ARIA live regions — [Sara Soueidan](https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-1/), [marcus.io](https://marcus.io/blog/a11y-app-shopping-cart-with-aria-live)
- Reduced motion — [Pope Tech, Dec 2025](https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/)
- FTC dark patterns — [Reed Smith](https://www.reedsmith.com/articles/dark-patterns-lead-to-enforcement-spotlight-key-compliance-steps-for-businesses/), [Arnall Golden Gregory](https://www.agg.com/news-insights/publications/the-ftc-blacklists-dark-patterns/)
- OpenAI Agentic Commerce Protocol — [developers.openai.com/commerce](https://developers.openai.com/commerce), [GitHub spec repo](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
- Google Agent Payments Protocol / Universal Commerce Protocol — [Google Cloud Blog, AP2 announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), [Google Developers Blog, UCP](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/)
- llms.txt adoption data — [Rankability, June 2026 study](https://www.rankability.com/data/llms-txt-adoption/)
- Google Merchant Center 2026 image spec change — [ALM Corp](https://almcorp.com/blog/google-merchant-center-product-data-specification-update-2026/)
- eMarketer — [Extra costs as #1 abandonment reason](https://www.emarketer.com/content/extra-costs-are-the-top-reason-consumers-abandon-online-carts)
- FAQPage deprecation — [Search Engine Journal](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/), [GetPassionfruit](https://www.getpassionfruit.com/blog/what-changed-with-google-drops-faq-rich-results-and-what-to-do-now)

**Caveat on secondary sources**: A handful of citations above (INP threshold explainer, WCAG 2.2 criterion summaries, "sticky ATC lifts conversion 5–12%" figure) come from industry blogs synthesizing primary standards/research rather than the standards bodies or Baymard/NN/g themselves directly. These are flagged inline; where a number matters for a compliance or contractual claim, verify against the primary spec (W3C WCAG 2.2, web.dev's own INP article) before relying on it.
