/**
 * @fileoverview Unit tests for the owner-alert channel:
 *   - workers/routes/alerts.js  (alertOwner, the six-hour dedupe on job_state,
 *                                recipient resolution, gift-card masking, the
 *                                plain-text body, degrade-on-failure)
 *   - the sites wired to it: the Stripe webhook's top-level catch, the sales-
 *     tax probe, a failing cron step, a retention email given up on, and the
 *     gift-card unwind (pinned at source -- driving a ledger race end to end
 *     belongs to worker-checkout.test.js).
 *
 * Same harness as scripts/worker-restock.test.js: no network, no wrangler. D1
 * is emulated on `node:sqlite` (scripts/lib/d1-emulator.js); Stripe, Resend
 * and the site's own JSON are mocked on global.fetch; the webhook is driven
 * through the REAL entrypoint (workers/checkout.js's default export) so the
 * router and the claim/release path are part of what is under test.
 *
 * Run: node scripts/worker-alerts.test.js
 */

const fs = require("fs");
const path = require("path");
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

/* ==========================================================================
   Fixtures and harness
   ========================================================================== */

const SITE = "https://yallternativeliving.com";
const WEBHOOK_SECRET = "whsec_alerts_suite";
const HOUR = 60 * 60 * 1000;

const mockCatalog = {
  products: [{ id: "sleep-salve", name: "Sleep Salve", category: "salves", price: 18 }],
  bundles: [],
  sales: [],
  shop: { freeShippingThreshold: 40 }
};

