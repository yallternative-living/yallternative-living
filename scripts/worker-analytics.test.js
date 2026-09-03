/**
 * @fileoverview Server-side revenue reporting (workers/routes/analytics.js and
 * the reportRevenue step in workers/routes/stripe-webhook.js).
 * Run: node scripts/worker-analytics.test.js
 *
 * Node-only, no network: `fetch` is a stub and D1 is the SQLite emulator in
 * scripts/lib/d1-emulator.js.
 *
 * What is pinned here, and why each thing is pinned:
 *
 *  1. THE PAYLOAD IS EXACTLY revenue + currency. No email, no name, no Stripe
 *     session id. The session id is an order-lookup token; the client-side
 *     scrubber exists precisely to keep it out of a third-party dashboard, and
 *     the server must not be the hole in that.
 *
 *  2. THE USER-AGENT IS NOT A BOT. Umami runs every collection request through
 *     the npm `isbot` package and answers 200 with {"beep":"boop"} for anything
 *     it flags -- revenue would simply stop appearing, with no error anywhere.
 *     Umami's own docs example ("Mozilla/5.0 (Server)") is flagged, and so is
 *     almost any bare "Name/1.0" token. This suite re-runs the real package
 *     against the real string, so an isbot update that would switch revenue
 *     reporting off fails the build instead.
 *
 *  3. ANALYTICS CAN NEVER FAIL THE WEBHOOK. A timeout, a 500, a bot rejection
 *     or a thrown error must all leave the webhook's own result untouched --
 *     a non-2xx makes Stripe redeliver, which re-runs the money path.
 *
 *  4. ONCE PER ORDER. A redelivered Stripe event must not book the same money
 *     twice. Umami has no idempotency of its own, so the claim is the only
 *     thing standing between a retry and an overstated Revenue report.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { makeD1 } = require("./lib/d1-emulator.js");

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const failures = [];
async function it(desc, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (e) {
    failed++;
    failures.push(desc);
    console.log(`  ✗ ${desc}\n    ${e && e.message}`);
  }
}

const WEBSITE_ID = "a134e5d8-e8e5-4a8e-90e9-c21e9dba5acb";
const SESSION_ID = "cs_test_a1B2c3D4e5F6g7H8";

function paidSession(extra) {
  return Object.assign(
    {
      id: SESSION_ID,
      payment_status: "paid",
      status: "complete",
      amount_total: 4250,
      amount_subtotal: 4000,
      currency: "usd",
      customer_details: { name: "Savanna Buyer", email: "buyer@example.com" },
      metadata: {}
    },
    extra || {}
  );
}

/** A D1 with the real schema applied, so the claim table is the shipped one. */
async function freshDb(migrations) {
  const db = makeD1(new DatabaseSync(":memory:"));
  await migrations.applyMigrations(db);
  return db;
}

/** Collects every fetch the code under test makes. */
function fetchSpy(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return (
      response || {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ cache: "token" })
      }
    );
  };
  impl.calls = calls;
  return impl;
}

/** A ctx whose waitUntil work can be awaited, the way the runtime awaits it. */
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    settle: () => Promise.all(pending)
  };
}

