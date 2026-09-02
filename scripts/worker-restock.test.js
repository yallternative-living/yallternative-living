/**
 * @fileoverview Unit tests for the back-in-stock automation:
 *   - workers/state/restock-signups.js  (D1: signups, de-duplication, pending
 *                                        reads, the notified flag)
 *   - workers/routes/restock.js         (POST /api/restock, runRestockAlerts,
 *                                        runLowStockCheck, the templates)
 *
 * Same harness as scripts/worker-retention.test.js: no network, no wrangler.
 * D1 is emulated on `node:sqlite` (scripts/lib/d1-emulator.js) and only Resend
 * and the site's own JSON are mocked, so the route is driven through the REAL
 * entrypoint (workers/checkout.js's default export) rather than by calling the
 * handler directly -- the router wiring is part of what is under test.
 *
 * The cron jobs are called on the module they live in, with an explicit `now`,
 * because the `scheduled` handler that calls them is covered by
 * worker-retention.test.js and re-driving the whole tick here would test the
 * other agents' jobs, not this one.
 *
 * Run: node scripts/worker-restock.test.js
 */

const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

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
const SIGNING_SECRET = "restock-suite-signing-secret";

/**
 * Shaped exactly like products.json, and deliberately covering every
 * availability spelling the real catalogue uses:
 *   sleep-salve      -- no `stock` key at all (made to order: always buyable)
 *   frankincense-salve -- stock: null (the CMS writes this; NOT zero)
 *   tank-top         -- stock: 2   (buyable, and low)
 *   last-three-balm  -- stock: 3   (buyable, and exactly at the threshold)
 *   sold-out-soak    -- stock: 0   (not buyable, and low)
 *   retired-tee      -- inStock: false with units on hand
 *   sugar-scrub      -- comingSoon (never buyable, never "low")
 */
const mockCatalog = {
  products: [
    { id: "sleep-salve", name: "Sleep Salve", category: "salves", price: 18 },
    { id: "frankincense-salve", name: "Frankincense Salve", category: "salves", stock: null },
    { id: "tank-top", name: "Y'all Tank Top", category: "apparel", stock: 2, inStock: true },
    { id: "last-three-balm", name: "Last Three Balm", category: "salves", stock: 3 },
    { id: "sold-out-soak", name: "Sold Out Soak", category: "soaks", stock: 0 },
    { id: "retired-tee", name: "Retired Tee", category: "apparel", stock: 5, inStock: false },
    { id: "sugar-scrub", name: "Sugar Scrub", category: "body", stock: 1, comingSoon: true }
  ],
  bundles: [],
  shop: { freeShippingThreshold: 40 }
};

const INTRO = "Good news: the thing you asked us to watch is back on the shelf.";

const mockContent = {
  site: {
    enableRestockAlerts: true,
    enableLowStockAlerts: true,
    automations: { lowStockThreshold: 3, restockEmailIntro: INTRO }
  }
};

/** 2026-09-02 13:00 UTC = 09:00 America/New_York (EDT). */
const NINE_AM_NY = Date.parse("2026-09-02T13:00:00Z");
/** 2026-09-02 10:00 UTC = 06:00 America/New_York. */
const SIX_AM_NY = Date.parse("2026-09-02T10:00:00Z");
/** The next NY day, still after 08:00. */
const NEXT_DAY_NY = Date.parse("2026-09-03T13:00:00Z");

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

