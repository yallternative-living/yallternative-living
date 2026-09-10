/**
 * @fileoverview POST /api/square-webhook -- the market register and the site
 * sell off one shelf.
 *
 * THE GAP THIS CLOSES
 * The shop sells online through Stripe and in person through Square, at
 * markets and pop-ups (assets/data/events.json). The inventory ledger
 * (workers/state/inventory.js) counted online sales down and heard nothing
 * about the register, so a Saturday's market sales left the site overselling
 * until someone recounted by hand. This route makes the register a second
 * writer to the same ledger and makes the ledger the register's source of
 * truth for what is left.
 *
 * INBOUND -- a sale at the register
 *   Square -> `payment.updated` (status COMPLETED) -> the order's line items
 *   -> each item's SKU -> a product id (workers/state/square-sync.js
 *   resolveSku) -> deductOnHand. Keyed on the Square ORDER, so a split
 *   tender's two payments and any redelivery move the shelf once. A full
 *   refund (`refund.updated`, COMPLETED, for the whole payment) puts exactly
 *   what was taken back; a partial refund is about the money, not the goods,
 *   and moves nothing -- the same reading routes/inventory.js gives Stripe.
 *
 * OUTBOUND -- what the register is allowed to sell
 *   After any move of the shelf (an online order paid, expired or refunded; a
 *   register sale applied; the owner's hourly correction), the live
 *   `available` count of every mapped product is written to Square as a
 *   PHYSICAL_COUNT for each of its variations, so the register shows the
 *   same "3 left" the site does. Only rows whose count moved are written.
 *
 * WHAT IS NOT DONE
 *   Square's own `inventory.count.updated` is NOT subscribed to. Two systems
 *   both adjusting each other on every change is a loop; here the site's
 *   ledger is authoritative and Square is written TO. Square-side stock
 *   edits are overwritten within the hour. That is the intended behaviour,
 *   and the docs say so: correct a count in the CMS, not in Square.
 *
 * SIGNATURE, AND WHY THERE IS NO TIMESTAMP TOLERANCE
 *   Square signs `notification_url + raw body` with HMAC-SHA256 and sends it
 *   base64 in `x-square-hmacsha256-signature`. The URL is the one registered
 *   in the Square Developer Dashboard -- the SITE's URL behind the Netlify
 *   `/api/*` proxy, not the Worker's own -- so it comes from configuration
 *   (`SQUARE_WEBHOOK_NOTIFICATION_URL`, defaulting to
 *   `${SITE_ORIGIN}/api/square-webhook`), never from `request.url`. Unlike
 *   Stripe, Square does NOT re-sign a retry with a fresh timestamp: a retry
 *   carries the original body and `created_at`, so a five-minute tolerance
 *   would reject every legitimate retry. Replay is defeated by the event-id
 *   claim instead: a replayed event finds its id already claimed and does
 *   nothing.
 *
 * NO `Square-Version` HEADER, ON PURPOSE
 *   Square pins API behaviour per application in the Developer Dashboard; an
 *   unrecognised version string in the header is a 400. Omitting the header
 *   uses the application's configured version, which is the one the owner's
 *   Square account was set up against. The fields read below are the stable
 *   ones (order line items, payment status and money, refund status and
 *   money, catalog variation SKUs, inventory physical counts).
 *
 * CONFIGURATION -- three secrets and one var, all optional
 *   SQUARE_WEBHOOK_SIGNATURE_KEY  secret; without it the route answers 404 and
 *                                 the Worker has no Square surface at all
 *   SQUARE_ACCESS_TOKEN           secret; reads orders, payments and the
 *                                 catalogue, writes inventory counts. Without
 *                                 it a verified webhook is acknowledged and
 *                                 logged but cannot be applied (the line items
 *                                 live on the order, which needs the API)
 *   SQUARE_LOCATION_ID            var; the location counts are pushed to.
 *                                 Without it inbound works and outbound is off
 *   SQUARE_ENVIRONMENT            var; "sandbox" for the Square sandbox, else
 *                                 production
 *   Plus the CMS kill switch `site.enableSquareSync` (Site settings -> Shop ->
 *   "Sync stock with Square"): off, verified events are acknowledged and
 *   ignored, and nothing is pushed.
 */