(async () => {
  const analytics = await import("../workers/routes/analytics.js");
  const migrations = await import("../workers/state/migrations.js");
  const sends = await import("../workers/state/analytics-sends.js");
  const webhook = await import("../workers/routes/stripe-webhook.js");

  /* ==================================================================== 1 */
  console.log("\n1. the payload");

  await it("is exactly revenue + currency, and nothing else", () => {
    const body = analytics.buildOrderPaidPayload(paidSession(), WEBSITE_ID);
    assert.deepStrictEqual(body, {
      type: "event",
      payload: {
        website: WEBSITE_ID,
        hostname: "yallternativeliving.com",
        url: "/thank-you.html",
        name: "Order Paid",
        data: { revenue: 42.5, currency: "USD" }
      }
    });
  });

  await it("carries no email, no name and no Stripe session id", () => {
    const body = analytics.buildOrderPaidPayload(paidSession(), WEBSITE_ID);
    const json = JSON.stringify(body);
    for (const forbidden of ["buyer@example.com", "Savanna", SESSION_ID, "cs_test", "cs_live"]) {
      assert.ok(!json.includes(forbidden), `payload leaked ${forbidden}`);
    }
  });

  await it("is named 'Order Paid', not 'Purchase' -- Purchase is the client funnel step", () => {
    assert.strictEqual(analytics.ORDER_PAID_EVENT, "Order Paid");
    const thankYouJs = fs.readFileSync(path.join(ROOT, "assets/js/thank-you.js"), "utf8");
    assert.ok(
      thankYouJs.includes('window.plausible("Purchase")'),
      "thank-you.js still fires Purchase as the funnel step"
    );
    /* The browser must never SEND it. The file is allowed to mention the name
       in the comment that explains the split -- that comment is the reason the
       next person does not re-add revenue here. */
    assert.ok(
      !/plausible\(\s*["']Order Paid/.test(thankYouJs),
      "and the browser never sends Order Paid -- that name is the server's"
    );
  });

  await it("converts Stripe's minor units to major units", () => {
    assert.strictEqual(analytics.revenueFromSession({ amount_total: 4250 }), 42.5);
    assert.strictEqual(analytics.revenueFromSession({ amount_total: 1 }), 0.01);
    assert.strictEqual(analytics.revenueFromSession({ amount_total: 100000 }), 1000);
  });

  await it("refuses an amount that is missing, zero, negative or not a number", () => {
    for (const amount_total of [undefined, null, 0, -1, "lots", NaN, Infinity]) {
      assert.strictEqual(
        analytics.revenueFromSession({ amount_total }),
        null,
        String(amount_total)
      );
    }
  });

  await it("upper-cases the currency and refuses anything that is not three letters", () => {
    assert.strictEqual(analytics.currencyFromSession({ currency: "usd" }), "USD");
    assert.strictEqual(analytics.currencyFromSession({ currency: "eur" }), "EUR");
    for (const currency of ["", "dollars", "us", "u5d", undefined, 12]) {
      assert.strictEqual(analytics.currencyFromSession({ currency }), null, String(currency));
    }
  });

  await it("builds nothing at all when the amount or the website id is unusable", () => {
    assert.strictEqual(analytics.buildOrderPaidPayload(paidSession(), ""), null);
    assert.strictEqual(
      analytics.buildOrderPaidPayload({ amount_total: 0, currency: "usd" }, WEBSITE_ID),
      null
    );
    assert.strictEqual(analytics.buildOrderPaidPayload({ amount_total: 500 }, WEBSITE_ID), null);
  });

  /* ==================================================================== 2 */
  console.log("\n2. the User-Agent Umami's bot filter has to let through");

  await it("is sent on the request, because Umami rejects a request without one", async () => {
    const spy = fetchSpy();
    await analytics.sendToUmami({ type: "event", payload: {} }, { fetch: spy });
    assert.strictEqual(spy.calls.length, 1);
    assert.strictEqual(spy.calls[0].url, "https://gateway.umami.is/api/send");
    assert.strictEqual(spy.calls[0].init.headers["User-Agent"], analytics.ORDER_PAID_USER_AGENT);
    assert.strictEqual(spy.calls[0].init.headers["Content-Type"], "application/json");
  });

  await it("is NOT classified as a bot by the real isbot package", () => {
    /* The gate this whole file exists for. Umami answers 200 with
       {"beep":"boop"} and records nothing when isbot flags the User-Agent, so
       revenue would silently stop. isbot is a devDependency for exactly this
       assertion -- it is the same package Umami runs
       (umami-software/umami src/app/api/send/route.ts). */
    const { isbot } = require("isbot");
    assert.ok(
      !isbot(analytics.ORDER_PAID_USER_AGENT),
      `isbot classifies "${analytics.ORDER_PAID_USER_AGENT}" as a bot -- Umami would drop every ` +
        `revenue event and say nothing. Pick another string and re-test it here.`
    );
  });

  await it("...and the strings that DO get flagged are flagged, so the check is real", () => {
    const { isbot } = require("isbot");
    /* Umami's own documented example is one of them. If this ever stops being
       true, isbot's behaviour changed and the assertion above needs re-reading
       rather than trusting. */
    assert.ok(isbot("Mozilla/5.0 (Server)"), "Umami's docs example is bot-flagged");
    assert.ok(isbot("YallternativeLiving/1.0"), "a bare Name/version token is bot-flagged");
    assert.ok(isbot("curl/8.0"), "curl is bot-flagged");
  });

  await it("reports a bot rejection instead of calling it a success", async () => {
    const spy = fetchSpy({ ok: true, status: 200, text: async () => '{"beep":"boop"}' });
    const outcome = await analytics.sendToUmami({}, { fetch: spy });
    assert.deepStrictEqual(outcome, { sent: false, reason: "bot-filtered" });
  });

  await it("treats a real 200 as sent", async () => {
    const outcome = await analytics.sendToUmami({}, { fetch: fetchSpy() });
    assert.deepStrictEqual(outcome, { sent: true });
  });

  await it("reports an HTTP failure, a network error and a timeout distinctly", async () => {
    const bad = await analytics.sendToUmami({}, { fetch: fetchSpy({ ok: false, status: 503 }) });
    assert.deepStrictEqual(bad, { sent: false, reason: "http-503" });

    const boom = await analytics.sendToUmami(
      {},
      {
        fetch: async () => {
          throw new Error("dns");
        }
      }
    );
    assert.deepStrictEqual(boom, { sent: false, reason: "network" });

    const slow = await analytics.sendToUmami(
      {},
      {
        timeoutMs: 5,
        fetch: (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      }
    );
    assert.deepStrictEqual(slow, { sent: false, reason: "timeout" });
  });

  /* ==================================================================== 3 */
  console.log("\n3. the once-per-order claim");

  await it("claims a session id once and refuses every repeat", async () => {
    const db = await freshDb(migrations);
    assert.strictEqual(await sends.claimAnalyticsSend(db, sends.ORDER_PAID, SESSION_ID), true);
    assert.strictEqual(await sends.claimAnalyticsSend(db, sends.ORDER_PAID, SESSION_ID), false);
    assert.strictEqual(await sends.claimAnalyticsSend(db, sends.ORDER_PAID, SESSION_ID), false);
  });

  await it("keys on kind AND id, so two kinds of send about one order do not collide", async () => {
    const db = await freshDb(migrations);
    assert.strictEqual(await sends.claimAnalyticsSend(db, sends.ORDER_PAID, SESSION_ID), true);
    assert.strictEqual(await sends.claimAnalyticsSend(db, "order-refund", SESSION_ID), true);
  });

  await it("refuses a malformed kind or id rather than writing a junk key", async () => {
    const db = await freshDb(migrations);
    await assert.rejects(() => sends.claimAnalyticsSend(db, "ORDER PAID", SESSION_ID), TypeError);
    await assert.rejects(() => sends.claimAnalyticsSend(db, sends.ORDER_PAID, "a"), TypeError);
    await assert.rejects(() => sends.claimAnalyticsSend(db, sends.ORDER_PAID, null), TypeError);
  });

  await it("sweeps rows older than the retention window and keeps newer ones", async () => {
    const db = await freshDb(migrations);
    const now = Date.UTC(2026, 8, 2);
    const old = now - 120 * 24 * 60 * 60 * 1000;
    await sends.claimAnalyticsSend(db, sends.ORDER_PAID, "cs_test_old", old);
    await sends.claimAnalyticsSend(db, sends.ORDER_PAID, "cs_test_new", now);
    assert.strictEqual(await sends.sweepAnalyticsSends(db, 90, now), 1);
    assert.strictEqual(await sends.getAnalyticsSend(db, sends.ORDER_PAID, "cs_test_old"), null);
    assert.ok(await sends.getAnalyticsSend(db, sends.ORDER_PAID, "cs_test_new"));
  });

  await it("the schema the Worker applies actually contains the claim table", async () => {
    assert.ok(
      migrations.SCHEMA_STATEMENTS.some((s) =>
        /CREATE TABLE IF NOT EXISTS analytics_sends/.test(s)
      ),
      "migrations.js declares analytics_sends"
    );
    const sql = fs.readFileSync(path.join(ROOT, "workers/schema.sql"), "utf8");
    assert.ok(
      /CREATE TABLE IF NOT EXISTS analytics_sends/.test(sql),
      "workers/schema.sql declares it too"
    );
    assert.ok(migrations.SCHEMA_VERSION >= 5, "SCHEMA_VERSION was bumped for the new table");
  });

  /* ==================================================================== 4 */
  console.log("\n4. the webhook step");

  const baseEnv = (db) => ({
    STATE_DB: db,
    UMAMI_WEBSITE_ID: WEBSITE_ID,
    GIFT_CARD_LEDGER: {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
  });

  /* processStripeEvent runs every fulfilment step too, and those need Stripe
     and Resend stubs that are not this file's subject. Drive reportRevenue
     through the webhook's real export by calling processStripeEvent with a
     session that asks nothing of the other steps: no gift cards, no gift note,
     no size confirmation, no buyer email for retention. */
  const bareSession = (extra) =>
    Object.assign(paidSession(), { customer_details: {}, metadata: {} }, extra || {});

  await it("books the order's revenue exactly once, even when Stripe redelivers", async () => {
    const db = await freshDb(migrations);
    const env = baseEnv(db);
    const spy = fetchSpy();
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      const ctx1 = makeCtx();
      const first = await webhook.processStripeEvent(
        { id: "evt_1", type: "checkout.session.completed", data: { object: bareSession() } },
        env,
        ctx1
      );
      await ctx1.settle();
      assert.strictEqual(first.revenue.sent, true);
      assert.strictEqual(first.revenue.revenue, 42.5);

      const ctx2 = makeCtx();
      const second = await webhook.processStripeEvent(
        { id: "evt_1", type: "checkout.session.completed", data: { object: bareSession() } },
        env,
        ctx2
      );
      await ctx2.settle();
      assert.deepStrictEqual(second.revenue, { sent: false, reason: "already-sent" });
    } finally {
      globalThis.fetch = realFetch;
    }
    const umamiCalls = spy.calls.filter((c) => String(c.url).includes("umami"));
    assert.strictEqual(umamiCalls.length, 1, "exactly one POST to Umami across both deliveries");
    const body = JSON.parse(umamiCalls[0].init.body);
    assert.deepStrictEqual(body.payload.data, { revenue: 42.5, currency: "USD" });
  });

  await it("books nothing for a session Stripe has not marked paid", async () => {
    const db = await freshDb(migrations);
    const env = baseEnv(db);
    const spy = fetchSpy();
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      for (const payment_status of ["unpaid", "no_payment_required", undefined]) {
        const ctx = makeCtx();
        const out = await webhook.processStripeEvent(
          {
            id: "evt_x",
            type: "checkout.session.completed",
            data: {
              object: bareSession({ payment_status, id: "cs_test_" + String(payment_status) })
            }
          },
          env,
          ctx
        );
        await ctx.settle();
        assert.strictEqual(out.revenue.sent, false, String(payment_status));
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(spy.calls.filter((c) => String(c.url).includes("umami")).length, 0);
  });

  await it("books nothing, and says so, when UMAMI_WEBSITE_ID is not configured", async () => {
    const db = await freshDb(migrations);
    const env = Object.assign(baseEnv(db), { UMAMI_WEBSITE_ID: "" });
    const ctx = makeCtx();
    const out = await webhook.processStripeEvent(
      { id: "evt_2", type: "checkout.session.completed", data: { object: bareSession() } },
      env,
      ctx
    );
    await ctx.settle();
    assert.deepStrictEqual(out.revenue, { sent: false, reason: "not-configured" });
    /* ...and the claim was NOT taken, so configuring the id later and
       replaying the event still books the order. */
    assert.strictEqual(await sends.getAnalyticsSend(db, sends.ORDER_PAID, SESSION_ID), null);
  });

  await it("an analytics outage does not fail the webhook", async () => {
    const db = await freshDb(migrations);
    const env = baseEnv(db);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("umami is down");
    };
    try {
      const ctx = makeCtx();
      /* The assertion is that this RESOLVES. processStripeEvent throws when
         any step it collects a failure for went wrong, and Stripe redelivers
         on a throw -- re-running the money path for the sake of a dashboard. */
      const out = await webhook.processStripeEvent(
        { id: "evt_3", type: "checkout.session.completed", data: { object: bareSession() } },
        env,
        ctx
      );
      await ctx.settle();
      assert.strictEqual(out.type, "checkout.session.completed");
      assert.strictEqual(out.revenue.sent, true, "queued -- the failure happens off the response");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await it("an unusable amount is reported as such rather than sent as zero", async () => {
    const db = await freshDb(migrations);
    const env = baseEnv(db);
    const spy = fetchSpy();
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      const ctx = makeCtx();
      const out = await webhook.processStripeEvent(
        {
          id: "evt_4",
          type: "checkout.session.completed",
          data: { object: bareSession({ amount_total: null, id: "cs_test_noamount" }) }
        },
        env,
        ctx
      );
      await ctx.settle();
      assert.deepStrictEqual(out.revenue, { sent: false, reason: "unusable-amount" });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(spy.calls.filter((c) => String(c.url).includes("umami")).length, 0);
  });

  await it("does nothing at all without the D1 binding, rather than sending twice", async () => {
    const spy = fetchSpy();
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      const ctx = makeCtx();
      const out = await webhook.processStripeEvent(
        { id: "evt_5", type: "checkout.session.completed", data: { object: bareSession() } },
        { UMAMI_WEBSITE_ID: WEBSITE_ID, GIFT_CARD_LEDGER: {} },
        ctx
      );
      await ctx.settle();
      assert.deepStrictEqual(out.revenue, { sent: false, reason: "no-state-db" });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(spy.calls.filter((c) => String(c.url).includes("umami")).length, 0);
  });

  /* ==================================================================== 5 */
  console.log("\n5. configuration");

  await it("wrangler.toml's UMAMI_WEBSITE_ID matches the id the site build emits", () => {
    const toml = fs.readFileSync(path.join(ROOT, "workers/wrangler.toml"), "utf8");
    const m = /^UMAMI_WEBSITE_ID\s*=\s*"([^"]*)"/m.exec(toml);
    assert.ok(m, "wrangler.toml declares UMAMI_WEBSITE_ID in [vars]");
    const content = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
    );
    const siteId = String((content.site || {}).umamiWebsiteId || "").trim();
    assert.ok(siteId, "content.json holds a website id (this check is pointless without one)");
    assert.strictEqual(
      m[1],
      siteId,
      "the Worker and the site must report to the SAME website, or revenue lands in a dashboard nobody reads"
    );
  });

  await it("the cron sweeps the claim table, so it is not the one table that grows forever", () => {
    const checkout = fs.readFileSync(path.join(ROOT, "workers/checkout.js"), "utf8");
    assert.ok(
      checkout.includes("sweepAnalyticsSends"),
      "workers/checkout.js's scheduled handler sweeps analytics_sends"
    );
  });

  console.log(
    `\nworker-analytics.test.js: ${passed} passed, ${failed} failed` +
      (failed ? `\n  failing: ${failures.join(", ")}` : "")
  );
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
