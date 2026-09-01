/**
 * @fileoverview Unit test suite for the Cloudflare state layer in workers/state/:
 *   - gift-card-ledger.js  (Durable Object, SQLite storage)
 *   - webhook-events.js    (D1, exactly-once webhook claiming)
 *   - loyalty.js           (D1, append-only points ledger)
 *   - magic-link.js        (WebCrypto HMAC tokens + D1 single-use burn)
 *   - rate-limit.js        (binding path + Durable Object fallback)
 *   - stripe-orders.js     (Stripe lookup, sanitised)
 *   - migrations.js        (idempotent schema application)
 *
 * No network and no wrangler. D1 and Durable Object SQLite are both emulated on
 * Node's built-in `node:sqlite`, exposing the same call shapes the real bindings
 * do (`prepare().bind().run()` with `meta.changes`; `storage.sql.exec()` with
 * `.toArray()`/`.rowsWritten`; `storage.transactionSync`; `storage.setAlarm`).
 * If the emulator and the real binding ever disagree, that is a bug in this
 * file -- the shapes are asserted against the documented D1/DO APIs.
 *
 * Run: node scripts/worker-state.test.js
 */

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

async function throwsAsync(fn, expectedCode, label) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${label} (expected a throw, but it resolved)`);
  } catch (err) {
    const code = err && (err.code || err.message);
    if (!expectedCode || String(code).includes(expectedCode)) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${label}\n      expected code "${expectedCode}"\n      got "${code}"`);
    }
  }
}

/* ==========================================================================
   D1 emulator.

   The real binding: db.prepare(sql).bind(...).run() -> { success, meta:
   { changes, last_row_id } }, .first() -> row | null, .all() -> { results }.
   node:sqlite's StatementSync gives us changes/lastInsertRowid directly.
   ========================================================================== */

function isRead(sql) {
  return /^\s*(select|with)\b/i.test(sql);
}

function makeD1(db) {
  function statement(sql, params) {
    return {
      bind(...args) {
        return statement(sql, args);
      },
      async run() {
        const stmt = db.prepare(sql);
        if (isRead(sql)) {
          stmt.all(...params);
          return { success: true, meta: { changes: 0, last_row_id: 0 } };
        }
        const info = stmt.run(...params);
        return {
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }
        };
      },
      async first(column) {
        const row = db.prepare(sql).get(...params);
        if (row === undefined || row === null) return null;
        return column ? row[column] : row;
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...params), meta: {} };
      }
    };
  }
  return {
    prepare(sql) {
      return statement(sql, []);
    },
    async batch(statements) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
    _raw: db
  };
}

/* ==========================================================================
   Durable Object storage emulator: ctx.storage.sql.exec(...) with .toArray()
   and .rowsWritten, ctx.storage.transactionSync (savepoint-nested), and
   setAlarm/deleteAlarm as recording stubs.
   ========================================================================== */

