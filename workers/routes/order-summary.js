/**
 * @fileoverview POST /api/order-summary -- the settled totals of ONE paid
 * Checkout Session, for thank-you.html.
 *
 * Why it exists: the Worker builds success_url with `amount=` at the moment it
 * CREATES the session (checkout.js), i.e. before Stripe applies a promotion
 * code the shopper typed on the Stripe page. A shopper who used a promo code
 * therefore landed on a receipt showing the pre-discount figure. This route
 * lets the page replace that hint with what Stripe actually settled.
 *
 * Disclosure boundary -- read this before widening the payload. The router
 * lets requests with no Origin header through (Stripe's webhook needs that),
 * so anyone holding a `cs_...` id can call this. The id already sits in the
 * thank-you URL, browser history and proxy logs, so it is treated as a
 * low-value bearer token: this route answers with MONEY FIGURES ONLY --
 * subtotal, total, discount, gift-card portion, currency, status. Never the
 * shopper's email, name, address, line items, card details or gift-card code.
 * Anything richer needs the email check that /api/order-status does
 * (state/stripe-orders.js), which is why that route exists separately.
 *
 * Only a PAID, COMPLETE session is reported. A session the shopper abandoned
 * (`status: "open"`) or the Worker expired on ledger contention is `not_found`
 * -- indistinguishable from a bad id -- so the page can never paint a
 * "Verified Stripe Payment" total for money that was not taken.
 *
 * POST with `{sessionId}`, like every other route on this Worker: the id
 * travels in the body rather than a query string, so it does not depend on
 * the Netlify proxy forwarding query strings and does not land in the
 * proxy's URL log field.
 *
 * Rate-limited per client IP (fail-open like /api/order-status, and for the
 * same reason -- see state/rate-limit.js). Each call costs one Stripe read.
 */

import { json, readJson, clientIp } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { STRIPE_API_BASE, STRIPE_API_VERSION } from "./stripe.js";

export const ORDER_SUMMARY_RATE_LIMIT = { limit: 10, period: 60 };

const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{8,255}$/;

const NOT_FOUND_BODY = { found: false, error: "not_found" };

function centsOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export async function handleOrderSummary(request, env, origin) {
  const limit = await checkRateLimit(env, `order-summary:${clientIp(request)}`, {
    ...ORDER_SUMMARY_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json({ found: false, error: "rate_limited" }, 429, origin, env);
  }

  const body = await readJson(request, "Please provide a session ID.");
  const sessionId = String(body.sessionId || body.session_id || "").trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    return json({ found: false, error: "invalid_session_id" }, 400, origin, env);
  }

  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("order-summary: STRIPE_SECRET_KEY is not configured.");

  const doFetch = (env && env.fetchImpl) || fetch;
  const res = await doFetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION }
    }
  );

  if (!res || !res.ok) {
    // Unknown id is a 404 from Stripe; a malformed one a 400. Anything else
    // (rotated key, Stripe outage, rate limit) is an internal failure -- throw
    // so the router logs it and answers a generic 500, instead of telling the
    // shopper their order does not exist.
    if (res && (res.status === 404 || res.status === 400)) {
      return json(NOT_FOUND_BODY, 404, origin, env);
    }
    throw new Error(`order-summary: Stripe returned ${res ? res.status : "no response"}.`);
  }

  const session = await res.json();
  if (!session || session.error || session.id !== sessionId) {
    return json(NOT_FOUND_BODY, 404, origin, env);
  }

  const paid =
    session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!paid || session.status !== "complete") {
    return json(NOT_FOUND_BODY, 404, origin, env);
  }

  const totalDetails = session.total_details || {};
  const metadata = session.metadata || {};
  // The Worker records the gift-card portion of the discount on the session
  // (checkout.js, `gift_card_amount_applied_cents`) because Stripe folds the
  // gift-card coupon into `amount_discount` alongside any promo code. Exposing
  // the AMOUNT lets the page label it honestly; the code itself stays private.
  const giftCardApplied = Number.parseInt(metadata.gift_card_amount_applied_cents, 10);

  return json(
    {
      found: true,
      sessionId: session.id,
      status: session.status,
      paymentStatus: session.payment_status,
      amountTotalCents: centsOrNull(session.amount_total),
      amountSubtotalCents: centsOrNull(session.amount_subtotal),
      amountDiscountCents: centsOrNull(totalDetails.amount_discount) || 0,
      giftCardAppliedCents:
        Number.isFinite(giftCardApplied) && giftCardApplied > 0 ? giftCardApplied : 0,
      currency: typeof session.currency === "string" ? session.currency.slice(0, 8) : "usd"
    },
    200,
    origin,
    env
  );
}
