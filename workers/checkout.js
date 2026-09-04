/**
 * @fileoverview Cloudflare Worker: the entire money path for this shop.
 *
 * This file is the Worker's entrypoint. It creates Stripe Checkout Sessions
 * (its original job, backing the on-site cart in assets/js/cart.js -- see
 * docs/STRIPE-MIGRATION.md) and it now ROUTES the four endpoints that used to
 * be Netlify Functions:
 *
 *   POST /api/checkout           create a Checkout Session   (this file)
 *   POST /api/gift-card-balance  what is left on a card      (routes/gift-card-balance.js)
 *   POST /api/stripe-webhook     Stripe events               (routes/stripe-webhook.js)
 *   POST /api/order-status       look up a real order        (routes/order-status.js)
 *   POST /api/restock            "tell me when it's back"    (routes/restock.js)
 *   POST /api/safety-report      report a reaction (MoCRA)     (routes/safety-report.js)
 *   GET  /api/gift-note          printable gift note (owner, signed link) (routes/gift-note.js)
 *   POST /api/market-alerts      "email me the next market date" (routes/market-alerts.js)
 *   POST /api/unsubscribe        opt out of marketing email  (routes/retention.js)
 *   POST /api/welcome-code       mint a single-use welcome code
 *   POST /api/birthday-club      store an MM/DD birthday
 *   POST /api/loyalty-balance    read a points balance (token required)
 *
 * WHY ONE WORKER. The state those endpoints need -- the gift-card ledger, the
 * exactly-once webhook claim, the rate-limit counters -- lives in Cloudflare
 * Durable Objects and D1, which a Netlify Function cannot reach. Splitting the
 * money path across two providers also meant splitting it across two failure
 * modes: audit H-23 notes the Netlify free plan pauses EVERY project at its
 * 300-credit cap, which would have taken the Stripe webhook down with it.
 * Netlify keeps serving the static site and proxies `/api/*` here.
 *
 * PATH NORMALISATION. That proxy rule forwards `/api/<rest>` as `/<rest>`
 * (netlify.toml's `:splat`), while a Cloudflare route on the apex domain would
 * deliver the full `/api/<rest>`. The router accepts both -- see routeOf --
 * so the same build works whichever way traffic arrives.
 *
 * The Durable Object classes are re-exported at the foot of this file. A
 * `[[durable_objects.bindings]]` entry is only valid if the Worker's `main`
 * module exports its `class_name`, so those two lines are what make the
 * bindings in wrangler.toml legal.
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
 * Shipping: a flat $10 rate applies below the free-shipping threshold on the
 * physical-items subtotal, free at or above it -- matching the "Free shipping
 * on orders over $X" promise already shown on every page. The threshold is
 * NOT hardcoded here: it comes from the same catalog these prices do
 * (products.json shop.freeShippingThreshold, editable in the CMS), so
 * changing it in /admin moves the site copy and what Stripe charges together
 * -- see resolveFreeShippingThresholdCents. The $10 flat rate itself is a
 * business constant with no CMS field, hardcoded below; change it there (not
 * in the Stripe Dashboard) if real rates differ. All-gift-card orders skip
 * shipping entirely -- nothing physical to ship.
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
 * written to session metadata (gift_card_N_amount_cents) so the webhook route
 * (routes/stripe-webhook.js, listening for checkout.session.completed) knows
 * how much to put on the card it issues on the ledger and emails to the
 * recipient -- see that file for the rest of the flow.
 *
 * Sales tax: self-enabling. The Worker asks Stripe once an hour whether Tax
 * is ready on the account (GET /v1/tax/settings, status "active") and turns
 * automatic_tax on as soon as it is -- so finishing the registration in the
 * Stripe Dashboard is the entire switch, with no code change or redeploy.
 * See isTaxEnabled below, including the STRIPE_TAX_ENABLED override for
 * forcing it on/off. It can't simply be sent unconditionally: calling
 * automatic_tax[enabled]=true while Tax is still `pending` makes Stripe
 * reject the whole Checkout Session, so an always-on version would break
 * every purchase until that paperwork is done. When on, this Worker:
 *   - sends automatic_tax[enabled]=true and customer_creation=always (Stripe
 *     needs a Customer to hang the collected address off of for new buyers),
 *   - marks every price tax_behavior=exclusive, since displayed prices on
 *     the site are pre-tax,
 *   - tags each line with a real product tax code rather than leaning on the
 *     account default: gift cards txcd_10502000 (multi-purpose gift card --
 *     not taxed at purchase in most US states, taxed at redemption instead,
 *     so getting this wrong double-taxes a gift), apparel txcd_30011000,
 *     everything else txcd_99999999 (general tangible goods),
 *   - tags shipping txcd_92010001, since some states tax delivery charges
 *     on taxable orders and some don't -- let Stripe decide per-address.
 *
 * Which address gets rated: SC is destination-based, so the rate follows
 * the delivery address (including its county add-on), not this business's
 * own location. Collecting a shipping address for physical orders is what
 * makes that work -- Stripe prefers the shipping address over billing.
 * Market pickups are rated at the market instead, since that's where the
 * buyer actually takes possession -- handled by pinning a Customer that
 * carries the market address and skipping shipping-address collection (see
 * resolvePickupAddress/createPickupCustomer). Needs a ZIP on the market in
 * events.json; without one it falls back to the buyer's address.
 *
 * Tax vs. discounts: Stripe Tax rates the subtotal AFTER discounts are
 * applied (https://docs.stripe.com/tax/calculating), which is the correct
 * treatment for this site's built-in markdowns -- bundle discountPercent and
 * the custom box's 10% are baked into unit_amount before Stripe ever sees
 * the line, and a sale price is genuinely a lower price, so tax should
 * follow it down. One caveat worth knowing: a gift-card redemption reaches
 * Stripe as a single-use `amount_off` coupon, so Stripe treats it as a
 * discount and rates the reduced amount. Tax law generally treats a gift card
 * as a payment method instead -- tax the full price, then let the card pay part
 * of the total. Since these cards are also untaxed at purchase (see the
 * gift-card tax code above), an order fully covered by one still collects no
 * tax at either end. The BALANCE is now real (it lives in the GiftCardLedger
 * Durable Object rather than in a coupon), but the tax treatment is unchanged:
 * fixing it needs Stripe to accept stored value as a payment method, which it
 * does not. See docs/DEVELOPMENT.md section 18, and section 8 for the
 * non-technical version.
 *
 * Required Worker secrets / vars (wrangler secret put / [vars]):
 *   - STRIPE_SECRET_KEY      (secret) Stripe restricted or secret key. Needs
 *                                     Tax Settings *read* if you want tax to
 *                                     switch itself on; without that scope the
 *                                     probe just fails closed (tax stays off).
 *   - STRIPE_WEBHOOK_SECRET  (secret) signing secret for /api/stripe-webhook.
 *                                     Also keys the gift-card code derivation.
 *   - RESEND_API_KEY         (secret) gift-card, restock and reaction-report
 *                                     email.
 *   - SITE_ORIGIN            (var)    e.g. "https://yallternativeliving.com"
 *   - STRIPE_TAX_ENABLED     (var)    optional override: "true" forces tax on,
 *                                     "false" forces it off. Omit for auto.
 *   - RESTOCK_NOTIFY_EMAIL   (var)    optional; where restock alerts go.
 *   - ORDER_NOTIFY_EMAIL     (var)    optional; where the "gift note to print"
 *                                     email for a gift order goes. Falls back
 *                                     to RESTOCK_NOTIFY_EMAIL, then the shop
 *                                     contact address.
 *   - GIFT_CARD_FROM_EMAIL   (var)    optional; verified Resend sender.
 *   - SAFETY_REPORT_EMAIL    (var)    optional; where MoCRA reaction reports
 *                                     go. Falls back to RESTOCK_NOTIFY_EMAIL,
 *                                     then contact@yallternativeliving.com.
 *
 * Retention layer (workers/routes/retention*.js) -- see workers/README.md:
 *   - MAGIC_LINK_SECRET          (secret) signs unsubscribe and points links.
 *                                         Without it NO marketing email sends,
 *                                         on purpose: an email with no working
 *                                         opt-out is not one we will send.
 *   - STRIPE_WELCOME_COUPON_ID   (var)    the shared 10%-off Coupon the welcome
 *                                         Promotion Codes are minted against.
 *                                         Unset = /api/welcome-code answers
 *                                         `configured: false` and welcome.html
 *                                         falls back to the CMS welcomeCode.
 *   - STRIPE_BIRTHDAY_COUPON_ID  (var)    shared $5-off Coupon, birthday club.
 *   - STRIPE_LOYALTY_COUPON_ID   (var)    shared $5-off Coupon for points
 *                                         payouts; falls back to the birthday
 *                                         coupon when unset.
 *   - LOYALTY_REDEEM_THRESHOLD   (var)    points that trigger a payout (100).
 *   - LOYALTY_REWARD_CENTS       (var)    what a payout is worth (500 = $5).
 *   - RETENTION_FROM_EMAIL       (var)    optional; verified Resend sender for
 *                                         the retention sends specifically.
 *
 * Bindings (workers/wrangler.toml): GIFT_CARD_LEDGER and RATE_LIMIT_COUNTER
 * (Durable Objects) and STATE_DB (D1). Checkout itself runs without them; the
 * routes that cannot are guarded and return 503 rather than pretending.
 */

