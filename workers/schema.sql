-- ---------------------------------------------------------------------------
-- workers/schema.sql -- D1 schema for the Y'allternative Living state layer.
--
-- This file is the human-readable source of truth. The Worker applies the SAME
-- statements at runtime from workers/state/migrations.js (a Worker cannot read
-- files at runtime), and scripts/worker-state.test.js fails the build if the two
-- ever drift apart.
--
-- Apply by hand to a fresh database with:
--   wrangler d1 execute yallternative-state --remote --file=workers/schema.sql
--
-- Every statement is IF NOT EXISTS, so re-running it is free and harmless.
--
-- What is NOT here: gift-card balances (they live in the GiftCardLedger Durable
-- Object, one per code, because they need serialised read-modify-write) and
-- orders (Stripe is the system of record). D1 holds only the three things that
-- are naturally sharded by a random key and never contended.
-- ---------------------------------------------------------------------------

-- Applied-schema marker. `id` is pinned to 1 by a CHECK so the table can hold
-- at most one row and migrations.js can upsert it without a race.
CREATE TABLE IF NOT EXISTS schema_version (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- webhook_events -- exactly-once processing of Stripe webhooks.
--
-- Stripe delivers at least once and retries for about three days. The handler
-- claims the event id here BEFORE any side effect: the PRIMARY KEY plus
-- INSERT OR IGNORE means the first delivery gets meta.changes = 1 and every
-- redelivery gets 0. A handler that fails deletes its own claim (releaseEvent)
-- so the retry can pick the work up again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,          -- Stripe evt_… id
  type         TEXT,                      -- e.g. checkout.session.completed
  status       TEXT NOT NULL,             -- 'processing' | 'done'
  claimed_at   INTEGER NOT NULL,          -- epoch ms
  completed_at INTEGER
);

-- Supports the cron sweep, which deletes by age.
CREATE INDEX IF NOT EXISTS webhook_events_claimed_at ON webhook_events (claimed_at);

-- ---------------------------------------------------------------------------
-- loyalty_ledger -- append-only Alt-Points ledger, keyed by normalised email.
--
-- Positive `points` is a credit, negative is a debit; the balance is SUM(points)
-- for the email. Rows are never updated or deleted.
--
-- `order_id` is UNIQUE so a redelivered order webhook cannot pay out twice.
-- SQLite treats NULLs as distinct in a UNIQUE index, so debit rows (which carry
-- NULL here and use `ref_id` instead) do not collide with each other.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,            -- lowercased, trimmed
  points     INTEGER NOT NULL,            -- signed: + credit, - debit
  order_id   TEXT UNIQUE,                 -- credits only; the idempotency key
  reason     TEXT,                        -- 'order', 'birthday', 'redemption'…
  ref_id     TEXT,                        -- debits only: the voucher/redemption id
  created_at INTEGER NOT NULL
);

-- balance() and statement() both filter by email; without this every read is a
-- full scan, and rows read is the metered resource on the free plan.
CREATE INDEX IF NOT EXISTS loyalty_ledger_email ON loyalty_ledger (email, id);

-- debit() checks this to refuse a repeated redemption reference.
CREATE INDEX IF NOT EXISTS loyalty_ledger_ref ON loyalty_ledger (ref_id);

-- ---------------------------------------------------------------------------
-- burned_tokens -- single-use enforcement for magic-link tokens.
--
-- Verification itself is stateless (HMAC), so this table is touched once per
-- successful link click and nothing else. `expires_at` is epoch SECONDS, matching
-- the token's own `exp` claim: once that passes, the row can be swept because the
-- token would be rejected on expiry anyway.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS burned_tokens (
  token_id   TEXT PRIMARY KEY,            -- the token's jti claim
  expires_at INTEGER NOT NULL,            -- epoch SECONDS
  burned_at  INTEGER NOT NULL             -- epoch ms
);

CREATE INDEX IF NOT EXISTS burned_tokens_expires_at ON burned_tokens (expires_at);
