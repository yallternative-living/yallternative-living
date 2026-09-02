# Email/retention plan for Y'allternative Living — Sept 2026

Scope check against the actual repo (not just the brief): `assets/js/main.js`, `assets/js/cart.js`, `workers/checkout.js`, `workers/routes/*`, `workers/state/loyalty.js`, `docs/STATE-LAYER.md`, `admin/config.yml`, `*.html` footers. Findings from the code are marked **[code]**; everything else is marked with a source and date.

## Verdict up front

Three of the five things already built (welcome discount, birthday club, Alt-Points) are **broken or inert as implemented**, not just "unoptimized":

- The welcome code is one static string in the CMS, shown to every visitor forever. **[code: `admin/config.yml:752`, `assets/js/main.js:383-400`]** It is screenshot-and-share bait, not a discount.
- The birthday field posts to Kit **[code: `contact.html:371` etc.]**, but Kit's free plan has **zero automations** (confirmed on Kit's own pricing page, below) — so the birthday reward this field exists to trigger cannot fire without a paid plan or custom code. Right now the shop is collecting a date of birth field for nothing.
- "Alt-Points" shows "Earn N Alt-Points" badges everywhere **[code: `assets/js/main.js:2512-2956`]**, backed by a `localStorage["yl_loyalty_points"]` wallet **[code: `assets/js/cart.js:698-739`]** — but the only endpoint that ever redeemed points was deleted after an internal audit found it minted an unlimited-use Stripe coupon from a client-supplied number (finding C-1, `docs/STATE-LAYER.md:30`). There is no redemption route left in `workers/checkout.js`'s `ROUTES` object. So today: real "earn" promises, on every product, that lead to a wallet that always reads whatever number is in localStorage and **cannot be spent by anyone**. That's not a loyalty program, it's a broken promise on every page.

None of this needs a marketing decision. It needs deletion or repair before anything new gets built on top of it.

The second load-bearing finding: **Kit's free plan cannot run any automated flow at all** — not "one automation," zero. That contradicts a lot of the SEO blog chatter about Kit's free tier and changes the whole plan (§2).

---

## 1. Which automations matter, ranked by expected revenue at ~100 orders/yr

Benchmark data below is aggregated across e-commerce broadly (fashion, beauty, supplements, etc.), skewed toward brands with real order volume and AOVs often well above this shop's $15–40. Treat every dollar figure as directional, not a forecast — a 2026 aggregate report from Klaviyo pools tens of thousands of stores; **this shop will not hit list-level statistical significance for a year or more**, and its own numbers should replace these benchmarks as soon as it has ~50 orders through any given flow.