async function makeEnv(overrides = {}) {
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  const env = {
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_restock",
    MAGIC_LINK_SECRET: SIGNING_SECRET,
    RESTOCK_NOTIFY_EMAIL: "shop@yallternativeliving.com",
    STATE_DB: db,
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
  return env;
}

/**
 * Swap global.fetch for a recorder answering products.json, content.json and
 * Resend. Everything sent is captured.
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [] };
  const content = options.content || mockContent;
  const catalog = options.catalog || mockCatalog;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("products.json")) {
      if (options.catalogDown) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, clone: () => ({ body: null }), json: async () => catalog };
    }
    if (u.includes("content.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => content };
    }
    if (u.includes("api.resend.com")) {
      calls.resend.push({
        message: JSON.parse((opts && opts.body) || "{}"),
        headers: (opts && opts.headers) || {}
      });
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

/** Records console output instead of printing it, so it can be asserted on. */
async function withConsole(fn) {
  const lines = [];
  const originals = {};
  for (const level of ["log", "warn", "error"]) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  }
  try {
    const value = await fn(lines);
    return { value, lines };
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
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

const noCtx = { waitUntil: () => {} };

function rows(env, sql, ...params) {
  return env.STATE_DB._raw.prepare(sql).all(...params);
}

/** Every console line produced by a job, for the "no PII in logs" assertion. */
const allLogLines = [];

/* ==========================================================================
   1. workers/state/restock-signups.js
   ========================================================================== */

async function testSignupStore() {
  console.log("\n1. restock-signups.js (D1: store, de-duplicate, pending, notified)");
  const mod = await import("../workers/state/restock-signups.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);

  const first = await mod.addRestockSignup(db, {
    productId: "sleep-salve",
    email: " Shopper@Example.COM "
  });
  eq(first, { stored: true, duplicate: false }, "a new signup is stored");

  const again = await mod.addRestockSignup(db, {
    productId: "sleep-salve",
    email: "shopper@example.com"
  });
  eq(
    again,
    { stored: false, duplicate: true },
    "the SAME product + address is a no-op, not an error -- UNIQUE(product_id,email)"
  );
  const stored = db._raw.prepare("SELECT email, notified_at FROM restock_signups").all();
  eq(stored.length, 1, "and there is still exactly one row");
  eq(stored[0].email, "shopper@example.com", "the address is stored lower-cased and trimmed");
  eq(stored[0].notified_at, null, "notified_at starts NULL -- that is the pending flag");

  await mod.addRestockSignup(db, { productId: "sleep-salve", email: "other@example.com" });
  await mod.addRestockSignup(db, { productId: "tank-top", email: "shopper@example.com" });
  eq(
    await mod.pendingRestockCounts(db),
    [
      { productId: "sleep-salve", waiting: 2 },
      { productId: "tank-top", waiting: 1 }
    ],
    "pendingRestockCounts groups the un-notified rows by product"
  );
  eq(await mod.pendingRestockCount(db, "sleep-salve"), 2, "pendingRestockCount counts one product");

  const pending = await mod.pendingRestockSignups(db, "sleep-salve", 1);
  eq(pending.length, 1, "pendingRestockSignups honours its limit");
  await mod.markRestockNotified(db, pending[0].id, 1770000000000);
  eq(
    await mod.pendingRestockCount(db, "sleep-salve"),
    1,
    "a notified row drops out of the pending count"
  );
  eq(
    db._raw.prepare("SELECT notified_at FROM restock_signups WHERE id = ?").get(pending[0].id)
      .notified_at,
    1770000000000,
    "markRestockNotified writes the timestamp"
  );

  let threw = false;
  try {
    await mod.addRestockSignup(db, { productId: "sleep-salve", email: "not-an-address" });
  } catch {
    threw = true;
  }
  assert(threw, "an address that will not normalise is refused rather than stored");

  threw = false;
  try {
    await mod.addRestockSignup(db, { productId: "", email: "shopper@example.com" });
  } catch {
    threw = true;
  }
  assert(threw, "an empty product id is refused");

  eq(mod.RESTOCK_BATCH_LIMIT, 50, "the per-tick batch cap is 50");
}

/* ==========================================================================
   2. POST /api/restock -- through the real router
   ========================================================================== */

async function testRoute() {
  console.log("\n2. POST /api/restock (router, honeypot, validation, storage)");
  const worker = (await import("../workers/checkout.js")).default;

  await withMocks(async (calls) => {
    const env = await makeEnv();
    const { lines } = await withConsole(async () => {
      const res = await worker.fetch(
        post("/api/restock", { email: "Shopper@Example.com", product_id: "sold-out-soak" }),
        env,
        noCtx
      );
      const body = await res.json();
      eq(res.status, 200, "a valid signup answers 200");
      eq(body.success, true, "the response still carries {success: true} for the modal");
      assert(
        typeof body.message === "string" && body.message.includes("notify"),
        "and the same {message} confirmation string the restock modal renders"
      );
    });
    allLogLines.push(...lines);

    eq(calls.resend.length, 1, "the owner is still notified by email");
    eq(
      calls.resend[0].message.to,
      "shop@yallternativeliving.com",
      "to RESTOCK_NOTIFY_EMAIL, as before"
    );
    eq(
      calls.resend[0].message.reply_to,
      "Shopper@Example.com",
      "with the requester as reply-to, never as From"
    );

    const stored = rows(env, "SELECT product_id, email, notified_at FROM restock_signups");
    eq(stored.length, 1, "AND the signup is now stored for the alert job");
    eq(stored[0].product_id, "sold-out-soak", "under the product id");
    eq(stored[0].email, "shopper@example.com", "with the address lower-cased");
    eq(stored[0].notified_at, null, "pending");

    // --- de-duplication over the route ------------------------------------
    const dupe = await withConsole(() =>
      worker.fetch(
        post("/api/restock", { email: "shopper@example.com", product_id: "sold-out-soak" }),
        env,
        noCtx
      )
    );
    allLogLines.push(...dupe.lines);
    eq(dupe.value.status, 200, "signing up twice is a success, not an error");
    eq(
      rows(env, "SELECT id FROM restock_signups").length,
      1,
      "and stores no second row -- the shopper hears from us once"
    );

    // --- unknown product ---------------------------------------------------
    const unknown = await withConsole(() =>
      worker.fetch(
        post("/api/restock", { email: "shopper@example.com", product_id: "not-a-product" }),
        env,
        noCtx
      )
    );
    allLogLines.push(...unknown.lines);
    eq(unknown.value.status, 400, "a product the catalogue does not know is refused");
    eq(
      rows(env, "SELECT id FROM restock_signups").length,
      1,
      "and nothing is stored for it -- a row nothing can ever match is not kept"
    );

    // --- the product NAME is accepted too (the documented {email, product}) -
    const byName = await withConsole(() =>
      worker.fetch(
        post("/api/restock", { email: "byname@example.com", product: "Sold Out Soak" }),
        env,
        noCtx
      )
    );
    allLogLines.push(...byName.lines);
    eq(byName.value.status, 200, "the display name resolves to the product id");
    eq(
      rows(env, "SELECT product_id FROM restock_signups WHERE email = ?", "byname@example.com")[0]
        .product_id,
      "sold-out-soak",
      "and is stored as the id, not the name"
    );

    // --- honeypot ----------------------------------------------------------
    const before = calls.resend.length;
    const hp = await withConsole(() =>
      worker.fetch(
        post("/api/restock", {
          email: "bot@example.com",
          product_id: "sold-out-soak",
          website_hp: "gotcha"
        }),
        env,
        noCtx
      )
    );
    allLogLines.push(...hp.lines);
    const hpBody = await hp.value.json();
    eq(hp.value.status, 200, "the honeypot still gets a 200");
    eq(hpBody.success, true, "with the same success shape a person gets");
    eq(calls.resend.length, before, "but nothing is emailed");
    eq(
      rows(env, "SELECT id FROM restock_signups WHERE email = ?", "bot@example.com").length,
      0,
      "AND NOTHING IS STORED -- the honeypot must not fill the alert list"
    );

    // --- invalid address ---------------------------------------------------
    const bad = await withConsole(() =>
      worker.fetch(post("/api/restock", { email: "nope", product_id: "sold-out-soak" }), env, noCtx)
    );
    allLogLines.push(...bad.lines);
    eq(bad.value.status, 400, "an invalid address is still a 400");
    eq(rows(env, "SELECT id FROM restock_signups").length, 2, "and stores nothing");
  });

  // --- no STATE_DB: the old behaviour, a log line, and never a 500 ---------
  await withMocks(async (calls) => {
    const env = await makeEnv();
    delete env.STATE_DB;
    const { value: res, lines } = await withConsole(() =>
      worker.fetch(
        post("/api/restock", { email: "shopper@example.com", product_id: "sold-out-soak" }),
        env,
        noCtx
      )
    );
    allLogLines.push(...lines);
    eq(res.status, 200, "with no STATE_DB the route still answers 200, never a 500");
    eq(calls.resend.length, 1, "and the owner is still notified");
    assert(
      lines.some((l) => l.includes("STATE_DB is not bound")),
      "and it says so in the log rather than failing silently"
    );
  });

  // --- no RESEND_API_KEY: still a 503, still nothing stored ----------------
  await withMocks(async () => {
    const env = await makeEnv();
    delete env.RESEND_API_KEY;
    const { value: res, lines } = await withConsole(() =>
      worker.fetch(
        post("/api/restock", { email: "shopper@example.com", product_id: "sold-out-soak" }),
        env,
        noCtx
      )
    );
    allLogLines.push(...lines);
    eq(res.status, 503, "an unconfigured Resend key is still a 503, not a cheerful lie");
    eq(
      rows(env, "SELECT id FROM restock_signups").length,
      0,
      "and no row is stored for a request that was refused"
    );
  });

  // --- rate limit ----------------------------------------------------------
  await withMocks(async () => {
    const env = await makeEnv();
    const ip = "203.0.113.77";
    let last = null;
    await withConsole(async () => {
      for (let i = 0; i < 6; i += 1) {
        last = await worker.fetch(
          post(
            "/api/restock",
            { email: `person${i}@example.com`, product_id: "sold-out-soak" },
            { "X-Forwarded-For": ip }
          ),
          env,
          noCtx
        );
      }
    });
    eq(last.status, 429, "the 6th request from one IP inside a minute is rate limited");
    eq(
      rows(env, "SELECT id FROM restock_signups").length,
      5,
      "and the limited request stored nothing"
    );
  });
}

/* ==========================================================================
   3. Templates and the stock predicate
   ========================================================================== */

async function testTemplatesAndStock() {
  console.log("\n3. Templates, isInStock and stockLevel");
  const mod = await import("../workers/routes/restock.js");

  eq(mod.stockLevel({ stock: 4 }), 4, "a numeric stock reads as itself");
  eq(mod.stockLevel({ stock: 0 }), 0, "zero is zero");
  eq(mod.stockLevel({}), null, "a missing stock field is null -- 'not counted', not zero");
  eq(mod.stockLevel({ stock: null }), null, "an explicit null is 'not counted' too");
  eq(mod.stockLevel({ stock: "" }), null, "so is an empty string from the CMS");

  eq(mod.isInStock({ id: "a" }), true, "a product with no stock field is buyable (made to order)");
  eq(mod.isInStock({ stock: 2 }), true, "units on hand is buyable");
  eq(mod.isInStock({ stock: 0 }), false, "zero units is not");
  eq(mod.isInStock({ stock: 5, inStock: false }), false, "inStock:false beats a unit count");
  eq(mod.isInStock({ stock: 5, comingSoon: true }), false, "comingSoon is never buyable");
  eq(mod.isInStock(null), false, "an unknown product is never buyable");

  const alert = mod.restockAlertEmail(
    { id: "sleep-salve", name: "Sleep Salve" },
    INTRO,
    "https://example.test"
  );
  assert(alert.subject.includes("Sleep Salve"), "the alert subject names the product");
  assert(alert.html.includes(INTRO), "the CMS intro line is the opening line of the HTML body");
  assert(alert.text.includes(INTRO), "and of the text body");
  assert(
    alert.html.includes("https://example.test/products/sleep-salve.html"),
    "the product page link is <SITE_ORIGIN>/products/<id>.html"
  );
  assert(
    alert.text.includes("https://example.test/products/sleep-salve.html"),
    "in the text part too"
  );
  const noIntro = mod.restockAlertEmail({ id: "x", name: "X" }, "", SITE);
  assert(
    noIntro.html.includes(mod.DEFAULT_RESTOCK_INTRO),
    "an unset restockEmailIntro falls back to a written default, never an empty paragraph"
  );

  const low = mod.lowStockEmail(
    [
      { id: "sold-out-soak", name: "Sold Out Soak", stock: 0, waiting: 4 },
      { id: "tank-top", name: "Y'all Tank Top", stock: 2, waiting: 0 }
    ],
    3,
    SITE
  );
  assert(low.subject.includes("2 items"), "the low-stock subject counts the products");
  assert(low.subject.includes("3"), "and names the threshold");
  assert(low.html.includes("Sold Out Soak") && low.html.includes("0 left"), "rows carry the count");
  assert(low.html.includes("4</strong> waiting"), "and how many shoppers are waiting");
  assert(low.text.includes("nobody waiting"), "a product with no waiting list says so plainly");
}

/* ==========================================================================
   4. runRestockAlerts
   ========================================================================== */

async function seed(env, pairs, now = 1770000000000) {
  const { addRestockSignup } = await import("../workers/state/restock-signups.js");
  let i = 0;
  for (const [productId, email] of pairs) {
    i += 1;
    await addRestockSignup(env.STATE_DB, { productId, email }, now + i);
  }
}

async function testRestockAlerts() {
  console.log("\n4. runRestockAlerts (in stock only, suppression, batch, idempotency)");
  const mod = await import("../workers/routes/restock.js");
  const { hashEmail } = await import("../workers/state/retention.js");

  // --- the happy path -----------------------------------------------------
  await withMocks(async (calls) => {
    const env = await makeEnv();
    await seed(env, [
      ["sleep-salve", "waiting@example.com"],
      ["frankincense-salve", "second@example.com"],
      ["sold-out-soak", "patient@example.com"],
      ["retired-tee", "hopeful@example.com"],
      ["sugar-scrub", "early@example.com"],
      ["deleted-product", "orphan@example.com"]
    ]);
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);

    eq(summary.sent, 2, "only the two in-stock products are emailed");
    const recipients = calls.resend.map((c) => c.message.to).sort();
    eq(
      recipients,
      ["second@example.com", "waiting@example.com"],
      "the sold-out, coming-soon, inStock:false and unknown products send NOTHING"
    );

    const sent = calls.resend.find((c) => c.message.to === "waiting@example.com");
    assert(sent.message.subject.includes("Sleep Salve"), "the subject names the product");
    assert(sent.message.html.includes(INTRO), "the body opens with the CMS intro line");
    assert(
      sent.message.html.includes(`${SITE}/products/sleep-salve.html`),
      "and links to the product page"
    );
    assert(
      /\/api\/unsubscribe\?t=[a-f0-9]{32}\.[a-f0-9]{32}/.test(
        sent.message.headers["List-Unsubscribe"]
      ),
      "it carries the same signed unsubscribe link every marketing email carries"
    );
    eq(
      sent.message.headers["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click",
      "with the RFC 8058 one-click header"
    );
    assert(
      sent.message.html.includes("unsubscribe") || sent.message.text.includes("unsubscribe"),
      "and the visible opt-out line in the body"
    );
    eq(
      sent.headers["Idempotency-Key"],
      `restock-sleep-salve-${await hashEmail("waiting@example.com")}`,
      "the idempotency key is restock-<product>-<sha256 of the address>"
    );
    assert(
      !sent.headers["Idempotency-Key"].includes("waiting@example.com"),
      "-- a hash, never the address itself"
    );

    const notified = rows(
      env,
      "SELECT product_id, notified_at FROM restock_signups WHERE notified_at IS NOT NULL"
    );
    eq(notified.length, 2, "the two sent rows have notified_at set");
    eq(
      rows(
        env,
        "SELECT id FROM restock_signups WHERE product_id = ? AND notified_at IS NULL",
        "sold-out-soak"
      ).length,
      1,
      "and the sold-out product's signup is still pending, waiting for the restock"
    );

    // --- a second tick sends nothing more --------------------------------
    const before = calls.resend.length;
    const second = await withConsole(() => mod.runRestockAlerts(env, noCtx, NINE_AM_NY));
    allLogLines.push(...second.lines);
    eq(calls.resend.length, before, "a second tick emails nobody twice -- notified_at is the gate");
    eq(second.value.sent, 0, "and the summary says so");
  });

  // --- suppression ---------------------------------------------------------
  await withMocks(async (calls) => {
    const env = await makeEnv();
    const { suppressEmail } = await import("../workers/state/retention.js");
    await suppressEmail(env.STATE_DB, "gone@example.com");
    await seed(env, [
      ["sleep-salve", "gone@example.com"],
      ["sleep-salve", "here@example.com"]
    ]);
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(calls.resend.length, 1, "an unsubscribed address is not emailed");
    eq(calls.resend[0].message.to, "here@example.com", "only the address still opted in is");
    eq(summary.skipped, 1, "and the skip is counted, not hidden");
    eq(
      rows(env, "SELECT id FROM restock_signups WHERE notified_at IS NULL").length,
      0,
      "the suppressed row is CLOSED too -- it is not reconsidered every hour forever"
    );
  });

  // --- the batch bound -----------------------------------------------------
  await withMocks(async (calls) => {
    const env = await makeEnv();
    const pairs = [];
    for (let i = 0; i < 60; i += 1) pairs.push(["sleep-salve", `person${i}@example.com`]);
    await seed(env, pairs);
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(summary.sent, 50, "one tick sends at most RESTOCK_BATCH_LIMIT emails");
    eq(calls.resend.length, 50, "-- and really does stop at 50 Resend calls");
    eq(
      rows(env, "SELECT id FROM restock_signups WHERE notified_at IS NULL").length,
      10,
      "the remaining 10 stay pending and drain on the next tick"
    );
    const next = await withConsole(() => mod.runRestockAlerts(env, noCtx, NINE_AM_NY));
    allLogLines.push(...next.lines);
    eq(next.value.sent, 10, "which is exactly what the next tick does");
  });

  // --- a failed send is retried, not lost ----------------------------------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      await seed(env, [["sleep-salve", "retry@example.com"]]);
      const { value: summary, lines } = await withConsole(() =>
        mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(calls.resend.length, 1, "the send was attempted");
      eq(summary.failed, 1, "and reported as deferred");
      eq(
        rows(env, "SELECT id FROM restock_signups WHERE notified_at IS NULL").length,
        1,
        "a Resend failure leaves notified_at NULL so the next tick retries it"
      );
    },
    { resendFails: true }
  );

  // --- the switches --------------------------------------------------------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      await seed(env, [["sleep-salve", "waiting@example.com"]]);
      const { value: summary, lines } = await withConsole(() =>
        mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(summary.skipped, "disabled", "site.enableRestockAlerts:false stops the whole job");
      eq(calls.resend.length, 0, "and sends nothing");
      assert(
        lines.some((l) => l.includes("enableRestockAlerts")),
        "with a log line naming the switch"
      );
    },
    {
      content: {
        site: { enableRestockAlerts: false, automations: { restockEmailIntro: INTRO } }
      }
    }
  );

  await withMocks(async (calls) => {
    const env = await makeEnv();
    delete env.MAGIC_LINK_SECRET;
    await seed(env, [["sleep-salve", "waiting@example.com"]]);
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(
      summary.skipped,
      "unconfigured",
      "no MAGIC_LINK_SECRET means no signable unsubscribe link, so nothing is sent"
    );
    eq(calls.resend.length, 0, "quietly -- a configuration fact, not an error");
  });

  await withMocks(async (calls) => {
    const env = await makeEnv();
    delete env.RESEND_API_KEY;
    await seed(env, [["sleep-salve", "waiting@example.com"]]);
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(summary.skipped, "unconfigured", "and no RESEND_API_KEY skips too");
    eq(calls.resend.length, 0, "sending nothing");
  });

  await withMocks(async (calls) => {
    const env = await makeEnv();
    delete env.STATE_DB;
    const { value: summary, lines } = await withConsole(() =>
      mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(summary.skipped, "no-state-db", "no STATE_DB skips instead of throwing inside the cron");
    eq(calls.resend.length, 0, "and sends nothing");
  });

  // --- an unreachable catalogue sends nothing rather than guessing ---------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      await seed(env, [["sleep-salve", "waiting@example.com"]]);
      const { value: summary, lines } = await withConsole(() =>
        mod.runRestockAlerts(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(summary.skipped, "no-catalog", "an unreachable products.json skips the tick");
      eq(calls.resend.length, 0, "rather than emailing about a product it cannot check");
      eq(
        rows(env, "SELECT id FROM restock_signups WHERE notified_at IS NULL").length,
        1,
        "and the signup stays pending"
      );
    },
    { catalogDown: true }
  );
}

/* ==========================================================================
   5. runLowStockCheck
   ========================================================================== */

async function testLowStockCheck() {
  console.log("\n5. runLowStockCheck (once a day, 8am NY, owner only)");
  const mod = await import("../workers/routes/restock.js");

  await withMocks(async (calls) => {
    const env = await makeEnv({ ORDER_NOTIFY_EMAIL: "owner@yallternativeliving.com" });
    await seed(env, [
      ["sold-out-soak", "one@example.com"],
      ["sold-out-soak", "two@example.com"],
      ["tank-top", "three@example.com"]
    ]);

    // --- before 8am NY: nothing at all -----------------------------------
    const early = await withConsole(() => mod.runLowStockCheck(env, noCtx, SIX_AM_NY));
    allLogLines.push(...early.lines);
    eq(early.value.skipped, "too-early", "before 08:00 America/New_York the job does nothing");
    eq(calls.resend.length, 0, "and sends nothing");

    // --- the daily note ---------------------------------------------------
    const run = await withConsole(() => mod.runLowStockCheck(env, noCtx, NINE_AM_NY));
    allLogLines.push(...run.lines);
    eq(run.value.sent, 1, "at 09:00 NY the owner gets one note");
    eq(run.value.low, 3, "listing the three products at or under the threshold of 3");
    eq(calls.resend.length, 1, "one email, not one per product");

    const note = calls.resend[0];
    eq(note.message.to, "owner@yallternativeliving.com", "to ORDER_NOTIFY_EMAIL");
    assert(note.message.subject.includes("Low stock"), "with a subject that says what it is");
    assert(note.message.html.includes("Sold Out Soak"), "the zero-stock product is listed");
    assert(note.message.text.includes("Y'all Tank Top"), "so is the 2-left one");
    assert(
      note.message.html.includes("Y&#39;all Tank Top"),
      "and the HTML part escapes the apostrophe rather than emitting raw input"
    );
    assert(note.message.html.includes("Last Three Balm"), "and the one exactly at the threshold");
    assert(
      !note.message.html.includes("Sugar Scrub"),
      "a coming-soon product is NOT 'low stock' -- it has not launched"
    );
    assert(
      !note.message.html.includes("Sleep Salve") && !note.message.html.includes("Frankincense"),
      "and a product that does not count units is never low"
    );
    assert(
      note.message.text.includes("Sold Out Soak: 0 left, 2 waiting"),
      "counts the waiting list"
    );
    assert(
      note.message.text.includes("Last Three Balm: 3 left, nobody waiting"),
      "and says so plainly when nobody is waiting"
    );
    eq(
      note.headers["Idempotency-Key"],
      "low-stock-2026-09-02",
      "the idempotency key is one per New York day"
    );
    assert(
      !("List-Unsubscribe" in (note.message.headers || {})),
      "the owner's own operational note is transactional -- no unsubscribe link"
    );

    // --- once a day --------------------------------------------------------
    const second = await withConsole(() => mod.runLowStockCheck(env, noCtx, NINE_AM_NY + 3600000));
    allLogLines.push(...second.lines);
    eq(second.value.skipped, "already-ran-today", "the next hourly tick does not send again");
    eq(calls.resend.length, 1, "still one email today");
    eq(
      rows(env, "SELECT value FROM job_state WHERE job = ?", "low-stock")[0].value,
      "2026-09-02",
      "claimDaily recorded the New York day it ran"
    );

    // --- and again tomorrow -------------------------------------------------
    const tomorrow = await withConsole(() => mod.runLowStockCheck(env, noCtx, NEXT_DAY_NY));
    allLogLines.push(...tomorrow.lines);
    eq(tomorrow.value.sent, 1, "the next NY day it sends again");
    eq(calls.resend.length, 2, "two notes over two days");
    eq(
      calls.resend[1].headers["Idempotency-Key"],
      "low-stock-2026-09-03",
      "under the new day's key"
    );
  });

  // --- nothing low means no email -----------------------------------------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      const { value: summary, lines } = await withConsole(() =>
        mod.runLowStockCheck(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(summary.low, 0, "nothing is low");
      eq(
        calls.resend.length,
        0,
        "so no email is sent -- a daily 'all fine' trains the inbox to ignore it"
      );
    },
    {
      catalog: {
        products: [{ id: "sleep-salve", name: "Sleep Salve", stock: 40 }],
        bundles: []
      }
    }
  );

  // --- the threshold comes from the CMS ------------------------------------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      const { value: summary, lines } = await withConsole(() =>
        mod.runLowStockCheck(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(summary.threshold, 1, "site.automations.lowStockThreshold is honoured");
      eq(summary.low, 1, "so only the 0-left product qualifies at a threshold of 1");
      assert(calls.resend[0].message.subject.includes("under 1"), "and the subject says so");
    },
    {
      content: {
        site: { enableLowStockAlerts: true, automations: { lowStockThreshold: 1 } }
      }
    }
  );

  // --- the default threshold ------------------------------------------------
  await withMocks(
    async () => {
      const env = await makeEnv();
      const { value: summary, lines } = await withConsole(() =>
        mod.runLowStockCheck(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(
        summary.threshold,
        mod.DEFAULT_LOW_STOCK_THRESHOLD,
        "an unset lowStockThreshold falls back to the documented default of 3"
      );
    },
    { content: { site: {} } }
  );

  // --- the switch -----------------------------------------------------------
  await withMocks(
    async (calls) => {
      const env = await makeEnv();
      const { value: summary, lines } = await withConsole(() =>
        mod.runLowStockCheck(env, noCtx, NINE_AM_NY)
      );
      allLogLines.push(...lines);
      eq(summary.skipped, "disabled", "site.enableLowStockAlerts:false stops the job");
      eq(calls.resend.length, 0, "and sends nothing");
      eq(
        rows(env, "SELECT job FROM job_state").length,
        0,
        "without burning the day, so switching it back on works the same day"
      );
    },
    { content: { site: { enableLowStockAlerts: false } } }
  );

  await withMocks(async (calls) => {
    const env = await makeEnv();
    delete env.STATE_DB;
    const { value: summary, lines } = await withConsole(() =>
      mod.runLowStockCheck(env, noCtx, NINE_AM_NY)
    );
    allLogLines.push(...lines);
    eq(summary.skipped, "no-state-db", "no STATE_DB skips instead of throwing inside the cron");
    eq(calls.resend.length, 0, "and sends nothing");
  });
}

/* ==========================================================================
   6. The logs carry no addresses
   ========================================================================== */

function testNoPiiInLogs() {
  console.log("\n6. Operational logs");
  assert(allLogLines.length > 0, "the jobs and the route did log something to assert about");
  const leaks = allLogLines.filter((line) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(line));
  eq(leaks, [], "NO CONSOLE LINE CARRIES AN EMAIL ADDRESS -- logs are product ids and counts only");
}

/* ==========================================================================
   7. The cron wiring is real
   ========================================================================== */

async function testCronWiring() {
  console.log("\n7. Cron wiring");
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "workers", "checkout.js"), "utf8");
  assert(
    source.includes("runRestockAlerts(env, ctx)"),
    "the scheduled handler in checkout.js calls runRestockAlerts"
  );
  assert(
    source.includes("runLowStockCheck(env, ctx)"),
    "and runLowStockCheck -- neither job is orphaned"
  );
  const mod = await import("../workers/routes/restock.js");
  assert(typeof mod.runRestockAlerts === "function", "runRestockAlerts is exported");
  assert(typeof mod.runLowStockCheck === "function", "runLowStockCheck is exported");
  const { value: stub } = await withConsole(() => mod.runRestockAlerts({}, noCtx));
  assert(
    stub && stub.skipped !== "not-implemented",
    "and neither is still the not-implemented stub"
  );
}

/* ==========================================================================
   Runner
   ========================================================================== */

(async () => {
  await testSignupStore();
  await testRoute();
  await testTemplatesAndStock();
  await testRestockAlerts();
  await testLowStockCheck();
  testNoPiiInLogs();
  await testCronWiring();

  const { resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();

  if (passed === 0) {
    console.error("\nworker-restock.test.js: NO assertions ran -- that is a failure, not a pass.");
    process.exit(1);
  }
  console.log(`\nworker-restock.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-restock.test.js crashed:", err);
  process.exit(1);
});