import { json } from "./http.js";
import { ensureSchema } from "../state/migrations.js";
import { loadProductIndex, loadSiteSettings } from "../state/site-data.js";
import { claimEvent, markEventDone, releaseEvent } from "../state/webhook-events.js";
import { alertOwner } from "./alerts.js";
import {
  addOnHand,
  deductOnHand,
  readAvailability,
  syncInventory,
  trackedProductsOf
} from "../state/inventory.js";
import {
  catalogRows,
  claimSquareSale,
  expandLine,
  mappedRows,
  markPushed,
  mergeLines,
  releaseSquareSale,
  resolveSku,
  restockSquareSale,
  upsertCatalogRows
} from "../state/square-sync.js";

export const SIGNATURE_HEADER = "x-square-hmacsha256-signature";

/** One marker for every log line from this file, so an outage is one grep. */
export const LOG_MARKER = "[SQUARE]";

/** How long one Square API call may take before it is given up on. */
export const SQUARE_TIMEOUT_MS = 8000;

/** Square accepts at most this many inventory changes per batch call. */
const PUSH_CHUNK = 100;

/** Catalogue listing pages read per reconcile before giving up (2000 objects). */
const MAX_CATALOG_PAGES = 20;

/**
 * The event types the handler acts on; everything else is acknowledged and
 * ignored. Cash is not a special case anywhere here: a cash sale at the
 * register is an order with a COMPLETED payment whose `source_type` is CASH,
 * and it arrives through exactly the same event as a card. `order.updated`
 * is subscribed as well for the sale that has NO payment at all -- a
 * giveaway or a 100% comp rung up at the table -- which still completes the
 * order. A normal sale fires both; the per-order claim makes the second a
 * no-op.
 */
export const PAYMENT_EVENTS = ["payment.updated", "payment.created"];
export const ORDER_EVENTS = ["order.updated"];
export const REFUND_EVENTS = ["refund.updated", "refund.created"];

/* ----------------------------------------------------------- configuration */

/** The Worker has a Square surface only when the signature key is set. */
export function isSquareConfigured(env) {
  return Boolean(env && env.SQUARE_WEBHOOK_SIGNATURE_KEY);
}

/** The API can be called (reads and count pushes) only with a token. */
export function canCallSquare(env) {
  return Boolean(env && env.SQUARE_ACCESS_TOKEN);
}

/** Counts can be pushed only to a location. */
export function canPushCounts(env) {
  return canCallSquare(env) && Boolean(env.SQUARE_LOCATION_ID);
}

