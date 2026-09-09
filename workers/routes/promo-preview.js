/**
 * @fileoverview POST /api/promo-preview -- does this code work, and for how much?
 *
 * Before this route a promo code was invisible in the cart: cart.js sent
 * `discount_code`, checkout.js wrote it to session metadata and turned on
 * Stripe's own code box, and the shopper found out whether the code did
 * anything on Stripe's page -- after the drawer had already shown them a
 * total that did not include it. The drawer now asks here first, shows the
 * estimated discount and the adjusted total, and checkout.js (which imports
 * the same lookup and the same verdict) attaches the code to the session
 * itself so the number on Stripe's page is the number the drawer promised.
 *
 * WHAT IS LOOKED UP. Promotion codes only (Stripe Dashboard: Products ->
 * Coupons -> a coupon -> Promotion codes), matched on the customer-facing
 * string, active ones only. The percent-off or amount-off behind the code is
 * its coupon's. The estimate is computed over the SAME priced line items
 * checkout.js builds (`priceCart`, passed in by the router rather than
 * imported, so this file and checkout.js never import each other) -- never a
 * second implementation of the shop's pricing.
 *
 * WHAT IS SAID. Every miss answers HTTP 200 with `{ valid: false, reason }`
 * and a sentence written here; Stripe's own text and the coupon/promotion ids
 * never reach the browser. The reasons are a closed set the drawer maps to
 * its dictionary and reports to analytics as a class, so nothing the shopper
 * typed rides along. The one status that is not 200 is the limiter's 429,
 * which -- as on /gift-card-balance -- is not a verdict on the code.
 *
 * ONE DISCOUNT PER SESSION. Stripe Checkout takes a single `discounts` entry,
 * and a redeemed gift card already occupies it (an ephemeral amount_off
 * coupon, see checkout.js). A promo code and a gift card are therefore one
 * or the other; the drawer says so, and checkout.js answers a structured
 * `promo.reason: "gift_card_conflict"` if a client sends both anyway.
 */

import { json, readJson, clientIp, ClientError, clientErrorBody } from "./http.js";
import { stripeGet } from "./stripe.js";
import { isGiftCardCode } from "./gift-cards.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { loadSiteSettings } from "../state/site-data.js";

/** Lookups per client per minute. Fails open: a limiter that cannot count
 *  must not hide a working code. */
export const PROMO_PREVIEW_RATE_LIMIT = { limit: 5, period: 60 };

/** Stripe allows longer, but nothing the shop will ever hand out is. */
export const PROMO_CODE_MAX_LEN = 40;
const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;

/**
 * Shopper-facing copy for every verdict, keyed by reason. The drawer prefers
 * its own dictionary entry for the reason (so the sentence translates) and
 * falls back to this text.
 */
export const PROMO_COPY = {
  malformed: "Codes are letters and numbers only, up to 40 characters.",
  gift_card: "That looks like a gift card -- enter it in the gift card box instead.",
  disabled: "Promo codes aren't available right now.",
  rate_limited: "Too many attempts, try again in a minute.",
  unavailable: "Codes can't be checked right now. Try again in a moment.",
  unknown: "That code isn't valid.",
  expired: "That code has expired or has already been used.",
  minimum_not_met: "This code needs a subtotal of at least {amount}.",
  not_applicable: "That code doesn't apply to anything in this cart.",
  gift_card_conflict: "Promo codes and gift cards can't be combined. Remove one to continue.",
  rejected: "That code couldn't be applied to this order."
};

/**
 * Upper-case the code and drop the spacing a paste can carry. Returns "" for
 * anything that is not a plausible code, so the caller answers `malformed`
 * without spending a lookup or a limiter slot on it.
 */
export function normalizePromoCode(raw) {
  if (typeof raw !== "string") return "";
  const code = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F\s]/g, "")
    .toUpperCase();
  if (!code || code.length > PROMO_CODE_MAX_LEN || !PROMO_CODE_RE.test(code)) return "";
  return code;
}