import { ClientError, isAllowedOrigin, json, preflight, stripControlChars } from "./routes/http.js";
// The Stripe API version used to be "ONE VALUE, FOUR FILES" -- this file plus
// three Netlify functions, all reading and writing the same Stripe objects,
// each with its own copy of the string. The functions are retired and the
// version is pinned once, in routes/stripe.js.
import { STRIPE_API_VERSION, deleteCoupon, expireSession, stripePost } from "./routes/stripe.js";
import { isGiftCardCode } from "./routes/gift-cards.js";
import { handleGiftCardBalance } from "./routes/gift-card-balance.js";
import { handleStripeWebhook } from "./routes/stripe-webhook.js";
import { handleOrderStatus } from "./routes/order-status.js";
import { handleOrderSummary } from "./routes/order-summary.js";
import { handleRestock } from "./routes/restock.js";
import { handleSafetyReport } from "./routes/safety-report.js";
import { handleGiftNote } from "./routes/gift-note.js";
import { handleMarketAlerts } from "./routes/market-alerts.js";
import {
  handleBirthdayClub,
  handleLoyaltyBalance,
  handleUnsubscribe,
  handleWelcomeCode
} from "./routes/retention.js";
import { giftCardLedger, LedgerError } from "./state/gift-card-ledger.js";

const GIFT_CARD_ID = "yallternative-gift-card";
const GIFT_CARD_MIN = 10;
const GIFT_CARD_MAX = 500;

// Stripe product tax codes (https://docs.stripe.com/tax/tax-codes).
// Only consulted when STRIPE_TAX_ENABLED is on -- see the file header.
const TAX_CODE_GIFT_CARD = "txcd_10502000"; // Gift Card (multi-purpose)
const TAX_CODE_APPAREL = "txcd_30011000"; // Clothing & Footwear
const TAX_CODE_GOODS = "txcd_99999999"; // General - Tangible Goods
const TAX_CODE_SHIPPING = "txcd_92010001"; // Shipping

const MAX_QTY_PER_ITEM = 99;
const MAX_LINE_ITEMS = 50;
// The six languages assets/js/translator.js offers, every one of which is also
// a value Stripe Checkout accepts for `locale`. This Worker's own JSON error
// strings stay English on purpose -- cart.js renders them, and translating
// them here would put shop copy in two places at once.
const CHECKOUT_LOCALES = new Set(["en", "es", "de", "fr", "ja", "zh"]);
const MAX_GIFT_TEXT_LEN = 500;
// Stripe's own limit is 50 metadata keys per object; stop short of it so the
// session-level keys (pickup, discount, gift flags, gift-card redemption)
// always fit alongside the per-gift-card groups. See the guard in fetch().
const MAX_METADATA_KEYS = 45;

// ClientError, corsHeaders and json now live in routes/http.js, shared with
// every other route this Worker answers -- three copies of an origin allowlist
// is three chances for one of them to drift open.

// Bake active sales into a freshly loaded catalog, mirroring
// scripts/build-site-data.js's "Process Products" step (and qa-check.js's
// copy of it -- change one, change all three). The shop pages render prices
// from the generated, sale-adjusted catalog, so the raw products.json this
// Worker fetches must get the same transform before any price is validated
// against it: without this, a live category sale displays one price on the
// site and charges another at checkout. Bundle math is unaffected on
// purpose -- resolveBundlePriceDollars() prefers originalPrice (the
// pre-sale price), exactly like main.js's bundlesHTML(), so bundle
// discounts don't stack with a sale on either side.
function applySales(catalog) {
  const salesByCategory = {};
  for (const s of Array.isArray(catalog.sales) ? catalog.sales : []) {
    if (s && s.category) salesByCategory[s.category] = s;
  }
  for (const p of Array.isArray(catalog.products) ? catalog.products : []) {
    if (p.sale && p.sale.price) {
      p.originalPrice = p.price;
      p.price = p.sale.price;
    } else if (salesByCategory[p.category] && typeof p.price === "number") {
      const catSale = salesByCategory[p.category];
      p.originalPrice = p.price;
      p.price = Math.round(p.price * (1 - catSale.percentOff / 100) * 100) / 100;
      p.sale = { label: catSale.label };
    }
  }
  return catalog;
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
  return applySales(await res.json());
}

// Same fetch+cache treatment for the market calendar. Only needed when a
// pickup order has to be taxed at the market rather than the buyer's home
// address, so failures here are non-fatal -- see resolvePickupAddress.
async function loadEvents(env, ctx) {
  const url = `${env.SITE_ORIGIN}/assets/data/events.json`;
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
  if (!res.ok) throw new Error("Could not load events");
  return res.json();
}

/**
 * Decide whether to send automatic_tax on this Checkout Session.
 *
 * Default is "auto": ask Stripe whether Tax is actually ready
 * (GET /v1/tax/settings -> status "active" means the account has the
 * required info to calculate), and turn tax on the moment it is. That means
 * Savanna finishing her registration in the Stripe Dashboard is the whole
 * switch -- no code change, no redeploy, nobody to notify. It also handles
 * test vs. live correctly for free, since Tax settings are per-mode and the
 * answer follows whichever key this Worker is using.
 *
 * Why not simply always send automatic_tax and let Stripe sort it out:
 * calling it while Tax is still `pending` makes Stripe reject the entire
 * Checkout Session, so an unconditional version breaks every purchase until
 * the paperwork is done. Hence the probe.
 *
 * Env override (`STRIPE_TAX_ENABLED`):
 *   unset / "auto"  -> probe Stripe (default)
 *   "true"          -> force on, skip the probe
 *   "false" / "off" -> force off; kill switch if tax ever needs stopping
 *                      faster than a Dashboard change can be made
 *
 * Anything unrecognised falls back to "auto" rather than guessing.
 *
 * The probe is cached for an hour and keyed per site+mode, so this is not a
 * per-checkout API call. Any failure -- network, bad key, unexpected shape
 * -- resolves to false, which is the safe direction: an order that should
 * have charged tax is a bookkeeping problem, an order Stripe refuses to
 * create is a lost sale.
 */