export function squareApiBase(env) {
  const mode = String((env && env.SQUARE_ENVIRONMENT) || "production").toLowerCase();
  return mode === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

/** The URL Square signs: the registered notification URL, never request.url. */
export function notificationUrl(env) {
  if (env && typeof env.SQUARE_WEBHOOK_NOTIFICATION_URL === "string") {
    const explicit = env.SQUARE_WEBHOOK_NOTIFICATION_URL.trim();
    if (explicit) return explicit;
  }
  const origin = (env && env.SITE_ORIGIN) || "https://yallternativeliving.com";
  return `${origin.replace(/\/+$/, "")}/api/square-webhook`;
}

/**
 * The CMS kill switch. Fails OPEN to "enabled": a content.json that cannot be
 * read must not stop market sales from counting down.
 */
export async function squareSyncEnabled(env, ctx) {
  let site = {};
  try {
    site = await loadSiteSettings(env, ctx);
  } catch {
    site = {};
  }
  return !site || site.enableSquareSync !== false;
}

/* --------------------------------------------------------------- signature */

function base64ToBytes(b64) {
  if (typeof b64 !== "string" || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Verify Square's signature and return the parsed event.
 *
 * Throws (never returns false) so the caller cannot treat a refusal as a
 * pass, and the caller must NOT echo the reason -- which of "missing",
 * "malformed" or "wrong" it was is an oracle for probing the check.
 * WebCrypto's `subtle.verify` does the constant-time comparison.
 */
export async function verifySquareSignature(rawBody, signatureHeader, key, url) {
  if (!signatureHeader) throw new Error(`Missing ${SIGNATURE_HEADER} header`);
  if (!key) throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEY is not configured");
  if (!url) throw new Error("No notification URL to verify against");
  const provided = base64ToBytes(String(signatureHeader).trim());
  if (!provided) throw new Error("Malformed Square signature header");

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    provided,
    encoder.encode(`${url}${rawBody}`)
  );
  if (!ok) throw new Error("Signature mismatch");
  return JSON.parse(rawBody);
}

/** A Square event id is a UUID; the claim table wants `[A-Za-z0-9_]`. */
export function claimKeyFor(eventId) {
  return `sq_${String(eventId).replace(/[^A-Za-z0-9_]/g, "")}`;
}

/* ------------------------------------------------------------- Square API */

/**
 * One call to Square. Bearer token, JSON both ways, a timeout, and an Error
 * whose message names the call and Square's first error detail on a non-2xx
 * -- that message goes to the log and the owner alert, never to a client.
 */
export async function squareFetch(env, path, { method = "GET", body } = {}) {
  if (!canCallSquare(env)) throw new Error("SQUARE_ACCESS_TOKEN is not configured");
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    init.signal = AbortSignal.timeout(SQUARE_TIMEOUT_MS);
  }
  const res = await fetch(`${squareApiBase(env)}${path}`, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res || !res.ok) {
    const first = data && Array.isArray(data.errors) && data.errors[0];
    const detail = first
      ? [first.category, first.code, first.detail].filter(Boolean).join(" ")
      : "";
    throw new Error(
      `Square ${method} ${path} -> ${res ? res.status : "no response"}${detail ? `: ${detail}` : ""}`
    );
  }
  return data || {};
}

export async function fetchOrder(env, orderId) {
  const data = await squareFetch(env, `/v2/orders/${encodeURIComponent(orderId)}`);
  return (data && data.order) || null;
}

export async function fetchPayment(env, paymentId) {
  const data = await squareFetch(env, `/v2/payments/${encodeURIComponent(paymentId)}`);
  return (data && data.payment) || null;
}

/** `[{variationId, sku, itemName, variationName}]` for the given variation ids. */
export async function retrieveVariations(env, variationIds) {
  const ids = [...new Set((variationIds || []).filter((id) => typeof id === "string" && id))];
  if (!ids.length) return [];
  const data = await squareFetch(env, "/v2/catalog/batch-retrieve", {
    method: "POST",
    body: { object_ids: ids, include_related_objects: true }
  });
  const itemNames = new Map();
  for (const obj of (data && data.related_objects) || []) {
    if (obj && obj.type === "ITEM" && obj.item_data) itemNames.set(obj.id, obj.item_data.name);
  }
  return variationRows((data && data.objects) || [], itemNames);
}

/** Every ITEM_VARIATION in the register's catalogue, paged. */
export async function listVariations(env) {
  const items = new Map();
  const variations = [];
  let cursor = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await squareFetch(env, `/v2/catalog/list?types=ITEM,ITEM_VARIATION${query}`);
    for (const obj of (data && data.objects) || []) {
      if (!obj) continue;
      if (obj.type === "ITEM" && obj.item_data) items.set(obj.id, obj.item_data.name);
      else if (obj.type === "ITEM_VARIATION") variations.push(obj);
    }
    cursor = data && typeof data.cursor === "string" && data.cursor ? data.cursor : null;
    if (!cursor) break;
  }
  return variationRows(variations, items);
}

