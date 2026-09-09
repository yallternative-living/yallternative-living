/**
 * @fileoverview Unit tests for the passwordless order history:
 *   - workers/state/orders.js          (D1: the orders table)
 *   - workers/state/magic-link.js      (the opaque `subject` claim)
 *   - workers/routes/orders.js         (POST /api/orders/request-link, GET /api/orders)
 * and the wiring that feeds it -- the per-line metadata workers/checkout.js
 * writes, the webhook step that persists an order, and the ship-notice merge
 * that folds tracking in.
 *
 * Same harness as scripts/worker-retention.test.js: D1 and the Durable Object
 * rate limiter are emulated on node:sqlite (scripts/lib/d1-emulator.js), only
 * Stripe, Resend and the site JSON are mocked, and every route is driven
 * through the REAL entrypoint (workers/checkout.js's default export).
 *
 * Run: node scripts/worker-orders.test.js
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
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

/* ==========================================================================
   Fixtures and harness
   ========================================================================== */

const WEBHOOK_SECRET = "whsec_orders_suite";
const SIGNING_SECRET = "orders-suite-signing-secret";
const SITE = "https://yallternativeliving.com";

const mockCatalog = {
  products: [
    { id: "sleep-salve", name: "Sleep Salve", category: "salves", price: 18, inStock: true },
    {
      id: "tank-top",
      name: "Y'all Tank Top",
      category: "apparel",
      price: 28,
      inStock: true,
      variants: { name: "Size", options: [{ label: "M" }, { label: "L" }] }
    }
  ],
  bundles: [],
  sales: [],
  shop: { freeShippingThreshold: 40 }
};

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
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
    STRIPE_SECRET_KEY: "sk_test_orders",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: "re_test_orders",
    MAGIC_LINK_SECRET: SIGNING_SECRET,
    STRIPE_BIRTHDAY_COUPON_ID: "coupon_five_off",
    STATE_DB: db,
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

/** A Stripe line item as the list endpoint returns it with price.product expanded. */
function stripeLine(productId, name, unit, qty, extra = {}) {
  return {
    id: `li_${productId}_${qty}`,
    description: name,
    quantity: qty,
    amount_subtotal: unit * qty,
    amount_total: unit * qty,
    price: {
      unit_amount: unit,
      product: {
        id: `prod_${productId}`,
        metadata: { yl_product_id: productId, yl_kind: "product", ...extra }
      }
    }
  };
}

/**
 * Swap global.fetch for a recorder that answers the site JSON, Stripe and
 * Resend. `options.lineItems` is what the line-items list returns.
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [], lineItemUrls: [], sessionBodies: [], sessionLookups: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = (opts && opts.body) || "";
    const jsonRes = (data, status = 200) => ({
      ok: status < 400,
      status,
      clone: () => ({ body: null }),
      json: async () => data,
      text: async () => JSON.stringify(data)
    });
    if (u.includes("products.json")) return jsonRes(mockCatalog);
    if (u.includes("content.json")) {
      return jsonRes(options.content || { site: { loyaltyPointsPerDollar: 2 } });
    }
    if (u.includes("events.json")) return jsonRes({ events: [] });
    if (/checkout\/sessions\/[^/]+\/line_items/.test(u)) {
      calls.lineItemUrls.push(u);
      if (options.lineItemsDown) return jsonRes({}, 503);
      if (options.lineItemsGone) return jsonRes({ error: { message: "no such session" } }, 404);
      return jsonRes({ data: options.lineItems || [], has_more: false });
    }
    if (u.includes("api.stripe.com/v1/checkout/sessions")) {
      if (u.includes("payment_intent=")) {
        calls.sessionLookups.push(u);
        const found = Object.prototype.hasOwnProperty.call(options, "session")
          ? options.session
          : { id: "cs_test_shipped", customer_details: { email: "parcel@example.com" } };
        return jsonRes({ data: found ? [found] : [] });
      }
      calls.sessionBodies.push(new URLSearchParams(body));
      return jsonRes({ id: "cs_test_orders", url: "https://checkout.stripe.com/pay/x" });
    }
    if (u.includes("api.stripe.com/v1/promotion_codes")) {
      return jsonRes({ id: "promo_1", code: "MINTED1", expires_at: null });
    }
    if (u.includes("api.stripe.com")) return jsonRes({});
    if (u.includes("api.resend.com")) {
      calls.resend.push({ message: JSON.parse(body), headers: (opts && opts.headers) || {} });
      if (options.resendFails) return jsonRes({}, 500);
      return jsonRes({ id: "email_1" });
    }
    return jsonRes({}, 404);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function post(pathname, body, headers = {}) {
  return new Request(`${SITE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function get(pathname, headers = {}) {
  return new Request(`${SITE}${pathname}`, {
    method: "GET",
    headers: { Accept: "application/json", "X-Forwarded-For": freshIp(), ...headers }
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

/** A ctx whose waitUntil promises can be awaited -- request-link sends behind it. */
function collectingCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    settle: () => Promise.all(pending)
  };
}

const noCtx = { waitUntil: () => {} };

function completedEvent(id, sessionId, email, extra = {}) {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        status: "complete",
        created: 1_757_400_000,
        currency: "usd",
        amount_subtotal: 4600,
        amount_total: 5100,
        payment_intent: `pi_${sessionId}`,
        customer_details: { email },
        metadata: { retention_product_ids: "sleep-salve,tank-top", retention_categories: "salves" },
        ...extra
      }
    }
  };
}

/* ==========================================================================
   1. magic-link: the opaque subject claim
   ========================================================================== */

