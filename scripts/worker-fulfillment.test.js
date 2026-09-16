const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", label);
  }
}

function makeD1(dbSync) {
  return {
    prepare(sql) {
      const stmt = dbSync.prepare(sql);
      return {
        bind(...args) {
          return {
            async run() {
              const info = stmt.run(...args);
              return { success: true, meta: { changes: info.changes } };
            },
            async all() {
              const results = stmt.all(...args);
              return { success: true, results };
            },
            async first() {
              const result = stmt.get(...args);
              return result || null;
            }
          };
        },
        async run() {
          const info = stmt.run();
          return { success: true, meta: { changes: info.changes } };
        },
        async all() {
          const results = stmt.all();
          return { success: true, results };
        },
        async first() {
          const result = stmt.get();
          return result || null;
        }
      };
    },
    exec(sql) {
      dbSync.exec(sql);
    }
  };
}

async function main() {
  const { ensureSchema } = await import("file://" + process.cwd() + "/workers/state/migrations.js");
  const { handleUnfulfilledOrders, handleFulfillOrder } = await import("file://" + process.cwd() + "/workers/routes/fulfillment.js");

  const db = makeD1(new DatabaseSync(":memory:"));
  const env = {
    STATE_DB: db,
    STRIPE_SECRET_KEY: "sk_test_mock",
    ADMIN_PASSWORD: "secret_admin_pw"
  };

  await ensureSchema(env.STATE_DB);

  // Setup: mock an unfulfilled order
  await env.STATE_DB.prepare(
    "INSERT INTO order_signals (order_id, email, email_hash, placed_at) VALUES (?, ?, ?, ?)"
  )
    .bind("cs_test_mock", "mock@example.com", "mockhash", 1700000000)
    .run();

  await env.STATE_DB.prepare(
    "INSERT INTO orders (session_id, email_hash, payment_intent, created, amount_total, currency, status, line_items_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("cs_test_mock", "mockhash", "pi_test_mock", 1700000000, 2000, "usd", "processing", "[]", 1700000000)
    .run();

  // Test Unauthorized
  let unauthRes = await handleUnfulfilledOrders({ headers: new Map() }, env, "https://example.com");
  assert(unauthRes.status === 401, "unfulfilled-orders rejects missing auth");

  let authHeaders = new Map([["Authorization", "Bearer secret_admin_pw"]]);

  let unfulfilledRes = await handleUnfulfilledOrders({ headers: authHeaders }, env, "https://example.com");
  assert(unfulfilledRes.status === 200, "unfulfilled-orders returns 200 with auth");
  let unfulfilledJson = await unfulfilledRes.json();
  assert(unfulfilledJson.orders && unfulfilledJson.orders.length === 1, "finds one processing order");
  assert(unfulfilledJson.orders[0].email === "mock@example.com", "resolves email from order_signals");
  assert(unfulfilledJson.orders[0].payment_intent === "pi_test_mock", "returns payment intent");

  let stripeCalls = [];
  const ogFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.includes("api.stripe.com")) {
      stripeCalls.push({ url, options });
      return { ok: true, json: async () => ({ id: "pi_test_mock" }) };
    }
    return ogFetch(url, options);
  };

  try {
    const fulfillReq = {
      json: async () => ({
        payment_intent: "pi_test_mock",
        tracking_url: "https://track.it/123",
        status: "shipped"
      }),
      headers: authHeaders
    };

    // Test Unauthorized
    let unauthFulfillReq = { ...fulfillReq, headers: new Map() };
    let unauthFulfillRes = await handleFulfillOrder(unauthFulfillReq, env, "https://example.com");
    assert(unauthFulfillRes.status === 401, "fulfill-order rejects missing auth");

    let fulfillRes = await handleFulfillOrder(fulfillReq, env, "https://example.com");
    assert(fulfillRes.status === 200, "fulfill-order returns 200 with auth");

    assert(stripeCalls.length === 1, "stripePost was called");
    assert(stripeCalls[0].url.endsWith("/payment_intents/pi_test_mock"), "called correct Stripe URL");
    const sentBody = stripeCalls[0].options.body;
    assert(sentBody.includes("metadata%5Bfulfillment_status%5D=shipped"), "sent status correctly");
    assert(sentBody.includes("metadata%5Btracking_url%5D=https%3A%2F%2Ftrack.it%2F123"), "sent tracking url correctly");
    assert(sentBody.includes("metadata%5Bshipped_at%5D="), "sent shipped_at correctly");
  } finally {
    global.fetch = ogFetch;
  }

  if (failed === 0) {
    console.log("✓ worker-fulfillment.test.js passed");
  } else {
    console.error(`✗ ${failed} tests failed`);
    process.exit(1);
  }
}

main().catch(console.error);