function variationRows(objects, itemNames) {
  const out = [];
  for (const obj of objects || []) {
    if (!obj || obj.type !== "ITEM_VARIATION" || typeof obj.id !== "string") continue;
    const v = obj.item_variation_data || {};
    out.push({
      variationId: obj.id,
      sku: typeof v.sku === "string" ? v.sku : null,
      itemName: (itemNames && itemNames.get(v.item_id)) || null,
      variationName: typeof v.name === "string" ? v.name : null
    });
  }
  return out;
}

/**
 * Seeds an inventory row for every product the catalogue tracks, exactly as
 * GET /api/inventory does before it reads (routes/inventory.js): a product
 * given a Stock count since the last sale would otherwise have no row and be
 * skipped as untracked. Returns the index it read so callers read it once.
 */
async function seedLedger(env, ctx, now, index = null) {
  const idx = index || (await loadProductIndex(env, ctx));
  if (idx.size) await syncInventory(env.STATE_DB, trackedProductsOf(idx.values()), now);
  return idx;
}

/* ---------------------------------------------------------- inbound: sales */

/**
 * The order's item lines as `[{variationId, qty, name, variationName}]`.
 * Square quantities are decimal strings ("2", "1.5"); a shelf counts whole
 * units, so the quantity is floored and a line below one unit is dropped.
 * Lines with no catalog object (a custom amount typed at the register) have
 * nothing to map to and are dropped as well -- there is no product to count.
 */
export function linesFromOrder(order) {
  const out = [];
  for (const li of (order && order.line_items) || []) {
    if (!li || typeof li.catalog_object_id !== "string") continue;
    const qty = Math.floor(Number(li.quantity));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      variationId: li.catalog_object_id,
      qty,
      name: typeof li.name === "string" ? li.name : "",
      variationName: typeof li.variation_name === "string" ? li.variation_name : ""
    });
  }
  return out;
}

/**
 * Turns the order's variation ids into ledger lines. The square_catalog
 * table answers first; variations it has never seen are fetched from Square
 * (one batch call), resolved through the SKU rule, and recorded either way
 * so the next sale of the same item costs no API call.
 *
 * `unmapped` is what the owner gets emailed about; `mapped` is what the
 * ledger deducts. Throws only when the catalogue could not be consulted at
 * all for an unknown item -- the transient case, worth a Square retry.
 */
export async function resolveLines(env, db, index, lines) {
  const ids = [...new Set(lines.map((l) => l.variationId))];
  const known = await catalogRows(db, ids);
  const unknownIds = ids.filter((id) => !known.has(id));
  if (unknownIds.length) {
    const fetched = await retrieveVariations(env, unknownIds);
    const rows = [];
    for (const v of fetched) {
      const resolved = resolveSku(v.sku, index);
      rows.push({ ...v, productId: resolved ? resolved.id : null });
    }
    // An id Square itself did not return (deleted from the catalogue between
    // the sale and now) is recorded as unmapped so it is not fetched again.
    for (const id of unknownIds) {
      if (!fetched.some((v) => v.variationId === id)) {
        rows.push({
          variationId: id,
          sku: null,
          itemName: null,
          variationName: null,
          productId: null
        });
      }
    }
    await upsertCatalogRows(db, rows);
    for (const r of rows) {
      known.set(r.variationId, { ...r, lastPushedCount: null, lastPushedAt: null });
    }
  }
  const mapped = [];
  const unmapped = [];
  for (const line of lines) {
    const row = known.get(line.variationId);
    if (row && row.productId) {
      const entry = index.get(row.productId);
      const kind =
        entry && Array.isArray(entry.productIds) && entry.productIds.length ? "bundle" : "product";
      mapped.push(...expandLine({ id: row.productId, kind }, line.qty, index));
    } else {
      unmapped.push({
        variationId: line.variationId,
        sku: row ? row.sku : null,
        name: [line.name, line.variationName].filter(Boolean).join(" -- ") || line.variationId,
        qty: line.qty
      });
    }
  }
  return { mapped: mergeLines(mapped), unmapped };
}