async function makeEnv(overrides = {}) {
  const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  const { resetAlertMemo } = await import("../workers/routes/alerts.js");
  resetSchemaMemo();
  resetAlertMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return {
    SITE_ORIGIN: SITE,
    STRIPE_SECRET_KEY: "sk_test_alerts",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: "re_test_alerts",
    MAGIC_LINK_SECRET: "alerts-suite-signing-secret",
    ORDER_NOTIFY_EMAIL: "orders@example.com",
    STATE_DB: db,
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

/**
 * Swap global.fetch for a recorder. `options.content` is what content.json
 * answers; `options.resend` is "ok" (default), "refuse" (HTTP 500) or "throw"
 * (a network error); `options.stripeCouponDelete` is "ok" or "refuse".
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [], stripe: [], content: 0 };
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = (opts && opts.body) || "";
    if (u.includes("products.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => mockCatalog };
    }
    if (u.includes("content.json")) {
      calls.content++;
      if (options.content === "down") throw new Error("ECONNRESET");
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => options.content || { site: {} }
      };
    }
    if (u.includes("events.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => ({ upcoming: [] }) };
    }
    if (u.includes("api.resend.com")) {
      if (options.resend === "throw") throw new Error("ENOTFOUND api.resend.com");
      calls.resend.push({ message: JSON.parse(body), headers: (opts && opts.headers) || {} });
      if (options.resend === "refuse") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
    }
    if (u.includes("api.stripe.com/v1/tax/settings")) {
      if (options.tax === "down") throw new Error("ECONNRESET");
      if (options.tax === "refuse") return { ok: false, status: 401 };
      return { ok: true, status: 200, json: async () => ({ status: "active" }) };
    }
    if (u.includes("api.stripe.com/v1/coupons/")) {
      calls.stripe.push(u);
      if (options.stripeCouponDelete === "refuse") return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    if (u.includes("api.stripe.com")) {
      calls.stripe.push(u);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

/** A ctx that remembers what was handed to waitUntil, so a test can await it. */
function collectingCtx() {
  const promises = [];
  return {
    promises,
    waitUntil(p) {
      promises.push(p);
    },
    async settle() {
      await Promise.all(promises);
    }
  };
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

const alertsOnly = (calls) =>
  calls.resend.filter((c) => String(c.message.subject).startsWith("[Shop alert]"));

/* ==========================================================================
   1. Masking
   ========================================================================== */
async function testMasking() {
  console.log("\n1. gift-card codes are masked wherever they appear");
  const { maskGiftCardCode, formatAlertBody } = await import("../workers/routes/alerts.js");

  eq(
    maskGiftCardCode("YALL-AB12-CD34-EF56"),
    "YALL-****-****-EF56",
    "grouped code keeps only its tail"
  );
  eq(maskGiftCardCode("YALL-AB12CD34EF56"), "YALL-****-****-EF56", "flat code, same tail");
  eq(maskGiftCardCode("YALL-PTS-Q7R8S9T0"), "YALL-PTS-****S9T0", "points code keeps its prefix");
  eq(
    maskGiftCardCode("card YALL-AB12-CD34-EF56 for cs_test_1"),
    "card YALL-****-****-EF56 for cs_test_1",
    "codes inside free text are masked, the rest is untouched"
  );
  eq(maskGiftCardCode("cs_test_1 pi_3ABC"), "cs_test_1 pi_3ABC", "ids are not codes");
  eq(maskGiftCardCode(null), "", "null is an empty string, not 'null'");

  const body = formatAlertBody({
    key: "gift-card-unwind:cs_test_9",
    subject: "unwind failed",
    details: { "gift card": "YALL-AB12-CD34-EF56", session: "cs_test_9" },
    now: Date.UTC(2026, 8, 9, 12, 0, 0)
  });
  assert(!body.includes("AB12-CD34"), "the body never carries a full code");
  assert(body.includes("YALL-****-****-EF56"), "but does carry the masked tail");
  assert(body.includes("cs_test_9"), "the session id is in the body");
  assert(body.includes("2026-09-09T12:00:00.000Z"), "the timestamp is ISO, UTC");
  assert(body.includes('"owner-alert gift-card-unwind:cs_test_9"'), "the log marker to search for");
  assert(body.includes("What failed: unwind failed"), "what failed, in plain words");
}

/* ==========================================================================
   2. Recipient resolution
   ========================================================================== */
async function testRecipient() {
  console.log("\n2. where the alert goes");
  const { alertRecipient, envAlertRecipient } = await import("../workers/routes/alerts.js");

  eq(
    envAlertRecipient({}),
    "contact@yallternativeliving.com",
    "the default is the contact address"
  );
  eq(
    envAlertRecipient({ RESTOCK_NOTIFY_EMAIL: "r@x.com" }),
    "r@x.com",
    "RESTOCK_NOTIFY_EMAIL next"
  );
  eq(
    envAlertRecipient({ RESTOCK_NOTIFY_EMAIL: "r@x.com", ORDER_NOTIFY_EMAIL: "o@x.com" }),
    "o@x.com",
    "ORDER_NOTIFY_EMAIL wins over it"
  );

  const env = await makeEnv();
  const fromCms = await withMocks(() => alertRecipient(env, null), {
    content: { site: { alertEmail: " savanna@example.com " } }
  });
  eq(fromCms, "savanna@example.com", "the CMS field wins, trimmed");

  const junk = await withMocks(() => alertRecipient(env, null), {
    content: { site: { alertEmail: "not an email" } }
  });
  eq(junk, "orders@example.com", "a CMS value that is not an email falls back to the env ladder");

  const blank = await withMocks(() => alertRecipient(env, null), {
    content: { site: { alertEmail: "" } }
  });
  eq(blank, "orders@example.com", "and so does a blank one");

  const down = await withMocks(() => alertRecipient(env, null), { content: "down" });
  eq(down, "orders@example.com", "an unreachable content.json falls back too -- no throw");
}

/* ==========================================================================
   3. Dedupe window
   ========================================================================== */
async function testDedupe() {
  console.log("\n3. one email per key per six hours");
  const alerts = await import("../workers/routes/alerts.js");
  const { claimAlertSlot, resetAlertMemo, ALERT_WINDOW_MS } = alerts;
  const env = await makeEnv();
  const db = env.STATE_DB;
  const t0 = Date.UTC(2026, 8, 9, 0, 0, 0);

  eq(ALERT_WINDOW_MS, 6 * HOUR, "the window is six hours");
  eq(await claimAlertSlot(db, "tax-probe", t0), true, "the first failure sends");
  eq(
    await claimAlertSlot(db, "tax-probe", t0 + 1000),
    false,
    "a second one a moment later does not"
  );
  eq(await claimAlertSlot(db, "tax-probe", t0 + 5 * HOUR), false, "nor one five hours later");
  eq(
    await claimAlertSlot(db, "cron:digest", t0 + 5 * HOUR),
    true,
    "a different key is its own window"
  );
  eq(await claimAlertSlot(db, "tax-probe", t0 + 6 * HOUR), true, "at six hours it sends again");
  eq(await claimAlertSlot(db, "tax-probe", t0 + 6 * HOUR + 1), false, "and the window restarts");

  const row = await db
    .prepare("SELECT value, updated_at FROM job_state WHERE job = ?")
    .bind("alert:tax-probe")
    .first();
  eq(row && row.updated_at, t0 + 6 * HOUR, "the claim lives on job_state as alert:<key>");

  // Two isolates -- two memos -- sharing one database: the row is what decides.
  resetAlertMemo();
  eq(
    await claimAlertSlot(db, "tax-probe", t0 + 7 * HOUR),
    false,
    "a fresh isolate reads the shared claim and stays quiet"
  );
  resetAlertMemo();
  eq(
    await claimAlertSlot(db, "tax-probe", t0 + 13 * HOUR),
    true,
    "and sends once the shared window has passed"
  );

  // No D1 at all: the memo alone caps a single isolate.
  resetAlertMemo();
  eq(await claimAlertSlot(null, "webhook:x", t0), true, "without D1 the first send goes");
  eq(await claimAlertSlot(null, "webhook:x", t0 + HOUR), false, "and the memo holds the window");
  eq(await claimAlertSlot(undefined, "webhook:x", t0 + 7 * HOUR), true, "until it passes");

  // A D1 that throws must not swallow the alert.
  resetAlertMemo();
  const brokenDb = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw new Error("D1 is down");
        }
      })
    })
  };
  eq(await claimAlertSlot(brokenDb, "cron:sweep", t0), true, "a broken dedupe store still sends");
  eq(await claimAlertSlot(brokenDb, "cron:sweep", t0 + HOUR), false, "and the memo still dedupes");
}

