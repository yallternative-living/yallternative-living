/**
 * @fileoverview The inventory ledger (workers/state/inventory.js), its hooks
 * (workers/routes/inventory.js) and the way checkout.js and stripe-webhook.js
 * call them -- against the real modules over an in-memory D1
 * (scripts/lib/d1-emulator.js), so every line under test is the shipped one.
 *
 *   1. seed and owner-correction re-seed
 *   2. reserve, and the race for the last unit
 *   3. commit / expire-release / refund-restock, each exactly once
 *   4. the stale-hold sweep
 *   5. checkout: the ledger caps the cart, a lost race is a 400 the drawer
 *      can act on, and a dead ledger fails OPEN
 *   6. the webhook hooks
 *   7. GET /api/inventory: shape, no-store, rate limit, 503 without D1
 *
 * Run: node scripts/worker-inventory.test.js
 */

const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

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

async function rejects(fn, codeOrRe, label) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${label}\n      expected a rejection`);
  } catch (err) {
    const ok =
      codeOrRe instanceof RegExp
        ? codeOrRe.test(String(err && (err.message || err)))
        : err && err.code === codeOrRe;
    if (ok) passed++;
    else {
      failed++;
      console.error(`  ✗ ${label}\n      rejected with ${err && (err.code || err.message)}`);
    }
  }
}

/** Capture console.error / console.warn lines while `fn` runs. */
async function capture(fn) {
  const lines = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
  return lines;
}

const mockCatalog = {
  products: [
    { id: "lavender-soak", name: "Lavender Soak", price: 18, category: "soaks" },
    { id: "last-three-balm", name: "Last Three Balm", price: 9, category: "salves", stock: 3 },
    { id: "single-tee", name: "Single Tee", price: 20, category: "apparel", stock: 1 },
    { id: "boxable-salve", name: "Boxable Salve", price: 12, category: "salves", stock: 2 },
    { id: "boxable-soak", name: "Boxable Soak", price: 12, category: "soaks", stock: 9 },
    { id: "boxable-body", name: "Boxable Body", price: 12, category: "body", stock: 9 }
  ],
  bundles: [],
  shop: {
    customBox: {
      minItems: 3,
      maxItems: 5,
      discountPercent: 10,
      eligibleCategories: ["salves", "soaks", "body"]
    },
    freeShippingThreshold: 40
  }
};
const mockEvents = { upcoming: [], past: [] };

async function freshDb() {
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  const { resetInventoryMemo } = await import("../workers/state/inventory.js");
  resetSchemaMemo();
  resetInventoryMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return db;
}

async function makeEnv(overrides = {}) {
  const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  return {
    SITE_ORIGIN: "https://yallternativeliving.com",
    STRIPE_SECRET_KEY: "sk_test_inventory",
    STATE_DB: await freshDb(),
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

const noCtx = { waitUntil: () => {} };

/**
 * Drive one checkout through the real Worker with Stripe stubbed. Mirrors
 * scripts/worker-checkout.test.js's executeCheckout, trimmed to what the
 * ledger path needs. `beforeReserve(env)` runs after Stripe "creates" the
 * session and before the Worker reserves -- the concurrent second shopper.
 */
async function checkout(env, items, options = {}) {
  const expired = [];
  const deletedCoupons = [];
  const originalFetch = global.fetch;
  let sessionCount = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    if (u.includes("products.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => options.catalog || mockCatalog
      };
    }
    if (u.includes("events.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => mockEvents };
    }
    if (u.includes("/v1/coupons") && method === "DELETE") {
      deletedCoupons.push(u.split("/").pop());
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    if (u.includes("/expire")) {
      expired.push(u);
      return { ok: true, status: 200, json: async () => ({ status: "expired" }) };
    }
    if (u.includes("/v1/checkout/sessions")) {
      sessionCount += 1;
      const id = options.sessionId || `cs_test_${sessionCount}`;
      if (options.beforeReserve) await options.beforeReserve(env);
      return {
        ok: true,
        json: async () => ({ id, url: `https://checkout.stripe.com/pay/${id}` })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const req = new Request("https://yallternativeliving.com/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://yallternativeliving.com" },
      body: JSON.stringify({ items })
    });
    const res = await worker.fetch(req, env, noCtx);
    return { status: res.status, data: await res.json(), expired, deletedCoupons };
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  const inv = await import("../workers/state/inventory.js");
  const routes = await import("../workers/routes/inventory.js");
  const { processStripeEvent } = await import("../workers/routes/stripe-webhook.js");
  const tracked = inv.trackedProductsOf(mockCatalog.products);

  console.log("\n1. seed and owner-correction re-seed");
  {
    const db = await freshDb();
    eq(
      tracked.map((p) => p.id),
      ["last-three-balm", "single-tee", "boxable-salve", "boxable-soak", "boxable-body"],
      "trackedProductsOf keeps only products with a finite numeric stock"
    );
    eq(
      inv.trackedProductsOf([{ id: "x", stock: null }, { id: "y", stock: "4" }, { id: "z" }]),
      [],
      "null, string and absent stock are all untracked"
    );
    const first = await inv.syncInventory(db, tracked, 1000);
    eq(first.changed, 5, "first sight of five tracked products seeds five rows");
    const rows = await inv.inventoryRows(db);
    const balm = rows.find((r) => r.product_id === "last-three-balm");
    eq(
      [balm.on_hand, balm.reserved, balm.seed_stock, balm.updated_at],
      [3, 0, 3, 1000],
      "a seeded row: on_hand = stock, seed_stock = stock, nothing reserved"
    );

    const again = await inv.syncInventory(db, tracked, 2000);
    eq(again.changed, 0, "the same catalog again writes nothing (isolate memo)");
    inv.resetInventoryMemo();
    const cold = await inv.syncInventory(db, tracked, 3000);
    eq(cold.changed, 0, "...and on a cold isolate the same catalog changes no row either");

    // A sale, then a rebuild that still says 3: the live count must survive.
    await inv.reserveInventory(db, "cs_seed_1", [{ productId: "last-three-balm", qty: 2 }]);
    await inv.commitInventory(db, "cs_seed_1");
    inv.resetInventoryMemo();
    await inv.syncInventory(db, tracked, 4000);
    const afterSale = (await inv.readAvailability(db, ["last-three-balm"])).get("last-three-balm");
    eq(afterSale.available, 1, "a rebuild with the same stock does not undo a sale");

    // The owner types a new count: that IS the count now.
    inv.resetInventoryMemo();
    const corrected = tracked.map((p) =>
      p.id === "last-three-balm" ? { id: p.id, stock: 12 } : p
    );
    const reseed = await inv.syncInventory(db, corrected, 5000);
    eq(reseed.changed, 1, "a changed stock in products.json re-seeds exactly that row");
    const fixed = (await inv.inventoryRows(db)).find((r) => r.product_id === "last-three-balm");
    eq(
      [fixed.on_hand, fixed.seed_stock, fixed.reserved],
      [12, 12, 0],
      "owner correction: on_hand = new stock, seed_stock = new stock"
    );

    // A correction below what is held for open sessions keeps the holds.
    await inv.reserveInventory(db, "cs_seed_2", [{ productId: "single-tee", qty: 1 }]);
    inv.resetInventoryMemo();
    const zeroed = tracked.map((p) => (p.id === "single-tee" ? { id: p.id, stock: 0 } : p));
    await inv.syncInventory(db, zeroed, 6000);
    const tee = (await inv.inventoryRows(db)).find((r) => r.product_id === "single-tee");
    eq(
      [tee.on_hand, tee.reserved, tee.seed_stock],
      [1, 1, 0],
      "a correction to 0 under an active hold keeps on_hand at the held units (CHECK holds)"
    );
    eq(
      (await inv.readAvailability(db, ["single-tee"])).get("single-tee").available,
      0,
      "...and nothing is available to a new shopper"
    );
  }

  console.log("\n2. reserve, and the race for the last unit");
  {
    const db = await freshDb();
    await inv.syncInventory(db, tracked);
    const held = await inv.reserveInventory(db, "cs_a", [
      { productId: "last-three-balm", qty: 2 },
      { productId: "lavender-soak", qty: 5 }
    ]);
    eq(
      held,
      { reserved: true, holds: [{ productId: "last-three-balm", qty: 2 }] },
      "reserve holds the tracked product and skips the untracked one"
    );
    const counts = await inv.availableCounts(db, ["last-three-balm", "lavender-soak"]);
    eq([...counts], [["last-three-balm", 1]], "available = on_hand - reserved; untracked absent");

    await rejects(
      () => inv.reserveInventory(db, "cs_a", [{ productId: "last-three-balm", qty: 1 }]),
      "hold_exists",
      "the same session cannot stack a second hold"
    );
    await rejects(
      () => inv.reserveInventory(db, "cs_b", [{ productId: "last-three-balm", qty: 2 }]),
      "insufficient_stock",
      "a second session asking for more than is left is refused"
    );
    const partial = await inv.reserveInventory(db, "cs_b", [
      { productId: "last-three-balm", qty: 1 },
      { productId: "single-tee", qty: 1 }
    ]);
    eq(partial.holds.length, 2, "...and gets the last unit when it asks for exactly that");

    // All-or-nothing across the list: one short product refuses the whole hold.
    await rejects(
      () =>
        inv.reserveInventory(db, "cs_c", [
          { productId: "boxable-soak", qty: 1 },
          { productId: "single-tee", qty: 1 }
        ]),
      "insufficient_stock",
      "a multi-product reserve is refused as a whole when one product is short"
    );
    const soak = (await inv.readAvailability(db, ["boxable-soak"])).get("boxable-soak");
    eq(soak.reserved, 0, "...and the product that had room was not held either");
    eq((await inv.holdRows(db, "cs_c")).length, 0, "...nor was any hold row written");

    /* THE RACE. The pre-read says there is room; between it and the write
       another session takes the unit. The CHECK (reserved <= on_hand) is
       what refuses the second writer, and the batch is rolled back whole. */
    const raceDb = await freshDb();
    await inv.syncInventory(raceDb, tracked);
    let reads = 0;
    const staleDb = {
      prepare(sql) {
        const stmt = raceDb.prepare(sql);
        if (/FROM inventory WHERE product_id IN/.test(sql)) {
          reads += 1;
          if (reads === 1) {
            // The pre-read: let the rival in before answering.
            return {
              bind: (...args) => {
                const bound = stmt.bind(...args);
                return {
                  async all() {
                    const answer = await bound.all();
                    await inv.reserveInventory(raceDb, "cs_rival", [
                      { productId: "single-tee", qty: 1 }
                    ]);
                    return answer;
                  }
                };
              }
            };
          }
        }
        return stmt;
      },
      batch: (statements) => raceDb.batch(statements)
    };
    await rejects(
      () =>
        inv.reserveInventory(staleDb, "cs_loser", [
          { productId: "boxable-soak", qty: 1 },
          { productId: "single-tee", qty: 1 }
        ]),
      "insufficient_stock",
      "race: the write that finds the unit gone is refused by the CHECK constraint"
    );
    const tee = (await inv.readAvailability(raceDb, ["single-tee"])).get("single-tee");
    eq([tee.onHand, tee.reserved], [1, 1], "...the rival's hold stands, once");
    eq((await inv.holdRows(raceDb, "cs_loser")).length, 0, "...and the loser's batch left no row");
    const soakAfter = (await inv.readAvailability(raceDb, ["boxable-soak"])).get("boxable-soak");
    eq(soakAfter.reserved, 0, "...not even for the product that had room");

    await rejects(
      () => inv.reserveInventory(db, "", [{ productId: "single-tee", qty: 1 }]),
      "invalid_session",
      "a hold needs a session id"
    );
    eq(
      await inv.reserveInventory(db, "cs_d", [{ productId: "nope", qty: 1 }]),
      { reserved: false, holds: [] },
      "a product with no inventory row is not held (untracked as far as the ledger knows)"
    );
  }

  console.log("\n3. commit / release / restock, each exactly once");
  {
    const db = await freshDb();
    await inv.syncInventory(db, tracked);
    await inv.reserveInventory(db, "cs_pay", [
      { productId: "last-three-balm", qty: 3 },
      { productId: "boxable-salve", qty: 1 }
    ]);
    const commit = await inv.commitInventory(db, "cs_pay");
    eq(
      commit,
      {
        committed: [
          { productId: "boxable-salve", qty: 1 },
          { productId: "last-three-balm", qty: 3 }
        ],
        alreadyCommitted: false,
        soldOut: ["last-three-balm"]
      },
      "commit reports what it sold and which products it took to zero"
    );
    const balm = (await inv.readAvailability(db, ["last-three-balm"])).get("last-three-balm");
    eq(
      [balm.onHand, balm.reserved, balm.available],
      [0, 0, 0],
      "commit: on_hand -= qty, reserved -= qty"
    );
    const again = await inv.commitInventory(db, "cs_pay");
    eq(
      again,
      { committed: [], alreadyCommitted: true, soldOut: [] },
      "a redelivered completion commits nothing again"
    );
    eq(
      await inv.commitInventory(db, "cs_never"),
      { committed: [], alreadyCommitted: false, soldOut: [] },
      "a session that never held anything commits nothing"
    );
    eq(
      (await inv.holdRows(db, "cs_pay")).map((r) => r.state),
      ["committed", "committed"],
      "the holds read committed"
    );

    // Release: an abandoned session.
    await inv.reserveInventory(db, "cs_walk", [{ productId: "boxable-salve", qty: 1 }]);
    eq(
      (await inv.readAvailability(db, ["boxable-salve"])).get("boxable-salve").available,
      0,
      "the last salve is held"
    );
    eq(
      await inv.releaseInventory(db, "cs_walk"),
      { released: [{ productId: "boxable-salve", qty: 1 }] },
      "release gives the held unit back"
    );
    const salve = (await inv.readAvailability(db, ["boxable-salve"])).get("boxable-salve");
    eq([salve.onHand, salve.reserved], [1, 0], "release: reserved -= qty, on_hand untouched");
    eq(await inv.releaseInventory(db, "cs_walk"), { released: [] }, "a second release is a no-op");
    eq(
      await inv.releaseInventory(db, "cs_pay"),
      { released: [] },
      "a committed hold is never released"
    );
    eq(
      await inv.releaseInventory(db, "cs_unknown"),
      { released: [] },
      "an expired session that never held anything is fine"
    );

    // Restock: a full refund.
    eq(
      await inv.restockInventory(db, "cs_pay"),
      {
        restocked: [
          { productId: "boxable-salve", qty: 1 },
          { productId: "last-three-balm", qty: 3 }
        ]
      },
      "restock puts a committed order back on the shelf"
    );
    const back = (await inv.readAvailability(db, ["last-three-balm"])).get("last-three-balm");
    eq([back.onHand, back.available], [3, 3], "restock: on_hand += qty");
    eq(
      await inv.restockInventory(db, "cs_pay"),
      { restocked: [] },
      "a second refund event restocks nothing"
    );
    eq(
      await inv.restockInventory(db, "cs_walk"),
      { restocked: [] },
      "a released hold cannot be restocked"
    );
    eq(
      (await inv.holdRows(db, "cs_pay")).map((r) => r.state),
      ["restocked", "restocked"],
      "the holds read restocked"
    );
  }

  console.log("\n4. the stale-hold sweep");
  {
    const db = await freshDb();
    await inv.syncInventory(db, tracked);
    const t0 = 1_000_000;
    await inv.reserveInventory(db, "cs_old", [{ productId: "single-tee", qty: 1 }], t0);
    await inv.reserveInventory(
      db,
      "cs_new",
      [{ productId: "boxable-salve", qty: 1 }],
      t0 + inv.HOLD_TTL_MS
    );
    eq(await inv.sweepStaleHolds(db, t0 + inv.HOLD_TTL_MS - 1), 0, "nothing stale a minute early");
    eq(await inv.sweepStaleHolds(db, t0 + inv.HOLD_TTL_MS + 1), 1, "the 25h-old hold is released");
    eq(
      (await inv.readAvailability(db, ["single-tee", "boxable-salve"])).get("single-tee").available,
      1,
      "...its unit is on sale again"
    );
    eq((await inv.holdRows(db, "cs_new"))[0].state, "active", "...and the young hold is untouched");
  }

  console.log("\n5. checkout: capped by the ledger, refused on a lost race, open on a dead ledger");
  {
    const env = await makeEnv();
    const ok = await checkout(env, [{ id: "last-three-balm", qty: 2 }], { sessionId: "cs_one" });
    eq(ok.status, 200, "a checkout within the live count goes through");
    eq(
      (await inv.holdRows(env.STATE_DB, "cs_one")).map((r) => [r.product_id, r.qty, r.state]),
      [["last-three-balm", 2, "active"]],
      "...and holds the allocated quantity against the Stripe session"
    );
    eq(
      (await inv.readAvailability(env.STATE_DB, ["last-three-balm"])).get("last-three-balm")
        .available,
      1,
      "the ledger now shows one left although products.json still says 3"
    );

    // The next shopper is capped by the LEDGER, not by products.json.
    const capped = await checkout(env, [{ id: "last-three-balm", qty: 3 }], {
      sessionId: "cs_two"
    });
    eq(capped.status, 200, "a second checkout for 3 goes through...");
    eq(
      (await inv.holdRows(env.STATE_DB, "cs_two"))[0].qty,
      1,
      "...for the 1 unit the ledger has, not the 3 the static catalog claims"
    );

    // Now the count is gone: refused before Stripe is ever called.
    const gone = await checkout(env, [{ id: "last-three-balm", qty: 1 }], {
      sessionId: "cs_three"
    });
    eq(gone.status, 400, "with nothing left the line is refused with a 400");
    eq(
      gone.data.unavailable,
      [{ id: "last-three-balm", reason: "sold_out" }],
      "...in the unavailableDetails shape cart.js drops the line on"
    );
    eq(gone.expired.length, 0, "...and no Stripe session was created to expire");

    // The lost race: a rival takes the last unit between Stripe's answer
    // and this Worker's reserve.
    const raceEnv = await makeEnv();
    const lost = await checkout(raceEnv, [{ id: "single-tee", qty: 1 }], {
      sessionId: "cs_loser",
      beforeReserve: async (e) => {
        await inv.reserveInventory(e.STATE_DB, "cs_rival", [{ productId: "single-tee", qty: 1 }]);
      }
    });
    eq(
      lost.status,
      400,
      "the loser of the race gets a 400, not a 409 (400 is what drops the line)"
    );
    eq(lost.data.error, "Sold out: Single Tee", "...naming the product");
    eq(
      lost.data.unavailable,
      [{ id: "single-tee", reason: "sold_out" }],
      "...and the line, so the drawer removes exactly that one"
    );
    eq(lost.expired.length, 1, "...and its Stripe session was expired so it cannot be paid");
    assert(lost.expired[0].includes("cs_loser/expire"), "the expired session is the loser's");
    eq((await inv.holdRows(raceEnv.STATE_DB, "cs_loser")).length, 0, "no hold for the loser");

    // A box loses the race on a member: member_unavailable, naming the member.
    const boxEnv = await makeEnv();
    const box = {
      id: "custom-box",
      qty: 1,
      boxProductIds: ["boxable-salve", "boxable-soak", "boxable-body"]
    };
    const boxLost = await checkout(boxEnv, [box], {
      sessionId: "cs_boxloser",
      beforeReserve: async (e) => {
        await inv.reserveInventory(e.STATE_DB, "cs_rival", [
          { productId: "boxable-salve", qty: 2 }
        ]);
      }
    });
    eq(boxLost.status, 400, "a box whose member was taken is refused");
    eq(
      boxLost.data.unavailable,
      [{ id: "custom-box", reason: "member_unavailable", member: "boxable-salve" }],
      "...as member_unavailable naming the member, the shape the drawer already handles"
    );
    const fresh = await makeEnv();
    const twoBoxes = await checkout(fresh, [{ ...box, qty: 5 }], { sessionId: "cs_boxes" });
    eq(twoBoxes.status, 200, "five boxes wanted, two salves on hand: the order goes through");
    eq(
      (await inv.holdRows(fresh.STATE_DB, "cs_boxes")).map((r) => [r.product_id, r.qty]),
      [
        ["boxable-body", 2],
        ["boxable-salve", 2],
        ["boxable-soak", 2]
      ],
      "...capped to 2 boxes, holding one of each content per box"
    );

    // holdsFromAllocation on its own.
    eq(
      routes.holdsFromAllocation(
        [{ id: "tee" }, { id: "tee" }, { id: "custom-box" }, { id: "soak" }],
        [
          { qty: 2, holds: [{ productId: "tee", name: "Tee", units: 1 }] },
          { qty: 1, holds: [{ productId: "tee", name: "Tee", units: 1 }] },
          { qty: 2, holds: [{ productId: "salve", name: "Salve", units: 2 }] },
          { qty: 0, holds: [{ productId: "soak", name: "Soak", units: 1 }] }
        ],
        "custom-box"
      ),
      [
        { productId: "tee", name: "Tee", qty: 3, lineId: "tee", viaBox: false },
        { productId: "salve", name: "Salve", qty: 4, lineId: "custom-box", viaBox: true }
      ],
      "holdsFromAllocation sums per product across lines, boxes multiply units, zero lines drop"
    );

    /* FAIL OPEN. A D1 that throws on every query must leave checkout exactly
       where it was before the ledger: capped by products.json, session made. */
    const deadDb = {
      prepare() {
        throw new Error("D1_ERROR: storage unavailable");
      },
      batch() {
        throw new Error("D1_ERROR: storage unavailable");
      }
    };
    const deadEnv = await makeEnv({ STATE_DB: deadDb });
    let dead;
    const log = await capture(async () => {
      dead = await checkout(deadEnv, [{ id: "last-three-balm", qty: 5 }], { sessionId: "cs_dead" });
    });
    eq(dead.status, 200, "a dead ledger does not take checkout down");
    eq(dead.data.url, "https://checkout.stripe.com/pay/cs_dead", "...the session is made");
    assert(
      log.some((l) => l.includes("[INVENTORY]") && l.includes("falling back")),
      "...and the fallback is logged under the [INVENTORY] marker"
    );
    eq(dead.expired.length, 0, "...and nothing was unwound");

    // Reserve alone dying (seeded fine, the hold's batch dead) is the same story.
    const flakyEnv = await makeEnv();
    await inv.syncInventory(flakyEnv.STATE_DB, tracked);
    flakyEnv.STATE_DB.batch = async () => {
      throw new Error("D1_ERROR: batch failed");
    };
    let flaky;
    const flakyLog = await capture(async () => {
      flaky = await checkout(flakyEnv, [{ id: "last-three-balm", qty: 1 }], {
        sessionId: "cs_flaky"
      });
    });
    eq(flaky.status, 200, "a reserve that dies mid-write still lets the shopper pay");
    assert(
      flakyLog.some((l) => l.includes("[INVENTORY] reserving for cs_flaky failed")),
      "...and says so in the log"
    );

    // No STATE_DB at all: the static cap, silently.
    const noDb = await makeEnv({ STATE_DB: undefined });
    const unbound = await checkout(noDb, [{ id: "last-three-balm", qty: 9 }], {
      sessionId: "cs_nodb"
    });
    eq(unbound.status, 200, "without a STATE_DB binding checkout runs on products.json alone");
  }

  console.log("\n6. the webhook hooks");
  {
    const env = await makeEnv();
    await checkout(env, [{ id: "last-three-balm", qty: 3 }], { sessionId: "cs_hook" });
    const paid = {
      id: "evt_hook_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_hook",
          payment_status: "paid",
          customer_details: { email: "buyer@example.com" },
          metadata: {}
        }
      }
    };
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ""
    });
    let outcome;
    let log;
    try {
      log = await capture(async () => {
        outcome = await processStripeEvent(paid, env, noCtx).catch((err) => err.partial);
      });
    } finally {
      global.fetch = originalFetch;
    }
    eq(
      outcome.inventory.committed,
      [{ productId: "last-three-balm", qty: 3 }],
      "checkout.session.completed commits the session's hold"
    );
    eq(outcome.inventory.soldOut, ["last-three-balm"], "...and reports the sell-out");
    assert(
      log.some((l) => l.includes("[INVENTORY_SOLD_OUT]") && l.includes("last-three-balm")),
      "the zero-stock owner alert is logged under [INVENTORY_SOLD_OUT]"
    );
    assert(
      log.some((l) => l.includes("owner-alert inventory-sold-out:last-three-balm")),
      "...and handed to alertOwner (routes/alerts.js), keyed per product"
    );
    const balm = (await inv.readAvailability(env.STATE_DB, ["last-three-balm"])).get(
      "last-three-balm"
    );
    eq([balm.onHand, balm.reserved], [0, 0], "the shelf is empty");

    // Unpaid completion: nothing moves.
    const env2 = await makeEnv();
    await checkout(env2, [{ id: "single-tee", qty: 1 }], { sessionId: "cs_unpaid" });
    const unpaid = {
      ...paid,
      id: "evt_unpaid",
      data: { object: { ...paid.data.object, id: "cs_unpaid", payment_status: "unpaid" } }
    };
    const deferred = await processStripeEvent(unpaid, env2, noCtx);
    assert(deferred.deferred && !deferred.inventory, "an unpaid completion leaves the hold active");
    eq(
      (await inv.holdRows(env2.STATE_DB, "cs_unpaid"))[0].state,
      "active",
      "...still held for the async payment"
    );

    // Expiry releases.
    const expired = {
      id: "evt_exp",
      type: "checkout.session.expired",
      data: { object: { id: "cs_unpaid", metadata: {} } }
    };
    const exp = await processStripeEvent(expired, env2, noCtx).catch((err) => err.partial);
    eq(
      exp.inventory,
      { released: [{ productId: "single-tee", qty: 1 }], reason: "session_expired" },
      "checkout.session.expired releases the hold"
    );
    eq(
      (await inv.readAvailability(env2.STATE_DB, ["single-tee"])).get("single-tee").available,
      1,
      "...back on sale"
    );

    // async_payment_failed releases too.
    const env3 = await makeEnv();
    await checkout(env3, [{ id: "single-tee", qty: 1 }], { sessionId: "cs_fail" });
    const failedPay = {
      id: "evt_fail",
      type: "checkout.session.async_payment_failed",
      data: { object: { id: "cs_fail", metadata: {} } }
    };
    const fail = await processStripeEvent(failedPay, env3, noCtx).catch((err) => err.partial);
    eq(
      fail.inventory.released,
      [{ productId: "single-tee", qty: 1 }],
      "async_payment_failed releases the hold"
    );

    // Refund: full restocks, partial does not; the session comes from Stripe.
    const refundEnv = await makeEnv();
    await checkout(refundEnv, [{ id: "single-tee", qty: 1 }], { sessionId: "cs_refund" });
    await inv.commitInventory(refundEnv.STATE_DB, "cs_refund");
    const chargeOf = (extra) => ({
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_1", amount: 2000, payment_intent: "pi_1", ...extra } }
    });
    const withStripe = async (fn) => {
      const orig = global.fetch;
      global.fetch = async (url) => {
        if (String(url).includes("/v1/checkout/sessions?payment_intent=pi_1")) {
          return { ok: true, json: async () => ({ data: [{ id: "cs_refund", metadata: {} }] }) };
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      };
      try {
        return await fn();
      } finally {
        global.fetch = orig;
      }
    };
    const partial = await withStripe(() =>
      processStripeEvent(
        chargeOf({ amount_refunded: 500, refunded: false }),
        refundEnv,
        noCtx
      ).catch((e) => e.partial)
    );
    eq(
      partial.inventory,
      { restocked: [], partialRefund: true },
      "a partial refund restocks nothing"
    );
    const full = await withStripe(() =>
      processStripeEvent(
        chargeOf({ amount_refunded: 2000, refunded: true }),
        refundEnv,
        noCtx
      ).catch((e) => e.partial)
    );
    eq(
      full.inventory,
      { restocked: [{ productId: "single-tee", qty: 1 }] },
      "a full refund restocks the order"
    );
    eq(
      (await inv.readAvailability(refundEnv.STATE_DB, ["single-tee"])).get("single-tee").available,
      1,
      "...the tee is back"
    );
    const replay = await withStripe(() =>
      processStripeEvent(
        chargeOf({ amount_refunded: 2000, refunded: true }),
        refundEnv,
        noCtx
      ).catch((e) => e.partial)
    );
    eq(replay.inventory, { restocked: [] }, "a redelivered refund restocks nothing more");

    // Without STATE_DB every hook says so and the webhook carries on.
    const bare = await makeEnv({ STATE_DB: undefined });
    eq(
      await routes.commitInventoryForSession({ id: "cs_x" }, bare),
      { skipped: "no-state-db" },
      "commit without D1 is skipped"
    );
    eq(
      await routes.releaseInventoryForSession({ id: "cs_x" }, bare),
      { skipped: "no-state-db" },
      "release without D1 is skipped"
    );
    eq(
      await routes.restockInventoryForRefund({ id: "ch" }, bare),
      { skipped: "no-state-db" },
      "restock without D1 is skipped"
    );
  }

  console.log("\n7. GET /api/inventory");
  {
    const env = await makeEnv();
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("products.json")) {
        return { ok: true, clone: () => ({ body: null }), json: async () => mockCatalog };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const get = (e, ip = "1.1.1.1") =>
      worker.fetch(
        new Request("https://yallternativeliving.com/api/inventory", {
          method: "GET",
          headers: { "CF-Connecting-IP": ip }
        }),
        e,
        noCtx
      );
    try {
      await inv.syncInventory(env.STATE_DB, tracked);
      await inv.reserveInventory(env.STATE_DB, "cs_api", [{ productId: "single-tee", qty: 1 }]);
      const res = await get(env);
      eq(res.status, 200, "GET /api/inventory answers 200");
      eq(res.headers.get("Cache-Control"), "no-store", "...with Cache-Control: no-store");
      const body = await res.json();
      eq(
        body,
        {
          products: {
            "last-three-balm": { available: 3, tracked: true },
            "single-tee": { available: 0, tracked: true },
            "boxable-salve": { available: 2, tracked: true },
            "boxable-soak": { available: 9, tracked: true },
            "boxable-body": { available: 9, tracked: true }
          }
        },
        "the shape is { products: { id: { available, tracked: true } } } for tracked products only"
      );
      assert(!("lavender-soak" in body.products), "an untracked product is absent, not zero");

      const { INVENTORY_RATE_LIMIT } = routes;
      let last;
      for (let i = 0; i < INVENTORY_RATE_LIMIT.limit; i++) last = await get(env, "9.9.9.9");
      eq(
        last.status,
        200,
        `the ${INVENTORY_RATE_LIMIT.limit}th lookup in a minute is still answered`
      );
      const throttled = await get(env, "9.9.9.9");
      eq(throttled.status, 429, "...the next one is rate-limited");
      eq((await get(env, "8.8.8.8")).status, 200, "...per IP");

      const noDb = await makeEnv({ STATE_DB: undefined });
      eq(
        (await get(noDb)).status,
        503,
        "without STATE_DB the route answers 503 (the shop keeps its static count)"
      );

      const post = await worker.fetch(
        new Request("https://yallternativeliving.com/api/inventory", {
          method: "POST",
          headers: {
            Origin: "https://yallternativeliving.com",
            "Content-Type": "application/json"
          },
          body: "{}"
        }),
        env,
        noCtx
      );
      eq(
        post.status,
        200,
        "POST reaches the same handler (the route table), for a client that cannot GET"
      );
    } finally {
      global.fetch = originalFetch;
    }
  }

  /* ======================================================================
     Red team, 2026-09-09: reseed monotonicity, untrack/retrack, bind
     chunking, seed clamp, and the v7 -> v8 column migration on a live DB.
     ====================================================================== */
  {
    const db = await freshDb();
    const at = (stock) => [{ id: "guarded", stock }];
    // Seeded from a catalog served at t=100.
    await inv.syncInventory(db, at(12), 1000, 100);
    await inv.reserveInventory(db, "cs_g1", [{ productId: "guarded", qty: 3 }]);
    await inv.commitInventory(db, "cs_g1");
    // The owner corrects to 10; that catalog was served at t=300.
    inv.resetInventoryMemo();
    const corrected = await inv.syncInventory(db, at(10), 2000, 300);
    eq(corrected.changed, 1, "a newer catalog with a new count reseeds");
    // A colo still holding the pre-correction catalog (served at t=200)
    // syncs next. It used to flip the row back to 12 and erase the sale.
    inv.resetInventoryMemo();
    const stale = await inv.syncInventory(db, at(12), 3000, 200);
    eq(stale.changed, 0, "an OLDER catalog than the last reseed changes nothing");
    let row = (await inv.inventoryRows(db)).find((r) => r.product_id === "guarded");
    eq([row.on_hand, row.seed_stock, row.seed_at], [10, 10, 300], "...the correction stands");
    // The stale colo refreshes its cache (served at t=400): same 10, no-op.
    inv.resetInventoryMemo();
    eq(
      (await inv.syncInventory(db, at(10), 4000, 400)).changed,
      0,
      "a fresh copy of the same count is a no-op"
    );
    // A genuinely newer correction back to 12 (served at t=500) applies.
    inv.resetInventoryMemo();
    eq(
      (await inv.syncInventory(db, at(12), 5000, 500)).changed,
      1,
      "a newer correction, even to an old number, applies"
    );
    // No fetch time at all: the sync stamps `now`, still strictly forward.
    inv.resetInventoryMemo();
    eq(
      (await inv.syncInventory(db, at(9), 6000)).changed,
      1,
      "without a fetch time the sync uses now and still reseeds"
    );
    row = (await inv.inventoryRows(db)).find((r) => r.product_id === "guarded");
    eq(row.seed_at, 6000, "...recording now as seed_at");

    // Untrack, then re-track at the very same number: the count seeds fresh.
    const db2 = await freshDb();
    await inv.syncInventory(db2, at(12), 1000, 100);
    await inv.reserveInventory(db2, "cs_u1", [{ productId: "guarded", qty: 5 }]);
    await inv.commitInventory(db2, "cs_u1");
    inv.resetInventoryMemo();
    await inv.syncInventory(db2, [], 2000, 200);
    row = (await inv.inventoryRows(db2)).find((r) => r.product_id === "guarded");
    eq(
      row.seed_stock,
      inv.UNTRACKED_SEED,
      "a product the catalog stopped tracking is marked untracked"
    );
    eq(row.on_hand, 7, "...its count is left alone while untracked");
    inv.resetInventoryMemo();
    const retracked = await inv.syncInventory(db2, at(12), 3000, 300);
    eq(retracked.changed, 1, "tracking it again at the old number seeds fresh");
    row = (await inv.inventoryRows(db2)).find((r) => r.product_id === "guarded");
    eq([row.on_hand, row.seed_stock], [12, 12], "...to exactly what the owner typed");

    // D1 binds at most 100 parameters per statement.
    const db3 = await freshDb();
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, stock: i + 1 }));
    const bulk = await inv.syncInventory(db3, many, 1000, 100);
    eq(bulk.changed, 150, "150 tracked products seed in one sync");
    const avail = await inv.readAvailability(
      db3,
      many.map((p) => p.id)
    );
    eq(avail.size, 150, "...and are read back across chunks");
    eq(avail.get("p149").available, 150, "...with the right counts");

    // A typo of a count is not a shelf.
    eq(
      inv.trackedProductsOf([{ id: "big", stock: 1e300 }])[0].stock,
      inv.MAX_SEED_STOCK,
      "an absurd stock is clamped to the ceiling"
    );

    // The live database is at v7 (no seed_at / synced_at); v8 must add them.
    const { applyMigrations, resetSchemaMemo, SCHEMA_VERSION } =
      await import("../workers/state/migrations.js");
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1, 7, 0);
      CREATE TABLE inventory (product_id TEXT PRIMARY KEY, on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
        seed_stock INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO inventory VALUES ('legacy', 5, 0, 5, 0);`);
    const db4 = makeD1(raw);
    resetSchemaMemo();
    const migrated = await applyMigrations(db4, 7777);
    eq(
      [migrated.applied, migrated.version],
      [true, SCHEMA_VERSION],
      "a v7 database migrates to the current version"
    );
    const cols = raw
      .prepare("PRAGMA table_info(inventory)")
      .all()
      .map((c) => c.name);
    assert(
      cols.includes("seed_at") && cols.includes("synced_at"),
      "...gaining seed_at and synced_at"
    );
    resetSchemaMemo();
    const twice = await applyMigrations(db4, 7778);
    eq(twice.applied, false, "...and a second run is a no-op (no duplicate-column failure)");
    inv.resetInventoryMemo();
    eq(
      (await inv.syncInventory(db4, [{ id: "legacy", stock: 5 }], 8000, 100)).changed,
      0,
      "a migrated row with the same count is untouched"
    );
    inv.resetInventoryMemo();
    eq(
      (await inv.syncInventory(db4, [{ id: "legacy", stock: 7 }], 9000, 200)).changed,
      1,
      "...and a correction after migration reseeds (seed_at started at 0)"
    );
  }

  console.log(`\nworker-inventory.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
