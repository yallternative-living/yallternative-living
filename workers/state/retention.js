/**
 * @fileoverview D1 access for the retention layer: order signals, the delayed
 * email queue, the suppression list, the birthday club and minted welcome
 * codes.
 *
 * WHY THIS SHAPE
 * Everything here follows the two rules the rest of `workers/state/` follows:
 * a write is idempotent by primary key (INSERT OR IGNORE, never a
 * read-then-write pair), and a read is served by an index that exists in
 * `workers/schema.sql`. Nothing grows without a sweeper -- `sweepEmailQueue`
 * is called from the cron handler alongside the webhook sweep.
 *
 * SCHEDULING: A D1 QUEUE, NOT ONE DURABLE OBJECT ALARM PER ORDER.
 * Both work. The queue wins here because the sends are day-scale, so minute
 * precision is worthless; because a DO-per-order is one object plus one alarm
 * per order whose state cannot be listed, audited or replayed by hand; and
 * because a dropped alarm is silent while an undrained row is visible to
 * `wrangler d1 execute "SELECT * FROM email_queue WHERE status = 'pending'"`.
 * The `scheduled` handler in workers/checkout.js already existed for the
 * webhook sweep, so this adds a query, not a subsystem.
 *
 * PII
 * `order_signals` stores both `email` and `email_hash`. The address is there
 * because an email cannot be sent to a hash; the hash is what every log line,
 * idempotency key and Stripe metadata field uses, so an operational trace never
 * carries the address. The unsubscribe link carries `unsub_id` -- an HMAC of
 * the address, one-way and unguessable -- so no URL anywhere holds an email.
 */

import { normalizeEmail } from "./loyalty.js";

export { normalizeEmail };

/** Queue kinds. A row with any other `kind` is skipped by the drain, loudly. */
export const EMAIL_KINDS = [
  "usage-guide",
  "review-request",
  "recovery",
  "birthday",
  "loyalty-reward"
];

/** A queued send is abandoned after this many failed attempts. */
export const MAX_SEND_ATTEMPTS = 5;

const encoder = new TextEncoder();

/** SHA-256, lowercase hex. Used for `email_hash` and idempotency keys. */
export async function hashEmail(email) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalizeEmail(email)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, message) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TypeError("retention: signing secret must be at least 16 characters.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare -- an early return leaks the signature. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The opaque id an unsubscribe link carries in place of the address.
 *
 * Deterministic (the same address always yields the same id, so the row is
 * written once), one-way (SHA-256 HMAC under the signing secret) and
 * unguessable without that secret.
 */
export async function unsubscribeId(secret, email) {
  return (await hmacHex(secret, `unsub-id:${normalizeEmail(email)}`)).slice(0, 32);
}

/**
 * `<unsub_id>.<signature>`. The signature lets the route reject a random or
 * tampered token with zero database reads, which is what keeps the endpoint
 * from being a free enumeration oracle over `email_contacts`.
 */
export async function unsubscribeToken(secret, email) {
  const id = await unsubscribeId(secret, email);
  return `${id}.${(await hmacHex(secret, `unsub:${id}`)).slice(0, 32)}`;
}

/** @returns {Promise<{valid: boolean, unsubId?: string}>} */
export async function verifyUnsubscribeToken(secret, token) {
  if (typeof token !== "string" || token.length > 128) return { valid: false };
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0])) return { valid: false };
  const expected = (await hmacHex(secret, `unsub:${parts[0]}`)).slice(0, 32);
  return safeEqual(expected, parts[1]) ? { valid: true, unsubId: parts[0] } : { valid: false };
}

/* ------------------------------------------------------------ order signals */

function joinList(values, cap = 400) {
  const list = (Array.isArray(values) ? values : [])
    .map((v) => String(v === null || v === undefined ? "" : v).trim())
    .filter(Boolean);
  return Array.from(new Set(list)).join(",").slice(0, cap);
}

