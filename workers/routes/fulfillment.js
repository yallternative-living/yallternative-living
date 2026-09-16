/**
 * @fileoverview The owner's fulfilment dashboard (admin/fulfillment.html):
 * list the orders still marked `processing` in D1, and push a shipped status
 * plus tracking link onto the Stripe PaymentIntent, exactly as typing it into
 * the Stripe Dashboard would. The hourly ship-notice sweep then emails the
 * customer and merges the status into D1 (routes/ship-notice.js).
 *
 * AUTH: one shared password (`ADMIN_PASSWORD`, a Worker Secret) sent as
 * `Authorization: Bearer <password>`. Two things protect that password:
 *
 *   - Every request to either route is rate-limited per client IP BEFORE the
 *     password is looked at (2026-09-16 audit: this was the only credentialed
 *     path in the Worker with no limiter, so a guess loop ran at line speed).
 *     The counter runs on every request, not only on failures, so a caller
 *     cannot dodge it by mixing in valid ones.
 *   - The compare is constant-time over SHA-256 digests, so neither the
 *     length of the secret nor the position of the first wrong byte leaks
 *     through response timing.
 *
 * With `ADMIN_PASSWORD` unset both routes answer 401 for every caller: an
 * unset secret must never mean "no password required".
 */

import { json, ClientError, clientIp, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { stripePost } from "./stripe.js";
import { emailForHash, mergeShipment } from "../state/orders.js";
import { SHIPPED_STATUSES } from "./ship-notice.js";
import { safeUrl } from "../state/stripe-orders.js";

/**
 * Attempts per client IP per minute across BOTH admin routes together. Five is
 * plenty for a human (one prompt, one list, a handful of "Mark Shipped"
 * clicks) and makes a brute-force of the password a non-starter. Fails OPEN
 * like every other limiter in the Worker: a counter that cannot count must not
 * lock the owner out of shipping.
 */
export const ADMIN_AUTH_RATE_LIMIT = { limit: 5, period: 60 };

/**
 * What the dashboard may write as `fulfillment_status`. The three shipped
 * words are the ones the ship-notice sweep and order-status.html understand;
 * `processing` is allowed too so an accidental "Mark Shipped" can be undone
 * from the same tool (the sweep ignores it, so it is written to D1 here
 * directly and the order reappears on the dashboard). Reverting does NOT
 * un-send a ship notice that already went out -- `order_emails` remembers it,
 * so shipping the same order again later sends no second email.
 */
export const FULFILLMENT_STATUSES = [...SHIPPED_STATUSES, "processing"];

/** Stripe PaymentIntent ids: `pi_` + alphanumerics. Anything else is not a path segment. */
const PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9]{1,255}$/;

/** Matches the `tracking_url` column budget in state/orders.js and safeUrl(). */
const TRACKING_URL_MAX = 500;

const encoder = new TextEncoder();

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Byte-for-byte compare that never exits early. Both inputs are 32-byte digests. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Password check for the admin routes. Expects `Authorization: Bearer <ADMIN_PASSWORD>`.
 * Fails closed when the secret is unset or the token is empty.
 * @returns {Promise<boolean>}
 */
async function verifyAdminAuth(request, env) {
  const secret = env && typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const [expected, provided] = await Promise.all([sha256(secret), sha256(token)]);
  return timingSafeEqual(expected, provided);
}

/** @returns {Promise<boolean>} true when this client has used up its attempts */
async function limited(request, env) {
  const result = await checkRateLimit(env, `admin-auth:${clientIp(request)}`, {
    ...ADMIN_AUTH_RATE_LIMIT,
    failOpen: true
  });
  return !result.success;
}

/**
 * The limiter, then the password. Returns a Response to send when the caller
 * is refused, or null when they may proceed.
 */
async function gate(request, env, origin) {
  if (await limited(request, env)) {
    return json(
      { error: "Too many attempts. Please wait a minute and try again." },
      429,
      origin,
      env
    );
  }
  if (!(await verifyAdminAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401, origin, env);
  }
  return null;
}

/**
 * GET /api/unfulfilled-orders
 * Returns a JSON array of all orders currently marked as 'processing'
 * in the D1 orders table, joined with their original emails.
 */
