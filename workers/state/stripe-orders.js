/**
 * @fileoverview Real order lookup against Stripe, sanitised for public display.
 *
 * WHY
 * Audit H-6: `order-status.html` makes no request at all. Any email, any `cs_…`
 * string, any `YL-…` string renders "Order Confirmed, payment processed via
 * Stripe" over a hardcoded two-item order, complete with a printable packing
 * slip and a reorder button that puts the fabricated items in the real cart.
 * This module is the real lookup that page needs.
 *
 * NO LOCAL ORDER STORE
 * Stripe is the system of record for orders and stays that way. Copying orders
 * into D1 would double the number of places that can be wrong, and there is
 * nothing to reconcile against. The state layer only owns what Stripe cannot
 * hold for us: balances, event claims, points.
 *
 * AUTHORISATION
 * Knowing a session id is not authorisation -- ids appear in browser history,
 * shared links and referrer headers. The caller must also supply the email on
 * the order, compared case-insensitively against `customer_details.email`.
 * A mismatch returns exactly the same `{found: false, error: "not_found"}` as a
 * session that does not exist, so the endpoint cannot be used to test whether a
 * session id is real. Pair it with a per-IP rate limit in the caller
 * (checkRateLimit) -- a shared-secret check still allows guessing at speed.
 *
 * WHAT COMES BACK
 * Only what the customer already knows or is entitled to: status, total, line
 * item names and quantities, the shipping CITY and STATE (enough to confirm the
 * right address without reprinting the street), and the three fulfilment keys
 * the merchant writes on the PaymentIntent. Never the street address, never the
 * phone, never customer or payment-method ids, never gift-card codes, never raw
 * metadata.
 */

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Metadata keys the merchant sets on the PaymentIntent to drive the status page. */
export const FULFILMENT_KEYS = ["fulfillment_status", "tracking_url", "shipped_at"];

const NOT_FOUND = Object.freeze({ found: false, error: "not_found" });

function isSessionId(value) {
  return typeof value === "string" && /^cs_[A-Za-z0-9_]{8,255}$/.test(value);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Only http(s) links are echoed back; a `javascript:` tracking_url would be an
 * XSS gift. Exported because routes/ship-notice.js mails the same value the
 * status page renders, and the two must agree on what counts as a usable link.
 */
export function safeUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function trimText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/**
 * Shipping moved to `collected_information.shipping_details` in recent Stripe API
 * versions; older sessions still carry the top-level `shipping_details`. Read both.
 */
function readShipping(session) {
  const collected =
    (session.collected_information && session.collected_information.shipping_details) || null;
  const details = collected || session.shipping_details || null;
  const address = (details && details.address) || null;
  if (!address) return null;
  return {
    city: trimText(address.city, 80),
    state: trimText(address.state, 40),
    country: trimText(address.country, 2)
  };
}

function readFulfilment(session) {
  const intent = session.payment_intent;
  const metadata = (intent && typeof intent === "object" && intent.metadata) || {};
  return {
    status: trimText(metadata.fulfillment_status, 40) || "processing",
    trackingUrl: safeUrl(metadata.tracking_url),
    shippedAt: trimText(metadata.shipped_at, 40)
  };
}

function readItems(session) {
  const data = (session.line_items && session.line_items.data) || [];
  return data.slice(0, 50).map((item) => ({
    name: trimText(item.description || (item.price && item.price.nickname) || "Item", 120),
    quantity: Number(item.quantity) || 1
  }));
}

/**
 * Retrieves one Checkout Session and returns a display-safe view of it.
 *
 * Costs exactly one Stripe request. Rate-limit the caller by IP.
 *
 * @param {object} env  needs `env.STRIPE_SECRET_KEY`
 * @param {{sessionId: string, email: string, fetchImpl?: Function}} args
 * @returns {Promise<object>} `{found: false, error: "not_found"}` for an unknown
 *   session OR an email mismatch (deliberately indistinguishable), or
 *   `{found: true, sessionId, status, paymentStatus, amountTotalCents, currency,
 *     placedAt, items, shipTo, fulfilment}`.
 */
export async function lookupOrder(env, args) {
  const params = args || {};
  const sessionId = params.sessionId;
  const email = normalizeEmail(params.email);
  const doFetch = params.fetchImpl || (env && env.fetchImpl) || fetch;

  if (!isSessionId(sessionId) || !email.includes("@")) return { ...NOT_FOUND };
  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe-orders: STRIPE_SECRET_KEY is not configured.");

  const url =
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}` +
    "?expand[]=line_items&expand[]=payment_intent";
  const res = await doFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION }
  });

  if (!res || !res.ok) {
    if (res && (res.status === 404 || res.status === 400)) return { ...NOT_FOUND };
    throw new Error(`stripe-orders: Stripe returned ${res ? res.status : "no response"}.`);
  }

  const session = await res.json();
  if (!session || session.error || session.id !== sessionId) return { ...NOT_FOUND };

  const onFile = normalizeEmail(
    (session.customer_details && session.customer_details.email) || session.customer_email
  );
  if (!onFile || onFile !== email) return { ...NOT_FOUND };

  return {
    found: true,
    sessionId: session.id,
    status: trimText(session.status, 40),
    paymentStatus: trimText(session.payment_status, 40),
    amountTotalCents: Number(session.amount_total) || 0,
    currency: trimText(session.currency, 8) || "usd",
    placedAt: Number(session.created) || null,
    items: readItems(session),
    shipTo: readShipping(session),
    fulfilment: readFulfilment(session)
  };
}
