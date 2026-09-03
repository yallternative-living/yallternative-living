/**
 * @fileoverview Idempotent D1 schema application at first request.
 *
 * A Worker has no filesystem, so workers/schema.sql cannot be read at runtime.
 * The statements below are that file, transcribed. They are the same statements
 * in the same order, and scripts/worker-state.test.js compares the two so the
 * copy cannot silently drift from the documented schema.
 *
 * GUARD, IN TWO LAYERS
 * 1. `schema_version` -- a one-row table (CHECK (id = 1)) holding the applied
 *    version. When it already reads >= SCHEMA_VERSION, nothing runs.
 * 2. The isolate-level memo in `ensureSchema` -- after the first request on a
 *    Worker isolate, later requests do not query at all. A failed attempt clears
 *    the memo so the next request retries rather than serving a broken database
 *    forever.
 *
 * Every statement is CREATE ... IF NOT EXISTS, so even if both guards were
 * bypassed (two isolates racing on a cold deploy) the result is identical.
 *
 * BUDGET
 * Cold start costs 1 read + up to 21 writes, once per deploy per isolate,
 * against a free-plan allowance of 100k row writes a day. The steady state is
 * zero queries.
 */

/**
 * Bump when SCHEMA_STATEMENTS changes; the new statements must stay additive.
 * v2 (2026-09-02) added the retention tables -- order_signals, email_queue,
 * email_suppression, email_contacts, birthday_club, welcome_codes.
 * v3 (2026-09-02) added adverse_events -- the MoCRA reaction reports behind
 * /safety. Nothing sweeps that table: its rows are kept for at least three
 * years (MoCRA's small-business retention period).
 * v4 (2026-09-02) added the automation tables -- restock_signups,
 * market_alert_subscribers and job_state (the once-per-day marker the cron's
 * daily and monthly jobs check before running).
 * v5 (2026-09-02) added analytics_sends -- the once-per-order claim that stops
 * a redelivered Stripe event booking the same revenue in Umami twice.
 */
export const SCHEMA_VERSION = 5;