/**
 * One row per paid order. Idempotent on the Stripe session id, so a redelivered
 * `checkout.session.completed` writes nothing and reports `recorded: false`.
 *
 * @param {object} db D1 binding
 * @param {{orderId: string, email: string, productIds?: string[], categories?: string[]}} args
 * @returns {Promise<{recorded: boolean, emailHash: string}>}
 */
export async function recordOrder(db, args, now = Date.now()) {
  const params = args || {};
  const orderId = String(params.orderId || "").trim();
  if (!orderId) throw new TypeError("retention: orderId is required.");
  const email = normalizeEmail(params.email);
  const emailHash = await hashEmail(email);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO order_signals
         (order_id, email, email_hash, product_ids, categories, placed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(orderId, email, emailHash, joinList(params.productIds), joinList(params.categories), now)
    .run();
  return { recorded: (res && res.meta && res.meta.changes) === 1, emailHash };
}

/** @returns {Promise<object|null>} the signal row, or null. */
export async function getOrderSignal(db, orderId) {
  return db
    .prepare("SELECT * FROM order_signals WHERE order_id = ?")
    .bind(String(orderId || ""))
    .first();
}

/* -------------------------------------------------------------- email queue */

/**
 * Schedules one send. `id` is the idempotency key and carries the (kind,
 * subject) pair -- e.g. `usage-guide:cs_test_123` -- so a redelivered webhook
 * or a re-run cron enqueues nothing.
 *
 * @param {object} db D1 binding
 * @param {{id: string, kind: string, email: string, payload?: object, sendAfter: number}} args
 * @returns {Promise<{queued: boolean}>} false when the row already existed
 */
export async function enqueueEmail(db, args, now = Date.now()) {
  const params = args || {};
  const id = String(params.id || "").trim();
  if (!id || id.length > 200) throw new TypeError("retention: queue id is required.");
  if (!EMAIL_KINDS.includes(params.kind)) {
    throw new TypeError(`retention: unknown email kind "${params.kind}".`);
  }
  const email = normalizeEmail(params.email);
  const sendAfter = Number(params.sendAfter);
  if (!Number.isFinite(sendAfter)) throw new TypeError("retention: sendAfter must be a number.");
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO email_queue
         (id, kind, email, payload, send_after, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`
    )
    .bind(id, params.kind, email, JSON.stringify(params.payload || {}), Math.round(sendAfter), now)
    .run();
  return { queued: (res && res.meta && res.meta.changes) === 1 };
}

/**
 * Moves one queued send to a new due time.
 *
 * PENDING ROWS ONLY, and that clause is the whole safety story: a row already
 * `sent` must not be resurrected by a later reschedule, and a row the drain has
 * marked `failed` after five refusals is evidence of a configuration problem,
 * not work to retry on a new date. `attempts` is deliberately untouched -- the
 * send is the same send, just later.
 *
 * @param {object} db D1 binding
 * @param {string} id the queue row's id, e.g. `usage-guide:cs_test_123`
 * @param {number} sendAfter epoch ms
 * @returns {Promise<{moved: boolean}>} false when there was no pending row
 */
export async function rescheduleQueuedEmail(db, id, sendAfter) {
  const when = Number(sendAfter);
  if (!Number.isFinite(when)) throw new TypeError("retention: sendAfter must be a number.");
  const res = await db
    .prepare("UPDATE email_queue SET send_after = ? WHERE id = ? AND status = 'pending'")
    .bind(Math.round(when), String(id))
    .run();
  return { moved: (res && res.meta && res.meta.changes) > 0 };
}

/**
 * Pending rows whose time has come, oldest first. Served entirely by
 * `email_queue_due (status, send_after)`.
 *
 * @returns {Promise<object[]>}
 */
export async function dueEmails(db, now = Date.now(), limit = 25) {
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const res = await db
    .prepare(
      `SELECT id, kind, email, payload, send_after, attempts
         FROM email_queue
        WHERE status = 'pending' AND send_after <= ?
        ORDER BY send_after ASC
        LIMIT ?`
    )
    .bind(Math.round(now), cap)
    .all();
  return (res && res.results) || [];
}

/** Marks a row delivered. */
export async function markEmailSent(db, id, now = Date.now()) {
  await db
    .prepare(
      "UPDATE email_queue SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?"
    )
    .bind(now, String(id))
    .run();
}

/**
 * Marks a row skipped -- the recipient is suppressed, or the payload no longer
 * makes sense. A skip is terminal and is NOT a failure: retrying it would send
 * mail to someone who asked not to receive any.
 */
export async function markEmailSkipped(db, id, now = Date.now()) {
  await db
    .prepare("UPDATE email_queue SET status = 'skipped', sent_at = ? WHERE id = ?")
    .bind(now, String(id))
    .run();
}

/**
 * Records a failed attempt. The row stays `pending` (so the next cron tick
 * retries it) until MAX_SEND_ATTEMPTS, then becomes `failed` and stops -- a
 * send that has been refused five times is a configuration problem, and
 * hammering Resend forever hides it.
 *
 * @returns {Promise<{attempts: number, exhausted: boolean}>}
 */
export async function markEmailFailed(db, id, now = Date.now()) {
  await db
    .prepare(
      `UPDATE email_queue
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
              sent_at = ?
        WHERE id = ?`
    )
    .bind(MAX_SEND_ATTEMPTS, now, String(id))
    .run();
  const row = await db
    .prepare("SELECT attempts, status FROM email_queue WHERE id = ?")
    .bind(String(id))
    .first();
  const attempts = (row && Number(row.attempts)) || 0;
  return { attempts, exhausted: Boolean(row && row.status === "failed") };
}

/**
 * Cron housekeeping: settled rows older than `days` are dropped. Pending and
 * failed rows are never swept -- a pending row is work still owed, and a failed
 * one is evidence.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepEmailQueue(db, days = 90, now = Date.now()) {
  const cutoff = now - Math.max(1, Number(days) || 90) * 86400000;
  const res = await db
    .prepare("DELETE FROM email_queue WHERE status IN ('sent', 'skipped') AND send_after < ?")
    .bind(cutoff)
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}

/* --------------------------------------------------------------- suppression */

/**
 * Opts an address out of every marketing send. Idempotent.
 *
 * @returns {Promise<{suppressed: boolean, alreadySuppressed: boolean}>}
 */
export async function suppressEmail(db, email, reason = "unsubscribe", now = Date.now()) {
  const key = normalizeEmail(email);
  const res = await db
    .prepare("INSERT OR IGNORE INTO email_suppression (email, reason, created_at) VALUES (?, ?, ?)")
    .bind(key, String(reason || "unsubscribe").slice(0, 64), now)
    .run();
  const first = (res && res.meta && res.meta.changes) === 1;
  return { suppressed: true, alreadySuppressed: !first };
}

/**
 * The check every marketing send makes, immediately before the Resend call --
 * never at enqueue time, because someone who unsubscribes on day 3 must not get
 * the review request that was queued on day 0.
 */
export async function isSuppressed(db, email) {
  let key;
  try {
    key = normalizeEmail(email);
  } catch {
    return true; // an address this module will not normalise is never mailed
  }
  const row = await db
    .prepare("SELECT 1 AS hit FROM email_suppression WHERE email = ?")
    .bind(key)
    .first();
  return Boolean(row);
}

/* ------------------------------------------------------------- unsub contacts */

/** Remembers the address behind an unsubscribe id. Idempotent. */
export async function rememberContact(db, unsubId, email, now = Date.now()) {
  await db
    .prepare("INSERT OR IGNORE INTO email_contacts (unsub_id, email, created_at) VALUES (?, ?, ?)")
    .bind(String(unsubId), normalizeEmail(email), now)
    .run();
}

/** @returns {Promise<string|null>} the address, or null for an unknown id. */
export async function contactForUnsubId(db, unsubId) {
  if (typeof unsubId !== "string" || !/^[a-f0-9]{32}$/.test(unsubId)) return null;
  const row = await db
    .prepare("SELECT email FROM email_contacts WHERE unsub_id = ?")
    .bind(unsubId)
    .first();
  return (row && row.email) || null;
}

/* ----------------------------------------------------------- birthday club */

/** MM/DD or MM-DD in, `MM-DD` out. Rejects a year, and rejects 02/30. */
export function normalizeMonthDay(value) {
  const match = /^(\d{2})[/-](\d{2})$/.exec(String(value === undefined ? "" : value).trim());
  if (!match) throw new TypeError("retention: birthday must be MM/DD.");
  const month = Number(match[1]);
  const day = Number(match[2]);
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]) {
    throw new TypeError("retention: birthday must be a real month and day.");
  }
  return `${match[1]}-${match[2]}`;
}

/**
 * Stores a birthday-club membership. MM-DD only -- there is no column for a
 * year and nothing here accepts one.
 *
 * Idempotent per email: a second submission for the same address updates the
 * date and the consent timestamp rather than creating a second membership.
 *
 * @returns {Promise<{saved: boolean, updated: boolean, monthDay: string}>}
 */
export async function saveBirthday(db, args, now = Date.now()) {
  const params = args || {};
  const email = normalizeEmail(params.email);
  const monthDay = normalizeMonthDay(params.monthDay);
  const existing = await db
    .prepare("SELECT month_day FROM birthday_club WHERE email = ?")
    .bind(email)
    .first();
  await db
    .prepare(
      `INSERT INTO birthday_club (email, month_day, consent_at, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE
         SET month_day = excluded.month_day,
             consent_at = excluded.consent_at,
             source = excluded.source`
    )
    .bind(email, monthDay, now, String(params.source || "thank-you").slice(0, 32))
    .run();
  return { saved: true, updated: Boolean(existing), monthDay };
}

/** Members whose birthday is `MM-DD`. Served by `birthday_club_month_day`. */
export async function birthdaysOn(db, monthDay, limit = 200) {
  const key = normalizeMonthDay(monthDay);
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const res = await db
    .prepare("SELECT email, month_day FROM birthday_club WHERE month_day = ? LIMIT ?")
    .bind(key, cap)
    .all();
  return (res && res.results) || [];
}

/* ------------------------------------------------------------ welcome codes */

/**
 * Records the promotion code minted for a subscriber. INSERT OR IGNORE, so the
 * first code minted for an address is the only one that is ever kept: this row
 * is both the idempotency key and the per-address rate limit.
 *
 * @returns {Promise<{stored: boolean}>}
 */
export async function saveWelcomeCode(db, args, now = Date.now()) {
  const params = args || {};
  const email = normalizeEmail(params.email);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO welcome_codes (email, code, promo_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      email,
      String(params.code || "").slice(0, 64),
      params.promoId ? String(params.promoId).slice(0, 64) : null,
      Math.round(Number(params.expiresAt) || 0),
      now
    )
    .run();
  return { stored: (res && res.meta && res.meta.changes) === 1 };
}

/**
 * The code already minted for this address, if it has not expired.
 *
 * @returns {Promise<{code: string, expiresAt: number}|null>}
 */
export async function getWelcomeCode(db, email, now = Date.now()) {
  const row = await db
    .prepare("SELECT code, expires_at FROM welcome_codes WHERE email = ?")
    .bind(normalizeEmail(email))
    .first();
  if (!row) return null;
  const expiresAt = Number(row.expires_at) || 0;
  if (expiresAt > 0 && expiresAt * 1000 <= now) return null;
  return { code: String(row.code), expiresAt };
}

/** One queued row by id. Used to decide whether a reward still needs minting. */
export async function getQueuedEmail(db, id) {
  return db
    .prepare("SELECT id, kind, status, attempts, payload FROM email_queue WHERE id = ?")
    .bind(String(id || ""))
    .first();
}
