/**
 * @fileoverview Cloudflare Worker: Stripe Checkout Session creator. Backs
 * the on-site cart in assets/js/cart.js -- this is the checkout backend for
 * the Snipcart -> Stripe migration (see docs/STRIPE-MIGRATION.md).
 *
 * Corrections applied vs. the original SOTA-report draft this started from:
 *   - CORS is locked to the real site origin(s), NOT "*".
 *   - Prices are validated server-side against the canonical products.json,
 *     including per-variant priceDelta, so a tampered client price is ignored.
 *   - Quantities are parsed as integers and clamped to a sane range.
 *   - Both `products` and `bundles` arrays are searched. Bundle line items
 *     arrive as "bundle-<id>" (see main.js's bundlesHTML()) but a bundle's
 *     own `id` in products.json never carries that prefix -- findEntry()
 *     strips it before searching. Bundles also never carry their own
 *     `price` field (it's always computed from their component products,
 *     see resolveBundlePriceDollars()), so they need their own resolution
 *     path through resolveUnitAmountCents() instead of a plain price
 *     lookup -- get either of these wrong and every bundle checkout 404s
 *     or throws "not purchasable" (this was in fact broken until it was
 *     tested end-to-end against the real catalog while writing this file).
 *   - products.json is fetched from the deployed site and cached, so this
 *     Worker never drifts from the single source of truth in assets/data/.
 *
 * Shipping: a flat $10 rate applies below a $40 physical-items subtotal,
 * free above it (see the freeShippingThresholdCents/flatShippingRateCents
 * constants below) -- matches the "Free shipping on orders over $40"
 * promise already shown on every page. Snipcart used to own this via its
 * own dashboard config; there's no equivalent dashboard here, so it's a
 * starting default hardcoded below. Change it there (not in the Stripe
 * Dashboard) if real rates differ. All-gift-card orders skip shipping
 * entirely -- nothing physical to ship.
 *
 * Gift cards are a special case (see resolveGiftCardAmountCents below):
 * products.json's own `variants.options` for the gift card is a short
 * preset list ($10/$25/$50/$100/$200) used for display, but the actual
 * button on shop.html offers a continuous $10-$500 range via a
 * "Preset $NN[+delta]" custom-field string generated at build time
 * (scripts/build-site-data.js). Rather than require those two lists to ever
 * be kept in sync, the Worker parses the dollar amount directly out of the
 * "Preset $NN" label and clamps it to $10-$500 server-side -- the client
 * still never controls the charged amount, it only picks a preset off a
 * list whose bounds are enforced here. The resolved cents amount is also
 * written to session metadata (gift_card_N_amount_cents) so the separate
 * fulfill-gift-card.js webhook (netlify/functions/, listens for
 * checkout.session.completed) knows how much to put on the redeemable
 * code it emails the recipient -- see that file for the rest of the flow.
 *
 * Required Worker secrets / vars (wrangler secret put / [vars]):
 *   - STRIPE_SECRET_KEY   (secret)  Stripe restricted or secret key.
 *   - SITE_ORIGIN         (var)     e.g. "https://yallternativeliving.com"
 */

const ALLOWED_ORIGINS = [
  "https://yallternativeliving.com",
  "https://www.yallternativeliving.com",
];

const GIFT_CARD_ID = "yallternative-gift-card";
const GIFT_CARD_MIN = 10;
const GIFT_CARD_MAX = 500;

const MAX_QTY_PER_ITEM = 99;
const MAX_LINE_ITEMS = 50;
const MAX_GIFT_TEXT_LEN = 500;

function corsHeaders(origin, env) {
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || (env && env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
  const allow = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, env) },
  });
}

// Fetch + cache the canonical catalog from the deployed site so prices here
// always match assets/data/products.json (the single source of truth).
async function loadCatalog(env, ctx) {
  const url = `${env.SITE_ORIGIN}/assets/data/products.json`;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url);
  let res = cache ? await cache.match(cacheKey) : null;
  if (!res) {
    res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res.ok && ctx && cache) {
      const toCache = new Response(res.clone().body, res);
      toCache.headers.set("Cache-Control", "max-age=300");
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
  }
  if (!res.ok) throw new Error("Could not load product catalog");
  return res.json();
}

// Bundle buttons render data-item-id="bundle-<id>" (see main.js's
// bundlesHTML()), but a bundle's own `id` in products.json never carries
// that prefix (e.g. button id "bundle-starter-self-care-set" vs. catalog id
// "starter-self-care-set") -- strip it back off before searching the
// bundles array, or every bundle checkout would 404 against its own catalog.
function findEntry(catalog, id) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const bundles = Array.isArray(catalog.bundles) ? catalog.bundles : [];
  const found = products.find((p) => p.id === id);
  if (found) return found;
  const bundleId = id.startsWith("bundle-") ? id.slice("bundle-".length) : id;
  return bundles.find((b) => b.id === bundleId) || null;
}