async function isTaxEnabled(env, ctx) {
  const override = String(env.STRIPE_TAX_ENABLED || "auto").toLowerCase();
  if (override === "true") return true;
  if (override === "false" || override === "off") return false;

  const mode = String(env.STRIPE_SECRET_KEY || "").includes("_live_") ? "live" : "test";
  const cache = typeof caches !== "undefined" ? caches.default : null;
  // Synthetic key: never contains the API key, only site + mode.
  const cacheKey = new Request(`${env.SITE_ORIGIN}/__internal/tax-status?mode=${mode}`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      try {
        const cached = await hit.json();
        return Boolean(cached.active);
      } catch (e) {
        // Fall through and re-probe on an unreadable cache entry.
      }
    }
  }

  let active = false;
  // Did we actually get a definitive answer from Stripe? A probe that never
  // reached a good response (network error, non-2xx, unparseable body) leaves
  // this false. We still fail open -- active stays false, so the order is
  // created without tax -- but a *failed* probe must not be cached like a
  // genuine "tax is off" result. Otherwise one transient Stripe blip would
  // pin every SC order to untaxed for the full hour-long cache window.
  let probeSucceeded = false;
  try {
    const res = await fetch("https://api.stripe.com/v1/tax/settings", {
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Stripe-Version": STRIPE_API_VERSION
      }
    });
    if (res.ok) {
      const settings = await res.json();
      active = settings && settings.status === "active";
      probeSucceeded = true;
    }
  } catch (e) {
    active = false;
  }

  if (cache && ctx) {
    // Cache a real result for the full hour; cache a failed probe for only
    // 60s so we re-probe soon instead of serving stale "no tax" for an hour.
    const maxAge = probeSucceeded ? 3600 : 60;
    const toCache = new Response(JSON.stringify({ active }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${maxAge}`
      }
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return active;
}

// Rebuild the exact <option> label cart.js renders for a market, so a
// client-sent pickupMarket string can be matched against the real calendar
// instead of being trusted. Must stay byte-identical to the label built in
// cart.js's pickup <select> -- if that format changes, change it here too
// (the backend test suite pins both).
function pickupLabelFor(evt) {
  return (
    (evt.name || "Pop-up Market") +
    " — " +
    (evt.dateLabel || "") +
    " (" +
    (evt.location || "Landrum, SC") +
    ")"
  );
}

/**
 * Work out where a pickup order is actually delivered, for tax purposes.
 *
 * South Carolina (like most states) sources sales tax to the point of
 * delivery, and for a market pickup that's the market -- not wherever the
 * buyer happens to live. Counties add 1-3% on top of the 6% state rate, so
 * rating a Landrum pickup at a Charleston home address is simply the wrong
 * number.
 *
 * The market label arrives from the client, so it's re-derived from
 * events.json here rather than trusted -- same rule as prices. A caller who
 * invents a label, or picks a market with no ZIP recorded, gets null back
 * and the checkout quietly falls back to collecting a shipping address,
 * which is the pre-existing behaviour. Returning null is always safe.
 *
 * Stripe needs country + state + 5-digit ZIP to resolve a US jurisdiction;
 * the state is read off the tail of the "City, ST" location string, since
 * markets aren't always in SC (past events include Flat Rock, NC).
 */
// Is this label a market that's actually on the calendar? This is the single
// gate on whether an order is treated as a pickup at all -- it runs on every
// checkout, tax on or off (an unvalidated label used to waive shipping on any
// order that merely sent the field). Returns the calendar event, or null.
function findPickupEvent(events, pickupMarket) {
  if (!events || !pickupMarket || typeof pickupMarket !== "string") return null;
  const upcoming = Array.isArray(events.upcoming) ? events.upcoming : [];
  return upcoming.find((e) => pickupLabelFor(e) === pickupMarket) || null;
}

function resolvePickupAddress(events, pickupMarket) {
  const evt = findPickupEvent(events, pickupMarket);
  if (!evt) return null;

  const zip = String(evt.zip || "").trim();
  if (!/^\d{5}$/.test(zip)) return null;

  const stateMatch = String(evt.location || "").match(/,\s*([A-Za-z]{2})\s*$/);
  const state = stateMatch ? stateMatch[1].toUpperCase() : "SC";

  return { state, postal_code: zip, country: "US" };
}

// Stripe rates an order against a Customer's saved shipping address when the
// session itself doesn't collect one, which is the only way to pin a pickup
// order to the market inside Checkout. (Stripe's purpose-built feature for
// this, performance locations, is not supported by Checkout Sessions.)
async function createPickupCustomer(env, address, marketLabel) {
  const params = new URLSearchParams();
  params.append("shipping[name]", truncate(marketLabel, 250));
  params.append("shipping[address][state]", address.state);
  params.append("shipping[address][postal_code]", address.postal_code);
  params.append("shipping[address][country]", address.country);
  params.append("metadata[pickup_market]", truncate(marketLabel, 250));

  const res = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: params.toString()
  });
  if (!res.ok) return null;
  const customer = await res.json();
  return customer && customer.id ? customer.id : null;
}

// Bundle buttons render data-item-id="bundle-<id>" (see main.js's
// bundlesHTML()), but a bundle's own `id` in products.json never carries
// that prefix (e.g. button id "bundle-starter-self-care-set" vs. catalog id
// "starter-self-care-set") -- strip it back off before searching the
// bundles array, or every bundle checkout would 404 against its own catalog.
// A single checkout validates every line item against the same catalog, so
// each item was rebuilding an identical id->product (and id->bundle) Map and
// running O(N) `.find()` scans. Build each lookup Map once per catalog object
// and cache it in a WeakMap keyed by that catalog, turning findEntry and the
// price resolvers into O(1) lookups with no repeated allocation. The WeakMap
// key means a fresh catalog (e.g. after cache expiry) transparently gets its
// own maps, and old ones are garbage-collected with the catalog they belong to.
const productMapCache = new WeakMap();
const bundleMapCache = new WeakMap();

function productMapOf(catalog) {
  let map = productMapCache.get(catalog);
  if (!map) {
    const products = Array.isArray(catalog.products) ? catalog.products : [];
    map = new Map(products.map((p) => [p.id, p]));
    productMapCache.set(catalog, map);
  }
  return map;
}

function bundleMapOf(catalog) {
  let map = bundleMapCache.get(catalog);
  if (!map) {
    const bundles = Array.isArray(catalog.bundles) ? catalog.bundles : [];
    map = new Map(bundles.map((b) => [b.id, b]));
    bundleMapCache.set(catalog, map);
  }
  return map;
}

function findEntry(catalog, id) {
  const found = productMapOf(catalog).get(id);
  if (found) return found;
  const bundleId = id.startsWith("bundle-") ? id.slice("bundle-".length) : id;
  return bundleMapOf(catalog).get(bundleId) || null;
}

// Variant labels arrive from the client and are matched against the catalog's
// own option list, never trusted as free text. Normalisation is deliberately
// forgiving about the things a copy/paste or a stale cart mangles (case,
// surrounding and doubled whitespace) and deliberately strict about
// everything else: "S " is the sold-out "S", but "24 oz" is not "4 oz".
function normalizeVariantLabel(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Resolve a client-sent variant label to the real catalog option.
 *
 * Returns the matching option object, or null when the item is not
 * purchasable as sent. Callers must treat null as "fail closed":
 *   - the entry has options and the client named one that doesn't exist
 *     (previously this silently charged the base price -- a shopper who
 *     edited the label got a real product at a price no page ever offered),
 *   - the named option is sold out,
 *   - the entry has options and the client named none (an order can't be
 *     packed without knowing which size shipped).
 * An entry with no options at all returns null too; callers distinguish that
 * case with hasVariantOptions() before deciding it's an error.
 */
function hasVariantOptions(entry) {
  return Boolean(
    entry &&
    entry.variants &&
    Array.isArray(entry.variants.options) &&
    entry.variants.options.length
  );
}

function findVariantOption(entry, variantLabel) {
  if (!hasVariantOptions(entry)) return null;
  if (variantLabel === null || variantLabel === undefined || variantLabel === "") return null;
  const wanted = normalizeVariantLabel(variantLabel);
  if (!wanted) return null;
  const opt = entry.variants.options.find((o) => o && normalizeVariantLabel(o.label) === wanted);
  return opt || null;
}

// Bundles in products.json never carry their own `price` field -- like
// main.js's bundlesHTML() and scripts/build-site-data.js's bundlePricing(),
// their price is always computed live from their real component products'
// prices, so it can't drift out of sync after a product's price changes.
// (Previously this was baked into a generated snipcart-products.json
// manifest at build time; there's no equivalent static artifact anymore,
// so it's recomputed here, server-side, on every checkout instead.)
/**
 * Which members of a gift set are sold in sizes/scents/blends, and therefore
 * need a choice from the shopper before the set can be packed.
 *
 * Derived from the bundle's own productIds against the live catalog -- the
 * bundle records carry no variant slot of their own, and the client derives
 * the identical list in main.js's bundleVariantMembers(). A product that
 * grows an option starts being required here on the next catalog fetch,
 * with no data migration and nothing for the client to assert.
 */
function bundleVariantMembers(catalog, bundle) {
  if (!bundle || !Array.isArray(bundle.productIds)) return [];
  const productMap = productMapOf(catalog);
  const members = [];
  for (const id of bundle.productIds) {
    const p = productMap.get(id);
    if (!hasVariantOptions(p)) continue;
    members.push({ productId: id, product: p });
  }
  return members;
}

/**
 * Validate the per-member choices a gift-set line arrived with.
 *
 * Until the 2026-09-02 live audit a gift set checked out as `{id, qty}` with
 * no variant field anywhere in the payload, and this Worker never asked:
 * $45 was taken for a Pride Set containing a tee (4 sizes) and an oil
 * (3 scents), and the order carried neither. Every choice is now matched
 * against the catalog's real option list -- an unknown label, a sold-out
 * one, or a missing one is a 400 the cart drawer surfaces, never a silent
 * fallback to "the first size".
 *
 * Returns [{productId, productName, variantName, label, priceDelta}] using
 * the CATALOG's spelling of every label, which is what reaches Stripe.
 */
function resolveBundleVariantChoices(catalog, bundle, rawChoices) {
  const members = bundleVariantMembers(catalog, bundle);
  if (!members.length) return [];
  const choices =
    rawChoices && typeof rawChoices === "object" && !Array.isArray(rawChoices) ? rawChoices : {};
  const setName = bundle.name || bundle.id;

  // A choice naming something that is not a variant-bearing member of THIS
  // set is a tampered or stale payload, not a harmless extra.
  const memberIds = new Set(members.map((m) => m.productId));
  for (const key of Object.keys(choices)) {
    if (!memberIds.has(key)) {
      throw new ClientError(`"${key}" is not part of the ${setName}.`);
    }
  }

  const resolved = [];
  for (const m of members) {
    const variantName = (m.product.variants && m.product.variants.name) || "Option";
    const requested = choices[m.productId];
    if (requested === undefined || requested === null || requested === "") {
      throw new ClientError(
        `Please choose a ${variantName.toLowerCase()} for the ${m.product.name} in the ${setName}.`
      );
    }
    const opt = findVariantOption(m.product, requested);
    if (!opt) {
      throw new ClientError(
        `That ${variantName.toLowerCase()} isn't available for the ${m.product.name} in the ${setName}.`
      );
    }
    if (opt.soldOut) {
      throw new ClientError(
        `${m.product.name} (${opt.label}) is sold out, so the ${setName} can't be made up that way.`
      );
    }
    resolved.push({
      productId: m.productId,
      productName: m.product.name,
      variantName,
      label: opt.label,
      priceDelta: typeof opt.priceDelta === "number" ? opt.priceDelta : 0
    });
  }
  return resolved;
}

// Bundles in products.json never carry their own `price` field -- like
// main.js's bundlesHTML() and scripts/build-site-data.js's bundlePricing(),
// their price is always computed live from their real component products'
// prices, so it can't drift out of sync after a product's price changes.
// (Previously this was baked into a generated snipcart-products.json
// manifest at build time; there's no equivalent static artifact anymore,
// so it's recomputed here, server-side, on every checkout instead.)
//
// A bundle's price is either set outright (`price`) or worked out as a
// percentage off the sum of its parts (`discountPercent`, the older form
// and still the fallback). A chosen member option that costs more (the
// 8 oz shea, the 24 oz soak) is added ON TOP:
//   - explicit price: at face value, so a $5 upgrade costs $5;
//   - percentage: folded into the full price before the discount, which is
//     what that model has always done.
// Either way the picker never hands out a free upgrade. The identical rule
// lives in assets/js/cart.js, workers/checkout.js and
// scripts/build-site-data.js and the three MUST agree -- the Worker is the
// one that actually charges, and a mismatch means the drawer quotes a price
// the customer is not billed.
// The deltas come from the catalog options resolved above, never from the
// payload.
function resolveBundlePriceDollars(catalog, bundle, variantChoices) {
  if (!bundle || !Array.isArray(bundle.productIds) || !bundle.productIds.length) return null;
  const productMap = productMapOf(catalog);
  let baseSum = 0;
  for (const id of bundle.productIds) {
    const p = productMap.get(id);
    if (!p || typeof p.price !== "number") return null; // referential integrity issue -- fail closed
    baseSum += typeof p.originalPrice === "number" ? p.originalPrice : p.price;
  }
  let deltaSum = 0;
  if (Array.isArray(variantChoices)) {
    for (const choice of variantChoices) {
      deltaSum += Number(choice.priceDelta) || 0;
    }
  }
  const fixed = bundle.price;
  if (typeof fixed === "number" && Number.isFinite(fixed) && fixed > 0) {
    return Math.round((fixed + deltaSum) * 100) / 100;
  }
  return Math.round((baseSum + deltaSum) * (1 - (bundle.discountPercent || 0) / 100) * 100) / 100;
}

const QUALIFYING_2OZ_SALVE_PRICE_CENTS = 1500;

const DEFAULT_VOLUME_PRICING = [
  {
    id: "salves-2oz",
    name: "2oz Salve Multi-Buy",
    category: "salves",
    qualifyingVariant: "2oz",
    minQuantity: 2,
    unitPrice: QUALIFYING_2OZ_SALVE_PRICE_CENTS / 100,
    label: "2+ for $15 each",
    enabled: true
  }
];