/* ==========================================================================
   4. alertOwner never throws, never blocks, degrades to the log
   ========================================================================== */
async function testDegrade() {
  console.log("\n4. alertOwner degrades instead of failing its caller");
  const { alertOwner } = await import("../workers/routes/alerts.js");
  const quiet = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    // Happy path, with a ctx: the promise is handed to waitUntil.
    const env = await makeEnv();
    const ctx = collectingCtx();
    const sent = await withMocks(async (calls) => {
      const result = alertOwner(env, ctx, {
        key: "tax-probe",
        subject: "Sales-tax check failed for YALL-AB12-CD34-EF56",
        details: { session: "cs_test_1" }
      });
      assert(typeof result.then === "function", "alertOwner returns a promise");
      eq(ctx.promises.length, 1, "and hands the same work to ctx.waitUntil");
      await ctx.settle();
      eq(calls.resend.length, 1, "one email went out");
      const msg = calls.resend[0].message;
      eq(msg.to, "orders@example.com", "to the env recipient when the CMS has none");
      assert(msg.subject.startsWith("[Shop alert] "), "subject is prefixed");
      assert(!msg.subject.includes("AB12-CD34"), "and masked");
      assert(typeof msg.text === "string" && msg.text.includes("cs_test_1"), "plain-text body");
      assert(!("html" in msg) || !msg.html, "no HTML body");
      return result;
    });
    eq(sent.sent, true, "the result says it sent");
    assert(
      logged.some((l) => l.includes("owner-alert tax-probe")),
      "the log carries the marker"
    );
    assert(!logged.some((l) => l.includes("AB12-CD34")), "and the log is masked too");

    // No RESEND_API_KEY: log only, no fetch at all.
    const noKey = await makeEnv({ RESEND_API_KEY: undefined });
    const r1 = await withMocks(async (calls) => {
      const out = await alertOwner(noKey, null, { key: "k1", subject: "x" });
      eq(calls.resend.length, 0, "no key -> no request");
      eq(calls.content, 0, "and content.json is not fetched either");
      return out;
    });
    eq(r1, { sent: false, reason: "no-resend" }, "no key -> logged only");

    // Resend refuses.
    const env2 = await makeEnv();
    const r2 = await withMocks(() => alertOwner(env2, null, { key: "k2", subject: "x" }), {
      resend: "refuse"
    });
    eq(r2, { sent: false, reason: "resend-500" }, "a refusal is reported, not thrown");

    // Resend is unreachable (fetch throws).
    const env3 = await makeEnv();
    const r3 = await withMocks(() => alertOwner(env3, null, { key: "k3", subject: "x" }), {
      resend: "throw"
    });
    eq(r3, { sent: false, reason: "threw" }, "a network error is caught");

    // D1 is missing entirely and ctx is null.
    const env4 = await makeEnv({ STATE_DB: undefined });
    const r4 = await withMocks(async (calls) => {
      const out = await alertOwner(env4, null, { key: "k4", subject: "x" });
      eq(calls.resend.length, 1, "no D1 -> still sends");
      return out;
    });
    eq(r4.sent, true, "and reports it");

    // Garbage input.
    const r5 = await withMocks(() => alertOwner(undefined, undefined, undefined));
    eq(r5.sent, false, "no env at all -> a settled promise, no throw");

    // Dedupe through the public entrypoint.
    const env5 = await makeEnv();
    await withMocks(async (calls) => {
      const now = Date.UTC(2026, 8, 9, 0, 0, 0);
      await alertOwner(env5, null, { key: "cron:x", subject: "one", now });
      const second = await alertOwner(env5, null, {
        key: "cron:x",
        subject: "two",
        now: now + HOUR
      });
      eq(calls.resend.length, 1, "the second alert within the window sends nothing");
      eq(second, { sent: false, reason: "deduped" }, "and says why");
    });
  } finally {
    console.error = quiet;
  }
}

