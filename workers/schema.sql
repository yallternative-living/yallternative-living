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
-- orders (Stripe is the system of record -- the retention layer below keeps one
-- lightweight signal row per order, not a copy of it). D1 holds only what is
-- naturally sharded by a random key and never contended.
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

-- ---------------------------------------------------------------------------
-- RETENTION LAYER (schema version 2)
--
-- Everything below backs the post-purchase sequence, the abandoned-checkout
-- recovery mail, the birthday club and the loyalty payouts. The same rules as
-- above apply: append-only or idempotent-by-primary-key, indexed reads, and a
-- sweeper for anything that grows.
--
-- WHY D1 AND A CRON, NOT ONE DURABLE OBJECT ALARM PER ORDER.
-- The sends are day-scale (day 2-3, day 7-14, a birthday once a year), so
-- minute precision buys nothing. A DO-per-order costs one object plus one
-- alarm per order, its state cannot be listed or audited, and a dropped alarm
-- is silent. One `email_queue` table drained by the `scheduled` handler in
-- workers/checkout.js is a single indexed query per tick, is inspectable with
-- `wrangler d1 execute`, retries on its own, and reuses the cron handler that
-- already exists for the webhook sweep.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- order_signals -- ONE LIGHTWEIGHT ROW PER ORDER. Not a copy of the order:
-- Stripe stays the system of record (see the header of this file). This holds
-- only what a delayed email needs to be written -- who to write to, what they
-- bought, and when -- so the day-2 and day-10 sends do not have to call Stripe
-- back days later for data that may have been redacted by then.
--
-- `email_hash` is SHA-256 of the normalised address. It is what logs, metrics
-- and idempotency keys use, so an operational trace never carries the address
-- itself. `email` is still stored because an email cannot be sent to a hash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_signals (
  order_id    TEXT PRIMARY KEY,          -- Stripe Checkout Session id; the idempotency key
  email       TEXT NOT NULL,             -- lowercased, trimmed
  email_hash  TEXT NOT NULL,             -- sha256 hex of `email`
  product_ids TEXT,                      -- comma-joined product ids from the session
  categories  TEXT,                      -- comma-joined catalogue categories
  placed_at   INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX IF NOT EXISTS order_signals_email ON order_signals (email, placed_at);

-- ---------------------------------------------------------------------------
-- email_queue -- the send schedule. One row per (kind, subject) pair, with the
-- pair baked into `id` so INSERT OR IGNORE is the whole idempotency story: a
-- redelivered webhook re-enqueues nothing.
--
-- `payload` is JSON and holds only what the template renders (product ids, a
-- recovery URL, a promotion code). Never card data, never an address.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_queue (
  id         TEXT PRIMARY KEY,           -- e.g. "usage-guide:cs_test_123"
  kind       TEXT NOT NULL,              -- usage-guide | review-request | recovery | birthday | loyalty-reward
  email      TEXT NOT NULL,
  payload    TEXT,                       -- JSON
  send_after INTEGER NOT NULL,           -- epoch ms; the drain ignores anything later
  status     TEXT NOT NULL,              -- 'pending' | 'sent' | 'skipped' | 'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);

-- The drain's only query: pending rows whose time has come, oldest first.
CREATE INDEX IF NOT EXISTS email_queue_due ON email_queue (status, send_after);

-- ---------------------------------------------------------------------------
-- email_suppression -- the opt-out list, honoured by EVERY marketing send.
--
-- Checked in the drain, immediately before the Resend call, rather than at
-- enqueue time: someone who unsubscribes on day 3 must not receive the review
-- request that was queued for them on day 0.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_suppression (
  email      TEXT PRIMARY KEY,           -- lowercased, trimmed
  reason     TEXT,                       -- 'unsubscribe' | 'bounce' | 'manual'
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- email_contacts -- the opaque id an unsubscribe link carries.
--
-- The link must not contain the address (an unsubscribe URL ends up in logs,
-- proxies and screenshots), so it carries `unsub_id`: HMAC-SHA-256 of the
-- address under MAGIC_LINK_SECRET, truncated. It is stable, unguessable and
-- one-way, and this table is what turns it back into an address.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_contacts (
  unsub_id   TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- birthday_club -- MM-DD ONLY. No year, ever.
--
-- A month and day cannot be turned into an age, cannot answer a bank's
-- security question, and is not a date of birth for any privacy regime that
-- treats one specially. The form enforces MM/DD and so does the route; the
-- column is CHECKed as well so a future caller cannot widen it by accident.
-- `consent_at` is the record of when the person asked to be in the club.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS birthday_club (
  email      TEXT PRIMARY KEY,           -- lowercased, trimmed
  month_day  TEXT NOT NULL CHECK (length(month_day) = 5),
  consent_at INTEGER NOT NULL,           -- epoch ms
  source     TEXT                        -- 'thank-you' | 'admin' | ...
);

-- The daily cron reads by month_day and nothing else.
CREATE INDEX IF NOT EXISTS birthday_club_month_day ON birthday_club (month_day);

-- ---------------------------------------------------------------------------
-- welcome_codes -- one minted Stripe Promotion Code per subscriber address.
--
-- The row is the rate limit AND the idempotency key: a second request for the
-- same address returns the code that was already minted rather than minting a
-- second one, so refreshing welcome.html cannot spray promotion codes into the
-- Stripe account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS welcome_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,              -- the redeemable string Stripe generated
  promo_id   TEXT,                       -- promo_… id, for support lookups
  expires_at INTEGER NOT NULL,           -- epoch SECONDS, matching Stripe's expires_at
  created_at INTEGER NOT NULL            -- epoch ms
);

-- ---------------------------------------------------------------------------
-- ADVERSE EVENTS (schema version 3) -- the MoCRA reaction reports.
--
-- One row per submission of the form on /safety (workers/routes/safety-report.js).
-- MoCRA (21 U.S.C. 364a, FD&C Act section 609(a)) requires the label to carry a
-- contact through which a consumer can report an adverse event; this table is
-- what that contact writes to. The columns are the fields a MedWatch Form FDA
-- 3500A report needs, so a serious event can be forwarded to the FDA within 15
-- BUSINESS DAYS without going back to the reporter for anything.
--
-- RETENTION: THREE YEARS. MoCRA's retention rule is six years
-- (21 U.S.C. 364a(c)(2)), with three for small businesses under section 612 --
-- under $1M average gross annual sales over the prior three years. This shop is
-- under that threshold. IF THE THREE-YEAR AVERAGE EVER CROSSES $1M THE PERIOD
-- BECOMES SIX YEARS, here and in workers/routes/safety-report.js, safety.html
-- and privacy.html.
--
-- It is a MINIMUM, not a purge date, and NOTHING SWEEPS THIS TABLE. The cron in
-- workers/checkout.js deletes old rows from webhook_events, burned_tokens and
-- email_queue; do not add adverse_events to that list.
--
-- `serious` is computed server-side from `outcomes`, never taken from the
-- client. `ip_hash` is a salted SHA-256 prefix, so an abusive submitter can be
-- recognised without the address itself ever being stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adverse_events (
  id              TEXT PRIMARY KEY,        -- the reference, YL-AE-XXXX-XXXX
  created_at      INTEGER NOT NULL,        -- epoch ms; the 15-business-day clock starts here
  product_id      TEXT,                    -- catalogue id, or "other" / empty
  lot             TEXT,                    -- lot or batch number off the label
  channel         TEXT,                    -- 'site' | 'etsy' | 'in-person'
  first_use_date  TEXT,                    -- YYYY-MM-DD
  reaction_date   TEXT,                    -- YYYY-MM-DD
  body_area       TEXT,
  description     TEXT NOT NULL,           -- the reporter's own words
  outcomes        TEXT NOT NULL,           -- JSON array of outcome ids
  stopped_use     TEXT,                    -- 'yes' | 'no' | ''
  reporter_name   TEXT,
  reporter_email  TEXT NOT NULL,
  reporter_phone  TEXT,
  age_range       TEXT,
  sex             TEXT,
  contact_consent INTEGER NOT NULL DEFAULT 0,
  serious         INTEGER NOT NULL DEFAULT 0,  -- computed from `outcomes`
  status          TEXT NOT NULL,           -- 'new' | 'reviewed' | 'reported-to-fda'
  ip_hash         TEXT                     -- salted sha256 prefix; never the IP
);

-- The two reads the shop actually makes: "what is new and serious" and
-- "everything since <date>" when a record request arrives.
CREATE INDEX IF NOT EXISTS adverse_events_triage ON adverse_events (serious, status, created_at);
CREATE INDEX IF NOT EXISTS adverse_events_created_at ON adverse_events (created_at);

-- ---------------------------------------------------------------------------
-- v4 (2026-09-02): automation tables.
--
-- restock_signups: "tell me when it's back" now stores the address so the
-- hourly cron can email the shopper itself once the product is in stock (it
-- used to only tell the owner someone asked). notified_at set = done.
--
-- market_alert_subscribers: the events page's "email me the next market date"
-- form posts here instead of Kit, so the cron can send a day-before reminder
-- for each upcoming market. Unsubscribes go through the same suppression list
-- as every other marketing email.
--
-- job_state: one row per scheduled job -- the "last ran on <day>" marker that
-- keeps a daily/monthly job from running twice inside the hourly cron.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restock_signups (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  email        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  notified_at  INTEGER,
  UNIQUE (product_id, email)
);
CREATE INDEX IF NOT EXISTS restock_signups_pending ON restock_signups (product_id, notified_at);

CREATE TABLE IF NOT EXISTS market_alert_subscribers (
  email          TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  consent_text   TEXT NOT NULL,
  last_event_id  TEXT,
  last_sent_at   INTEGER
);

CREATE TABLE IF NOT EXISTS job_state (
  job         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
