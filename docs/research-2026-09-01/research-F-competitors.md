# Competitor Teardown: Y'allternative Living vs. 6 Comparable Small-Batch Body-Care Brands

Research date: 2026-09-01. All competitor pages fetched same day. Y'allternative Living data pulled read-only from the local repo (`assets/data/products.json`, `shop.html`, `assets/js/main.js`, `workers/checkout.js`, `assets/css/styles.css`) — not from the live site — so it reflects the codebase, which is presumed to match production.

## Methodology / limitations

- Target profile: one-person or small-team, handmade, direct-sold, $15–$40 mode price point, ideally queer-owned and/or Southern/Appalachian. This excludes VC-backed "queer-owned beauty brand" listicle entries (Alder New York, NOTO, Common Heir, Malin+Goetz) that showed up in generic searches — they're funded, multi-employee operations selling at a different scale, not genuine comparables to a Landrum, SC one-person shop.
- I fetched the shop homepage and one representative product page for each of 6 brands. A 7th candidate, ThoroughlyGenuine (Asheville, NC — healing salve/body butter, found via web search), turned out to be a closed/renamed Etsy shop as of 2026-09-01 (its shop URL 404s); I dropped it rather than report stale data.
- Etsy listing pages returned HTTP 403 to the fetch tool and the browser tool redirected to Etsy's homepage (bot detection), so I could not directly tear down an Etsy-only competitor's product page. All 6 brands below run their own Shopify/Wix storefronts, which is itself a data point (see synthesis).
- Follower/review counts are cited where a source stated them; I did not find a public follower count for @yallternativeliving to benchmark against, so that comparison is omitted rather than guessed.
- Two of the six product pages I fetched (Appalachian Alchemy's salve, Piece of Mynd's lotion, The Witch's Bath's scrub) were showing as sold-out at fetch time — noted per-brand; this doesn't affect the page-anatomy findings but means "add to cart" flows themselves weren't testable live.

---

## Y'allternative Living baseline (for reference, from repo — not modified)

- **Platform:** custom static site + Cloudflare Worker + hosted **Stripe Checkout** (redirect, not embedded/on-page).
- **Price range:** $8 (protection keychain, miracle balm) to $31 (unisex tee); most salves/soaks/scrubs $10–$19.99.
- **Free shipping threshold:** $40, plus a free pocket salve gift-with-purchase at $60 (`shop.freeShippingThreshold` / `shippingMilestones` in `products.json`).
- **Bundles:** 7 named, curated 2–4 item bundles at 10–15% off (`bundles` array), plus a **Pick & Mix custom box** (3–5 items across salves/body/soaks/potions/ritual, 10% off, server-validated in `workers/checkout.js`) and 2oz-salve volume pricing (2+ at $14.99 each).
- **Reviews:** Etsy-sourced `aggregateRating` per product (1–5 reviews each), rendered on-page as visible stars only when a product has 3+ reviews (`main.js` line 2806: `if (!p.rating || !(p.rating.count >= 3)) return "";`); shop-level 4.9★ / 32 reviews / 105 sales in `products.json`.
- **Ingredients/usage:** full ingredient list and a structured `usageGuide` (howToApply / storage / patchTest) on essentially every product — more consistent than any competitor reviewed.
- **Scent notes:** distinctive top/heart/base perfumery-style breakdown on every scented product — none of the 6 competitors do this.
- **Gallery:** up to ~6 images where photographed, but many live products currently ship with only 1–3 images; no video anywhere.
- **Express pay:** none on-page; Apple Pay/Google Pay/Link/Cash App Pay only appear once the shopper reaches Stripe's hosted Checkout page (`workers/checkout.js`: automatic payment methods, no on-PDP wallet buttons).
- **Sticky mobile add-to-cart bar:** yes — implemented (`assets/css/styles.css` `.pdp-sticky-bar`), a feature most competitors below lack.
- **Subscription:** none.
- **Email capture:** footer newsletter form (Kit/ConvertKit) offering "a welcome code, plus new batch alerts, market dates."
- **Loyalty/referral/birthday program:** none found in repo.
- **Cross-sell:** curated `pairsWith` (2 products) per item, framed as a "ritual."
- **Trust signals:** `vegan` / `essential-oil-free` / `sensitive-safe` tags on some SKUs; no formal certifications (no Leaping Bunny, no third-party vegan cert), no press mentions found in repo content.