/* ==========================================================================
   5. The wired sites
   ========================================================================== */
async function testWiredWebhook() {
  console.log("\n5a. a webhook handler that throws after the claim alerts the shop");
  const worker = (await import("../workers/checkout.js")).default;
  const quiet = console.error;
  console.error = () => {};
  try {
    const env = await makeEnv();
    const ctx = collectingCtx();
    await withMocks(
      async (calls) => {
        // An expired session whose ephemeral coupon Stripe refuses to delete:
        // handleSessionExpired throws, the top-level catch releases the claim.
        const res = await worker.fetch(
          webhookRequest({
            id: "evt_alert_1",
            type: "checkout.session.expired",
            data: {
              object: {
                id: "cs_test_expired_1",
                payment_intent: "pi_test_expired_1",
                metadata: { gift_card_ephemeral_coupon_id: "gc_coupon_1" }
              }
            }
          }),
          env,
          ctx
        );
        eq(res.status, 500, "the webhook still answers non-2xx so Stripe redelivers");
        await ctx.settle();
        const alerts = alertsOnly(calls);
        eq(alerts.length, 1, "exactly one alert email was attempted");
        const text = alerts[0].message.text;
        assert(
          /webhook "checkout\.session\.expired" failed/.test(alerts[0].message.subject),
          "subject names the event type"
        );
        assert(text.includes("evt_alert_1"), "body carries the event id");
        assert(text.includes("cs_test_expired_1"), "and the session id");
        assert(text.includes("pi_test_expired_1"), "and the payment intent");
        assert(text.includes("gc_coupon_1"), "and the error, which names the coupon");
        assert(text.includes("owner-alert webhook:checkout.session.expired"), "and the marker");

        const claim = await env.STATE_DB.prepare(
          "SELECT status FROM webhook_events WHERE event_id = ?"
        )
          .bind("evt_alert_1")
          .first();
        eq(claim, null, "the claim was released for the retry");

        // The retry within the window: same failure, no second email.
        const ctx2 = collectingCtx();
        await worker.fetch(
          webhookRequest({
            id: "evt_alert_1",
            type: "checkout.session.expired",
            data: {
              object: {
                id: "cs_test_expired_1",
                metadata: { gift_card_ephemeral_coupon_id: "gc_coupon_1" }
              }
            }
          }),
          env,
          ctx2
        );
        await ctx2.settle();
        eq(alertsOnly(calls).length, 1, "the redelivery a moment later is deduped");
      },
      { stripeCouponDelete: "refuse" }
    );

    // The alert must not be what makes the webhook fail: with Resend down the
    // answer is the same 500 the handler produced, not a crash.
    const env2 = await makeEnv();
    const ctx3 = collectingCtx();
    await withMocks(
      async () => {
        const res = await worker.fetch(
          webhookRequest({
            id: "evt_alert_2",
            type: "checkout.session.expired",
            data: {
              object: {
                id: "cs_test_expired_2",
                metadata: { gift_card_ephemeral_coupon_id: "gc_coupon_2" }
              }
            }
          }),
          env2,
          ctx3
        );
        eq(res.status, 500, "Resend being down changes nothing for Stripe");
        let settled = true;
        try {
          await ctx3.settle();
        } catch {
          settled = false;
        }
        assert(settled, "and the background work settles rather than rejecting");
      },
      { stripeCouponDelete: "refuse", resend: "throw" }
    );
  } finally {
    console.error = quiet;
  }
}