function alertUnmapped(env, ctx, unmapped, orderId) {
  for (const item of unmapped) {
    alertOwner(env, ctx, {
      key: `square-unmapped:${item.variationId}`,
      subject: `Sold at the register but not matched to the site: "${item.name}"`,
      details: {
        "square item": item.name,
        "square sku": item.sku || "(none)",
        "square order": orderId,
        sold: item.qty,
        "what happens": "the site's stock count for it was NOT reduced by this sale",
        next:
          "In the Square Dashboard set this item's SKU to the product's id from the CMS " +
          "(e.g. lavender-soak), or add the SKU under the product's 'Square SKUs' field in /admin. " +
          "Then adjust the Stock count by hand for the units already sold."
      }
    });
  }
}

function alertShortfall(env, ctx, applied, orderId) {
  for (const a of applied) {
    if (a.short <= 0) continue;
    alertOwner(env, ctx, {
      key: `square-short:${a.productId}`,
      subject: `The register sold ${a.short} more "${a.productId}" than the site had`,
      details: {
        product: a.productId,
        "sold at register": a.qty,
        "taken off the site's count": a.deducted,
        "could not be taken": a.short,
        "square order": orderId,
        "what happens":
          "the site now shows this product as Sold Out (or as held by an open online checkout)",
        next: "Recount the shelf and set the Stock count in /admin to what is actually there."
      }
    });
  }
}

/**
 * The register sold something: count it off the shelf, once per order.
 *
 * @returns {Promise<object>} the outcome, for the log and for tests
 */
export async function applySquareOrder(env, ctx, order, now = Date.now()) {
  const db = env.STATE_DB;
  if (!order || typeof order.id !== "string") return { skipped: "no-order" };
  const lines = linesFromOrder(order);
  if (!lines.length) return { orderId: order.id, skipped: "no-item-lines" };

  const index = await loadProductIndex(env, ctx);
  if (!index.size) {
    // Nothing to resolve against. Transient (the site is unreachable): throw so
    // the claim is not taken and Square redelivers.
    throw new Error("products.json is unreachable; cannot map the register's items");
  }
  await seedLedger(env, ctx, now, index);
  const { mapped, unmapped } = await resolveLines(env, db, index, lines);

  const claimed = await claimSquareSale(db, order.id, mapped, order.location_id || null, now);
  if (!claimed) return { orderId: order.id, duplicate: true };

  let out;
  try {
    out = await deductOnHand(db, mapped, now);
  } catch (err) {
    await releaseSquareSale(db, order.id).catch(() => {});
    throw err;
  }
  console.log(
    `${LOG_MARKER} order ${order.id}: deducted ${JSON.stringify(out.applied)}` +
      (unmapped.length ? `; unmapped ${unmapped.map((u) => u.name).join(", ")}` : "")
  );
  if (unmapped.length) alertUnmapped(env, ctx, unmapped, order.id);
  alertShortfall(env, ctx, out.applied, order.id);
  if (out.soldOut.length) {
    const { announceSoldOut } = await import("./inventory.js");
    announceSoldOut(env, ctx, out.soldOut, `square order ${order.id}`);
  }
  pushCountsForProducts(
    env,
    ctx,
    out.applied.map((a) => a.productId)
  );
  return { orderId: order.id, ...out, unmapped };
}

async function handlePaymentEvent(event, env, ctx) {
  const payment = event.data && event.data.object && event.data.object.payment;
  if (!payment || typeof payment !== "object") return { skipped: "no-payment" };
  if (payment.status !== "COMPLETED") return { skipped: `payment ${payment.status || "unknown"}` };
  if (typeof payment.order_id !== "string" || !payment.order_id) return { skipped: "no-order-id" };
  if (!canCallSquare(env)) {
    console.error(
      `${LOG_MARKER} payment ${payment.id} completed for order ${payment.order_id} but ` +
        "SQUARE_ACCESS_TOKEN is not set, so the order's items cannot be read; nothing deducted"
    );
    return { skipped: "no-access-token", orderId: payment.order_id };
  }
  const order = await fetchOrder(env, payment.order_id);
  if (!order) return { skipped: "order-not-found", orderId: payment.order_id };
  return applySquareOrder(env, ctx, order);
}