function makeDurableCtx() {
  const db = new DatabaseSync(":memory:");
  const alarm = { at: null, sets: 0, deletes: 0 };
  let depth = 0;

  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (isRead(query)) {
        const rows = stmt.all(...bindings);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error("expected exactly one row");
            return rows[0];
          },
          rowsRead: rows.length,
          rowsWritten: 0
        };
      }
      const info = stmt.run(...bindings);
      return {
        toArray: () => [],
        one: () => {
          throw new Error("no rows");
        },
        rowsRead: 0,
        rowsWritten: Number(info.changes)
      };
    }
  };

  return {
    storage: {
      sql,
      transactionSync(fn) {
        const name = `sp_${depth}`;
        db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
        depth++;
        try {
          const result = fn();
          depth--;
          db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
          return result;
        } catch (err) {
          depth--;
          db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}`);
          throw err;
        }
      },
      async setAlarm(at) {
        alarm.at = at;
        alarm.sets++;
      },
      async deleteAlarm() {
        alarm.at = null;
        alarm.deletes++;
      },
      async deleteAll() {
        db.exec("DELETE FROM windows");
      }
    },
    _alarm: alarm,
    _db: db
  };
}

/** A Durable Object namespace binding over real class instances, kept in a Map. */
function makeNamespace(ClassRef, env = {}) {
  const instances = new Map();
  return {
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      if (!instances.has(id.name)) instances.set(id.name, new ClassRef(makeDurableCtx(), env));
      const instance = instances.get(id.name);
      return {
        fetch: (url, init) => instance.fetch(new Request(url, init)),
        _instance: instance
      };
    },
    _instances: instances
  };
}

/* ==========================================================================
   1. GiftCardLedger -- issue, reserve, commit, release, restore, expiry
   ========================================================================== */

async function testGiftCardLedger() {
  console.log("\n1. GiftCardLedger (Durable Object, SQLite)");
  const mod = await import("../workers/state/gift-card-ledger.js");
  const { GiftCardLedger, LedgerError, normalizeCode, RESERVATION_TTL_MS } = mod;

  eq(normalizeCode(" yall-gift50 "), "YALL-GIFT50", "normalizeCode upper-cases and trims");
  await throwsAsync(
    async () => normalizeCode("NOT-A-CODE"),
    "invalid_code",
    "normalizeCode rejects a foreign code"
  );
  assert(
    new LedgerError("insufficient_balance").status === 409,
    "LedgerError carries an HTTP status"
  );

  // --- issue -------------------------------------------------------------
  let ctx = makeDurableCtx();
  let card = new GiftCardLedger(ctx, {});
  const issued = await card.issue({
    code: "YALL-GIFT50",
    initialCents: 5000,
    recipientEmail: "Recipient@Example.com",
    source: "checkout",
    stripePromoId: "promo_123"
  });
  eq(issued.balanceCents, 5000, "issue() sets the opening balance");
  eq(issued.recipientEmail, "recipient@example.com", "issue() lowercases the recipient email");
  eq(issued.alreadyIssued, false, "issue() reports a first issue");

  const replay = await card.issue({
    code: "yall-gift50",
    initialCents: 5000,
    stripePromoId: "promo_123"
  });
  eq(replay.alreadyIssued, true, "a byte-identical re-issue is an idempotent no-op");
  eq(replay.balanceCents, 5000, "the idempotent re-issue does not double the balance");

  await throwsAsync(
    () => card.issue({ code: "YALL-GIFT50", initialCents: 9900 }),
    "already_issued",
    "a code cannot be re-issued with different terms"
  );

  // --- reserve -----------------------------------------------------------
  const held = await card.reserve({ sessionId: "cs_test_A", cents: 2600 });
  eq(held.reservedCents, 2600, "reserve() holds the requested amount");
  eq(held.remainingCents, 2400, "reserve() deducts the hold from the spendable balance");
  assert(
    typeof held.reservationId === "string" && held.reservationId.length > 4,
    "reserve() returns a reservationId"
  );
  assert(ctx._alarm.at === held.expiresAt, "reserve() arms the expiry alarm");
  assert(
    held.expiresAt - Date.now() > RESERVATION_TTL_MS - 5000,
    "the reservation expires roughly 24h out (Stripe session max life)"
  );

  let snapshot = await card.getBalance();
  eq(snapshot.pendingCents, 2600, "the held amount shows as pending");
  eq(snapshot.spentCents, 0, "nothing is spent before commit");

  await throwsAsync(
    () => card.reserve({ sessionId: "cs_test_A", cents: 100 }),
    "reservation_exists",
    "a second reserve for the SAME session is refused (no stacking from a second tab)"
  );

  await throwsAsync(
    () => card.reserve({ sessionId: "cs_test_B", cents: 2500 }),
    "insufficient_balance",
    "two sessions cannot together exceed the balance"
  );
  eq((await card.getBalance()).balanceCents, 2400, "the refused reserve moved no money");

  const second = await card.reserve({ sessionId: "cs_test_B", cents: 2400 });
  eq(second.remainingCents, 0, "the rest of the card can still be reserved by another session");
  await throwsAsync(
    () => card.reserve({ sessionId: "cs_test_C", cents: 1 }),
    "insufficient_balance",
    "an empty card refuses even one more cent"
  );

  // --- negative balance is structurally impossible -----------------------
  let checkRejected = false;
  try {
    ctx.storage.sql.exec("UPDATE card SET balance_cents = -1 WHERE code = 'YALL-GIFT50'");
  } catch {
    checkRejected = true;
  }
  assert(checkRejected, "SQLite CHECK constraint refuses a negative balance even via raw SQL");
  eq((await card.getBalance()).balanceCents, 0, "the balance survived the rejected raw write");

  // --- commit ------------------------------------------------------------
  const committed = await card.commit({ sessionId: "cs_test_A" });
  eq(committed.alreadyCommitted, false, "commit() settles an active hold");
  const recommitted = await card.commit({ sessionId: "cs_test_A" });
  eq(recommitted.alreadyCommitted, true, "commit() is idempotent for a webhook redelivery");
  snapshot = await card.getBalance();
  eq(snapshot.spentCents, 2600, "committed funds move from pending to spent");
  eq(snapshot.pendingCents, 2400, "the other session's hold is untouched by the commit");

  // --- release -----------------------------------------------------------
  const released = await card.release({ sessionId: "cs_test_B", reason: "session_expired" });
  eq(released.released, true, "release() returns an abandoned hold");
  eq(released.remainingCents, 2400, "released funds are spendable again");
  eq(
    await card.release({ sessionId: "cs_test_B" }),
    { released: false, reason: "already_resolved" },
    "release() is idempotent"
  );
  eq(
    await card.release({ sessionId: "cs_test_A" }),
    { released: false, reason: "committed" },
    "release() never un-charges a committed order"
  );
  eq(
    await card.release({ sessionId: "cs_never_seen" }),
    { released: false, reason: "not_found" },
    "release() tolerates a session that never reserved (checkout.session.expired noise)"
  );

  // --- restore -----------------------------------------------------------
  const restored = await card.restore({ chargeId: "ch_refund_1", cents: 1000 });
  eq(restored.restored, true, "restore() credits a refund back to the card");
  eq(restored.balanceCents, 3400, "restore() adds to the spendable balance");
  const restoreReplay = await card.restore({ chargeId: "ch_refund_1", cents: 1000 });
  eq(restoreReplay.alreadyRestored, true, "restore() is idempotent per chargeId");
  eq(restoreReplay.balanceCents, 3400, "the replayed restore added nothing");
  const otherRefund = await card.restore({ chargeId: "ch_refund_2", cents: 500 });
  eq(otherRefund.balanceCents, 3900, "a different chargeId restores independently");

  // --- ledger + invariants ----------------------------------------------
  const history = await card.history();
  eq(
    history.ledger.map((row) => row.kind),
    ["issue", "reserve", "reserve", "commit", "release", "restore", "restore"],
    "every mutation appended one ledger row, in order, and nothing else did"
  );
  assert(
    history.ledger.every((row) => typeof row.kind === "string" && row.created_at > 0),
    "ledger rows carry a kind and a timestamp"
  );
  assert(
    history.ledger.some((row) => row.external_id === "ch_refund_1" && row.kind === "restore"),
    "the ledger records the external id behind each mutation"
  );
  const audited = await card.audit();
  eq(audited.ok, true, "balance re-derived from the append-only ledger matches the stored balance");
  eq(audited.derivedCents, audited.storedCents, "no drift between ledger and stored balance");

  const totals = await card.getBalance();
  eq(
    totals.initialCents + totals.restoredCents,
    totals.balanceCents + totals.pendingCents + totals.spentCents,
    "value is conserved: initial + restored == balance + pending + spent"
  );

  // --- alarm expiry ------------------------------------------------------
  ctx = makeDurableCtx();
  card = new GiftCardLedger(ctx, {});
  await card.issue({ code: "YALL-EXPIRE1", initialCents: 4000 });
  await card.reserve({ sessionId: "cs_stale", cents: 3000 });
  eq((await card.getBalance()).balanceCents, 1000, "hold reduces the balance before expiry");
  ctx.storage.sql.exec("UPDATE reservations SET expires_at = ? WHERE session_id = 'cs_stale'", 1);
  const swept = await card.alarm();
  eq(swept.expired, 1, "the alarm expires a hold past its 24h life");
  eq((await card.getBalance()).balanceCents, 4000, "an expired hold returns the money");
  eq(ctx._alarm.at, null, "with nothing left to expire, the alarm is cleared");
  eq((await card.audit()).ok, true, "the ledger still reconciles after an expiry");

  // A reserve arriving after the deadline but before the alarm still sees a
  // correct balance, because reserve() sweeps first.
  await card.reserve({ sessionId: "cs_late", cents: 4000 });
  ctx.storage.sql.exec("UPDATE reservations SET expires_at = ? WHERE session_id = 'cs_late'", 1);
  const afterSweep = await card.reserve({ sessionId: "cs_next", cents: 4000 });
  eq(afterSweep.reservedCents, 4000, "reserve() sweeps stale holds before judging the balance");

  // --- fetch transport + client stub -------------------------------------
  const ns = makeNamespace(GiftCardLedger);
  const client = mod.giftCardLedger({ GIFT_CARD_LEDGER: ns }, "yall-stub01");
  eq(client.code, "YALL-STUB01", "the client normalises the code before idFromName");
  await client.issue({ initialCents: 2000 });
  const viaStub = await client.reserve({ sessionId: "cs_stub", cents: 500 });
  eq(viaStub.remainingCents, 1500, "the fetch transport round-trips a reserve");
  await throwsAsync(
    () => client.reserve({ sessionId: "cs_stub2", cents: 999999 }),
    "insufficient_balance",
    "the fetch transport re-throws refusals as LedgerError"
  );
  const sameObject = mod.giftCardLedger({ GIFT_CARD_LEDGER: ns }, " YALL-STUB01 ");
  eq(
    (await sameObject.getBalance()).balanceCents,
    1500,
    "a differently-cased code addresses the same Durable Object"
  );
  const unknown = await ns.get(ns.idFromName("YALL-STUB01")).fetch("https://x/dropTable", {
    method: "POST"
  });
  eq(unknown.status, 404, "the fetch dispatcher refuses any method not on the allowlist");
}

/* ==========================================================================
   2. webhook-events -- exactly-once claiming
   ========================================================================== */

async function testWebhookEvents(makeDb) {
  console.log("\n2. webhook-events (D1 exactly-once claim)");
  const { claimEvent, markEventDone, releaseEvent, getEvent, sweepOldEvents } =
    await import("../workers/state/webhook-events.js");
  const db = await makeDb();

  const first = await claimEvent(db, "evt_1", "checkout.session.completed");
  const second = await claimEvent(db, "evt_1", "checkout.session.completed");
  eq(first, true, "the first delivery claims the event");
  eq(second, false, "a redelivery of the same event id is refused");

  const claims = await Promise.all([
    claimEvent(db, "evt_race", "charge.refunded"),
    claimEvent(db, "evt_race", "charge.refunded"),
    claimEvent(db, "evt_race", "charge.refunded")
  ]);
  eq(claims.filter(Boolean).length, 1, "three simultaneous deliveries produce exactly one claim");

  eq(await markEventDone(db, "evt_1"), true, "markEventDone closes a processing claim");
  eq(await markEventDone(db, "evt_1"), false, "markEventDone is a no-op the second time");
  eq((await getEvent(db, "evt_1")).status, "done", "the row records the done status");
  eq(await claimEvent(db, "evt_1", "x"), false, "a finished event can never be re-claimed");

  eq(await claimEvent(db, "evt_fail", "charge.refunded"), true, "a failing handler claims first");
  eq(await releaseEvent(db, "evt_fail"), true, "releaseEvent gives a failed claim back");
  eq(await claimEvent(db, "evt_fail", "charge.refunded"), true, "Stripe's retry can then re-claim");
  eq(await releaseEvent(db, "evt_1"), false, "releaseEvent will not un-finish a done event");

  const now = Date.now();
  await claimEvent(db, "evt_old", "old", now - 40 * 24 * 60 * 60 * 1000);
  eq(await sweepOldEvents(db, 30, now), 1, "the cron sweep drops rows past the retention window");
  eq(await getEvent(db, "evt_old"), null, "the swept row is gone");
  assert((await getEvent(db, "evt_1")) !== null, "the sweep left recent rows alone");

  await throwsAsync(
    () => claimEvent(db, "evt bad id!", "x"),
    "Stripe-style id",
    "claimEvent rejects a malformed event id"
  );
}

/* ==========================================================================
   3. loyalty -- append-only points ledger
   ========================================================================== */

async function testLoyalty(makeDb) {
  console.log("\n3. loyalty (D1 append-only points ledger)");
  const { credit, debit, balance, statement, normalizeEmail } =
    await import("../workers/state/loyalty.js");
  const db = await makeDb();

  eq(normalizeEmail("  Shopper@Example.COM "), "shopper@example.com", "emails are normalised");
  await throwsAsync(
    async () => normalizeEmail("not-an-email"),
    "valid address",
    "an invalid email is refused before it can key a ledger row"
  );

  const email = "Shopper@Example.com";
  eq(await balance(db, email), 0, "an unknown customer has no points");

  const credited = await credit(db, { email, points: 120, orderId: "cs_order_1" });
  eq(credited.credited, true, "credit() awards points for an order");
  eq(credited.balance, 120, "the balance reflects the credit");

  const dupe = await credit(db, {
    email: "SHOPPER@example.com",
    points: 120,
    orderId: "cs_order_1"
  });
  eq(dupe.credited, false, "a redelivered order webhook does not pay out twice");
  eq(dupe.duplicate, true, "the duplicate is reported as such");
  eq(dupe.balance, 120, "the balance is unchanged by the duplicate");

  await credit(db, { email, points: 380, orderId: "cs_order_2", reason: "order" });
  eq(await balance(db, email), 500, "credits accumulate");

  const overdraw = await debit(db, {
    email,
    points: 501,
    reason: "redemption",
    refId: "YALL-PTS-AAAAAA"
  });
  eq(overdraw.ok, false, "a debit larger than the balance is refused");
  eq(overdraw.reason, "insufficient", "the refusal says why");
  eq(await balance(db, email), 500, "the refused debit wrote nothing");

  const spend = await debit(db, {
    email,
    points: 500,
    reason: "redemption",
    refId: "YALL-PTS-BBBBBB"
  });
  eq(spend.ok, true, "a debit within the balance succeeds");
  eq(spend.balance, 0, "the balance drops to zero");

  const replay = await debit(db, {
    email,
    points: 500,
    reason: "redemption",
    refId: "YALL-PTS-BBBBBB"
  });
  eq(replay.ok, false, "a repeated redemption reference is refused");
  eq(replay.reason, "duplicate", "the repeat is reported as a duplicate, not as insufficient");

  await credit(db, { email, points: 200, orderId: "cs_order_3" });
  const races = await Promise.all([
    debit(db, { email, points: 200, reason: "redemption", refId: "ref_race_1" }),
    debit(db, { email, points: 200, reason: "redemption", refId: "ref_race_2" })
  ]);
  eq(races.filter((r) => r.ok).length, 1, "two racing redemptions of the whole balance: one wins");
  eq(await balance(db, email), 0, "the balance never goes negative");

  const stmt = await statement(db, email);
  eq(stmt.balance, 0, "statement() reports the balance");
  eq(stmt.entries.length, 5, "statement() lists every credit and debit, append-only");
  assert(
    stmt.entries.every((row) => row.created_at > 0),
    "every ledger row carries a timestamp"
  );

  const other = await credit(db, { email: "other@example.com", points: 50, orderId: "cs_order_9" });
  eq(other.balance, 50, "ledgers are isolated per email");
  eq(await balance(db, email), 0, "another customer's credit did not leak in");
}

/* ==========================================================================
   4. magic-link -- HMAC tokens and single-use burn
   ========================================================================== */

async function testMagicLink(makeDb) {
  console.log("\n4. magic-link (WebCrypto HMAC + single-use burn)");
  const { signToken, verifyToken, burnToken, sweepBurnedTokens } =
    await import("../workers/state/magic-link.js");
  const db = await makeDb();
  const secret = "test-secret-value-at-least-16-chars";

  const minted = await signToken(secret, {
    email: "Shopper@Example.com",
    purpose: "points",
    ttlSeconds: 900
  });
  assert(minted.token.startsWith("v1."), "the token is version-prefixed");
  eq(minted.token.split(".").length, 3, "the token has three dot-separated parts");
  assert(!/[+/=]/.test(minted.token), "the token is base64url, safe in a URL");
  eq(minted.email, "shopper@example.com", "the signed email is normalised");

  const ok = await verifyToken(secret, minted.token);
  eq(ok.valid, true, "a fresh token verifies");
  eq(ok.email, "shopper@example.com", "verification returns the email claim");
  eq(ok.purpose, "points", "verification returns the purpose claim");
  eq(ok.tokenId, minted.tokenId, "verification returns the jti used for burning");

  eq(
    (await verifyToken("a-completely-different-secret-x", minted.token)).reason,
    "bad_signature",
    "a token signed with another secret is rejected"
  );

  const parts = minted.token.split(".");
  const tamperedPayload = await signToken(secret, {
    email: "attacker@evil.test",
    purpose: "points"
  });
  eq(
    (await verifyToken(secret, `${parts[0]}.${tamperedPayload.token.split(".")[1]}.${parts[2]}`))
      .reason,
    "bad_signature",
    "swapping the payload under a valid signature is rejected"
  );
  eq(
    (await verifyToken(secret, `${parts[0]}.${parts[1]}.${"A".repeat(parts[2].length)}`)).reason,
    "bad_signature",
    "a forged signature of the right length is rejected"
  );
  eq(
    (await verifyToken(secret, "garbage")).reason,
    "malformed",
    "garbage is rejected as malformed"
  );
  eq((await verifyToken(secret, "")).reason, "malformed", "an empty token is malformed");
  eq(
    (await verifyToken(secret, `v2.${parts[1]}.${parts[2]}`)).reason,
    "malformed",
    "an unknown version prefix is refused"
  );

  eq(
    (await verifyToken(secret, minted.token, { purpose: "order-status" })).reason,
    "wrong_purpose",
    "a points token cannot be replayed against the order-status endpoint"
  );

  const expiring = await signToken(secret, {
    email: "shopper@example.com",
    purpose: "points",
    ttlSeconds: 60,
    now: Date.now() - 120 * 1000
  });
  eq((await verifyToken(secret, expiring.token)).reason, "expired", "an expired token is rejected");
  eq(
    (await verifyToken(secret, expiring.token, { now: Date.now() - 119 * 1000 })).valid,
    true,
    "the same token was valid inside its window"
  );

  eq(await burnToken(db, minted.tokenId, minted.expiresAt), true, "the first use burns the token");
  eq(await burnToken(db, minted.tokenId, minted.expiresAt), false, "a replayed token is refused");
  eq(await burnToken(db, "not-hex!", 0), false, "a malformed token id cannot poison the table");

  const nowMs = Date.now();
  await burnToken(db, "abcdef0123456789", Math.floor(nowMs / 1000) - 10, nowMs);
  eq(await sweepBurnedTokens(db, nowMs), 1, "the sweep drops burns whose tokens already expired");
  assert(
    (await db.prepare("SELECT COUNT(*) AS n FROM burned_tokens").first()).n === 1,
    "the sweep kept the burn that is still inside its token's lifetime"
  );
}

/* ==========================================================================
   5. rate-limit -- binding path and Durable Object fallback
   ========================================================================== */

async function testRateLimit() {
  console.log("\n5. rate-limit (binding + Durable Object fallback)");
  const { checkRateLimit, RateLimitCounter } = await import("../workers/state/rate-limit.js");

  const calls = [];
  const bindingEnv = {
    RATE_LIMITER: {
      limit: async (args) => {
        calls.push(args.key);
        return { success: calls.length <= 2 };
      }
    }
  };
  eq(
    await checkRateLimit(bindingEnv, "1.2.3.4", { limit: 5, period: 60 }),
    { success: true, source: "binding" },
    "the Rate Limiting binding is used when present"
  );
  await checkRateLimit(bindingEnv, "1.2.3.4", { limit: 5, period: 60 });
  eq(
    (await checkRateLimit(bindingEnv, "1.2.3.4", { limit: 5, period: 60 })).success,
    false,
    "a refusal from the binding is passed through"
  );
  eq(calls[0], "1.2.3.4", "the key is forwarded to the binding verbatim");

  const doEnv = { RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter) };
  const outcomes = [];
  for (let i = 0; i < 4; i++) {
    outcomes.push(await checkRateLimit(doEnv, "9.9.9.9", { limit: 3, period: 60 }));
  }
  eq(
    outcomes.map((o) => o.success),
    [true, true, true, false],
    "the Durable Object fallback counts exactly and refuses over the limit"
  );
  eq(outcomes[0].source, "durable-object", "the fallback reports its source");
  eq(outcomes[2].remaining, 0, "remaining reaches zero on the last allowed request");
  eq(
    (await checkRateLimit(doEnv, "8.8.8.8", { limit: 3, period: 60 })).success,
    true,
    "a different key gets its own counter"
  );

  const counterCtx = makeDurableCtx();
  const counter = new RateLimitCounter(counterCtx, {});
  const base = 1_700_000_000_000;
  await counter.check({ limit: 2, period: 60, now: base });
  const secondHit = await counter.check({ limit: 2, period: 60, now: base + 1000 });
  eq(secondHit.success, true, "two hits inside one window are allowed");
  eq(
    (await counter.check({ limit: 2, period: 60, now: base + 2000 })).success,
    false,
    "the third is refused"
  );
  const nextWindow = await counter.check({ limit: 2, period: 60, now: base + 61000 });
  eq(nextWindow.success, true, "the counter resets in the next fixed window");
  eq(nextWindow.remaining, 1, "the new window starts from one hit");
  assert(counterCtx._alarm.sets > 0, "the counter arms an alarm so idle keys evict themselves");

  eq(
    await checkRateLimit({}, "1.1.1.1", { limit: 1, period: 60 }),
    { success: true, source: "none" },
    "with no backend configured the limiter fails open and says so"
  );
  eq(
    (await checkRateLimit({}, "1.1.1.1", { limit: 1, period: 60, failOpen: false })).success,
    false,
    "failOpen:false turns a missing backend into a refusal"
  );
  await throwsAsync(
    () => checkRateLimit({}, "1.1.1.1", { limit: 0, period: 60 }),
    "positive integer",
    "a nonsensical limit is a programming error, not a silent allow"
  );
}

/* ==========================================================================
   6. stripe-orders -- sanitised lookup against a mocked Stripe
   ========================================================================== */

async function testStripeOrders() {
  console.log("\n6. stripe-orders (mocked Stripe lookup)");
  const { lookupOrder } = await import("../workers/state/stripe-orders.js");

  const session = {
    id: "cs_test_realorder",
    status: "complete",
    payment_status: "paid",
    amount_total: 4297,
    currency: "usd",
    created: 1_756_000_000,
    customer_details: {
      email: "Buyer@Example.com",
      phone: "+15125550123",
      address: { line1: "12 Secret Ln", city: "Austin", state: "TX", postal_code: "78704" }
    },
    collected_information: {
      shipping_details: {
        name: "Buyer Person",
        address: {
          line1: "12 Secret Ln",
          city: "Austin",
          state: "TX",
          postal_code: "78704",
          country: "US"
        }
      }
    },
    line_items: {
      data: [
        { description: "Frankincense Salve", quantity: 2 },
        { description: "Miracle Balm", quantity: 1 }
      ]
    },
    payment_intent: {
      id: "pi_123",
      metadata: {
        fulfillment_status: "shipped",
        tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400",
        shipped_at: "2026-08-28",
        gift_card_redeemed_code: "YALL-GIFT50"
      }
    }
  };

  let requested = null;
  const fetchImpl = async (url) => {
    requested = url;
    return { ok: true, status: 200, json: async () => session };
  };
  const env = { STRIPE_SECRET_KEY: "sk_test_x" };

  const found = await lookupOrder(env, {
    sessionId: "cs_test_realorder",
    email: "  buyer@EXAMPLE.com ",
    fetchImpl
  });
  eq(found.found, true, "a matching email returns the order");
  assert(requested.includes("expand[]=line_items"), "line_items are expanded in one request");
  assert(requested.includes("expand[]=payment_intent"), "the PaymentIntent is expanded too");
  eq(found.paymentStatus, "paid", "payment_status is surfaced");
  eq(found.status, "complete", "session status is surfaced");
  eq(found.amountTotalCents, 4297, "the order total is surfaced");
  eq(
    found.items,
    [
      { name: "Frankincense Salve", quantity: 2 },
      { name: "Miracle Balm", quantity: 1 }
    ],
    "line items come back as name and quantity only"
  );
  eq(
    found.shipTo,
    { city: "Austin", state: "TX", country: "US" },
    "only city/state/country ship out"
  );
  eq(found.fulfilment.status, "shipped", "fulfillment_status is read from PaymentIntent metadata");
  eq(found.fulfilment.shippedAt, "2026-08-28", "shipped_at is read from PaymentIntent metadata");
  assert(found.fulfilment.trackingUrl.startsWith("https://"), "the tracking URL is passed through");

  const serialised = JSON.stringify(found);
  assert(!serialised.includes("Secret Ln"), "the street address is never returned");
  assert(!serialised.includes("78704"), "the postal code is never returned");
  assert(!serialised.includes("5125550123"), "the phone number is never returned");
  assert(!serialised.includes("YALL-GIFT50"), "unrelated metadata (a gift-card code) never leaks");
  assert(!serialised.includes("pi_123"), "internal Stripe object ids never leak");

  const mismatch = await lookupOrder(env, {
    sessionId: "cs_test_realorder",
    email: "stranger@example.com",
    fetchImpl
  });
  eq(mismatch, { found: false, error: "not_found" }, "a wrong email gets nothing back");
  eq(
    JSON.stringify(mismatch),
    JSON.stringify(
      await lookupOrder(env, {
        sessionId: "cs_test_missing00",
        email: "buyer@example.com",
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: {} }) })
      })
    ),
    "a wrong email is indistinguishable from a missing session (no enumeration oracle)"
  );

  eq(
    await lookupOrder(env, { sessionId: "YL-1234", email: "buyer@example.com", fetchImpl }),
    { found: false, error: "not_found" },
    "a non-Stripe order reference never reaches Stripe"
  );
  eq(
    await lookupOrder(env, { sessionId: "cs_test_realorder", email: "", fetchImpl }),
    { found: false, error: "not_found" },
    "a missing email never reaches Stripe"
  );

  const legacy = {
    ...session,
    collected_information: undefined,
    shipping_details: { address: { city: "Lockhart", state: "TX", country: "US" } },
    payment_intent: { metadata: { tracking_url: "javascript:alert(1)" } }
  };
  const legacyResult = await lookupOrder(env, {
    sessionId: "cs_test_realorder",
    email: "buyer@example.com",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => legacy })
  });
  eq(legacyResult.shipTo.city, "Lockhart", "the legacy shipping_details field is still read");
  eq(legacyResult.fulfilment.trackingUrl, null, "a javascript: tracking URL is dropped");
  eq(
    legacyResult.fulfilment.status,
    "processing",
    "a missing fulfillment_status defaults to processing"
  );

  await throwsAsync(
    () =>
      lookupOrder(env, {
        sessionId: "cs_test_realorder",
        email: "buyer@example.com",
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
      }),
    "503",
    "a Stripe outage throws rather than reporting the order as missing"
  );
  await throwsAsync(
    () =>
      lookupOrder({}, { sessionId: "cs_test_realorder", email: "buyer@example.com", fetchImpl }),
    "STRIPE_SECRET_KEY",
    "a missing Stripe key is a loud configuration error"
  );
}

/* ==========================================================================
   7. migrations -- idempotent, and in step with workers/schema.sql
   ========================================================================== */

async function testMigrations() {
  console.log("\n7. migrations (idempotent schema application)");
  const mod = await import("../workers/state/migrations.js");
  const { applyMigrations, ensureSchema, resetSchemaMemo, SCHEMA_STATEMENTS, SCHEMA_VERSION } = mod;

  const db = makeD1(new DatabaseSync(":memory:"));
  const first = await applyMigrations(db);
  eq(first, { applied: true, version: SCHEMA_VERSION }, "the first run applies the schema");
  const second = await applyMigrations(db);
  eq(second, { applied: false, version: SCHEMA_VERSION }, "a second run is a no-op");

  for (const table of ["webhook_events", "loyalty_ledger", "burned_tokens", "schema_version"]) {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(table)
      .first();
    assert(row !== null, `migrations created the ${table} table`);
  }
  const indexes = (
    await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
  ).results.map((r) => r.name);
  assert(indexes.includes("loyalty_ledger_email"), "the loyalty email index exists");
  assert(indexes.includes("webhook_events_claimed_at"), "the webhook sweep index exists");

  resetSchemaMemo();
  const memoDb = makeD1(new DatabaseSync(":memory:"));
  const a = ensureSchema(memoDb);
  const b = ensureSchema(memoDb);
  assert(a === b, "ensureSchema memoises the in-flight migration for the isolate");
  await a;
  resetSchemaMemo();

  // Parity with the documented schema: every table and index in schema.sql must
  // exist in SCHEMA_STATEMENTS, and vice versa.
  const sqlFile = fs.readFileSync(path.join(ROOT, "workers", "schema.sql"), "utf8");
  const objectsIn = (text) => {
    const found = [];
    const re = /CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi;
    let match;
    while ((match = re.exec(text)) !== null) found.push(`${match[1].toUpperCase()} ${match[2]}`);
    return found.sort();
  };
  eq(
    objectsIn(SCHEMA_STATEMENTS.join(";\n")),
    objectsIn(sqlFile),
    "migrations.js and workers/schema.sql declare exactly the same tables and indexes"
  );
  assert(
    SCHEMA_STATEMENTS.every((s) => /IF NOT EXISTS/i.test(s)),
    "every migration statement is IF NOT EXISTS, so re-running is always safe"
  );
}

/* ==========================================================================
   8. wrangler.toml -- the bindings the state layer needs are documented there
   ========================================================================== */

function testWranglerConfig() {
  console.log("\n8. wrangler.toml (bindings documented for phase B)");
  const toml = fs.readFileSync(path.join(ROOT, "workers", "wrangler.toml"), "utf8");
  assert(/GIFT_CARD_LEDGER/.test(toml), "wrangler.toml names the GIFT_CARD_LEDGER binding");
  assert(/RATE_LIMIT_COUNTER/.test(toml), "wrangler.toml names the RATE_LIMIT_COUNTER binding");
  assert(/STATE_DB/.test(toml), "wrangler.toml names the STATE_DB D1 binding");
  assert(
    /new_sqlite_classes/.test(toml),
    "the DO migration uses new_sqlite_classes (required for SQLite DOs on the free plan)"
  );
  assert(/wrangler d1 create/.test(toml), "wrangler.toml records the exact d1 create command");
  assert(
    /SITE_ORIGIN = "https:\/\/yallternativeliving.com"/.test(toml),
    "the existing SITE_ORIGIN var survived the edit"
  );
  assert(/^main = "checkout.js"$/m.test(toml), "the existing entrypoint survived the edit");
  assert(/^workers_dev = true$/m.test(toml), "the existing workers_dev setting survived the edit");
}

/* ==========================================================================
   Runner
   ========================================================================== */

(async () => {
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  const makeDb = async () => {
    const db = makeD1(new DatabaseSync(":memory:"));
    await applyMigrations(db);
    return db;
  };

  await testGiftCardLedger();
  await testWebhookEvents(makeDb);
  await testLoyalty(makeDb);
  await testMagicLink(makeDb);
  await testRateLimit();
  await testStripeOrders();
  await testMigrations();
  testWranglerConfig();
  resetSchemaMemo();

  console.log(`\nworker-state.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-state.test.js crashed:", err);
  process.exit(1);
});