async function testWiredTaxProbe() {
  console.log("\n5b. the sales-tax probe failing open is no longer silent");
  const checkout = await import("../workers/checkout.js");
  const quiet = console.error;
  console.error = () => {};
  try {
    const env = await makeEnv();
    const ctx = collectingCtx();
    await withMocks(
      async (calls) => {
        const active = await checkout.isTaxEnabled(env, ctx);
        eq(active, false, "a refused probe still fails open (no tax)");
        await ctx.settle();
        const alerts = alertsOnly(calls);
        eq(alerts.length, 1, "and alerts once");
        assert(/tax/i.test(alerts[0].message.subject), "about tax");
        assert(alerts[0].message.text.includes("HTTP 401"), "with the cause");
        assert(alerts[0].message.text.includes("owner-alert tax-probe"), "and the marker");

        const ctx2 = collectingCtx();
        await checkout.isTaxEnabled(env, ctx2);
        await ctx2.settle();
        eq(alertsOnly(calls).length, 1, "the next checkout in the window does not alert again");
      },
      { tax: "refuse" }
    );

    const env2 = await makeEnv();
    const ctx3 = collectingCtx();
    await withMocks(
      async (calls) => {
        const active = await checkout.isTaxEnabled(env2, ctx3);
        eq(active, false, "a network error fails open too");
        await ctx3.settle();
        eq(alertsOnly(calls).length, 1, "and alerts");
        assert(alertsOnly(calls)[0].message.text.includes("ECONNRESET"), "with the error");
      },
      { tax: "down" }
    );

    const env3 = await makeEnv();
    const ctx4 = collectingCtx();
    await withMocks(async (calls) => {
      eq(await checkout.isTaxEnabled(env3, ctx4), true, "a good probe reports active");
      await ctx4.settle();
      eq(alertsOnly(calls).length, 0, "and sends no alert");
    });

    const env4 = await makeEnv({ STRIPE_TAX_ENABLED: "false" });
    await withMocks(
      async (calls) => {
        eq(
          await checkout.isTaxEnabled(env4, collectingCtx()),
          false,
          "the kill switch is honoured"
        );
        eq(calls.resend.length, 0, "and is not a failure");
      },
      { tax: "refuse" }
    );
  } finally {
    console.error = quiet;
  }
}

async function testWiredCron() {
  console.log("\n5c. a failing cron step alerts, and the other steps still run");
  const worker = (await import("../workers/checkout.js")).default;
  const quiet = console.error;
  console.error = () => {};
  try {
    const env = await makeEnv();
    const realDb = env.STATE_DB;
    // The first step's sweep throws; everything else -- including the alert's
    // own job_state upsert -- goes through untouched.
    env.STATE_DB = {
      prepare(sql) {
        if (/DELETE FROM webhook_events WHERE claimed_at/.test(sql)) {
          throw new Error("simulated D1 failure on the sweep");
        }
        return realDb.prepare(sql);
      },
      batch: realDb.batch ? (...args) => realDb.batch(...args) : undefined
    };
    const ctx = collectingCtx();
    await withMocks(async (calls) => {
      await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
      await ctx.settle();
      const alerts = alertsOnly(calls);
      eq(alerts.length, 1, "one alert for the one failed step");
      assert(alerts[0].message.subject.includes("webhook-events sweep"), "naming the step");
      assert(alerts[0].message.text.includes("simulated D1 failure"), "with the error");
      assert(
        alerts[0].message.text.includes("owner-alert cron:webhook-events-sweep"),
        "and the marker"
      );
    });
  } finally {
    console.error = quiet;
  }
}

