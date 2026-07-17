# Y'allternative Living — website gap analysis (2026-07-17)

A study of the current site against 2026 small-business e-commerce
practice, to figure out what's actually missing versus what's already
solid. Sources for the research claims are linked at the bottom.

## What's already strong (don't touch)

Real per-product photo galleries (avg. 3-4 photos/product, AVIF+WebP
responsive), real Etsy-sourced ratings with correct schema.org markup,
a working direct checkout (Snipcart) that doesn't depend on Etsy, a
privacy-friendly analytics setup, WCAG 2.2 AA-checked accessibility, a
real automated test suite, and — as of today — a site-native review
submission channel. Most sites this size don't have any of that. The
gaps below are genuinely additive, not "fix what's broken."

## High priority, low effort (mostly account setup, not new code)

**Discount codes.** Snipcart (already the cart engine here) has
built-in discount/coupon code support — nothing to build, just create
codes in the Snipcart dashboard once Steven has a real account. A
"10% off your first order" code tied to the newsletter signup is the
single highest-leverage thing missing: it gives visitors a reason to
hand over an email *right now* instead of "maybe later," and first-time-buyer
discounts are one of the best-documented conversion levers for small
DTC shops.

**Abandoned cart recovery.** Also native to Snipcart — multi-step
recovery emails (e.g. at 1 hour / 24 hours / 3 days) with an optional
discount at the final step, shown to lift recovered-cart conversion
meaningfully. Zero new code; a dashboard configuration once the real
Snipcart account exists.

**Post-purchase review prompt.** The site can now collect reviews (built
today), but nothing currently asks a buyer to leave one after their
order arrives. Even a simple manual step — Savanna emailing "how'd it
go?" a week after shipping, with a link to the review form — would
meaningfully grow the site's own review pool, and reviews are one of
the highest-converting trust signals there is (real reviews are shown
to lift conversion dramatically — see sources).

## Medium priority (real but scoped dev work)

**Ingredient/allergen transparency — done 2026-07-17.** Added a
collapsed "Ingredients" disclosure to every body-care/potion product
card, sourced by fetching each product's own real Etsy listing
description (never the generic "Materials" tag, which turned out to be
copy-pasted boilerplate across a couple of unrelated listings — the
per-product free-text description was the trustworthy source each
time). Includes a short allergy/sensitivity note. `npm test` validates
the shape of every entry.

**Size chart for apparel — attempted, not added.** Checked both the
tank top and tee's real Etsy listings for actual garment measurements
(chest/length chart, "runs true to size" note, or a named blank
brand/style that would let me pull a manufacturer's published chart).
Neither listing has any of that — just "Materials: triblend" and a
plain size dropdown. Rather than invent plausible-sounding numbers,
I've left this alone. If Savanna has real measurements (or knows the
blank garment brand/style used), that'd make this addable.

**Visual social proof / UGC.** No customer photos or Instagram content
appear anywhere on the site, even though the business has a real,
active Instagram. Visual UGC is processed far faster than text and is
called out repeatedly in 2026 CRO research as a top-tier trust signal —
even a simple "as worn/used by real customers" strip using a handful of
real Instagram photos (with permission) would help.

**On-site search / FAQ on the shop page itself.** The FAQ currently
lives only on contact.html. Shipping/returns questions are exactly what
stalls a cart at the last step — a compact FAQ or accordion near
checkout on shop.html (using the same real Q&A content, not
duplicated-and-drifting copy) would keep more people from bouncing to
go "just double check the return policy."

**Low-stock / "back in stock" signals.** Nothing on the site currently
shows availability urgency (e.g. "only 3 left") or offers a "notify me"
option for anything sold out. This depends on Savanna actually tracking
inventory somewhere, which isn't set up yet — worth a conversation
before building it, since faking urgency would cross into dishonest UX.

**Bundles / gift sets.** Thirteen products, no "starter kit" or
"gift bundle" option bundling 2-3 items at a small discount — a common,
low-effort average-order-value lift for a small handmade catalog like
this one.

## Lower priority / worth flagging, not building yet

- **Local SEO / Google Business Profile.** The site's `LocalBusiness`
  structured data is solid, but that's different from an actual claimed,
  verified Google Business Profile listing (reviews, map pin, hours) —
  this is a Savanna action outside the codebase, not something I can do
  for her, but it's one of the highest-ROI things a Landrum-based,
  market-and-Pride-circuit business can do and isn't done yet.
- **Blog / ongoing content.** No blog or content-marketing pages exist.
  Reasonable to skip for now given the team size, but it's the main lever
  left untouched for organic search growth beyond the static pages.
- **Subscriptions / repeat delivery.** Snipcart supports recurring
  billing; could suit something like a recurring salve/soak
  "restock club" down the line, but not worth building speculatively.
- **Gift cards, live chat, multi-currency/international shipping,
  referral program, PWA install.** All real, all reasonable, all lower
  priority than the items above for a shop this size right now.

## Already-known blockers (not new, just still outstanding)

The real Snipcart API key, a real Kit account/form URL, a real
Formspree form URL, and a real production domain are still placeholders
— every item above assumes those get filled in first, since discount
codes/recovery emails/etc. all live inside the Snipcart dashboard tied
to a real account.

## Sources

- [Ecommerce Conversion Rate Optimization: The Complete Guide 2026](https://www.genaiembed.ai/blog/ecommerce-conversion-rate-optimization)
- [Top Strategies For Ecommerce Conversion Optimization In 2026 — Yotpo](https://www.yotpo.com/blog/ecommerce-conversion-optimization/)
- [Cart Abandonment Software to Increase Revenue - Snipcart](https://snipcart.com/cart-abandonment-software)
- [Discounts – Snipcart Documentation](https://docs.snipcart.com/v2/setup/discounts)
- [Trust Signals & User Reviews: Why Peer Opinions Drive Conversions - GoodFellas Tech](https://www.goodfellastech.com/blog/trust-signals-user-reviews-why-peer-opinions-drive-conversions-and-5-steps-to-maximize-ugc-in-2026)
- [Building Trust Signals: The New Currency of Small Business Websites in 2026](https://www.connectmediaagency.com/website-trust-signals/)
- [What Small Business Websites Need in 2026 — Triad Web Design Service](https://triadwebservice.com/web-design-blog/what-small-business-websites-need-in-2026-trust-builders-lead-engines-and-local-seo-wins/)
- [Ecommerce Trust Signals: What to Add to Product Pages - Foursixty](https://foursixty.com/blog/ecommerce-trust-signals/)
