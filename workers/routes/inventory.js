/**
 * @fileoverview GET /api/inventory, plus the thin hooks checkout.js and
 * stripe-webhook.js call into the inventory ledger (workers/state/inventory.js).
 *
 * THE ROUTE
 * `{ products: { id: { available, tracked: true } } }` for tracked products
 * only -- a product with no `stock` count in the CMS is simply absent, and the
 * shop keeps rendering it from the static catalog. `Cache-Control: no-store`
 * (every JSON answer from this Worker is; routes/http.js), rate-limited per IP
 * like the other public routes, and 503 without STATE_DB. The shop
 * (assets/js/main.js) fetches it once per page load and, when it answers,
 * lets the live count override the static `stock` for badges and sold-out
 * state; when it does not answer, the static rendering stands.
 *
 * THE HOOKS -- and why every one of them fails OPEN
 * Checkout and the webhook are the money path. A D1 outage must degrade this
 * shop to what it was before the ledger existed (the static `stock` cap), not
 * take checkout offline, so each hook catches everything the ledger throws,
 * logs it under one greppable marker, and answers as though the ledger were
 * not there. The one thing that is NOT swallowed is a refusal for want of
 * stock: that is the answer the hook exists to give.
 *
 * ZERO-STOCK OWNER ALERT
 * When a commit takes a product to zero, `announceSoldOut` logs it under
 * INVENTORY_SOLD_OUT and emails the shop through routes/alerts.js's
 * alertOwner (deduped per product for six hours).
 */

import { json, clientIp } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { ensureSchema } from "../state/migrations.js";
import { loadProductIndex } from "../state/site-data.js";
import { deleteCoupon, expireSession, findSessionByPaymentIntent } from "./stripe.js";
import { alertOwner } from "./alerts.js";
import {
  InventoryError,
  availableCounts,
  commitInventory,
  inventorySnapshot,
  releaseInventory,
  reserveInventory,
  restockInventory,
  syncInventory,
  trackedProductsOf
} from "../state/inventory.js";

/** Lookups per client per minute. The shop asks once per page load. */
export const INVENTORY_RATE_LIMIT = { limit: 30, period: 60 };

/** One marker for every log line from this file, so an outage is one grep. */
export const LOG_MARKER = "[INVENTORY]";
/** The zero-stock alert's own marker -- the line the owner alert is built on. */
export const SOLD_OUT_MARKER = "[INVENTORY_SOLD_OUT]";

function warnFailOpen(step, err) {
  console.error(
    `${LOG_MARKER} ${step} failed; falling back to the static stock in products.json:`,
    err && (err.stack || err.message || err)
  );
}

/* ------------------------------------------------------------------ route */

