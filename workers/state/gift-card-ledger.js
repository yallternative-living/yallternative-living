/**
 * @fileoverview GiftCardLedger -- the authoritative, server-side balance ledger
 * for one gift-card code, stored in a SQLite-backed Durable Object.
 *
 * WHY THIS EXISTS
 * Audit finding C-2: the cart-drawer gift-card path mints an ephemeral Stripe
 * coupon for min(total, balance) and never debits the source promotion code, so
 * two tabs (or two orders) spend the same card twice and the balance checker
 * keeps reporting the full amount. Stripe has no "reserve then settle" primitive
 * for stored-value promotion codes, so the reservation has to live somewhere we
 * control. A Durable Object gives us the one thing KV cannot: strong consistency
 * and single-threaded serialisation of every mutation for a given code.
 *
 * ONE OBJECT PER CODE
 * Callers address the object with `idFromName(normalizeCode(code))`. All
 * requests for a code therefore land on the same object, in one location, and
 * run one at a time. That -- not the SQL -- is what makes double-spend
 * impossible; the SQL below is the durable record of it.
 *
 * TRANSACTIONS: which primitive and why
 * Every mutation runs its SQL inside `ctx.storage.transactionSync(fn)`.
 * Two separate properties are at play and it is worth being precise:
 *   - ISOLATION is free. A Durable Object processes one event-loop turn at a
 *     time and none of the private `#...Sync` helpers below contain an `await`,
 *     so no other request can interleave between a read and its write. A plain
 *     read-check-then-write is already atomic here.
 *   - ATOMICITY is not free. A mutation touches two or three tables (`card`,
 *     `reservations`, `ledger`). Without an explicit transaction, a throw
 *     halfway through would leave the balance updated but the ledger row
 *     missing. `transactionSync` rolls the whole group back on throw, which is
 *     also how the guards below reject a bad mutation: they throw, and the
 *     partial writes vanish.
 * Belt and braces on top of that: `card.balance_cents` carries a
 * `CHECK (balance_cents >= 0)` constraint, so even a logic bug cannot persist a
 * negative balance -- SQLite refuses the write and the transaction unwinds.
 *
 * STORED BALANCE, NOT DERIVED
 * `card.balance_cents` is maintained in the same transaction that appends to the
 * append-only `ledger` table, rather than being recomputed as SUM(ledger.delta)
 * on every read. Durable Object SQLite bills by rows read, and a card used for
 * years would make every balance check cost more than the last. The ledger stays
 * the audit trail: `audit()` re-derives the balance from it and reports any
 * drift, and `history()` returns it verbatim.
 *
 * MONEY MODEL
 *   balance_cents  spendable right now
 *   pending        sum of active reservations (already deducted from balance)
 *   spent          sum of committed reservations
 *   invariant: initial + restored == balance + pending + spent
 *
 * Stripe remains the system of record for orders, sessions and the promotion
 * codes themselves. This object is the system of record for how much of a card
 * is left.
 */

/** Stripe Checkout Sessions live at most 24h; a reservation must not outlive one. */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Ledger entry kinds. `delta_cents` is always the effect on the spendable balance. */
export const LEDGER_KINDS = ["issue", "reserve", "commit", "release", "expire", "restore"];

