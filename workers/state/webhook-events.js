/**
 * @fileoverview Exactly-once claiming of Stripe webhook events, in D1.
 *
 * WHY
 * Audit H-9 and H-5: `fulfill-gift-card.js` re-derives idempotency from ad-hoc
 * keys (a hash of the session id in one place, the charge id in another) and
 * 500s the whole webhook when any sub-step fails, so Stripe retries forever and
 * the retry re-runs the steps that already succeeded. Stripe guarantees
 * at-least-once delivery and will redeliver for up to three days; the only
 * correct defence is a durable, atomic "have I already started this event id?"
 * claim before any side effect runs.
 *
 * WHY D1 AND NOT A DURABLE OBJECT
 * Event ids are uniformly distributed and never contended -- two deliveries of
 * the same event arrive minutes apart, not microseconds -- so the strong
 * single-writer serialisation a DO buys is not needed. What is needed is one
 * cheap conditional insert. `INSERT OR IGNORE` on a PRIMARY KEY is atomic in
 * SQLite, and D1 reports the row count in `meta.changes`, so the first writer
 * sees changes === 1 and every redelivery sees 0. One query per webhook.
 *
 * LIFECYCLE
 *   claimEvent   -> row inserted with status 'processing'  (returns true once)
 *   markEventDone-> status 'done'
 *   releaseEvent -> row deleted, so Stripe's next retry may re-claim it
 *   sweepOldEvents -> cron housekeeping, keeps the table (and the row-write
 *                     budget) small
 *
 * A handler that throws MUST call releaseEvent, otherwise the failed event is
 * permanently claimed and Stripe's retries all no-op. See README.md.
 */

/** Rows older than this are swept by default; Stripe stops retrying after ~3 days. */
export const DEFAULT_SWEEP_DAYS = 30;

function assertEventId(eventId) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_]{3,255}$/.test(eventId)) {
    throw new TypeError("webhook-events: eventId must be a Stripe-style id string.");
  }
  return eventId;
}

/**
 * Atomically claims a webhook event for processing.
 *
 * @param {object} db  D1 binding (env.STATE_DB)
 * @param {string} eventId  Stripe event id, e.g. "evt_1P..."
 * @param {string} type     Stripe event type, e.g. "checkout.session.completed"
 * @param {number} [now]    epoch ms, injectable for tests
 * @returns {Promise<boolean>} true only for the first caller; false for every
 *   redelivery. Callers MUST skip all side effects when this is false.
 */
export async function claimEvent(db, eventId, type, now = Date.now()) {
  assertEventId(eventId);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events (event_id, type, status, claimed_at)
       VALUES (?, ?, 'processing', ?)`
    )
    .bind(eventId, typeof type === "string" ? type.slice(0, 120) : null, now)
    .run();
  return (res && res.meta && res.meta.changes) === 1;
}

/**
 * Marks a claimed event finished. Safe to call twice.
 *
 * @returns {Promise<boolean>} true if a 'processing' row moved to 'done'.
 */
export async function markEventDone(db, eventId, now = Date.now()) {
  assertEventId(eventId);
  const res = await db
    .prepare(
      `UPDATE webhook_events SET status = 'done', completed_at = ?
        WHERE event_id = ? AND status <> 'done'`
    )
    .bind(now, eventId)
    .run();
  return (res && res.meta && res.meta.changes) > 0;
}

/**
 * Gives a failed event back so Stripe's next retry can claim it again. Call this
 * from the handler's catch block before returning a non-2xx, otherwise the event
 * stays claimed and the retry silently does nothing.
 *
 * @returns {Promise<boolean>} true if a claim was actually released.
 */
export async function releaseEvent(db, eventId) {
  assertEventId(eventId);
  const res = await db
    .prepare("DELETE FROM webhook_events WHERE event_id = ? AND status = 'processing'")
    .bind(eventId)
    .run();
  return (res && res.meta && res.meta.changes) > 0;
}

/** @returns {Promise<object|null>} the raw row, for debugging and tests. */
export async function getEvent(db, eventId) {
  assertEventId(eventId);
  return db.prepare("SELECT * FROM webhook_events WHERE event_id = ?").bind(eventId).first();
}

/**
 * Cron housekeeping. Deletes rows older than `olderThanDays` regardless of
 * status: Stripe abandons retries after about three days, so a month-old row can
 * no longer be redelivered, and a month-old 'processing' row is a crash that was
 * never going to be retried anyway.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepOldEvents(db, olderThanDays = DEFAULT_SWEEP_DAYS, now = Date.now()) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError("webhook-events: olderThanDays must be >= 1.");
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const res = await db
    .prepare("DELETE FROM webhook_events WHERE claimed_at < ?")
    .bind(cutoff)
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}