/** Verbatim from workers/schema.sql. Keep the two in sync -- a test enforces it. */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     version    INTEGER NOT NULL,
     applied_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
     event_id     TEXT PRIMARY KEY,
     type         TEXT,
     status       TEXT NOT NULL,
     claimed_at   INTEGER NOT NULL,
     completed_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_events_claimed_at ON webhook_events (claimed_at)`,
  `CREATE TABLE IF NOT EXISTS loyalty_ledger (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT    NOT NULL,
     points     INTEGER NOT NULL,
     order_id   TEXT UNIQUE,
     reason     TEXT,
     ref_id     TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS loyalty_ledger_email ON loyalty_ledger (email, id)`,
  `CREATE INDEX IF NOT EXISTS loyalty_ledger_ref ON loyalty_ledger (ref_id)`,
  `CREATE TABLE IF NOT EXISTS burned_tokens (
     token_id   TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL,
     burned_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS burned_tokens_expires_at ON burned_tokens (expires_at)`,
  // --- schema version 2: the retention layer --------------------------------
  `CREATE TABLE IF NOT EXISTS order_signals (
     order_id    TEXT PRIMARY KEY,
     email       TEXT NOT NULL,
     email_hash  TEXT NOT NULL,
     product_ids TEXT,
     categories  TEXT,
     placed_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS order_signals_email ON order_signals (email, placed_at)`,
  `CREATE TABLE IF NOT EXISTS email_queue (
     id         TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     email      TEXT NOT NULL,
     payload    TEXT,
     send_after INTEGER NOT NULL,
     status     TEXT NOT NULL,
     attempts   INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     sent_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS email_queue_due ON email_queue (status, send_after)`,
  `CREATE TABLE IF NOT EXISTS email_suppression (
     email      TEXT PRIMARY KEY,
     reason     TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS email_contacts (
     unsub_id   TEXT PRIMARY KEY,
     email      TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS birthday_club (
     email      TEXT PRIMARY KEY,
     month_day  TEXT NOT NULL CHECK (length(month_day) = 5),
     consent_at INTEGER NOT NULL,
     source     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS birthday_club_month_day ON birthday_club (month_day)`,
  `CREATE TABLE IF NOT EXISTS welcome_codes (
     email      TEXT PRIMARY KEY,
     code       TEXT NOT NULL,
     promo_id   TEXT,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  // --- schema version 3: MoCRA adverse-event reports -------------------------
  // Written by workers/routes/safety-report.js, the endpoint behind the /safety
  // URL printed on the packaging. `serious` is computed server-side from
  // `outcomes`; `ip_hash` is a salted digest, never an address. KEPT FOR AT
  // LEAST THREE YEARS (MoCRA's small-business period; six if this shop's
  // three-year average sales ever cross $1M) -- no sweeper touches this table,
  // and none may be added.
  `CREATE TABLE IF NOT EXISTS adverse_events (
     id              TEXT PRIMARY KEY,
     created_at      INTEGER NOT NULL,
     product_id      TEXT,
     lot             TEXT,
     channel         TEXT,
     first_use_date  TEXT,
     reaction_date   TEXT,
     body_area       TEXT,
     description     TEXT NOT NULL,
     outcomes        TEXT NOT NULL,
     stopped_use     TEXT,
     reporter_name   TEXT,
     reporter_email  TEXT NOT NULL,
     reporter_phone  TEXT,
     age_range       TEXT,
     sex             TEXT,
     contact_consent INTEGER NOT NULL DEFAULT 0,
     serious         INTEGER NOT NULL DEFAULT 0,
     status          TEXT NOT NULL,
     ip_hash         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS adverse_events_triage ON adverse_events (serious, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS adverse_events_created_at ON adverse_events (created_at)`,
  // v4: automation tables (see workers/schema.sql for the rationale)
  `CREATE TABLE IF NOT EXISTS restock_signups (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  email        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  notified_at  INTEGER,
  UNIQUE (product_id, email)
)`,
  `CREATE INDEX IF NOT EXISTS restock_signups_pending ON restock_signups (product_id, notified_at)`,
  `CREATE TABLE IF NOT EXISTS market_alert_subscribers (
  email          TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  consent_text   TEXT NOT NULL,
  last_event_id  TEXT,
  last_sent_at   INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS job_state (
  job         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  // v5: the analytics send claim (see workers/schema.sql for the rationale)
  `CREATE TABLE IF NOT EXISTS analytics_sends (
  send_key    TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS analytics_sends_created_at ON analytics_sends (created_at)`
];

/** Per-isolate memo of the in-flight or completed migration. */
let pending = null;

/**
 * Applies the schema if this database has not reached SCHEMA_VERSION yet.
 * Always safe to call; runs every statement at most once per version.
 *
 * @param {object} db D1 binding
 * @returns {Promise<{applied: boolean, version: number}>}
 */
export async function applyMigrations(db, now = Date.now()) {
  // The version table has to exist before it can be read.
  await db.prepare(SCHEMA_STATEMENTS[0]).run();
  const row = await db.prepare("SELECT version FROM schema_version WHERE id = 1").first();
  if (row && Number(row.version) >= SCHEMA_VERSION) {
    return { applied: false, version: Number(row.version) };
  }

  for (const statement of SCHEMA_STATEMENTS.slice(1)) {
    await db.prepare(statement).run();
  }
  await db
    .prepare(
      `INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`
    )
    .bind(SCHEMA_VERSION, now)
    .run();
  return { applied: true, version: SCHEMA_VERSION };
}

/**
 * The call sites' entry point: cheap after the first request on an isolate.
 * Put it at the top of any handler that touches D1.
 *
 * @param {object} db D1 binding
 * @returns {Promise<{applied: boolean, version: number}>}
 */
export function ensureSchema(db) {
  if (!pending) {
    pending = applyMigrations(db).catch((err) => {
      pending = null; // let the next request try again
      throw err;
    });
  }
  return pending;
}

/** Test seam: forgets the isolate memo. */
export function resetSchemaMemo() {
  pending = null;
}
