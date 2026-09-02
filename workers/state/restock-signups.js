/**
 * @fileoverview `restock_signups` -- "tell me when it's back", stored.
 *
 * POST /api/restock used to do one thing: email the owner that somebody asked.
 * That put the shopper's address in a mailbox and nowhere else, so the only way
 * anyone was ever told a product had returned was the owner remembering to go
 * back through months of notification mail. This table is the other half: the
 * hourly cron reads it, sees which of those products are in stock again, and
 * writes to the shopper directly (workers/routes/restock.js).
 *
 * Shape notes, all of them load-bearing:
 *   - `UNIQUE (product_id, email)` plus `INSERT OR IGNORE` means a second
 *     signup for the same product is a NO-OP, not an error and not a second
 *     email. Someone who taps the button twice gets told the same thing twice
 *     and hears from us once.
 *   - `notified_at` is the done-flag. It is set AFTER the send returns ok, so a
 *     Resend failure is retried on the next tick instead of being lost, and it
 *     is set for a SUPPRESSED address too -- an unsubscribed shopper must not
 *     be reconsidered every hour forever.
 *   - Reads are served by `restock_signups_pending (product_id, notified_at)`;
 *     rows read is the metered resource on the D1 free plan, so nothing here
 *     scans the table.
 *
 * The address is stored in the clear because an email cannot be sent to a hash.
 * It is never logged: the alert job logs product ids and counts only.
 */

import { normalizeEmail } from "./loyalty.js";

/**
 * How many signup rows one cron tick may handle. A restock on a popular item
 * drains over a few hourly ticks rather than firing hundreds of sends at once
 * (Resend rate limits, and a bad template should not reach the whole list
 * before anyone notices).
 */
export const RESTOCK_BATCH_LIMIT = 50;

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function assertProductId(value) {
  const id = String(value === null || value === undefined ? "" : value).trim();
  if (!id || id.length > 200) {
    throw new TypeError("restock: productId must be a non-empty string.");
  }
  return id;
}

/**
 * Records one "tell me when it's back". Idempotent per (product, address).
 *
 * @param {object} db D1 binding
 * @param {{productId: string, email: string, id?: string}} args
 * @returns {Promise<{stored: boolean, duplicate: boolean}>} `stored` is false
 *   when the pair was already on file -- which is a success, not a failure.
 */
export async function addRestockSignup(db, args, now = Date.now()) {
  const params = args || {};
  const productId = assertProductId(params.productId);
  const email = normalizeEmail(params.email);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO restock_signups (id, product_id, email, created_at, notified_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .bind(String(params.id || randomId()), productId, email, Math.round(now))
    .run();
  const stored = (res && res.meta && res.meta.changes) === 1;
  return { stored, duplicate: !stored };
}

/**
 * Every product with at least one un-notified signup, and how many are waiting.
 * One grouped query per tick, so the job knows which products to look up in the
 * catalogue instead of asking about all nineteen.
 *
 * @returns {Promise<Array<{productId: string, waiting: number}>>}
 */
export async function pendingRestockCounts(db) {
  if (!db) return [];
  const res = await db
    .prepare(
      `SELECT product_id AS productId, COUNT(*) AS waiting
         FROM restock_signups
        WHERE notified_at IS NULL
        GROUP BY product_id
        ORDER BY waiting DESC`
    )
    .all();
  return ((res && res.results) || []).map((row) => ({
    productId: String(row.productId),
    waiting: Number(row.waiting) || 0
  }));
}

/** How many shoppers are waiting on one product. Used by the low-stock note. */
export async function pendingRestockCount(db, productId) {
  if (!db) return 0;
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS waiting FROM restock_signups WHERE product_id = ? AND notified_at IS NULL"
    )
    .bind(assertProductId(productId))
    .first();
  return (row && Number(row.waiting)) || 0;
}

/**
 * The oldest un-notified signups for one product, first come first served.
 *
 * @returns {Promise<Array<{id: string, email: string}>>}
 */
export async function pendingRestockSignups(db, productId, limit = RESTOCK_BATCH_LIMIT) {
  if (!db) return [];
  const cap = Math.min(Math.max(Number(limit) || 1, 1), RESTOCK_BATCH_LIMIT);
  const res = await db
    .prepare(
      `SELECT id, email
         FROM restock_signups
        WHERE product_id = ? AND notified_at IS NULL
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .bind(assertProductId(productId), cap)
    .all();
  return ((res && res.results) || []).map((row) => ({
    id: String(row.id),
    email: String(row.email)
  }));
}

/** Marks one signup done. Only called after a send returned ok, or was skipped. */
export async function markRestockNotified(db, id, now = Date.now()) {
  await db
    .prepare("UPDATE restock_signups SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    .bind(Math.round(now), String(id))
    .run();
}
