/**
 * @fileoverview "Has this order already been told?" -- the record of
 * transactional order emails that must not be sent a second time.
 *
 * WHY IT IS NOT THE webhook_events CLAIM
 * That one answers "have I started processing this Stripe EVENT id", and it is
 * released when a handler fails so the retry can re-run every idempotent step.
 * A ship notice is keyed on the ORDER, and is not sent from a webhook at all:
 * Stripe fires nothing when PaymentIntent metadata is edited, so the hourly
 * cron sweep (routes/ship-notice.js) re-reads every recent shipped order on
 * every pass, for weeks. The customer must be told once, however many passes
 * see the same parcel and however many times the tracking link is corrected.
 *
 * WHY IT IS NOT analytics_sends
 * That claim is taken BEFORE the side effect and never released, because an
 * over-counted revenue figure is worse than a missing one. Here the trade runs
 * the other way: a customer who is never told their order shipped is worse than
 * the small risk of a duplicate. So the row is written AFTER Resend has
 * accepted the message -- a refused send leaves no row, and the next hourly
 * pass of the sweep simply tries that order again. The only window that leaves
 * is two passes in flight at once, which the Resend `Idempotency-Key` on the
 * send itself closes.
 *
 * COST
 * One indexed read and (once per order) one write. Swept after 90 days by the
 * hourly cron: a Stripe id is never reused, so a row older than that can only
 * match an order that shipped a season ago.
 */

/** Rows older than this are swept by the hourly cron. */
export const DEFAULT_SWEEP_DAYS = 90;

/**
 * The kinds recorded here. Kept as a key prefix so a second kind can never
 * collide with the first on the same Stripe id.
 */
export const SHIP_NOTICE = "ship-notice";

function recordKey(kind, id) {
  if (typeof kind !== "string" || !/^[a-z0-9-]{3,40}$/.test(kind)) {
    throw new TypeError("order-emails: kind must be a short lowercase slug.");
  }
  if (typeof id !== "string" || !/^[A-Za-z0-9_]{3,255}$/.test(id)) {
    throw new TypeError("order-emails: id must be a Stripe-style id string.");
  }
  return `${kind}:${id}`;
}

/**
 * Has this email already gone out for this order?
 *
 * @param {object} db D1 binding (env.STATE_DB)
 * @param {string} kind e.g. SHIP_NOTICE
 * @param {string} id the Stripe id the email is keyed on
 * @returns {Promise<boolean>} true when it has; callers MUST NOT send.
 */
export async function orderEmailSent(db, kind, id) {
  const row = await db
    .prepare("SELECT 1 AS hit FROM order_emails WHERE send_key = ?")
    .bind(recordKey(kind, id))
    .first();
  return Boolean(row);
}

/**
 * Records a delivered email. Call ONLY once the send has been accepted --
 * recording one that never went out is how a customer silently stops being
 * told anything.
 *
 * @returns {Promise<boolean>} true when this call wrote the row, false when it
 *   was already there (a concurrent delivery got in first).
 */
export async function recordOrderEmail(db, kind, id, now = Date.now()) {
  const res = await db
    .prepare("INSERT OR IGNORE INTO order_emails (send_key, created_at) VALUES (?, ?)")
    .bind(recordKey(kind, id), now)
    .run();
  return (res && res.meta && res.meta.changes) === 1;
}

/** @returns {Promise<object|null>} the raw row, for debugging and tests. */
export async function getOrderEmail(db, kind, id) {
  return db
    .prepare("SELECT * FROM order_emails WHERE send_key = ?")
    .bind(recordKey(kind, id))
    .first();
}

/**
 * Cron housekeeping.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepOrderEmails(db, olderThanDays = DEFAULT_SWEEP_DAYS, now = Date.now()) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError("order-emails: olderThanDays must be >= 1.");
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const res = await db.prepare("DELETE FROM order_emails WHERE created_at < ?").bind(cutoff).run();
  return (res && res.meta && res.meta.changes) || 0;
}