export const GIFT_CARD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS card (
     code             TEXT    PRIMARY KEY,
     initial_cents    INTEGER NOT NULL CHECK (initial_cents > 0),
     balance_cents    INTEGER NOT NULL CHECK (balance_cents >= 0),
     recipient_email  TEXT,
     source           TEXT,
     stripe_promo_id  TEXT,
     issued_at        INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reservations (
     session_id     TEXT    PRIMARY KEY,
     reservation_id TEXT    NOT NULL UNIQUE,
     cents          INTEGER NOT NULL CHECK (cents > 0),
     state          TEXT    NOT NULL CHECK (state IN ('active','committed','released','expired')),
     created_at     INTEGER NOT NULL,
     expires_at     INTEGER NOT NULL,
     resolved_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS reservations_active ON reservations (state, expires_at)`,
  `CREATE TABLE IF NOT EXISTS restores (
     charge_id  TEXT    PRIMARY KEY,
     cents      INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ledger (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at    INTEGER NOT NULL,
     kind          TEXT    NOT NULL,
     delta_cents   INTEGER NOT NULL,
     balance_after INTEGER NOT NULL,
     reason        TEXT,
     external_id   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_external ON ledger (external_id)`
];

/** Methods the fetch dispatcher will route to. Anything else 404s. */
const RPC_METHODS = new Set([
  "issue",
  "getBalance",
  "reserve",
  "commit",
  "release",
  "restore",
  "history",
  "audit"
]);

const ERROR_STATUS = {
  invalid_code: 400,
  invalid_amount: 400,
  invalid_session: 400,
  invalid_charge: 400,
  not_issued: 404,
  already_issued: 409,
  reservation_exists: 409,
  reservation_not_found: 404,
  reservation_not_active: 409,
  insufficient_balance: 409
};

/** A refusal the caller is expected to handle; never a bug, never a 500. */
export class LedgerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "LedgerError";
    this.code = code;
    this.status = ERROR_STATUS[code] || 409;
  }
}

/**
 * Canonical form of a gift-card code. MUST be used before `idFromName` so that
 * "yall-gift50" and " YALL-GIFT50 " address the same object as "YALL-GIFT50".
 */
export function normalizeCode(code) {
  if (typeof code !== "string") throw new LedgerError("invalid_code", "Code must be a string.");
  const clean = code.trim().toUpperCase();
  if (!/^YALL-(?:PTS-)?[A-Z0-9]{6,16}$/.test(clean)) {
    throw new LedgerError("invalid_code", "Code is not a Y'allternative gift-card code.");
  }
  return clean;
}

function assertCents(value, field) {
  if (!Number.isInteger(value) || value <= 0 || value > 100000000) {
    throw new LedgerError("invalid_amount", `${field} must be a positive integer of cents.`);
  }
  return value;
}

function assertId(value, code, field) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 255) {
    throw new LedgerError(code, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export class GiftCardLedger {
  /**
   * @param {object} ctx Durable Object state: `storage.sql`, `storage.setAlarm`
   * @param {object} env Worker bindings (unused today; kept for phase B)
   */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    // Schema creation is synchronous on DO SQLite, so it can run in the
    // constructor -- no blockConcurrencyWhile needed and no per-request check.
    for (const statement of GIFT_CARD_SCHEMA) this.sql.exec(statement);
  }

  /* ---------------------------------------------------------------- reads */

  /** @returns {Promise<object>} spendable balance plus the pending/spent split. */
  async getBalance() {
    return this.#snapshot();
  }

  /** @returns {Promise<object>} the card row, its reservations and the full ledger. */
  async history() {
    return {
      card: this.#card(),
      reservations: this.sql.exec("SELECT * FROM reservations ORDER BY created_at ASC").toArray(),
      ledger: this.sql.exec("SELECT * FROM ledger ORDER BY id ASC").toArray()
    };
  }

  /**
   * Re-derives the balance from the append-only ledger and compares it with the
   * stored one. Used by the tests and available as an operational spot-check.
   */
  async audit() {
    const card = this.#card();
    const derived = this.sql
      .exec("SELECT COALESCE(SUM(delta_cents), 0) AS total FROM ledger")
      .toArray()[0].total;
    const stored = card ? card.balance_cents : 0;
    const snapshot = this.#snapshot();
    const conserved = card
      ? card.initial_cents + snapshot.restoredCents ===
        snapshot.balanceCents + snapshot.pendingCents + snapshot.spentCents
      : true;
    return { ok: derived === stored && conserved, derivedCents: derived, storedCents: stored };
  }

  /* ------------------------------------------------------------- mutations */

  /**
   * Records a newly sold (or newly minted) card. A code may be issued once;
   * a byte-identical replay -- a retried Stripe webhook -- is a no-op rather
   * than an error, so callers do not have to distinguish the two.
   *
   * @param {{code: string, initialCents: number, recipientEmail?: string,
   *          source?: string, stripePromoId?: string}} args
   */
  async issue(args) {
    const params = args || {};
    const code = normalizeCode(params.code);
    const initialCents = assertCents(params.initialCents, "initialCents");
    const recipientEmail =
      typeof params.recipientEmail === "string" ? params.recipientEmail.trim().toLowerCase() : null;
    const source = typeof params.source === "string" ? params.source.slice(0, 64) : null;
    const promoId = typeof params.stripePromoId === "string" ? params.stripePromoId : null;

    const existing = this.#card();
    if (existing) {
      const identical =
        existing.code === code &&
        existing.initial_cents === initialCents &&
        (existing.stripe_promo_id || null) === promoId;
      if (identical) return { ...this.#snapshot(), alreadyIssued: true };
      throw new LedgerError("already_issued", "This gift-card code has already been issued.");
    }

    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO card
           (code, initial_cents, balance_cents, recipient_email, source, stripe_promo_id, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        code,
        initialCents,
        initialCents,
        recipientEmail,
        source,
        promoId,
        now
      );
      this.#appendSync(now, "issue", initialCents, initialCents, source || "issued", promoId);
    });
    return { ...this.#snapshot(), alreadyIssued: false };
  }

  /**
   * Holds `cents` against the card for one Checkout Session. Atomic: it either
   * takes the whole amount or refuses. Refuses when the card is unknown, when
   * the spendable balance is short, or when this session already holds a
   * reservation -- a second tab therefore cannot stack a second hold.
   *
   * @param {{sessionId: string, cents: number}} args
   * @returns {Promise<{reservationId: string, reservedCents: number, remainingCents: number}>}
   */
  async reserve(args) {
    const params = args || {};
    const sessionId = assertId(params.sessionId, "invalid_session", "sessionId");
    const cents = assertCents(params.cents, "cents");
    const now = Date.now();
    const expiresAt = now + RESERVATION_TTL_MS;
    const reservationId = `res_${now.toString(36)}_${sessionId.slice(-12)}`;

    const result = this.ctx.storage.transactionSync(() => {
      const card = this.#card();
      if (!card) throw new LedgerError("not_issued", "Unknown gift-card code.");

      // Sweep first: a hold from an abandoned session that is already past its
      // 24h life must not keep funds locked just because the alarm has not run.
      this.#expireStaleSync(now);

      const prior = this.sql
        .exec("SELECT state FROM reservations WHERE session_id = ?", sessionId)
        .toArray()[0];
      if (prior && prior.state === "active") {
        throw new LedgerError("reservation_exists", "This session already holds a reservation.");
      }
      if (prior && prior.state === "committed") {
        throw new LedgerError("reservation_exists", "This session has already been charged.");
      }

      // Conditional debit: the WHERE clause is the real guard. Combined with the
      // CHECK constraint on balance_cents there is no path to a negative balance.
      const write = this.sql.exec(
        `UPDATE card SET balance_cents = balance_cents - ?
          WHERE code = ? AND balance_cents >= ?`,
        cents,
        card.code,
        cents
      );
      if (!write.rowsWritten) {
        throw new LedgerError("insufficient_balance", "Gift card balance is too low.");
      }

      this.sql.exec(
        `INSERT INTO reservations
           (session_id, reservation_id, cents, state, created_at, expires_at)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           reservation_id = excluded.reservation_id,
           cents          = excluded.cents,
           state          = 'active',
           created_at     = excluded.created_at,
           expires_at     = excluded.expires_at,
           resolved_at    = NULL`,
        sessionId,
        reservationId,
        cents,
        now,
        expiresAt
      );

      const remaining = this.#card().balance_cents;
      this.#appendSync(now, "reserve", -cents, remaining, "checkout_session", sessionId);
      return { reservationId, reservedCents: cents, remainingCents: remaining, expiresAt };
    });

    await this.#rescheduleAlarm();
    return result;
  }

  /**
   * Turns an active hold into a permanent debit. Idempotent: a webhook redelivery
   * of `checkout.session.completed` returns the same answer without moving money.
   *
   * @param {{sessionId: string}} args
   */
  async commit(args) {
    const sessionId = assertId((args || {}).sessionId, "invalid_session", "sessionId");
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec("SELECT * FROM reservations WHERE session_id = ?", sessionId)
        .toArray()[0];
      if (!row) throw new LedgerError("reservation_not_found", "No reservation for that session.");
      if (row.state === "committed") {
        return { committed: true, alreadyCommitted: true, cents: row.cents };
      }
      if (row.state !== "active") {
        throw new LedgerError(
          "reservation_not_active",
          `Reservation is ${row.state}; it cannot be committed.`
        );
      }
      this.sql.exec(
        "UPDATE reservations SET state = 'committed', resolved_at = ? WHERE session_id = ?",
        now,
        sessionId
      );
      // The funds left the spendable balance at reserve() time, so committing
      // moves no money -- delta 0. The row exists so the ledger tells the whole
      // story of the card without having to join the reservations table.
      const balance = this.#card().balance_cents;
      this.#appendSync(now, "commit", 0, balance, "order_paid", sessionId);
      return { committed: true, alreadyCommitted: false, cents: row.cents };
    });
    await this.#rescheduleAlarm();
    return result;
  }

  /**
   * Returns an unspent hold to the card. Idempotent, and deliberately forgiving:
   * `checkout.session.expired` fires for sessions that never reserved anything,
   * and a committed reservation is never quietly un-charged.
   *
   * @param {{sessionId: string, reason?: string}} args
   */
  async release(args) {
    const params = args || {};
    const sessionId = assertId(params.sessionId, "invalid_session", "sessionId");
    const reason = typeof params.reason === "string" ? params.reason.slice(0, 64) : "released";
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec("SELECT * FROM reservations WHERE session_id = ?", sessionId)
        .toArray()[0];
      if (!row) return { released: false, reason: "not_found" };
      if (row.state === "committed") return { released: false, reason: "committed" };
      if (row.state !== "active") return { released: false, reason: "already_resolved" };
      return this.#releaseRowSync(row, now, "release", reason);
    });
    await this.#rescheduleAlarm();
    return result;
  }

  /**
   * Puts refunded money back on the card. Idempotent per `chargeId`: the first
   * write of the charge id wins and a redelivered refund event is a no-op.
   *
   * @param {{chargeId: string, cents: number}} args
   */
  async restore(args) {
    const params = args || {};
    const chargeId = assertId(params.chargeId, "invalid_charge", "chargeId");
    const cents = assertCents(params.cents, "cents");
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const card = this.#card();
      if (!card) throw new LedgerError("not_issued", "Unknown gift-card code.");
      const claim = this.sql.exec(
        "INSERT OR IGNORE INTO restores (charge_id, cents, created_at) VALUES (?, ?, ?)",
        chargeId,
        cents,
        now
      );
      if (!claim.rowsWritten) {
        return { ...this.#snapshot(), restored: false, alreadyRestored: true };
      }
      this.sql.exec(
        "UPDATE card SET balance_cents = balance_cents + ? WHERE code = ?",
        cents,
        card.code
      );
      const balance = this.#card().balance_cents;
      this.#appendSync(now, "restore", cents, balance, "refund", chargeId);
      return { ...this.#snapshot(), restored: true, alreadyRestored: false };
    });
  }

  /* ----------------------------------------------------------------- alarm */

  /** Releases every hold whose 24h life has run out, then re-arms for the next. */
  async alarm() {
    const now = Date.now();
    const expired = this.ctx.storage.transactionSync(() => this.#expireStaleSync(now));
    await this.#rescheduleAlarm();
    return { expired };
  }

  /* ------------------------------------------------------------- transport */

  /**
   * HTTP transport, so the class works as a plain Durable Object without the
   * `cloudflare:workers` RPC base class (which cannot be imported by the Node
   * test harness). Phase B may instead `extends DurableObject` and call the
   * methods directly; the method signatures are identical either way.
   */
  async fetch(request) {
    const method = new URL(request.url).pathname.replace(/^\/+/, "");
    if (!RPC_METHODS.has(method)) {
      return jsonResponse({ ok: false, error: "unknown_method" }, 404);
    }
    let args = {};
    if (request.method === "POST") {
      args = await request.json().catch(() => ({}));
    }
    try {
      return jsonResponse({ ok: true, result: await this[method](args) }, 200);
    } catch (err) {
      if (err instanceof LedgerError) {
        return jsonResponse({ ok: false, error: err.code, message: err.message }, err.status);
      }
      throw err;
    }
  }

  /* --------------------------------------------------------------- private */

  #card() {
    return this.sql.exec("SELECT * FROM card LIMIT 1").toArray()[0] || null;
  }

  #snapshot() {
    const card = this.#card();
    if (!card) return { issued: false, balanceCents: 0, pendingCents: 0, spentCents: 0 };
    const sums = this.sql
      .exec(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'active'    THEN cents END), 0) AS pending,
           COALESCE(SUM(CASE WHEN state = 'committed' THEN cents END), 0) AS spent
         FROM reservations`
      )
      .toArray()[0];
    const restored = this.sql
      .exec("SELECT COALESCE(SUM(cents), 0) AS total FROM restores")
      .toArray()[0].total;
    return {
      issued: true,
      code: card.code,
      balanceCents: card.balance_cents,
      pendingCents: sums.pending,
      spentCents: sums.spent,
      restoredCents: restored,
      initialCents: card.initial_cents,
      recipientEmail: card.recipient_email,
      stripePromoId: card.stripe_promo_id,
      issuedAt: card.issued_at
    };
  }

  #appendSync(now, kind, delta, balanceAfter, reason, externalId) {
    this.sql.exec(
      `INSERT INTO ledger (created_at, kind, delta_cents, balance_after, reason, external_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      now,
      kind,
      delta,
      balanceAfter,
      reason || null,
      externalId || null
    );
  }

  #releaseRowSync(row, now, kind, reason) {
    this.sql.exec(
      "UPDATE card SET balance_cents = balance_cents + ? WHERE code = (SELECT code FROM card)",
      row.cents
    );
    this.sql.exec(
      "UPDATE reservations SET state = ?, resolved_at = ? WHERE session_id = ?",
      kind === "expire" ? "expired" : "released",
      now,
      row.session_id
    );
    const balance = this.#card().balance_cents;
    this.#appendSync(now, kind, row.cents, balance, reason, row.session_id);
    return { released: true, cents: row.cents, remainingCents: balance };
  }

  #expireStaleSync(now) {
    const stale = this.sql
      .exec("SELECT * FROM reservations WHERE state = 'active' AND expires_at <= ?", now)
      .toArray();
    for (const row of stale) this.#releaseRowSync(row, now, "expire", "reservation_expired");
    return stale.length;
  }

  async #rescheduleAlarm() {
    const next = this.sql
      .exec("SELECT MIN(expires_at) AS next FROM reservations WHERE state = 'active'")
      .toArray()[0].next;
    if (next != null) {
      await this.ctx.storage.setAlarm(next);
    } else if (typeof this.ctx.storage.deleteAlarm === "function") {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

/**
 * Thin client for the Worker side: `giftCardLedger(env, code).reserve({...})`.
 * Hides `idFromName` + the fetch envelope and re-throws refusals as LedgerError
 * so calling code sees the same errors it would with direct RPC.
 */
export function giftCardLedger(env, code, bindingName = "GIFT_CARD_LEDGER") {
  const normalized = normalizeCode(code);
  const ns = env[bindingName];
  if (!ns) throw new LedgerError("not_issued", `Missing Durable Object binding ${bindingName}.`);
  const stub = ns.get(ns.idFromName(normalized));
  const call = async (method, args) => {
    const res = await stub.fetch(`https://gift-card-ledger/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {})
    });
    const body = await res.json();
    if (!body.ok) throw new LedgerError(body.error, body.message);
    return body.result;
  };
  return {
    code: normalized,
    issue: (args) => call("issue", { ...args, code: normalized }),
    getBalance: () => call("getBalance", {}),
    reserve: (args) => call("reserve", args),
    commit: (args) => call("commit", args),
    release: (args) => call("release", args),
    restore: (args) => call("restore", args),
    history: () => call("history", {}),
    audit: () => call("audit", {})
  };
}