async function testMagicLinkSubject() {
  console.log("\n1. magic-link.js: tokens that carry a hash, not an address");
  const mod = await import("../workers/state/magic-link.js");
  const { hashEmail } = await import("../workers/state/retention.js");
  const hash = await hashEmail("Buyer@Example.com");

  const minted = await mod.signToken(SIGNING_SECRET, { subject: hash, purpose: "orders" });
  assert(!minted.token.includes("@"), "THE TOKEN CARRIES NO ADDRESS -- no @ anywhere in it");
  const decoded = Buffer.from(
    minted.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  assert(!decoded.includes("buyer") && !decoded.includes("example"), "nor in its decoded payload");
  eq(minted.subject, hash, "signToken echoes the subject");
  eq(minted.email, undefined, "and no email");

  const check = await mod.verifyToken(SIGNING_SECRET, minted.token, { purpose: "orders" });
  eq(check.valid, true, "a subject token verifies");
  eq(check.subject, hash, "and hands the subject back");
  eq(check.email, undefined, "with no email claim invented");

  let threw = false;
  try {
    await mod.signToken(SIGNING_SECRET, { subject: hash, email: "a@b.co", purpose: "orders" });
  } catch {
    threw = true;
  }
  assert(threw, "email and subject together are refused");
  threw = false;
  try {
    await mod.signToken(SIGNING_SECRET, { subject: "not-hex!", purpose: "orders" });
  } catch {
    threw = true;
  }
  assert(threw, "a non-hex subject is refused");

  const emailToken = await mod.signToken(SIGNING_SECRET, { email: "a@b.co", purpose: "points" });
  const emailCheck = await mod.verifyToken(SIGNING_SECRET, emailToken.token);
  eq(emailCheck.valid, true, "an email token still verifies exactly as before");
  eq(emailCheck.email, "a@b.co", "with its email");
  eq(emailCheck.subject, undefined, "and no subject");

  // A hand-built payload carrying BOTH claims must not verify even when signed.
  const both = Buffer.from(
    JSON.stringify({
      e: "a@b.co",
      s: hash,
      p: "orders",
      iat: 1,
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: "ab".repeat(8)
    })
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${both}`))
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const bothCheck = await mod.verifyToken(SIGNING_SECRET, `v1.${both}.${sig}`);
  eq(bothCheck.valid, false, "a payload with both e and s is malformed even when signed");

  // Sealing: the link carries the hash encrypted, so the URL names nobody.
  const sealed = await mod.sealSubject(SIGNING_SECRET, hash);
  assert(/^[a-f0-9]{120}$/.test(sealed), "a sealed SHA-256 is 120 hex characters");
  assert(!sealed.includes(hash.slice(0, 16)), "and does not contain the hash");
  eq(await mod.openSubject(SIGNING_SECRET, sealed), hash, "it opens back to the hash");
  assert(
    (await mod.sealSubject(SIGNING_SECRET, hash)) !== sealed,
    "two seals of one hash differ (fresh IV), so two links never look alike"
  );
  eq(
    await mod.openSubject("a-different-secret-entirely", sealed),
    null,
    "another secret opens nothing"
  );
  eq(
    await mod.openSubject(
      SIGNING_SECRET,
      sealed.slice(0, -2) + (sealed.endsWith("00") ? "01" : "00")
    ),
    null,
    "a tampered byte opens nothing"
  );
  eq(await mod.openSubject(SIGNING_SECRET, hash), null, "a bare hash is not a sealed subject");
  const sealedToken = await mod.signToken(SIGNING_SECRET, { subject: sealed, purpose: "orders" });
  eq(
    (await mod.verifyToken(SIGNING_SECRET, sealedToken.token, { purpose: "orders" })).subject,
    sealed,
    "a sealed subject fits the token's subject rule"
  );
}

/* ==========================================================================
   2. state/orders.js
   ========================================================================== */

async function testOrdersState() {
  console.log("\n2. orders.js (D1: record, list, merge)");
  const mod = await import("../workers/state/orders.js");
  const { hashEmail } = await import("../workers/state/retention.js");
  const env = await makeEnv();
  const db = env.STATE_DB;

  const lines = mod.normalizeLineItems([
    stripeLine("tank-top", "Y'all Tank Top (M)", 2800, 1, { yl_variant: "M" }),
    stripeLine("sleep-salve", "Sleep Salve", 1800, 2),
    { description: "Something without a product", quantity: 3, amount_subtotal: 900 },
    { description: "x".repeat(400), quantity: 0 }
  ]);
  eq(
    lines[0],
    {
      name: "Y'all Tank Top (M)",
      quantity: 1,
      unitCents: 2800,
      productId: "tank-top",
      variant: "M",
      kind: "product"
    },
    "a Stripe line with the checkout's metadata normalises to id + variant + kind"
  );
  eq(lines[1].productId, "sleep-salve", "the product id is read off price.product.metadata");
  eq(lines[2].unitCents, 300, "a line with no unit price derives it from the subtotal");
  eq(lines[2].productId, "", "and carries no product id");
  eq(lines[3].quantity, 1, "a zero quantity becomes one");
  eq(lines[3].name.length, 160, "names are capped");

  const first = await mod.recordOrderRow(
    db,
    {
      sessionId: "cs_test_one",
      email: "Buyer@Example.com",
      paymentIntent: "pi_one",
      created: 1000,
      amountTotal: 6400,
      currency: "USD",
      items: lines.slice(0, 2)
    },
    5000
  );
  eq(first.recorded, true, "the first write records");
  eq(first.emailHash, await hashEmail("buyer@example.com"), "under the normalised address hash");
  const again = await mod.recordOrderRow(
    db,
    { sessionId: "cs_test_one", email: "buyer@example.com", amountTotal: 1, items: [] },
    6000
  );
  eq(again.recorded, false, "a second write for the same session is ignored");
  const row = await db.prepare("SELECT * FROM orders WHERE session_id = 'cs_test_one'").first();
  eq(row.amount_total, 6400, "and the first row stands");
  eq(row.currency, "usd", "currency is lower-cased");
  eq(row.status, "processing", "a new order starts as processing");
  assert(!("email" in row), "THE ROW HAS NO EMAIL COLUMN");
  assert(!JSON.stringify(row).includes("@"), "and no address anywhere in it");

  let threw = false;
  try {
    await mod.recordOrderRow(db, { sessionId: "nope", email: "a@b.co", amountTotal: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "a non-session id is refused");

  await mod.recordOrderRow(db, {
    sessionId: "cs_test_two",
    email: "buyer@example.com",
    created: 3000,
    amountTotal: 1800,
    items: [{ name: "Sleep Salve", quantity: 1, unitCents: 1800, productId: "sleep-salve" }]
  });
  await mod.recordOrderRow(db, {
    sessionId: "cs_test_other",
    email: "someone-else@example.com",
    created: 4000,
    amountTotal: 999,
    items: []
  });
  const hash = await hashEmail("buyer@example.com");
  eq(await mod.hasOrders(db, hash), true, "hasOrders sees the buyer's rows");
  eq(await mod.hasOrders(db, "f".repeat(64)), false, "and nothing for an unknown hash");

  const listed = await mod.listOrders(db, hash);
  eq(
    listed.map((o) => o.sessionId),
    ["cs_test_two", "cs_test_one"],
    "listOrders is newest first and holds only this hash's orders"
  );
  eq(listed[1].placedAt, 1, "placedAt is epoch seconds");
  eq(listed[1].amountTotalCents, 6400, "with the total in cents");
  eq(listed[1].items[0].reorderable, true, "a product line is reorderable");
  eq(listed[1].trackingUrl, null, "and no tracking link yet");

  for (let i = 0; i < 30; i++) {
    await mod.recordOrderRow(db, {
      sessionId: `cs_test_many_${String(i).padStart(2, "0")}`,
      email: "buyer@example.com",
      created: 10000 + i,
      amountTotal: 100,
      items: []
    });
  }
  const capped = await mod.listOrders(db, hash);
  eq(capped.length, mod.MAX_ORDERS_LISTED, "the list is capped at MAX_ORDERS_LISTED");
  eq(capped[0].sessionId, "cs_test_many_29", "newest first");
  eq((await mod.listOrders(db, hash, 999)).length, 25, "a bigger limit is clamped to the cap");

  eq(
    await mod.mergeShipment(db, {
      paymentIntent: "pi_one",
      status: "Shipped",
      trackingUrl: "https://tools.usps.com/go/1"
    }),
    true,
    "mergeShipment updates the row behind the PaymentIntent"
  );
  eq(
    await mod.mergeShipment(db, {
      paymentIntent: "pi_one",
      status: "shipped",
      trackingUrl: "https://tools.usps.com/go/1"
    }),
    false,
    "and spends no write when nothing changed"
  );
  // A refund outranks the sweep: the hourly ship-notice pass revisits every
  // shipped intent for 45 days and must not flip "refunded" back.
  await mod.recordOrderRow(db, {
    sessionId: "cs_test_refunded",
    email: "refund@example.com",
    paymentIntent: "pi_refund",
    amountTotal: 1800,
    items: []
  });
  eq(await mod.markRefunded(db, "pi_refund"), true, "markRefunded marks the order");
  eq(
    await mod.mergeShipment(db, {
      paymentIntent: "pi_refund",
      status: "shipped",
      trackingUrl: "https://tools.usps.com/go/9"
    }),
    false,
    "a later sweep does not overwrite Refunded"
  );
  eq(
    (await db.prepare("SELECT status FROM orders WHERE payment_intent = 'pi_refund'").first())
      .status,
    "refunded",
    "...it stays Refunded"
  );
  eq(await mod.markRefunded(db, "pi_refund"), false, "and marking it again is a no-op");
  eq(
    await mod.mergeShipment(db, {
      paymentIntent: "pi_one",
      status: "shipped",
      trackingUrl: "https://tools.usps.com/go/2"
    }),
    true,
    "a corrected tracking link is a change"
  );
  // cs_test_one is older than the 25 filler rows, so read it straight off the table.
  const merged = await db
    .prepare("SELECT status, tracking_url FROM orders WHERE session_id = 'cs_test_one'")
    .first();
  eq(merged.status, "shipped", "status is stored lower-cased");
  eq(merged.tracking_url, "https://tools.usps.com/go/2", "with the latest link");
  eq(
    await mod.mergeShipment(db, { paymentIntent: "pi_none", status: "shipped" }),
    false,
    "unknown intent: no-op"
  );
  eq(await mod.mergeShipment(db, { status: "shipped" }), false, "no intent: no-op");

  eq(await mod.emailForHash(db, hash), null, "emailForHash has nothing without an order signal");
  const retention = await import("../workers/state/retention.js");
  await retention.recordOrder(db, { orderId: "cs_test_one", email: "buyer@example.com" }, 1);
  eq(await mod.emailForHash(db, hash), "buyer@example.com", "and reads it back from order_signals");
}

/* ==========================================================================
   3. The checkout writes per-line metadata; the webhook persists the order
   ========================================================================== */

async function testCheckoutAndWebhook() {
  console.log("\n3. Checkout metadata and webhook persistence");
  const worker = (await import("../workers/checkout.js")).default;
  const { listOrders } = await import("../workers/state/orders.js");
  const { hashEmail } = await import("../workers/state/retention.js");
  const env = await makeEnv();
  const db = env.STATE_DB;

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
    eq(res.status, 200, "the checkout creates a session");
    const params = calls.sessionBodies[0];
    eq(
      params.get("line_items[0][price_data][product_data][metadata][yl_product_id]"),
      "sleep-salve",
      "each Stripe line carries the catalog id"
    );
    eq(
      params.get("line_items[0][price_data][product_data][metadata][yl_kind]"),
      "product",
      "and its kind"
    );
    eq(
      params.get("line_items[0][price_data][product_data][metadata][yl_variant]"),
      null,
      "a line without an option carries no variant key"
    );
    eq(
      params.get("line_items[1][price_data][product_data][metadata][yl_variant]"),
      "M",
      "a line with an option carries the label the Worker matched, not the client string"
    );
  });

  const items = [
    stripeLine("sleep-salve", "Sleep Salve", 1800, 2),
    stripeLine("tank-top", "Y'all Tank Top (M)", 2800, 1, { yl_variant: "M" })
  ];
  await withMocks(
    async (calls) => {
      const res = await worker.fetch(
        webhookRequest(completedEvent("evt_o1", "cs_test_persist", "Hooked@Example.com")),
        env,
        noCtx
      );
      eq(res.status, 200, "the webhook accepts a completed session");
      assert(
        calls.lineItemUrls.some((u) => u.includes("expand%5B%5D=data.price.product")),
        "the line-items read expands price.product so the yl_* metadata comes back"
      );
      eq(calls.lineItemUrls.length, 1, "and reads the lines ONCE per session (memoised)");
    },
    { lineItems: items }
  );

  const hash = await hashEmail("hooked@example.com");
  const orders = await listOrders(db, hash);
  eq(orders.length, 1, "one orders row was written");
  eq(orders[0].sessionId, "cs_test_persist", "for the session");
  eq(orders[0].amountTotalCents, 5100, "with the settled total");
  eq(orders[0].placedAt, 1_757_400_000, "and Stripe's created time");
  eq(
    orders[0].items.map((l) => [l.productId, l.variant, l.quantity, l.unitCents]),
    [
      ["sleep-salve", "", 2, 1800],
      ["tank-top", "M", 1, 2800]
    ],
    "with every line's id, option, quantity and unit price"
  );
  const raw = await db.prepare("SELECT * FROM orders WHERE session_id = 'cs_test_persist'").first();
  eq(raw.payment_intent, "pi_cs_test_persist", "and the PaymentIntent, for the ship notice");
  eq(raw.email_hash, hash, "keyed by the hash of the normalised address");

  await withMocks(
    async () => {
      const again = await worker.fetch(
        webhookRequest(completedEvent("evt_o2", "cs_test_persist", "hooked@example.com")),
        env,
        noCtx
      );
      eq(again.status, 200, "a redelivery is accepted");
    },
    { lineItems: items }
  );
  eq(
    (await db.prepare("SELECT COUNT(*) AS n FROM orders").first()).n,
    1,
    "and writes no second row"
  );

  await withMocks(async () => {
    await worker.fetch(
      webhookRequest(
        completedEvent("evt_o3", "cs_test_unpaid", "hooked@example.com", {
          payment_status: "unpaid"
        })
      ),
      env,
      noCtx
    );
  });
  eq(
    (await db.prepare("SELECT COUNT(*) AS n FROM orders").first()).n,
    1,
    "an unpaid completion writes nothing -- the history holds paid orders only"
  );

  // Red team: Stripe unreachable while the webhook reads the lines. The row
  // is written without them AND the event fails, so Stripe redelivers; the
  // redelivery fills the lines in. Before, the row froze at "[]" for good.
  await withMocks(
    async () => {
      const res = await worker.fetch(
        webhookRequest(completedEvent("evt_o4", "cs_test_blip", "blip@example.com")),
        env,
        noCtx
      );
      eq(res.status, 500, "line items unreadable (Stripe 503): the event is NOT acknowledged");
    },
    { lineItemsDown: true }
  );
  const blip = await db.prepare("SELECT * FROM orders WHERE session_id = 'cs_test_blip'").first();
  assert(blip, "...but the order row exists already");
  eq(blip.line_items_json, "[]", "...with no lines yet");
  await withMocks(
    async () => {
      const res = await worker.fetch(
        webhookRequest(completedEvent("evt_o4", "cs_test_blip", "blip@example.com")),
        env,
        noCtx
      );
      eq(res.status, 200, "the redelivery is acknowledged");
    },
    { lineItems: items }
  );
  const healed = await db
    .prepare("SELECT line_items_json FROM orders WHERE session_id = 'cs_test_blip'")
    .first();
  eq(JSON.parse(healed.line_items_json).length, items.length, "...and fills the lines in");
  // Stripe ANSWERING that there is nothing to read (a 4xx) is not transient:
  // failing the event would fail it identically for three days of retries.
  await withMocks(
    async () => {
      const res = await worker.fetch(
        webhookRequest(completedEvent("evt_o5", "cs_test_gone", "gone@example.com")),
        env,
        noCtx
      );
      eq(res.status, 200, "line items answered 404: the event IS acknowledged");
    },
    { lineItemsGone: true }
  );
  eq(
    (
      await db
        .prepare("SELECT line_items_json FROM orders WHERE session_id = 'cs_test_gone'")
        .first()
    ).line_items_json,
    "[]",
    "...with the row written and no lines"
  );

  // A full refund reaches the page as "Refunded"; a partial one changes nothing.
  const refundEvent = (id, extra) => ({
    id,
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_blip",
        amount: 5100,
        payment_intent: "pi_cs_test_blip",
        ...extra
      }
    }
  });
  const stripeSession = {
    session: {
      id: "cs_test_blip",
      metadata: {},
      customer_details: { email: "blip@example.com" }
    }
  };
  await withMocks(async () => {
    const res = await worker.fetch(
      webhookRequest(refundEvent("evt_r1", { amount_refunded: 500, refunded: false })),
      env,
      noCtx
    );
    eq(res.status, 200, "a partial refund is acknowledged");
  }, stripeSession);
  eq(
    (await db.prepare("SELECT status FROM orders WHERE session_id = 'cs_test_blip'").first())
      .status,
    "processing",
    "...and leaves the status alone"
  );
  await withMocks(async () => {
    const res = await worker.fetch(
      webhookRequest(refundEvent("evt_r2", { amount_refunded: 5100, refunded: true })),
      env,
      noCtx
    );
    eq(res.status, 200, "a full refund is acknowledged");
  }, stripeSession);
  eq(
    (await db.prepare("SELECT status FROM orders WHERE session_id = 'cs_test_blip'").first())
      .status,
    "refunded",
    "...and the order reads Refunded on the customer's page"
  );

  // --- the ship-notice sweep folds status + tracking in --------------------
  const ship = await import("../workers/routes/ship-notice.js");
  await withMocks(
    async () => {
      const out = await ship.emailShipNotice(
        {
          id: "pi_cs_test_persist",
          metadata: {
            fulfillment_status: "shipped",
            tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400"
          }
        },
        env,
        noCtx
      );
      assert(out && out.emailed, "the notice went out");
    },
    { session: { id: "cs_test_persist", customer_details: { email: "hooked@example.com" } } }
  );
  let merged = (await listOrders(db, hash))[0];
  eq(merged.status, "shipped", "the order now reads shipped");
  eq(
    merged.trackingUrl,
    "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400",
    "with the tracking link"
  );
  await withMocks(
    async () => {
      const out = await ship.emailShipNotice(
        {
          id: "pi_cs_test_persist",
          metadata: {
            fulfillment_status: "delivered",
            tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9401"
          }
        },
        env,
        noCtx
      );
      eq(out.skipped, "already-sent", "a later pass sends no second notice");
    },
    { session: { id: "cs_test_persist", customer_details: { email: "hooked@example.com" } } }
  );
  merged = (await listOrders(db, hash))[0];
  eq(merged.status, "delivered", "but still merges the corrected status");
  eq(merged.trackingUrl.endsWith("9401"), true, "and the corrected link");
  await withMocks(
    async () => {
      await ship.emailShipNotice(
        {
          id: "pi_cs_test_persist",
          metadata: { fulfillment_status: "shipped", tracking_url: "javascript:alert(1)" }
        },
        env,
        noCtx
      );
    },
    { session: { id: "cs_test_persist", customer_details: { email: "hooked@example.com" } } }
  );
  merged = (await listOrders(db, hash))[0];
  eq(merged.trackingUrl, null, "a javascript: tracking link is stored as no link at all");
}

/* ==========================================================================
   4. POST /api/orders/request-link
   ========================================================================== */

async function testRequestLink() {
  console.log("\n4. POST /api/orders/request-link");
  const worker = (await import("../workers/checkout.js")).default;
  const routes = await import("../workers/routes/orders.js");
  const { recordOrderRow } = await import("../workers/state/orders.js");
  const { suppressEmail } = await import("../workers/state/retention.js");
  const { verifyToken } = await import("../workers/state/magic-link.js");
  const env = await makeEnv();
  const db = env.STATE_DB;
  await recordOrderRow(db, {
    sessionId: "cs_test_known",
    email: "known@example.com",
    amountTotal: 1800,
    items: []
  });
  await recordOrderRow(db, {
    sessionId: "cs_test_quiet",
    email: "quiet@example.com",
    amountTotal: 1800,
    items: []
  });
  await suppressEmail(db, "quiet@example.com", "bounce");
  await recordOrderRow(db, {
    sessionId: "cs_test_unsub",
    email: "unsub@example.com",
    amountTotal: 1800,
    items: []
  });
  await suppressEmail(db, "unsub@example.com", "unsubscribe");

  const bad = await worker.fetch(post("/api/orders/request-link", { email: "nope" }), env, noCtx);
  eq(bad.status, 400, "an unusable address is a 400");

  const bodies = {};
  await withMocks(async (calls) => {
    const ctx = collectingCtx();
    const res = await worker.fetch(
      post("/api/orders/request-link", { email: "Known@Example.com" }),
      env,
      ctx
    );
    await ctx.settle();
    eq(res.status, 200, "a known address gets a 200");
    eq(res.headers.get("Cache-Control"), "no-store", "that is never cached");
    bodies.known = await res.json();
    eq(bodies.known.message, routes.NEUTRAL_MESSAGE, "with the neutral message");
    eq(calls.resend.length, 1, "and ONE email went out");
    const msg = calls.resend[0].message;
    eq(msg.to, "known@example.com", "to the normalised address");
    assert(/orders/i.test(msg.subject), "about their orders");
    const m = /orders\.html\?token=([^"\s<]+)/.exec(msg.text);
    assert(m !== null, "the plain-text part carries the orders.html?token= link");
    assert(msg.html.includes(m[1]), "and the HTML part carries the same token");
    const token = decodeURIComponent(m[1]);
    assert(!token.includes("@") && !/known/i.test(token), "the link holds no address");
    const check = await verifyToken(SIGNING_SECRET, token, {
      purpose: routes.ORDERS_TOKEN_PURPOSE
    });
    eq(check.valid, true, "the token verifies for the orders purpose");
    assert(
      check.expiresAt - Math.floor(Date.now() / 1000) <= routes.ORDERS_TOKEN_TTL_SECONDS,
      "and expires within 24 hours"
    );
    assert(
      check.expiresAt - Math.floor(Date.now() / 1000) > routes.ORDERS_TOKEN_TTL_SECONDS - 120,
      "not sooner"
    );
    assert(
      !/unsubscribe/i.test(msg.html) && !/unsubscribe/i.test(msg.text),
      "it is transactional: no unsubscribe footer"
    );
    assert(calls.resend[0].headers["Idempotency-Key"], "the send carries a Resend idempotency key");
  });

  await withMocks(async (calls) => {
    const ctx = collectingCtx();
    const res = await worker.fetch(
      post("/api/orders/request-link", { email: "stranger@example.com" }),
      env,
      ctx
    );
    await ctx.settle();
    eq(res.status, 200, "an UNKNOWN address gets a 200 too");
    bodies.unknown = await res.json();
    eq(calls.resend.length, 0, "and no email");
  });
  eq(bodies.unknown, bodies.known, "THE TWO BODIES ARE IDENTICAL -- nothing distinguishes them");

  await withMocks(async (calls) => {
    const ctx = collectingCtx();
    const res = await worker.fetch(
      post("/api/orders/request-link", { email: "quiet@example.com" }),
      env,
      ctx
    );
    await ctx.settle();
    eq(res.status, 200, "a BOUNCED address gets the same 200");
    eq(await res.json(), bodies.known, "the same body");
    eq(calls.resend.length, 0, "and no email -- nobody is there to read it");
  });

  await withMocks(async (calls) => {
    const ctx = collectingCtx();
    const res = await worker.fetch(
      post("/api/orders/request-link", { email: "unsub@example.com" }),
      env,
      ctx
    );
    await ctx.settle();
    eq(res.status, 200, "an UNSUBSCRIBED address gets the same 200");
    eq(
      calls.resend.length,
      1,
      "and the link still goes out: it is transactional and was asked for a moment ago"
    );
  });

  // Red team: a third limiter, per address per day. 3 per 10 minutes alone
  // let callers rotating their own addresses send one inbox 432 links a day.
  eq(routes.ORDERS_LINK_DAILY_LIMIT, { limit: 10, period: 86400 }, "10 links per address per day");
  assert(
    [...env.RATE_LIMIT_COUNTER._instances.keys()].some((k) =>
      k.startsWith("86400:10:orders-link:d:")
    ),
    "the daily per-address counter was consulted for the requests above"
  );

  await withMocks(
    async (calls) => {
      const ctx = collectingCtx();
      const res = await worker.fetch(
        post("/api/orders/request-link", { email: "known@example.com" }),
        env,
        ctx
      );
      await ctx.settle();
      eq(res.status, 200, "a refused send is still a 200");
      eq(await res.json(), bodies.known, "with the same body");
      eq(calls.resend.length, 1, "(Resend was asked)");
    },
    { resendFails: true }
  );

  // --- rate limits -------------------------------------------------------
  const ip = "203.0.113.77";
  await withMocks(async (calls) => {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const ctx = collectingCtx();
      const res = await worker.fetch(
        post(
          "/api/orders/request-link",
          { email: `fresh${i}@example.com` },
          { "X-Forwarded-For": ip }
        ),
        env,
        ctx
      );
      await ctx.settle();
      seen.push(res.status);
    }
    eq(seen, [200, 200, 200, 429], "3 per client per window; the 4th from one client is a 429");
    eq(calls.resend.length, 0, "(none of those addresses had orders)");
  });
  await withMocks(async (calls) => {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const ctx = collectingCtx();
      const res = await worker.fetch(
        post("/api/orders/request-link", { email: "Hammered@Example.com" }),
        env,
        ctx
      );
      await ctx.settle();
      seen.push(res.status);
    }
    eq(
      seen,
      [200, 200, 200, 429],
      "3 per ADDRESS per window: four different clients asking for one address, the 4th is a 429"
    );
    eq(calls.resend.length, 0, "and still nothing sent for an unknown address");
  });

  // --- the switch and the bindings ---------------------------------------
  await withMocks(
    async () => {
      const res = await worker.fetch(
        post("/api/orders/request-link", { email: "known@example.com" }),
        env,
        noCtx
      );
      eq(res.status, 404, "with enableOrderHistory off in /admin the route answers 404");
    },
    { content: { site: { enableOrderHistory: false } } }
  );
  const noDb = await worker.fetch(
    post("/api/orders/request-link", { email: "known@example.com" }),
    { ...env, STATE_DB: undefined },
    noCtx
  );
  eq(noDb.status, 503, "without STATE_DB it answers 503 rather than pretending");
  const noSecret = await worker.fetch(
    post("/api/orders/request-link", { email: "known@example.com" }),
    { ...env, MAGIC_LINK_SECRET: undefined },
    noCtx
  );
  eq(noSecret.status, 503, "and without MAGIC_LINK_SECRET too");
}

/* ==========================================================================
   5. GET /api/orders?token=
   ========================================================================== */

async function testList() {
  console.log("\n5. GET /api/orders");
  const worker = (await import("../workers/checkout.js")).default;
  const routes = await import("../workers/routes/orders.js");
  const { recordOrderRow } = await import("../workers/state/orders.js");
  const { sealSubject, signToken } = await import("../workers/state/magic-link.js");
  const { hashEmail, recordOrder } = await import("../workers/state/retention.js");
  const { credit } = await import("../workers/state/loyalty.js");
  const env = await makeEnv();
  const db = env.STATE_DB;

  const alice = await hashEmail("alice@example.com");
  const bob = await hashEmail("bob@example.com");
  await recordOrderRow(db, {
    sessionId: "cs_test_alice_1",
    email: "alice@example.com",
    paymentIntent: "pi_a1",
    created: 1000,
    amountTotal: 3600,
    items: [
      { name: "Sleep Salve", quantity: 2, unitCents: 1800, productId: "sleep-salve" },
      {
        name: "Gift Card ($25)",
        quantity: 1,
        unitCents: 2500,
        productId: "gift-card",
        kind: "gift-card"
      }
    ]
  });
  await recordOrderRow(db, {
    sessionId: "cs_test_alice_2",
    email: "alice@example.com",
    created: 2000,
    amountTotal: 2800,
    items: [
      {
        name: "Y'all Tank Top (M)",
        quantity: 1,
        unitCents: 2800,
        productId: "tank-top",
        variant: "M"
      }
    ],
    trackingUrl: "https://tools.usps.com/go/x",
    status: "shipped"
  });
  await recordOrderRow(db, {
    sessionId: "cs_test_bob_1",
    email: "bob@example.com",
    created: 3000,
    amountTotal: 999,
    items: [{ name: "Bob's thing", quantity: 1, unitCents: 999, productId: "sleep-salve" }]
  });
  await recordOrder(db, { orderId: "cs_test_alice_1", email: "alice@example.com" }, 1000);
  await credit(db, { email: "alice@example.com", points: 40, orderId: "cs_test_alice_1" });

  // Minted the way the route mints: the hash is sealed before it becomes the
  // subject (magic-link.js sealSubject), so the link never carries it bare.
  const mint = async (subject, extra = {}) =>
    signToken(SIGNING_SECRET, {
      subject: await sealSubject(SIGNING_SECRET, subject),
      purpose: routes.ORDERS_TOKEN_PURPOSE,
      ttlSeconds: routes.ORDERS_TOKEN_TTL_SECONDS,
      ...extra
    });

  const aliceToken = (await mint(alice)).token;
  let data;
  await withMocks(async () => {
    const res = await worker.fetch(
      get(`/api/orders?token=${encodeURIComponent(aliceToken)}`),
      env,
      noCtx
    );
    eq(res.status, 200, "a fresh token opens the list");
    eq(res.headers.get("Cache-Control"), "no-store", "Cache-Control: no-store");
    data = await res.json();
  });
  eq(
    Object.keys(data).sort(),
    ["loyalty", "orders"],
    "the body holds orders and loyalty, nothing else"
  );
  eq(
    data.orders.map((o) => o.sessionId),
    ["cs_test_alice_2", "cs_test_alice_1"],
    "ALICE'S orders, newest first -- and none of Bob's"
  );
  const text = JSON.stringify(data);
  assert(!text.includes("@"), "NO ADDRESS ANYWHERE IN THE ANSWER");
  assert(!text.includes("Bob"), "and nothing of another customer's");
  eq(
    Object.keys(data.orders[0]).sort(),
    ["amountTotalCents", "currency", "items", "placedAt", "sessionId", "status", "trackingUrl"],
    "each order: date, items, total, currency, status, tracking, reference"
  );
  eq(
    Object.keys(data.orders[0].items[0]).sort(),
    ["kind", "name", "productId", "quantity", "reorderable", "unitCents", "variant"],
    "each line: name, quantity, unit price, id, option, kind, reorderable"
  );
  eq(data.orders[0].trackingUrl, "https://tools.usps.com/go/x", "the tracking link comes through");
  eq(data.orders[0].status, "shipped", "with its status");
  eq(data.orders[1].items[1].reorderable, false, "a gift-card line is not reorderable");
  eq(data.orders[1].items[0].reorderable, true, "a product line is");
  eq(data.loyalty.balance, 40, "the points balance is included when the switch is on");
  eq(data.loyalty.pointsToReward, 60, "with the distance to the next reward");

  await withMocks(async () => {
    const res = await worker.fetch(
      get(`/api/orders?token=${encodeURIComponent(aliceToken)}`),
      env,
      noCtx
    );
    eq(res.status, 403, "THE SAME TOKEN A SECOND TIME IS REFUSED -- it was burned");
    const posted = await worker.fetch(
      post(`/api/orders?token=${encodeURIComponent((await mint(alice)).token)}`, {}),
      env,
      noCtx
    );
    eq(posted.status, 405, "POST /api/orders is not a second door to the same handler");
  });
  const burned = await db.prepare("SELECT COUNT(*) AS n FROM burned_tokens").first();
  eq(burned.n, 1, "one burned_tokens row records the use");

  // --- loyalty off, or no address on file --------------------------------
  await withMocks(
    async () => {
      const res = await worker.fetch(
        get(`/api/orders?token=${encodeURIComponent((await mint(alice)).token)}`),
        env,
        noCtx
      );
      eq((await res.json()).loyalty, null, "with enableLoyaltyPoints off the balance is omitted");
    },
    { content: { site: { enableLoyaltyPoints: false } } }
  );
  await withMocks(async () => {
    const res = await worker.fetch(
      get(`/api/orders?token=${encodeURIComponent((await mint(bob)).token)}`),
      env,
      noCtx
    );
    const bobData = await res.json();
    eq(
      bobData.orders.map((o) => o.sessionId),
      ["cs_test_bob_1"],
      "Bob's token lists Bob's order only"
    );
    eq(bobData.loyalty, null, "and no balance when no address is on file for the hash");
  });

  // --- every refusal is the same 403 ---------------------------------------
  const refusals = {};
  const tokenA = (await mint(alice)).token;
  const [h, p, s] = tokenA.split(".");
  const tampered = `${h}.${p}.${s.slice(0, -2)}${s.slice(-2) === "AA" ? "BB" : "AA"}`;
  const pointsToken = (
    await signToken(SIGNING_SECRET, { email: "alice@example.com", purpose: "points" })
  ).token;
  const emailOrdersToken = (
    await signToken(SIGNING_SECRET, {
      email: "alice@example.com",
      purpose: routes.ORDERS_TOKEN_PURPOSE
    })
  ).token;
  const expired = (await mint(alice, { now: Date.now() - 2 * 86400 * 1000 })).token;
  const otherSecret = (
    await signToken("a-completely-different-secret", {
      subject: alice,
      purpose: routes.ORDERS_TOKEN_PURPOSE
    })
  ).token;
  await withMocks(async () => {
    for (const [label, token] of [
      ["missing", ""],
      ["garbage", "v1.abc.def"],
      ["tampered", tampered],
      ["points-purpose", pointsToken],
      ["email-bearing orders token", emailOrdersToken],
      ["expired", expired],
      ["other secret", otherSecret]
    ]) {
      const res = await worker.fetch(
        get(`/api/orders?token=${encodeURIComponent(token)}`),
        env,
        noCtx
      );
      refusals[label] = { status: res.status, body: await res.json() };
    }
  });
  for (const label of Object.keys(refusals)) {
    eq(refusals[label].status, 403, `a ${label} token is a 403`);
  }
  eq(
    new Set(Object.values(refusals).map((r) => JSON.stringify(r.body))).size,
    1,
    "and every refusal carries the SAME body -- nothing says which check failed"
  );
  eq(
    (await db.prepare("SELECT COUNT(*) AS n FROM burned_tokens").first()).n,
    3,
    "refused tokens burn nothing (only the three that opened a list did)"
  );

  // --- rate limit, switch, bindings ---------------------------------------
  await withMocks(async () => {
    const ip = "203.0.113.99";
    const statuses = [];
    for (let i = 0; i < routes.ORDERS_LIST_RATE_LIMIT.limit + 1; i++) {
      const res = await worker.fetch(
        get("/api/orders?token=v1.x.y", { "X-Forwarded-For": ip }),
        env,
        noCtx
      );
      statuses.push(res.status);
    }
    eq(statuses[statuses.length - 1], 429, "the list endpoint is rate-limited per client");
    eq(statuses[0], 403, "(before that, the bad token was a 403)");
  });
  await withMocks(
    async () => {
      const res = await worker.fetch(
        get(`/api/orders?token=${encodeURIComponent((await mint(alice)).token)}`),
        env,
        noCtx
      );
      eq(res.status, 404, "with enableOrderHistory off the list answers 404");
    },
    { content: { site: { enableOrderHistory: false } } }
  );
  const noDb = await worker.fetch(
    get("/api/orders?token=x"),
    { ...env, STATE_DB: undefined },
    noCtx
  );
  eq(noDb.status, 503, "without STATE_DB it answers 503");
  const preflight = await worker.fetch(
    new Request(`${SITE}/api/orders`, { method: "OPTIONS", headers: { Origin: SITE } }),
    env,
    noCtx
  );
  eq(preflight.status, 204, "OPTIONS preflight is answered like every other route");
}

/* ==========================================================================
   6. The docs and the pages keep up
   ========================================================================== */

function testDocsAndPages() {
  console.log("\n6. schema.sql, README, docs, the page and the service worker");
  const schema = fs.readFileSync(path.join(ROOT, "workers", "schema.sql"), "utf8");
  assert(
    /CREATE TABLE IF NOT EXISTS orders\b/.test(schema),
    "schema.sql documents the orders table"
  );
  assert(!/orders\s*\([^)]*\bemail\s+TEXT/s.test(schema), "and it has no email column");

  const readme = fs.readFileSync(path.join(ROOT, "workers", "README.md"), "utf8");
  for (const route of ["/api/orders/request-link", "/api/orders"]) {
    assert(readme.includes(route), `workers/README.md documents ${route}`);
  }
  const stateLayer = fs.readFileSync(path.join(ROOT, "docs", "STATE-LAYER.md"), "utf8");
  assert(
    stateLayer.includes("/api/orders/request-link"),
    "docs/STATE-LAYER.md documents the link route"
  );
  const dev = fs.readFileSync(path.join(ROOT, "docs", "DEVELOPMENT.md"), "utf8");
  assert(dev.includes("/api/orders"), "docs/DEVELOPMENT.md lists the endpoints");
  const analytics = fs.readFileSync(path.join(ROOT, "docs", "ANALYTICS.md"), "utf8");
  assert(
    /orders\.html/.test(analytics),
    "docs/ANALYTICS.md says what the orders page sends (nothing)"
  );
  const editing = fs.readFileSync(path.join(ROOT, "docs", "EDITING-GUIDE.md"), "utf8");
  assert(/Your Orders/.test(editing), "docs/EDITING-GUIDE.md explains the Your Orders page");
  const setup = fs.readFileSync(path.join(ROOT, "docs", "SETUP-GUIDE.md"), "utf8");
  assert(
    /orders/i.test(setup) && /MAGIC_LINK_SECRET/.test(setup),
    "docs/SETUP-GUIDE.md says nothing new is needed"
  );

  const page = fs.readFileSync(path.join(ROOT, "orders.html"), "utf8");
  assert(/<meta name="robots" content="noindex/.test(page), "orders.html is noindexed");
  assert(
    !/<script>[^]*?token[^]*?<\/script>/i.test(
      page.replace(/application\/ld\+json[^]*?<\/script>/, "")
    ),
    "orders.html has no inline script of its own"
  );
  assert(page.includes('src="assets/js/orders.js"'), "and loads the external orders.js");
  for (const marker of [
    "orders.headline",
    "orders.lede",
    "orders.emailLabel",
    "orders.buttonText",
    "orders.confirmation"
  ]) {
    assert(page.includes(`<!--YL:${marker}-->`), `orders.html carries the ${marker} marker`);
  }
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
  eq(content.site.enableOrderHistory, true, "content.json has enableOrderHistory on by default");
  for (const key of ["headline", "lede", "emailLabel", "buttonText", "confirmation"]) {
    assert(
      typeof content.orders[key] === "string" && content.orders[key],
      `content.json orders.${key} is set`
    );
  }
  assert(
    /if we have orders/i.test(content.orders.confirmation),
    "the confirmation wording is neutral"
  );
  const cms = fs.readFileSync(path.join(ROOT, "admin/config.yml"), "utf8");
  assert(/name: enableOrderHistory/.test(cms), "admin/config.yml exposes the switch");
  assert(/name: orders\n\s+label: Your Orders page/.test(cms), "and the page wording");
  const sitemap = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
  assert(!sitemap.includes("orders.html"), "sitemap.xml does not list the token page");
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert(
    sw.includes("'/orders.html'") && sw.includes("'/assets/js/orders.js'"),
    "sw.js precaches the page and its script"
  );
  const footer = fs.readFileSync(path.join(ROOT, "assets/data/footer.html"), "utf8");
  assert(/href="\/orders\.html"[^>]*orders-history-link/.test(footer), "the footer links the page");
  for (const file of ["thank-you.html", "order-status.html"]) {
    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert(
      /href="orders\.html"/.test(html) && /orders-history-link/.test(html),
      `${file} links the page`
    );
  }
  const ordersJs = fs.readFileSync(path.join(ROOT, "assets/js/orders.js"), "utf8");
  assert(!/\.innerHTML\s*=/.test(ordersJs), "orders.js never assigns innerHTML");
  assert(
    !/plausible\(|umami\.track\(|\btrack\(/.test(ordersJs),
    "orders.js sends no analytics event"
  );
  assert(/replaceState/.test(ordersJs), "orders.js scrubs the token from the URL");
  assert(/enableOrderHistory/.test(ordersJs), "orders.js honours the CMS switch");
}

/* ==========================================================================
   Runner
   ========================================================================== */

(async () => {
  await testMagicLinkSubject();
  await testOrdersState();
  await testCheckoutAndWebhook();
  await testRequestLink();
  await testList();
  testDocsAndPages();

  const { resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();

  if (passed === 0) {
    console.error("\nworker-orders.test.js: NO assertions ran -- that is a failure, not a pass.");
    process.exit(1);
  }
  console.log(`\nworker-orders.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-orders.test.js crashed:", err);
  process.exit(1);
});
