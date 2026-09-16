import { json, ClientError } from "./http.js";
import { stripePost } from "./stripe.js";
import { emailForHash } from "../state/orders.js";

/**
 * Simple password-based check for the admin endpoint.
 * Expects Authorization: Bearer <ADMIN_PASSWORD>
 */
function verifyAdminAuth(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token === env.ADMIN_PASSWORD;
}

/**
 * GET /api/unfulfilled-orders
 * Returns a JSON array of all orders currently marked as 'processing'
 * in the D1 orders table, joined with their original emails.
 */
export async function handleUnfulfilledOrders(request, env, origin) {
  if (!verifyAdminAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401, origin, env);
  }
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
 */
export async function handleFulfillOrder(request, env, origin) {
  if (!verifyAdminAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401, origin, env);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Stripe not configured" }, 503, origin, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new ClientError("Invalid JSON");
  }

  if (!body.payment_intent) throw new ClientError("Missing payment_intent");

  const status = String(body.status || "shipped").toLowerCase().trim();
  const trackingUrl = String(body.tracking_url || "").trim();
  const shippedAt = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const params = new URLSearchParams();
  params.append("metadata[fulfillment_status]", status);
  if (trackingUrl) params.append("metadata[tracking_url]", trackingUrl);
  params.append("metadata[shipped_at]", shippedAt);

  const updated = await stripePost(env, `/payment_intents/${body.payment_intent}`, params);

  if (!updated) {
    // stripePost internally logs the error
    return json({ error: "Failed to update Stripe PaymentIntent" }, 500, origin, env);
  }

  return json({ success: true }, 200, origin, env);
}
