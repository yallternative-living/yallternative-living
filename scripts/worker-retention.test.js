/**
 * @fileoverview Unit tests for the retention layer:
 *   - workers/state/retention.js        (D1: order signals, queue, suppression,
 *                                        birthdays, welcome codes, unsub tokens)
 *   - workers/routes/retention-emails.js (templates, the marketing sender, the
 *                                        queue drain, birthdays, loyalty payout)
 *   - workers/routes/retention.js       (the four HTTP routes)
 *   - workers/routes/stripe.js          (createPromotionCode)
 * and the wiring in workers/checkout.js and workers/routes/stripe-webhook.js
 * that drives them -- the Checkout Session params, the webhook side effects and
 * the `scheduled` cron handler.
 *
 * Same harness as scripts/worker-state.test.js: no network, no wrangler. D1 and
 * Durable Object SQLite are emulated on `node:sqlite` (scripts/lib/d1-emulator.js)
 * and only Stripe and Resend are mocked, so every route here is driven through
 * the REAL entrypoint (workers/checkout.js's default export). A test that stubbed
 * the handlers would be testing nothing -- the wiring is the thing that was
 * missing.
 *
 * Run: node scripts/worker-retention.test.js
 */

const path = require("path");
const fs = require("fs");
const nodeCrypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

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

async function throwsAsync(fn, expected, label) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${label} (expected a throw, but it resolved)`);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!expected || message.includes(expected)) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${label}\n      expected "${expected}"\n      got "${message}"`);
    }
  }
}

/* ==========================================================================
   Fixtures and harness
   ========================================================================== */

const WEBHOOK_SECRET = "whsec_retention_suite";
const SIGNING_SECRET = "retention-suite-signing-secret";
const SITE = "https://yallternativeliving.com";

/** A catalogue small enough to read, shaped exactly like products.json. */
const mockCatalog = {
  products: [
    {
      id: "sleep-salve",
      name: "Sleep Salve",
      category: "salves",
      price: 18,
      inStock: true,
      usageGuide: {
        howToApply: "Rub a little on your wrists and temples before bed.",
        storage: "Keep it cool and out of the sun.",
        patchTest: "Patch test on your inner arm first."
      }
    },
    {
      id: "tank-top",
      name: "Y'all Tank Top",
      category: "apparel",
      price: 28,
      inStock: true,
      variants: { label: "Size", options: [{ label: "M" }, { label: "L" }] },
      usageGuide: { howToApply: "Wear it proudly.", storage: "Machine wash cold." }
    }
  ],
  bundles: [],
  sales: [],
  shop: { freeShippingThreshold: 40 }
};

const mockContent = { site: { loyaltyPointsPerDollar: 2, welcomeCode: "YALL10" } };

let ipCounter = 0;

/** A unique client IP per request, so one test's rate limit is not another's. */
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