export async function handleUnfulfilledOrders(request, env, origin) {
  const refused = await gate(request, env, origin);
  if (refused) return refused;
  if (!env.STATE_DB) return json({ error: "No database available" }, 503, origin, env);

  const res = await env.STATE_DB.prepare(
    "SELECT session_id, payment_intent, email_hash, created, amount_total, currency, status, line_items_json FROM orders WHERE status = 'processing' ORDER BY created ASC"
  ).all();

  const orders = res && res.results ? res.results : [];

  // Resolve email addresses sequentially since this is an admin/internal endpoint
  for (const order of orders) {
    if (order.email_hash) {
      const email = await emailForHash(env.STATE_DB, order.email_hash);
      order.email = email || "(unknown)";
    }
  }

  return json({ orders }, 200, origin, env);
}

/**
 * POST /api/fulfill-order
 * Takes { payment_intent, tracking_url, status } and pushes it directly
 * to Stripe PaymentIntent metadata. This automatically triggers the ship-notice
 * hourly sweep and updates the order status in D1.
 *
 * Every field is validated before it goes anywhere near the Stripe path or
 * the metadata: the intent id must look like one (it is a URL segment), the
 * status must be one of FULFILLMENT_STATUSES, and a tracking link must be an
 * http(s) URL of at most 500 characters -- a bad one is refused with a 400
 * rather than silently dropped, so the owner notices before the customer does.
 */
export async function handleFulfillOrder(request, env, origin) {
  const refused = await gate(request, env, origin);
  if (refused) return refused;
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Stripe not configured" }, 503, origin, env);
  }

  const body = await readJson(request, "Invalid JSON");

  const paymentIntent = typeof body.payment_intent === "string" ? body.payment_intent.trim() : "";
  if (!paymentIntent) throw new ClientError("Missing payment_intent");
  if (!PAYMENT_INTENT_RE.test(paymentIntent)) {
    throw new ClientError("payment_intent is not a Stripe PaymentIntent id.");
  }

  const status = String(body.status || "shipped")
    .toLowerCase()
    .trim();
  if (!FULFILLMENT_STATUSES.includes(status)) {
    throw new ClientError(`status must be one of: ${FULFILLMENT_STATUSES.join(", ")}.`);
  }

  const rawTracking = body.tracking_url == null ? "" : String(body.tracking_url).trim();
  let trackingUrl = "";
  if (rawTracking) {
    if (rawTracking.length > TRACKING_URL_MAX) {
      throw new ClientError(`tracking_url must be at most ${TRACKING_URL_MAX} characters.`);
    }
    trackingUrl = safeUrl(rawTracking) || "";
    if (!trackingUrl) throw new ClientError("tracking_url must be an http(s) link.");
  }

  const shippedAt = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const reverting = status === "processing";

  const params = new URLSearchParams();
  params.append("metadata[fulfillment_status]", status);
  // Stripe deletes a metadata key given an empty value: a revert clears the
  // stale link and date, while a shipped save without a link leaves whatever
  // is already on the intent alone.
  if (trackingUrl || reverting) params.append("metadata[tracking_url]", trackingUrl);
  params.append("metadata[shipped_at]", reverting ? "" : shippedAt);

  const updated = await stripePost(
    env,
    `/payment_intents/${encodeURIComponent(paymentIntent)}`,
    params
  );

  if (!updated) {
    // stripePost internally logs the error
    return json({ error: "Failed to update Stripe PaymentIntent" }, 500, origin, env);
  }

  // The hourly sweep merges shipped statuses into D1 on its own; a revert to
  // `processing` it never looks at, so write that one straight away or the
  // order would never come back onto the dashboard. Best effort: Stripe is
  // the source of truth and already has it.
  if (reverting && env.STATE_DB) {
    try {
      await mergeShipment(env.STATE_DB, { paymentIntent, status, trackingUrl: null });
    } catch (err) {
      console.error("fulfill-order: D1 revert failed:", err && err.message ? err.message : err);
    }
  }

  return json({ success: true }, 200, origin, env);
}