---

## Brand-by-brand teardown

### 1. Witch Baby Soap — witchbabysoap.com
Fetched 2026-09-01: homepage + [Basic Witch Hand Salve](https://www.witchbabysoap.com/products/basic-witch-hand-salve).

- **Platform:** Shopify.
- **Ownership/story:** "Witch Owned," founded October 2013 (12 years old). Press-featured in Bust, Allure, Buzzfeed, Alternative Press, Insider (per site). Instagram [@witchbabysoap](https://www.instagram.com/witchbabysoap/) has **~180K followers**, per web search of the account.
- **Pricing:** $6.50–$50 site-wide; hand salves $12 for a 2oz tin.
- **Shipping:** free over $75.
- **Product page anatomy (Basic Witch Hand Salve, $12):** 1 product image, no video, no size/variant selector (single SKU), no visible express-pay buttons, no sticky bar, INCI ingredient list present, fragrance-free/no scent-note breakdown, no how-to-use text, no visible reviews, no UGC photos, cross-sell of 4 related body oils, no subscription.
- **Bundles/loyalty:** no bundles or loyalty/referral program found; email list pitched as "weekly magic," "exclusive deals, beauty rituals."
- **Certifications:** none displayed (no vegan/cruelty-free/Leaping Bunny badges).
- **Voice sample:** *"Get Naked. Do witchcraft."* — playful, minimal-copy, relies on years of brand recognition rather than explanation.
- **What they have that Y'all doesn't:** 12 years of real press coverage and a genuinely large social following (180K IG) — a scale/credibility gap, not a site-feature gap. Deep SKU count of themed variants of the same product (9+ hand salve scents found via search alone).
- **What Y'all has that they don't:** sticky mobile add-to-cart bar, structured usage/patch-test/storage guidance, bundles + custom box + volume pricing, scent top/heart/base notes, a free-shipping threshold ($40) that's actually reachable on a single order vs. their $75.

### 2. Appalachian Alchemy — appalachianalchemy.com
Fetched 2026-09-01: homepage + [Ripple Skin Healing Salve](https://appalachianalchemy.com/products/ripple-skin-healing-salve) (sold out at fetch).

- **Platform:** Shopify.
- **Ownership/story:** founded by Lesley Vernon, East Tennessee, practicing "Wise Woman traditions"; ingredients wildcrafted or grown in her own garden. Strong single-founder Appalachian authenticity narrative — closest brand in the set to Y'all's "handmade in the mountains" positioning.
- **Pricing:** not disclosed on homepage; the salve was $14.00 for 2oz (in line with Y'all's $19.99 2oz salves, actually cheaper).
- **Shipping:** no free-shipping threshold disclosed anywhere fetched — a gap for them, not an advantage.
- **Product page anatomy:** **6 product images** (open tin, front/back label, styled shots) — richer gallery than most live Y'all product pages; no video; single size, no variants; standard quantity stepper; no express-pay buttons; no sticky bar; ingredient list (10 botanicals, no INCI); scent notes ("lavender and lemongrass"); usage instructions ("apply liberally to the affected area") plus an explicit **pregnancy/breastfeeding warning callout**; 2 on-page reviews (100% 5-star) with review text shown directly on the PDP; no UGC; no cross-sell or bundle shown on the PDP itself (site has a separate "Gift Ideas" collection).
- **Loyalty:** none; email list for "special offers, recipes, and information."
- **Certifications:** none, but an FDA disclaimer is shown — a liability-conscious labeling move Y'all's site doesn't appear to replicate.
- **Voice sample:** *"Restores and protects hardworking skin"* / "made with love, intention, and respect" — warm, herbalist, low-irony (a contrast to Y'all's irreverent register).
- **What they have that Y'all doesn't:** 6-image PDP galleries as standard; an explicit pregnancy/allergen safety callout box on the product page itself (Y'all's patch-test note is present but less prominent as a dedicated UI element); a dedicated gift-guide collection page.
- **What Y'all has that they don't:** any stated free-shipping threshold at all; bundles/custom box/volume pricing; sticky mobile bar; higher aggregate review volume relative to shop size.

### 3. Rebecca's Herbal Apothecary — rebeccasherbs.com (Boulder, CO)
Fetched 2026-09-01: homepage + [Total Nourishment Body Butter](https://www.rebeccasherbs.com/products/total-nourishment-body-butter).

- **Platform:** Shopify.
- Not Southern/queer-specific, but included as the closest "general herbal apothecary" price/format comparable (small-batch, plant-based, similar body-butter/scrub SKUs, similar $15–$30 zone).
- **Pricing:** $4–$30+ site-wide; body butters $20–$28.
- **Shipping:** free over **$200** — far higher than any other brand reviewed, effectively unreachable for a typical single-item order.
- **Email offer:** 10% off first order (a real % discount code, which none of the other Shopify competitors reviewed offer).
- **Product page anatomy (Total Nourishment Body Butter, $20):** 1 image, no video; dropdown size selector (1oz/2oz); quantity stepper; no express-pay buttons visible; no sticky bar; **full INCI ingredient list**; no structured scent-note breakdown (just "lovely scent" in a review); general use guidance only ("use to heal cracked or dry skin or as daily moisturizer"); 1 review (100% 5-star); no UGC; no cross-sell; no subscription.
- **Trust signals:** local sourcing, plastic-free packaging, staff-expertise framing, and paid/free herbalism classes — a content/education layer none of the other brands (including Y'all) have.
- **Voice sample:** *"Your whole body, not just your beautiful face, deserves the absolute best."* — knowledgeable, warmer-but-more-conventional retail copy, less identity-forward than the witchy/queer set.
- **What they have that Y'all doesn't:** a real first-order percentage discount code; an education/class offering that builds repeat-visit reasons beyond restocking.
- **What Y'all has that they don't:** a free-shipping threshold that's 5x more attainable ($40 vs $200); scent-note profiles; bundles/custom box; sticky bar.

### 4. Witch Queen Workshop — witchqueen.net (Cabell Gathman)
Fetched 2026-09-01: homepage + [Protection Bath Potion Cauldron](https://www.witchqueen.net/product-page/energy-bath-potion-cauldron).

- **Platform:** Wix.
- **Positioning:** explicitly "for all your witchy and/or queer bath product needs" — the single most overtly queer-branded storefront in the set, including identity-specific SKUs like an "Ace of Cakes Asexual Pride Bath Bomb" and a Pride-flag soap bar.
- **Pricing:** $5–$18 site-wide; bundles from $9.
- **Shipping:** no free-shipping threshold disclosed; local pickup offered as an alternative.
- **Product page anatomy (Protection Bath Potion Cauldron, from $13):** 1 image, no video; dropdown variant for crystal topper; numeric quantity field; no express-pay buttons; no sticky bar; ingredient list present (cosmetic-grade, not INCI); scent description ("slightly smoky, stormy autumn woods... juicy cranberry"); how-to-use text with real safety warnings (crystal-removal, staining risk, age restriction); no reviews visible; no UGC; **12 related-product cross-sells** shown on the PDP (much heavier rail than Y'all's 2-item `pairsWith`); no subscription.
- **Loyalty:** none found.
- **Voice sample:** *"A witch ought never to be frightened in the darkest forest..."* — mystical, empowering, unapologetically identity-forward copy.
- **What they have that Y'all doesn't:** identity-specific micro-SKUs tied to specific queer identities/flags (not just a general rainbow-stag motif); a much larger PDP cross-sell rail (12 items vs. 2).
- **What Y'all has that they don't:** any free-shipping threshold; bundles with a real stated discount percentage; sticky mobile bar; structured ingredient/patch-test guidance.

### 5. The Witch's Bath — thewitchsbath.com (Columbus, OH)
Fetched 2026-09-01: homepage + [Wealthy Witch Whipped Sugar Scrub](https://www.thewitchsbath.com/products/wealthy-witch-whipped-sugar-scrub) (sold out at fetch).

- **Platform:** Shopify.
- **Ownership:** explicitly states on-site it is "a black, queer, woman-owned and operated online bath and body shop" — ownership identity is foregrounded as copy, not just implied through aesthetic.
- **Pricing:** $4.75–$18.
- **Shipping:** no free-shipping threshold; instead a **discount code (WITCH10, 10% off)** drives the same incentive.
- **Product page anatomy (Wealthy Witch Whipped Sugar Scrub, $18):** 2 images, no video; style/color/scent variant selectors (all sold out at fetch); quantity field; no express-pay buttons surfaced prominently on the PDP, though the footer displays Shop Pay and Google Pay logos (native Shopify wallet support exists at checkout even if not pushed on the PDP); no sticky bar; full INCI-translated ingredient list; scent notes present; no how-to-use text; no reviews/UGC/cross-sell/subscription on this page.
- **Voice sample:** *"Indulge in the decadent death of Wealthy Witch with creamy lather and the golden lady cameo soap."*
- **What they have that Y'all doesn't:** an explicit, front-and-center ownership-identity statement as trust copy (vs. Y'all's identity coming through tone/aesthetic rather than a stated ownership line); native Shopify wallet buttons (Shop Pay/Google Pay) available at checkout, which read as more familiar/frictionless than a Stripe redirect for shoppers used to Shopify checkout.
- **What Y'all has that they don't:** a free-shipping threshold (vs. code-only discounting); bundles/custom box/volume pricing; sticky mobile bar; ingredient + usage + patch-test structure.

### 6. Piece of Mynd — pieceofmynd.com (Wasilla, AK)
Fetched 2026-09-01: homepage + [Base Camp Unscented Magnesium Lotion](https://pieceofmynd.com/products/base-camp-unscented-magnesium-lotion) (sold out at fetch).

- **Platform:** Shopify.
- **Ownership:** "queer woman owned" (stated across the brand's Instagram/Threads bios) small-batch skincare, Alaska. **This is the single closest category match** in the set — magnesium lotions/sprays (direct analog to Y'all's magnesium sleep salve), ritual bath soaks, beard care, and lip care all overlap directly with Y'all's line.
- **Pricing:** $16–$38.
- **Shipping:** free at $100+ within Alaska, **$150+ nationwide** — far higher than Y'all's $40.
- **Email offer:** 10% off next order.
- **Social proof at scale:** homepage states **154+ customer reviews**; Instagram [@pieceofmyndak](https://www.instagram.com/pieceofmyndak/) has **~1,729 followers** per web search — a social-scale comparable much closer to Y'all's likely size than Witch Baby Soap's 180K.
- **Product page anatomy (Base Camp Unscented Magnesium Lotion, $22):** 2 images, no video; dropdown size selector (2oz/4oz); quantity stepper; no express-pay buttons visible; no sticky bar; ingredient list with organic-certification callouts on specific ingredients; no scent notes (fragrance-free line); how-to-use text present; **3 reviews shown directly on the PDP with reviewer names and quotes** (a materially more trust-building pattern than Y'all's structured-data-only stars, which are hidden below a 3-review threshold); no UGC; no cross-sell/bundle shown on this specific PDP (though the site has a separate "Magnesium Trio Bundle" product elsewhere); no subscription.
- **Voice sample:** *"A soothing, fragrance-free magnesium lotion crafted for sensitive skin and minimalist routines."* Product naming leans poetic/mythological ("Aphrodite's Kiss," "Persephone's Bloom") rather than pun-driven.
- **What they have that Y'all doesn't:** on-page review display with reviewer name + quote (works even at low review counts, unlike Y'all's 3-review gate); a 154+ aggregate review count that reads as more socially proven than Y'all's 32; organic-certification callouts on individual ingredients.
- **What Y'all has that they don't:** a free-shipping threshold that's more than 3x more attainable ($40 vs $150); bundles + custom box + volume pricing; sticky mobile bar; scent-note profiles (where scented); a gift-with-purchase mechanic ($60 free pocket salve) with no equivalent found on Piece of Mynd.

---

## Feature-presence table

| Feature | Y'allternative | Witch Baby Soap | Appalachian Alchemy | Rebecca's Herbal | Witch Queen Workshop | The Witch's Bath | Piece of Mynd |
|---|---|---|---|---|---|---|---|
| Platform | Custom + Stripe Checkout | Shopify | Shopify | Shopify | Wix | Shopify | Shopify |
| PDP gallery (images seen) | 1–6 (varies) | 1 | 6 | 1 | 1 | 2 | 2 |
| Video on PDP | No | No | No | No | No | No | No |
| On-PDP express pay (Shop Pay/GPay/etc.) | No (Stripe redirect only) | Not seen | Not seen | Not seen | Not seen | Logos in footer only | Not seen |
| Sticky mobile add-to-cart bar | **Yes** | No | No | No | No | No | No |
| Free-shipping threshold | **$40** | $75 | Not disclosed | $200 | Not disclosed | None (code-based) | $150 (nat'l) |
| Gift-with-purchase | **Yes ($60→free pocket salve)** | No | No | No | No | No | No |
| Bundles / gift sets | **7 curated + custom box + volume pricing** | No | Gift collection page, not on PDP | Gift boxes | Bundles from $9 | No | Trio bundle (separate page) |
| First-order % discount code | No | No | No | **Yes (10%)** | No | **Yes (WITCH10, 10%)** | **Yes (10%)** |
| Ingredient list on PDP | Yes, nearly all | Yes (INCI) | Yes (common names) | Yes (INCI) | Yes (cosmetic-grade) | Yes (INCI) | Yes + organic callouts |
| Structured scent notes (top/heart/base) | **Yes** | No | No | No | No | No | No |
| Usage guide (how-to/storage/patch test) | **Yes, structured, all products** | No | Partial (safety warning only) | Minimal | Partial (safety warning) | No | Partial |
| On-page reviews visible (not just schema) | Only if 3+ (gated) | No | **Yes (2, with text)** | Yes (1) | No | No | **Yes (3, name+quote)** |
| UGC photos on PDP | No | No | No | No | No | No | No |
| Cross-sell on PDP | 2 curated ("pairsWith") | 4 related | None | None | **12 related** | None | None |
| Explicit ownership-identity statement as trust copy | No (implied via tone) | "Witch Owned" | Founder bio | Staff-expertise framing | Identity-specific SKUs | **"Black, queer, woman-owned" stated directly** | Stated in social bios, not obviously on-site copy fetched |
| Loyalty/referral/birthday program | No | No | No | No | No | No | No |
| Subscription option | No | No | No | No | No | No | No |
| Press/media mentions shown | No | **Yes (Bust, Allure, Buzzfeed, etc.)** | No | No | No | No | No |

---

## 5 highest-leverage gaps for Y'allternative

1. **On-PDP reviews are invisible below 3 count, and the shop has almost none.** Two of six competitors (Appalachian Alchemy, Piece of Mynd) show reviews with reviewer name and quote text directly on the product page even at 1–3 reviews; Y'all's own code actively *hides* the star widget below 3 reviews (`main.js` line 2806), meaning most of the catalog (1–2 review products: sleep-salve, shea-butter, miracle-balm, protection-keychain) shows no social proof at all despite having a 4.9★/32-review Etsy history to draw on. Fix: either lower the display threshold or surface the raw quote text instead of gating on star count.
2. **No first-order discount code.** Three of six competitors (Rebecca's, The Witch's Bath, Piece of Mynd) all convert email signups with an explicit 10%-off code — a proven, low-cost, easy-to-implement lever Y'all's footer signup doesn't currently offer (it only promises "a welcome code" without a stated value in the fetched copy).
3. **Thin PDP galleries relative to the strongest competitor.** Appalachian Alchemy standardizes on 6 images per salve (open tin, both label faces, styled shots); Y'all's `images` arrays in `products.json` are inconsistent — several bestsellers (miracle-balm, beard-salve, bug-spray at only 1–3 images) undersell texture/scale/label detail that a $19.99 impulse buy needs to justify itself without in-hand inspection.
4. **No express/wallet pay on the product or cart page.** Every Shopify competitor in the set has Shop Pay/Google Pay/PayPal available natively at their checkout (visible as footer badges on The Witch's Bath); Y'all's flow requires a full redirect to Stripe Checkout before any wallet option appears, adding a click of friction the others don't have at the cart stage.
5. **No dedicated pregnancy/allergen safety callout as a distinct UI element.** Appalachian Alchemy and Witch Queen Workshop both surface a highlighted safety-warning block (pregnancy/breastfeeding, age restriction, staining) separate from body copy. Y'all has the substance (patch-test/ingredientsNote fields exist in the data, e.g. the almond-oil/tree-nut warning on frankincense-salve) but it's not treated as a distinct, scannable trust element the way competitors format it.

## 3 things Y'allternative already does better than this set

1. **Free-shipping threshold and GWP mechanics.** $40 free shipping (vs. $75–$200 or "not disclosed" among 5 of 6 competitors) plus a $60 gift-with-purchase is a materially more generous, more clearly stated incentive structure than anyone else reviewed — none of the six had a stated gift-with-purchase mechanic at all.
2. **Bundle depth and the Pick & Mix custom box.** 7 curated bundles at 10–15% off plus a server-validated 3–5 item custom box (10% off) and 2oz-salve volume pricing is a more sophisticated merchandising system than any competitor's site; the closest analog (Witch Queen's "bundles from $9") is a simple price-anchored collection, not a real discount mechanic, and most competitors (Witch Baby Soap, Rebecca's, The Witch's Bath) have no bundles at all.
3. **Structured ingredient/usage/scent content and a sticky mobile buy bar.** No competitor in the set pairs a full ingredient list with a structured how-to-apply/storage/patch-test block *and* a top/heart/base scent breakdown on every product — most show ingredients alone, sometimes with a generic safety line. Combined with the sticky mobile add-to-cart bar (present on Y'all, absent everywhere else checked), Y'all's PDPs are doing more conversion-relevant work per product than the sites they were compared against, even though gallery depth and reviews (gap #1 and #3 above) lag.

## Pricing / shipping-threshold positioning vs. the set

| Brand | Price range | Free-shipping threshold |
|---|---|---|
| Witch Queen Workshop | $5–$18 | Not disclosed |
| The Witch's Bath | $4.75–$18 | None (10% code instead) |
| Witch Baby Soap | $6.50–$50 | $75 |
| **Y'allternative Living** | **$8–$31** | **$40 (+ GWP at $60)** |
| Appalachian Alchemy | ~$14+ (partial data) | Not disclosed |
| Piece of Mynd | $16–$38 | $150 (nat'l) |
| Rebecca's Herbal Apothecary | $4–$30+ | $200 |

Y'allternative sits in the middle of the price band — above the two witchy-bath-bomb-driven shops (Witch Queen, The Witch's Bath, both anchored by cheap $5–$9 bath bombs) and below the two most premium/apothecary-positioned shops (Piece of Mynd, Rebecca's). Its $40 free-shipping threshold is the second-lowest in the set by dollar amount and by far the most *reachable relative to its own price points* — a single $19.99 salve plus one $10 add-on clears it, whereas Piece of Mynd and Rebecca's shoppers need to buy 4–8 items to hit $150–$200. This threshold-to-price-point ratio is a genuine, quantifiable competitive advantage worth foregrounding in marketing rather than treating as a routine checkout detail.

---

## Sources (all fetched 2026-09-01 unless noted)

- Y'allternative Living: `assets/data/products.json`, `shop.html`, `assets/js/main.js`, `workers/checkout.js`, `assets/css/styles.css` (local repo, read-only)
- [witchbabysoap.com](https://www.witchbabysoap.com/) · [Basic Witch Hand Salve](https://www.witchbabysoap.com/products/basic-witch-hand-salve) · [@witchbabysoap on Instagram](https://www.instagram.com/witchbabysoap/) (~180K followers, per web search)
- [appalachianalchemy.com](https://appalachianalchemy.com/) · [Ripple Skin Healing Salve](https://appalachianalchemy.com/products/ripple-skin-healing-salve)
- [rebeccasherbs.com](https://www.rebeccasherbs.com/) · [Total Nourishment Body Butter](https://www.rebeccasherbs.com/products/total-nourishment-body-butter)
- [witchqueen.net](https://www.witchqueen.net/) · [Protection Bath Potion Cauldron](https://www.witchqueen.net/product-page/energy-bath-potion-cauldron)
- [thewitchsbath.com](https://www.thewitchsbath.com/) · [Wealthy Witch Whipped Sugar Scrub](https://www.thewitchsbath.com/products/wealthy-witch-whipped-sugar-scrub)
- [pieceofmynd.com](https://pieceofmynd.com/) · [Base Camp Unscented Magnesium Lotion](https://pieceofmynd.com/products/base-camp-unscented-magnesium-lotion) · [@pieceofmyndak on Instagram](https://www.instagram.com/pieceofmyndak/) (~1,729 followers, per web search)
- Dropped candidate: [ThoroughlyGenuine on Etsy](https://www.etsy.com/shop/ThoroughlyGenuine) — 404/shop not found as of 2026-09-01, excluded from analysis
