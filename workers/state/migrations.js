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
 * Cold start costs 1 read + up to 24 writes, once per deploy per isolate,
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
 * v6 (2026-09-04) added order_emails -- the record of transactional order mail
 * already delivered, so the ship notice goes out once per parcel however many
 * times the shop edits the fulfilment metadata behind it.
 * v7 (2026-09-09) added inventory and inventory_holds -- the live count that
 * decrements as orders are paid (workers/state/inventory.js), seeded from the
 * `stock` the owner sets in the CMS.
 * v8 (2026-09-09) added seed_at / synced_at to inventory (SCHEMA_ALTERS below)
 * so a stale catalog cannot reseed a row backwards and an un-tracked product
 * is marked instead of frozen.
 * v9 (2026-09-09) added orders -- the customer's own order history behind
 * /orders.html (workers/state/orders.js), written from
 * checkout.session.completed and keyed by a SHA-256 of the address, never
 * the address itself. v8 and v9 landed on parallel branches, each bumping
 * from v7; a database that reached "8" through either one is brought to 9
 * here, which is safe because every statement is idempotent (CREATE IF NOT
 * EXISTS, and the ALTERs swallow "duplicate column").
 * v10 (2026-09-10) added square_sales and square_catalog -- the register
 * (workers/state/square-sync.js): one row per Square order already counted
 * off the shelf, so a second payment on the same order or a redelivered
 * webhook moves nothing, and the SKU -> product map the register's items
 * resolve through.
 */
export const SCHEMA_VERSION = 10;

/** Verbatim from workers/schema.sql. Keep the two in sync -- worker-state.test.js compares every statement. */
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
  `CREATE INDEX IF NOT EXISTS analytics_sends_created_at ON analytics_sends (created_at)`,
  // v6: the transactional order-email record (see workers/schema.sql for the
  // rationale -- in particular why it is not analytics_sends)
  `CREATE TABLE IF NOT EXISTS order_emails (
  send_key    TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS order_emails_created_at ON order_emails (created_at)`,
  // v7: the inventory ledger (see workers/schema.sql and workers/state/inventory.js
  // for the state machine and the seed / owner-correction rule)
  `CREATE TABLE IF NOT EXISTS inventory (
  product_id  TEXT PRIMARY KEY,
  on_hand     INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved    INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  seed_stock  INTEGER NOT NULL,
  seed_at     INTEGER NOT NULL DEFAULT 0,
  synced_at   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS inventory_holds (
  session_id  TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  state       TEXT NOT NULL CHECK (state IN ('active','committed','released','restocked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, product_id)
)`,
  `CREATE INDEX IF NOT EXISTS inventory_holds_state ON inventory_holds (state, created_at)`,
  // v9: the order history (see workers/schema.sql and workers/state/orders.js
  // for why the address is stored only as a hash, and why nothing sweeps it)
  `CREATE TABLE IF NOT EXISTS orders (
  session_id      TEXT PRIMARY KEY,
  email_hash      TEXT NOT NULL,
  payment_intent  TEXT,
  created         INTEGER NOT NULL,
  amount_total    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL,
  line_items_json TEXT NOT NULL,
  tracking_url    TEXT,
  updated_at      INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS orders_email_hash ON orders (email_hash, created)`,
  `CREATE INDEX IF NOT EXISTS orders_payment_intent ON orders (payment_intent)`,
  // v10: the register (see workers/schema.sql and workers/state/square-sync.js
  // for why a sale is keyed on the Square ORDER, not the payment or the event)
  `CREATE TABLE IF NOT EXISTS square_sales (
  order_id     TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('applied','restocked')),
  lines_json   TEXT NOT NULL,
  location_id  TEXT,
  sold_at      INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS square_sales_sold_at ON square_sales (sold_at)`,
  `CREATE TABLE IF NOT EXISTS square_catalog (
  variation_id       TEXT PRIMARY KEY,
  sku                TEXT,
  item_name          TEXT,
  variation_name     TEXT,
  product_id         TEXT,
  resolved_at        INTEGER NOT NULL,
  last_pushed_count  INTEGER,
  last_pushed_at     INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS square_catalog_product ON square_catalog (product_id)`
];

/**
 * v8 (2026-09-09): columns added to a table that already exists on the live
 * database. CREATE TABLE IF NOT EXISTS cannot add them, so these run after
 * the CREATEs; SQLite has no ADD COLUMN IF NOT EXISTS, so a "duplicate
 * column" refusal (a fresh database, whose CREATE already carried them) is
 * the expected no-op and is swallowed. Anything else is a real failure.
 *   seed_at   -- when (catalog fetch time) the row was last seeded, so an
 *                isolate holding an OLDER catalog than the last owner
 *                correction cannot reseed the row backwards.
 *   synced_at -- last sync that saw the product as tracked, so a product
 *                the owner un-tracks is marked and re-tracking seeds fresh.
 */
export const SCHEMA_ALTERS = [
  `ALTER TABLE inventory ADD COLUMN seed_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE inventory ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0`
];

function isDuplicateColumn(err) {
  return /duplicate column/i.test(String((err && err.message) || err));
}

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
  for (const statement of SCHEMA_ALTERS) {
    try {
      await db.prepare(statement).run();
    } catch (err) {
      if (!isDuplicateColumn(err)) throw err;
    }
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