async function makeEnv(overrides = {}) {
  const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return {
    SITE_ORIGIN: SITE,
    STRIPE_SECRET_KEY: "sk_test_retention",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: "re_test_retention",
    MAGIC_LINK_SECRET: SIGNING_SECRET,
    STRIPE_WELCOME_COUPON_ID: "coupon_welcome_10",
    STRIPE_BIRTHDAY_COUPON_ID: "coupon_five_off",
    STATE_DB: db,
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

/**
 * Swap global.fetch for a recorder that answers products.json, content.json,
 * Stripe and Resend. Everything sent is captured for assertions.
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = {
    stripe: [],
    resend: [],
    promoBodies: [],
    sessionBodies: [],
    sessionLookups: []
  };
  let promoSeq = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = (opts && opts.body) || "";
    if (u.includes("products.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => mockCatalog };
    }
    if (u.includes("content.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => options.content || mockContent
      };
    }
    if (u.includes("events.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => ({ events: [] }) };
    }
    if (u.includes("api.stripe.com/v1/promotion_codes")) {
      const params = new URLSearchParams(body);
      calls.promoBodies.push({ params, headers: (opts && opts.headers) || {} });
      if (options.promoFails) {
        return { ok: false, status: 400, json: async () => ({ error: { message: "no" } }) };
      }
      promoSeq += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `promo_${promoSeq}`,
          code: `MINTED${promoSeq}`,
          expires_at: Number(params.get("expires_at")) || null
        })
      };
    }
    if (u.includes("api.stripe.com/v1/checkout/sessions")) {
      // The session LOOKUP (findSessionByPaymentIntent) and the session CREATE
      // share a path and answer different shapes -- a list versus one object.
      if (u.includes("payment_intent=")) {
        calls.sessionLookups.push(u);
        const found = Object.prototype.hasOwnProperty.call(options, "session")
          ? options.session
          : { id: "cs_test_shipped", customer_details: { email: "Parcel@Example.com" } };
        return { ok: true, status: 200, json: async () => ({ data: found ? [found] : [] }) };
      }
      calls.sessionBodies.push(new URLSearchParams(body));
      return {
        ok: true,
        json: async () => ({ id: "cs_test_retention", url: "https://checkout.stripe.com/pay/x" })
      };
    }
    if (u.includes("api.stripe.com/v1/payment_intents")) {
      calls.stripe.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => options.intents || { data: [], has_more: false }
      };
    }
    if (u.includes("api.stripe.com")) {
      calls.stripe.push(u);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes("api.resend.com")) {
      calls.resend.push({ message: JSON.parse(body), headers: (opts && opts.headers) || {} });
      if (options.resendFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function post(pathname, body, headers = {}) {
  const isString = typeof body === "string";
  return new Request(`${SITE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": isString ? "application/x-www-form-urlencoded" : "application/json",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: isString ? body : JSON.stringify(body)
  });
}

function signWebhook(rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = nodeCrypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function webhookRequest(event) {
  const raw = JSON.stringify(event);
  return new Request(`${SITE}/api/stripe-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signWebhook(raw) },
    body: raw
  });
}

const noCtx = { waitUntil: () => {} };

/* ==========================================================================
   1. workers/state/retention.js
   ========================================================================== */

async function testRetentionState() {
  console.log("\n1. retention.js (D1: signals, queue, suppression, birthdays)");
  const mod = await import("../workers/state/retention.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);

  // --- hashing and unsubscribe tokens -----------------------------------
  const hash = await mod.hashEmail(" Buyer@Example.COM ");
  assert(/^[a-f0-9]{64}$/.test(hash), "hashEmail returns a 64-char hex digest");
  eq(
    hash,
    await mod.hashEmail("buyer@example.com"),
    "hashEmail normalises before hashing, so one customer is one hash"
  );

  const token = await mod.unsubscribeToken(SIGNING_SECRET, "buyer@example.com");
  assert(/^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(token), "the unsubscribe token is id.signature");
  assert(
    !token.includes("@") && !token.includes("buyer") && !token.includes("example"),
    "THE UNSUBSCRIBE TOKEN CARRIES NO PII -- no address, no local part, no domain"
  );
  const verified = await mod.verifyUnsubscribeToken(SIGNING_SECRET, token);
  eq(verified.valid, true, "a token this secret signed verifies");
  eq(
    (await mod.verifyUnsubscribeToken("a-completely-different-secret", token)).valid,
    false,
    "a token signed by another secret does not verify"
  );
  const [id, sig] = token.split(".");
  eq(
    (await mod.verifyUnsubscribeToken(SIGNING_SECRET, `${id}.${sig.replace(/.$/, "0")}`)).valid,
    false,
    "a tampered signature does not verify"
  );
  eq(
    (await mod.verifyUnsubscribeToken(SIGNING_SECRET, `${"f".repeat(32)}.${sig}`)).valid,
    false,
    "an id that was not signed does not verify -- no enumeration of email_contacts"
  );

  // --- MM/DD only --------------------------------------------------------
  eq(mod.normalizeMonthDay("06/14"), "06-14", "MM/DD normalises to MM-DD");
  eq(mod.normalizeMonthDay("06-14"), "06-14", "MM-DD is accepted too");
  for (const bad of ["1990-06-14", "06/14/1990", "13/01", "02/30", "6/4", "", "abc"]) {
    let threw = false;
    try {
      mod.normalizeMonthDay(bad);
    } catch {
      threw = true;
    }
    assert(threw, `normalizeMonthDay rejects "${bad}" -- a year is never accepted`);
  }

  // --- order signals -----------------------------------------------------
  const first = await mod.recordOrder(
    db,
    {
      orderId: "cs_test_a",
      email: "Buyer@Example.com",
      productIds: ["sleep-salve", "sleep-salve", "tank-top"],
      categories: ["salves", "apparel"]
    },
    1000
  );
  eq(first.recorded, true, "recordOrder writes the first time");
  const repeat = await mod.recordOrder(
    db,
    { orderId: "cs_test_a", email: "buyer@example.com", productIds: ["x"] },
    2000
  );
  eq(repeat.recorded, false, "a redelivered order records nothing -- INSERT OR IGNORE");
  const row = await mod.getOrderSignal(db, "cs_test_a");
  assert(row !== null, "the order signal row exists");
  eq(row.email, "buyer@example.com", "the stored address is normalised");
  eq(row.product_ids, "sleep-salve,tank-top", "duplicate product ids are collapsed");
  eq(row.email_hash, await mod.hashEmail("buyer@example.com"), "the row carries the email hash");

  // --- the queue ---------------------------------------------------------
  await throwsAsync(
    () => mod.enqueueEmail(db, { id: "x", kind: "not-a-kind", email: "a@b.co", sendAfter: 1 }),
    "unknown email kind",
    "enqueueEmail refuses a kind the drain cannot render"
  );
  eq(
    (
      await mod.enqueueEmail(
        db,
        {
          id: "usage-guide:cs_test_a",
          kind: "usage-guide",
          email: "buyer@example.com",
          sendAfter: 5000
        },
        1000
      )
    ).queued,
    true,
    "enqueueEmail queues the first time"
  );
  eq(
    (
      await mod.enqueueEmail(
        db,
        {
          id: "usage-guide:cs_test_a",
          kind: "usage-guide",
          email: "buyer@example.com",
          sendAfter: 9999
        },
        1000
      )
    ).queued,
    false,
    "the same queue id is never queued twice"
  );
  await mod.enqueueEmail(
    db,
    {
      id: "review-request:cs_test_a",
      kind: "review-request",
      email: "buyer@example.com",
      sendAfter: 20000
    },
    1000
  );

  eq((await mod.dueEmails(db, 4999)).length, 0, "nothing is due before send_after");
  const due = await mod.dueEmails(db, 30000);
  eq(due.length, 2, "both rows are due later on");
  eq(due[0].id, "usage-guide:cs_test_a", "due rows come back oldest-first");

  await mod.markEmailSent(db, "usage-guide:cs_test_a", 6000);
  eq(
    (await mod.dueEmails(db, 30000)).length,
    1,
    "a sent row is not due again -- the drain cannot double-send"
  );

  let state = { exhausted: false };
  for (let i = 0; i < mod.MAX_SEND_ATTEMPTS; i++) {
    state = await mod.markEmailFailed(db, "review-request:cs_test_a", 21000 + i);
    if (i < mod.MAX_SEND_ATTEMPTS - 1) {
      eq(state.exhausted, false, `attempt ${i + 1} leaves the row pending for another try`);
    }
  }
  eq(state.exhausted, true, "a row stops retrying after MAX_SEND_ATTEMPTS");
  eq(state.attempts, mod.MAX_SEND_ATTEMPTS, "the attempt count is what stopped it");
  eq(
    (await mod.dueEmails(db, 30000)).length,
    0,
    "an exhausted row is no longer picked up by the drain"
  );

  eq(
    await mod.sweepEmailQueue(db, 90, 6000 + 91 * 86400000),
    1,
    "the sweeper drops settled rows and keeps the failed one as evidence"
  );

  // --- suppression -------------------------------------------------------
  eq(await mod.isSuppressed(db, "buyer@example.com"), false, "a new address is not suppressed");
  eq(
    (await mod.suppressEmail(db, "Buyer@Example.com")).alreadySuppressed,
    false,
    "the first unsubscribe is recorded"
  );
  eq(
    (await mod.suppressEmail(db, "buyer@example.com")).alreadySuppressed,
    true,
    "a second unsubscribe is idempotent"
  );
  eq(await mod.isSuppressed(db, "BUYER@example.com"), true, "suppression is case-insensitive");
  eq(
    await mod.isSuppressed(db, "not an address"),
    true,
    "an address that will not normalise is treated as suppressed, never mailed"
  );

  // --- contacts ----------------------------------------------------------
  await mod.rememberContact(db, id, "buyer@example.com");
  eq(await mod.contactForUnsubId(db, id), "buyer@example.com", "the unsub id resolves back");
  eq(await mod.contactForUnsubId(db, "f".repeat(32)), null, "an unknown id resolves to nothing");
  eq(
    await mod.contactForUnsubId(db, "not-hex"),
    null,
    "a malformed id is rejected before the read"
  );

  // --- birthdays ---------------------------------------------------------
  const saved = await mod.saveBirthday(db, { email: "party@example.com", monthDay: "06/14" }, 100);
  eq(saved, { saved: true, updated: false, monthDay: "06-14" }, "a birthday is stored as MM-DD");
  const again = await mod.saveBirthday(db, { email: "party@example.com", monthDay: "07/04" }, 200);
  eq(again.updated, true, "a second submission updates rather than duplicating");
  eq((await mod.birthdaysOn(db, "06-14")).length, 0, "the old date no longer matches");
  eq((await mod.birthdaysOn(db, "07/04"))[0].email, "party@example.com", "the new date matches");
  const bdayRow = await db
    .prepare("SELECT * FROM birthday_club WHERE email = ?")
    .bind("party@example.com")
    .first();
  assert(
    Object.keys(bdayRow).every((k) => !/year|dob|birth_date/.test(k)),
    "the birthday_club row has no column that could hold a year"
  );
  eq(bdayRow.consent_at, 200, "the consent timestamp is stored");

  // --- welcome codes -----------------------------------------------------
  const expiresAt = Math.floor(5000 / 1000) + 45 * 86400;
  eq(
    (await mod.saveWelcomeCode(db, { email: "new@example.com", code: "ABC", expiresAt }, 5000))
      .stored,
    true,
    "the first welcome code for an address is stored"
  );
  eq(
    (await mod.saveWelcomeCode(db, { email: "new@example.com", code: "XYZ", expiresAt }, 6000))
      .stored,
    false,
    "a second mint for the same address is ignored -- one code per subscriber"
  );
  eq(
    (await mod.getWelcomeCode(db, "new@example.com", 6000)).code,
    "ABC",
    "the stored code is the first one, not the second"
  );
  eq(
    await mod.getWelcomeCode(db, "new@example.com", (expiresAt + 1) * 1000),
    null,
    "an expired welcome code is not handed back"
  );
}

/* ==========================================================================
   2. createPromotionCode
   ========================================================================== */

async function testCreatePromotionCode() {
  console.log("\n2. stripe.js createPromotionCode");
  const { createPromotionCode } = await import("../workers/routes/stripe.js");
  const env = { STRIPE_SECRET_KEY: "sk_test" };

  await withMocks(async (calls) => {
    const promo = await createPromotionCode(
      env,
      {
        couponId: "coupon_welcome_10",
        maxRedemptions: 1,
        expiresAt: 1800000000,
        firstTimeTransaction: true,
        metadata: { purpose: "welcome", email_hash: "abc" }
      },
      "welcome-abc"
    );
    assert(promo !== null, "a promotion code comes back");
    eq(promo.code, "MINTED1", "the code Stripe generated is returned");
    const sent = calls.promoBodies[0];
    assert(sent !== undefined, "a request actually reached Stripe");
    /* Stripe 2026-06-24.dahlia: the coupon is nested under `promotion`. */
    eq(sent.params.get("promotion[type]"), "coupon", "the promotion is a coupon promotion");
    eq(
      sent.params.get("promotion[coupon]"),
      "coupon_welcome_10",
      "it is minted against the shared coupon"
    );
    eq(sent.params.get("coupon"), null, "the retired flat coupon parameter is not sent");
    eq(
      sent.params.get("max_redemptions"),
      "1",
      "max_redemptions is 1 -- the code is not shareable"
    );
    eq(
      sent.params.get("restrictions[first_time_transaction]"),
      "true",
      "the welcome code is first-order only"
    );
    eq(sent.params.get("expires_at"), "1800000000", "expires_at is passed through in seconds");
    eq(sent.params.get("metadata[email_hash]"), "abc", "metadata carries the hash");
    assert(
      !Array.from(sent.params.keys()).some((k) => /email\]$/.test(k)),
      "no raw email address is written into Stripe metadata"
    );
    eq(
      sent.headers["Idempotency-Key"],
      "welcome-abc",
      "the idempotency key is sent, so a retry re-uses the same code"
    );
    assert(
      sent.params.get("code") === null,
      "the code string is Stripe's, so two mints cannot collide"
    );
  });

  await withMocks(
    async () => {
      const refused = await createPromotionCode(env, { couponId: "coupon_x" }, "k");
      eq(refused, null, "a Stripe refusal returns null rather than a fake code");
    },
    { promoFails: true }
  );

  eq(
    await createPromotionCode(env, { couponId: "" }, "k"),
    null,
    "no coupon id configured means no request and no code"
  );
}

/* ==========================================================================
   3. Templates
   ========================================================================== */

async function testTemplates() {
  console.log("\n3. Email templates");
  const mod = await import("../workers/routes/retention-emails.js");

  const usage = mod.usageGuideEmail(
    [{ id: "sleep-salve", name: "Sleep Salve", usageGuide: mockCatalog.products[0].usageGuide }],
    SITE,
    `${SITE}/thank-you.html#points=tok`
  );
  assert(usage.subject.includes("Sleep Salve"), "the usage email names the product");
  assert(
    usage.html.includes("Rub a little on your wrists"),
    "the usage copy comes from products.json usageGuide, not from a copy in the Worker"
  );
  assert(usage.text.includes("Patch test"), "the plain-text part carries the guide too");
  assert(usage.html.includes("points=tok"), "the points link is included when a token was minted");
  eq(
    mod
      .usageGuideEmail([{ id: "x", name: "X", usageGuide: null }], SITE, "")
      .html.includes("Check your balance"),
    false,
    "no token means no points link at all, rather than a dead one"
  );

  const review = mod.reviewRequestEmail({ id: "sleep-salve", name: "Sleep Salve" }, SITE);
  assert(
    review.html.includes(`${SITE}/products/sleep-salve.html#pdpReviews`),
    "the review ask links straight to that product's own review block"
  );
  const reviewBody = `${review.subject} ${review.html} ${review.text}`.toLowerCase();
  const bannedInReviewCopy = [
    "% off",
    "discount",
    "coupon",
    "promo code",
    "five star",
    "5-star",
    "positive review"
  ];
  for (const word of bannedInReviewCopy) {
    assert(!reviewBody.includes(word), `the review ask never says "${word}" -- no incentive, ever`);
  }
  assert(
    reviewBody.includes("good, bad") || reviewBody.includes("truth"),
    "the review ask explicitly invites a negative review"
  );

  const birthday = mod.birthdayEmail("BDAY1", 500, SITE);
  assert(birthday.html.includes("BDAY1"), "the birthday email shows the code");
  assert(birthday.subject.includes("5.00"), "the birthday subject names the amount");

  const reward = mod.loyaltyRewardEmail("LOYAL1", 500, 100, SITE, "");
  assert(reward.html.includes("LOYAL1"), "the loyalty email shows the code");
  assert(reward.text.includes("100 Alt-Points"), "it says what was spent");

  const recovery = mod.recoveryEmail("https://checkout.stripe.com/c/pay/recover_1");
  assert(
    recovery.html.includes("recover_1"),
    "the recovery email links the Stripe-issued recovery URL"
  );

  // Delay policy. Every one of these is measured from DISPATCH, not payment.
  eq(mod.REVIEW_DELAY_DAYS.fast, 7, "apparel and gift cards are asked 7 days after dispatch");
  assert(
    mod.REVIEW_DELAY_DAYS.slow >= 10 && mod.REVIEW_DELAY_DAYS.slow <= 14,
    "salves, soaks and butter are asked between day 10 and day 14 after dispatch"
  );
  assert(
    mod.USAGE_GUIDE_AFTER_DISPATCH_MS >= 3 * 86400000 &&
      mod.USAGE_GUIDE_AFTER_DISPATCH_MS <= 6 * 86400000,
    "the how-to-use email allows ground transit before it lands"
  );
  assert(
    mod.ASSUMED_DISPATCH_MS >= 3 * 86400000,
    "an unshipped order is assumed to sit at least as long as policies.html promises (1-3 days)"
  );
  assert(
    mod.USAGE_GUIDE_DELAY_MS === undefined,
    "the old payment-anchored constant is gone, not left behind describing a schedule nothing uses"
  );
}

/* ==========================================================================
   4. Scheduling, the drain and the marketing sender
   ========================================================================== */

async function testScheduleAndDrain() {
  console.log("\n4. Scheduling, suppression and the queue drain");
  const mod = await import("../workers/routes/retention-emails.js");
  const state = await import("../workers/state/retention.js");
  const env = await makeEnv();
  const db = env.STATE_DB;
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  const ASSUMED_DISPATCH_DAYS = Math.round(mod.ASSUMED_DISPATCH_MS / 86400000);

  const queued = await mod.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_slow",
      email: "salve@example.com",
      placed_at: now,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now
  );
  eq(queued, { usageGuide: true, reviewRequest: true }, "an order queues both post-purchase sends");
  const slowRow = await state.getQueuedEmail(db, "review-request:cs_test_slow");
  assert(slowRow !== null, "the review row exists");
  const slowDue = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("review-request:cs_test_slow")
    .first();
  eq(
    Math.round((slowDue.send_after - now) / 86400000),
    ASSUMED_DISPATCH_DAYS + mod.REVIEW_DELAY_DAYS.slow,
    "a salve order waits the slow delay, counted from assumed dispatch"
  );
  const slowGuide = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("usage-guide:cs_test_slow")
    .first();
  eq(
    slowGuide.send_after,
    now + mod.ASSUMED_DISPATCH_MS + mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "the how-to-use email clears the shop's own 1-3 day dispatch window first"
  );
  assert(
    slowGuide.send_after - now > 3 * 86400000,
    "it can no longer land before an order dispatched at the end of that window"
  );

  await mod.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_fast",
      email: "shirt@example.com",
      placed_at: now,
      product_ids: "tank-top",
      categories: "apparel"
    },
    now
  );
  const fastDue = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("review-request:cs_test_fast")
    .first();
  eq(
    Math.round((fastDue.send_after - now) / 86400000),
    ASSUMED_DISPATCH_DAYS + mod.REVIEW_DELAY_DAYS.fast,
    "an apparel order waits the fast delay, counted from assumed dispatch"
  );

  await mod.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_mixed",
      email: "both@example.com",
      placed_at: now,
      product_ids: "tank-top,sleep-salve",
      categories: "apparel,salves"
    },
    now
  );
  const mixedDue = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("review-request:cs_test_mixed")
    .first();
  eq(
    Math.round((mixedDue.send_after - now) / 86400000),
    ASSUMED_DISPATCH_DAYS + mod.REVIEW_DELAY_DAYS.slow,
    "a mixed order takes the slow delay -- asking about a salve too early is the mistake that matters"
  );

  /* A gift card is emailed by the same webhook that records the order: there is
     no parcel, so charging it the dispatch window would delay a how-to-use note
     about something the recipient already had before the tab closed. */
  await mod.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_card",
      email: "card@example.com",
      placed_at: now,
      product_ids: "yallternative-gift-card",
      categories: "gift-cards"
    },
    now
  );
  const cardGuide = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("usage-guide:cs_test_card")
    .first();
  eq(
    cardGuide.send_after,
    now + mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "a gift-card-only order is dispatched at checkout, so it waits no shipping window"
  );

  await mod.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_card_plus",
      email: "cardplus@example.com",
      placed_at: now,
      product_ids: "yallternative-gift-card,sleep-salve",
      categories: "gift-cards,salves"
    },
    now
  );
  const cardPlusGuide = await db
    .prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("usage-guide:cs_test_card_plus")
    .first();
  eq(
    cardPlusGuide.send_after,
    now + mod.ASSUMED_DISPATCH_MS + mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "a card bought alongside a salve still waits: something in that order gets packed"
  );

  /* Those two orders exist only to check the arithmetic above. Drop their rows
     so the drain further down still sees exactly the queue it was written for --
     a shared fixture table is how a "sent 4 emails" assertion quietly becomes a
     "sent 6" one every time somebody adds a scheduling case. */
  await db
    .prepare(
      "DELETE FROM email_queue WHERE id LIKE '%:cs_test_card' OR id LIKE '%:cs_test_card_plus'"
    )
    .run();

  // --- the drain ---------------------------------------------------------
  const later = now + 30 * 86400000;
  await state.suppressEmail(db, "shirt@example.com", "unsubscribe", now + 1000);

  const summary = await withMocks(async (calls) => {
    const result = await mod.drainEmailQueue(env, noCtx, later, 50);
    // The suppressed recipient's two rows must not have produced a send.
    const recipients = calls.resend.map((c) => c.message.to);
    assert(
      !recipients.includes("shirt@example.com"),
      "AN UNSUBSCRIBED ADDRESS IS NOT MAILED, even for a send queued before the opt-out"
    );
    assert(recipients.includes("salve@example.com"), "the un-suppressed recipient is mailed");

    const sample = calls.resend.find((c) => c.message.to === "salve@example.com");
    assert(sample !== undefined, "a real Resend request was made");
    const headers = sample.message.headers || {};
    assert(
      typeof headers["List-Unsubscribe"] === "string" && headers["List-Unsubscribe"].length > 0,
      "every marketing send carries a List-Unsubscribe header"
    );
    eq(
      headers["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click",
      "and the RFC 8058 one-click header beside it"
    );
    const httpsPart = (headers["List-Unsubscribe"].match(/<(https:[^>]+)>/) || [])[1] || "";
    assert(httpsPart.includes("/api/unsubscribe?t="), "the header points at POST /api/unsubscribe");
    assert(
      !httpsPart.includes("@") && !httpsPart.includes("salve"),
      "NO PII IN THE UNSUBSCRIBE URL -- it carries an opaque HMAC id"
    );
    assert(
      String(sample.message.html).includes("unsubscribe"),
      "the visible body carries an opt-out line too"
    );
    assert(
      sample.headers["Idempotency-Key"] === "usage-guide:cs_test_slow" ||
        calls.resend.some((c) => c.headers["Idempotency-Key"] === "usage-guide:cs_test_slow"),
      "the queue row id is the Resend idempotency key"
    );
    return result;
  });

  eq(
    summary.sent,
    4,
    "four sends left the Worker -- both rows for each of the two un-suppressed buyers"
  );
  eq(summary.skipped, 2, "the suppressed recipient's two rows were skipped, not retried");
  eq(
    (await state.dueEmails(db, later)).length,
    0,
    "nothing is left pending -- every row reached a terminal state"
  );

  // A second drain must be a no-op, not a second send.
  const second = await withMocks(async (calls) => {
    const result = await mod.drainEmailQueue(env, noCtx, later, 50);
    eq(calls.resend.length, 0, "a repeated drain sends nothing");
    return result;
  });
  eq(second.processed, 0, "a repeated drain has nothing to process");

  // --- a refused send is retried, not lost -------------------------------
  const retryEnv = await makeEnv();
  await mod.scheduleOrderSequence(
    retryEnv.STATE_DB,
    {
      order_id: "cs_test_retry",
      email: "retry@example.com",
      placed_at: now,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now
  );
  const failed = await withMocks(async () => mod.drainEmailQueue(retryEnv, noCtx, later, 50), {
    resendFails: true
  });
  eq(failed.failed, 2, "a Resend refusal is counted as a failure");
  eq(
    (await state.dueEmails(retryEnv.STATE_DB, later)).length,
    2,
    "and the rows stay pending so the next cron tick tries again"
  );

  // --- a row the templates cannot render is skipped, never retried -------
  const junkEnv = await makeEnv();
  await state.enqueueEmail(
    junkEnv.STATE_DB,
    {
      id: "recovery:cs_junk",
      kind: "recovery",
      email: "junk@example.com",
      payload: {},
      sendAfter: now
    },
    now
  );
  const junk = await withMocks(async (calls) => {
    const result = await mod.drainEmailQueue(junkEnv, noCtx, later, 50);
    eq(calls.resend.length, 0, "a recovery row with no URL sends nothing");
    return result;
  });
  eq(junk.skipped, 1, "and is marked skipped rather than retried forever");

  // --- no signing secret means no marketing email at all -----------------
  const unsignedEnv = await makeEnv({ MAGIC_LINK_SECRET: undefined });
  await mod.scheduleOrderSequence(
    unsignedEnv.STATE_DB,
    {
      order_id: "cs_test_unsigned",
      email: "nosecret@example.com",
      placed_at: now,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now
  );
  await withMocks(async (calls) => {
    await mod.drainEmailQueue(unsignedEnv, noCtx, later, 50);
    eq(
      calls.resend.length,
      0,
      "with no MAGIC_LINK_SECRET nothing is sent -- an email with no working opt-out is not sent at all"
    );
  });
}

/* ==========================================================================
   5. Birthday club job
   ========================================================================== */

async function testBirthdayJob() {
  console.log("\n5. The birthday club cron job");
  const mod = await import("../workers/routes/retention-emails.js");
  const state = await import("../workers/state/retention.js");
  const env = await makeEnv();
  const db = env.STATE_DB;

  // 2026-06-14, 14:00 UTC == 10:00 America/New_York (EDT).
  const morning = Date.UTC(2026, 5, 14, 14, 0, 0);
  const parts = mod.shopDateParts(morning);
  eq(parts.monthDay, "06-14", "the date is read in the shop's timezone, not UTC");
  eq(parts.hour, 10, "and so is the hour");
  eq(
    mod.shopDateParts(Date.UTC(2026, 5, 15, 3, 0, 0)).monthDay,
    "06-14",
    "3am UTC on the 15th is still the 14th in Landrum -- the UTC date would send a day early"
  );

  await state.saveBirthday(db, { email: "party@example.com", monthDay: "06/14" }, morning - 1000);
  await state.saveBirthday(db, { email: "quiet@example.com", monthDay: "06/14" }, morning - 1000);
  await state.suppressEmail(db, "quiet@example.com", "unsubscribe", morning - 500);

  const tooEarly = await withMocks(async (calls) => {
    const result = await mod.runBirthdayClub(env, noCtx, Date.UTC(2026, 5, 14, 8, 0, 0));
    eq(calls.promoBodies.length, 0, "no code is minted before 9am local time");
    return result;
  });
  eq(tooEarly.queued, 0, "and nothing is queued");

  const run = await withMocks(async (calls) => {
    const result = await mod.runBirthdayClub(env, noCtx, morning);
    eq(
      calls.promoBodies.length,
      1,
      "one code per eligible member -- the suppressed one is skipped"
    );
    const params = calls.promoBodies[0].params;
    eq(params.get("max_redemptions"), "1", "a birthday code is single-use");
    eq(params.get("promotion[type]"), "coupon", "the birthday promotion is a coupon promotion");
    eq(params.get("promotion[coupon]"), "coupon_five_off", "minted against the shared $5 coupon");
    const days = (Number(params.get("expires_at")) - Math.floor(morning / 1000)) / 86400;
    eq(Math.round(days), 30, "a birthday code expires in 30 days");
    eq(
      calls.promoBodies[0].headers["Idempotency-Key"],
      `birthday-${await state.hashEmail("party@example.com")}-2026`,
      "the Stripe idempotency key is per member per year, and carries a hash not an address"
    );
    return result;
  });
  eq(run.matched, 2, "both members match today");
  eq(run.queued, 1, "one send is queued");

  const rerun = await withMocks(async (calls) => {
    const result = await mod.runBirthdayClub(env, noCtx, morning + 3600000);
    eq(calls.promoBodies.length, 0, "the next hourly tick mints nothing more");
    return result;
  });
  eq(rerun.queued, 0, "and queues nothing more -- one code per person per birthday");

  // A year later the same member is eligible again.
  const nextYear = Date.UTC(2027, 5, 14, 14, 0, 0);
  const later = await withMocks(async () => mod.runBirthdayClub(env, noCtx, nextYear));
  eq(later.queued, 1, "the same member is eligible again next year");

  const unconfigured = await makeEnv({ STRIPE_BIRTHDAY_COUPON_ID: undefined });
  await state.saveBirthday(unconfigured.STATE_DB, {
    email: "party@example.com",
    monthDay: "06/14"
  });
  const noCoupon = await withMocks(async (calls) => {
    const result = await mod.runBirthdayClub(unconfigured, noCtx, morning);
    eq(calls.promoBodies.length, 0, "with no coupon id configured nothing is minted");
    return result;
  });
  eq(noCoupon.queued, 0, "and nothing is queued against a coupon that does not exist");
}

/* ==========================================================================
   6. Loyalty: credit, payout, and the balance route's token rule
   ========================================================================== */

async function testLoyalty() {
  console.log("\n6. Loyalty points: credit, atomic payout, balance");
  const mod = await import("../workers/routes/retention-emails.js");
  const { balance, statement } = await import("../workers/state/loyalty.js");
  const env = await makeEnv();
  const db = env.STATE_DB;
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);

  const credited = await withMocks(async () =>
    mod.creditLoyaltyForOrder(
      env,
      noCtx,
      { orderId: "cs_points_1", email: "Points@Example.com", amountCents: 4550 },
      now
    )
  );
  eq(
    credited.points,
    90,
    "points come from content.json's loyaltyPointsPerDollar (2) on whole dollars ($45)"
  );
  eq(await balance(db, "points@example.com"), 90, "the balance is the credited points");
  eq(credited.reward.reason, "below_threshold", "90 points is below the 100-point threshold");

  const replay = await withMocks(async () =>
    mod.creditLoyaltyForOrder(
      env,
      noCtx,
      { orderId: "cs_points_1", email: "points@example.com", amountCents: 4550 },
      now
    )
  );
  eq(replay.credited, false, "a redelivered order credits nothing twice");
  eq(await balance(db, "points@example.com"), 90, "and the balance is unchanged");

  const paid = await withMocks(async (calls) => {
    const result = await mod.creditLoyaltyForOrder(
      env,
      noCtx,
      { orderId: "cs_points_2", email: "points@example.com", amountCents: 1000 },
      now + 1000
    );
    eq(calls.promoBodies.length, 1, "crossing the threshold mints exactly one code");
    eq(calls.promoBodies[0].params.get("max_redemptions"), "1", "the reward code is single-use");
    return result;
  });
  eq(paid.points, 20, "the second order credits 20 points");
  eq(paid.reward.paid, true, "and the payout fires");
  eq(
    await balance(db, "points@example.com"),
    10,
    "the ledger is debited by exactly the threshold (90 + 20 - 100)"
  );
  const entries = (await statement(db, "points@example.com")).entries;
  eq(
    entries.filter((e) => e.points < 0).length,
    1,
    "exactly one debit row exists -- the ledger stays append-only and auditable"
  );

  const queuedReward = await db
    .prepare("SELECT kind, payload FROM email_queue WHERE kind = 'loyalty-reward'")
    .all();
  eq(queuedReward.results.length, 1, "one reward email is queued");
  assert(
    JSON.parse(queuedReward.results[0].payload).code === "MINTED1",
    "the queued payload carries the minted code"
  );

  // Replaying the SAME order must not debit again.
  const replayPaid = await withMocks(async () =>
    mod.payOutLoyalty(env, db, { email: "points@example.com", orderId: "cs_points_2" }, now + 2000)
  );
  eq(
    replayPaid.reason,
    "below_threshold",
    "a replay below the threshold pays nothing and debits nothing"
  );
  eq(await balance(db, "points@example.com"), 10, "the balance is untouched by the replay");

  // A mint failure must throw rather than silently swallowing spent points.
  const failEnv = await makeEnv();
  await withMocks(
    async () => {
      await mod.creditLoyaltyForOrder(
        failEnv,
        noCtx,
        { orderId: "cs_fail_1", email: "unlucky@example.com", amountCents: 10000 },
        now
      );
    },
    { promoFails: false }
  ).catch(() => {});
  await throwsAsync(
    () =>
      withMocks(
        async () =>
          mod.payOutLoyalty(
            failEnv,
            failEnv.STATE_DB,
            { email: "unlucky@example.com", orderId: "cs_fail_2" },
            now
          ),
        { promoFails: true }
      ),
    "Stripe refused",
    "a refused mint throws, so Stripe retries the webhook and the points are not lost silently"
  );
}

/* ==========================================================================
   7. The four routes, through the real entrypoint
   ========================================================================== */

async function testRoutes() {
  console.log("\n7. Routes: /unsubscribe, /welcome-code, /birthday-club, /loyalty-balance");
  const worker = (await import("../workers/checkout.js")).default;
  const state = await import("../workers/state/retention.js");
  const { signToken } = await import("../workers/state/magic-link.js");

  // --- /api/welcome-code -------------------------------------------------
  const env = await makeEnv();
  await withMocks(async (calls) => {
    const res = await worker.fetch(
      post("/api/welcome-code", { email: "New@Example.com" }),
      env,
      noCtx
    );
    const body = await res.json();
    eq(res.status, 200, "a valid welcome-code request is a 200");
    eq(body.configured, true, "the route reports itself configured");
    eq(body.code, "MINTED1", "and returns the minted code");
    eq(
      res.headers.get("Cache-Control"),
      "no-store",
      "a minted code is never stored in a shared cache"
    );
    eq(
      res.headers.get("Access-Control-Allow-Origin"),
      SITE,
      "CORS stays locked to the site origin"
    );
    eq(
      calls.promoBodies[0].params.get("restrictions[first_time_transaction]"),
      "true",
      "first order only"
    );

    const again = await worker.fetch(
      post("/api/welcome-code", { email: "new@example.com" }),
      env,
      noCtx
    );
    const againBody = await again.json();
    eq(againBody.code, "MINTED1", "a repeat request returns the SAME code");
    eq(calls.promoBodies.length, 1, "and mints nothing more -- one code per subscriber");
  });

  await withMocks(async () => {
    const bad = await worker.fetch(post("/api/welcome-code", { email: "nope" }), env, noCtx);
    eq(bad.status, 400, "an unparseable address is refused");
    const body = await bad.json();
    assert(
      typeof body.error === "string" && body.error.length > 0,
      "with a message a person can act on"
    );
  });

  const unconfigured = await makeEnv({ STRIPE_WELCOME_COUPON_ID: undefined });
  await withMocks(async (calls) => {
    const res = await worker.fetch(
      post("/api/welcome-code", { email: "a@b.co" }),
      unconfigured,
      noCtx
    );
    const body = await res.json();
    eq(res.status, 200, "an unconfigured route still answers 200");
    eq(
      body.configured,
      false,
      "and says so, which is what makes welcome.html fall back to the CMS code"
    );
    eq(calls.promoBodies.length, 0, "nothing is minted");
  });

  // --- /api/unsubscribe --------------------------------------------------
  const unsubEnv = await makeEnv();
  const token = await state.unsubscribeToken(SIGNING_SECRET, "leaver@example.com");
  await state.rememberContact(
    unsubEnv.STATE_DB,
    await state.unsubscribeId(SIGNING_SECRET, "leaver@example.com"),
    "leaver@example.com"
  );
  await withMocks(async () => {
    // Exactly what a mail client's one-click POST looks like: no Origin, a
    // form body, and the token in the query string.
    const req = new Request(`${SITE}/api/unsubscribe?t=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Forwarded-For": freshIp()
      },
      body: "List-Unsubscribe=One-Click"
    });
    const res = await worker.fetch(req, unsubEnv, noCtx);
    eq(res.status, 200, "a one-click unsubscribe from a mail client succeeds");
    eq((await res.json()).success, true, "and reports success");
    eq(
      await state.isSuppressed(unsubEnv.STATE_DB, "leaver@example.com"),
      true,
      "the address is now suppressed"
    );

    const junk = await worker.fetch(
      new Request(`${SITE}/api/unsubscribe?t=${"a".repeat(32)}.${"b".repeat(32)}`, {
        method: "POST",
        headers: { "X-Forwarded-For": freshIp() }
      }),
      unsubEnv,
      noCtx
    );
    eq(junk.status, 400, "a forged token is refused");

    const none = await worker.fetch(
      new Request(`${SITE}/api/unsubscribe`, {
        method: "POST",
        headers: { "X-Forwarded-For": freshIp() }
      }),
      unsubEnv,
      noCtx
    );
    eq(none.status, 400, "a request with no token at all is refused");
  });

  // --- /api/birthday-club ------------------------------------------------
  const bdayEnv = await makeEnv();
  await withMocks(async () => {
    const res = await worker.fetch(
      post("/api/birthday-club", { email: "Cake@Example.com", birthday: "06/14" }),
      bdayEnv,
      noCtx
    );
    const body = await res.json();
    eq(res.status, 200, "a JSON birthday submission succeeds");
    eq(body.success, true, "and says so");
    const row = await bdayEnv.STATE_DB.prepare("SELECT * FROM birthday_club WHERE email = ?")
      .bind("cake@example.com")
      .first();
    assert(row !== null, "the membership row exists");
    eq(row.month_day, "06-14", "stored as MM-DD");
    assert(Number(row.consent_at) > 0, "with a consent timestamp");

    const withYear = await worker.fetch(
      post("/api/birthday-club", { email: "cake@example.com", birthday: "1990-06-14" }),
      bdayEnv,
      noCtx
    );
    eq(withYear.status, 400, "a full date of birth is refused -- MM/DD only, never a year");

    const hp = await worker.fetch(
      post("/api/birthday-club", {
        email: "bot@example.com",
        birthday: "01/01",
        website_hp: "spam"
      }),
      bdayEnv,
      noCtx
    );
    eq(hp.status, 200, "a honeypot hit gets the same success shape a person gets");
    eq(
      await bdayEnv.STATE_DB.prepare("SELECT 1 AS hit FROM birthday_club WHERE email = ?")
        .bind("bot@example.com")
        .first(),
      null,
      "but nothing is stored for it"
    );

    // The no-JavaScript path: a plain form post gets a redirect back.
    const formRes = await worker.fetch(
      post("/api/birthday-club", "email=noscript%40example.com&birthday=07%2F04"),
      bdayEnv,
      noCtx
    );
    eq(formRes.status, 303, "a plain form post is answered with a redirect, not raw JSON");
    assert(
      String(formRes.headers.get("Location")).includes("birthday=saved"),
      "and lands back on thank-you.html with the result in the URL"
    );
    const noscriptRow = await bdayEnv.STATE_DB.prepare(
      "SELECT month_day FROM birthday_club WHERE email = ?"
    )
      .bind("noscript@example.com")
      .first();
    eq(noscriptRow.month_day, "07-04", "and the form post really stored the birthday");
  });

  // --- /api/loyalty-balance ----------------------------------------------
  const pointsEnv = await makeEnv();
  const { credit } = await import("../workers/state/loyalty.js");
  await credit(pointsEnv.STATE_DB, {
    email: "holder@example.com",
    points: 40,
    orderId: "cs_hold_1"
  });
  await withMocks(async () => {
    const noToken = await worker.fetch(
      post("/api/loyalty-balance", { email: "holder@example.com" }),
      pointsEnv,
      noCtx
    );
    eq(
      noToken.status,
      403,
      "A BALANCE IS NEVER READABLE BY EMAIL ALONE -- the signed token is required"
    );

    const minted = await signToken(SIGNING_SECRET, {
      email: "holder@example.com",
      purpose: "points",
      ttlSeconds: 3600
    });
    const ok = await worker.fetch(
      post("/api/loyalty-balance", { email: "holder@example.com", token: minted.token }),
      pointsEnv,
      noCtx
    );
    const body = await ok.json();
    eq(ok.status, 200, "email plus its own token reads the balance");
    eq(body.balance, 40, "and the balance is right");
    eq(body.threshold, 100, "the payout threshold is reported");
    eq(body.pointsToReward, 60, "so is the distance to the next payout");

    const mismatched = await worker.fetch(
      post("/api/loyalty-balance", { email: "someone.else@example.com", token: minted.token }),
      pointsEnv,
      noCtx
    );
    eq(mismatched.status, 403, "a token for one address cannot read another's balance");

    const wrongPurpose = await signToken(SIGNING_SECRET, {
      email: "holder@example.com",
      purpose: "order-status",
      ttlSeconds: 3600
    });
    const refused = await worker.fetch(
      post("/api/loyalty-balance", { email: "holder@example.com", token: wrongPurpose.token }),
      pointsEnv,
      noCtx
    );
    eq(refused.status, 403, "an order-status token cannot be replayed at the points endpoint");
  });

  // --- STATE_DB missing --------------------------------------------------
  const noDb = await makeEnv({ STATE_DB: undefined });
  await withMocks(async () => {
    for (const [route, body] of [
      ["/api/unsubscribe", { token }],
      ["/api/birthday-club", { email: "a@b.co", birthday: "01/01" }],
      ["/api/loyalty-balance", { email: "a@b.co", token: "x" }]
    ]) {
      const res = await worker.fetch(post(route, body), noDb, noCtx);
      eq(res.status, 503, `${route} answers 503 without STATE_DB rather than pretending`);
    }
  });
}

/* ==========================================================================
   8. Checkout Session params
   ========================================================================== */

async function testCheckoutSessionParams() {
  console.log("\n8. Checkout Session: recovery, consent and retention metadata");
  const worker = (await import("../workers/checkout.js")).default;
  const env = await makeEnv();

  await withMocks(async (calls) => {
    const res = await worker.fetch(
      post("/api/checkout", {
        items: [
          { id: "sleep-salve", qty: 2 },
          { id: "tank-top", qty: 1, variant: "M" }
        ]
      }),
      env,
      noCtx
    );
    eq(res.status, 200, "the checkout still creates a session");
    const params = calls.sessionBodies[0];
    assert(params !== undefined, "a Checkout Session request reached Stripe");

    eq(
      params.get("after_expiration[recovery][enabled]"),
      "true",
      "abandoned-checkout recovery is enabled, which is what generates the recovery URL"
    );
    eq(
      params.get("consent_collection[promotions]"),
      "auto",
      "the marketing opt-in box is offered, so the recovery email has real consent behind it"
    );
    eq(
      params.get("consent_collection[terms_of_service]"),
      "required",
      "a terms checkbox is required -- dispute evidence, per audit R5"
    );
    const termsText = params.get("custom_text[terms_of_service_acceptance][message]") || "";
    assert(termsText.includes(`${SITE}/terms.html`), "the terms text links /terms.html");
    assert(termsText.includes(`${SITE}/policies.html`), "and /policies.html");

    eq(
      params.get("metadata[retention_product_ids]"),
      "sleep-salve,tank-top",
      "the session carries the product ids the retention layer needs"
    );
    eq(
      params.get("metadata[retention_categories]"),
      "salves,apparel",
      "and their categories, which decide the review-request delay"
    );
    assert(
      !Array.from(params.keys()).some((k) => k.startsWith("metadata[") && /email/.test(k)),
      "no customer address is written into session metadata by the retention wiring"
    );
  });
}

/* ==========================================================================
   9. The webhook, end to end
   ========================================================================== */

async function testWebhookWiring() {
  console.log("\n9. Webhook: order signal, sequence, points, recovery");
  const worker = (await import("../workers/checkout.js")).default;
  const state = await import("../workers/state/retention.js");
  const { balance } = await import("../workers/state/loyalty.js");
  const env = await makeEnv();
  const db = env.STATE_DB;

  const completed = {
    id: "evt_completed_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_hooked",
        amount_subtotal: 5000,
        amount_total: 5000,
        customer_details: { email: "Hooked@Example.com" },
        metadata: {
          retention_product_ids: "sleep-salve",
          retention_categories: "salves"
        }
      }
    }
  };

  await withMocks(async () => {
    const res = await worker.fetch(webhookRequest(completed), env, noCtx);
    eq(res.status, 200, "the webhook accepts a completed session");
    eq((await res.json()).received, true, "and reports it");
  });

  const signal = await state.getOrderSignal(db, "cs_test_hooked");
  assert(signal !== null, "one order_signals row was written");
  eq(signal.email, "hooked@example.com", "with the normalised address");
  eq(signal.product_ids, "sleep-salve", "and the products, copied from session metadata");
  assert(
    signal.email_hash && signal.email_hash !== signal.email,
    "and a hash that is not the address"
  );

  const queued = await db.prepare("SELECT id, kind FROM email_queue ORDER BY id").all();
  const kinds = queued.results.map((r) => r.kind).sort();
  eq(
    kinds,
    ["loyalty-reward", "review-request", "usage-guide"],
    "both post-purchase sends are queued -- plus the payout, because this order crossed the threshold"
  );
  // $50 x 2 points/dollar = 100 points, which IS the threshold, so the Worker
  // spends them on the customer's behalf in the same webhook.
  eq(
    await balance(db, "hooked@example.com"),
    0,
    "100 points were credited and immediately paid out, leaving a zero balance"
  );
  const ledger = await db
    .prepare("SELECT points, reason FROM loyalty_ledger WHERE email = ? ORDER BY id")
    .bind("hooked@example.com")
    .all();
  eq(
    ledger.results.map((r) => r.points),
    [100, -100],
    "one credit row and one debit row -- the ledger stays append-only"
  );

  // A redelivery of the same event must change nothing.
  await withMocks(async () => {
    const again = await worker.fetch(
      webhookRequest({ ...completed, id: "evt_completed_2" }),
      env,
      noCtx
    );
    eq(again.status, 200, "a second delivery is accepted");
  });
  eq(
    (await db.prepare("SELECT COUNT(*) AS n FROM order_signals").first()).n,
    1,
    "and records no second order signal"
  );
  eq(
    (await db.prepare("SELECT COUNT(*) AS n FROM email_queue WHERE kind = 'usage-guide'").first())
      .n,
    1,
    "queues no second usage-guide email"
  );
  eq(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM loyalty_ledger WHERE email = ?")
        .bind("hooked@example.com")
        .first()
    ).n,
    2,
    "and pays out no second reward -- the debit refId is keyed on the order"
  );

  // --- expired sessions --------------------------------------------------
  const expiredWithConsent = {
    id: "evt_expired_1",
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_test_expired",
        customer_details: { email: "left@example.com" },
        consent: { promotions: "opt_in" },
        after_expiration: { recovery: { url: "https://checkout.stripe.com/c/pay/recover_1" } },
        metadata: {}
      }
    }
  };
  await withMocks(async () => {
    const res = await worker.fetch(webhookRequest(expiredWithConsent), env, noCtx);
    eq(res.status, 200, "an expired session is accepted");
  });
  const recovery = await state.getQueuedEmail(db, "recovery:cs_test_expired");
  assert(recovery !== null, "a recovery email is queued");
  assert(
    JSON.parse(recovery.payload).recoveryUrl.includes("recover_1"),
    "carrying Stripe's own recovery URL"
  );

  const expiredNoConsent = {
    id: "evt_expired_2",
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_test_noconsent",
        customer_details: { email: "shy@example.com" },
        consent: { promotions: "opt_out" },
        after_expiration: { recovery: { url: "https://checkout.stripe.com/c/pay/recover_2" } },
        metadata: {}
      }
    }
  };
  await withMocks(async () => {
    await worker.fetch(webhookRequest(expiredNoConsent), env, noCtx);
  });
  eq(
    await state.getQueuedEmail(db, "recovery:cs_test_noconsent"),
    null,
    "NO CONSENT, NO RECOVERY EMAIL -- abandoning a cart is not permission to market"
  );

  const expiredNoEmail = {
    id: "evt_expired_3",
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_test_noemail",
        consent: { promotions: "opt_in" },
        after_expiration: { recovery: { url: "https://checkout.stripe.com/c/pay/recover_3" } },
        metadata: {}
      }
    }
  };
  await withMocks(async () => {
    await worker.fetch(webhookRequest(expiredNoEmail), env, noCtx);
  });
  eq(
    await state.getQueuedEmail(db, "recovery:cs_test_noemail"),
    null,
    "and a session with no address queues nothing either"
  );
}

/* ==========================================================================
   10. The cron handler
   ========================================================================== */

async function testCron() {
  console.log("\n10. The scheduled (cron) handler");
  const worker = (await import("../workers/checkout.js")).default;
  const mod = await import("../workers/routes/retention-emails.js");
  const state = await import("../workers/state/retention.js");
  const env = await makeEnv();
  const now = Date.now();

  await mod.scheduleOrderSequence(
    env.STATE_DB,
    {
      order_id: "cs_cron_1",
      email: "cron@example.com",
      placed_at: now - 40 * 86400000,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now - 40 * 86400000
  );
  eq(
    (await state.dueEmails(env.STATE_DB, now)).length,
    2,
    "two sends are overdue before the cron runs"
  );

  const pending = [];
  await withMocks(async (calls) => {
    await worker.scheduled({ scheduledTime: now }, env, { waitUntil: (p) => pending.push(p) });
    assert(pending.length === 1, "the cron handler hands its work to waitUntil");
    await Promise.all(pending);
    assert(calls.resend.length >= 2, "the cron drained the queue and actually sent the mail");
  });
  eq((await state.dueEmails(env.STATE_DB, now)).length, 0, "and nothing is left due afterwards");

  // A cron run without STATE_DB must not throw.
  let threw = false;
  try {
    await worker.scheduled({ scheduledTime: now }, { ...env, STATE_DB: undefined }, noCtx);
  } catch {
    threw = true;
  }
  eq(threw, false, "a cron tick with no database is a no-op, not a crash");
}

/* ==========================================================================
   11. Config and documentation parity
   ========================================================================== */

function testConfig() {
  console.log("\n11. wrangler.toml, schema.sql and the docs");
  const toml = fs.readFileSync(path.join(ROOT, "workers", "wrangler.toml"), "utf8");
  assert(/^\[triggers\]$/m.test(toml), "wrangler.toml declares a [triggers] section");
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml);
  assert(crons !== null, "with a crons list");
  assert(
    crons !== null && /"[^"]+"/.test(crons[1]),
    "that names at least one real cron expression"
  );
  assert(/LOYALTY_REDEEM_THRESHOLD/.test(toml), "wrangler.toml documents LOYALTY_REDEEM_THRESHOLD");
  assert(/LOYALTY_REWARD_CENTS/.test(toml), "wrangler.toml documents LOYALTY_REWARD_CENTS");
  assert(/STRIPE_WELCOME_COUPON_ID/.test(toml), "wrangler.toml documents STRIPE_WELCOME_COUPON_ID");
  assert(
    /STRIPE_BIRTHDAY_COUPON_ID/.test(toml),
    "wrangler.toml documents STRIPE_BIRTHDAY_COUPON_ID"
  );
  assert(/MAGIC_LINK_SECRET/.test(toml), "wrangler.toml names MAGIC_LINK_SECRET as a SECRET");
  assert(
    !/MAGIC_LINK_SECRET\s*=/.test(toml),
    "and never assigns it a value -- a secret in this file would be committed"
  );
  assert(
    !/(sk_live|sk_test|re_[A-Za-z0-9]{10}|whsec_)/.test(toml),
    "no secret value of any kind is present in wrangler.toml"
  );

  const schema = fs.readFileSync(path.join(ROOT, "workers", "schema.sql"), "utf8");
  for (const table of [
    "order_signals",
    "email_queue",
    "email_suppression",
    "email_contacts",
    "birthday_club",
    "welcome_codes"
  ]) {
    assert(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(schema),
      `schema.sql documents the ${table} table`
    );
  }
  assert(
    !/birth_year|\byear\s+INTEGER/.test(schema),
    "no table has a birth-year column -- the club stores MM-DD and nothing else"
  );

  const readme = fs.readFileSync(path.join(ROOT, "workers", "README.md"), "utf8");
  for (const route of [
    "/api/unsubscribe",
    "/api/welcome-code",
    "/api/birthday-club",
    "/api/loyalty-balance"
  ]) {
    assert(readme.includes(route), `workers/README.md documents ${route}`);
  }
  for (const name of [
    "STRIPE_WELCOME_COUPON_ID",
    "STRIPE_BIRTHDAY_COUPON_ID",
    "LOYALTY_REDEEM_THRESHOLD",
    "MAGIC_LINK_SECRET"
  ]) {
    assert(readme.includes(name), `workers/README.md documents ${name}`);
  }

  const stateDoc = fs.readFileSync(path.join(ROOT, "docs", "STATE-LAYER.md"), "utf8");
  assert(stateDoc.includes("email_queue"), "docs/STATE-LAYER.md documents the email queue");
  assert(stateDoc.includes("order_signals"), "docs/STATE-LAYER.md documents the order signals");
}

/* ==========================================================================
   12. The front-end this Worker answers
   ========================================================================== */

function testFrontEnd() {
  console.log("\n12. thank-you.js, thank-you.html and welcome.html");
  const thankYouJs = fs.readFileSync(path.join(ROOT, "assets", "js", "thank-you.js"), "utf8");

  // Purchase is still fired -- it is the last step of the conversion funnel --
  // but it carries NOTHING. The money is booked once, server-side, by the
  // Stripe webhook ("Order Paid", workers/routes/stripe-webhook.js) off the
  // amount Stripe actually captured. Sending revenue from here as well would
  // double-count every order whose shopper returns to this page, and would
  // miss every order whose shopper does not.
  assert(
    /window\.plausible\("Purchase"\)/.test(thankYouJs),
    "thank-you.js still fires the Purchase event"
  );
  assert(
    !/window\.plausible\("Purchase",/.test(thankYouJs),
    "and it passes no properties -- booking revenue is the webhook's job now"
  );
  assert(
    !/[{,]\s*(revenue|currency)\s*:/.test(thankYouJs),
    "no revenue or currency property is built anywhere in thank-you.js"
  );
  assert(
    thankYouJs.includes("claimSession(sessionId)"),
    "the once-per-order session dedupe survived the edit"
  );

  const thankYouHtml = fs.readFileSync(path.join(ROOT, "thank-you.html"), "utf8");
  const bdayForm = /<form[^>]*id="birthdayClubForm"[\s\S]*?<\/form>/.exec(thankYouHtml);
  assert(bdayForm !== null, "the Birthday Club form is still on thank-you.html");
  const formHtml = bdayForm ? bdayForm[0] : "";
  assert(/action="\/api\/birthday-club"/.test(formHtml), "and it posts to the Worker, not to Kit");
  assert(!/app\.kit\.com/.test(formHtml), "no Kit endpoint is left on the birthday form");
  assert(!/name="[^"]*year[^"]*"/i.test(formHtml), "the form has no year field -- MM/DD only");
  assert(/name="website_hp"/.test(formHtml), "it carries the same honeypot the restock form uses");
  // The FOOTER Kit form is not ours and must be untouched.
  assert(
    /class="footer-signup-form"[^>]*action="https:\/\/app\.kit\.com/.test(thankYouHtml),
    "the footer newsletter form still posts to Kit, unchanged"
  );

  const welcomeHtml = fs.readFileSync(path.join(ROOT, "welcome.html"), "utf8");
  assert(
    welcomeHtml.includes('src="assets/js/welcome.js'),
    "welcome.html loads assets/js/welcome.js"
  );
  assert(
    welcomeHtml.indexOf("assets/js/welcome.js") < welcomeHtml.indexOf("assets/js/main.js"),
    "BEFORE main.js -- deferred scripts run in document order, and welcome.js has to claim the card first"
  );
  assert(
    welcomeHtml.includes('id="welcomeCodeForm"'),
    "and carries the email form for the fallback path"
  );

  const welcomeJs = fs.readFileSync(path.join(ROOT, "assets", "js", "welcome.js"), "utf8");
  assert(welcomeJs.includes("/api/welcome-code"), "welcome.js asks the Worker for a code");
  assert(
    welcomeJs.includes('codeEl.removeAttribute("id")'),
    "and claims #welcomeCode so main.js cannot write the shared CMS code into it"
  );
  assert(
    welcomeJs.includes("site.welcomeCode"),
    "the CMS code survives as the fallback for the unconfigured case"
  );
  assert(
    welcomeJs.includes("configured === false"),
    "which is reached only when the route reports itself unconfigured"
  );
}

/* ==========================================================================
   13. The ship notice, and the dispatch anchor it corrects
   ========================================================================== */

async function testShipNotice() {
  console.log("\n13. The ship notice (payment_intent.updated)");
  const worker = (await import("../workers/checkout.js")).default;
  const mod = await import("../workers/routes/ship-notice.js");
  const retention = await import("../workers/routes/retention-emails.js");
  const orderEmails = await import("../workers/state/order-emails.js");

  /* --- the status vocabulary, against the page that shares it ------------ */
  const mainJs = fs.readFileSync(path.join(ROOT, "assets", "js", "main.js"), "utf8");
  const plainWords = mainJs.slice(
    mainJs.indexOf("function orderStatusPlainWords"),
    mainJs.indexOf("function formatOrderAmount")
  );
  assert(plainWords.length > 100, "orderStatusPlainWords was actually found in main.js");
  for (const status of mod.SHIPPED_STATUSES) {
    assert(
      plainWords.includes(`"${status}"`),
      `order-status.html calls "${status}" shipped too -- the page and the email agree`
    );
  }
  assert(mod.isShippedStatus("  SHIPPED "), "the status match is trimmed and case-insensitive");
  assert(!mod.isShippedStatus("packing"), "a status that is not one of them does not send");
  assert(!mod.isShippedStatus(""), "and neither does an empty one");

  /* --- the template ------------------------------------------------------ */
  const withTracking = mod.shipNoticeEmail("cs_abc123", "https://tools.usps.com/go/x", SITE);
  assert(withTracking.html.includes("tools.usps.com/go/x"), "the tracking link is in the HTML");
  assert(withTracking.text.includes("tools.usps.com/go/x"), "and in the plain-text part");
  assert(withTracking.html.includes("cs_abc123"), "the reference is shown so support can use it");
  assert(
    withTracking.html.includes("order-status.html?session_id=cs_abc123"),
    "the status link prefills the lookup with that reference"
  );
  assert(
    !/unsubscribe/i.test(withTracking.html) && !/unsubscribe/i.test(withTracking.text),
    "it is transactional: no unsubscribe line anywhere in it"
  );
  const noTracking = mod.shipNoticeEmail("cs_abc123", null, SITE);
  assert(
    /no tracking link/i.test(noTracking.text),
    "with no tracking number it says so rather than printing a dead button"
  );
  assert(!noTracking.html.includes("Track this shipment"), "and shows no button");

  /* --- the wiring, through the real webhook entrypoint -------------------- */
  const shipped = (id, metadata, intentId = "pi_test_ship") => ({
    id,
    type: "payment_intent.updated",
    data: { object: { id: intentId, metadata } }
  });

  const env = await makeEnv();
  const db = env.STATE_DB;
  const placedAt = Date.now() - 5 * 86400000;
  await (
    await import("../workers/state/retention.js")
  ).recordOrder(
    db,
    {
      orderId: "cs_test_shipped",
      email: "parcel@example.com",
      productIds: "sleep-salve",
      categories: "salves"
    },
    placedAt
  );
  await retention.scheduleOrderSequence(
    db,
    {
      order_id: "cs_test_shipped",
      email: "parcel@example.com",
      placed_at: placedAt,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    placedAt
  );
  const before = await db
    .prepare("SELECT id, send_after FROM email_queue WHERE id LIKE '%:cs_test_shipped' ORDER BY id")
    .all();
  eq(before.results.length, 2, "the order starts with both post-purchase rows queued");

  await withMocks(async (calls) => {
    const res = await worker.fetch(
      webhookRequest(
        shipped("evt_ship_1", {
          fulfillment_status: "shipped",
          tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400"
        })
      ),
      env,
      noCtx
    );
    eq(res.status, 200, "the webhook accepts payment_intent.updated");
    eq(calls.resend.length, 1, "exactly one email went out");
    eq(calls.resend[0].message.to, "Parcel@Example.com", "addressed to the buyer");
    assert(
      calls.resend[0].message.subject.length > 0 &&
        calls.resend[0].message.html.includes("tools.usps.com"),
      "carrying the tracking link the shop pasted into Stripe"
    );
    eq(
      calls.resend[0].headers["Idempotency-Key"],
      "ship-notice-pi_test_ship",
      "under a per-order idempotency key, so two deliveries at once cannot double-send"
    );
  });

  assert(
    await orderEmails.orderEmailSent(db, orderEmails.SHIP_NOTICE, "pi_test_ship"),
    "the send is recorded against the PaymentIntent"
  );

  /* --- the sweep: the trigger that actually exists ------------------------
     Stripe fires no event for a metadata edit, so the hourly cron lists recent
     PaymentIntents and sends for the ones marked shipped. pi_test_ship was
     just recorded above, so it must be skipped; pi_sweep_new must be sent;
     the unshipped one must not cost a call. */
  await withMocks(
    async (calls) => {
      const outcome = await mod.runShipNoticeSweep(env, noCtx);
      eq(outcome.scanned, 3, "every PaymentIntent in the window is looked at");
      eq(outcome.shipped, 2, "two of them are marked shipped");
      eq(outcome.sent, 1, "one had not been told yet");
      eq(outcome.skipped, 1, "the one already told is left alone");
      eq(calls.resend.length, 1, "exactly one email went out");
      eq(
        calls.resend[0].headers["Idempotency-Key"],
        "ship-notice-pi_sweep_new",
        "under the same per-order key the webhook path uses"
      );
      const again = await mod.runShipNoticeSweep(env, noCtx);
      eq(again.sent, 0, "a second tick sends nothing -- the send was recorded");
      eq(calls.resend.length, 1, "no second email");
    },
    {
      intents: {
        has_more: false,
        data: [
          { id: "pi_sweep_new", metadata: { fulfillment_status: "shipped" } },
          { id: "pi_test_ship", metadata: { fulfillment_status: "shipped" } },
          { id: "pi_sweep_pending", metadata: {} }
        ]
      }
    }
  );

  /* The whole point of the anchor fix: the sequence now counts from dispatch. */
  const after = await db
    .prepare("SELECT id, send_after FROM email_queue WHERE id LIKE '%:cs_test_shipped' ORDER BY id")
    .all();
  const dueById = Object.fromEntries(after.results.map((r) => [r.id, r.send_after]));
  const beforeById = Object.fromEntries(before.results.map((r) => [r.id, r.send_after]));
  assert(
    dueById["usage-guide:cs_test_shipped"] > beforeById["usage-guide:cs_test_shipped"],
    "an order that sat five days before shipping has its how-to-use email pushed back"
  );
  assert(
    dueById["review-request:cs_test_shipped"] > beforeById["review-request:cs_test_shipped"],
    "and its review request with it"
  );
  assert(
    dueById["usage-guide:cs_test_shipped"] - Date.now() >=
      retention.USAGE_GUIDE_AFTER_DISPATCH_MS - 60000,
    "both are now measured from the moment the parcel actually left"
  );

  /* --- pasting the tracking link later must not write again -------------- */
  await withMocks(async (calls) => {
    const res = await worker.fetch(
      webhookRequest(
        shipped("evt_ship_2", {
          fulfillment_status: "shipped",
          tracking_url: "https://tools.usps.com/go/CORRECTED"
        })
      ),
      env,
      noCtx
    );
    eq(res.status, 200, "a second edit of the same order's metadata is accepted");
    eq(calls.resend.length, 0, "but sends nothing -- one parcel, one notice");
    eq(calls.sessionLookups.length, 0, "and does not even ask Stripe who the order belongs to");
  });

  /* --- every other reason a PaymentIntent changes ------------------------- */
  await withMocks(async (calls) => {
    const res = await worker.fetch(
      webhookRequest(shipped("evt_ship_3", { fulfillment_status: "packing" }, "pi_test_other")),
      env,
      noCtx
    );
    eq(res.status, 200, "an unrelated PaymentIntent update is accepted");
    eq(calls.resend.length, 0, "and sends nothing");
    eq(calls.sessionLookups.length, 0, "without costing a Stripe call");
  });

  /* --- a hostile tracking_url -------------------------------------------- */
  await withMocks(async (calls) => {
    await worker.fetch(
      webhookRequest(
        shipped(
          "evt_ship_4",
          // eslint-disable-next-line no-script-url
          { fulfillment_status: "shipped", tracking_url: "javascript:alert(1)" },
          "pi_test_xss"
        )
      ),
      env,
      noCtx
    );
    eq(calls.resend.length, 1, "the notice still goes out");
    assert(
      !calls.resend[0].message.html.includes("javascript:"),
      "but a javascript: tracking_url is dropped, not linked"
    );
    assert(
      /no tracking link/i.test(calls.resend[0].message.text),
      "and it falls back to the honest 'no tracking yet' copy"
    );
  });

  /* --- a refused send has to be retried, not swallowed -------------------- */
  const retryEnv = await makeEnv();
  await withMocks(
    async (calls) => {
      const res = await worker.fetch(
        webhookRequest(shipped("evt_ship_5", { fulfillment_status: "shipped" }, "pi_test_refused")),
        retryEnv,
        noCtx
      );
      eq(calls.resend.length, 1, "the send was attempted");
      eq(res.status, 500, "a refusal answers non-2xx so Stripe redelivers");
    },
    { resendFails: true }
  );
  assert(
    !(await orderEmails.orderEmailSent(
      retryEnv.STATE_DB,
      orderEmails.SHIP_NOTICE,
      "pi_test_refused"
    )),
    "and nothing is recorded, so the retry is free to send properly"
  );
}

/* ==========================================================================
   14. Savanna's switches for the how-to-use email
   ========================================================================== */

async function testUsageGuideControls() {
  console.log("\n14. The how-to-use email's CMS switch and timing");
  const mod = await import("../workers/routes/retention-emails.js");

  eq(mod.usageGuideEnabled({}), true, "absent means on, like every other enable* switch");
  eq(mod.usageGuideEnabled({ enableUsageGuideEmails: true }), true, "true is on");
  eq(mod.usageGuideEnabled({ enableUsageGuideEmails: false }), false, "false is off");

  eq(
    mod.usageGuideDelayMs({}),
    mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "an unset delay falls back to the default"
  );
  eq(mod.usageGuideDelayMs({ usageGuideDelayDays: 7 }), 7 * 86400000, "a set delay is honoured");
  eq(mod.usageGuideDelayMs({ usageGuideDelayDays: 0 }), 0, "zero means 'on dispatch', not 'unset'");
  eq(
    mod.usageGuideDelayMs({ usageGuideDelayDays: "" }),
    mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "a blank field falls back rather than sending the moment it ships"
  );
  eq(
    mod.usageGuideDelayMs({ usageGuideDelayDays: -3 }),
    mod.USAGE_GUIDE_AFTER_DISPATCH_MS,
    "and so does a negative one"
  );
  eq(
    mod.usageGuideDelayMs({ usageGuideDelayDays: 9000 }),
    mod.USAGE_GUIDE_DELAY_MAX_DAYS * 86400000,
    "an absurd value is clamped instead of parking the email past the sweeper"
  );

  // The delay reaches the queue.
  const env = await makeEnv();
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  await mod.scheduleOrderSequence(
    env.STATE_DB,
    {
      order_id: "cs_test_delayed",
      email: "slow@example.com",
      placed_at: now,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now,
    { usageGuideDelayDays: 9 }
  );
  const row = await env.STATE_DB.prepare("SELECT send_after FROM email_queue WHERE id = ?")
    .bind("usage-guide:cs_test_delayed")
    .first();
  eq(
    row.send_after,
    now + mod.ASSUMED_DISPATCH_MS + 9 * 86400000,
    "the CMS number is what the queue row is scheduled on"
  );

  /* Off is read at SEND time. The row below was queued while the switch was on,
     and must still be skipped -- the same rule the suppression list follows. */
  const offEnv = await makeEnv();
  await mod.scheduleOrderSequence(
    offEnv.STATE_DB,
    {
      order_id: "cs_test_switched_off",
      email: "quiet@example.com",
      placed_at: now,
      product_ids: "sleep-salve",
      categories: "salves"
    },
    now
  );
  await withMocks(
    async (calls) => {
      const summary = await mod.drainEmailQueue(offEnv, noCtx, now + 400 * 86400000);
      eq(summary.sent, 1, "only the review request goes out");
      eq(summary.skipped, 1, "the how-to-use email is skipped");
      assert(
        calls.resend.every((c) => !/how to/i.test(c.message.subject)),
        "nothing that went out is the how-to-use email"
      );
    },
    { content: { site: { loyaltyPointsPerDollar: 2, enableUsageGuideEmails: false } } }
  );
  const skipped = await offEnv.STATE_DB.prepare("SELECT status FROM email_queue WHERE id = ?")
    .bind("usage-guide:cs_test_switched_off")
    .first();
  eq(
    skipped.status,
    "skipped",
    "and the row is terminal, not left pending to be retried every hour"
  );
}

/* ==========================================================================
   Runner
   ========================================================================== */

(async () => {
  await testRetentionState();
  await testCreatePromotionCode();
  await testTemplates();
  await testScheduleAndDrain();
  await testBirthdayJob();
  await testLoyalty();
  await testRoutes();
  await testCheckoutSessionParams();
  await testWebhookWiring();
  await testCron();
  await testShipNotice();
  await testUsageGuideControls();
  testConfig();
  testFrontEnd();

  const { resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();

  if (passed === 0) {
    console.error(
      "\nworker-retention.test.js: NO assertions ran -- that is a failure, not a pass."
    );
    process.exit(1);
  }
  console.log(`\nworker-retention.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-retention.test.js crashed:", err);
  process.exit(1);
});