// Bundles in products.json never carry their own `price` field -- like
// main.js's bundlesHTML() and scripts/build-site-data.js's bundlePricing(),
// their price is always computed live from their real component products'
// prices, so it can't drift out of sync after a product's price changes.
// (Previously this was baked into a generated snipcart-products.json
// manifest at build time; there's no equivalent static artifact anymore,
// so it's recomputed here, server-side, on every checkout instead.)
function resolveBundlePriceDollars(catalog, bundle) {
  if (!bundle || !Array.isArray(bundle.productIds) || !bundle.productIds.length) return null;
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const productMap = new Map(products.map((prod) => [prod.id, prod]));
  let fullPrice = 0;
  for (const id of bundle.productIds) {
    const p = productMap.get(id);
    if (!p || typeof p.price !== "number") return null; // referential integrity issue -- fail closed
    fullPrice += typeof p.originalPrice === "number" ? p.originalPrice : p.price;
  }
  return Math.round(fullPrice * (1 - (bundle.discountPercent || 0) / 100) * 100) / 100;
}

// Resolve a validated unit price (in cents) for an item, honoring a chosen
// variant's priceDelta when one is supplied and valid. `isBundle` picks the
// bundle-pricing path above instead of a plain product's own `price` field.
function resolveUnitAmountCents(catalog, entry, variantLabel, isBundle) {
  let price;
  if (isBundle) {
    price = resolveBundlePriceDollars(catalog, entry);
  } else {
    price = typeof entry.price === "number" ? entry.price : null;
  }
  if (price === null || price === undefined) return null;
  if (!isBundle && variantLabel && entry.variants && Array.isArray(entry.variants.options)) {
    const opt = entry.variants.options.find((o) => o.label === variantLabel);
    if (opt && typeof opt.priceDelta === "number") price += opt.priceDelta;
  }
  return Math.round(price * 100);
}

// Gift card: parse "Preset $NN" and clamp to the allowed range -- see the
// file-level comment above for why this doesn't go through the normal
// variants.options lookup.
function resolveGiftCardAmountCents(variantLabel) {
  const m = /^Preset \$(\d+(?:\.\d{1,2})?)$/.exec(String(variantLabel || "").trim());
  const raw = m ? parseFloat(m[1]) : NaN;
  const dollars = Number.isFinite(raw)
    ? Math.min(GIFT_CARD_MAX, Math.max(GIFT_CARD_MIN, raw))
    : GIFT_CARD_MIN;
  return Math.round(dollars * 100);
}