function getVolumePricingRules(catalog) {
  if (catalog && Array.isArray(catalog.volumePricing)) {
    return catalog.volumePricing.filter((r) => r && r.enabled !== false);
  }
  if (catalog && catalog.shop && Array.isArray(catalog.shop.volumePricing)) {
    return catalog.shop.volumePricing.filter((r) => r && r.enabled !== false);
  }
  return DEFAULT_VOLUME_PRICING;
}

// Volume pricing decides how many units of a rule's product are in the cart,
// which is what unlocks the cheaper unit price. Every input to that decision
// therefore has to come from the catalog, not from the payload (F11): a
// client that could assert its own `category`, or have an unrecognised
// `variant` string taken at face value, could mix two unrelated products and
// still collect the multi-buy price. So:
//   - the category is ONLY ever the catalog entry's category (no
//     item.category fallback, no per-id hardcodes for products whose entry
//     failed to load -- an unknown id simply doesn't qualify),
//   - a variant claim is resolved against the entry's real option list and
//     the CATALOG's label is what gets compared to the rule.
// Products with no options at all can still qualify (Sleep Salve is a 2oz
// salve with nothing to choose), but only on the catalog's own text.
function itemMatchesVolumeRule(item, rule, catalog) {
  if (!item || !item.id || !rule || rule.enabled === false) return false;
  if (!catalog) return false;
  const entry = findEntry(catalog, String(item.id));
  if (!entry) return false;
  if ((entry.category || "") !== rule.category) return false;

  if (rule.qualifyingVariant) {
    // Whitespace is stripped entirely here (not just collapsed) so a rule
    // written "2 oz" still matches a catalog option labelled "2oz".
    const normQ = String(rule.qualifyingVariant).trim().toLowerCase().replace(/\s+/g, "");
    if (hasVariantOptions(entry)) {
      const opt = findVariantOption(entry, item.variant || item.variantLabel);
      if (!opt || opt.soldOut) return false;
      return String(opt.label).trim().toLowerCase().replace(/\s+/g, "") === normQ;
    }
    const text = (
      String(entry.name || "") +
      " " +
      String(entry.blurb || "") +
      " " +
      String(entry.description || "")
    )
      .toLowerCase()
      .replace(/\s+/g, "");
    return text.includes(normQ);
  }
  return true;
}

function isQualifying2ozSalve(item, catalog) {
  const rules = getVolumePricingRules(catalog);
  const salveRule = rules.find((r) => r.category === "salves") || DEFAULT_VOLUME_PRICING[0];
  return itemMatchesVolumeRule(item, salveRule, catalog);
}

// Resolve a validated unit price (in cents) for an item, honoring a chosen
// variant's priceDelta when one is supplied and valid. `isBundle` picks the
// bundle-pricing path above instead of a plain product's own `price` field.
function resolveUnitAmountCents(
  catalog,
  entry,
  variantLabel,
  isBundle,
  ruleCountsOrSalveCount,
  bundleVariantChoices
) {
  let matchedDiscountCents = null;
  if (!isBundle && entry) {
    const rules = getVolumePricingRules(catalog);

    if (typeof ruleCountsOrSalveCount === "number") {
      if (
        ruleCountsOrSalveCount >= 2 &&
        isQualifying2ozSalve(
          { id: entry.id, category: entry.category, variant: variantLabel },
          catalog
        )
      ) {
        const salveRule = rules.find((r) => r.category === "salves") || DEFAULT_VOLUME_PRICING[0];
        matchedDiscountCents = Math.round(Number(salveRule.unitPrice) * 100);
      }
    } else if (ruleCountsOrSalveCount && typeof ruleCountsOrSalveCount.get === "function") {
      for (const rule of rules) {
        const ruleKey = rule.id || rule.name || rule.category;
        const count = ruleCountsOrSalveCount.get(ruleKey) || 0;
        const minQ = typeof rule.minQuantity === "number" ? rule.minQuantity : 2;
        if (
          count >= minQ &&
          itemMatchesVolumeRule(
            { id: entry.id, category: entry.category, variant: variantLabel },
            rule,
            catalog
          )
        ) {
          const discountCents = Math.round(Number(rule.unitPrice) * 100);
          if (matchedDiscountCents === null || discountCents < matchedDiscountCents) {
            matchedDiscountCents = discountCents;
          }
        }
      }
    }
  }

  let price;
  if (isBundle) {
    price = resolveBundlePriceDollars(catalog, entry, bundleVariantChoices);
  } else {
    price = typeof entry.price === "number" ? entry.price : null;
  }
  if (price === null || price === undefined) return null;
  if (!isBundle && hasVariantOptions(entry)) {
    // A product with options is only sold AS one of those options. Anything
    // else -- an unknown label, a sold-out one, or no label at all -- is not
    // purchasable, rather than quietly falling back to the base price:
    //   - an unknown label used to charge base price for a product no page
    //     ever offered at that price (and left fulfilment with no size),
    //   - "no label" can only reach here from a stale cart or a tampered
    //     client, since every add-to-cart control picks an option.
    // Matching is by the CATALOG's label (normalised for case/whitespace),
    // and the matched option is what names the Stripe line item.
    const opt = findVariantOption(entry, variantLabel);
    if (!opt || opt.soldOut) return null;
    if (typeof opt.priceDelta === "number") price += opt.priceDelta;
  }

  const baseCents = Math.round(price * 100);
  if (matchedDiscountCents !== null) {
    return Math.min(baseCents, matchedDiscountCents);
  }
  return baseCents;
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

// stripControlChars (imported from routes/http.js) drops the control
// characters that have no business in Stripe metadata and would otherwise land
// unescaped in the gift-card email the webhook sends. Tabs and newlines
// survive: a gift message is allowed to have lines.

/**
 * Validate a gift-card recipient address before it becomes the destination of
 * a real email carrying real money.
 *
 * This is the one client-supplied string this Worker hands to an outbound
 * mailer: fulfill-gift-card.js sends the redeemable code to whatever address
 * lands in session metadata. An unvalidated value meant a typo silently
 * burned the card (the code exists, nobody can receive it), and a value
 * carrying a CR/LF or a control byte is header-injection material on the way
 * out. Reject at checkout, where the shopper can still fix it, with a message
 * they're allowed to see (ClientError -> 400 with this text).
 */
const MAX_EMAIL_LEN = 254; // RFC 5321 practical maximum

function validateGiftRecipientEmail(raw) {
  const clean = stripControlChars(raw).replace(/\s+/g, "");
  if (
    !clean ||
    clean.length > MAX_EMAIL_LEN ||
    !/^[^\s@,;<>]+@[^\s@,;<>.]+(?:\.[^\s@,;<>.]+)+$/.test(clean)
  ) {
    throw new ClientError("Please enter a valid email address for your gift card recipient.");
  }
  return clean;
}

// The cart drawer's milestone meter promises a free pocket salve once the
// physical subtotal clears the top shipping milestone. Read the number from
// the same CMS-editable list the meter renders from (products.json
// shop.shippingMilestones) so raising it in /admin moves the promise and what
// Stripe puts on the order together; fall back to the $60 the copy has always
// quoted when the field is missing or malformed.
const DEFAULT_FREE_GIFT_THRESHOLD_CENTS = 6000; // $60.00
const FREE_GIFT_LINE_NAME = "Free Handcrafted Pocket Salve (gift)";

function resolveFreeGiftThresholdCents(catalog) {
  const milestones =
    catalog && catalog.shop && Array.isArray(catalog.shop.shippingMilestones)
      ? catalog.shop.shippingMilestones
      : [];
  for (const m of milestones) {
    if (!m) continue;
    const isGiftMilestone = m.icon === "gift" || /salve|gift/i.test(String(m.reward || ""));
    const dollars = Number(m.threshold);
    if (isGiftMilestone && Number.isFinite(dollars) && dollars > 0) {
      return Math.round(dollars * 100);
    }
  }
  return DEFAULT_FREE_GIFT_THRESHOLD_CENTS;
}

// Build-your-own box. The shopper picks their own mix, so unlike a bundle
// there's no fixed catalog entry to price against -- the contents arrive from
// the client. That makes this the one place a tampered payload could try to
// invent a cheap "box", so everything is re-validated here against
// products.json and the shop's own customBox rules:
//   - the feature must actually be configured,
//   - every chosen id must be a real product,
//   - every chosen product must be in an eligible category,
//   - the count must sit within the configured min/max,
//   - the price is recomputed from the real product prices, never trusted.
// Any failure throws, which the caller turns into a 400 -- fail closed.
const CUSTOM_BOX_ID = "custom-box";

function resolveCustomBoxCents(catalog, productIds) {
  const cfg = (catalog.shop && catalog.shop.customBox) || null;
  if (!cfg) throw new ClientError("Custom boxes are not enabled.");
  if (!Array.isArray(productIds) || !productIds.length) {
    throw new ClientError("Custom box is empty.");
  }

  const minItems = Number.isFinite(cfg.minItems) ? cfg.minItems : 1;
  const maxItems = Number.isFinite(cfg.maxItems) ? cfg.maxItems : 12;
  if (productIds.length < minItems || productIds.length > maxItems) {
    throw new ClientError(`A custom box must contain between ${minItems} and ${maxItems} items.`);
  }

  const eligible = Array.isArray(cfg.eligibleCategories) ? cfg.eligibleCategories : null;
  const productMap = productMapOf(catalog);

  let fullPrice = 0;
  for (const rawId of productIds) {
    const p = productMap.get(String(rawId));
    if (!p || typeof p.price !== "number") {
      throw new ClientError(`Product not found in box: ${rawId}`);
    }
    if (p.comingSoon) throw new ClientError(`Not available yet: ${rawId}`);
    if (eligible && eligible.indexOf(p.category) === -1) {
      throw new ClientError(`Not eligible for a custom box: ${rawId}`);
    }
    fullPrice += p.price;
  }

  const pct = Number.isFinite(cfg.discountPercent) ? cfg.discountPercent : 0;
  // Clamp the discount defensively: a mis-typed 500 in the CMS shouldn't be
  // able to produce a negative line total.
  const safePct = Math.min(Math.max(pct, 0), 90);
  return Math.round(fullPrice * (1 - safePct / 100) * 100);
}

// Free-shipping threshold, in cents, straight from the catalog the site is
// already rendering from (products.json shop.freeShippingThreshold, editable
// in the CMS). Keeping this out of a constant is the whole point: the
// announcement bar, the product cards and the cart drawer all read that
// value, so hardcoding it here means changing it in the CMS updates every
// promise on the site while Stripe quietly keeps billing at the old number.
//
// Semantics match the client (assets/js/cart.js freeShipThreshold() and
// main.js's announcement bar):
//   missing / non-numeric -> DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS
//   <= 0                  -> free shipping disabled (admin/config.yml:
//                            "Set to 0 to disable"), flat rate always applies
const DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS = 4000; // $40.00

function resolveFreeShippingThresholdCents(catalog) {
  const raw = catalog && catalog.shop ? catalog.shop.freeShippingThreshold : undefined;
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS;
  }
  const dollars = Number(raw);
  if (!Number.isFinite(dollars)) return DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS;
  if (dollars <= 0) return 0; // promise switched off
  return Math.round(dollars * 100);
}

