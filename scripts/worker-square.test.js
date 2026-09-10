/**
 * @fileoverview The market register: Square sales count the inventory ledger
 * down and the ledger's live count is written back to Square
 * (workers/routes/square-webhook.js, workers/state/square-sync.js) -- against
 * the real modules over an in-memory D1 (scripts/lib/d1-emulator.js), with
 * Square's API and the site's own JSON stubbed at `fetch`, so every line
 * under test is the shipped one.
 *
 *   1. the SKU rule: id, id/size, alias, bundle
 *   2. the signature: right, wrong, missing, malformed -- and no clock
 *   3. the route through the Worker: 404 / 503 / 400 / 200, and the claim
 *   4. sales: card, cash, split tender, a comp with no payment, a redelivery
 *   5. what the owner is told: an unmapped item, a shortfall, a sell-out
 *   6. refunds: partial moves nothing, full restocks once
 *   7. the other direction: counts pushed to Square, only when they moved
 *   8. the hourly reconcile, the sweep, the kill switch
 *   9. schema.sql, the CMS, the docs keep up
 *  10. red team: a crash between claim and deduction, two deliveries racing,
 *      a split-tender refund, a return order, register drift, a deleted
 *      variation, control characters in item names, a stale catalogue
 *
 * Run: node scripts/worker-square.test.js
 */

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

const ROOT = path.resolve(__dirname, "..");
const workerModule = require("../workers/checkout.js");
const worker = workerModule.default || workerModule;

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

function assert(condition, label) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