export async function handleInventory(request, env, origin, ctx) {
  if (!env.STATE_DB) {
    return json({ error: "Live stock is unavailable." }, 503, origin, env);
  }
  const limit = await checkRateLimit(env, `inventory:${clientIp(request)}`, {
    ...INVENTORY_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json({ error: "Too many requests. Please wait a minute." }, 429, origin, env);
  }
  const index = await loadProductIndex(env, ctx);
  if (!index.size) {
    return json({ error: "Live stock is unavailable." }, 503, origin, env);
  }
  await ensureSchema(env.STATE_DB);
  const snapshot = await inventorySnapshot(env.STATE_DB, trackedProductsOf(index.values()));
  return json(snapshot, 200, origin, env);
}

/* --------------------------------------------------------- checkout hooks */

/**
 * `Map<productId, available>` for allocateStock, from the ledger -- or null
 * when the ledger cannot answer, in which case allocateStock uses the
 * catalog's own `stock` exactly as it did before the ledger existed.
 */
export async function availabilityForCheckout(env, catalog) {
  if (!env.STATE_DB) return null;
  try {
    const tracked = trackedProductsOf(catalog && catalog.products);
    if (!tracked.length) return new Map();
    await ensureSchema(env.STATE_DB);
    await syncInventory(env.STATE_DB, tracked, Date.now(), catalog && catalog.fetchedAt);
    return await availableCounts(
      env.STATE_DB,
      tracked.map((p) => p.id)
    );
  } catch (err) {
    warnFailOpen("reading availability", err);
    return null;
  }
}

/**
 * Sums allocateStock's per-line holds into one hold per product, keeping the
 * first cart line that touches each product so a refusal can name it back to
 * the drawer.
 *
 * @param {Array} items the cart lines as the client sent them
 * @param {Array<{qty: number, holds: Array<{productId: string, name: string, units: number}>}>} allocation
 * @returns {Array<{productId: string, name: string, qty: number, lineId: string, viaBox: boolean}>}
 */
export function holdsFromAllocation(items, allocation, customBoxId) {
  const byProduct = new Map();
  (allocation || []).forEach((line, idx) => {
    if (!line || !(line.qty > 0) || !Array.isArray(line.holds)) return;
    const item = items[idx] || {};
    const lineId = String(item.id);
    for (const hold of line.holds) {
      const qty = line.qty * hold.units;
      if (!(qty > 0)) continue;
      const prior = byProduct.get(hold.productId);
      if (prior) {
        prior.qty += qty;
      } else {
        byProduct.set(hold.productId, {
          productId: hold.productId,
          name: hold.name || hold.productId,
          qty,
          lineId,
          viaBox: lineId === customBoxId
        });
      }
    }
  });
  return [...byProduct.values()];
}

/**
 * Holds the tracked units of a cart against the Stripe session that now
 * exists. `{ ok: true }` when held (or when there is nothing tracked to hold,
 * or when the ledger is down -- fail open, logged); `{ ok: false, refusal,
 * name }` when another session took the last units first, with `refusal` in
 * the `unavailableDetails` shape the drawer already knows how to drop.
 */
export async function reserveForCheckout(env, sessionId, holds) {
  if (!env.STATE_DB || !Array.isArray(holds) || !holds.length) return { ok: true, held: [] };
  try {
    const out = await reserveInventory(env.STATE_DB, sessionId, holds);
    return { ok: true, held: out.holds };
  } catch (err) {
    if (err instanceof InventoryError && err.code === "insufficient_stock") {
      const hold = holds.find((h) => h.productId === err.productId) || holds[0];
      const refusal = hold.viaBox
        ? { id: hold.lineId, reason: "member_unavailable", member: hold.productId }
        : { id: hold.lineId, reason: "sold_out" };
      return { ok: false, refusal, name: hold.name, productId: hold.productId };
    }
    warnFailOpen(`reserving for ${sessionId}`, err);
    return { ok: true, held: [], failedOpen: true };
  }
}

/**
 * The session was created and then refused (the last unit went to someone
 * else): make it unpayable. The coupon, if one was minted, goes first and is
 * never re-minted; expiry is tried twice, like the gift-card unwind in
 * checkout.js, and a session that still will not expire is logged at error
 * level with its id so it can be expired by hand.
 */
export async function unwindRefusedSession(env, sessionId, couponId) {
  let couponDeleted = !couponId;
  if (couponId) {
    try {
      couponDeleted = await deleteCoupon(env, couponId);
    } catch (err) {
      console.error(`${LOG_MARKER} unwind: deleting coupon ${couponId} threw:`, err);
    }
  }
  let expired = false;
  for (let attempt = 1; attempt <= 2 && !expired; attempt++) {
    try {
      expired = await expireSession(env, sessionId);
    } catch (err) {
      console.error(
        `${LOG_MARKER} unwind: expiring session ${sessionId} threw (attempt ${attempt}):`,
        err
      );
    }
  }
  if (!expired || !couponDeleted) {
    console.error(
      `${LOG_MARKER} unwind incomplete for session ${sessionId}: ` +
        `coupon ${couponId || "(none)"} ${couponDeleted ? "deleted" : "NOT deleted"}, ` +
        `session ${expired ? "expired" : "NOT expired after 2 attempts"}. ` +
        `Expire the session in the Stripe Dashboard so it cannot be paid.`
    );
  }
  return { expired, couponDeleted };
}

/* ---------------------------------------------------------- webhook hooks */

/**
 * The zero-stock owner alert. Always the log line; then the owner email via
 * alertOwner (routes/alerts.js), keyed per product so the six-hour dedupe
 * window is per sell-out, not per order. Fire-and-forget: alertOwner never
 * rejects, so a mail outage cannot make Stripe replay the order.
 */
export function announceSoldOut(env, ctx, productIds, sessionId) {
  if (!Array.isArray(productIds) || !productIds.length) return;
  console.error(
    `${SOLD_OUT_MARKER} sold out by order ${sessionId}: ${productIds.join(", ")}. ` +
      `Set a new Stock count in the CMS to restock, or leave it at 0 to keep it Sold Out.`
  );
  for (const productId of productIds) {
    alertOwner(env, ctx, {
      key: `inventory-sold-out:${productId}`,
      subject: `Sold out: ${productId} -- the last unit just sold`,
      details: {
        product: productId,
        session: sessionId,
        next: "Set a new Stock count in the CMS to restock, or leave it at 0 to keep it Sold Out."
      }
    });
  }
}

/** checkout.session.completed (paid): the held units leave the shelf. */
export async function commitInventoryForSession(session, env, ctx) {
  if (!env.STATE_DB || !session || !session.id) return { skipped: "no-state-db" };
  await ensureSchema(env.STATE_DB);
  const out = await commitInventory(env.STATE_DB, session.id);
  if (out.soldOut.length) announceSoldOut(env, ctx || null, out.soldOut, session.id);
  return out;
}

/** checkout.session.expired / async_payment_failed: the held units go back on sale. */
export async function releaseInventoryForSession(session, env, reason) {
  if (!env.STATE_DB || !session || !session.id) return { skipped: "no-state-db" };
  await ensureSchema(env.STATE_DB);
  const out = await releaseInventory(env.STATE_DB, session.id);
  return { ...out, reason: reason || "session_expired" };
}

/**
 * charge.refunded, in FULL: the order's units go back on the shelf. A partial
 * refund is an instruction about the cash, not the goods (the same reading
 * the gift-card restore takes), so it moves nothing.
 */
export async function restockInventoryForRefund(charge, env) {
  if (!env.STATE_DB) return { skipped: "no-state-db" };
  const refundedCents = Number(charge && charge.amount_refunded) || 0;
  const chargedCents = Number(charge && charge.amount);
  const fullyRefunded =
    (charge && charge.refunded === true) ||
    (Number.isFinite(chargedCents) && refundedCents > 0 && refundedCents >= chargedCents);
  if (!fullyRefunded) return { restocked: [], partialRefund: true };
  const paymentIntentId =
    charge.payment_intent && typeof charge.payment_intent === "object"
      ? charge.payment_intent.id
      : charge.payment_intent;
  if (!paymentIntentId) return { restocked: [], reason: "no-payment-intent" };
  const session = await findSessionByPaymentIntent(env, paymentIntentId);
  if (!session || !session.id) return { restocked: [], reason: "no-session" };
  await ensureSchema(env.STATE_DB);
  return restockInventory(env.STATE_DB, session.id);
}