| Rank | Flow | Evidence | Feasible on this stack? |
|---|---|---|---|
| 1 | **Post-purchase (order confirm → how-to-use → review ask)** | Post-purchase/thank-you flows are consistently among the top 3 automated flows by RPR industry-wide; automated flows overall deliver 16–30x the RPR of one-off campaigns (Omnisend 2026 report: automated emails were 2% of sends but 30% of revenue, $3.41 RPR vs $0.155 for campaigns — a 22x gap; Klaviyo 2026 benchmarks: flows are ~18x campaign RPR). [Omnisend, *2026 Ecommerce Marketing Report*, omnisend.com, accessed 2026-09-01](https://www.omnisend.com/resources/reports/2026-ecommerce-marketing-report/); [Klaviyo, *2026 Email Marketing Benchmarks*, klaviyo.com, accessed 2026-09-01](https://www.klaviyo.com/products/email-marketing/benchmarks) | Yes — no Kit automation needed, see §8. Uses infra already in this repo (Resend, D1). |
| 2 | **Welcome discount, fixed** | Welcome flows see 40–60% open rates vs 18–25% for campaigns (Klaviyo 2026). For a shop with a "10% off first order" promise already advertised sitewide, this is the highest-open-rate mail this business will ever send — but only if it actually gates on first order (§3). Currently it doesn't. [Klaviyo, *2026 Email Marketing Benchmarks*](https://www.klaviyo.com/products/email-marketing/benchmarks) | Fixing the code (single-use, first-order-only) is a Stripe API change, not a Kit change — cheap. |
| 3 | **Abandoned cart** | Highest per-flow RPR in most reports: Klaviyo-flow aggregates cited across 2025–2026 trackers put abandoned-cart around a 50% open rate and $3–3.65 RPR, well above other flows; timing matters enormously — sub-1-hour sends convert ~20%, 24h+ sends fall to ~12% (via Klaviyo flow data, reported by Ringly, *50 Ecommerce Cart Abandonment Statistics for 2026*, ringly.io, accessed 2026-09-01). [Baymard Institute, *44 Cart Abandonment Rate Statistics*, baymard.com, updated 2025-09-22](https://baymard.com/lists/cart-abandonment-rate) | Feasible but structurally awkward here — see the Stripe-specific caveat below. This shop's cart abandonment is likely mobile-heavy per the brief, and mobile abandonment (80%) runs meaningfully higher than desktop (66%) (Dynamic Yield 2025 data, cited in the same Ringly piece). |
| 4 | **Replenishment reminder (2oz salve)** | A named, product-specific flow type in every major ESP's playbook for consumables; Klaviyo's own guidance is to fire it a few days *before* the customer is expected to run out, timed off actual average-days-between-orders for that SKU — but that number only becomes statistically usable once you have volume ("qualifying for predictive analytics needs 500+ customers who've ordered"), which this shop won't have for years. [Klaviyo Community, *Average Days Between Orders*, community.klaviyo.com, accessed 2026-09-01](https://community.klaviyo.com/campaigns-and-flows-30/average-days-between-orders-761) | Feasible, but start with an *estimated* interval (see §8), not a data-driven one — the "supplement/body-care 30-45 day usage cycle" logic is a placeholder, not measured. |
| 5 | **Review request** | See §6 for timing; not a revenue-per-send flow so much as a compounding asset (reviews drive future conversion — Baymard's own product-page research is the relevant citation, not an email-benchmark number). | Yes, cheap, do it. |
| 6 | **Win-back (lapsed customer)** | Genuinely useful at scale; at ~100 orders/year across (optimistically) 60-80 unique customers, a win-back flow triggers for maybe 1-2 people a month in year one. Real, but small in absolute revenue terms until the customer base compounds. Omnisend/Klaviyo don't break out win-back RPR separately in the reports pulled here at a size where it would be trustworthy for a shop this small. | Deprioritize to year 2. |
| 7 | **VIP/birthday** | Omnisend's 2025 report highlights birthday-flow AOV as outsized (reported at $744/order, ~4x platform average) — but that figure is pooled across all Omnisend verticals including high-ticket categories (jewelry, electronics), and is not representative of a $15-40 salve shop; treat as evidence that birthday sends over-index on AOV in general, not as a forecast for this store. [Omnisend, *New Omnisend Report Shows eCommerce Shift Toward High-Intent Engagement in 2025*, omnisend.com, accessed 2026-09-01](https://www.omnisend.com/blog/email-marketing-statistics/) | Only worth it once the anniversary-of-first-order alternative replaces the birthday field (§4) — as currently built, this flow has no trigger mechanism at all. |
| 8 | **Browse abandonment** | Real, but needs product-view tracking synced to identified email — a heavier lift than cart abandonment for a static site with no logged-in accounts. Skip until the higher-RPR flows above are live and stable. | Not worth building first. |

**Bottom line ranking for a 1-person, ~100-orders/yr shop:** post-purchase sequence, fixed welcome discount, abandoned-cart recovery (structurally cheap given the Stripe feature already exists), replenishment reminder for salves, review request. Win-back, VIP/birthday, and browse abandonment come later or not at all at this volume.

---

## 2. Kit in 2026 — read the free-tier fine print before planning anything

This is the finding that reshapes the whole plan. Fetched directly from Kit's own pricing page:

> **Free ($0/mo, up to 10,000 subscribers):** unlimited landing pages, forms, and broadcasts; audience tagging/segmentation; sell digital products; 1 user account; "basic product support."
> **Creator ($33/mo annual, $39/mo monthly, from 1,000 subscribers) — "Everything in Free, plus": unlimited visual automations, unlimited email sequences, Kit MCP integration, A/B testing, SMS marketing, remove Kit branding, 24/7 support, 2 user accounts.**

[Kit, pricing page, kit.com/pricing, accessed 2026-09-01](https://kit.com/pricing)

Read that literally: **automations and sequences are not "limited" on Free, they are absent.** Free-tier Kit can send a manual newsletter broadcast to a tag/segment and nothing else — no welcome series, no purchase-triggered anything, no delayed sends of any kind. (Several SEO blogs claim "1 free automation" — that's stale or wrong; the vendor's own comparison table lists automations and sequences only under "Everything in Free, plus," i.e., paid-only. Don't plan around the blog claim.)

What that means for each of the brief's questions:

- **Subscriber cap:** 10,000 on Free — irrelevant at this shop's scale, not a constraint for years.
- **Custom fields (birthday):** available on Free — the form already posts `fields[birthday]` successfully. Data capture works fine; *acting* on it does not (see above).
- **API/webhooks:** Kit's REST API v4 covers subscribers, tags, sequences, custom fields, purchases, and webhooks (72 operations) and is not gated behind a paid plan the way the visual-automation UI is [Kit developer docs, *Upgrading to V4*, developers.kit.com, accessed 2026-09-01](https://developers.kit.com/api-reference/upgrading-to-v4). So the Worker *can* tag a subscriber or push a purchase record via API on Free — it just can't make Kit *act* on that data with a delayed/branching flow, because the automation engine that would consume it is paid-only.
- **Trigger from a Stripe purchase:** three paths exist — (a) Kit's own Stripe integration [Kit Help Center, *Stripe Integration: Troubleshooting*, help.kit.com, accessed 2026-09-01](https://help.kit.com/en/articles/2827332-stripe-integration-troubleshooting), which tags subscribers on payment events but still needs the *automation* to act on the tag, so it's dead weight on Free; (b) Zapier/Make watching the Worker's Stripe webhook and calling Kit's API to tag/subscribe [Make, *Stripe and Kit Integration*, make.com, accessed 2026-09-01](https://www.make.com/en/integrations/stripe/convertkit) — works for tagging on Free, still can't drive delayed sends without a paid automation on the Kit side (or a paid multi-step Zap with Delay steps, which Zapier also gates off its free tier); (c) the Worker calls Kit's API directly from `handleStripeWebhook` — no new vendor, and it's the only path that can also drive *timing*, because the delay logic lives in the Worker, not in Kit. **(c) is the only option that doesn't eventually require a Kit or Zapier subscription.**
- **Deliverability (Google/Yahoo bulk-sender rules):** any domain sending ≥5,000 messages/day to Gmail is a "bulk sender" and must have SPF + DKIM authenticating, a published DMARC record (minimum `p=none`) with From-domain alignment, one-click unsubscribe (required since June 1, 2024) on all commercial/promotional mail, and a spam-complaint rate under 0.3% (Google's guidance says aim under 0.1%) [PowerDMARC, *Google and Yahoo Bulk Email Sender Requirements*, powerdmarc.com, accessed 2026-09-01](https://powerdmarc.com/bulk-email-sender-requirements/); [MxToolbox, *New Gmail & Yahoo Sender Requirements*, mxtoolbox.com, accessed 2026-09-01](https://mxtoolbox.com/c/landing/gmail-and-yahoo-new-dmarc-spam-sender-requirements). At ~100 orders/year plus a small newsletter list, this shop is nowhere near the 5,000/day bulk-sender threshold and never will be at this size — but SPF/DKIM/DMARC and one-click unsubscribe are good practice regardless and matter for *inbox placement*, not just compliance. Kit handles its own sending domain's authentication; if the Worker starts sending its own mail via Resend for post-purchase flows (§8), that domain's SPF/DKIM/DMARC and unsubscribe handling become this shop's responsibility, not Kit's — flag this as real (if small) new deliverability surface area.
- **Branding:** confirmed on Free — "Powered by Kit" appears on forms/emails; removed starting on Creator ($33-39/mo).

**Practical read:** don't pay Kit $33-39/mo (15-20% of a year's gross margin on ~$2,500-4,000/yr revenue) purely to unlock automations you could build once, cheaply, in the Worker you already maintain and that already sends transactional mail via Resend. Keep Kit for what its free tier is actually good at — unlimited broadcast sends to up to 10,000 people, a hosted signup form, a welcome landing page. Build the *triggered, timed* logic (welcome gate, post-purchase sequence, replenishment, abandoned cart) in the Worker + Resend, which this repo already has wired, tested, and paying no monthly fee for. See §8 for exact trigger points.

If Kit's automation gap turns out to matter more than expected once volume grows, the honest alternative isn't "upgrade Kit" — it's comparing against ESPs whose *free* tiers include real automation: Klaviyo free (250 profiles / 500 sends per month, includes the visual flow builder with welcome and abandoned-cart templates) [search summary of Klaviyo pricing pages, accessed 2026-09-01] or MailerLite free (250 subscribers, up to 3 active automations, 2,500 sends/month) [search summary of MailerLite pricing pages, accessed 2026-09-01]. Both cap out fast (250 contacts) and would mean re-pointing every footer form and the privacy policy's named vendor — a real migration cost, not a plug-in. Worth knowing this option exists; not worth doing today.

---

## 3. The welcome discount

**Current state [code]:** `welcome.html` prints `site.welcomeCode` from `content.json`/CMS — one string, same for every visitor, no expiry, no usage cap, shown indefinitely on a page anyone can bookmark or screenshot. It is not gated to first-time buyers in any way; nothing in `workers/checkout.js` treats it specially. It's a reusable public 10%-off code that happens to live behind a signup wall that doesn't actually check anything.

**Should it be a discount at all?** For margin-thin handmade goods, an unconditional percentage-off is the worst-performing lever of the standard set (free shipping, small free gift, no discount but a value-add). The category evidence: shipping-cost surprise, not price, is the #1 named cause of cart abandonment (Baymard's meta-analysis attributes it as the leading reason across the 50 studies it aggregates) [Baymard Institute, *Cart Abandonment Rate Statistics*, baymard.com, updated 2025-09-22](https://baymard.com/lists/cart-abandonment-rate) — which argues for a free-shipping-style offer being at least as persuasive as 10% off, and cheaper on a $15-40 order where 10% is $1.50-$4 but a flat-rate $10 shipping charge is the actual friction point named in the site's own copy (`workers/checkout.js`'s $10 flat rate below the free-shipping threshold). A first-order free-shipping code (or "free pocket salve with first order," reusing the milestone-gift mechanic already built for the $60 cart threshold — `FREE_GIFT_LINE_NAME` in `workers/checkout.js`) costs this business a fixed ~$2-4 marginal-cost item instead of a straight 10% margin hit, and is novel enough to not train subscribers to expect a permanent discount. NN/g's own catalog of email research doesn't have a study isolating "10% popup vs. free shipping vs. no discount" specifically, so this is a reasoned inference from cost structure and Baymard's abandonment-cause data, not a directly-cited A/B result — flag it as such rather than overstating the evidence.

**Fix the mechanism regardless of what the offer is.** Stripe supports exactly the "single code, not shareable" pattern this needs, and it's a Promotion Code feature independent of the underlying Coupon:

- `max_redemptions` exists on the **Promotion Code** object itself (not just the Coupon) — set it to `1` per generated code, so *that specific string* can only be redeemed once, ever, by anyone [Stripe API docs, *The Promotion Code object*, docs.stripe.com, accessed 2026-09-01](https://docs.stripe.com/api/promotion_codes/object).
- `restrictions.first_time_transaction: true` on the Promotion Code makes it fail for any customer/email with a prior payment on file [Stripe API docs, *The Promotion Code object*](https://docs.stripe.com/api/promotion_codes/object).
- Pattern: create **one Coupon** (`percent_off: 10`, or better, a free-shipping equivalent), and generate a fresh **Promotion Code** per subscriber (`max_redemptions: 1`, `first_time_transaction: true`, `expires_at` 30-60 days out) via `POST /v1/promotion_codes`, referencing that shared coupon. This is a code change (§8), not a Kit or CMS setting — the current static-string approach cannot be fixed by editing content.json, only by the Worker minting real Stripe objects.

---

## 4. Birthday club

**Does it work for a tiny list?** Not as built. It's a data-collection field with literally no automation behind it (Kit Free = zero automations, §2), so the "birthday reward" this field exists to power doesn't exist yet on any platform this shop is paying for. Even once fixed, birthday flows are a low-frequency trigger (1/365 chance per subscriber per day) — at a list in the low hundreds, this fires for maybe one person a week. Real, but small, and it's the flow Omnisend's own report flags as unusually high-AOV-but-low-volume (§1).

**Data minimization:** collecting MM/DD only (no year) is the right call already made in the code — `pattern="(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])"` in the form field enforces month/day format only, no year captured [code: `contact.html:371`]. That's good practice: no year means no derivable age, no DOB-as-identity-verification-question overlap, less sensitive data sitting in a third-party vendor (Kit) than a full birthdate would be. Keep that constraint if the field is kept at all.

**COPPA:** COPPA governs operators of services *directed to children under 13* collecting personal information from them. This is a general-audience body-care/apparel shop with no child-directed content, and MM/DD alone isn't independently identifying (no name/email pairing required by COPPA's definition triggers extra obligations here beyond what already applies to any adult-marketed newsletter). Net: COPPA is not a live compliance question for this shop as currently scoped — worth one line in the privacy policy (already present, per `privacy.html`) confirming the site isn't directed at children, not a redesign.

**Better alternative: anniversary of first order.** Strictly better on every axis that matters here:
- Zero additional data collected from the customer (no new form field, no birthday to protect/leak/mismanage).
- Triggers only for people who actually bought something — a birthday-club signup from a newsletter subscriber who never purchased anything currently gets treated identically to a real customer; an anniversary reward by construction only fires for revenue-generating relationships.
- Derivable from data the Stripe webhook already sees at `checkout.session.completed` — needs one small addition (a `first_order_date` keyed by email, following the exact append-only pattern `workers/state/loyalty.js` already uses for points, not a full order copy — `STATE-LAYER.md` explicitly rejected duplicating full orders into D1, but a single date-per-email row is a much smaller, already-justified precedent).

**Recommendation:** stop collecting the birthday field (or make it clearly optional and cosmetic-only, "we might send you something nice" with no promise), and build the anniversary trigger instead once post-purchase automation exists at all (§8).

---

## 5. "Alt-Points" browser-only loyalty

**Why it fails — confirmed in code, not hypothetical:**
- **Device-bound:** the balance lives at `localStorage["yl_loyalty_points"]` [code: `assets/js/cart.js:698`] — clear cookies, switch phones, use incognito, and the "balance" is gone. Nothing server-side ever held it.
- **No proof of purchase:** nothing ever wrote to that key from a real transaction. The `getWalletPoints()`/`setWalletPoints()` pair exists, but grep of the whole checkout path shows no caller sets it after an order — it's either always 0 for a real customer or whatever a curious visitor typed into devtools.
- **No redemption path — and this is worse than "insecure," it's now dead:** `workers/checkout.js`'s `ROUTES` object has no points/redemption endpoint at all. The repo's own audit (`docs/STATE-LAYER.md`, finding C-1) explains why: the old `redeem-points.js` function minted a real, unlimited-use Stripe coupon from any client-submitted `{"points": N}` body — a straightforward exploit — and it was deleted rather than fixed. A proper server-side ledger (`workers/state/loyalty.js`, append-only, D1-backed, idempotent on `order_id`, atomic debit-checks) was **built to replace it** but is explicitly "wired into nothing, deliberately" per that same doc. So today the product-card badges promise "Earn N Alt-Points" on every item, and the cart drawer shows a wallet balance, for a currency that cannot be spent by any real visitor under any circumstances. That's a UX-honesty defect, not just a missed opportunity — every visitor who notices the wallet and expects to redeem it eventually is being quietly lied to by the UI.

**Cheapest honest alternative for a shop this size:** don't rebuild point-based loyalty. A points/tiers program needs sustained repeat-purchase volume to feel rewarding (crossing thresholds, watching a balance grow) — at ~100 orders/year across maybe 60-80 unique buyers, most customers will never accumulate enough points to redeem anything before the incentive stops feeling real. Two options that actually fit the volume:
1. **Referral code via Stripe** — reuse the exact single-use Promotion Code mechanism from §3 (`max_redemptions: 1`, tied to a shared coupon) for a "share this code, you both get $5/10%" mechanic. One mechanism, no ledger, no login, no localStorage — just more Stripe objects, which this Worker already knows how to mint.
2. **Drop it entirely** and put that UI real estate toward the review-request or replenishment flows in §1, which have real revenue evidence behind them.

Given the deletion already happened and the proper ledger (`workers/state/loyalty.js`) was built and shelved rather than wired up, the pragmatic call is: **remove the "Earn N Alt-Points" badges and wallet UI now** (they are actively misleading in production), and revisit a real points program only if repeat-purchase rate justifies it later — that ledger module is sitting there ready if so.

---

## 6. Review requests

**Timing:** converge on roughly 5-14 days after confirmed delivery, adjusted for the product's own "experience window" — a salve or soak needs at least a few uses to have an opinion about, unlike a t-shirt someone can judge on arrival [aggregated from PowerReviews, InboxArmy, and Geysera post-purchase-email guides, accessed 2026-09-01; see e.g. PowerReviews, *When To Ask for Reviews*, powerreviews.com](https://www.powerreviews.com/when-to-ask-for-reviews-best-practice-guide/). For this catalog: apparel and gift cards, ~7 days post-delivery; salves/soaks/body butter, ~10-14 days (long enough for 2-3 uses). This shop ships flat-rate and doesn't currently track delivery confirmation server-side — see §8's code-change flag.

**Linking to the site's review form, product prefilled:** `reviews.html` exists already per the file list; whatever form it posts to needs a query-param or hash-based product identifier so the email can deep-link with the product pre-selected — this is a small, contained change (pass `?product=<id>` in the review-request email's CTA, read it on page load to preselect a dropdown). Flagged as a code change, not a copy change.

**FTC 2024 rule — what it actually restricts.** The FTC's Trade Regulation Rule on the Use of Consumer Reviews and Testimonials, finalized August 22, 2024, effective October 21, 2024, does not ban incentivized reviews outright — it bans **conditioning** the incentive on the review expressing a particular sentiment ("leave a 5-star review for 10% off" is the violation; "leave a review, positive or negative, and get 10% off" is not) [FTC, *Federal Trade Commission Announces Final Rule Banning Fake Reviews and Testimonials*, ftc.gov, 2024-08-22](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials); [Federal Register, *Trade Regulation Rule on the Use of Consumer Reviews and Testimonials*, federalregister.gov, 2024-08-22](https://www.federalregister.gov/documents/2024/08/22/2024-18519/trade-regulation-rule-on-the-use-of-consumer-reviews-and-testimonials). Penalties run to $51,744 per violation. **Practical rule for this shop's copy:** never write "leave a positive review and get X" — write "share your honest take (good, bad, or in-between) and we'll send you a code" or don't incentivize at all. Given the small volume here, a non-incentivized ask ("would you tell us how the [product] worked out?") is simpler to keep compliant and avoids the incentive-review disclosure machinery entirely.

---

## 7. SMS — not worth it at this size

- **Cost structure:** platform fees (Klaviyo SMS, Attentive, Postscript, etc.) typically carry a monthly minimum on top of per-segment costs; at ~100 orders/year this shop would be paying a fixed monthly fee to reach a low double-digit number of texts a month.
- **TCPA risk is real and rising, and disproportionate for a solo owner:** prior express written consent is required before any automated/marketing text, with no small-business carve-out; statutory damages run $500 per message ($1,500 for willful violations), and TCPA class-action filings rose ~95% year-over-year through mid-2025, continuing into 2026 [ActiveProspect, *TCPA text messages: Rules and regulations guide for 2026*, activeprospect.com, accessed 2026-09-01](https://activeprospect.com/blog/tcpa-text-messages/); [MessageIQ, *TCPA and CAN-SPAM for SMS Marketing*, messageiq.io, accessed 2026-09-01](https://messageiq.io/blogs/avoid-costly-fines-a-guide-to-tcpa-and-can-spam-for-sms-marketing/). A one-person shop with no legal/compliance staff taking on per-text litigation exposure for a channel that reaches maybe a few dozen people a month is a bad trade.
- **Verdict:** skip SMS entirely until order volume is at least an order of magnitude higher and there's someone whose job includes consent-record hygiene.

---

## 8. Concrete plan for this site

### Build first (in order)

**1. Fix the welcome discount (small, Worker-only change).**
- Add a `POST /promo-code` route (or fold into the existing Kit-adjacent flow) that calls Stripe's `POST /v1/promotion_codes` with `max_redemptions: 1`, `restrictions[first_time_transaction]: true`, against one shared 10%-off (or free-shipping-equivalent) Coupon, and emails/redirects the code to the subscriber instead of printing a static CMS string.
- Trigger point: today, `welcome.html` reads `site.welcomeCode` client-side — that has to become a real API call, which means the Kit form's redirect (or a Zapier/Make step, or ideally Kit's webhook if available on Free — confirm at implementation time since webhook delivery specifically vs. tagging may differ from the API-access claim above) needs to reach the Worker with the subscriber's email before `welcome.html` can show a real, unique code.
- **Needs code changes:** yes — new Worker route, Stripe Promotion Code creation logic, `welcome.html`/`main.js` changed to fetch instead of read a static field.

**2. Post-purchase sequence (highest ranked, §1) — Worker + Resend, not Kit.**
- Trigger point: `workers/routes/stripe-webhook.js`'s existing `checkout.session.completed` handler is already the one authoritative signal for a real paid order (per the file-header comments in `checkout.js` — never trust the client redirect). Add: on that event, write one lightweight row (email, product category/ids, order date) — following the `workers/state/loyalty.js` append-only/idempotent-on-`order_id` pattern already in the codebase, not a full order copy (STATE-LAYER.md's stated reason for keeping orders in Stripe still holds — this is metadata *about* an order, not the order).
- Schedule the delayed sends (day-2 "how to use," day-10/14 review request for consumables, day-N replenishment) with **Durable Object alarms**, one per order, following the exact reserve/commit pattern the `GiftCardLedger` DO already uses for money — this repo already trusts DO alarms/serialization for the money path, so reusing it for scheduled mail is a smaller leap than it looks. Cloudflare's free tier includes DO alarms; no new vendor.
- Send via **Resend**, which is already wired and already has a verified sending domain from the gift-card flow (`RESEND_API_KEY`, `GIFT_CARD_FROM_EMAIL` in `checkout.js`'s documented secrets) — reuse it rather than adding an ESP.
- **Deliverability note:** these are the shop's own outbound emails now, not Kit-hosted ones — add a `List-Unsubscribe` header and an actual unsubscribe/suppression mechanism (a D1 table of opted-out emails, checked before every send) even though this shop is nowhere near Google/Yahoo's 5,000/day bulk-sender threshold — it's good practice and it's cheap to build once, expensive to retrofit.
- **Needs code changes:** yes — new D1 table, new DO (or reuse pattern), Resend send logic, unsubscribe handling. This is the single biggest lift in the plan, but it's the only flow ranked #1 in §1.

**3. Abandoned cart — partial win, cheap.**
- Stripe Checkout Sessions support `after_expiration.recovery.enabled: true`, which generates a recovery URL in the `checkout.session.expired` webhook payload that reopens a copy of the abandoned session — but **Stripe does not send the email itself**; the recovery link and the send have to be built by this Worker [Stripe docs, *Recover abandoned carts*, docs.stripe.com, accessed 2026-09-01](https://docs.stripe.com/payments/checkout/abandoned-carts). Also: Stripe only has the customer's email if they'd already started entering it in Checkout, so this only recovers *late-stage* abandons (people who reached Stripe's payment page and left), not people who filled a cart and never clicked "checkout" — that earlier-stage abandonment has no server-side signal on this static-site architecture at all without adding client-side email capture in the cart drawer first.
- **Needs code changes:** yes — enable the Checkout Session param, add a `checkout.session.expired` handler alongside the existing `checkout.session.completed` one, generate and send the recovery email (same Resend/DO-alarm infra as #2, on a much shorter delay — literature above suggests within 1 hour for the first touch).

**4. Replenishment reminder for 2oz salves — extend #2's infra.**
- Use the same order-metadata row from #2. Start with an **estimated** interval (no real repeat-purchase data exists yet) rather than pretending to have measured one — pick something defensible (e.g., ~45 days for a 2oz product used a few times a week) and say so internally as a placeholder, then replace it with the shop's own average-days-between-orders for that SKU once there's enough repeat-purchase history to compute it (Klaviyo's own guidance: fire a few days *before* the average gap, and note their predictive-analytics feature needs 500+ ordering customers to even activate — this shop won't reach that for a long time, so "measure it yourself from raw order dates" is the only honest path, not "turn on a vendor's predictive feature").
- **Needs code changes:** minor, once #2 exists — mostly a timing/segmentation rule on data already being captured.

**5. Review request — extend #2, add prefill.**
- Same infra as #2, ~10-14 days post-order for consumables, ~7 days for apparel/gift cards. Add a product-id query param to the review-request CTA link so `reviews.html` (already in the repo) can preselect the product.
- **Needs code changes:** small — timing rule (already have the infra from #2) plus a query-param read on `reviews.html`.

### Keep on Kit, unchanged

- Newsletter broadcasts (unlimited on Free, no reason to move).
- The signup form itself and the hosted welcome *landing page* (just not the static code on it, per #1).

### Fix or remove now, not later (no revenue upside, active harm as-is)

- **Alt-Points badges/wallet UI:** remove the "Earn N Alt-Points" copy and the wallet balance display — it's non-functional and misleading in production today (§5). This is a subtraction, not a build.
- **Birthday field:** either drop it or make it explicitly non-binding ("might," not "will") until an anniversary-based reward (§4) replaces it — right now it collects a date-of-birth-adjacent field that powers nothing.

### Cadence calendar (once #2 ships)

| Trigger | Send | Timing |
|---|---|---|
| Kit signup | Welcome + unique single-use code | Immediate |
| `checkout.session.completed` | Order confirmation is Stripe's own — don't duplicate it | — |
| `checkout.session.completed` | "How to use your [product]" | Day 2-3 |
| `checkout.session.expired` (cart had email) | Recovery link | Within 1 hour, one follow-up at 24h |
| `checkout.session.completed`, apparel/gift card | Review request | Day 7 |
| `checkout.session.completed`, salves/soaks/butter | Review request | Day 10-14 |
| `checkout.session.completed`, 2oz salve | Replenishment nudge | ~Day 35-40 (estimate, revisit with real data) |
| No order in [interval based on typical repeat-purchase gap once known] | Win-back | Year 2 priority, not now |
| First-order anniversary (once built, replacing birthday) | Small reward | Once #4's data pattern exists |

### Copy angles (brand voice: warm, funny, Southern, queer)

Keep these light — this section is a starting point, not final copy:
- Welcome: *"Ten percent off, one time, just for you — this code's got your name on it and it'll only work once, so don't go passing it 'round like church gossip."*
- Post-purchase how-to-use: *"Your [product] made it. Here's how to actually use the thing before you just... smell it and put it on a shelf (we see you)."*
- Review ask (non-incentivized, FTC-clean): *"Tell us the truth — good, bad, or 'it's fine I guess.' We can take it."*
- Replenishment: *"Running low? We built you a shortcut before you have to think about it."*
- Recovery: *"Left something in your cart. No judgment — checkout's a whole ordeal sometimes."*

---

## Not worth it at this size (explicit list)

- **SMS marketing** — TCPA litigation exposure and platform minimums outweigh reach at ~100 orders/year (§7).
- **Browse abandonment** — needs product-view tracking this static site doesn't have and no logged-in accounts to key it to; lower priority than cart/post-purchase.
- **Win-back flow** — real eventually, but fires for maybe 1-2 people/month at this customer count; build it after the top-5 flows are stable.
- **Points-based loyalty rebuild** — repeat-purchase volume is too low for a points program to feel rewarding before it feels forgotten; a referral single-use code (reusing §3's Stripe mechanism) gets 80% of the retention value for a fraction of the engineering.
- **Paying for Kit Creator ($33-39/mo) purely to unlock automations** — 15-20% of a year's gross revenue for something this Worker can build once for free using infrastructure already proven in production (§2, §8).
- **A/B testing subject lines, advanced segmentation, predictive analytics** — all require volume (Klaviyo's predictive tier alone needs 500+ ordering customers) this shop doesn't have and won't for a long time; skip until the basic 5 flows are running and stable.
- **Kit's own Stripe integration / Zapier bridge** — tags subscribers but can't drive timed sends on Kit's free automation-less tier; would just be a second thing to maintain for capability the Worker already needs to build itself (§8).