function formatCents(cents) {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** The copy for a reason, with `{amount}` filled in where the reason has one. */
export function copyFor(reason, vars) {
  const text = PROMO_COPY[reason] || PROMO_COPY.unknown;
  return text.replace(/\{amount\}/g, vars && vars.amount ? vars.amount : "");
}

function miss(reason, extra) {
  return { valid: false, reason, error: copyFor(reason, extra), ...(extra || {}) };
}

/**
 * The coupon behind a promotion code, whichever shape this Stripe API version
 * returns it in: the historical top-level `coupon`, or `promotion.coupon`
 * (the nesting createPromotionCode writes on 2026-06-24.dahlia). Either may
 * be an expanded object or a bare id.
 */
function couponFieldOf(promotionCode) {
  if (!promotionCode) return null;
  if (promotionCode.coupon) return promotionCode.coupon;
  if (promotionCode.promotion && promotionCode.promotion.coupon) {
    return promotionCode.promotion.coupon;
  }
  return null;
}

/**
 * Look a customer-facing code up in Stripe.
 *
 * @returns {Promise<object|null|undefined>} the promotion code with its
 *   coupon expanded to an object; `undefined` when no active code has that
 *   string; `null` when Stripe could not be asked (the caller must not turn
 *   that into "not valid").
 */
export async function findPromotionCode(env, code) {
  const clean = normalizePromoCode(code);
  if (!clean) return undefined;
  const list = await stripeGet(
    env,
    `/promotion_codes?code=${encodeURIComponent(clean)}&active=true&limit=1`
  );
  if (!list || !Array.isArray(list.data)) return null;
  const found = list.data.find(
    (pc) => pc && typeof pc.code === "string" && pc.code.toUpperCase() === clean
  );
  if (!found) return undefined;
  let coupon = couponFieldOf(found);
  if (typeof coupon === "string") {
    coupon = await stripeGet(env, `/coupons/${encodeURIComponent(coupon)}`);
    if (!coupon) return null;
  }
  return { ...found, coupon: coupon && typeof coupon === "object" ? coupon : null };
}

function exhausted(maxRedemptions, timesRedeemed) {
  const max = Number(maxRedemptions);
  return Number.isFinite(max) && max > 0 && Number(timesRedeemed) >= max;
}

/**
 * What a promotion code (as returned by findPromotionCode) is worth against a
 * goods subtotal, or why it is not.
 *
 * Mirrors what Stripe will enforce when the session is created, so the
 * drawer's estimate and Stripe's page agree: active and unexpired on both the
 * code and its coupon, redemptions left on both, the minimum-amount
 * restriction met, US dollars, and a coupon that applies to the whole order
 * -- the shop's line items are ad-hoc `price_data`, so a coupon limited to
 * specific Stripe products can never match one and is reported as not
 * applicable rather than as a $0 discount.
 *
 * @param {object} promotionCode
 * @param {number} subtotalCents goods subtotal Stripe discounts (never shipping)
 * @param {number} [now] epoch ms, for tests
 */
export function evaluatePromotion(promotionCode, subtotalCents, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const pc = promotionCode || {};
  const coupon = pc.coupon && typeof pc.coupon === "object" ? pc.coupon : null;
  const subtotal = Math.max(0, Math.round(Number(subtotalCents) || 0));

  if (!coupon || pc.active === false || coupon.valid === false) return miss("expired");
  if (Number(pc.expires_at) > 0 && Number(pc.expires_at) * 1000 <= at) return miss("expired");
  if (Number(coupon.redeem_by) > 0 && Number(coupon.redeem_by) * 1000 <= at) {
    return miss("expired");
  }
  if (exhausted(pc.max_redemptions, pc.times_redeemed)) return miss("expired");
  if (exhausted(coupon.max_redemptions, coupon.times_redeemed)) return miss("expired");

  const appliesTo = coupon.applies_to && coupon.applies_to.products;
  if (Array.isArray(appliesTo) && appliesTo.length) return miss("not_applicable");

  const percentOff = Number(coupon.percent_off);
  const amountOff = Number(coupon.amount_off);
  let kind = null;
  if (Number.isFinite(percentOff) && percentOff > 0) kind = "percent";
  else if (Number.isFinite(amountOff) && amountOff > 0) kind = "amount";
  if (!kind) return miss("not_applicable");
  if (kind === "amount" && coupon.currency && String(coupon.currency).toLowerCase() !== "usd") {
    return miss("not_applicable");
  }

  const restrictions = pc.restrictions || {};
  const minimum = Number(restrictions.minimum_amount);
  const minimumCents = Number.isFinite(minimum) && minimum > 0 ? Math.round(minimum) : 0;
  if (minimumCents > 0) {
    const minCurrency = String(restrictions.minimum_amount_currency || "usd").toLowerCase();
    if (minCurrency !== "usd") return miss("not_applicable");
    if (subtotal < minimumCents) {
      return miss("minimum_not_met", {
        minimumAmountCents: minimumCents,
        amount: formatCents(minimumCents)
      });
    }
  }

  const estimated =
    kind === "percent"
      ? Math.min(subtotal, Math.round((subtotal * Math.min(percentOff, 100)) / 100))
      : Math.min(subtotal, Math.round(amountOff));

  return {
    valid: true,
    code: String(pc.code || "").toUpperCase(),
    kind,
    percentOff: kind === "percent" ? percentOff : null,
    amountOffCents: kind === "amount" ? Math.round(amountOff) : null,
    minimumAmountCents: minimumCents,
    restrictions: { firstTimeOnly: restrictions.first_time_transaction === true },
    estimatedDiscountCents: estimated,
    subtotalCents: subtotal
  };
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {string} origin
 * @param {object} ctx
 * @param {{loadCatalog: Function, priceCart: Function}} deps checkout.js's own
 *   catalog loader and pricer, handed in by the router (see the file header).
 */
export async function handlePromoPreview(request, env, origin, ctx, deps) {
  let body;
  try {
    body = await readJson(request, "Please enter a promo code.");
  } catch (err) {
    if (err instanceof ClientError) return json(clientErrorBody(err), 400, origin, env);
    throw err;
  }

  // Shape first, so a malformed guess costs no lookup and no limiter slot.
  const rawCode = typeof body.code === "string" ? body.code : "";
  if (isGiftCardCode(rawCode)) return json(miss("gift_card"), 200, origin, env);
  const code = normalizePromoCode(rawCode);
  if (!code) return json(miss("malformed"), 200, origin, env);

  const site = await loadSiteSettings(env, ctx);
  if (site.enablePromoCodes === false) return json(miss("disabled"), 200, origin, env);

  const limit = await checkRateLimit(env, `promo-preview:${clientIp(request)}`, {
    ...PROMO_PREVIEW_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) return json(miss("rate_limited"), 429, origin, env);

  if (!env.STRIPE_SECRET_KEY) {
    console.error("promo-preview: STRIPE_SECRET_KEY is missing");
    return json(miss("unavailable"), 200, origin, env);
  }

  // The estimate is over the goods exactly as checkout will send them. A cart
  // checkout would refuse is refused here with checkout's own sentence -- the
  // drawer already knows how to show those.
  let priced;
  try {
    const catalog = await deps.loadCatalog(env, ctx);
    priced = deps.priceCart(catalog, Array.isArray(body.items) ? body.items : []);
  } catch (err) {
    if (err instanceof ClientError) {
      return json({ valid: false, reason: "cart_invalid", error: err.message }, 200, origin, env);
    }
    console.error("promo-preview: pricing the cart failed:", err && err.stack ? err.stack : err);
    return json(miss("unavailable"), 200, origin, env);
  }

  const found = await findPromotionCode(env, code);
  if (found === null) return json(miss("unavailable"), 200, origin, env);
  if (!found) return json(miss("unknown"), 200, origin, env);

  return json(evaluatePromotion(found, priced.subtotalCents), 200, origin, env);
}
