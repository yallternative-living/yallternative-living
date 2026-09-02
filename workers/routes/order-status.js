/**
 * @fileoverview POST /api/order-status -- the real lookup behind
 * order-status.html.
 *
 * Audit H-6: that page made no request at all. Any email, any `cs_…` string,
 * any `YL-…` string rendered "Order Confirmed, payment processed via Stripe"
 * over a hardcoded two-item order, complete with a printable packing slip and a
 * reorder button that put the fabricated items in the real cart.
 *
 * AUTHORISATION. Knowing a session id is not authorisation -- ids sit in
 * browser history, shared links and Referer headers -- so the caller must also
 * supply the email on the order. A wrong email and a session that does not
 * exist return the SAME `404 {found:false}`, so this cannot be used to test
 * whether a `cs_…` is real. Rate-limited at 5/minute per IP on top, because a
 * shared-secret check still allows guessing at speed.
 *
 * WHAT IT WILL NOT SAY. Status, payment status, total, line names and
 * quantities, the shipping CITY and STATE, and the three fulfilment keys the
 * merchant writes on the PaymentIntent. Never the street address, never the
 * phone, never the email back, never customer or payment-method ids, never
 * gift-card codes, never raw metadata -- everything here is something the
 * person who placed the order already knows.
 */

import { json, readJson, clientIp } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { lookupOrder } from "../state/stripe-orders.js";

export const ORDER_STATUS_RATE_LIMIT = { limit: 5, period: 60 };

const NOT_FOUND_BODY = {
  found: false,
  error: "not_found"
};

export async function handleOrderStatus(request, env, origin) {
  const limit = await checkRateLimit(env, `order-status:${clientIp(request)}`, {
    ...ORDER_STATUS_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json(
      {
        found: false,
        error: "rate_limited",
        message: "Too many lookups. Please try again in a minute."
      },
      429,
      origin,
      env
    );
  }

  const body = await readJson(request, "Please enter your order number and email.");
  const order = await lookupOrder(env, {
    sessionId: body.sessionId || body.session_id,
    email: body.email
  });

  if (!order || !order.found) {
    return json({ ...NOT_FOUND_BODY }, 404, origin, env);
  }

  const shipTo = order.shipTo || null;
  return json(
    {
      found: true,
      sessionId: order.sessionId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      // Cents, as Stripe reports it. `amountTotalCents` is the same number
      // under the name the state layer documents; both are sent so neither the
      // page nor a future caller has to guess at the unit.
      amountTotal: order.amountTotalCents,
      amountTotalCents: order.amountTotalCents,
      currency: order.currency,
      placedAt: order.placedAt,
      items: order.items,
      shipping: shipTo ? { city: shipTo.city, state: shipTo.state } : null,
      fulfillment: {
        status: order.fulfilment.status,
        trackingUrl: order.fulfilment.trackingUrl,
        shippedAt: order.fulfilment.shippedAt
      }
    },
    200,
    origin,
    env
  );
}
