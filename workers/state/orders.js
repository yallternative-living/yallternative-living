/**
 * @fileoverview D1 access for the customer-facing order history (`orders`).
 *
 * WHY A COPY, WHEN STRIPE IS THE SYSTEM OF RECORD
 * /api/order-status answers one order at a time, from Stripe, and needs the
 * `cs_...` reference AND the address for every lookup -- a good privacy
 * posture for a single order, and useless for "what have I bought here?".
 * Stripe has no cheap "every session for this email" query either (it is a
 * paged list of Customers, then Sessions per Customer, and the Worker does
 * not create a Customer per order). So the webhook writes one row per paid
 * session here, in the shape the page needs, and the page reads only this.
 * `order_signals` already held a row per order for the email sequence but
 * carries no quantities, unit prices, total, status or tracking, which is
 * why this is a new table rather than three more columns on that one.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * `email_hash` (SHA-256 of the normalised address, retention.js hashEmail),
 * the session id, the PaymentIntent id, when it was placed, the settled total
 * and currency, a status word, a tracking link and a JSON list of lines:
 * `{name, quantity, unitCents, productId, variant, kind}`. Never the address
 * itself, never a name, never the street, never a gift message.
 *
 * NO SWEEPER, ON PURPOSE. Every other table in workers/state/ is swept
 * because it is operational state; this one is the customer's history, and a
 * history that forgets after 90 days is a bug report waiting to happen.
 *
 * Every write is INSERT OR IGNORE on the primary key (a redelivered webhook
 * writes nothing) or a conditional UPDATE that only spends a write when the
 * value actually changed (the hourly ship-notice sweep sees the same parcel
 * every pass for 45 days).
 */

import { hashEmail, normalizeEmail } from "./retention.js";

/** The page shows at most this many orders, newest first. */
export const MAX_ORDERS_LISTED = 25;

/** Line items are capped per order so a row can never grow past D1's limits. */
const MAX_LINES = 50;

/** Line kinds the cart can put straight back in the drawer. */
export const REORDERABLE_KINDS = ["product", "bundle"];

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function whole(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * Normalises a line for storage. Accepts either the Worker's own shape
 * (`{name, quantity, unitCents, productId, variant, kind}`) or a raw Stripe
 * line item (`description`, `quantity`, `price.unit_amount`, and the
 * `price.product.metadata` the checkout wrote -- `yl_product_id`,
 * `yl_variant`, `yl_kind`).
 *
 * @returns {Array<{name: string, quantity: number, unitCents: number,
 *   productId: string, variant: string, kind: string}>}
 */
export function normalizeLineItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_LINES).map((item) => {
    const raw = item || {};
    const price = raw.price && typeof raw.price === "object" ? raw.price : {};
    const product = price.product && typeof price.product === "object" ? price.product : {};
    const meta = (product.metadata && typeof product.metadata === "object" && product.metadata) || {};
    const qty = whole(raw.quantity, 1);
    const unit = Number.isFinite(Number(raw.unitCents))
      ? whole(raw.unitCents)
      : Number.isFinite(Number(price.unit_amount))
        ? whole(price.unit_amount)
        : Number.isFinite(Number(raw.amount_subtotal)) && qty > 0
          ? Math.round(Number(raw.amount_subtotal) / qty)
          : 0;
    return {
      name: text(raw.name || raw.description || (price.nickname ?? ""), 160) || "Item",
      quantity: qty > 0 ? qty : 1,
      unitCents: unit,
      productId: text(raw.productId || meta.yl_product_id, 80),
      variant: text(raw.variant || meta.yl_variant, 80),
      kind: text(raw.kind || meta.yl_kind, 24) || "product"
    };
  });
}

/**
 * One row per paid Checkout Session. Idempotent on the session id.
 *
 * @param {object} db D1 binding
 * @param {{sessionId: string, email: string, paymentIntent?: string,
 *   created?: number, amountTotal: number, currency?: string, status?: string,
 *   items: Array, trackingUrl?: string}} args `created` in epoch MILLISECONDS
 * @returns {Promise<{recorded: boolean, emailHash: string}>}
 */