async function testWiredRetention() {
  console.log("\n5d. a retention email given up on alerts once per kind");
  const mod = await import("../workers/routes/retention-emails.js");
  const state = await import("../workers/state/retention.js");
  const quiet = console.error;
  console.error = () => {};
  try {
    const env = await makeEnv();
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    await state.enqueueEmail(
      env.STATE_DB,
      {
        id: "recovery:cs_test_giveup",
        kind: "recovery",
        email: "giveup@example.com",
        payload: { recoveryUrl: "https://checkout.stripe.com/c/pay/cs_test_giveup" },
        sendAfter: now
      },
      now
    );
    const later = now + 60 * 24 * HOUR;
    const ctx = collectingCtx();
    await withMocks(
      async (calls) => {
        for (let attempt = 1; attempt <= state.MAX_SEND_ATTEMPTS; attempt++) {
          await mod.drainEmailQueue(env, ctx, later + attempt, 50);
        }
        await ctx.settle();
        const alerts = alertsOnly(calls);
        assert(alerts.length >= 1, "at least one alert once a row is exhausted");
        assert(
          alerts.every((a) => /given up/.test(a.message.subject)),
          "each says the email was given up on"
        );
        assert(
          alerts.some((a) => a.message.text.includes(`attempts: ${state.MAX_SEND_ATTEMPTS}`)),
          "with the attempt count"
        );
        const kinds = new Set(alerts.map((a) => a.message.subject));
        eq(kinds.size, alerts.length, "and never twice for the same kind in the window");
      },
      { resend: "refuse" }
    );
  } finally {
    console.error = quiet;
  }
}

async function testUnwindPinnedAtSource() {
  console.log("\n5e. the gift-card unwind is wired (pinned at source)");
  const src = fs.readFileSync(path.join(ROOT, "workers", "checkout.js"), "utf8");
  const start = src.indexOf("Gift card unwind incomplete for session");
  assert(start > 0, "the unwind's error log is still there");
  const block = src.slice(start, start + 1500);
  assert(/alertOwner\(env, ctx, \{/.test(block), "and it calls alertOwner");
  assert(/key: `gift-card-unwind:\$\{session\.id\}`/.test(block), "keyed on the session");
  assert(/coupon: couponId/.test(block), "with the coupon id");
  assert(/"gift card": appliedGiftCardCode/.test(block), "and the card (masked by alerts.js)");
  assert(/Expire/.test(block), "telling the shop what to do");
}

/* ==========================================================================
   6. The owner-facing field exists everywhere it has to
   ========================================================================== */
async function testOwnerField() {
  console.log("\n6. site.alertEmail is a CMS field, documented");
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
  assert(
    Object.prototype.hasOwnProperty.call(content.site, "alertEmail"),
    "content.json site.alertEmail exists (blank means the env ladder)"
  );
  const config = fs.readFileSync(path.join(ROOT, "admin/config.yml"), "utf8");
  const at = config.indexOf("name: alertEmail");
  assert(at > 0, "admin/config.yml declares the field");
  const decl = config.slice(at, at + 800);
  assert(/widget: string/.test(decl), "as a plain text field");
  assert(/hint:/.test(decl), "with a hint");
  assert(/label: "Emails to me/.test(decl), "in the 'Emails to me' group");
  const guide = fs.readFileSync(path.join(ROOT, "docs/EDITING-GUIDE.md"), "utf8");
  assert(/Where shop alerts go/.test(guide), "EDITING-GUIDE.md explains it");
}

/* ==========================================================================
   Run
   ========================================================================== */
(async () => {
  await testMasking();
  await testRecipient();
  await testDedupe();
  await testDegrade();
  await testWiredWebhook();
  await testWiredTaxProbe();
  await testWiredCron();
  await testWiredRetention();
  await testUnwindPinnedAtSource();
  await testOwnerField();
  console.log(`\nworker-alerts.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