/**
 * `order.updated` carries a summary (`data.object.order_updated`), not the
 * order: the state and the id. COMPLETED is the only state that means "sold";
 * OPEN is a ticket still being rung up and CANCELED never was a sale.
 */
async function handleOrderEvent(event, env, ctx) {
  const summary =
    event.data && event.data.object && (event.data.object.order_updated || event.data.object.order);
  if (!summary || typeof summary !== "object") return { skipped: "no-order-summary" };
  if (summary.state !== "COMPLETED") return { skipped: `order ${summary.state || "unknown"}` };
  const orderId = typeof summary.order_id === "string" ? summary.order_id : summary.id;
  if (typeof orderId !== "string" || !orderId) return { skipped: "no-order-id" };
  if (!canCallSquare(env)) {
    console.error(
      `${LOG_MARKER} order ${orderId} completed but SQUARE_ACCESS_TOKEN is not set, so its ` +
        "items cannot be read; nothing deducted"
    );
    return { skipped: "no-access-token", orderId };
  }
  const order = await fetchOrder(env, orderId);
  if (!order) return { skipped: "order-not-found", orderId };
  return applySquareOrder(env, ctx, order);
}

/* -------------------------------------------------------- inbound: refunds */

/**
 * A refund is "full" when the payment has now been refunded for at least
 * what it was charged. The payment is re-read rather than trusting the
 * refund's own amount alone, because two partial refunds that add up to the
 * whole are a full refund too -- and `refunded_money` on the payment is the
 * running total.
 */
export function isFullRefund(payment, refund) {
  const charged = Number(payment && payment.amount_money && payment.amount_money.amount);
  if (!Number.isFinite(charged) || charged <= 0) return false;
  const running = Number(payment && payment.refunded_money && payment.refunded_money.amount);
  const thisOne = Number(refund && refund.amount_money && refund.amount_money.amount);
  const refunded = Number.isFinite(running) ? running : Number.isFinite(thisOne) ? thisOne : 0;
  return refunded >= charged;
}

async function handleRefundEvent(event, env, ctx) {
  const refund = event.data && event.data.object && event.data.object.refund;
  if (!refund || typeof refund !== "object") return { skipped: "no-refund" };
  if (refund.status !== "COMPLETED") return { skipped: `refund ${refund.status || "unknown"}` };
  if (typeof refund.payment_id !== "string" || !refund.payment_id) {
    return { skipped: "no-payment-id" };
  }
  if (!canCallSquare(env)) return { skipped: "no-access-token" };
  const payment = await fetchPayment(env, refund.payment_id);
  if (!payment) return { skipped: "payment-not-found" };
  const orderId = typeof refund.order_id === "string" ? refund.order_id : payment.order_id;
  if (typeof orderId !== "string" || !orderId) return { skipped: "no-order-id" };
  if (!isFullRefund(payment, refund)) return { orderId, partialRefund: true, returned: [] };

  const lines = await restockSquareSale(env.STATE_DB, orderId);
  if (!lines.length) return { orderId, alreadyRestocked: true, returned: [] };
  await seedLedger(env, ctx, Date.now());
  const out = await addOnHand(env.STATE_DB, lines);
  console.log(`${LOG_MARKER} order ${orderId} refunded in full: returned ${JSON.stringify(lines)}`);
  pushCountsForProducts(
    env,
    ctx,
    out.returned.map((l) => l.productId)
  );
  return { orderId, ...out };
}

/* --------------------------------------------------------------- dispatch */

