/**
 * @fileoverview "Have I already reported this to analytics?" -- a one-row-per-key
 * claim table in D1.
 *
 * WHY IT IS NOT THE webhook_events CLAIM
 * webhook_events answers "have I started processing this Stripe EVENT id",
 * and it is released on failure so Stripe's retry can pick the work up again.
 * That is exactly right for the money path and exactly wrong here: if the
 * gift-card mint throws, the webhook 500s, the claim is released, Stripe
 * redelivers, and every idempotent step re-runs harmlessly -- except an
 * analytics send, which is not idempotent at the far end. Umami would book the
 * order's revenue a second time and the Revenue report would quietly overstate
 * the shop's takings.
 *
 * So the analytics claim is keyed on the Stripe CHECKOUT SESSION id (one per
 * order, for the life of the order) and is never released. Claimed once means
 * reported once, whatever happens to the rest of the webhook.
 *
 * WHY A SEPARATE TABLE AND NOT job_state
 * job_state is "when did this scheduled job last run" -- a dozen rows that
 * live forever. This grows by one row per order and is swept. Mixing them
 * would make the sweeper's job ambiguous and job_state unreadable.
 *
 * COST
 * One INSERT OR IGNORE per paid order. `INSERT OR IGNORE` on a PRIMARY KEY is
 * atomic in SQLite and D1 reports the affected row count in `meta.changes`, so
 * the first caller sees 1 and every repeat sees 0. No read, no transaction.
 */

/** Rows older than this are swept by the hourly cron. */
export const DEFAULT_SWEEP_DAYS = 90;

/** The only kind of send claimed today. Kept as a prefix so a second kind
    (a refund event, say) cannot collide with an order id. */
export const ORDER_PAID = "order-paid";

function claimKey(kind, id) {
  if (typeof kind !== "string" || !/^[a-z0-9-]{3,40}$/.test(kind)) {
    throw new TypeError("analytics-sends: kind must be a short lowercase slug.");
  }
  if (typeof id !== "string" || !/^[A-Za-z0-9_]{3,255}$/.test(id)) {
    throw new TypeError("analytics-sends: id must be a Stripe-style id string.");
  }
  return `${kind}:${id}`;
}

/**
 * Atomically claims one analytics send.
 *
 * @param {object} db D1 binding (env.STATE_DB)
 * @param {string} kind e.g. ORDER_PAID
 * @param {string} id Stripe Checkout Session id
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {Promise<boolean>} true only for the first caller. Callers MUST NOT
 *   send when this is false.
 */
export async function claimAnalyticsSend(db, kind, id, now = Date.now()) {
  const key = claimKey(kind, id);
  const res = await db
    .prepare("INSERT OR IGNORE INTO analytics_sends (send_key, created_at) VALUES (?, ?)")
    .bind(key, now)
    .run();
  return (res && res.meta && res.meta.changes) === 1;
}

/**
 * Gives a claim back. Called ONLY when the send provably never happened --
 * i.e. the request was never made because analytics is not configured. A send
 * that was made and then failed is NOT released: Umami may well have recorded
 * it, and an over-count is worse than an under-count in a revenue report.
 *
 * @returns {Promise<boolean>} true if a claim was actually released.
 */
export async function releaseAnalyticsSend(db, kind, id) {
  const key = claimKey(kind, id);
  const res = await db.prepare("DELETE FROM analytics_sends WHERE send_key = ?").bind(key).run();
  return (res && res.meta && res.meta.changes) > 0;
}

/** @returns {Promise<object|null>} the raw row, for debugging and tests. */
export async function getAnalyticsSend(db, kind, id) {
  return db
    .prepare("SELECT * FROM analytics_sends WHERE send_key = ?")
    .bind(claimKey(kind, id))
    .first();
}

/**
 * Cron housekeeping. A Stripe session id is never reused, so an old row can
 * only ever match an order that was reported months ago.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepAnalyticsSends(
  db,
  olderThanDays = DEFAULT_SWEEP_DAYS,
  now = Date.now()
) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError("analytics-sends: olderThanDays must be >= 1.");
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const res = await db
    .prepare("DELETE FROM analytics_sends WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}