function truncate(s, max) {
  return String(s || "").slice(0, max);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405, origin, env);
    }
    // Reject cross-site callers outright.
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin) || (env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
    if (origin && !isAllowedOrigin) {
      return json({ error: "Forbidden origin" }, 403, origin, env);
    }

    try {
      const body = await request.json();
      const items = body && body.items;
      if (!Array.isArray(items) || items.length === 0) {
        return json({ error: "Cart is empty or invalid." }, 400, origin);
      }
      if (items.length > MAX_LINE_ITEMS) {
        return json({ error: "Too many line items." }, 400, origin);
      }

      const catalog = await loadCatalog(env, ctx);

      const metadata = {}; // Stripe session-level metadata (gift recipient/sender/message)
      if (body && body.pickupMarket) {
        metadata.pickup_market = truncate(body.pickupMarket, 250);
      }
      let giftLineIndex = 0;

      const lineItems = items.map((item) => {
        const entry = findEntry(catalog, String(item.id));
        if (!entry) throw new Error(`Product not found: ${item.id}`);

        const isGiftCard = item.id === GIFT_CARD_ID;
        const isBundle =
          !isGiftCard && Array.isArray(catalog.bundles) && catalog.bundles.some((b) => b.id === entry.id);
        const unitAmount = isGiftCard
          ? resolveGiftCardAmountCents(item.variant)
          : resolveUnitAmountCents(catalog, entry, item.variant, isBundle);
        if (unitAmount === null || unitAmount < 0) {
          throw new Error(`Product not purchasable: ${item.id}`);
        }

        const parsedQty = parseInt(item.qty, 10);
        const qty =
          Number.isNaN(parsedQty) || parsedQty < 1
            ? 1
            : Math.min(parsedQty, MAX_QTY_PER_ITEM);

        const name =
          entry.name + (isGiftCard ? ` ($${(unitAmount / 100).toFixed(2)})` : item.variant ? ` (${item.variant})` : "");
        const image =
          entry.image && env.SITE_ORIGIN
            ? `${env.SITE_ORIGIN}/${String(entry.image).replace(/^\/+/, "")}`
            : null;

        // Gift-card recipient/sender/message never affect price -- they're
        // pure metadata, attached at the session level (indexed so multiple
        // gift cards in one order don't collide).
        if (isGiftCard) {
          giftLineIndex += 1;
          const prefix = `gift_card_${giftLineIndex}`;
          // amount_cents is what fulfill-gift-card.js (the Netlify function
          // listening for checkout.session.completed) reads to know how
          // much to put on the code it emails -- it's set here, server-
          // side, from the same clamped unitAmount already computed above,
          // never from anything the client sent directly.
          metadata[`${prefix}_amount_cents`] = String(unitAmount);
          if (item.giftRecipientEmail) {
            metadata[`${prefix}_recipient`] = truncate(item.giftRecipientEmail, MAX_GIFT_TEXT_LEN);
          }
          if (item.giftSenderName) {
            metadata[`${prefix}_sender`] = truncate(item.giftSenderName, MAX_GIFT_TEXT_LEN);
          }
          if (item.giftMessage) {
            metadata[`${prefix}_message`] = truncate(item.giftMessage, MAX_GIFT_TEXT_LEN);
          }
        }

        return { name, image, unitAmount, qty, isGiftCard };
      });

      const totalCents = lineItems.reduce((sum, li) => sum + li.unitAmount * li.qty, 0);

      // Flat-rate shipping, matching the site's existing "Free shipping on
      // orders over $40" promise (see the announcement bar in main.js and
      // cart.js's free-shipping progress meter, both driven by
      // products.json's shop.freeShippingThreshold). $10 is a starting
      // default carried over from what the Etsy listings charge for
      // apparel shipped from Landrum, SC -- adjust both constants below to
      // match real rates; this is a business decision, not a technical one.
      // Gift cards are emailed, not shipped, so an order that's ALL gift
      // cards gets no shipping line at all.
      const physicalSubtotalCents = lineItems
        .filter((li) => !li.isGiftCard)
        .reduce((sum, li) => sum + li.unitAmount * li.qty, 0);
      const hasPhysicalItems = physicalSubtotalCents > 0;
      const freeShippingThresholdCents = 4000; // $40.00
      const flatShippingRateCents = 1000; // $10.00
      const isPickup = body && Boolean(body.pickupMarket);
      const shippingCents =
        hasPhysicalItems && physicalSubtotalCents < freeShippingThresholdCents && !isPickup
          ? flatShippingRateCents
          : 0;

      const params = new URLSearchParams();
      params.append("mode", "payment");
      // amount/currency on the success URL are ONLY for a best-effort
      // client-side analytics ping on thank-you.html -- never treat this
      // redirect as proof of payment. Real fulfillment must come from a
      // Stripe webhook (checkout.session.completed), which is the only
      // reliable signal a browser redirect can't fake or lose on a dropped
      // connection. See docs/STRIPE-MIGRATION.md step 6.
      params.append(
        "success_url",
        `${env.SITE_ORIGIN}/thank-you.html?session_id={CHECKOUT_SESSION_ID}&amount=${((totalCents + shippingCents) / 100).toFixed(2)}&currency=usd`
      );
      params.append("cancel_url", `${env.SITE_ORIGIN}/shop.html`);
      params.append("billing_address_collection", "auto");
      // Only ask for a shipping address (and charge shipping) when there's
      // actually something physical in the order -- an all-gift-card order
      // has nothing to ship.
      if (hasPhysicalItems) {
        params.append("shipping_address_collection[allowed_countries][0]", "US");
        params.append(
          "shipping_options[0][shipping_rate_data][type]",
          "fixed_amount"
        );
        params.append(
          "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
          String(shippingCents)
        );
        params.append(
          "shipping_options[0][shipping_rate_data][fixed_amount][currency]",
          "usd"
        );
        params.append(
          "shipping_options[0][shipping_rate_data][display_name]",
          shippingCents === 0 ? "Free shipping" : "Standard shipping"
        );
      }
      // Lets a gift-card recipient enter the code fulfill-gift-card.js
      // emailed them (a Stripe restricted Promotion Code, single-use,
      // amount_off) right on Stripe's own hosted Checkout page.
      params.append("allow_promotion_codes", "true");
      Object.keys(metadata).forEach((key) => {
        params.append(`metadata[${key}]`, metadata[key]);
      });
      lineItems.forEach((li, i) => {
        params.append(`line_items[${i}][price_data][currency]`, "usd");
        params.append(`line_items[${i}][price_data][product_data][name]`, li.name);
        if (li.image) {
          params.append(`line_items[${i}][price_data][product_data][images][0]`, li.image);
        }
        params.append(`line_items[${i}][price_data][unit_amount]`, String(li.unitAmount));
        params.append(`line_items[${i}][quantity]`, String(li.qty));
      });

      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": "2023-10-16",
        },
        body: params,
      });
      const session = await stripeRes.json();
      if (session.error) throw new Error(session.error.message);

      return json({ url: session.url }, 200, origin, env);
    } catch (err) {
      return json({ error: err.message || "Checkout failed" }, 400, origin, env);
    }
  },
};

export {
  loadCatalog,
  findEntry,
  resolveBundlePriceDollars,
  resolveUnitAmountCents,
  resolveGiftCardAmountCents,
};