async function rejects(fn, re, label) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${label}\n      expected a rejection`);
  } catch (err) {
    if (re.test(String(err && (err.message || err)))) passed++;
    else {
      failed++;
      console.error(`  ✗ ${label}\n      rejected with ${err && err.message}`);
    }
  }
}

/** Capture console.error / console.warn / console.log lines while `fn` runs. */
async function capture(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

/* ------------------------------------------------------------- the fixtures */

const SITE = "https://yallternativeliving.com";
const SIGNATURE_KEY = "sq-sig-key-test";
const LOCATION = "LTEST123";

const siteCatalog = {
  products: [
    { id: "last-three-balm", name: "Last Three Balm", price: 9, category: "salves", stock: 3 },
    { id: "single-tee", name: "Single Tee", price: 20, category: "apparel", stock: 1 },
    {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 10,
      category: "soaks",
      stock: 10,
      variants: { name: "Size", options: [{ label: "10 oz" }, { label: "24 oz", priceDelta: 8 }] }
    },
    {
      id: "miracle-balm",
      name: "Miracle Balm",
      price: 18,
      category: "salves",
      stock: 4,
      squareSkus: ["MB-2OZ"]
    },
    { id: "boxable-salve", name: "Boxable Salve", price: 12, category: "salves", stock: 2 },
    { id: "boxable-soak", name: "Boxable Soak", price: 12, category: "soaks", stock: 9 },
    { id: "bug-spray", name: "Bug Spray", price: 12, category: "body" }
  ],
  bundles: [
    {
      id: "starter-set",
      name: "Starter Set",
      productIds: ["boxable-salve", "boxable-soak"],
      price: 20
    }
  ]
};

const squareItems = {
  I_BALM: "Last Three Balm",
  I_TEE: "Single Tee",
  I_MB: "Miracle Balm",
  I_SET: "Starter Set",
  I_CANDLE: "Porch Candle",
  I_SOAK: "Lavender Soak",
  I_SPRAY: "Bug Spray"
};
const squareVariations = {
  V_BALM: { item_id: "I_BALM", name: "Regular", sku: "last-three-balm" },
  V_TEE_L: { item_id: "I_TEE", name: "Large", sku: "Single-Tee/Large" },
  V_MB: { item_id: "I_MB", name: "2 oz", sku: "mb-2oz" },
  V_SET: { item_id: "I_SET", name: "Regular", sku: "starter-set" },
  V_CANDLE: { item_id: "I_CANDLE", name: "Regular", sku: "candle-01" },
  V_SOAK10: { item_id: "I_SOAK", name: "10 oz", sku: "lavender-soak/10-oz" },
  V_SOAK24: { item_id: "I_SOAK", name: "24 oz", sku: "lavender-soak: 24 oz" },
  V_SPRAY: { item_id: "I_SPRAY", name: "Regular", sku: "bug-spray" }
};

function variationObject(id) {
  const v = squareVariations[id];
  return { type: "ITEM_VARIATION", id, item_variation_data: { ...v } };
}
function itemObject(id) {
  return { type: "ITEM", id, item_data: { name: squareItems[id] } };
}

/**
 * A Square order: `lines` is `[[variationId, quantity], ...]`. `extra` can
 * carry total_money / tenders / refunds / returns for the refund tests; by
 * default the order collected $10 per unit in one card tender.
 */
function order(id, lines, extra = {}) {
  const units = lines.reduce((n, [, qty]) => n + Number(qty), 0);
  const total = units * 1000;
  return {
    id,
    location_id: LOCATION,
    state: "COMPLETED",
    total_money: { amount: total, currency: "USD" },
    tenders: [
      { id: `T-${id}`, payment_id: `P-${id}`, amount_money: { amount: total, currency: "USD" } }
    ],
    refunds: [],
    line_items: lines.map(([vid, qty], i) => ({
      uid: `${id}-L${i}`,
      catalog_object_id: vid,
      quantity: String(qty),
      name: squareItems[squareVariations[vid].item_id],
      variation_name: squareVariations[vid].name,
      item_type: "ITEM"
    })),
    ...extra
  };
}

function payment(id, orderId, amount, extra = {}) {
  return {
    id,
    order_id: orderId,
    status: "COMPLETED",
    source_type: "CARD",
    amount_money: { amount, currency: "USD" },
    ...extra
  };
}

/** The Square + site stub. Records every Square call it answers. */
function makeSquare({
  orders = {},
  payments = {},
  variationIds = Object.keys(squareVariations)
} = {}) {
  const calls = [];
  const state = {
    orders,
    payments,
    variationIds,
    siteDown: false,
    catalogDown: false,
    // Red-team knobs: Square's own IN_STOCK counts by variation id, the
    // balm's Stock count as the site currently publishes it, and the Date
    // header the site serves products.json with (its "age").
    squareCounts: {},
    balmStock: null,
    siteDate: null
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    if (u.startsWith(SITE)) {
      if (state.siteDown) return new Response("nope", { status: 503 });
      if (u.endsWith("/assets/data/products.json")) {
        const catalog =
          state.balmStock === null
            ? siteCatalog
            : {
                ...siteCatalog,
                products: siteCatalog.products.map((p) =>
                  p.id === "last-three-balm" ? { ...p, stock: state.balmStock } : p
                )
              };
        const headers = state.siteDate ? { date: new Date(state.siteDate).toUTCString() } : {};
        return new Response(JSON.stringify(catalog), { status: 200, headers });
      }
      if (u.endsWith("/assets/data/content.json")) {
        return new Response(
          JSON.stringify({ site: { enableSquareSync: state.enabled !== false } }),
          {
            status: 200
          }
        );
      }
      return new Response("not found", { status: 404 });
    }
    if (!u.startsWith("https://connect.squareup.com/")) {
      throw new Error(`unexpected fetch ${method} ${u}`);
    }
    const pathname = new URL(u).pathname + new URL(u).search;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: pathname, body, auth: opts.headers && opts.headers.Authorization });
    const squareError = (status, code, detail) =>
      new Response(JSON.stringify({ errors: [{ category: "API", code, detail }] }), { status });
    let m;
    if ((m = /^\/v2\/orders\/([^/?]+)$/.exec(pathname))) {
      const o = state.orders[decodeURIComponent(m[1])];
      return o
        ? new Response(JSON.stringify({ order: o }))
        : squareError(404, "NOT_FOUND", "no order");
    }
    if ((m = /^\/v2\/payments\/([^/?]+)$/.exec(pathname))) {
      const p = state.payments[decodeURIComponent(m[1])];
      return p
        ? new Response(JSON.stringify({ payment: p }))
        : squareError(404, "NOT_FOUND", "no payment");
    }
    if (pathname === "/v2/catalog/batch-retrieve" && method === "POST") {
      if (state.catalogDown) return squareError(503, "SERVICE_UNAVAILABLE", "catalog down");
      const objects = body.object_ids.filter((id) => squareVariations[id]).map(variationObject);
      const related = [...new Set(objects.map((o) => o.item_variation_data.item_id))].map(
        itemObject
      );
      return new Response(JSON.stringify({ objects, related_objects: related }));
    }
    if (pathname.startsWith("/v2/catalog/list")) {
      const objects = [
        ...Object.keys(squareItems).map(itemObject),
        ...state.variationIds.map(variationObject)
      ];
      return new Response(JSON.stringify({ objects }));
    }
    if (pathname === "/v2/inventory/counts/batch-retrieve" && method === "POST") {
      const counts = (body.catalog_object_ids || [])
        .filter((id) => Object.prototype.hasOwnProperty.call(state.squareCounts, id))
        .map((id) => ({
          catalog_object_id: id,
          catalog_object_type: "ITEM_VARIATION",
          state: "IN_STOCK",
          location_id: LOCATION,
          quantity: String(state.squareCounts[id]),
          calculated_at: "2026-09-10T00:00:00Z"
        }));
      return new Response(JSON.stringify({ counts }));
    }
    if (pathname === "/v2/inventory/changes/batch-create" && method === "POST") {
      if (state.pushDown) return squareError(500, "INTERNAL_SERVER_ERROR", "push down");
      return new Response(JSON.stringify({ counts: [] }));
    }
    return squareError(404, "NOT_FOUND", `unstubbed ${method} ${pathname}`);
  };
  return {
    calls,
    state,
    pushes: () => calls.filter((c) => c.path === "/v2/inventory/changes/batch-create"),
    restore: () => {
      global.fetch = originalFetch;
    }
  };
}

async function freshDb() {
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  const { resetInventoryMemo } = await import("../workers/state/inventory.js");
  const { resetAlertMemo } = await import("../workers/routes/alerts.js");
  resetSchemaMemo();
  resetInventoryMemo();
  resetAlertMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return db;
}

async function makeEnv(overrides = {}) {
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  return {
    SITE_ORIGIN: SITE,
    STATE_DB: await freshDb(),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIGNATURE_KEY,
    SQUARE_ACCESS_TOKEN: "EAAA-test-token",
    SQUARE_LOCATION_ID: LOCATION,
    ...overrides
  };
}

/** A ctx whose waitUntil promises can be awaited, so pushes settle in-test. */
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    }
  };
}

const WEBHOOK_URL = `${SITE}/api/square-webhook`;

function sign(body, key = SIGNATURE_KEY, url = WEBHOOK_URL) {
  return nodeCrypto.createHmac("sha256", key).update(`${url}${body}`).digest("base64");
}

let eventCounter = 0;
function squareEvent(type, object, id) {
  return {
    merchant_id: "M1",
    type,
    event_id: id || `0f1e2d3c-0000-4000-8000-${String(++eventCounter).padStart(12, "0")}`,
    created_at: "2026-09-06T14:03:00Z",
    data: { type: type.split(".")[0], id: "x", object }
  };
}

/** POST one event through the real Worker. */
async function post(env, ctx, event, { signature } = {}) {
  const body = JSON.stringify(event);
  const headers = { "Content-Type": "application/json" };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers["x-square-hmacsha256-signature"] = sig;
  const req = new Request("https://yallternative-checkout.workers.dev/square-webhook", {
    method: "POST",
    headers,
    body
  });
  const res = await worker.fetch(req, env, ctx);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, cache: res.headers.get("Cache-Control") };
}

async function available(db, ids) {
  const { readAvailability } = await import("../workers/state/inventory.js");
  const rows = await readAvailability(db, ids);
  const out = {};
  for (const id of ids) out[id] = rows.has(id) ? rows.get(id).available : null;
  return out;
}

/* ================================================================== tests */

async function run() {
  const sync = await import("../workers/state/square-sync.js");
  const route = await import("../workers/routes/square-webhook.js");
  const { loadProductIndex } = await import("../workers/state/site-data.js");

  /* ------------------------------------------------------------------ 1 */
  console.log("\n1. the SKU rule");
  {
    const square = makeSquare();
    const index = await loadProductIndex({ SITE_ORIGIN: SITE }, null);
    square.restore();
    eq(
      sync.resolveSku("last-three-balm", index),
      { id: "last-three-balm", kind: "product" },
      "the id itself"
    );
    eq(
      sync.resolveSku("  Last-Three-Balm ", index),
      { id: "last-three-balm", kind: "product" },
      "case and space do not matter"
    );
    eq(
      sync.resolveSku("single-tee/large", index),
      { id: "single-tee", kind: "product" },
      "id/size maps to the product"
    );
    eq(
      sync.resolveSku("lavender-soak: 24 oz", index),
      { id: "lavender-soak", kind: "product" },
      "id: size too"
    );
    eq(
      sync.resolveSku("lavender-soak 10oz", index),
      { id: "lavender-soak", kind: "product" },
      "and id<space>size"
    );
    eq(
      sync.resolveSku("MB-2OZ", index),
      { id: "miracle-balm", kind: "product" },
      "an alias listed under squareSkus"
    );
    eq(
      sync.resolveSku("mb-2oz", index),
      { id: "miracle-balm", kind: "product" },
      "...case-insensitively"
    );
    eq(
      sync.resolveSku("starter-set", index),
      { id: "starter-set", kind: "bundle" },
      "a bundle id is a bundle"
    );
    eq(sync.resolveSku("candle-01", index), null, "an unknown SKU is null");
    eq(sync.resolveSku("", index), null, "an empty SKU is null");
    eq(sync.resolveSku(null, index), null, "a missing SKU is null");
    eq(sync.resolveSku("last-three-balm", null), null, "no index, no answer");
    eq(
      sync.expandLine({ id: "starter-set", kind: "bundle" }, 2, index),
      [
        { productId: "boxable-salve", qty: 2 },
        { productId: "boxable-soak", qty: 2 }
      ],
      "a bundle expands to its members, qty each"
    );
    eq(
      sync.expandLine({ id: "single-tee", kind: "product" }, "3", index),
      [{ productId: "single-tee", qty: 3 }],
      "a product is itself"
    );
    eq(sync.expandLine({ id: "single-tee", kind: "product" }, 0, index), [], "zero is nothing");
    eq(
      sync.mergeLines([
        { productId: "a", qty: 1 },
        { productId: "b", qty: 2 },
        { productId: "a", qty: 2 },
        { productId: "c", qty: 0 },
        { productId: 7, qty: 1 }
      ]),
      [
        { productId: "a", qty: 3 },
        { productId: "b", qty: 2 }
      ],
      "mergeLines sums duplicates and drops junk"
    );
    eq(
      route.linesFromOrder(
        order("O", [
          ["V_BALM", "2"],
          ["V_TEE_L", "1.9"],
          ["V_MB", "0.4"]
        ])
      ),
      [
        { variationId: "V_BALM", qty: 2, name: "Last Three Balm", variationName: "Regular" },
        { variationId: "V_TEE_L", qty: 1, name: "Single Tee", variationName: "Large" }
      ],
      "order lines: decimal quantities floor, under one unit drops"
    );
    eq(
      route.linesFromOrder({
        line_items: [{ uid: "custom", quantity: "1", name: "Custom amount" }]
      }),
      [],
      "a custom amount with no catalog object has nothing to count"
    );
    eq(
      route.claimKeyFor("0f1e2d3c-0000-4000-8000-000000000001"),
      "sq_0f1e2d3c000040008000000000000001",
      "the claim key strips the UUID's hyphens"
    );
    eq(
      route.notificationUrl({ SITE_ORIGIN: "https://example.com/" }),
      "https://example.com/api/square-webhook",
      "the signed URL defaults to the site's /api route"
    );
    eq(
      route.notificationUrl({
        SITE_ORIGIN: SITE,
        SQUARE_WEBHOOK_NOTIFICATION_URL: " https://x.test/hook "
      }),
      "https://x.test/hook",
      "...unless one is configured"
    );
    eq(
      route.squareApiBase({ SQUARE_ENVIRONMENT: "sandbox" }),
      "https://connect.squareupsandbox.com",
      "sandbox base"
    );
    eq(route.squareApiBase({}), "https://connect.squareup.com", "production base");
  }

  /* ------------------------------------------------------------------ 2 */
  console.log("\n2. the signature");
  {
    const body = JSON.stringify(squareEvent("payment.updated", {}));
    const ok = await route.verifySquareSignature(body, sign(body), SIGNATURE_KEY, WEBHOOK_URL);
    eq(ok.type, "payment.updated", "a correct signature returns the parsed event");
    await rejects(
      () => route.verifySquareSignature(body, sign(body, "other-key"), SIGNATURE_KEY, WEBHOOK_URL),
      /mismatch/,
      "the wrong key is refused"
    );
    await rejects(
      () =>
        route.verifySquareSignature(
          body,
          sign(body, SIGNATURE_KEY, "https://elsewhere/hook"),
          SIGNATURE_KEY,
          WEBHOOK_URL
        ),
      /mismatch/,
      "a signature over another URL is refused"
    );
    await rejects(
      () => route.verifySquareSignature(body + " ", sign(body), SIGNATURE_KEY, WEBHOOK_URL),
      /mismatch/,
      "a changed body is refused"
    );
    await rejects(
      () => route.verifySquareSignature(body, null, SIGNATURE_KEY, WEBHOOK_URL),
      /Missing/,
      "no header is refused"
    );
    await rejects(
      () => route.verifySquareSignature(body, "not base64!!", SIGNATURE_KEY, WEBHOOK_URL),
      /Malformed/,
      "a malformed header is refused"
    );
    await rejects(
      () => route.verifySquareSignature(body, sign(body), "", WEBHOOK_URL),
      /not configured/,
      "no key is refused"
    );
    const old = JSON.stringify({
      ...squareEvent("payment.updated", {}),
      created_at: "2020-01-01T00:00:00Z"
    });
    eq(
      (await route.verifySquareSignature(old, sign(old), SIGNATURE_KEY, WEBHOOK_URL)).created_at,
      "2020-01-01T00:00:00Z",
      "an old created_at is NOT refused: Square retries carry the original body"
    );
  }

  /* ------------------------------------------------------------------ 3 */
  console.log("\n3. the route through the Worker");
  {
    const square = makeSquare();
    const ctx = makeCtx();
    const unconfigured = await makeEnv({ SQUARE_WEBHOOK_SIGNATURE_KEY: undefined });
    let res = await post(unconfigured, ctx, squareEvent("payment.updated", {}));
    eq(res.status, 404, "without the signature key the route does not exist");
    const noDb = await makeEnv({ STATE_DB: undefined });
    res = await post(noDb, ctx, squareEvent("payment.updated", {}));
    eq(
      [res.status, res.json && res.json.error],
      [503, "state_unavailable"],
      "without STATE_DB it is a 503"
    );
    const env = await makeEnv();
    const lines = await capture(async () => {
      res = await post(env, ctx, squareEvent("payment.updated", {}), { signature: sign("{}") });
    });
    eq(
      [res.status, res.json],
      [400, { error: "Invalid signature" }],
      "a bad signature is one fixed string"
    );
    assert(
      lines.some((l) => /\[SQUARE\] signature verification failed/.test(l)),
      "...with the real reason in the log only"
    );
    eq(res.cache, "no-store", "no-store like every JSON answer");
    res = await post(env, ctx, squareEvent("payment.updated", {}), { signature: null });
    eq(res.status, 400, "no header is the same 400");
    res = await post(env, ctx, { ...squareEvent("payment.updated", {}), event_id: undefined });
    eq(res.status, 400, "an event without an id is refused too");
    res = await post(env, ctx, squareEvent("customer.created", { customer: {} }));
    eq(
      [res.status, res.json.received, res.json.outcome],
      [200, true, { ignored: "customer.created" }],
      "an unrelated event type is acknowledged and ignored"
    );
    const getReq = new Request("https://yallternative-checkout.workers.dev/square-webhook", {
      method: "GET"
    });
    eq((await worker.fetch(getReq, env, ctx)).status, 405, "GET is not allowed");
    await ctx.settle();
    square.restore();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log("\n4. sales: card, cash, split tender, a comp, a redelivery");
  {
    const square = makeSquare({
      orders: {
        O1: order("O1", [["V_BALM", 2]]),
        O2: order("O2", [["V_TEE_L", 1]]),
        O3: order("O3", [["V_MB", 1]]),
        O4: order("O4", [["V_SET", 1]])
      },
      payments: {
        P1: payment("P1", "O1", 1000),
        P1b: payment("P1b", "O1", 800, { source_type: "CASH" }),
        P2: payment("P2", "O2", 2000, { source_type: "CASH" })
      }
    });
    const ctx = makeCtx();
    const env = await makeEnv();
    const ids = ["last-three-balm", "single-tee", "miracle-balm", "boxable-salve", "boxable-soak"];

    const ev1 = squareEvent("payment.updated", { payment: square.state.payments.P1 });
    let res = await post(env, ctx, ev1);
    await ctx.settle();
    eq(res.status, 200, "a completed card payment is accepted");
    eq(
      res.json.outcome.applied,
      [{ productId: "last-three-balm", qty: 2, deducted: 2, short: 0 }],
      "...and its order's two balms leave the shelf"
    );
    eq((await available(env.STATE_DB, ids))["last-three-balm"], 1, "3 - 2 = 1");
    assert(
      square.calls.some((c) => c.path === "/v2/orders/O1"),
      "the order was read from Square"
    );
    assert(
      square.calls.some((c) => c.path === "/v2/catalog/batch-retrieve"),
      "...and the unknown variation looked up once"
    );
    assert(
      square.calls.every((c) => c.auth === "Bearer EAAA-test-token"),
      "every call carried the access token"
    );

    res = await post(env, ctx, ev1);
    eq(res.json, { received: true, duplicate: true }, "the same event redelivered is a duplicate");
    eq((await available(env.STATE_DB, ids))["last-three-balm"], 1, "...and moves nothing");

    const callsBefore = square.calls.length;
    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: square.state.payments.P1b })
    );
    eq(
      res.json.outcome,
      { orderId: "O1", duplicate: true },
      "the second payment on the same order (split tender) is a duplicate at the ORDER"
    );
    eq((await available(env.STATE_DB, ids))["last-three-balm"], 1, "...and moves nothing either");
    assert(
      !square.calls.slice(callsBefore).some((c) => c.path === "/v2/catalog/batch-retrieve"),
      "a variation already mapped is not looked up again"
    );

    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", {
        payment: { ...square.state.payments.P2, status: "PENDING" }
      })
    );
    eq(res.json.outcome, { skipped: "payment PENDING" }, "a pending payment is not a sale yet");
    eq((await available(env.STATE_DB, ids))["single-tee"], 1, "...so nothing moves");

    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: square.state.payments.P2 })
    );
    eq(
      res.json.outcome.applied,
      [{ productId: "single-tee", qty: 1, deducted: 1, short: 0 }],
      "a CASH payment counts exactly like a card"
    );
    eq((await available(env.STATE_DB, ids))["single-tee"], 0, "...through the id/size SKU");
    eq(res.json.outcome.soldOut, ["single-tee"], "...and it took the last one");

    res = await post(
      env,
      ctx,
      squareEvent("order.updated", {
        order_updated: { order_id: "O3", state: "COMPLETED", location_id: LOCATION }
      })
    );
    eq(
      res.json.outcome.applied,
      [{ productId: "miracle-balm", qty: 1, deducted: 1, short: 0 }],
      "a completed order with NO payment (a comp) counts through order.updated"
    );
    eq((await available(env.STATE_DB, ids))["miracle-balm"], 3, "...via the squareSkus alias");
    res = await post(
      env,
      ctx,
      squareEvent("order.updated", { order_updated: { order_id: "O4", state: "OPEN" } })
    );
    eq(res.json.outcome, { skipped: "order OPEN" }, "an open ticket is not a sale");

    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("P4", "O4", 2000) })
    );
    eq(
      res.json.outcome.applied,
      [
        { productId: "boxable-salve", qty: 1, deducted: 1, short: 0 },
        { productId: "boxable-soak", qty: 1, deducted: 1, short: 0 }
      ],
      "a bundle sold at the register counts each member down"
    );
    const after = await available(env.STATE_DB, ids);
    eq([after["boxable-salve"], after["boxable-soak"]], [1, 8], "2 -> 1 and 9 -> 8");

    const sale = await sync.getSquareSale(env.STATE_DB, "O1");
    eq(
      [sale.state, JSON.parse(sale.lines_json), sale.location_id],
      ["applied", [{ productId: "last-three-balm", qty: 2 }], LOCATION],
      "the sale row records what was taken and where"
    );
    const missing = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("P9", "O-gone", 100) })
    );
    eq(missing.status, 500, "an order Square no longer returns is a 500 so Square retries");
    eq(await sync.getSquareSale(env.STATE_DB, "O-gone"), null, "...and nothing was claimed for it");
    const { getEvent } = await import("../workers/state/webhook-events.js");
    eq(
      await getEvent(env.STATE_DB, route.claimKeyFor(ev1.event_id)).then((r) => r && r.status),
      "done",
      "a processed event is marked done"
    );
    await ctx.settle();
    square.restore();
  }

  /* ------------------------------------------------------------------ 5 */
  console.log("\n5. what the owner is told");
  {
    const square = makeSquare({
      orders: {
        O5: order("O5", [
          ["V_CANDLE", 1],
          ["V_BALM", 3]
        ]),
        O6: order("O6", [["V_SOAK10", 15]]),
        O7: order("O7", [["V_SPRAY", 2]])
      }
    });
    const ctx = makeCtx();
    const env = await makeEnv();
    let res;
    let lines = await capture(async () => {
      res = await post(
        env,
        ctx,
        squareEvent("payment.updated", { payment: payment("P5", "O5", 3000) })
      );
      await ctx.settle();
    });
    eq(
      res.json.outcome.applied,
      [{ productId: "last-three-balm", qty: 3, deducted: 3, short: 0 }],
      "the mapped line is deducted"
    );
    eq(
      res.json.outcome.unmapped.map((u) => [u.variationId, u.sku, u.qty]),
      [["V_CANDLE", "candle-01", 1]],
      "the unmapped line is reported"
    );
    assert(
      lines.some((l) => /owner-alert square-unmapped:V_CANDLE/.test(l) && /Porch Candle/.test(l)),
      "...and the owner is emailed which item, by name"
    );
    assert(
      lines.some((l) =>
        /\[INVENTORY_SOLD_OUT\] sold out by order square order O5: last-three-balm/.test(l)
      ),
      "the sell-out is announced like an online one"
    );
    const cat = await sync.catalogRows(env.STATE_DB, ["V_CANDLE"]);
    eq(
      [cat.get("V_CANDLE").productId, cat.get("V_CANDLE").itemName],
      [null, "Porch Candle"],
      "the unmapped variation is recorded so it is not fetched again"
    );

    lines = await capture(async () => {
      res = await post(
        env,
        ctx,
        squareEvent("payment.updated", { payment: payment("P6", "O6", 15000) })
      );
      await ctx.settle();
    });
    eq(
      res.json.outcome.applied,
      [{ productId: "lavender-soak", qty: 15, deducted: 10, short: 5 }],
      "selling more than the site had takes what there is and reports the rest"
    );
    eq(
      (await available(env.STATE_DB, ["lavender-soak"]))["lavender-soak"],
      0,
      "...the shelf stops at zero"
    );
    assert(
      lines.some((l) => /owner-alert square-short:lavender-soak/.test(l) && /5 more/.test(l)),
      "...and the owner hears by how much"
    );

    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("P7", "O7", 2400) })
    );
    eq(
      [res.json.outcome.applied, res.json.outcome.untracked],
      [[], ["bug-spray"]],
      "a product with no Stock count is mapped but not counted"
    );

    // Held units belong to the online shopper first.
    const inv = await import("../workers/state/inventory.js");
    await inv.reserveInventory(env.STATE_DB, "cs_hold", [{ productId: "miracle-balm", qty: 3 }]);
    const out = await inv.deductOnHand(env.STATE_DB, [{ productId: "miracle-balm", qty: 3 }]);
    eq(
      out.applied,
      [{ productId: "miracle-balm", qty: 3, deducted: 1, short: 2 }],
      "a register sale cannot take units an open checkout holds"
    );
    const rows = await inv.readAvailability(env.STATE_DB, ["miracle-balm"]);
    eq(
      [rows.get("miracle-balm").onHand, rows.get("miracle-balm").reserved],
      [3, 3],
      "...on_hand stops at reserved"
    );
    square.restore();
  }

  /* ------------------------------------------------------------------ 6 */
  console.log("\n6. refunds: judged on the ORDER, never on one payment");
  {
    // O1: two balms for $18, paid $10 card (P1) + $8 cash (P1b) -- a split tender.
    const square = makeSquare({
      orders: {
        O1: order("O1", [["V_BALM", 2]], {
          total_money: { amount: 1800, currency: "USD" },
          tenders: [
            { id: "T1", payment_id: "P1", amount_money: { amount: 1000, currency: "USD" } },
            { id: "T1b", payment_id: "P1b", amount_money: { amount: 800, currency: "USD" } }
          ]
        }),
        O2: order("O2", [["V_TEE_L", 1]], { total_money: { amount: 2000, currency: "USD" } })
      },
      payments: {
        P1: payment("P1", "O1", 1000),
        P1b: payment("P1b", "O1", 800, { source_type: "CASH" }),
        P2: payment("P2", "O2", 2000)
      }
    });
    const ctx = makeCtx();
    const env = await makeEnv();
    await post(env, ctx, squareEvent("payment.updated", { payment: square.state.payments.P1 }));
    await post(env, ctx, squareEvent("payment.updated", { payment: square.state.payments.P2 }));
    eq(
      (await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      1,
      "sold two of three balms"
    );

    const refund = (id, paymentId, orderId, amount, status = "COMPLETED") => ({
      id,
      payment_id: paymentId,
      order_id: orderId,
      status,
      amount_money: { amount, currency: "USD" }
    });
    const orderRefund = (id, amount, status = "COMPLETED") => ({
      id,
      status,
      amount_money: { amount, currency: "USD" }
    });

    // The card half is refunded IN FULL. That is a partial refund of the SALE.
    square.state.orders.O1.refunds = [orderRefund("R1", 1000)];
    let res = await post(
      env,
      ctx,
      squareEvent("refund.updated", { refund: refund("R1", "P1", "O1", 1000) })
    );
    eq(
      res.json.outcome,
      { orderId: "O1", partialRefund: true, returned: [] },
      "refunding one tender of a split sale in full is NOT a full refund of the sale"
    );
    eq(
      (await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      1,
      "...and moves nothing"
    );

    res = await post(
      env,
      ctx,
      squareEvent("refund.updated", { refund: refund("R2", "P1b", "O1", 800, "PENDING") })
    );
    eq(res.json.outcome, { skipped: "refund PENDING" }, "a pending refund waits");

    // The cash half comes back too -- Square has not listed it on the order
    // yet (the webhook can beat the order), so the triggering refund counts.
    const ev = squareEvent("refund.updated", { refund: refund("R2", "P1b", "O1", 800) });
    res = await post(env, ctx, ev);
    eq(
      res.json.outcome.returned,
      [{ productId: "last-three-balm", qty: 2 }],
      "both tenders refunded is a full refund of the order: the units come back"
    );
    eq((await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"], 3, "1 + 2 = 3");
    eq(
      (await sync.getSquareSale(env.STATE_DB, "O1")).state,
      "restocked",
      "the sale row is restocked"
    );

    res = await post(env, ctx, ev);
    eq(
      res.json,
      { received: true, duplicate: true },
      "the redelivered refund event is a duplicate"
    );
    square.state.orders.O1.refunds.push(orderRefund("R2", 800), orderRefund("R3", 1));
    res = await post(
      env,
      ctx,
      squareEvent("refund.updated", { refund: refund("R3", "P1", "O1", 1) })
    );
    eq(
      res.json.outcome,
      { orderId: "O1", alreadyRestocked: true, returned: [] },
      "a further refund on a restocked order returns nothing twice"
    );
    eq((await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"], 3, "...still 3");

    // An itemised return rung up at the register is its OWN order that points
    // at the sale; the refund event carries the return order's id.
    square.state.orders.RET2 = {
      id: "RET2",
      location_id: LOCATION,
      state: "COMPLETED",
      total_money: { amount: 0, currency: "USD" },
      returns: [{ uid: "ret", source_order_id: "O2", return_line_items: [] }],
      refunds: [orderRefund("R9", 2000)]
    };
    eq(
      (await available(env.STATE_DB, ["single-tee"]))["single-tee"],
      0,
      "the tee sold out at the register"
    );
    res = await post(
      env,
      ctx,
      squareEvent("refund.updated", { refund: refund("R9", "P2", "RET2", 2000) })
    );
    eq(
      res.json.outcome,
      { orderId: "O2", returned: [{ productId: "single-tee", qty: 1 }], untracked: [] },
      "a return order is followed to the sale it returns, and that sale is restocked"
    );
    eq((await available(env.STATE_DB, ["single-tee"]))["single-tee"], 1, "...the tee is back");

    // A refund for a sale this ledger never counted moves nothing.
    square.state.orders.O0 = order("O0", [["V_BALM", 1]], {
      refunds: [orderRefund("R0", 1000)]
    });
    res = await post(
      env,
      ctx,
      squareEvent("refund.updated", { refund: refund("R0", "P0", "O0", 1000) })
    );
    eq(
      res.json.outcome,
      { orderId: "O0", alreadyRestocked: true, returned: [] },
      "a refund for a sale from before the integration moves nothing"
    );

    // The rule itself.
    const sale = (total, refunds = [], tenders) => ({
      id: "S",
      total_money: total === null ? undefined : { amount: total, currency: "USD" },
      tenders,
      refunds
    });
    eq(
      route.isOrderFullyRefunded(sale(100, [orderRefund("a", 100)])),
      true,
      "refunds on the order equal to its total: full"
    );
    eq(route.isOrderFullyRefunded(sale(100, [orderRefund("a", 60)])), false, "...short of it: not");
    eq(
      route.isOrderFullyRefunded(sale(100, [orderRefund("a", 60)]), [], refund("b", "P", "S", 40)),
      true,
      "the triggering refund is counted when the order does not list it yet"
    );
    eq(
      route.isOrderFullyRefunded(sale(100, [orderRefund("a", 60)]), [], refund("a", "P", "S", 60)),
      false,
      "...but not twice when it does"
    );
    eq(
      route.isOrderFullyRefunded(
        sale(100, [orderRefund("a", 60, "PENDING"), orderRefund("b", 40)])
      ),
      false,
      "a pending refund on the order does not count"
    );
    eq(
      route.isOrderFullyRefunded(sale(100, []), [{ refunds: [orderRefund("z", 100)] }]),
      true,
      "refunds recorded on the return order count toward the sale"
    );
    eq(
      route.isOrderFullyRefunded(
        sale(null, [orderRefund("a", 50)], [{ amount_money: { amount: 50 } }])
      ),
      true,
      "with no total_money the tenders are summed"
    );
    eq(
      route.isOrderFullyRefunded(sale(0, [orderRefund("a", 0)])),
      false,
      "a $0 comp is never 'refunded'"
    );
    await ctx.settle();
    square.restore();
  }

  /* ------------------------------------------------------------------ 7 */
  console.log("\n7. counts pushed to Square");
  {
    const square = makeSquare({
      orders: { O1: order("O1", [["V_SOAK10", 4]]) },
      payments: { P1: payment("P1", "O1", 4000) }
    });
    const ctx = makeCtx();
    const env = await makeEnv();
    // Both soak variations are in the register's catalogue and map to one product.
    await sync.upsertCatalogRows(env.STATE_DB, [
      {
        variationId: "V_SOAK10",
        sku: "lavender-soak/10-oz",
        itemName: "Lavender Soak",
        variationName: "10 oz",
        productId: "lavender-soak"
      },
      {
        variationId: "V_SOAK24",
        sku: "lavender-soak: 24 oz",
        itemName: "Lavender Soak",
        variationName: "24 oz",
        productId: "lavender-soak"
      },
      {
        variationId: "V_SPRAY",
        sku: "bug-spray",
        itemName: "Bug Spray",
        variationName: "Regular",
        productId: "bug-spray"
      }
    ]);
    await post(env, ctx, squareEvent("payment.updated", { payment: square.state.payments.P1 }));
    await ctx.settle();
    const pushes = square.pushes();
    eq(pushes.length, 1, "a register sale pushes the new count back to Square");
    const changes = pushes[0].body.changes;
    eq(
      changes.map((c) => [
        c.type,
        c.physical_count.catalog_object_id,
        c.physical_count.quantity,
        c.physical_count.location_id,
        c.physical_count.state
      ]),
      [
        ["PHYSICAL_COUNT", "V_SOAK10", "6", LOCATION, "IN_STOCK"],
        ["PHYSICAL_COUNT", "V_SOAK24", "6", LOCATION, "IN_STOCK"]
      ],
      "...as a PHYSICAL_COUNT per variation, the same count for both sizes, quantity as a string"
    );
    assert(
      typeof pushes[0].body.idempotency_key === "string" &&
        pushes[0].body.idempotency_key.length >= 16,
      "...with an idempotency key"
    );
    assert(
      /^\d{4}-\d{2}-\d{2}T/.test(changes[0].physical_count.occurred_at),
      "...and an occurred_at timestamp"
    );
    assert(
      !changes.some((c) => c.physical_count.catalog_object_id === "V_SPRAY"),
      "a product the site does not count is left to the register"
    );

    let out = await route.pushCountsForProducts(env, null, ["lavender-soak"]);
    eq(out, { pushed: 0, skipped: "unchanged" }, "pushing again with nothing moved writes nothing");
    eq(square.pushes().length, 1, "...no second call");

    // An ONLINE sale moves the shelf: the hooks in routes/inventory.js tell the register.
    const inv = await import("../workers/state/inventory.js");
    const hooks = await import("../workers/routes/inventory.js");
    await inv.reserveInventory(env.STATE_DB, "cs_online", [{ productId: "lavender-soak", qty: 1 }]);
    out = await route.pushCountsForProducts(env, null, ["lavender-soak"]);
    eq(out.pushed, 2, "a hold lowers what the register may sell");
    eq(square.pushes()[1].body.changes[0].physical_count.quantity, "5", "...6 held one is 5");
    await hooks.commitInventoryForSession({ id: "cs_online" }, env, ctx);
    await ctx.settle();
    eq(
      square.pushes().length,
      2,
      "a commit does not change `available` (held became sold), so nothing is pushed"
    );
    await inv.reserveInventory(env.STATE_DB, "cs_abandon", [
      { productId: "lavender-soak", qty: 2 }
    ]);
    await route.pushCountsForProducts(env, null, ["lavender-soak"]);
    eq(square.pushes()[2].body.changes[0].physical_count.quantity, "3", "5 - 2 held = 3");
    await hooks.releaseInventoryForSession({ id: "cs_abandon" }, env, "session_expired", ctx);
    await ctx.settle();
    eq(
      square.pushes()[3].body.changes[0].physical_count.quantity,
      "5",
      "an abandoned checkout hands the units back to the register"
    );

    const noLocation = await makeEnv({ SQUARE_LOCATION_ID: undefined, STATE_DB: env.STATE_DB });
    eq(
      await route.pushCountsForProducts(noLocation, null, ["lavender-soak"]),
      { pushed: 0, skipped: "not-configured" },
      "no location, no push"
    );
    const noToken = await makeEnv({ SQUARE_ACCESS_TOKEN: undefined, STATE_DB: env.STATE_DB });
    eq(
      await route.pushCountsForProducts(noToken, null, ["lavender-soak"]),
      { pushed: 0, skipped: "not-configured" },
      "no token, no push"
    );
    hooks.tellRegister(noToken, ctx, ["lavender-soak"]);
    await ctx.settle();
    eq(square.pushes().length, 4, "tellRegister is a no-op without a token");

    square.state.pushDown = true;
    await inv.reserveInventory(env.STATE_DB, "cs_x", [{ productId: "lavender-soak", qty: 1 }]);
    const lines = await capture(async () => {
      out = await route.pushCountsForProducts(env, null, ["lavender-soak"]);
    });
    eq(out, { pushed: 0, skipped: "threw" }, "a Square outage never throws out of the push");
    assert(
      lines.some((l) => /owner-alert square-push/.test(l)),
      "...it is one owner alert"
    );
    eq(
      (await available(env.STATE_DB, ["lavender-soak"]))["lavender-soak"],
      4,
      "...and the shelf is still right"
    );
    square.restore();
  }

  /* ------------------------------------------------------------------ 8 */
  console.log("\n8. the hourly reconcile, the sweep, the kill switch");
  {
    const square = makeSquare();
    const ctx = makeCtx();
    const env = await makeEnv();
    let out = await route.runSquareReconcile(env, ctx);
    eq(
      out.refreshed,
      Object.keys(squareVariations).length,
      "the reconcile reads the register's whole catalogue"
    );
    const rows = await sync.mappedRows(env.STATE_DB);
    eq(
      rows.map((r) => [r.variationId, r.productId]),
      [
        ["V_SPRAY", "bug-spray"],
        ["V_BALM", "last-three-balm"],
        ["V_SOAK10", "lavender-soak"],
        ["V_SOAK24", "lavender-soak"],
        ["V_MB", "miracle-balm"],
        ["V_TEE_L", "single-tee"],
        ["V_SET", "starter-set"]
      ],
      "...maps every SKU the rule recognises"
    );
    eq(
      (await sync.catalogRows(env.STATE_DB, ["V_CANDLE"])).get("V_CANDLE").productId,
      null,
      "...and records the one it does not"
    );
    eq(
      out.pushed,
      5,
      "then pushes every tracked, mapped product once (bundles and untracked skipped)"
    );
    const pushed = square
      .pushes()[0]
      .body.changes.map((c) => [c.physical_count.catalog_object_id, c.physical_count.quantity]);
    eq(
      pushed,
      [
        ["V_BALM", "3"],
        ["V_SOAK10", "10"],
        ["V_SOAK24", "10"],
        ["V_MB", "4"],
        ["V_TEE_L", "1"]
      ],
      "...with the seeded counts"
    );
    out = await route.runSquareReconcile(env, ctx);
    eq(
      [out.refreshed, out.pushed, out.skipped],
      [8, 0, "unchanged"],
      "the next hour re-reads the catalogue and writes nothing"
    );

    // A SKU fixed in Square maps within the hour, and the row's push memo resets.
    squareVariations.V_CANDLE.sku = "bug-spray";
    out = await route.runSquareReconcile(env, ctx);
    eq(
      (await sync.catalogRows(env.STATE_DB, ["V_CANDLE"])).get("V_CANDLE").productId,
      "bug-spray",
      "a SKU corrected in the Square Dashboard maps on the next tick"
    );
    squareVariations.V_CANDLE.sku = "candle-01";
    await sync.upsertCatalogRows(env.STATE_DB, [
      { variationId: "V_BALM", sku: "single-tee", productId: "single-tee" }
    ]);
    eq(
      (await sync.catalogRows(env.STATE_DB, ["V_BALM"])).get("V_BALM").lastPushedCount,
      null,
      "remapping a variation to another product forgets what was pushed for the old one"
    );

    // The kill switch.
    square.state.enabled = false;
    const res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("P1", "O1", 100) })
    );
    eq(
      res.json,
      { received: true, disabled: true },
      "with Sync stock with Square off, events are acknowledged and ignored"
    );
    eq(
      await route.runSquareReconcile(env, ctx),
      { skipped: "disabled" },
      "...and the reconcile does nothing"
    );
    eq(
      await route.pushCountsForProducts(env, null, ["last-three-balm"]),
      { pushed: 0, skipped: "disabled" },
      "...and nothing is pushed"
    );
    square.state.enabled = true;
    square.state.siteDown = true;
    eq(
      await route.squareSyncEnabled(env, ctx),
      true,
      "an unreachable content.json fails OPEN to enabled"
    );
    square.state.siteDown = false;

    eq(
      await route.runSquareReconcile({ ...env, SQUARE_ACCESS_TOKEN: undefined }, ctx),
      { skipped: "not-configured" },
      "no token, nothing to reconcile"
    );

    // The sweep.
    const DAY = 24 * 60 * 60 * 1000;
    await sync.claimSquareSale(env.STATE_DB, "old", [{ productId: "x", qty: 1 }], null, 1000);
    await sync.claimSquareSale(env.STATE_DB, "new", [{ productId: "x", qty: 1 }], null, 100 * DAY);
    eq(
      await sync.sweepSquareSales(env.STATE_DB, 90, 100 * DAY),
      1,
      "the sweep drops sales older than 90 days"
    );
    eq(await sync.getSquareSale(env.STATE_DB, "old"), null, "...the old one");
    assert(await sync.getSquareSale(env.STATE_DB, "new"), "...not the recent one");
    await rejects(
      () => sync.sweepSquareSales(env.STATE_DB, 0),
      /olderThanDays/,
      "a nonsense retention is refused"
    );
    eq(
      await sync.claimSquareSale(env.STATE_DB, "new", [], null),
      { claimed: false, state: "pending" },
      "a second claim on a pending order reports it pending, for the caller to resume"
    );
    eq(
      await sync.restockSquareSale(env.STATE_DB, "never"),
      null,
      "restocking an unknown order is null"
    );
    eq(await sync.applySquareSale(env.STATE_DB, "never"), null, "...and so is applying one");

    // The cron wiring in checkout.js.
    const source = fs.readFileSync(path.join(ROOT, "workers", "checkout.js"), "utf8");
    assert(
      /"square sync"[\s\S]{0,200}runSquareReconcile/.test(source),
      "checkout.js's cron runs the reconcile"
    );
    assert(/"square-sales sweep"[\s\S]{0,200}sweepSquareSales/.test(source), "...and the sweep");
    assert(/"\/square-webhook": handleSquareWebhook/.test(source), "...and routes /square-webhook");
    await ctx.settle();
    square.restore();
  }

  /* ------------------------------------------------------------------ 9 */
  console.log("\n9. schema.sql, the CMS and the docs keep up");
  {
    const migrations = await import("../workers/state/migrations.js");
    assert(migrations.SCHEMA_VERSION >= 10, "SCHEMA_VERSION was bumped for the register's tables");
    const schema = fs.readFileSync(path.join(ROOT, "workers", "schema.sql"), "utf8");
    for (const table of ["square_sales", "square_catalog"]) {
      assert(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(schema),
        `schema.sql documents ${table}`
      );
      assert(
        migrations.SCHEMA_STATEMENTS.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
        `...and migrations.js creates it`
      );
    }
    const cms = fs.readFileSync(path.join(ROOT, "admin", "config.yml"), "utf8");
    assert(/name: squareSkus/.test(cms), "the CMS has the Square SKUs field on a product");
    assert(/name: enableSquareSync/.test(cms), "...and the Sync stock with Square switch");
    const content = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets", "data", "content.json"), "utf8")
    );
    eq(content.site.enableSquareSync, true, "content.json carries the switch, on");
    const toml = fs.readFileSync(path.join(ROOT, "workers", "wrangler.toml"), "utf8");
    for (const name of [
      "SQUARE_WEBHOOK_SIGNATURE_KEY",
      "SQUARE_ACCESS_TOKEN",
      "SQUARE_LOCATION_ID"
    ]) {
      assert(toml.includes(name), `wrangler.toml explains ${name}`);
    }
    assert(
      !/^\s*SQUARE_ACCESS_TOKEN\s*=/m.test(toml) &&
        !/^\s*SQUARE_WEBHOOK_SIGNATURE_KEY\s*=/m.test(toml),
      "...and neither secret is a [vars] entry"
    );
    const readme = fs.readFileSync(path.join(ROOT, "workers", "README.md"), "utf8");
    for (const needle of [
      "/api/square-webhook",
      "SQUARE_WEBHOOK_SIGNATURE_KEY",
      "SQUARE_ACCESS_TOKEN",
      "payment.updated",
      "order.updated",
      "refund.updated"
    ]) {
      assert(readme.includes(needle), `workers/README.md mentions ${needle}`);
    }
    const stateLayer = fs.readFileSync(path.join(ROOT, "docs", "STATE-LAYER.md"), "utf8");
    assert(stateLayer.includes("/api/square-webhook"), "docs/STATE-LAYER.md documents the route");
    const dev = fs.readFileSync(path.join(ROOT, "docs", "DEVELOPMENT.md"), "utf8");
    assert(dev.includes("/api/square-webhook"), "docs/DEVELOPMENT.md lists the endpoint");
    const setup = fs.readFileSync(path.join(ROOT, "docs", "SETUP-GUIDE.md"), "utf8");
    assert(
      /Square/.test(setup) && /SKU/.test(setup),
      "docs/SETUP-GUIDE.md walks the owner through Square and the SKU rule"
    );
    const editing = fs.readFileSync(path.join(ROOT, "docs", "EDITING-GUIDE.md"), "utf8");
    assert(
      /Square/.test(editing) && /SKU/.test(editing),
      "docs/EDITING-GUIDE.md explains the SKU rule"
    );
    const rootReadme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert(/Square/.test(rootReadme), "README.md's launch checklist has the register");
  }

  /* ----------------------------------------------------------------- 10 */
  console.log("\n10. red team: crashes, races, drift, junk names, stale catalogues");
  {
    const square = makeSquare({
      orders: {
        OX: order("OX", [["V_BALM", 1]]),
        OJ: order("OJ", [["V_CANDLE", 1]]),
        OC: order("OC", [["V_BALM", 1]])
      }
    });
    square.state.orders.OC.line_items[0].name = "Bad\r\nName with   spaces";
    const ctx = makeCtx();
    const env = await makeEnv();
    const inv = await import("../workers/state/inventory.js");

    // 10a. A claim an earlier attempt left `pending` (the isolate died between
    // claim and deduction) is resumed by the next delivery, not refused.
    eq(
      await sync.claimSquareSale(
        env.STATE_DB,
        "OX",
        [{ productId: "last-three-balm", qty: 1 }],
        LOCATION
      ),
      { claimed: true, state: "pending" },
      "a fresh claim is pending"
    );
    let res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("PX", "OX", 1000) })
    );
    eq(
      [res.json.outcome.resumed, res.json.outcome.applied],
      [true, [{ productId: "last-three-balm", qty: 1, deducted: 1, short: 0 }]],
      "a pending claim is resumed and applied once"
    );
    eq((await sync.getSquareSale(env.STATE_DB, "OX")).state, "applied", "...and is now applied");
    eq((await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"], 2, "3 - 1 = 2");

    // 10b. Two deliveries racing on one pending claim. The emulator runs one
    // SQLite connection, so the race is staged rather than parallel: a
    // competing delivery lands BETWEEN this one's read of the pending row and
    // its guarded batch -- the exact interleaving the guard exists for.
    const interleave = (db, competitor) => ({
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        for (const sql of competitor) db._raw.prepare(sql).run();
        return db.batch(statements);
      }
    });
    await sync.claimSquareSale(
      env.STATE_DB,
      "OY",
      [{ productId: "last-three-balm", qty: 1 }],
      LOCATION
    );
    const lost = await sync.applySquareSale(
      interleave(env.STATE_DB, [
        "UPDATE inventory SET on_hand = on_hand - 1 WHERE product_id = 'last-three-balm'",
        "UPDATE square_sales SET state = 'applied' WHERE order_id = 'OY' AND state = 'pending'"
      ]),
      "OY"
    );
    eq(lost.raced, true, "the delivery that read `pending` but lost the write knows it lost");
    eq(lost.applied, [], "...and reports nothing -- so no false shortfall alert");
    eq(
      (await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      1,
      "...and the shelf moved exactly once, by the winner"
    );
    eq(
      await sync.applySquareSale(env.STATE_DB, "OY"),
      null,
      "a later delivery finds nothing pending"
    );

    // 10c. The same race on the restock.
    const lostRestock = await sync.restockSquareSale(
      interleave(env.STATE_DB, [
        "UPDATE inventory SET on_hand = on_hand + 1 WHERE product_id = 'last-three-balm'",
        "UPDATE square_sales SET state = 'restocked' WHERE order_id = 'OY' AND state = 'applied'"
      ]),
      "OY"
    );
    eq(lostRestock.raced, true, "a restock that lost the write knows it lost");
    eq(lostRestock.returned, [], "...and returns nothing");
    eq(
      (await available(env.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      2,
      "...and the unit came back exactly once"
    );
    eq(await sync.restockSquareSale(env.STATE_DB, "OY"), null, "nothing left to restock");

    // 10d. A sale of only unmapped items still reaches `applied`, so it is not
    // re-resolved on every retry and a refund of it has a row to find.
    res = await post(
      env,
      ctx,
      squareEvent("payment.updated", { payment: payment("PJ", "OJ", 1000) })
    );
    eq(res.json.outcome.applied, [], "nothing to deduct");
    eq(
      (await sync.getSquareSale(env.STATE_DB, "OJ")).state,
      "applied",
      "...but the claim still advanced"
    );

    // 10e. Item names from Square are data, not header material.
    const lines = await capture(async () => {
      await sync.upsertCatalogRows(env.STATE_DB, [
        { variationId: "V_BALM", sku: "nope", itemName: "x", variationName: "x", productId: null }
      ]);
      res = await post(
        env,
        ctx,
        squareEvent("payment.updated", { payment: payment("PC", "OC", 1000) })
      );
    });
    eq(
      res.json.outcome.unmapped.map((u) => u.name),
      ["Bad Name with spaces -- Regular"],
      "control characters and runs of whitespace are stripped from the name"
    );
    assert(
      lines.some((l) => /square-unmapped:V_BALM/.test(l) && /Bad Name with spaces/.test(l)),
      "...and the alert carries the clean name"
    );
    assert(
      !lines.some((l) => /square-unmapped:V_BALM/.test(l) && /[\r]/.test(l)),
      "...with no carriage return anywhere in it"
    );
    await ctx.settle();

    // 10f. The register drifted (a webhook failed for a day; a number typed
    // into the Square Dashboard): the hourly tick reads Square's counts and
    // rewrites the ones that disagree, even though the ledger has not moved.
    let out = await route.runSquareReconcile(env, ctx);
    assert(out.pushed >= 1, "the first tick pushes the mapped counts");
    out = await route.runSquareReconcile(env, ctx);
    eq(out.skipped, "unchanged", "the next tick, with Square agreeing, writes nothing");
    square.state.squareCounts = { V_SOAK10: 7 }; // the ledger says 10
    out = await route.runSquareReconcile(env, ctx);
    eq(out.pushed, 1, "a Square count that disagrees with the ledger is rewritten");
    const last = square.pushes()[square.pushes().length - 1].body.changes;
    eq(
      last.map((c) => [c.physical_count.catalog_object_id, c.physical_count.quantity]),
      [["V_SOAK10", "10"]],
      "...to the ledger's number, and only that variation"
    );
    square.state.squareCounts = {};

    // 10g. A variation deleted from Square is unmapped after a complete listing,
    // so it cannot poison the next push batch.
    square.state.variationIds = Object.keys(squareVariations).filter((id) => id !== "V_MB");
    out = await route.runSquareReconcile(env, ctx);
    eq(out.unmapped, 1, "one variation the listing no longer has is unmapped");
    const gone = (await sync.catalogRows(env.STATE_DB, ["V_MB"])).get("V_MB");
    eq(
      [gone.productId, gone.lastPushedCount],
      [null, null],
      "...its mapping and push memo are cleared"
    );
    assert(
      !(await sync.mappedRows(env.STATE_DB)).some((r) => r.variationId === "V_MB"),
      "...and it is no longer pushed"
    );
    square.state.variationIds = Object.keys(squareVariations);

    // 10h. A stale catalogue cannot reseed a row backwards. The site says the
    // balm has 3 (served at T0); the owner corrects it to 5 (served at T1);
    // an isolate still holding the T0 copy must not put it back to 3 -- from
    // either seeder: the Square push, or GET /api/inventory.
    const fresh = await makeEnv();
    const T0 = "2026-09-10T01:00:00Z";
    const T1 = "2026-09-10T02:00:00Z";
    square.state.balmStock = 3;
    square.state.siteDate = T0;
    await sync.upsertCatalogRows(fresh.STATE_DB, [
      {
        variationId: "V_BALM",
        sku: "last-three-balm",
        itemName: "Balm",
        variationName: "R",
        productId: "last-three-balm"
      }
    ]);
    await route.pushCountsForProducts(fresh, null, ["last-three-balm"]);
    eq(
      (await available(fresh.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      3,
      "seeded at 3 from the T0 catalogue"
    );
    square.state.balmStock = 5;
    square.state.siteDate = T1;
    inv.resetInventoryMemo();
    await route.pushCountsForProducts(fresh, null, ["last-three-balm"]);
    eq(
      (await available(fresh.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      5,
      "the owner's correction (T1) reseeds to 5"
    );
    square.state.balmStock = 3;
    square.state.siteDate = T0;
    inv.resetInventoryMemo();
    await route.pushCountsForProducts(fresh, null, ["last-three-balm"]);
    eq(
      (await available(fresh.STATE_DB, ["last-three-balm"]))["last-three-balm"],
      5,
      "a stale T0 copy seen by the Square push does NOT reseed back to 3"
    );
    inv.resetInventoryMemo();
    const getReq = new Request("https://yallternative-checkout.workers.dev/inventory", {
      method: "GET"
    });
    const snap = await (await worker.fetch(getReq, fresh, ctx)).json();
    eq(
      snap.products["last-three-balm"].available,
      5,
      "...nor does GET /api/inventory reading the same stale copy"
    );
    square.state.balmStock = null;
    square.state.siteDate = null;
    await ctx.settle();
    square.restore();
  }

  console.log(`\nworker-square.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
