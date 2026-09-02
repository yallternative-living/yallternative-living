# Reviews & UGC — legal floor, tactics, and a concrete plan for Y'allternative Living

Grounded against the actual repo (`assets/data/site-reviews.json`, `reviews.html`, `shop.html`, `index.html`, `assets/data/social-feed.json`, `scripts/build-site-data.js`, `scripts/apply-etsy-snapshot.js`, `docs/AUDIT-2026-09-01.md`) as of 2026-09-01, plus FTC/Google/Etsy primary sources and industry benchmark research (citations inline).

---

## 1. What the FTC rule actually forbids (16 CFR Part 465, effective Oct 21, 2024)

This is a **Trade Regulation Rule**, not guidance — the FTC can seek civil penalties directly, no need to prove a company "knew" in the old FTC Act §5 sense for these specific practices. [Federal Register, final rule, Aug 22, 2024](https://www.federalregister.gov/documents/2024/08/22/2024-18519/trade-regulation-rule-on-the-use-of-consumer-reviews-and-testimonials) · [FTC press release](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials) · [16 CFR 465, eCFR](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465) · [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)

**Forbidden:**
- Fake/fabricated reviews — by a non-existent person, AI-generated, or by someone with no real experience with the product.
- **Insider reviews without disclosure** — an owner, employee, or family member reviewing the business without disclosing the relationship.
- **Buying reviews** — any compensation or incentive *conditioned on* the review expressing a particular sentiment (positive or negative). Unconditional incentives (same reward regardless of what they say) are still legal — see §2.
- **Review suppression** — threatening or intimidating a reviewer, or selectively publishing only positive reviews while hiding/deleting negative ones on a site you control, in a way that misrepresents that the shown reviews are representative.
- **Misrepresenting review counts** — implying a review section shows "all" or "most" reviews when negative ones were filtered out.
- **Fake "verified" indicators** — labeling a review "verified buyer/purchase" when it wasn't actually confirmed against a real transaction.
- **Testimonials from non-users**, and **company-controlled sites posing as independent** review sources.
- Buying/selling fake social-media indicators of influence (fake followers, fake engagement) — same rule, different section.

**Penalties:** consumer redress plus civil penalties up to **$53,088 per violation** (2025 inflation-adjusted amount, still in effect for 2026 — no CPI adjustment was published this year). [FTC 2025 penalty notice](https://www.ftc.gov/news-events/news/press-releases/2025/02/ftc-publishes-inflation-adjusted-civil-penalty-amounts-2025) · [Federal Register, no 2026 adjustment](https://www.federalregister.gov/documents/2026/07/07/2026-13629/no-adjustment-to-civil-monetary-penalty-amounts). "Per violation" is the multiplier that matters for a small shop — three sample posts with invented handles could, in theory, be read as three violations, though FTC enforcement in practice targets pattern/scale, not one-person shops making an isolated mistake. That's not a reason to leave it live.

**Where "Spotted In The Wild" (`assets/data/social-feed.json`) lands:** three posts with `author`/`handle` fields that are not real people — `"author": "Landrum Local", "handle": "@backroad_soaker"` and `"author": "Bold Hearts", "handle": "@night_ritual_co"` — captioned as if they're real customer social posts ("Landrum farmers market starts at 9am tomorrow, see y'all there!"). This is a **fabricated consumer review/testimonial** under the plain language of the rule: it misrepresents that real, non-existent people posted about the product. It's currently gated behind `enableSocialFeed: false` in `assets/data/content.json:19` (confirmed off), which is the only reason it isn't live right now. It cannot go back on with placeholder data — see §6.

**Do / Don't for a one-person shop:**
- DO ask every real customer once, unconditionally, disclose any incentive, and post only what you actually receive.
- DO disclose your own relationship if you (or family) ever leave a review of your own shop — or just don't do it. Simplest compliant answer: never post an "insider" review as if it's a customer's.
- DON'T invent handles, captions, or reviews to fill an empty section — an honest "we're just getting started" beats a fake wall of praise, and it's the difference between a UX gap and a federal violation.
- DON'T delete/hide only negative reviews while claiming the display is complete. You *can* choose not to publish a review that fails content moderation (profanity, off-topic, unrelated to a real purchase) as long as that policy is applied evenhandedly and disclosed if asked — moderating for quality/legitimacy isn't "suppression" under the rule; cherry-picking by sentiment is.
- DON'T tag a review "verified buyer" unless you can point to an actual order. See §6 for how this site can do that cheaply.

---

## 2. Legitimate acquisition — what actually works, with numbers

| Tactic | Evidence | Note |
|---|---|---|
| Post-purchase email, timed 48–72 hrs after **delivery** (not order date) | Structured-ask programs lift the unprompted 5–10% write-rate to 15–40% | [PowerReviews: when to ask](https://www.powerreviews.com/when-to-ask-for-reviews-best-practice-guide/), [1440.io 2026 guide](https://www.1440.io/blog/how-reviews-impact-conversion-rates-a-data-backed-guide-for-2026/) |
| Subject line | "Quick question about your order" outperforms "Please review your purchase" by 2–3x on opens; keep the body under ~60 words; Tue–Thu 10am–2pm local time performs best | same sources above |
| Category-adjusted delay | Skincare/salves benefit from waiting **14–21 days** (product needs to be used, not just arrive) vs. apparel at 5–7 days | same sources above |
| QR code on a package insert / market-table card | 20–40% response rates reported vs. 10–30% for generic feedback asks — friction removal (no typed URL) is the mechanism | [QRCodeKit](https://qrcodekit.com/news/qr-codes-for-customer-feedback/), [Craft Industry Alliance](https://craftindustryalliance.org/everything-you-need-to-know-about-qr-codes-for-your-craft-business/) |
| Market-booth verbal ask | No hard published response-rate study found (gap — treat as directional, not evidenced); the QR-card mechanism above is the actual lever, verbal ask is just the prompt to scan | — |
| **Incentives** | Legal only if unconditional of what they write and disclosed. A flat "leave a review, get 10% off your next order" (any review, any rating) is fine; "leave a 5-star review for 10% off" is a straight violation | [FTC final rule §465.7](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465), [FTC Endorsement Guides](https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews) |
| Photo/video review incentives | Same rule applies — incentive must be for *any* photo review, not a good one. Photo reviews carry outsized conversion value (§5), so this is worth the modest cost | — |
| Google review request | **Only if you're eligible for a Google Business Profile** — see the flag in §6/rules-you'd-break | [Google eligibility guidelines](https://support.google.com/business/answer/13763036) |
| Instagram UGC repost | Tagging ≠ license. Need explicit consent — a DM/comment reply ("mind if we repost this?" + a yes) is the accepted minimum bar for organic reposts; anything used in paid ads needs a written rights agreement | [Later.com UGC rules](https://later.com/blog/user-generated-content-rules/), [Digital Main Street](https://digitalmainstreet.ca/tool/how-to-legally-repost-user-generated-content-on-instagram/) |

---

## 3. Displaying reviews at tiny volume (12 site reviews, 32 on Etsy)

- **Don't average the two pools together.** The site already does this correctly — `shop.html:1290-1293` has a comment explicitly noting site reviews are "separate from ... the aggregateRating JSON-LD or the '4.9 average / 32 Etsy reviews'" figure. Keep that separation: it's both a Google structured-data rule (aggregateRating must be backed by reviews collected by/visible on the site carrying the markup — Etsy's 32 weren't collected by yallternativeliving.com) and an honesty point (site reviews are real but a small, self-selected 12; don't dilute the Etsy 4.9/32 with them or vice versa).
- **Show the star distribution, not just the average**, once volume justifies it. At n=12 a bar chart of 1 one-star and 11 five-stars looks more credible than a bare "4.7 average" — Baymard's research found users who don't see a distribution are more likely to conclude reviews are fake when they see an unbroken wall of 5-stars, and 53% of shoppers actively hunt for the negative reviews first. [Baymard: ratings distribution](https://baymard.com/blog/user-ratings-distribution-summary)
- **"Verified buyer" needs real evidence, not a manual toggle.** Right now `assets/data/site-reviews.json` sets `verifiedBuyer` per-entry by hand (e.g. `jordan-p`/`riley-h`/`sam-b`/`avery-g` are `false`, others `true`) with no visible mechanism tying it to an actual Stripe order — it's Savanna's word, not a checked transaction. Industry definition of the badge is "we matched this reviewer's order to a real purchase" ([Yotpo glossary](https://www.yotpo.com/glossary/what-is-a-verified-buyer/), [Judge.me](https://judge.me/authenticity)) — the FTC rule explicitly bans a **fake** verified indicator (§465.4). §6 below has the cheap fix, now that the site has a real order database (`yallternative-state` D1, per `git log`: `b1cb8aa feat(workers): bind the real yallternative-state D1 database`).
- **Importing Etsy reviews**: keep them verbatim (edits/paraphrase risk both copyright — the reviewer owns their own text — and FTC "misrepresenting the experience" if a paraphrase changes meaning), attribute clearly (`site-reviews.json` already does this right: `"name": "Eric M. (Etsy)"`), and disclose that they were collected on a different platform. There's no Etsy-specific "you may not repost your own reviews elsewhere" prohibition found in Etsy's Buyer Policy ([etsy.com/legal/buyers](https://www.etsy.com/legal/buyers/)) — the live legal risk is generic (copyright in the reviewer's own words, plus FTC accuracy), not an Etsy ToS breach, but Etsy's buyer-privacy framing means you should still strip anything beyond first-name-last-initial and never publish a buyer's email/city without consent.
- **Responding to negative reviews**: worth doing. 87% of sites studied don't respond at all, and responses build trust precisely because they're rare and visible. [Baymard: respond to negative reviews](https://baymard.com/blog/respond-to-negative-user-reviews) — the 3-star Avery G. review already in `site-reviews.json` ("wish the rosemary scent lingered longer") is a good practice target: a short, warm, on-brand reply costs nothing and reads as more credible than silence.
- **Review schema / AggregateRating**: this repo already implements the correct distinction — `Product` schema is the one type Google exempts from the "self-serving" restriction (a shop *can* collect and mark up reviews of its own products on its own site); `Organization`/`LocalBusiness` markup is not exempt, and this site's JSON-LD doesn't attach `aggregateRating` at the Organization level (`scripts/build-site-data.js:3014` uses `Organization` only as the `seller`, not the rated entity) — good, keep it that way. [Google review-snippet docs](https://developers.google.com/search/docs/appearance/structured-data/review-snippet) · [Google 2019 self-serving update](https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful). `build-site-data.js:715-722` already gates every `aggregateRating` on the product having a real Etsy-listing rating or a real site review (added post-audit, per `docs/AUDIT-2026-09-01.md:96`, finding **DI-3**) — this is the right pattern, keep enforcing it on every new product.
- **Gap worth flagging**: Google's guidance also expects the reviews behind an AggregateRating to be *visible on the page carrying the markup*. For products whose rating comes only from the Etsy per-listing snapshot (no site review yet), the PDP shows a star average with no review text under it — technically thin. Low priority given tiny volume, but as more products accumulate Etsy-only ratings, add a one-line "See what buyers say on Etsy →" link near the stars so there's something a human (and Googlebot) can actually read.
- **Photo reviews**: none currently accepted (`reviews.html` form has no file upload). See §5 for why this is worth adding despite the extra moderation burden.

---

## 4. UGC feed: replacing the fake strip honestly

Instagram Basic Display API was shut down **December 4, 2024**. It only ever supported personal accounts pulling their own media anyway — irrelevant to a business feed. [Smashballoon writeup](https://smashballoon.com/instagram-is-shutting-down-basic-display-api-continue-displaying-instagram-feeds-on-your-site/) · [Spotlight WP](https://spotlightwp.com/instagram-basic-display-api-is-ending/)

Current options for a **business/creator** Instagram account (personal accounts don't qualify for any of these):

1. **Instagram Graph API direct** — free, but requires a Meta developer app, a connected Facebook Page, and periodic token refresh/App Review if you exceed the "advanced access" basic limits. Realistic for a technical operator willing to maintain it; overkill for a one-person shop unless there's already a Cloudflare Worker doing the token refresh (there is a Worker stack here already — `workers/`).
2. **Third-party embed widget** (SnapWidget, LightWidget, Elfsight, EmbedSocial, Curator.io) — the practical choice for a static site. Typical cost: free tier for a single feed with a badge/watermark, $10–30/mo to remove branding and get consent/rights-request tooling built in. They handle the Graph API token refresh for you.
3. **Manual curated grid** — zero cost, zero API dependency, matches what this site actually needs at its size: hand-pick 6-8 real customer/market photos, get consent (see §2), host the images locally (`assets/img/`), and swap them a few times a year. Given the shop only has occasional market appearances and a small follower base, this is very likely the right answer over any live-embed option — it needs zero new infrastructure and can't silently start showing fake-looking content again the way `social-feed.json` did.

**CSP implication, confirmed against `_headers`/`scripts/build-security-headers.js:354-369`:** this site runs a genuinely locked-down CSP — `script-src`, `img-src`, and `connect-src` are all explicit allowlists (`cloud.umami.is`, `*.tawk.to`, Google Translate, `formspree.io`, `app.kit.com` — no Meta/Instagram domain anywhere). Any of options 1 or 2 above requires **adding the vendor's specific domains** to `script-src`/`frame-src`/`img-src`/`connect-src` (each embed tool uses different domains — check the vendor's own CSP doc before wiring it in), which is a real, auditable widening of the attack surface on a site that has clearly invested in tightening it (see the CSP rewrite context in `scripts/build-security-headers.js`). **Option 3 (manual grid) requires zero CSP changes** — images are same-origin. That's a strong practical argument for it here, independent of the FTC issue.

---

## 5. Benchmarks

- **Review count → conversion**: any reviews (vs. zero) lift conversion; PowerReviews' large-sample analysis (~1.5M product pages) shows roughly **+77% conversion lift in the 1–100 review band**, climbing further at higher volumes and flattening out — the big jump is 0→a few reviews, not 12→32. [PowerReviews: review volume](https://www.powerreviews.com/review-volume-conversion-impact/)
- **Photo/video reviews**: interacting with visual UGC on a product page shows **~168% conversion lift** in PowerReviews' data; having photo reviews present at all (vs. text-only) shows a smaller but still real **~9–14% lift across all visitors**. [PowerReviews: visual UGC](https://www.powerreviews.com/visual-ugc/)
- **Diminishing returns**: the curve is steep near zero and flattens fast — going from 0 to ~10 reviews matters far more than 12 to 32. This site is already past the steepest part of the curve on Etsy (32) and just past the "any reviews at all" threshold on-site (12) — the marginal unit of value now is in **display quality** (distribution, photos, responses) more than raw count.
- **4.5★/12 reviews vs. 4.9★/32 reviews**: to a skeptical shopper, small-n high averages read as *less* trustworthy than they used to (this is the exact skepticism the FTC rule targets) — a tight 4.9 with visible written reviews and a couple of photos reads as far more credible than the bare number. The site reviews average isn't stated anywhere on-site as a headline number (good — averaging 12 mixed 3-5 star reviews would currently land around 4.5, and displaying that number without distribution/context next to the Etsy 4.9 headline risks looking like two different, cherry-picked stories). Keep them visually and structurally distinct (already true), and don't ever headline a combined average.

---

## 6. Concrete plan for this site

**Review-request flow**
- Trigger point: `workers/routes/stripe-webhook.js` already handles `checkout.session.completed` and the state layer now has a real D1 database (`yallternative-state`, wired in `b1cb8aa`). Add a scheduled follow-up (Cloudflare Cron Trigger or a queued Resend send) at **delivery + 10–14 days** (salves/soaks — give it time to actually be used, per §2's category guidance), not immediately on the thank-you page. The current ask on `thank-you.html:216-225` fires the instant checkout completes, before the product has shipped — worst possible timing; keep that block as a low-key "here's where reviews live" mention, but move the *real* ask to the delayed email.
- Copy, in brand voice (matches `content.json` tone — direct, a little wry, "y'all"): subject `"Quick one — how's the [salve] treating you?"`; body under 60 words, one clear CTA button to `shop.html#reviews` (site) and a secondary link to the Etsy listing. No incentive language unless you also build the unconditional-incentive infra (§2) — don't half-implement an incentive (e.g. mention "we'd love a photo!" without a defined, disclosed reward, which is fine — an undisclosed *ask* isn't a violation, only a *conditional reward* is).
- Verification: when a Formspree review submission's email matches an email in the D1 orders table for that product, set `verifiedBuyer: true` server-side (or in the CMS review-moderation step) — genuinely evidenced, not asserted. This closes the fake-verified-indicator gap in §3.

**reviews.html / shop.html review section**
- Add a star-distribution bar (1★–5★ counts) above `#reviewsGrid` (`reviews.html:150`) once there are enough reviews to make it meaningful (even at 12, showing "1 three-star, 11 four/five-star" beats a bare average).
- Add photo-upload capability to the review form (`reviews.html:158` `<form id="reviewForm">`) — Formspree supports file uploads on paid plans; if staying on the free tier, add an optional "email us a photo separately" line instead. Given the ~9-168% conversion evidence in §5, this is the single highest-leverage display change available.
- Add a one-line reply mechanism for negative reviews (even a static `ownerReply` field in `site-reviews.json`, hand-authored) — costs nothing, directly targeted at the 87%-of-sites-don't-do-this gap.

**Etsy-review disclosure line**: add a short, honest line near the Etsy-sourced reviews (the three `"(Etsy)"`-suffixed entries in `site-reviews.json`, already surfaced on `index.html:317-327`) — something like *"Copied over from our Etsy shop with the reviewer's own words, unedited."* One sentence, placed once near the first Etsy-attributed review or in a footnote, satisfies both the FTC "don't misrepresent the source" concern and general reader honesty.

**Relaunching the social strip honestly** (`enableSocialFeed` in `content.json:19`, currently `false`):
1. Replace all three entries in `assets/data/social-feed.json` with real photos from actual customers/market appearances, each with genuine consent (§2) — or, if none exist yet, leave the section off rather than backfilling with anything invented.
2. Simplest compliant relaunch: swap `social-feed.json` for 4-8 of Savanna's own market/product photos (author: "Y'allternative Living", no invented third-party handles) captioned honestly as shop photos, not pretend customer posts — this alone removes the FTC exposure while the real customer-UGC pipeline (ask permission at markets, in post-purchase emails) fills in over time.
3. Once real tagged posts start coming in via Instagram, go with the manual curated grid (§4, option 3) — download the image, get explicit consent, credit the real handle, no new CSP surface, no vendor cost, no API to maintain on a one-person shop's time budget.
4. Don't re-enable `enableSocialFeed: true` until step 1/2 is done — verify by reading `assets/data/social-feed.json` directly before flipping the flag, since the flag and the data are decoupled and it would be easy to flip the flag back on without checking the underlying content is real.

---

## Must / Should / Nice checklist

### MUST (legal floor / real exposure)
- [ ] **Never re-enable `enableSocialFeed` while `social-feed.json` contains invented handles/authors.** Current content (`@backroad_soaker`, `@night_ritual_co`) is a textbook fake-testimonial violation under 16 CFR 465.2. [FTC final rule](https://www.federalregister.gov/documents/2024/08/22/2024-18519/trade-regulation-rule-on-the-use-of-consumer-reviews-and-testimonials)
- [ ] **Stop hand-toggling `verifiedBuyer` without an evidenced check.** A "verified" label with no real verification is its own violation (§465.4). Tie it to an actual D1 order match. [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- [ ] **Never launch a Google Business Profile for this business as currently structured.** It's an online shop shipping goods with occasional market pop-ups, not a business making in-person service calls or maintaining a storefront — Google's stated eligibility requires in-person customer contact during stated hours, and e-commerce-only businesses are explicitly listed as ineligible. Registering one (or hiding a home address behind a fake "service area") risks suspension and looks worse than having none. [Google eligibility guidelines](https://support.google.com/business/answer/13763036) · [Local Falcon summary](https://www.localfalcon.com/blog/everything-you-need-to-know-about-google-business-profile-eligibility) — see rules-you'd-break-by-accident below, this is the one most likely to get built without anyone checking first.
- [ ] **Never offer or accept a review incentive conditioned on sentiment** ("5 stars for 10% off"). Only unconditional incentives, disclosed as incentivized, are legal. [FTC final rule §465.7](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465)
- [ ] **Keep the Etsy 4.9/32 figure and the site's own review pool structurally separate** — already correctly done (`shop.html:1290-1293`); don't regress this when editing.
- [ ] **Keep `aggregateRating` off any `Organization`/`LocalBusiness` JSON-LD** — already correctly scoped to `Product` only; don't let a future SEO pass add it at the org level, which Google explicitly disallows as self-serving. [Google 2019 policy](https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful)
- [ ] **Keep the `build-site-data.js:715-722` rating-must-be-backed-by-a-real-source check in place** for every new product — this is the guardrail that already caught fabricated ratings once (audit finding DI-3).

### SHOULD (real ROI, evidenced, not legally forced)
- [ ] Move the review ask off the immediate thank-you page and into a delayed (10-14 day) email tied to the Stripe webhook / D1 order data.
- [ ] Add a star-distribution display to `reviews.html`/`shop.html` — evidenced trust lift at low review counts. [Baymard](https://baymard.com/blog/user-ratings-distribution-summary)
- [ ] Add photo-upload to the review form — largest single conversion lever available given current traffic/review volume. [PowerReviews](https://www.powerreviews.com/visual-ugc/)
- [ ] Add a visible, one-line disclosure that Etsy-sourced reviews are reposted verbatim with attribution.
- [ ] Add a lightweight owner-reply field for negative reviews (even the existing 3-star Avery G. review is a good first target) — 87% of competitors don't do this. [Baymard](https://baymard.com/blog/respond-to-negative-user-reviews)
- [ ] QR code on package inserts / market-table cards pointing straight to `reviews.html` or the Formspree form — cheap, evidenced 20-40% response rate vs 10-30% for a plain ask.

### NICE (marginal, low urgency at this scale)
- [ ] Manual curated UGC grid to replace the live-feed concept entirely — avoids CSP changes, API maintenance, and vendor cost; revisit once there's a real trickle of tagged customer photos.
- [ ] A "See what buyers say on Etsy →" link near Etsy-only product ratings that currently show a star average with no visible review text on the page.
- [ ] Consider Instagram Graph API direct integration only if/when there's enough post volume and technical bandwidth to maintain token refresh — not worth it today.

---

## Rules you would break by accident

These are the ones a reasonable, well-intentioned person would trip on without reading the primary sources first — flagged because they're specifically live risks in *this* codebase/plan, not generic warnings.

1. **Setting up a Google Business Profile "since we're a local business."** The instinct is obvious — Landrum, SC, farmers markets, why not claim the Maps pin. But Google's rule is about in-person customer contact *at the times you claim to be open*, and this is an e-commerce shop with occasional pop-ups, not a plumber-style service-area business or a storefront. A GBP built for this business shape gets suspended, and a suspended/flagged listing is worse for trust than no listing.
2. **Re-enabling `enableSocialFeed: true` after editing something else in `content.json` without re-checking `social-feed.json`.** The flag and the data live in two different files; it would be very easy to flip the switch back on during an unrelated content edit and not notice the fake posts are still sitting there.
3. **Treating "the customer said it's fine, I labeled it verified" as verification.** Manually setting `verifiedBuyer: true` because you personally remember selling to that person is not what the badge means to a reader, and not what FTC guidance means by "verified" — it needs to trace to an actual transaction record, which the site now has the infrastructure (D1) to do.
4. **Offering "leave a review for 10% off" as a throwaway line in a thank-you email**, forgetting the *for* is the violation. The fix is one word: "leave a review, *any* review, for 10% off."
5. **Editing an imported Etsy review for length/tone before posting it on-site** ("cleaning it up" for readability). Altering the substance of someone else's endorsement is squarely what the Endorsement Guides prohibit, and it's the reviewer's copyrighted text besides — trim only with brackets/ellipses that don't change meaning, or don't trim at all.
6. **Assuming a comment reply ("mind if we repost?" + emoji thumbs-up) is enough consent for paid ad use of a customer photo**, when it's only accepted as consent for an organic repost. Ads need an actual written rights agreement.
7. **Adding an Instagram embed widget and only checking that it displays correctly** — not that its script/image/connect domains were added to the CSP in `_headers`/`scripts/build-security-headers.js`. On this site the CSP is enforced and specific; an embed that silently gets CSP-blocked will just show a blank box, and the fix under deadline pressure is often to loosen the CSP more broadly than the one vendor domain that's actually needed.
