/**
 * @fileoverview Alt-Points loyalty ledger, in D1, append-only, keyed by email.
 *
 * WHY
 * Audit finding C-1: `redeem-points.js` mints a real, unlimited-use $25 Stripe
 * coupon for anyone who POSTs `{"points":500}`. There is no ledger anywhere --
 * the only "balance" is `localStorage["yl_loyalty_points"]`, which the shopper
 * owns, and nothing in the codebase ever credits it. Store credit cannot be
 * minted from a client-side number. This module is the server-side balance the
 * fix needs.
 *
 * SHAPE
 * One append-only table. A credit is a positive row, a debit is a negative row,
 * and the balance is SUM(points) for the email. Nothing is ever updated or
 * deleted, so every reward and every redemption stays auditable and a bug can
 * be reasoned about after the fact rather than guessed at.
 *
 * IDENTITY
 * The key is the lowercased, trimmed email. That is deliberately weak identity:
 * it is the same key Stripe puts on the order, and it is what the magic-link
 * module proves ownership of before any debit is allowed. Points are never
 * credited or debited on the strength of a request body alone -- credits come
 * from a verified Stripe webhook, debits from a magic-link-authenticated caller.
 *
 * IDEMPOTENCY AND RACES
 * - credit() is idempotent on `order_id`, enforced by a UNIQUE index, so a
 *   redelivered `checkout.session.completed` cannot pay the customer twice.
 * - debit() must never overdraw. The check and the write are ONE conditional
 *   INSERT ... SELECT ... WHERE (SELECT SUM(points) ...) >= ?, which SQLite
 *   evaluates atomically inside the statement. A read-then-write pair would be
 *   a TOCTOU race across two concurrent Worker invocations; this cannot be.
 */

/** Points-to-value tiers, mirroring netlify/functions/redeem-points.js. */
export const REDEMPTION_TIERS = {
  100: 500,
  200: 1000,
  500: 2500
};

/** Canonical customer key. Lowercase + trim only -- no provider-specific games. */
export function normalizeEmail(email) {
  if (typeof email !== "string") throw new TypeError("loyalty: email must be a string.");
  const clean = email.trim().toLowerCase();
  if (clean.length < 3 || clean.length > 254 || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(clean)) {
    throw new TypeError("loyalty: email is not a valid address.");
  }
  return clean;
}

function assertPoints(points) {
  if (!Number.isInteger(points) || points <= 0 || points > 1000000) {
    throw new TypeError("loyalty: points must be a positive integer.");
  }
  return points;
}

function assertRef(value, field) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 255) {
    throw new TypeError(`loyalty: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Awards points for an order. Idempotent on orderId.
 *
 * @param {object} db D1 binding
 * @param {{email: string, points: number, orderId: string, reason?: string}} args
 * @returns {Promise<{credited: boolean, duplicate: boolean, balance: number}>}
 *   `credited` is false with `duplicate` true when this order was already paid out.
 */
export async function credit(db, args, now = Date.now()) {
  const params = args || {};
  const email = normalizeEmail(params.email);
  const points = assertPoints(params.points);
  const orderId = assertRef(params.orderId, "orderId");
  const reason = typeof params.reason === "string" ? params.reason.slice(0, 64) : "order";

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO loyalty_ledger (email, points, order_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(email, points, orderId, reason, now)
    .run();
  const credited = (res && res.meta && res.meta.changes) === 1;
  return { credited, duplicate: !credited, balance: await balance(db, email) };
}

/**
 * @param {object} db D1 binding
 * @param {string} email
 * @returns {Promise<number>} current point balance (0 for an unknown customer)
 */
export async function balance(db, email) {
  const key = normalizeEmail(email);
  const row = await db
    .prepare("SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_ledger WHERE email = ?")
    .bind(key)
    .first();
  return (row && row.total) || 0;
}

/**
 * Spends points. Refuses rather than overdrawing, and refuses a repeated refId
 * so a double-submitted redemption cannot spend twice.
 *
 * The balance test lives inside the INSERT so there is no window between the
 * check and the write: two simultaneous 500-point redemptions on a 500-point
 * balance produce exactly one success and one `insufficient`.
 *
 * @param {object} db D1 binding
 * @param {{email: string, points: number, reason: string, refId: string}} args
 * @returns {Promise<{ok: boolean, reason?: 'insufficient'|'duplicate', balance: number}>}
 */
export async function debit(db, args, now = Date.now()) {
  const params = args || {};
  const email = normalizeEmail(params.email);
  const points = assertPoints(params.points);
  const refId = assertRef(params.refId, "refId");
  const reason = assertRef(params.reason, "reason").slice(0, 64);

  const res = await db
    .prepare(
      `INSERT INTO loyalty_ledger (email, points, order_id, reason, ref_id, created_at)
       SELECT ?, ?, NULL, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(points), 0) FROM loyalty_ledger WHERE email = ?) >= ?
          AND NOT EXISTS (SELECT 1 FROM loyalty_ledger WHERE ref_id = ? AND points < 0)`
    )
    .bind(email, -points, reason, refId, now, email, points, refId)
    .run();

  const current = await balance(db, email);
  if ((res && res.meta && res.meta.changes) === 1) return { ok: true, balance: current };

  // The conditional insert cannot tell us which clause failed, so ask once.
  const dupe = await db
    .prepare("SELECT 1 AS hit FROM loyalty_ledger WHERE ref_id = ? AND points < 0 LIMIT 1")
    .bind(refId)
    .first();
  return { ok: false, reason: dupe ? "duplicate" : "insufficient", balance: current };
}

/**
 * @param {object} db D1 binding
 * @param {string} email
 * @param {number} [limit] newest-first cap, 1..200
 * @returns {Promise<{email: string, balance: number, entries: object[]}>}
 */
export async function statement(db, email, limit = 50) {
  const key = normalizeEmail(email);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const res = await db
    .prepare(
      `SELECT id, points, order_id, reason, ref_id, created_at
         FROM loyalty_ledger WHERE email = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(key, cap)
    .all();
  return { email: key, balance: await balance(db, key), entries: (res && res.results) || [] };
}