export async function recordOrderRow(db, args, now = Date.now()) {
  const params = args || {};
  const sessionId = String(params.sessionId || "").trim();
  if (!/^cs_[A-Za-z0-9_]{1,255}$/.test(sessionId)) {
    throw new TypeError("orders: sessionId must be a Stripe Checkout Session id.");
  }
  const emailHash = await hashEmail(normalizeEmail(params.email));
  const lines = normalizeLineItems(params.items);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO orders
         (session_id, email_hash, payment_intent, created, amount_total, currency, status,
          line_items_json, tracking_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      emailHash,
      text(params.paymentIntent, 255) || null,
      whole(params.created, now) || now,
      whole(params.amountTotal),
      (text(params.currency, 8) || "usd").toLowerCase(),
      text(params.status, 40) || "processing",
      JSON.stringify(lines),
      text(params.trackingUrl, 500) || null,
      now
    )
    .run();
  return { recorded: (res && res.meta && res.meta.changes) === 1, emailHash };
}

/**
 * Folds the owner's fulfilment edit into the row, keyed on the PaymentIntent
 * the edit was made on. Costs a write only when something changed, so the
 * hourly sweep's repeat visits to the same parcel are free.
 *
 * @returns {Promise<boolean>} true when a row was updated
 */
export async function mergeShipment(db, args, now = Date.now()) {
  const params = args || {};
  const intent = text(params.paymentIntent, 255);
  if (!intent) return false;
  const status = text(params.status, 40).trim().toLowerCase() || "shipped";
  const trackingUrl = text(params.trackingUrl, 500) || null;
  const res = await db
    .prepare(
      `UPDATE orders SET status = ?, tracking_url = ?, updated_at = ?
        WHERE payment_intent = ? AND (status IS NOT ? OR tracking_url IS NOT ?)`
    )
    .bind(status, trackingUrl, now, intent, status, trackingUrl)
    .run();
  return (res && res.meta && res.meta.changes) >= 1;
}

/** @returns {Promise<boolean>} does at least one order exist for this hash? */
export async function hasOrders(db, emailHash) {
  const row = await db
    .prepare("SELECT 1 AS hit FROM orders WHERE email_hash = ? LIMIT 1")
    .bind(String(emailHash || ""))
    .first();
  return Boolean(row);
}

/**
 * The customer's orders, newest first, in the shape /orders.html renders.
 *
 * @param {object} db D1 binding
 * @param {string} emailHash
 * @param {number} [limit] 1..MAX_ORDERS_LISTED
 * @returns {Promise<object[]>}
 */
export async function listOrders(db, emailHash, limit = MAX_ORDERS_LISTED) {
  const cap = Math.min(Math.max(Number(limit) || MAX_ORDERS_LISTED, 1), MAX_ORDERS_LISTED);
  const res = await db
    .prepare(
      `SELECT session_id, created, amount_total, currency, status, line_items_json, tracking_url
         FROM orders WHERE email_hash = ? ORDER BY created DESC, session_id DESC LIMIT ?`
    )
    .bind(String(emailHash || ""), cap)
    .all();
  return ((res && res.results) || []).map((row) => {
    let items = [];
    try {
      items = normalizeLineItems(JSON.parse(row.line_items_json || "[]"));
    } catch {
      items = [];
    }
    return {
      sessionId: row.session_id,
      placedAt: Math.floor(Number(row.created) / 1000) || null,
      amountTotalCents: whole(row.amount_total),
      currency: row.currency || "usd",
      status: row.status || "processing",
      trackingUrl: row.tracking_url || null,
      items: items.map((line) => ({
        ...line,
        reorderable: REORDERABLE_KINDS.includes(line.kind) && Boolean(line.productId)
      }))
    };
  });
}

/**
 * The address behind a hash, for the one thing that needs it (the points
 * balance, whose ledger is keyed by email). Read from `order_signals`, which
 * the retention layer already keeps for the email sequence -- so this module
 * never has to store the address itself.
 *
 * @returns {Promise<string|null>}
 */
export async function emailForHash(db, emailHash) {
  const row = await db
    .prepare("SELECT email FROM order_signals WHERE email_hash = ? ORDER BY placed_at DESC LIMIT 1")
    .bind(String(emailHash || ""))
    .first();
  return (row && row.email) || null;
}
