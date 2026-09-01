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
 * Cold start costs 1 read + up to 10 writes, once per deploy per isolate,
 * against a free-plan allowance of 100k row writes a day. The steady state is
 * zero queries.
 */

/** Bump when SCHEMA_STATEMENTS changes; the new statements must stay additive. */
export const SCHEMA_VERSION = 1;

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
  `CREATE INDEX IF NOT EXISTS burned_tokens_expires_at ON burned_tokens (expires_at)`
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