export async function processSquareEvent(event, env, ctx) {
  const type = event && event.type;
  if (PAYMENT_EVENTS.includes(type)) return handlePaymentEvent(event, env, ctx);
  if (ORDER_EVENTS.includes(type)) return handleOrderEvent(event, env, ctx);
  if (REFUND_EVENTS.includes(type)) return handleRefundEvent(event, env, ctx);
  return { ignored: type };
}

/**
 * POST /api/square-webhook.
 *
 *   404  no SQUARE_WEBHOOK_SIGNATURE_KEY -- the Worker has no Square surface
 *   503  no STATE_DB -- nowhere to record a claim, so nothing can be applied
 *   400  "Invalid signature", one fixed string for every refusal
 *   200  {received:true} / {received:true, duplicate:true} / {received:true,
 *        disabled:true} when the CMS switch is off
 *   500  a handler threw after the claim; the claim is released, the owner
 *        is emailed, and Square retries
 */
export async function handleSquareWebhook(request, env, origin, ctx) {
  if (!isSquareConfigured(env)) {
    return json({ error: "Not Found" }, 404, origin, env);
  }
  if (!env.STATE_DB) {
    console.error(`${LOG_MARKER} STATE_DB binding is missing; cannot record Square sales`);
    return json({ received: false, error: "state_unavailable" }, 503, origin, env);
  }

  const rawBody = await request.text();
  let event;
  try {
    event = await verifySquareSignature(
      rawBody,
      request.headers.get(SIGNATURE_HEADER),
      env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      notificationUrl(env)
    );
  } catch (err) {
    console.error(`${LOG_MARKER} signature verification failed:`, err && err.message);
    return json({ error: "Invalid signature" }, 400, origin, env);
  }
  if (!event || typeof event.event_id !== "string" || !event.event_id) {
    return json({ error: "Invalid signature" }, 400, origin, env);
  }

  if (!(await squareSyncEnabled(env, ctx))) {
    return json({ received: true, disabled: true }, 200, origin, env);
  }

  const claimKey = claimKeyFor(event.event_id);
  let claimed = false;
  try {
    await ensureSchema(env.STATE_DB);
    claimed = await claimEvent(env.STATE_DB, claimKey, `square:${event.type}`);
    if (!claimed) return json({ received: true, duplicate: true }, 200, origin, env);

    const outcome = await processSquareEvent(event, env, ctx);
    await markEventDone(env.STATE_DB, claimKey);
    return json({ received: true, outcome }, 200, origin, env);
  } catch (err) {
    console.error(`${LOG_MARKER} processing error:`, err && (err.stack || err.message));
    const object = (event.data && event.data.object) || {};
    const payment = object.payment || {};
    const refund = object.refund || {};
    alertOwner(env, ctx, {
      key: `square-webhook:${event.type}`,
      subject: `Square webhook "${event.type}" failed`,
      details: {
        "event id": event.event_id,
        "square order": payment.order_id || refund.order_id || "",
        "square payment": payment.id || refund.payment_id || "",
        error: err && err.message,
        "what happens": "Square retries this event; if the cause is fixed nothing more is needed"
      }
    });
    if (claimed) {
      try {
        await releaseEvent(env.STATE_DB, claimKey);
      } catch (releaseErr) {
        console.error(
          `${LOG_MARKER} could not release the claim:`,
          releaseErr && releaseErr.message
        );
      }
    }
    return json({ received: false, error: "processing_failed" }, 500, origin, env);
  }
}

/* ------------------------------------------------------- outbound: counts */

/**
 * Writes the live `available` count of the given products (all mapped
 * products when `productIds` is null) to Square as PHYSICAL_COUNTs, one per
 * mapped variation, skipping rows whose count has not moved since the last
 * push. Never throws: the shelf is right whether or not the register heard,
 * and a failure is one owner alert per six hours.
 *
 * Fire-and-forget from the hooks; awaited by the cron and by tests.
 *
 * @returns {Promise<{pushed: number, skipped?: string}>}
 */