/**
 * Which route is this? Accepts both the path Netlify's `/api/*` proxy forwards
 * (`/checkout`, because `:splat` drops the prefix) and the full `/api/checkout`
 * a Cloudflare route on the apex domain would deliver -- see the file header.
 * A trailing slash is ignored; anything else is not a route.
 */
export function routeOf(pathname) {
  let path = String(pathname || "").replace(/\/+$/, "");
  if (path === "/api" || path.startsWith("/api/")) path = path.slice(4);
  if (path === "") path = "/checkout"; // the bare proxy target, historically
  return path;
}

const ROUTES = {
  "/gift-card-balance": handleGiftCardBalance,
  "/stripe-webhook": handleStripeWebhook,
  "/order-status": handleOrderStatus,
  "/order-summary": handleOrderSummary,
  "/restock": handleRestock,
  // MoCRA adverse-event intake -- the endpoint behind the /safety URL printed
  // on the packaging (routes/safety-report.js). Needs STATE_DB and answers 503
  // without it: a reaction report received into nowhere is the one outcome
  // that page must never produce.
  "/safety-report": handleSafetyReport,
  "/gift-note": handleGiftNote,
  "/market-alerts": handleMarketAlerts,
  // Retention (workers/routes/retention.js). Every one of these needs STATE_DB
  // and answers 503 without it rather than pretending to have stored anything.
  "/unsubscribe": handleUnsubscribe,
  "/welcome-code": handleWelcomeCode,
  "/birthday-club": handleBirthdayClub,
  "/loyalty-balance": handleLoyaltyBalance
};

