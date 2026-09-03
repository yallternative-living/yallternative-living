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
 * and the Worker routes that are built on them, driven through the real
 * entrypoint (workers/checkout.js): the router, /api/gift-card-balance,
 * /api/stripe-webhook, /api/order-status, /api/restock, the whole
 * buy-a-card-then-spend-it path, and the generated netlify.toml that fronts
 * them.
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
   D1 and Durable Object emulation lives in scripts/lib/d1-emulator.js -- the
   route tests in scripts/worker-checkout.test.js drive the same ledger through
   the same emulators, and one copy cannot drift from the other.
   ========================================================================== */

const { makeD1, makeDurableCtx, makeNamespace } = require("./lib/d1-emulator.js");

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

  const credited = await credit(db, { email, points: 120, orderId: "cs_order_00000001" });
  eq(credited.credited, true, "credit() awards points for an order");
  eq(credited.balance, 120, "the balance reflects the credit");

  const dupe = await credit(db, {
    email: "SHOPPER@example.com",
    points: 120,
    orderId: "cs_order_00000001"
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
   9. The Worker's routes, end to end.

   These drive the REAL entrypoint (workers/checkout.js's default export) with
   the real ledger, the real D1 helpers and the real signature verification --
   only Stripe, Resend and the storage engine are simulated. What is being
   tested is the wiring the audit found missing, so a test that stubbed the
   handlers would be testing nothing.
   ========================================================================== */

const nodeCrypto = require("crypto");

const WEBHOOK_SECRET = "whsec_test_secret_for_the_suite";

/** Build the `Stripe-Signature` header Stripe would send for this body. */
function signWebhook(rawBody, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = nodeCrypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * A Worker env with the state layer wired up the way wrangler.toml wires it:
 * one D1 database, one GiftCardLedger namespace, one RateLimitCounter
 * namespace. `sentEmails` and `stripeCalls` record what left the Worker.
 */
async function makeRouteEnv(overrides = {}) {
  const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return {
    SITE_ORIGIN: "https://yallternativeliving.com",
    STRIPE_SECRET_KEY: "sk_test_suite",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: "re_test_suite",
    STATE_DB: db,
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

/** Swap global.fetch for a recorder, run `fn`, always put it back. */
async function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    const answer = await handler(String(url), opts || {}, calls);
    return answer || { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function post(path, body, headers = {}) {
  return new Request(`https://yallternativeliving.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://yallternativeliving.com",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const noCtx = { waitUntil: () => {} };

async function testRouter() {
  console.log("\n9. Router (workers/checkout.js entrypoint)");
  const worker = (await import("../workers/checkout.js")).default;
  const { routeOf } = await import("../workers/checkout.js");
  const env = await makeRouteEnv();

  // Netlify's /api/* proxy forwards `:splat`, so the prefix is gone by the time
  // the Worker sees it; a Cloudflare route on the apex keeps it. Both work.
  eq(routeOf("/api/gift-card-balance"), "/gift-card-balance", "routeOf strips the /api prefix");
  eq(routeOf("/gift-card-balance"), "/gift-card-balance", "routeOf accepts the proxied path");
  eq(routeOf("/api/checkout/"), "/checkout", "routeOf ignores a trailing slash");
  eq(routeOf("/api"), "/checkout", "the bare proxy target is still checkout");
  eq(routeOf("/apifoo"), "/apifoo", "routeOf does not strip a prefix that merely starts with /api");

  const notFound = await worker.fetch(post("/api/nope", {}), env, noCtx);
  eq(notFound.status, 404, "an unknown route is a 404");
  eq((await notFound.json()).error, "Not Found", "...as JSON, not an HTML error page");
  eq(
    notFound.headers.get("Cache-Control"),
    "no-store",
    "every JSON response is Cache-Control: no-store (C-3)"
  );
  eq(notFound.headers.get("Vary"), "Origin", "every response varies on Origin");

  for (const route of [
    "/api/checkout",
    "/api/gift-card-balance",
    "/api/stripe-webhook",
    "/api/order-status",
    "/api/restock"
  ]) {
    const preflight = await worker.fetch(
      new Request(`https://yallternativeliving.com${route}`, {
        method: "OPTIONS",
        headers: { Origin: "https://yallternativeliving.com" }
      }),
      env,
      noCtx
    );
    eq(preflight.status, 204, `OPTIONS ${route} is a 204 preflight`);
    eq(
      preflight.headers.get("Access-Control-Allow-Origin"),
      "https://yallternativeliving.com",
      `OPTIONS ${route} echoes the allowed origin`
    );
  }

  const wrongMethod = await worker.fetch(
    new Request("https://yallternativeliving.com/api/restock", { method: "GET" }),
    env,
    noCtx
  );
  eq(wrongMethod.status, 405, "GET on a POST-only route is a 405");

  const hostile = await worker.fetch(
    post("/api/order-status", {}, { Origin: "https://evil.example" }),
    env,
    noCtx
  );
  eq(hostile.status, 403, "a cross-site Origin is refused on every route");
  eq(
    hostile.headers.get("Access-Control-Allow-Origin"),
    "https://yallternativeliving.com",
    "...and the refusal does not echo the attacker's origin back"
  );
}

/* ==========================================================================
   10. POST /api/gift-card-balance
   ========================================================================== */

async function testBalanceRoute() {
  console.log("\n10. POST /api/gift-card-balance");
  const worker = (await import("../workers/checkout.js")).default;
  const { giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const env = await makeRouteEnv();
  await giftCardLedger(env, "YALL-BAL1-BAL1-BAL1").issue({ initialCents: 5000, source: "test" });

  const found = await worker.fetch(
    post("/api/gift-card-balance", { code: "yall-bal1-bal1-bal1" }),
    env,
    noCtx
  );
  const foundBody = await found.json();
  eq(found.status, 200, "a real code returns 200");
  eq(foundBody.valid, true, "...with valid: true");
  eq(foundBody.balanceCents, 5000, "...the ledger balance in cents");
  eq(foundBody.formattedBalance, "$50", "...a formatted balance for the drawer");
  eq(foundBody.code, "YALL-BAL1-BAL1-BAL1", "...and the canonical code, upper-cased");
  eq(
    found.headers.get("Cache-Control"),
    "no-store",
    "a balance is never cached (C-3: the service worker served one shopper's card to another)"
  );

  const unknown = await worker.fetch(
    post("/api/gift-card-balance", { code: "YALL-ZZZZ-ZZZZ-ZZZZ" }),
    env,
    noCtx
  );
  eq(unknown.status, 404, "an unknown code is a 404");
  const { GENERIC_NOT_FOUND } = await import("../workers/routes/gift-card-balance.js");
  eq(
    (await unknown.json()).error,
    GENERIC_NOT_FOUND,
    "...with the same generic sentence a spent card gets, so the endpoint confirms nothing"
  );

  // Spend the card down to nothing; it must become indistinguishable from a
  // code that never existed.
  await giftCardLedger(env, "YALL-BAL1-BAL1-BAL1").reserve({ sessionId: "cs_spend", cents: 5000 });
  await giftCardLedger(env, "YALL-BAL1-BAL1-BAL1").commit({ sessionId: "cs_spend" });
  const spent = await worker.fetch(
    post("/api/gift-card-balance", { code: "YALL-BAL1-BAL1-BAL1" }),
    env,
    noCtx
  );
  eq(spent.status, 404, "a fully spent card answers exactly like an unknown one");
  eq((await spent.json()).error, GENERIC_NOT_FOUND, "...same sentence, no oracle");

  const malformed = await worker.fetch(
    post("/api/gift-card-balance", { code: "PROMO2026" }),
    env,
    noCtx
  );
  eq(malformed.status, 404, "a malformed code is refused");
  assert(
    /YALL-XXXX-XXXX-XXXX/.test((await malformed.json()).error),
    "...with the format, which is a typo the shopper can fix and reveals nothing"
  );

  // Rate limit: 10 a minute per IP, then 429. The eleventh request is the one
  // that must be refused.
  const limited = await makeRouteEnv();
  let statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await worker.fetch(
      post(
        "/api/gift-card-balance",
        { code: "YALL-RATE-RATE-RATE" },
        { "X-Forwarded-For": "203.0.113.9" }
      ),
      limited,
      noCtx
    );
    statuses.push(res.status);
  }
  eq(
    statuses.slice(0, 10).every((s) => s === 404),
    true,
    "the first ten lookups are answered"
  );
  eq(statuses.slice(10), [429, 429], "the eleventh and twelfth are rate-limited");

  const otherIp = await worker.fetch(
    post(
      "/api/gift-card-balance",
      { code: "YALL-RATE-RATE-RATE" },
      { "X-Forwarded-For": "198.51.100.4" }
    ),
    limited,
    noCtx
  );
  eq(otherIp.status, 404, "the limit is per IP, not global");

  const unbound = await makeRouteEnv({ GIFT_CARD_LEDGER: undefined });
  const guarded = await worker.fetch(
    post("/api/gift-card-balance", { code: "YALL-BAL1-BAL1-BAL1" }),
    unbound,
    noCtx
  );
  eq(guarded.status, 503, "with no ledger binding the route is 503, not a false 'not found'");
}

/* ==========================================================================
   11. POST /api/stripe-webhook
   ========================================================================== */

async function testWebhookRoute() {
  console.log("\n11. POST /api/stripe-webhook");
  const worker = (await import("../workers/checkout.js")).default;
  const { giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { verifyStripeSignature } = await import("../workers/routes/stripe-webhook.js");
  const { getEvent } = await import("../workers/state/webhook-events.js");

  /* --- signature verification (ported from the Netlify function's tests) --- */
  const body = JSON.stringify({ id: "evt_sig", type: "ping" });
  const parsed = await verifyStripeSignature(body, signWebhook(body), WEBHOOK_SECRET);
  eq(parsed.id, "evt_sig", "a correctly signed body verifies and parses");

  await throwsAsync(
    () => verifyStripeSignature(body, signWebhook(body, "whsec_wrong"), WEBHOOK_SECRET),
    "Signature mismatch",
    "a body signed with the wrong secret is rejected"
  );
  await throwsAsync(
    () => verifyStripeSignature(`${body} `, signWebhook(body), WEBHOOK_SECRET),
    "Signature mismatch",
    "a tampered body is rejected"
  );
  await throwsAsync(
    () => verifyStripeSignature(body, null, WEBHOOK_SECRET),
    "Missing Stripe-Signature",
    "a missing signature header is rejected"
  );
  await throwsAsync(
    () => verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000)},v1=`, WEBHOOK_SECRET),
    "Signature mismatch",
    "an empty v1 signature is rejected"
  );
  await throwsAsync(
    () => verifyStripeSignature(body, "not-a-header", WEBHOOK_SECRET),
    "Malformed Stripe-Signature",
    "a malformed signature header is rejected"
  );
  await throwsAsync(
    () =>
      verifyStripeSignature(
        body,
        signWebhook(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 4000),
        WEBHOOK_SECRET
      ),
    "outside tolerance",
    "a captured payload replayed an hour later is rejected"
  );
  await throwsAsync(
    () => verifyStripeSignature(body, signWebhook(body), ""),
    "STRIPE_WEBHOOK_SECRET is not configured",
    "no configured secret means no verification, and no processing"
  );

  const env = await makeRouteEnv();
  const badSig = await worker.fetch(
    post("/api/stripe-webhook", body, { "Stripe-Signature": "t=1,v1=deadbeef" }),
    env,
    noCtx
  );
  eq(badSig.status, 400, "the route rejects a forged signature with a 400");
  eq(
    (await badSig.json()).error,
    "Invalid signature",
    "...and one fixed string, so the reason is not an oracle"
  );

  /* --- purchase: issue on the ledger and email both parties ------------- */
  const purchase = {
    id: "evt_purchase_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_purchase_1",
        customer_details: { email: "buyer@example.com" },
        metadata: {
          gift_card_1_amount_cents: "5000",
          gift_card_1_qty: "2",
          gift_card_1_recipient: "friend@example.com",
          gift_card_1_sender: "Sam <script>",
          gift_card_1_message: "Enjoy!"
        }
      }
    }
  };
  const purchaseBody = JSON.stringify(purchase);
  const purchaseEnv = await makeRouteEnv();
  const emails = [];
  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        emails.push({ ...JSON.parse(opts.body), key: opts.headers["Idempotency-Key"] });
        return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", purchaseBody, {
          "Stripe-Signature": signWebhook(purchaseBody)
        }),
        purchaseEnv,
        noCtx
      );
      eq(res.status, 200, "a gift-card purchase is processed");
    }
  );

  eq(emails.length, 4, "two cards mean two recipient emails and two buyer receipts");
  const recipientEmails = emails.filter((e) => e.to === "friend@example.com");
  eq(recipientEmails.length, 2, "both cards reach the recipient");
  assert(
    recipientEmails.every((e) => /YALL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.test(e.html)),
    "each email carries a code in the YALL-XXXX-XXXX-XXXX format"
  );
  assert(
    recipientEmails.every((e) => e.html.includes("Sam &lt;script&gt;")),
    "the sender's name is HTML-escaped into the email"
  );
  assert(
    recipientEmails.every((e) => !e.html.includes("<script>")),
    "...so no raw tag from client input reaches the recipient's inbox"
  );
  assert(
    emails.every((e) => typeof e.key === "string" && e.key.includes("cs_purchase_1")),
    "every send carries a per-session, per-unit idempotency key"
  );

  const codes = recipientEmails.map(
    (e) => /YALL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(e.html)[0]
  );
  assert(codes[0] !== codes[1], "two units of one line get two different codes");
  for (const code of codes) {
    const snapshot = await giftCardLedger(purchaseEnv, code).getBalance();
    eq(snapshot.balanceCents, 5000, `the ledger issued ${code} with the paid amount`);
    eq(snapshot.recipientEmail, "friend@example.com", "...against the recipient it was bought for");
  }

  /* --- exactly-once: the same event again does nothing ------------------ */
  const replayEmails = [];
  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        replayEmails.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", purchaseBody, {
          "Stripe-Signature": signWebhook(purchaseBody)
        }),
        purchaseEnv,
        noCtx
      );
      eq(res.status, 200, "a redelivered event still answers 200 (or Stripe retries forever)");
      eq((await res.json()).duplicate, true, "...and says it was a duplicate");
    }
  );
  eq(replayEmails.length, 0, "a redelivered event sends no second copy of anything");
  const claim = await getEvent(purchaseEnv.STATE_DB, "evt_purchase_1");
  eq(claim.status, "done", "the first delivery marked the event done");

  /* --- codes are derived, so a fresh ledger re-derives the same ones ---- */
  const { deriveGiftCardCode } = await import("../workers/routes/gift-cards.js");
  eq(
    await deriveGiftCardCode("cs_purchase_1", "1-1", WEBHOOK_SECRET),
    codes[0],
    "the code is a deterministic function of (session, unit, signing secret)"
  );
  assert(
    (await deriveGiftCardCode("cs_purchase_1", "1-1", "whsec_other")) !== codes[0],
    "...and of the secret, so a leaked session id does not reveal the code"
  );

  /* --- redemption: paying commits the hold ----------------------------- */
  const spendEnv = await makeRouteEnv();
  await giftCardLedger(spendEnv, "YALL-SPND-SPND-SPND").issue({
    initialCents: 5000,
    recipientEmail: "holder@example.com",
    source: "test"
  });
  await giftCardLedger(spendEnv, "YALL-SPND-SPND-SPND").reserve({
    sessionId: "cs_spend_1",
    cents: 2000
  });
  const completed = {
    id: "evt_spend_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_spend_1",
        customer_details: { email: "holder@example.com" },
        metadata: {
          gift_card_redeemed_code: "YALL-SPND-SPND-SPND",
          gift_card_amount_applied_cents: "2000"
        }
      }
    }
  };
  const completedBody = JSON.stringify(completed);
  const spendEmails = [];
  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        spendEmails.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", completedBody, {
          "Stripe-Signature": signWebhook(completedBody)
        }),
        spendEnv,
        noCtx
      );
      eq(res.status, 200, "a paid order that used a gift card is processed");
    }
  );
  const afterSpend = await giftCardLedger(spendEnv, "YALL-SPND-SPND-SPND").getBalance();
  eq(afterSpend.balanceCents, 3000, "the balance is down by what was spent");
  eq(afterSpend.pendingCents, 0, "nothing is still held");
  eq(afterSpend.spentCents, 2000, "the hold became a permanent debit");
  eq(spendEmails.length, 1, "the card holder is told what is left");
  assert(spendEmails[0].subject.includes("$30.00"), "...and the email quotes the new balance");

  /* --- expiry: the hold goes back and the coupon is deleted ------------- */
  const expireEnv = await makeRouteEnv();
  await giftCardLedger(expireEnv, "YALL-EXPR-EXPR-EXPR").issue({
    initialCents: 4000,
    source: "test"
  });
  await giftCardLedger(expireEnv, "YALL-EXPR-EXPR-EXPR").reserve({
    sessionId: "cs_expire_1",
    cents: 1500
  });
  const expired = {
    id: "evt_expire_1",
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_expire_1",
        metadata: {
          gift_card_redeemed_code: "YALL-EXPR-EXPR-EXPR",
          gift_card_amount_applied_cents: "1500",
          gift_card_ephemeral_coupon_id: "coupon_abandoned"
        }
      }
    }
  };
  const expiredBody = JSON.stringify(expired);
  await withFetch(
    async (url, opts) => {
      if (url.includes("/v1/coupons/") && opts.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ deleted: true }) };
      }
      return null;
    },
    async (calls) => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", expiredBody, { "Stripe-Signature": signWebhook(expiredBody) }),
        expireEnv,
        noCtx
      );
      eq(res.status, 200, "an expired session is processed");
      assert(
        calls.some((c) => c.url.includes("coupon_abandoned") && c.opts.method === "DELETE"),
        "the ephemeral coupon an abandoned checkout left behind is deleted"
      );
    }
  );
  const afterExpiry = await giftCardLedger(expireEnv, "YALL-EXPR-EXPR-EXPR").getBalance();
  eq(afterExpiry.balanceCents, 4000, "an abandoned checkout puts the whole hold back");
  eq(afterExpiry.pendingCents, 0, "...and holds nothing");

  /* --- refund: restore min(applied, refunded), once (H-5) --------------- */
  const refundEnv = await makeRouteEnv();
  await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").issue({
    initialCents: 5000,
    recipientEmail: "holder@example.com",
    source: "test"
  });
  await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").reserve({
    sessionId: "cs_refund_1",
    cents: 3000
  });
  await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").commit({ sessionId: "cs_refund_1" });

  const refundSession = {
    id: "cs_refund_1",
    metadata: {
      gift_card_redeemed_code: "YALL-RFND-RFND-RFND",
      gift_card_amount_applied_cents: "3000"
    }
  };
  const stripeForRefunds = async (url) => {
    if (url.includes("/checkout/sessions?payment_intent=")) {
      return { ok: true, status: 200, json: async () => ({ data: [refundSession] }) };
    }
    if (url.includes("api.resend.com")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return null;
  };

  const partial = {
    id: "evt_refund_1",
    type: "charge.refunded",
    data: {
      object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 1000 }
    }
  };
  const partialBody = JSON.stringify(partial);
  await withFetch(stripeForRefunds, async () => {
    const res = await worker.fetch(
      post("/api/stripe-webhook", partialBody, { "Stripe-Signature": signWebhook(partialBody) }),
      refundEnv,
      noCtx
    );
    eq(res.status, 200, "a partial refund is processed");
  });
  eq(
    (await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").getBalance()).balanceCents,
    3000,
    "a $10 refund puts $10 back on a card that had $20 left"
  );

  // The same charge refunded further: only the DIFFERENCE goes back.
  const grown = {
    id: "evt_refund_2",
    type: "charge.refunded",
    data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 4000 } }
  };
  const grownBody = JSON.stringify(grown);
  await withFetch(stripeForRefunds, async () => {
    const res = await worker.fetch(
      post("/api/stripe-webhook", grownBody, { "Stripe-Signature": signWebhook(grownBody) }),
      refundEnv,
      noCtx
    );
    eq(res.status, 200, "a larger refund on the same charge is processed");
  });
  eq(
    (await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").getBalance()).balanceCents,
    5000,
    "restoration is capped at what the card actually paid, and never double-credits"
  );

  // A THIRD delivery of the same money must move nothing at all.
  const again = {
    id: "evt_refund_3",
    type: "charge.refunded",
    data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 4000 } }
  };
  const againBody = JSON.stringify(again);
  await withFetch(stripeForRefunds, async () => {
    await worker.fetch(
      post("/api/stripe-webhook", againBody, { "Stripe-Signature": signWebhook(againBody) }),
      refundEnv,
      noCtx
    );
  });
  eq(
    (await giftCardLedger(refundEnv, "YALL-RFND-RFND-RFND").getBalance()).balanceCents,
    5000,
    "a re-delivered refund event mints no money"
  );

  /* --- unrelated events, and the startup guard -------------------------- */
  const ignored = JSON.stringify({ id: "evt_ignored", type: "payment_intent.created", data: {} });
  const ignoredRes = await worker.fetch(
    post("/api/stripe-webhook", ignored, { "Stripe-Signature": signWebhook(ignored) }),
    await makeRouteEnv(),
    noCtx
  );
  eq(ignoredRes.status, 200, "an event this shop does not care about is acknowledged, not retried");

  /* STATE_DB (D1) only backs the exactly-once claim table, and every webhook
     effect is idempotent on its own (ledger keyed on session/charge ids,
     Resend idempotency keys). The binding stays commented out in
     wrangler.toml until the owner has run `wrangler d1 create`, so the
     Worker must keep processing events without it rather than 503 -- a 503
     here would mean no gift card is ever fulfilled on a fresh deploy. */
  const unbound = await makeRouteEnv({ STATE_DB: undefined });
  const degraded = await worker.fetch(
    post("/api/stripe-webhook", ignored, { "Stripe-Signature": signWebhook(ignored) }),
    unbound,
    noCtx
  );
  eq(
    degraded.status,
    200,
    "with no D1 binding the webhook still processes events (claim table is optional)"
  );
  const degradedBody = await degraded.json();
  eq(degradedBody.received, true, "…and acknowledges the event");
  eq(degradedBody.duplicate, undefined, "…without a claim table it cannot flag duplicates");

  const noLedger = await makeRouteEnv({ GIFT_CARD_LEDGER: undefined });
  const guarded = await worker.fetch(
    post("/api/stripe-webhook", ignored, { "Stripe-Signature": signWebhook(ignored) }),
    noLedger,
    noCtx
  );
  eq(
    guarded.status,
    503,
    "with no ledger binding the webhook is 503 -- retryable, so Stripe holds the event"
  );
}

/* ==========================================================================
   12. POST /api/order-status
   ========================================================================== */

async function testOrderStatusRoute() {
  console.log("\n12. POST /api/order-status");
  const worker = (await import("../workers/checkout.js")).default;
  const env = await makeRouteEnv();

  const session = {
    id: "cs_order_00000001",
    status: "complete",
    payment_status: "paid",
    amount_total: 4238,
    currency: "usd",
    created: 1756700000,
    customer_details: { email: "Shopper@Example.com", phone: "+15551234567" },
    collected_information: {
      shipping_details: {
        name: "A Shopper",
        address: {
          line1: "12 Private Street",
          city: "Landrum",
          state: "SC",
          postal_code: "29356",
          country: "US"
        }
      }
    },
    line_items: { data: [{ description: "Frankincense Salve (2oz)", quantity: 2 }] },
    payment_intent: {
      id: "pi_order_00000001",
      metadata: {
        fulfillment_status: "shipped",
        tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=99",
        shipped_at: "2026-09-01"
      }
    }
  };

  const stripe = async (url) =>
    url.includes("/checkout/sessions/cs_order_00000001")
      ? { ok: true, status: 200, json: async () => session }
      : { ok: false, status: 404, json: async () => ({ error: {} }) };

  let body;
  await withFetch(stripe, async () => {
    const res = await worker.fetch(
      post("/api/order-status", { sessionId: "cs_order_00000001", email: "shopper@example.com" }),
      env,
      noCtx
    );
    eq(res.status, 200, "the right session id with the right email returns the order");
    body = await res.json();
  });
  eq(body.found, true, "found: true");
  eq(body.status, "complete", "the session status is reported");
  eq(body.paymentStatus, "paid", "the payment status is reported");
  eq(body.amountTotal, 4238, "the total is reported in cents");
  eq(body.items, [{ name: "Frankincense Salve (2oz)", quantity: 2 }], "line items name and count");
  eq(body.shipping, { city: "Landrum", state: "SC" }, "only the city and state ship back");
  eq(
    body.fulfillment,
    {
      status: "shipped",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=99",
      shippedAt: "2026-09-01"
    },
    "the merchant's fulfilment keys are passed through"
  );
  const serialised = JSON.stringify(body);
  assert(!serialised.includes("12 Private Street"), "the street address is never returned");
  assert(!serialised.includes("+15551234567"), "the phone number is never returned");
  assert(!serialised.includes("@example.com"), "the email is never echoed back");

  await withFetch(stripe, async () => {
    const mismatch = await worker.fetch(
      post("/api/order-status", {
        sessionId: "cs_order_00000001",
        email: "someone-else@example.com"
      }),
      env,
      noCtx
    );
    eq(mismatch.status, 404, "a real session with the wrong email is a 404");
    eq(
      await mismatch.json(),
      { found: false, error: "not_found" },
      "...byte-identical to a session that does not exist, so ids cannot be probed"
    );

    const missing = await worker.fetch(
      post("/api/order-status", {
        sessionId: "cs_does_not_exist_00",
        email: "shopper@example.com"
      }),
      env,
      noCtx
    );
    eq(missing.status, 404, "an unknown session id is a 404");
    eq(await missing.json(), { found: false, error: "not_found" }, "...with the same body");

    const nonsense = await worker.fetch(
      post("/api/order-status", { sessionId: "YL-1234", email: "shopper@example.com" }),
      env,
      noCtx
    );
    eq(nonsense.status, 404, "a made-up order number is a 404 (H-6: it used to be a confirmation)");
  });

  // 5 a minute per IP.
  const limited = await makeRouteEnv();
  const statuses = [];
  await withFetch(stripe, async () => {
    for (let i = 0; i < 7; i++) {
      const res = await worker.fetch(
        post(
          "/api/order-status",
          { sessionId: "cs_does_not_exist_00", email: "a@b.com" },
          { "X-Forwarded-For": "203.0.113.55" }
        ),
        limited,
        noCtx
      );
      statuses.push(res.status);
    }
  });
  eq(
    statuses.slice(0, 5).every((s) => s === 404),
    true,
    "five lookups a minute are answered"
  );
  eq(statuses.slice(5), [429, 429], "the sixth is rate-limited");
}

/* ==========================================================================
   13. POST /api/restock
   ========================================================================== */

async function testRestockRoute() {
  console.log("\n13. POST /api/restock");
  const worker = (await import("../workers/checkout.js")).default;
  const env = await makeRouteEnv();

  let sent = null;
  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        sent = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ id: "email" }) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/restock", { email: "waiting@example.com", product: "Miracle Balm" }),
        env,
        noCtx
      );
      eq(res.status, 200, "a valid restock request is accepted");
      eq((await res.json()).success, true, "...and reports success");
    }
  );
  eq(sent.to, "contact@yallternativeliving.com", "the alert goes to the shop's default address");
  eq(sent.reply_to, "waiting@example.com", "the requester is the reply-to, never the From");
  assert(sent.html.includes("Miracle Balm"), "the product is named in the alert");

  // Honeypot: same shape a person gets, and nothing sent.
  let honeypotSent = false;
  await withFetch(
    async (url) => {
      if (url.includes("api.resend.com")) {
        honeypotSent = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/restock", {
          email: "bot@example.com",
          product: "Anything",
          website_hp: "filled in"
        }),
        env,
        noCtx
      );
      eq(res.status, 200, "a honeypot hit gets the same status a person gets");
      eq((await res.json()).success, true, "...and the same success shape");
    }
  );
  eq(honeypotSent, false, "...but nothing is actually sent");

  const invalid = await worker.fetch(
    post("/api/restock", { email: "not-an-address", product: "x" }),
    env,
    noCtx
  );
  eq(invalid.status, 400, "an address that is not an address is refused");

  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        sent = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    },
    async () => {
      await worker.fetch(
        post("/api/restock", { email: "ok@example.com", product: "<img src=x onerror=1>" }),
        env,
        noCtx
      );
    }
  );
  assert(!sent.html.includes("<img"), "a product name from the client is HTML-escaped");

  const noKey = await makeRouteEnv({ RESEND_API_KEY: undefined });
  const unavailable = await worker.fetch(
    /* A real catalogue id: the route now refuses products it cannot match,
       so the no-mailer path is reached only with a known product. */
    post("/api/restock", { email: "waiting@example.com", product_id: "miracle-balm" }),
    noKey,
    noCtx
  );
  eq(
    unavailable.status,
    503,
    "with no mailer configured the endpoint says so rather than pretending it recorded the request"
  );
}

/* ==========================================================================
   14. The whole money path, in one go.

   purchase -> issue -> balance -> apply -> reserve -> pay -> commit ->
   balance reduced. Every step goes through the real Worker; the only fakes are
   Stripe and Resend.
   ========================================================================== */

async function testEndToEndMoneyPath() {
  console.log("\n14. End to end: buy a card, spend it, check what is left");
  const worker = (await import("../workers/checkout.js")).default;
  const env = await makeRouteEnv();

  const catalog = {
    products: [
      { id: "lavender-soak", name: "Lavender Soak", price: 18.0, category: "soaks" },
      {
        id: "yallternative-gift-card",
        name: "Digital Gift Card",
        price: 25.0,
        variants: { name: "Amount", options: [{ label: "Preset $25", priceDelta: 0 }] }
      }
    ],
    shop: { freeShippingThreshold: 40 }
  };

  /* 1. Buy a $25 gift card. */
  let giftSessionParams = null;
  await withFetch(
    async (url, opts) => {
      if (url.includes("products.json")) {
        return { ok: true, clone: () => ({ body: null }), json: async () => catalog };
      }
      if (url.includes("/checkout/sessions")) {
        giftSessionParams = new URLSearchParams(opts.body);
        return { ok: true, json: async () => ({ id: "cs_e2e_buy", url: "https://stripe/x" }) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/checkout", {
          items: [
            {
              id: "yallternative-gift-card",
              qty: 1,
              variant: "Preset $25",
              giftRecipientEmail: "gift@example.com",
              giftSenderName: "Sam"
            }
          ]
        }),
        env,
        noCtx
      );
      eq(res.status, 200, "e2e: buying a gift card creates a session");
    }
  );
  eq(
    giftSessionParams.get("metadata[gift_card_1_amount_cents]"),
    "2500",
    "e2e: the session records the amount the webhook must put on the card"
  );

  /* 2. Stripe says it was paid. The webhook issues and emails the code. */
  const completed = JSON.stringify({
    id: "evt_e2e_buy",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_e2e_buy",
        customer_details: { email: "sam@example.com" },
        metadata: {
          gift_card_1_amount_cents: "2500",
          gift_card_1_recipient: "gift@example.com",
          gift_card_1_sender: "Sam"
        }
      }
    }
  });
  let issuedCode = null;
  await withFetch(
    async (url, opts) => {
      if (url.includes("api.resend.com")) {
        const message = JSON.parse(opts.body);
        if (message.to === "gift@example.com") {
          issuedCode = /YALL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(message.html)[0];
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", completed, { "Stripe-Signature": signWebhook(completed) }),
        env,
        noCtx
      );
      eq(res.status, 200, "e2e: the purchase webhook succeeds");
    }
  );
  assert(Boolean(issuedCode), "e2e: the recipient was emailed a code");

  /* 3. The recipient checks the balance on the site. */
  const balanceRes = await worker.fetch(
    post("/api/gift-card-balance", { code: issuedCode }),
    env,
    noCtx
  );
  eq(balanceRes.status, 200, "e2e: the balance route finds the new card");
  eq((await balanceRes.json()).balanceCents, 2500, "e2e: it is worth what was paid for it");

  /* 4. They spend it on an $18 soak (+$10 shipping = $28). */
  let couponParams = null;
  await withFetch(
    async (url, opts) => {
      if (url.includes("products.json")) {
        return { ok: true, clone: () => ({ body: null }), json: async () => catalog };
      }
      if (url.includes("/v1/coupons")) {
        couponParams = new URLSearchParams(opts.body);
        return { ok: true, json: async () => ({ id: "coupon_e2e" }) };
      }
      if (url.includes("/checkout/sessions")) {
        return { ok: true, json: async () => ({ id: "cs_e2e_spend", url: "https://stripe/y" }) };
      }
      return null;
    },
    async () => {
      const res = await worker.fetch(
        post("/api/checkout", {
          items: [{ id: "lavender-soak", qty: 1 }],
          giftCardCode: issuedCode
        }),
        env,
        noCtx
      );
      eq(res.status, 200, "e2e: the card is applied at checkout");
    }
  );
  eq(couponParams.get("amount_off"), "2500", "e2e: the whole $25 is applied to a $28 order");

  const held = await worker.fetch(post("/api/gift-card-balance", { code: issuedCode }), env, noCtx);
  eq(held.status, 404, "e2e: with the balance held, the card reads as having nothing spendable");

  /* 5. The order is paid; the hold becomes a debit. */
  const spend = JSON.stringify({
    id: "evt_e2e_spend",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_e2e_spend",
        customer_details: { email: "gift@example.com" },
        metadata: {
          gift_card_redeemed_code: issuedCode,
          gift_card_amount_applied_cents: "2500"
        }
      }
    }
  });
  await withFetch(
    async (url) =>
      url.includes("api.resend.com") ? { ok: true, status: 200, json: async () => ({}) } : null,
    async () => {
      const res = await worker.fetch(
        post("/api/stripe-webhook", spend, { "Stripe-Signature": signWebhook(spend) }),
        env,
        noCtx
      );
      eq(res.status, 200, "e2e: the paid order commits the hold");
    }
  );

  const { giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const finalState = await giftCardLedger(env, issuedCode).getBalance();
  eq(finalState.balanceCents, 0, "e2e: the card is spent");
  eq(finalState.spentCents, 2500, "e2e: ...and the ledger says where it went");
  const audit = await giftCardLedger(env, issuedCode).audit();
  eq(audit.ok, true, "e2e: the ledger reconciles against its own append-only history");
}

/* ==========================================================================
   15. The generated netlify.toml.

   The four Netlify functions are deleted. Their paths must not 404 into the
   SPA-ish void or, worse, keep working from a cached deploy: they answer 410
   Gone, which is the only status that tells a stale client to stop asking.
   ========================================================================== */

function testNetlifyRedirects() {
  console.log("\n15. netlify.toml (the retired functions, and the /api proxy)");
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

  const blocks = toml.split("[[redirects]]").slice(1);
  const rules = blocks.map((block) => ({
    from: (/from\s*=\s*"([^"]+)"/.exec(block) || [])[1],
    to: (/to\s*=\s*"([^"]+)"/.exec(block) || [])[1],
    status: Number((/status\s*=\s*(\d+)/.exec(block) || [])[1])
  }));

  /* Netlify reserves the /.netlify/functions/ prefix and rejects redirect
     rules on it at deploy time ("4 invalid redirect rules"), so the retired
     function URLs get no rule at all: a deleted function answers 404 on its
     own, and nothing in assets/js references those paths any more. */
  for (const legacy of [
    "/.netlify/functions/gift-card-balance",
    "/.netlify/functions/redeem-points",
    "/.netlify/functions/fulfill-gift-card",
    "/.netlify/functions/submit-restock"
  ]) {
    const rule = rules.find((r) => r.from === legacy);
    assert(!rule, `netlify.toml carries no (rejected) redirect rule for ${legacy}`);
  }
  assert(
    !fs.existsSync(path.join(ROOT, "netlify", "functions", "gift-card-balance.js")),
    "the retired Netlify Function source is gone"
  );

  const proxy = rules.find((r) => r.from === "/api/*");
  assert(Boolean(proxy), "netlify.toml proxies the whole /api/* surface to the Worker");
  eq(proxy && proxy.status, 200, "the proxy is a proxy (200), not a cross-origin redirect");
  assert(
    Boolean(proxy) && /^https:\/\/[^/]+\.workers\.dev\/:splat$/.test(proxy.to),
    "the proxy forwards the path with :splat, so every route reaches the Worker"
  );
  assert(
    rules.findIndex((r) => r.from === "/api/*") < rules.findIndex((r) => r.from === "/scripts/*"),
    "the proxy is matched before the blocked-path rules, as Netlify takes the first match"
  );

  assert(
    !fs.existsSync(path.join(ROOT, "netlify", "functions")),
    "netlify/functions is gone -- the money path is one Worker now"
  );
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

  await testRouter();
  await testBalanceRoute();
  await testWebhookRoute();
  await testOrderStatusRoute();
  await testRestockRoute();
  await testEndToEndMoneyPath();
  testNetlifyRedirects();
  resetSchemaMemo();

  console.log(`\nworker-state.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-state.test.js crashed:", err);
  process.exit(1);
});