export function pushCountsForProducts(env, ctx, productIds, now = Date.now()) {
  const work = pushCounts(env, ctx, productIds, now).catch((err) => {
    console.error(`${LOG_MARKER} push failed:`, err && (err.stack || err.message));
    alertOwner(env, ctx, {
      key: "square-push",
      subject: "Could not write stock counts to Square",
      details: {
        error: err && err.message,
        "what happens":
          "the site's count is still right; the register may show stale numbers until the next hourly push succeeds"
      }
    });
    return { pushed: 0, skipped: "threw" };
  });
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
  } catch {
    // A ctx that refuses the promise still gets the detached work above.
  }
  return work;
}

async function pushCounts(env, ctx, productIds, now) {
  if (!canPushCounts(env)) return { pushed: 0, skipped: "not-configured" };
  if (!env.STATE_DB) return { pushed: 0, skipped: "no-state-db" };
  if (Array.isArray(productIds) && !productIds.length) return { pushed: 0, skipped: "nothing" };
  if (!(await squareSyncEnabled(env, ctx))) return { pushed: 0, skipped: "disabled" };
  await ensureSchema(env.STATE_DB);
  const rows = await mappedRows(env.STATE_DB, Array.isArray(productIds) ? productIds : null);
  if (!rows.length) return { pushed: 0, skipped: "no-mapped-variations" };
  await seedLedger(env, ctx, now);
  const availability = await readAvailability(env.STATE_DB, [
    ...new Set(rows.map((r) => r.productId))
  ]);
  const changes = [];
  for (const row of rows) {
    const avail = availability.get(row.productId);
    if (!avail) continue; // untracked on the site: the register keeps its own count
    if (row.lastPushedCount === avail.available) continue;
    changes.push({ variationId: row.variationId, count: avail.available });
  }
  if (!changes.length) return { pushed: 0, skipped: "unchanged" };
  const occurredAt = new Date(now).toISOString();
  for (let i = 0; i < changes.length; i += PUSH_CHUNK) {
    const chunk = changes.slice(i, i + PUSH_CHUNK);
    await squareFetch(env, "/v2/inventory/changes/batch-create", {
      method: "POST",
      body: {
        idempotency_key: crypto.randomUUID(),
        changes: chunk.map((c) => ({
          type: "PHYSICAL_COUNT",
          physical_count: {
            catalog_object_id: c.variationId,
            state: "IN_STOCK",
            location_id: env.SQUARE_LOCATION_ID,
            quantity: String(c.count),
            occurred_at: occurredAt
          }
        }))
      }
    });
    await markPushed(env.STATE_DB, chunk, now);
  }
  console.log(`${LOG_MARKER} pushed ${changes.length} count(s) to Square`);
  return { pushed: changes.length };
}

/* ------------------------------------------------------------------- cron */

/**
 * The hourly step (checkout.js `scheduled`): re-read the register's
 * catalogue so a SKU the owner fixes in Square takes effect within the hour,
 * then push every mapped product whose count moved. A no-op without
 * SQUARE_ACCESS_TOKEN; the catalogue refresh alone without a location.
 */
export async function runSquareReconcile(env, ctx, now = Date.now()) {
  if (!canCallSquare(env) || !env.STATE_DB) return { skipped: "not-configured" };
  if (!(await squareSyncEnabled(env, ctx))) return { skipped: "disabled" };
  await ensureSchema(env.STATE_DB);
  const index = await loadProductIndex(env, ctx);
  let refreshed = 0;
  if (index.size) {
    const variations = await listVariations(env);
    const rows = variations.map((v) => {
      const resolved = resolveSku(v.sku, index);
      return { ...v, productId: resolved ? resolved.id : null };
    });
    refreshed = await upsertCatalogRows(env.STATE_DB, rows, now);
  }
  const push = await pushCounts(env, ctx, null, now);
  return { refreshed, ...push };
}