async function handleCheckout(request, env, ctx, origin) {
  {
    try {
      const body = await request.json();
      const items = body && body.items;
      if (!Array.isArray(items) || items.length === 0) {
        return json({ error: "Cart is empty or invalid." }, 400, origin, env);
      }
      if (items.length > MAX_LINE_ITEMS) {
        return json({ error: "Too many line items." }, 400, origin, env);
      }

      const catalog = await loadCatalog(env, ctx);

      const metadata = {}; // Stripe session-level metadata (gift recipient/sender/message)

      // Market pickup, validated on EVERY checkout rather than only when tax
      // is on. Claiming a pickup waives the shipping charge and (below) the
      // shipping-address form, so an unchecked label was a free-shipping
      // switch any client could flip by sending a string; and a made-up
      // market on the packing list is a physical order nobody can hand over.
      // The label is re-derived from events.json exactly as cart.js renders
      // it -- anything that doesn't match a real upcoming market is ignored
      // (ordinary shipped order) and flagged in metadata so a legitimate
      // mismatch, e.g. a market pulled from the calendar mid-session, is
      // visible in the Stripe dashboard instead of silent. A calendar that
      // won't load is treated the same way: it can't be honoured, so it
      // falls back to the shipped flow rather than trusting the client.
      const rawPickup = body && (body.pickupMarket || body.pickup_market);
      let pickupEvent = null;
      if (rawPickup && typeof rawPickup === "string") {
        try {
          pickupEvent = findPickupEvent(await loadEvents(env, ctx), rawPickup);
        } catch (e) {
          pickupEvent = null;
        }
        if (pickupEvent) {
          // Store the calendar's own label, never the client's copy of it.
          metadata.pickup_market = truncate(pickupLabelFor(pickupEvent), 250);
        } else {
          metadata.pickup_market_rejected = "true";
        }
      }
      const isPickup = Boolean(pickupEvent);

      // The language the shopper was reading the shop in, sent by cart.js from
      // the same `yl-lang` preference assets/js/translator.js writes. Without
      // it Stripe renders Checkout from Accept-Language, so someone browsing
      // the site in Japanese could land on an English payment page -- the one
      // step in the funnel where confusion costs an order. Validated against
      // the allow-list here rather than trusted: this value goes straight into
      // an outbound Stripe parameter, and `locale` is an enum Stripe rejects
      // the whole session for if it is unknown. All six of our codes are in
      // that enum (en, es, de, fr, ja, zh). Anything else is dropped, which
      // leaves Stripe on its default browser-locale behaviour.
      const rawLocale = body && body.locale;
      const checkoutLocale =
        typeof rawLocale === "string" && CHECKOUT_LOCALES.has(rawLocale.trim().toLowerCase())
          ? rawLocale.trim().toLowerCase()
          : null;
      const rawDiscount =
        body && (body.discount_code !== undefined ? body.discount_code : body.discountCode);
      if (rawDiscount && typeof rawDiscount === "string") {
        const cleanDiscount = rawDiscount
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
          .trim()
          .toUpperCase();
        if (cleanDiscount) {
          metadata.discount_code = truncate(cleanDiscount, 100);
        }
      }
      let giftLineIndex = 0;

      let boxLineIndex = 0;
      let bundleLineIndex = 0;
      const boxProductMap = productMapOf(catalog);

      const volumeRules = getVolumePricingRules(catalog);
      const ruleCounts = new Map();
      for (const rule of volumeRules) {
        const count = items.reduce((sum, item) => {
          if (itemMatchesVolumeRule(item, rule, catalog)) {
            const q = parseInt(item.qty, 10);
            return sum + (Number.isNaN(q) || q < 1 ? 1 : Math.min(q, MAX_QTY_PER_ITEM));
          }
          return sum;
        }, 0);
        ruleCounts.set(rule.id || rule.name || rule.category, count);
      }

      // What the retention layer needs off this order, collected as the line
      // items are validated so it costs nothing extra: the ids and categories
      // of what was bought. The webhook copies these into `order_signals` and
      // they decide which "how to use your …" copy gets sent and whether the
      // review ask waits 7 days or 12. Ids only -- no names, no quantities, no
      // prices; Stripe metadata is world-readable in the Dashboard.
      const retentionProductIds = [];
      const retentionCategories = [];

      const lineItems = items.map((item) => {
        // Custom boxes have no catalog entry of their own -- priced and
        // validated entirely from their contents. Handled before findEntry(),
        // which would (correctly) fail to find "custom-box" in the catalog.
        if (String(item.id) === CUSTOM_BOX_ID) {
          const ids = Array.isArray(item.boxProductIds) ? item.boxProductIds : [];
          const unitAmount = resolveCustomBoxCents(catalog, ids);
          const parsedBoxQty = parseInt(item.qty, 10);
          const boxQty =
            Number.isNaN(parsedBoxQty) || parsedBoxQty < 1
              ? 1
              : Math.min(parsedBoxQty, MAX_QTY_PER_ITEM);
          const contents = ids
            .map((id) => (boxProductMap.get(String(id)) || {}).name || id)
            .join(", ");
          for (const id of ids) {
            const boxed = boxProductMap.get(String(id));
            if (!boxed) continue;
            retentionProductIds.push(boxed.id || String(id));
            if (boxed.category) retentionCategories.push(boxed.category);
          }
          boxLineIndex += 1;
          // Record the exact contents so the packing slip / fulfilment side
          // knows what actually goes in the box.
          metadata[`custom_box_${boxLineIndex}`] = truncate(contents, MAX_GIFT_TEXT_LEN);
          return {
            name: `Build-Your-Own Box (${ids.length} items)`,
            image: null,
            description: contents || null,
            unitAmount,
            qty: boxQty,
            isGiftCard: false,
            // A box only ever holds physical apothecary goods (the builder
            // excludes apparel and gift cards), so the general goods code is
            // always right here -- no need to inspect its contents.
            taxCode: TAX_CODE_GOODS
          };
        }

        const entry = findEntry(catalog, String(item.id));
        if (!entry) throw new ClientError(`Product not found: ${item.id}`);

        // Availability, from the same catalog fields the shop pages render
        // from. A "Coming Soon" card has no working buy button and a sold-out
        // product isn't offered at all, so an order for one can only come
        // from a stale cart or an edited payload -- and taking the money for
        // something that cannot ship is worse than losing the sale.
        if (entry.comingSoon) {
          throw new ClientError(`Not available yet: ${entry.name || item.id}`);
        }
        if (entry.inStock === false) {
          throw new ClientError(`Sold out: ${entry.name || item.id}`);
        }

        const isGiftCard = item.id === GIFT_CARD_ID;
        const isBundle = !isGiftCard && bundleMapOf(catalog).has(entry.id);
        // Throws a ClientError (-> 400 with the message) when a gift set
        // arrives with a missing, unknown or sold-out member choice.
        const bundleChoices = isBundle
          ? resolveBundleVariantChoices(catalog, entry, item.bundleVariants)
          : [];
        const unitAmount = isGiftCard
          ? resolveGiftCardAmountCents(item.variant)
          : resolveUnitAmountCents(
              catalog,
              entry,
              item.variant,
              isBundle,
              ruleCounts,
              bundleChoices
            );
        if (unitAmount === null || unitAmount < 0) {
          throw new ClientError(`Product not purchasable: ${item.id}`);
        }

        const parsedQty = parseInt(item.qty, 10);
        let qty =
          Number.isNaN(parsedQty) || parsedQty < 1 ? 1 : Math.min(parsedQty, MAX_QTY_PER_ITEM);

        // `stock` is the on-hand count the CMS tracks (null/absent = not
        // tracked, e.g. made to order). Where it IS tracked, it caps the
        // quantity: a shopper who asks for 10 of the 3 that exist gets 3 --
        // charged for what can actually be shipped -- and 0 means there is
        // nothing to sell at all.
        if (typeof entry.stock === "number" && Number.isFinite(entry.stock)) {
          if (entry.stock <= 0) {
            throw new ClientError(`Sold out: ${entry.name || item.id}`);
          }
          qty = Math.min(qty, Math.floor(entry.stock));
        }

        // The variant in the line name comes from the catalog option that was
        // matched server-side, never from item.variant -- otherwise a client
        // could put arbitrary text (or a size it isn't buying) on the Stripe
        // receipt and the packing slip derived from it.
        const variantOption =
          !isGiftCard && !isBundle ? findVariantOption(entry, item.variant) : null;
        const name =
          entry.name +
          (isGiftCard
            ? ` ($${(unitAmount / 100).toFixed(2)})`
            : variantOption
              ? ` (${variantOption.label})`
              : "");
        const image =
          entry.image && env.SITE_ORIGIN
            ? `${env.SITE_ORIGIN}/${String(entry.image).replace(/^\/+/, "")}`
            : null;

        /* What was actually chosen inside a gift set, in the catalog's own
           words. It goes on the Stripe line item description (so it is on
           the receipt and on anything generated from the session) AND in
           session metadata, because a set is one line and the size/scent
           would otherwise exist nowhere on the order. */
        let description = null;
        if (isBundle && bundleChoices.length) {
          description = bundleChoices
            .map((c) => `${c.productName} — ${c.variantName}: ${c.label}`)
            .join(" · ");
          bundleLineIndex += 1;
          metadata[`gift_set_${bundleLineIndex}`] = truncate(
            `${entry.name}: ${description}`,
            MAX_GIFT_TEXT_LEN
          );
        }

        // Gift-card recipient/sender/message never affect price -- they're
        // pure metadata, attached at the session level (indexed so multiple
        // gift cards in one order don't collide).
        // One metadata GROUP per gift-card line, carrying its quantity --
        // not one group per unit. Stripe caps a session at 50 metadata keys,
        // so the old per-unit expansion meant a 10-card order silently lost
        // the cards past the cap: keys were dropped, the webhook never saw
        // them, and the buyer paid for codes that were never minted. The
        // webhook (fulfill-gift-card.js) now expands `_qty` itself when it
        // derives codes. A single card still writes exactly the keys it
        // always did, so nothing about the one-card case changes.
        if (isGiftCard) {
          giftLineIndex += 1;
          const prefix = `gift_card_${giftLineIndex}`;
          // amount_cents is what fulfill-gift-card.js (the Netlify function
          // listening for checkout.session.completed) reads to know how
          // much to put on the code it emails -- it's set here, server-
          // side, from the same clamped unitAmount already computed above,
          // never from anything the client sent directly.
          metadata[`${prefix}_amount_cents`] = String(unitAmount);
          if (qty > 1) metadata[`${prefix}_qty`] = String(qty);
          if (
            item.giftRecipientEmail !== undefined &&
            item.giftRecipientEmail !== null &&
            item.giftRecipientEmail !== ""
          ) {
            // Validated, not just truncated: this address is where a real
            // stored-value code gets emailed. See validateGiftRecipientEmail.
            metadata[`${prefix}_recipient`] = truncate(
              validateGiftRecipientEmail(item.giftRecipientEmail),
              MAX_GIFT_TEXT_LEN
            );
          }
          if (item.giftSenderName) {
            const sender = stripControlChars(item.giftSenderName);
            if (sender) metadata[`${prefix}_sender`] = truncate(sender, MAX_GIFT_TEXT_LEN);
          }
          if (item.giftMessage) {
            const giftNote = stripControlChars(item.giftMessage);
            if (giftNote) metadata[`${prefix}_message`] = truncate(giftNote, MAX_GIFT_TEXT_LEN);
          }
        }

        // Bundles have no category of their own, but every current bundle is
        // a mix of apothecary goods, so general tangible goods is correct for
        // them too. Only apparel and gift cards need to differ.
        const taxCode = isGiftCard
          ? TAX_CODE_GIFT_CARD
          : entry.category === "apparel"
            ? TAX_CODE_APPAREL
            : TAX_CODE_GOODS;

        retentionProductIds.push(entry.id);
        if (entry.category) retentionCategories.push(entry.category);

        return { name, image, description, unitAmount, qty, isGiftCard, taxCode };
      });

      // Stripe caps a metadata VALUE at 500 characters, so these are truncated
      // rather than silently rejected. Losing the tail of a very long list only
      // costs the email a product name, never a send.
      const uniqueRetentionIds = Array.from(new Set(retentionProductIds));
      const uniqueRetentionCategories = Array.from(new Set(retentionCategories));
      if (uniqueRetentionIds.length) {
        metadata.retention_product_ids = truncate(uniqueRetentionIds.join(","), 490);
      }
      if (uniqueRetentionCategories.length) {
        metadata.retention_categories = truncate(uniqueRetentionCategories.join(","), 490);
      }

      const totalCents = lineItems.reduce((sum, li) => sum + li.unitAmount * li.qty, 0);

      // Flat-rate shipping, matching the site's existing "Free shipping on
      // orders over $X" promise (see the announcement bar in main.js and
      // cart.js's free-shipping progress meter, both driven by
      // products.json's shop.freeShippingThreshold -- which is why the
      // threshold is read from the same catalog here rather than hardcoded;
      // see resolveFreeShippingThresholdCents). $10 is a starting default
      // carried over from what the Etsy listings charge for apparel shipped
      // from Landrum, SC -- that one genuinely is a business constant, not
      // CMS-editable. Gift cards are emailed, not shipped, so an order
      // that's ALL gift cards gets no shipping line at all.
      const physicalSubtotalCents = lineItems
        .filter((li) => !li.isGiftCard)
        .reduce((sum, li) => sum + li.unitAmount * li.qty, 0);
      const hasPhysicalItems = physicalSubtotalCents > 0;
      const freeShippingThresholdCents = resolveFreeShippingThresholdCents(catalog);
      const flatShippingRateCents = 1000; // $10.00
      // A threshold of 0 means the promise is off entirely, so nothing ever
      // qualifies -- not even a huge order.
      const qualifiesForFreeShipping =
        freeShippingThresholdCents > 0 && physicalSubtotalCents >= freeShippingThresholdCents;
      const shippingCents =
        hasPhysicalItems && !isPickup && !qualifiesForFreeShipping ? flatShippingRateCents : 0;

      // The cart drawer promises a free pocket salve at this milestone, so
      // the order has to actually contain one. A metadata flag alone left the
      // gift invisible on Stripe's receipt, on the packing slip generated
      // from the session, and to anyone picking the order -- a promise the
      // shopper saw and nobody downstream did. A $0 line item makes it part
      // of the order proper. No tax code: a promotional $0 line has no
      // taxable value, and taxing zero is still zero.
      if (physicalSubtotalCents >= resolveFreeGiftThresholdCents(catalog)) {
        metadata.free_gift = "true";
        lineItems.push({
          name: FREE_GIFT_LINE_NAME,
          image: null,
          description: null,
          unitAmount: 0,
          qty: 1,
          isGiftCard: false,
          taxCode: null,
          noTax: true
        });
      }

      const taxEnabled = await isTaxEnabled(env, ctx);

      const params = new URLSearchParams();
      params.append("mode", "payment");
      // No explicit payment_method_types list. Sending one PINS the session
      // to exactly those methods, which quietly overrode the account's own
      // Payment methods settings: turning on Klarna/Affirm/Amazon Pay (or
      // having Stripe enable a new wallet) in the Dashboard did nothing here,
      // and a method that later needs disabling for risk reasons could not be
      // switched off without a redeploy. Omitting it lets Stripe offer
      // whatever the Dashboard has enabled and the buyer's device supports --
      // Apple Pay, Google Pay, Link and Cash App Pay included. 3-D Secure
      // stays "automatic": Stripe steps up only when the issuer or the risk
      // signals call for it.
      params.append("payment_method_options[card][request_three_d_secure]", "automatic");
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

      // ---- Abandoned-checkout recovery -----------------------------------
      // Stripe generates a recovery URL for an EXPIRED session and puts it on
      // the `checkout.session.expired` event (after_expiration.recovery.url,
      // valid 30 days). Stripe does not send anything: the mail is ours, and
      // workers/routes/retention-emails.js sends it 45 minutes later, once,
      // through Resend. Without this flag there is no URL to send at all.
      params.append("after_expiration[recovery][enabled]", "true");
      // The recovery page is a fresh session, so it needs its own permission to
      // accept a marketing code. It never carries the gift-card discount --
      // that reservation is released when the original session expires.
      params.append("after_expiration[recovery][allow_promotion_codes]", "true");

      // ---- Consent -------------------------------------------------------
      // "auto" shows the marketing opt-in checkbox when Stripe has an address
      // to attach it to, and reports the answer as session.consent.promotions.
      // The recovery email is ONLY sent when that reads "opt_in": abandoning a
      // cart is not consent to be marketed at, and this is the field that keeps
      // the difference honest.
      // Render Checkout in the language the shopper was already reading.
      // Omitted entirely when the client sent nothing recognisable, which
      // leaves Stripe on its default "use the browser's locale" behaviour.
      if (checkoutLocale) {
        params.append("locale", checkoutLocale);
      }

      params.append("consent_collection[promotions]", "auto");
      // A ticked terms box is the standard "product as described" evidence in a
      // dispute, and it costs one parameter (audit R5 / research-I M3).
      params.append("consent_collection[terms_of_service]", "required");
      // Stripe renders this next to the checkbox and linkifies bare URLs, so the
      // shopper can actually read what they are agreeing to before they tick it.
      params.append(
        "custom_text[terms_of_service_acceptance][message]",
        `I agree to the Terms of Service (${env.SITE_ORIGIN}/terms.html) and the ` +
          `shipping, returns and refund policies (${env.SITE_ORIGIN}/policies.html).`
      );

      // A pickup order is delivered at the market, so that's where it has to
      // be taxed -- see resolvePickupAddress. Pinning it means handing Stripe
      // a Customer that already carries the market address and NOT collecting
      // a shipping address, since a collected one always wins. Everything
      // here degrades to the normal flow if anything is missing: no ZIP on
      // the market, an unrecognised label, events.json unreachable, or the
      // customer create failing. Only attempted when tax is actually on --
      // with tax off there's no rate to get wrong, so it'd be a pointless
      // extra API call on every pickup checkout.
      let pickupCustomerId = null;
      if (taxEnabled && isPickup && hasPhysicalItems) {
        try {
          const marketLabel = pickupLabelFor(pickupEvent);
          const pickupAddress = resolvePickupAddress({ upcoming: [pickupEvent] }, marketLabel);
          if (pickupAddress) {
            pickupCustomerId = await createPickupCustomer(env, pickupAddress, marketLabel);
          }
        } catch (e) {
          // Non-fatal by design: a market that can't be pinned (no ZIP on the
          // calendar, or the customer create failing) must never block a
          // sale. Falls through to buyer-address rating below. It is still a
          // pickup -- nothing is being shipped -- so the shipping address
          // form stays off either way.
          pickupCustomerId = null;
        }
      }
      const pinnedToMarket = Boolean(pickupCustomerId);

      // With tax on, an address is what Stripe rates the order against, and
      // an all-gift-card order collects no shipping address at all -- so the
      // billing address has to be mandatory or those orders can't be rated.
      params.append("billing_address_collection", taxEnabled ? "required" : "auto");
      if (taxEnabled) {
        params.append("automatic_tax[enabled]", "true");
        if (pinnedToMarket) {
          params.append("customer", pickupCustomerId);
          // Stop Checkout writing the buyer's billing address onto the
          // Customer, which would otherwise displace the market address we
          // just pinned and put us back where we started.
          params.append("customer_update[address]", "never");
        } else {
          // New buyers have no Stripe Customer yet; Checkout needs one
          // created to attach the address it collects. Mutually exclusive
          // with passing `customer` above.
          params.append("customer_creation", "always");
        }
      }
      // Only ask for a shipping address (and charge shipping) when there's
      // actually something physical in the order -- an all-gift-card order
      // has nothing to ship. A validated market pickup skips the address form
      // and the shipping line entirely: nothing is being shipped, asking for
      // a delivery address invites the buyer to expect delivery, and (with
      // tax on) a collected shipping address would override the market
      // address the order is rated against.
      if (hasPhysicalItems && !isPickup) {
        params.append("shipping_address_collection[allowed_countries][0]", "US");
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append(
          "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
          String(shippingCents)
        );
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
        params.append(
          "shipping_options[0][shipping_rate_data][display_name]",
          shippingCents === 0 ? "Free shipping" : "Standard shipping"
        );
        if (taxEnabled) {
          params.append("shipping_options[0][shipping_rate_data][tax_behavior]", "exclusive");
          params.append("shipping_options[0][shipping_rate_data][tax_code]", TAX_CODE_SHIPPING);
        }
      }
      const isGift = Boolean(
        body &&
        (body.is_gift_order === true ||
          body.is_gift_order === "true" ||
          body.isGiftOrder === true ||
          body.isGiftOrder === "true")
      );
      if (isGift) {
        metadata.is_gift_order = "true";
        const rawGiftMessage =
          body && (body.gift_message !== undefined ? body.gift_message : body.giftMessage);
        if (typeof rawGiftMessage === "string") {
          metadata.gift_message = rawGiftMessage
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
            .trim()
            .slice(0, 500);
        } else {
          metadata.gift_message = "";
        }
      }
      // ---------------------------------------------------------------
      // Gift card, applied from the cart drawer.
      //
      // Audit C-2: the previous version looked the code up as a Stripe
      // Promotion Code, minted an ephemeral coupon for min(total, balance) and
      // DEBITED NOTHING. The balance checker kept reporting the full amount and
      // two tabs spent the same card twice.
      //
      // The balance now lives in the GiftCardLedger Durable Object -- one
      // object per code, so every request for a card is serialised -- and the
      // order here is what makes double-spending impossible:
      //
      //   1. read the balance and cap the discount at it,
      //   2. mint a single-use coupon for exactly that,
      //   3. create the session,
      //   4. RESERVE the amount against the ledger.
      //
      // Reserving last means a Stripe call that fails leaves no hold behind. If
      // the reserve itself fails -- another checkout took the money in between
      // -- the coupon is deleted, the session is EXPIRED so nobody can walk
      // back to that tab and pay a total discounted by money the card no longer
      // has, and the shopper gets a 409 telling them to re-apply.
      // ---------------------------------------------------------------
      let appliedGiftCardCouponId = null;
      let appliedGiftCardDiscountCents = 0;
      let appliedGiftCardCode = null;

      const rawGiftCard = body && (body.giftCardCode || body.gift_card_code);
      // Buying a gift card with a gift card is still refused. The reasons have
      // narrowed (there is no rollover to collide with any more) but one
      // remains: a card issued by this very session does not exist on the
      // ledger until the webhook runs, so an order that both spends and mints
      // stored value has two halves that cannot be made atomic. The code is not
      // rejected outright -- the order falls through to Stripe's own promotion
      // -code box.
      const cartHasGiftCardProduct = items.some((it) => it && String(it.id) === GIFT_CARD_ID);
      if (rawGiftCard && typeof rawGiftCard === "string" && !cartHasGiftCardProduct) {
        if (!isGiftCardCode(rawGiftCard)) {
          throw new ClientError("That gift card code doesn't look right. Please check it.");
        }
        if (!env.GIFT_CARD_LEDGER) {
          // Fail closed and SAY SO. Silently dropping the card would charge the
          // shopper full price for a cart whose total they watched go down.
          console.error("checkout: GIFT_CARD_LEDGER binding is missing; refusing to apply a card");
          throw new ClientError(
            "Gift cards are temporarily unavailable. Please try again shortly."
          );
        }

        const ledger = giftCardLedger(env, rawGiftCard);
        let snapshot;
        try {
          snapshot = await ledger.getBalance();
        } catch (err) {
          if (err instanceof LedgerError) snapshot = null;
          else throw err;
        }
        const availableCents = snapshot && snapshot.issued ? snapshot.balanceCents : 0;
        if (!(availableCents > 0)) {
          throw new ClientError("That gift card has no balance left.");
        }

        appliedGiftCardDiscountCents = Math.min(totalCents + shippingCents, availableCents);
        if (appliedGiftCardDiscountCents > 0) {
          const ephemeralCoupon = await stripePost(env, "/coupons", {
            amount_off: String(appliedGiftCardDiscountCents),
            currency: "usd",
            duration: "once",
            // Single use, always. This coupon exists only to discount THIS
            // session by the amount THIS card agreed to hold; without the cap
            // its id (which appears in the session and in metadata) could be
            // replayed on another checkout and spend the same money twice.
            max_redemptions: "1",
            name: `Gift Card (${ledger.code})`,
            "metadata[gift_card_code]": ledger.code,
            "metadata[applied_cents]": String(appliedGiftCardDiscountCents)
          });
          if (!ephemeralCoupon || !ephemeralCoupon.id) {
            throw new Error("Stripe refused the gift-card coupon");
          }
          appliedGiftCardCouponId = ephemeralCoupon.id;
          appliedGiftCardCode = ledger.code;
          metadata.gift_card_redeemed_code = ledger.code;
          metadata.gift_card_amount_applied_cents = String(appliedGiftCardDiscountCents);
          metadata.gift_card_original_balance_cents = String(availableCents);
          // Named so the webhook can clean it up: on checkout.session.expired
          // the coupon is deleted, and on completion it has already been
          // consumed. Without this id an abandoned checkout left a live
          // amount_off coupon in the account forever.
          metadata.gift_card_ephemeral_coupon_id = String(ephemeralCoupon.id);
        }
      }

      if (appliedGiftCardCouponId) {
        params.append("discounts[0][coupon]", appliedGiftCardCouponId);
      } else {
        // Marketing codes ONLY. A gift card is never entered here any more --
        // it is not a promotion code, it is a ledger balance -- and the webhook
        // ignores promotion codes entirely. Stripe will not accept a session
        // that carries both `discounts` and `allow_promotion_codes`, so this is
        // an either/or in any case.
        params.append("allow_promotion_codes", "true");
      }
      // Stripe hard-caps a session at 50 metadata keys and silently rejects
      // the request past that. Refuse the order here, with a message the
      // shopper can act on, rather than letting a large multi-card order
      // reach Stripe and either fail opaquely or (worse, pre-H-8) succeed
      // with the trailing gift cards missing from the metadata the webhook
      // reads. 45 leaves headroom for the session-level keys added above.
      if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
        throw new ClientError(
          "Please split orders of more than 12 gift cards into separate checkouts."
        );
      }
      Object.keys(metadata).forEach((key) => {
        params.append(`metadata[${key}]`, metadata[key]);
      });
      lineItems.forEach((li, i) => {
        params.append(`line_items[${i}][price_data][currency]`, "usd");
        params.append(`line_items[${i}][price_data][product_data][name]`, li.name);
        if (li.description) {
          params.append(
            `line_items[${i}][price_data][product_data][description]`,
            truncate(li.description, 500)
          );
        }
        if (li.image) {
          params.append(`line_items[${i}][price_data][product_data][images][0]`, li.image);
        }
        params.append(`line_items[${i}][price_data][unit_amount]`, String(li.unitAmount));
        if (taxEnabled && !li.noTax) {
          // "exclusive" = the price above is pre-tax and Stripe adds tax on
          // top, which is how every price on this site is displayed.
          params.append(`line_items[${i}][price_data][tax_behavior]`, "exclusive");
          params.append(`line_items[${i}][price_data][product_data][tax_code]`, li.taxCode);
        }
        params.append(`line_items[${i}][quantity]`, String(li.qty));
      });

      const createSession = async (body) => {
        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Stripe-Version": STRIPE_API_VERSION
          },
          body
        });
        return res.json();
      };
      let session = await createSession(params);
      // Stripe refuses `consent_collection.promotions` until the account has
      // agreed to the Checkout terms at dashboard.stripe.com/settings/checkout.
      // That refusal took every live checkout down on 2026-09-02. Consent is
      // only what feeds the abandoned-cart email; a checkout without it is
      // still a sale, so retry once without the consent fields and say why.
      if (
        session.error &&
        /consent_collection/i.test(String(session.error.message || "")) &&
        params.has("consent_collection[promotions]")
      ) {
        console.warn(
          "Stripe has not accepted Checkout terms for consent_collection; retrying without it. " +
            "Agree to the terms at https://dashboard.stripe.com/settings/checkout to enable the " +
            "marketing opt-in (abandoned-cart recovery emails need it)."
        );
        params.delete("consent_collection[promotions]");
        params.delete("consent_collection[terms_of_service]");
        params.delete("custom_text[terms_of_service_acceptance][message]");
        session = await createSession(params);
      }
      if (session.error) {
        // Log the real Stripe error server-side for debugging, but never echo
        // its message to the browser -- it can carry internal detail.
        console.error("Stripe checkout session error:", session.error);
        // A coupon minted for a session that was never created is a live
        // amount_off coupon with no webhook coming to clean it up.
        if (appliedGiftCardCouponId) await deleteCoupon(env, appliedGiftCardCouponId);
        throw new Error("Stripe rejected the checkout session");
      }

      // Take the hold LAST, against the session that now exists. Everything up
      // to here can fail without moving money; from here on, the money is held
      // and the webhook (commit on payment, release on expiry, and the ledger's
      // own 24h alarm as a backstop) is what lets it go again.
      if (appliedGiftCardCode && appliedGiftCardDiscountCents > 0) {
        try {
          await giftCardLedger(env, appliedGiftCardCode).reserve({
            sessionId: session.id,
            cents: appliedGiftCardDiscountCents
          });
        } catch (err) {
          if (!(err instanceof LedgerError)) throw err;
          // Another checkout spent the balance while this one was being built.
          // Unwind everything so nothing is left pointing at money that is no
          // longer there: delete the coupon, expire the session (otherwise the
          // shopper could return to the tab and pay the discounted total), and
          // tell the shopper to re-apply.
          await deleteCoupon(env, appliedGiftCardCouponId);
          await expireSession(env, session.id);
          console.warn(
            `Gift card ${appliedGiftCardCode} could not be held for ${session.id}: ${err.code}`
          );
          throw new ClientError("That gift card balance changed; please re-apply it.", 409);
        }
      }

      return json({ url: session.url }, 200, origin, env);
    } catch (err) {
      // Only ClientError messages are safe to show the shopper. Anything else
      // is an internal failure: log it and return a generic message so raw
      // error strings never leak to the client. `err.status` lets a refusal
      // that is not a validation problem carry its own code -- a gift-card
      // balance that moved under a live checkout is a 409, and the cart tells
      // the two apart.
      if (err instanceof ClientError) {
        return json({ error: err.message }, err.status || 400, origin, env);
      }
      console.error("Checkout failed:", err && err.stack ? err.stack : err);
      return json({ error: "Checkout failed. Please try again." }, 400, origin, env);
    }
  }
}

/**
 * The Worker entrypoint: one router in front of every endpoint on the money
 * path. Same CORS allowlist and the same `Cache-Control: no-store` envelope for
 * all of them (routes/http.js), because the difference between these endpoints
 * is what they do, not who may call them.
 */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const route = routeOf(new URL(request.url).pathname);
    const known = route === "/checkout" || Object.prototype.hasOwnProperty.call(ROUTES, route);

    if (request.method === "OPTIONS") {
      // Preflight for a route that does not exist still gets a CORS answer;
      // the POST behind it is what 404s. Answering differently here would let
      // an unauthenticated caller map the Worker's surface with OPTIONS alone.
      return preflight(origin, env);
    }
    if (!known) {
      return json({ error: "Not Found" }, 404, origin, env);
    }
    // The one GET on the Worker: the owner's printable gift note, opened from
    // a signed link in the order email (routes/gift-note.js). It carries its
    // own token check; everything else stays POST-only.
    if (route === "/gift-note" && request.method === "GET") {
      try {
        return await handleGiftNote(request, env);
      } catch (err) {
        console.error("gift-note failed:", err && err.stack ? err.stack : err);
        return json({ error: "Something went wrong." }, 500, origin, env);
      }
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405, origin, env);
    }
    // Reject cross-site callers outright. A request with NO Origin header is
    // allowed through: that is server-to-server traffic, which is what Stripe's
    // webhook is -- and it authenticates with a signature, not an origin.
    if (origin && !isAllowedOrigin(origin, env)) {
      return json({ error: "Forbidden origin" }, 403, origin, env);
    }

    if (route === "/checkout") return handleCheckout(request, env, ctx, origin);

    try {
      return await ROUTES[route](request, env, origin, ctx);
    } catch (err) {
      if (err instanceof ClientError) {
        return json({ error: err.message }, err.status || 400, origin, env);
      }
      console.error(`Route ${route} failed:`, err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong. Please try again." }, 500, origin, env);
    }
  },

  /**
   * Cron (wrangler.toml `[triggers]`, hourly). Four jobs, in this order:
   *
   *   1. Sweep settled webhook claims and burned magic-link tokens.
   *   2. Sweep settled rows out of the email queue.
   *   3. Run the birthday club -- mint today's codes and queue them. Guarded to
   *      9am America/New_York and idempotent per member per year, so running it
   *      every hour sends exactly one code per birthday.
   *   4. Drain the email queue: everything whose `send_after` has passed.
   *
   * Everything here is idempotent, so a missed tick costs a delay and nothing
   * else, and a doubled tick sends nothing twice. Failures are logged and do
   * not stop the later steps -- a birthday that cannot be minted must not also
   * stop the day-2 emails from going out.
   */
  async scheduled(event, env, ctx) {
    if (!env.STATE_DB) return;
    ctx.waitUntil(
      (async () => {
        const [{ sweepOldEvents }, { sweepBurnedTokens }, { ensureSchema }, retention, jobs] =
          await Promise.all([
            import("./state/webhook-events.js"),
            import("./state/magic-link.js"),
            import("./state/migrations.js"),
            import("./state/retention.js"),
            import("./routes/retention-emails.js")
          ]);
        await ensureSchema(env.STATE_DB);

        const steps = [
          ["webhook-events sweep", () => sweepOldEvents(env.STATE_DB)],
          ["burned-token sweep", () => sweepBurnedTokens(env.STATE_DB)],
          /* One row per paid order, kept 90 days so a very late Stripe
             redelivery still cannot double-book revenue in Umami. Without a
             sweeper this table would be the only one in the schema that grows
             forever. */
          [
            "analytics-send sweep",
            async () =>
              (await import("./state/analytics-sends.js")).sweepAnalyticsSends(env.STATE_DB)
          ],
          /* One row per order that has been told it shipped, kept 90 days so a
             late edit to the fulfilment metadata cannot send the notice twice.
             Same reason as the row above: without a sweeper it grows forever. */
          [
            "order-email sweep",
            async () => (await import("./state/order-emails.js")).sweepOrderEmails(env.STATE_DB)
          ],
          ["email-queue sweep", () => retention.sweepEmailQueue(env.STATE_DB)],
          ["birthday club", () => jobs.runBirthdayClub(env, ctx)],
          [
            "restock alerts",
            async () => (await import("./routes/restock.js")).runRestockAlerts(env, ctx)
          ],
          [
            "low-stock check",
            async () => (await import("./routes/restock.js")).runLowStockCheck(env, ctx)
          ],
          [
            "order digest",
            async () => (await import("./routes/order-digest.js")).runOrderDigest(env, ctx)
          ],
          [
            "market reminders",
            async () => (await import("./routes/market-alerts.js")).runMarketReminders(env, ctx)
          ],
          [
            "reaction export",
            async () => (await import("./routes/reaction-export.js")).runReactionExport(env, ctx)
          ],
          ["email queue drain", () => jobs.drainEmailQueue(env, ctx)]
        ];
        for (const [label, run] of steps) {
          try {
            await run();
          } catch (err) {
            console.error(`cron: ${label} failed:`, err && (err.stack || err.message));
          }
        }
      })()
    );
  }
};

/**
 * A `[[durable_objects.bindings]]` entry is only valid when the Worker's `main`
 * module exports the binding's `class_name`. These two lines are what make
 * GIFT_CARD_LEDGER and RATE_LIMIT_COUNTER in wrangler.toml legal -- remove
 * either one and `wrangler deploy` fails outright.
 */
export { GiftCardLedger } from "./state/gift-card-ledger.js";
export { RateLimitCounter } from "./state/rate-limit.js";

export {
  isTaxEnabled,
  loadCatalog,
  loadEvents,
  findEntry,
  pickupLabelFor,
  findPickupEvent,
  resolvePickupAddress,
  normalizeVariantLabel,
  findVariantOption,
  hasVariantOptions,
  validateGiftRecipientEmail,
  resolveFreeGiftThresholdCents,
  FREE_GIFT_LINE_NAME,
  resolveBundlePriceDollars,
  resolveUnitAmountCents,
  resolveGiftCardAmountCents,
  resolveCustomBoxCents,
  resolveFreeShippingThresholdCents,
  isQualifying2ozSalve,
  itemMatchesVolumeRule,
  getVolumePricingRules
};
