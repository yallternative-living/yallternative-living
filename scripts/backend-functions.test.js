/**
 * @fileoverview Unit test suite for the Cloudflare Workers:
 *   - workers/checkout.js    (catalog pricing, variants, bundles, custom boxes,
 *                             volume pricing, shipping, tax, pickup, gift-card
 *                             metadata, and the gift-card redemption path)
 *   - workers/submit-form.js (contact form)
 *
 * netlify/functions/* is GONE. Its four handlers are Worker routes now
 * (workers/routes/*), for the reasons in docs/STATE-LAYER.md: the gift-card
 * ledger and the exactly-once webhook claim live in Cloudflare Durable Objects
 * and D1, which a Netlify Function cannot reach, and audit H-23 notes the
 * Netlify free plan pauses every project -- the Stripe webhook included -- at
 * its monthly credit cap.
 *
 * The cases that were about those files and are still worth having moved with
 * the code they test:
 *   - Stripe signature verification, gift-card code derivation and
 *     determinism, HTML escaping in the gift-card emails, and email
 *     idempotency  -> scripts/worker-state.test.js (section 11)
 *   - the balance lookup's "a spent card and an unknown code are
 *     indistinguishable" rule -> scripts/worker-state.test.js (section 10) and
 *     scripts/adversarial-stress.test.js (R7.5)
 *   - restock honeypot, validation, escaping and the 503-with-no-mailer rule
 *     -> scripts/worker-state.test.js (section 13)
 * Nothing was dropped to make this file pass.
 *
 * Run: node scripts/backend-functions.test.js
 */

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

/* Synchronous sibling of throwsAsync, for helpers that throw immediately
   (resolveCustomBoxCents validates and prices in one synchronous pass). */
function throws(fn, expectedSubstr, label) {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label} (expected throw, but function succeeded)`);
  } catch (err) {
    if (!expectedSubstr || err.message.includes(expectedSubstr)) {
      passed++;
    } else {
      failed++;
      console.error(
        `  ✗ ${label}\n      expected error containing "${expectedSubstr}"\n      got message "${err.message}"`
      );
    }
  }
}

async function throwsAsync(fn, expectedSubstr, label) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${label} (expected throw, but function succeeded)`);
  } catch (err) {
    if (!expectedSubstr || err.message.includes(expectedSubstr)) {
      passed++;
    } else {
      failed++;
      console.error(
        `  ✗ ${label}\n      expected error containing "${expectedSubstr}"\n      got message "${err.message}"`
      );
    }
  }
}

console.log("Running backend-functions unit tests...\n");

/* ==========================================================
   1. The Worker modules (workers/checkout.js & workers/submit-form.js)
   ========================================================== */
async function testWorkerModules() {
  const checkout = await import("../workers/checkout.js");
  const submitForm = await import("../workers/submit-form.js");

  // submit-form: escapeHtml
  eq(
    submitForm.escapeHtml('<a href="x">Test & "More"</a>'),
    "&lt;a href=&quot;x&quot;&gt;Test &amp; &quot;More&quot;&lt;/a&gt;",
    "submitForm.escapeHtml escapes HTML chars"
  );

  // submit-form: corsHeaders
  const corsEnv = { SITE_ORIGIN: "https://yallternativeliving.com" };
  const okCors = submitForm.corsHeaders("https://yallternativeliving.com", corsEnv);
  eq(
    okCors["Access-Control-Allow-Origin"],
    "https://yallternativeliving.com",
    "corsHeaders reflects an allowed origin"
  );
  eq(okCors["Vary"], "Origin", "corsHeaders sets Vary: Origin");
  assert(
    okCors["Access-Control-Allow-Methods"].includes("POST"),
    "corsHeaders allows the POST method"
  );
  const evilCors = submitForm.corsHeaders("https://evil.example", corsEnv);
  assert(
    evilCors["Access-Control-Allow-Origin"] !== "https://evil.example",
    "corsHeaders does not echo a disallowed origin back"
  );

  // mock catalog
  const mockCatalog = {
    products: [
      {
        id: "beard-salve",
        price: 16.0,
        originalPrice: 18.0,
        variants: { options: [{ label: "Large", priceDelta: 4.0 }] }
      },
      { id: "body-soak", price: 12.0 }
    ],
    bundles: [
      { id: "relax-set", productIds: ["beard-salve", "body-soak"], discountPercent: 10 },
      { id: "broken-set", productIds: ["non-existent-item"], discountPercent: 10 }
    ]
  };

  // findEntry
  eq(
    checkout.findEntry(mockCatalog, "beard-salve"),
    mockCatalog.products[0],
    "findEntry finds product"
  );
  eq(
    checkout.findEntry(mockCatalog, "bundle-relax-set"),
    mockCatalog.bundles[0],
    "findEntry finds bundle with bundle- prefix"
  );
  eq(
    checkout.findEntry(mockCatalog, "relax-set"),
    mockCatalog.bundles[0],
    "findEntry finds bundle without bundle- prefix"
  );
  eq(
    checkout.findEntry(mockCatalog, "unknown-item"),
    null,
    "findEntry returns null for unknown item"
  );

  // resolveBundlePriceDollars
  // Full price sum = beard-salve originalPrice (18) + body-soak price (12) = 30. Discount 10% = 27.00
  eq(
    checkout.resolveBundlePriceDollars(mockCatalog, mockCatalog.bundles[0]),
    27.0,
    "resolveBundlePriceDollars computes discounted price"
  );
  eq(
    checkout.resolveBundlePriceDollars(mockCatalog, mockCatalog.bundles[1]),
    null,
    "resolveBundlePriceDollars returns null for missing product ID"
  );
  eq(
    checkout.resolveBundlePriceDollars(mockCatalog, {}),
    null,
    "resolveBundlePriceDollars returns null for empty bundle"
  );

  /* resolveCustomBoxCents -- build-your-own box.
     The contents come from the client, so these cases are the security
     boundary: every one of them must fail closed rather than produce a
     cheap box. */
  const boxCatalog = {
    shop: {
      customBox: {
        minItems: 2,
        maxItems: 3,
        discountPercent: 10,
        eligibleCategories: ["salves", "soaks"]
      }
    },
    products: [
      { id: "salve-a", price: 10.0, category: "salves" },
      { id: "salve-b", price: 20.0, category: "salves" },
      { id: "soak-a", price: 30.0, category: "soaks" },
      { id: "tee", price: 25.0, category: "apparel" },
      { id: "future-salve", price: 15.0, category: "salves", comingSoon: true }
    ]
  };

  // 10 + 20 = 30, less 10% = 27.00 -> 2700 cents
  eq(
    checkout.resolveCustomBoxCents(boxCatalog, ["salve-a", "salve-b"]),
    2700,
    "resolveCustomBoxCents prices a valid box from real product prices"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, ["salve-a"]),
    "between",
    "resolveCustomBoxCents rejects a box below minItems"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, ["salve-a", "salve-b", "soak-a", "salve-a"]),
    "between",
    "resolveCustomBoxCents rejects a box above maxItems"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, ["salve-a", "tee"]),
    "Not eligible",
    "resolveCustomBoxCents rejects an ineligible category"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, ["salve-a", "made-up-id"]),
    "not found",
    "resolveCustomBoxCents rejects an unknown product id"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, ["salve-a", "future-salve"]),
    "Not available yet",
    "resolveCustomBoxCents rejects a coming-soon product"
  );
  throws(
    () => checkout.resolveCustomBoxCents({ products: [] }, ["salve-a", "salve-b"]),
    "not enabled",
    "resolveCustomBoxCents fails closed when customBox is unconfigured"
  );
  throws(
    () => checkout.resolveCustomBoxCents(boxCatalog, []),
    "empty",
    "resolveCustomBoxCents rejects an empty box"
  );
  // A mistyped discount in the CMS must not be able to produce a negative line.
  eq(
    checkout.resolveCustomBoxCents(
      {
        shop: { customBox: { minItems: 1, maxItems: 3, discountPercent: 500 } },
        products: [{ id: "salve-a", price: 10.0, category: "salves" }]
      },
      ["salve-a"]
    ),
    100,
    "resolveCustomBoxCents clamps an absurd discount to 90%"
  );

  // resolveUnitAmountCents
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[1], null, false),
    1200,
    "resolveUnitAmountCents standard product (no variants to choose)"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[0], "Large", false),
    2000,
    "resolveUnitAmountCents product with variant delta"
  );
  // A label the catalog doesn't list is NOT purchasable. It used to fall
  // back to the base price, i.e. sell a product at a size/price combination
  // no page ever offered and give fulfilment a size that doesn't exist.
  eq(
    checkout.resolveUnitAmountCents(
      mockCatalog,
      mockCatalog.products[0],
      "NonExistentVariant",
      false
    ),
    null,
    "resolveUnitAmountCents rejects an unknown variant instead of repricing it"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[0], null, false),
    null,
    "resolveUnitAmountCents rejects a variant product ordered with no variant"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[0], "  large ", false),
    2000,
    "resolveUnitAmountCents normalizes case and surrounding whitespace"
  );
  // Matching for the catalog label, and the option object behind it.
  eq(
    checkout.findVariantOption(mockCatalog.products[0], "LARGE").label,
    "Large",
    "findVariantOption returns the catalog's own option for a normalized label"
  );
  eq(
    checkout.findVariantOption(mockCatalog.products[0], "24 oz "),
    null,
    "findVariantOption rejects a label that is not on the option list"
  );
  eq(
    checkout.findVariantOption({ variants: { options: [] } }, "Large"),
    null,
    "findVariantOption is null-safe for an empty option list"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.bundles[0], null, true),
    2700,
    "resolveUnitAmountCents bundle product"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, {}, null, false),
    null,
    "resolveUnitAmountCents null for missing price"
  );

  const salveCatalog = {
    products: [
      {
        id: "frankincense-salve",
        price: 20,
        category: "salves",
        variants: {
          name: "Size",
          options: [
            { label: "2oz", priceDelta: 0 },
            { label: "1oz", priceDelta: -6.0 }
          ]
        }
      },
      // Volume-rule matching now reads the catalog only (F11: no client
      // `category`, no per-id hardcodes), so a variant-less salve qualifies
      // on its own catalog copy -- exactly as products.json describes it.
      {
        id: "sleep-salve",
        name: "Hush Y'all Magnesium Arnica Sleep Salve",
        blurb: "A 2oz tin of magnesium and arnica.",
        price: 20,
        category: "salves"
      },
      { id: "beard-salve", price: 14.0, category: "body" },
      { id: "miracle-balm", name: "Y'allternative Miracle Balm", price: 8.0, category: "salves" }
    ],
    bundles: []
  };

  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[0], "2oz", false, 1),
    2000,
    "resolveUnitAmountCents 1x 2oz Frankincense (single unit) is 2000 cents"
  );
  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[0], "2oz", false, 2),
    1500,
    "resolveUnitAmountCents 2x 2oz Frankincense (volume tier) is 1500 cents"
  );
  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[0], "1oz", false, 2),
    1400,
    "resolveUnitAmountCents 1oz Frankincense is 1400 cents (excluded from volume tier)"
  );
  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[1], null, false, 2),
    1500,
    "resolveUnitAmountCents 2oz Sleep Salve (volume tier) is 1500 cents"
  );
  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[2], null, false, 2),
    1400,
    "resolveUnitAmountCents Beard Salve (body category) remains 1400 cents"
  );
  eq(
    checkout.resolveUnitAmountCents(salveCatalog, salveCatalog.products[3], null, false, 2),
    800,
    "resolveUnitAmountCents Miracle Balm (.5oz) remains 800 cents"
  );

  // loadCatalog error path
  const globalFetch = global.fetch;
  global.fetch = async () => ({ ok: false });
  await throwsAsync(
    () => checkout.loadCatalog({ SITE_ORIGIN: "https://yallternativeliving.com" }, null),
    "Could not load product catalog",
    "loadCatalog throws when fetch is not ok"
  );
  global.fetch = globalFetch;

  // submit-form Worker fetch handler error paths
  const env = {
    SITE_ORIGIN: "https://yallternativeliving.com",
    TURNSTILE_SECRET_KEY: "test_secret",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "from@example.com",
    TO_EMAIL: "to@example.com"
  };

  // 1. Non-POST
  let req = new Request("https://yallternativeliving.com/submit", { method: "GET" });
  let res = await submitForm.default.fetch(req, env);
  eq(res.status, 405, "submitFormWorker returns 405 for GET");

  // 2. Forbidden origin
  req = new Request("https://yallternativeliving.com/submit", {
    method: "POST",
    headers: { Origin: "https://malicious-site.com" }
  });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 403, "submitFormWorker returns 403 for forbidden origin");

  // 3. Honeypot filled (returns 200 early success)
  let formData = new FormData();
  formData.append("website_hp", "bot-input");
  req = new Request("https://yallternativeliving.com/submit", { method: "POST", body: formData });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 200, "submitFormWorker honeypot returns 200 early success");

  // 4. Missing required fields
  formData = new FormData();
  formData.append("name", "Sam");
  req = new Request("https://yallternativeliving.com/submit", { method: "POST", body: formData });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 400, "submitFormWorker returns 400 for missing fields");

  // 5. Invalid email format
  formData = new FormData();
  formData.append("name", "Sam");
  formData.append("email", "not-an-email");
  formData.append("message", "Hello");
  req = new Request("https://yallternativeliving.com/submit", { method: "POST", body: formData });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 400, "submitFormWorker returns 400 for invalid email format");

  // 6. Turnstile failure
  global.fetch = async (url) => {
    if (url.includes("turnstile")) return { json: async () => ({ success: false }) };
    return { ok: true };
  };
  formData = new FormData();
  formData.append("name", "Sam");
  formData.append("email", "sam@example.com");
  formData.append("message", "Hello world");
  req = new Request("https://yallternativeliving.com/submit", { method: "POST", body: formData });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 400, "submitFormWorker returns 400 when Turnstile verification fails");

  // 7. Resend email delivery failure
  global.fetch = async (url) => {
    if (url.includes("turnstile")) return { json: async () => ({ success: true }) };
    if (url.includes("resend")) return { ok: false };
    return { ok: true };
  };
  req = new Request("https://yallternativeliving.com/submit", { method: "POST", body: formData });
  res = await submitForm.default.fetch(req, env);
  eq(res.status, 500, "submitFormWorker returns 500 when Resend delivery fails");

  global.fetch = globalFetch;

  /* ==========================================================
     6. checkout.js Stripe Tax wiring (STRIPE_TAX_ENABLED)
     Drives the real fetch handler with a stubbed catalog + Stripe endpoint
     and inspects the form body actually posted to Stripe. The tax path can
     never be exercised against live Stripe from CI, so asserting on the
     outgoing request is the only way to catch a regression here before it
     reaches a real card. Every assertion below maps to a rule in the
     "Sales tax" block of workers/checkout.js's header comment.
     ========================================================== */
  const taxCatalog = {
    products: [
      { id: "beard-salve", price: 16.0, category: "body" },
      { id: "unisex-tshirt", price: 25.0, category: "apparel" },
      { id: "yallternative-gift-card", price: 25.0, category: "gift-cards" }
    ],
    bundles: [],
    shop: {
      customBox: {
        minItems: 3,
        maxItems: 5,
        discountPercent: 10,
        eligibleCategories: ["salves", "body", "soaks", "potions", "ritual"]
      }
    }
  };

  const taxEvents = {
    upcoming: [
      {
        dateLabel: "October 17, 2026",
        name: "Autumn Apothecary Faire",
        location: "Landrum, SC",
        zip: "29356"
      },
      // Deliberately ZIP-less: must fall back rather than guess a rate.
      { dateLabel: "November 2, 2026", name: "No Zip Market", location: "Greer, SC" },
      // Out of state, to prove the state isn't hardcoded to SC.
      {
        dateLabel: "December 1, 2026",
        name: "Flat Rock Fair",
        location: "Flat Rock, NC",
        zip: "28731"
      }
    ],
    past: []
  };

  // Runs one checkout and hands back the params Stripe would have received,
  // plus anything posted to /v1/customers along the way.
  async function captureStripeParams(items, extraEnv, body) {
    let captured = null;
    let customerParams = null;
    const opts2 = {
      eventsOk: true,
      customerOk: true,
      // Mirrors an account that has finished Stripe Tax setup. Individual
      // tests flip this to "pending" or make the probe fail outright.
      taxSettings: { ok: true, status: "active" },
      ...(extraEnv || {})._stub
    };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/v1/tax/settings")) {
        if (!opts2.taxSettings.ok) return { ok: false };
        return { ok: true, json: async () => ({ status: opts2.taxSettings.status }) };
      }
      if (u.includes("products.json")) {
        const catalog = opts2.catalog
          ? opts2.catalog
          : opts2.shop
            ? { ...taxCatalog, shop: { ...taxCatalog.shop, ...opts2.shop } }
            : taxCatalog;
        return { ok: true, clone: () => ({ body: null }), json: async () => catalog };
      }
      if (u.includes("events.json")) {
        if (!opts2.eventsOk) return { ok: false };
        return { ok: true, clone: () => ({ body: null }), json: async () => taxEvents };
      }
      if (u.includes("/v1/customers")) {
        customerParams = new URLSearchParams(opts.body);
        if (!opts2.customerOk) return { ok: false };
        return { ok: true, json: async () => ({ id: "cus_test123" }) };
      }
      captured = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ url: "https://checkout.stripe.com/c/test" }) };
    };
    const req = new Request("https://yallternativeliving.com/api/checkout", {
      method: "POST",
      headers: { Origin: "https://yallternativeliving.com", "Content-Type": "application/json" },
      body: JSON.stringify({ items, ...(body || {}) })
    });
    const cleanEnv = { ...extraEnv };
    delete cleanEnv._stub;
    await checkout.default.fetch(
      req,
      {
        SITE_ORIGIN: "https://yallternativeliving.com",
        STRIPE_SECRET_KEY: "sk_test_x",
        ...cleanEnv
      },
      null
    );
    global.fetch = globalFetch;
    return { params: captured, customerParams };
  }

  // Most assertions only care about the Checkout Session body.
  const captureParams = async (items, extraEnv, body) =>
    (await captureStripeParams(items, extraEnv, body)).params;

  // Tax switches itself on/off from the account's own Stripe Tax status, so
  // finishing registration in the Dashboard is the whole switch. The
  // critical direction is the failure one: anything uncertain must resolve
  // to OFF, because sending automatic_tax while Tax is `pending` makes
  // Stripe reject the session outright -- a lost sale, not a missing line.
  const pending = { _stub: { taxSettings: { ok: true, status: "pending" } } };
  const probeDown = { _stub: { taxSettings: { ok: false } } };

  let p = await captureParams([{ id: "beard-salve", qty: 1 }], pending);
  eq(p.get("automatic_tax[enabled]"), null, "Tax pending: no automatic_tax");
  eq(p.get("customer_creation"), null, "Tax pending: no customer_creation");
  eq(p.get("billing_address_collection"), "auto", "Tax pending: billing stays auto");
  eq(
    p.get("line_items[0][price_data][product_data][tax_code]"),
    null,
    "Tax pending: no tax_code on line items"
  );

  p = await captureParams([{ id: "beard-salve", qty: 1 }], probeDown);
  eq(p.get("automatic_tax[enabled]"), null, "Tax probe unreachable: fails closed");

  // Active account, no env var set at all -- this is the whole point.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {});
  eq(
    p.get("automatic_tax[enabled]"),
    "true",
    "Tax active: enables itself with no env var and no redeploy"
  );

  // Overrides win over the probe in both directions.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    STRIPE_TAX_ENABLED: "false"
  });
  eq(p.get("automatic_tax[enabled]"), null, '"false" is a kill switch even when Tax is active');
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    STRIPE_TAX_ENABLED: "off"
  });
  eq(p.get("automatic_tax[enabled]"), null, '"off" also disables');
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    STRIPE_TAX_ENABLED: "TRUE",
    ...pending
  });
  eq(
    p.get("automatic_tax[enabled]"),
    "true",
    '"TRUE" forces tax on without probing (case-insensitive)'
  );
  // An unrecognised value must not be read as "on" -- it falls back to auto.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    STRIPE_TAX_ENABLED: "yes",
    ...pending
  });
  eq(p.get("automatic_tax[enabled]"), null, '"yes" is not treated as on; falls back to auto');
  p = await captureParams([{ id: "beard-salve", qty: 1 }], { STRIPE_TAX_ENABLED: "auto" });
  eq(p.get("automatic_tax[enabled]"), "true", '"auto" probes and enables when active');

  // The probe must never leak the API key into a cache key or elsewhere.
  {
    let taxProbeAuth = null;
    const savedFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes("/v1/tax/settings")) {
        taxProbeAuth = opts.headers.Authorization;
        return { ok: true, json: async () => ({ status: "active" }) };
      }
      return { ok: false };
    };
    const active = await checkout.isTaxEnabled(
      { STRIPE_SECRET_KEY: "sk_test_x", SITE_ORIGIN: "https://yallternativeliving.com" },
      null
    );
    global.fetch = savedFetch;
    eq(active, true, "isTaxEnabled reports active straight from Stripe");
    eq(taxProbeAuth, "Bearer sk_test_x", "isTaxEnabled authenticates the probe");
  }

  // An unreadable cache entry must fall through and re-probe.
  {
    const savedCaches = global.caches;
    const savedFetch = global.fetch;
    global.caches = {
      default: {
        match: async () => ({
          json: async () => {
            throw new Error("unreadable cache");
          }
        })
      }
    };
    let fetchCalled = false;
    global.fetch = async (url) => {
      if (String(url).includes("/v1/tax/settings")) {
        fetchCalled = true;
        return { ok: true, json: async () => ({ status: "active" }) };
      }
      return { ok: false };
    };
    const active = await checkout.isTaxEnabled(
      { STRIPE_SECRET_KEY: "sk_test_x", SITE_ORIGIN: "https://yallternativeliving.com" },
      null
    );
    global.caches = savedCaches;
    global.fetch = savedFetch;
    eq(active, true, "isTaxEnabled falls back to probe when cache entry is unreadable");
    eq(fetchCalled, true, "isTaxEnabled hits the network when cache entry is unreadable");
  }

  // On: physical order.
  p = await captureParams([{ id: "beard-salve", qty: 2 }], { STRIPE_TAX_ENABLED: "true" });
  eq(p.get("automatic_tax[enabled]"), "true", "tax on: automatic_tax enabled");
  eq(p.get("customer_creation"), "always", "tax on: customer_creation always");
  eq(p.get("billing_address_collection"), "required", "tax on: billing address required");
  eq(
    p.get("line_items[0][price_data][tax_behavior]"),
    "exclusive",
    "tax on: prices are tax-exclusive"
  );
  eq(
    p.get("line_items[0][price_data][product_data][tax_code]"),
    "txcd_99999999",
    "tax on: salve gets general tangible goods code"
  );
  eq(
    p.get("shipping_options[0][shipping_rate_data][tax_code]"),
    "txcd_92010001",
    "tax on: shipping carries the shipping tax code"
  );
  eq(
    p.get("shipping_options[0][shipping_rate_data][tax_behavior]"),
    "exclusive",
    "tax on: shipping is tax-exclusive"
  );

  // Apparel gets its own code -- states that exempt clothing rely on it.
  p = await captureParams([{ id: "unisex-tshirt", qty: 1, variant: "M" }], {
    STRIPE_TAX_ENABLED: "true"
  });
  eq(
    p.get("line_items[0][price_data][product_data][tax_code]"),
    "txcd_30011000",
    "tax on: apparel gets the clothing tax code"
  );

  // Gift cards must NOT be taxed at purchase -- they're taxed on redemption.
  // Using the goods code here would tax the same money twice.
  p = await captureParams([{ id: "yallternative-gift-card", qty: 1, variant: "Preset $50" }], {
    STRIPE_TAX_ENABLED: "true"
  });
  eq(
    p.get("line_items[0][price_data][product_data][tax_code]"),
    "txcd_10502000",
    "tax on: gift card gets the gift-card tax code"
  );
  eq(
    p.get("shipping_options[0][shipping_rate_data][tax_code]"),
    null,
    "tax on: all-gift-card order has no shipping line to tax"
  );
  eq(
    p.get("billing_address_collection"),
    "required",
    "tax on: gift-card-only order still collects an address to rate against"
  );

  // A custom box is always apothecary goods (apparel/gift cards aren't
  // eligible categories), so it takes the general goods code.
  p = await captureParams(
    [{ id: "custom-box", qty: 1, boxProductIds: ["beard-salve", "beard-salve", "beard-salve"] }],
    { STRIPE_TAX_ENABLED: "true" }
  );
  eq(
    p.get("line_items[0][price_data][product_data][tax_code]"),
    "txcd_99999999",
    "tax on: custom box gets general tangible goods code"
  );

  // Gift-card redemption codes stay enabled with tax on. Stripe applies the
  // discount to the subtotal first and then rates the reduced amount (see
  // https://docs.stripe.com/tax/calculating -- "Stripe Tax calculates tax
  // after applying discounts"), so this combination is well-defined; see
  // DEVELOPMENT.md section 18 for what that means for gift cards.
  eq(p.get("allow_promotion_codes"), "true", "tax on: promotion codes still allowed");

  /* ==========================================================
     6b. Free-shipping threshold follows the CMS, not a constant
     shop.freeShippingThreshold in products.json drives the announcement
     bar, the product cards and the cart drawer's progress meter. If the
     Worker keeps its own copy, raising the threshold in /admin changes
     every promise on the site while Stripe silently keeps waiving shipping
     at the old number -- checkout contradicting the page that sold it.
     ========================================================== */
  const shipAmount = (params) =>
    params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]");
  const shipName = (params) => params.get("shipping_options[0][shipping_rate_data][display_name]");

  // Pure resolver: dollars -> cents, with the client's own fallback rules.
  eq(
    checkout.resolveFreeShippingThresholdCents({ shop: { freeShippingThreshold: 40 } }),
    4000,
    "resolveFreeShippingThresholdCents converts dollars to cents"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents({ shop: { freeShippingThreshold: 74.5 } }),
    7450,
    "resolveFreeShippingThresholdCents handles a fractional threshold"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents({ shop: {} }),
    4000,
    "resolveFreeShippingThresholdCents falls back when the field is missing"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents({}),
    4000,
    "resolveFreeShippingThresholdCents falls back when shop is missing"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents(null),
    4000,
    "resolveFreeShippingThresholdCents is null-safe"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents({ shop: { freeShippingThreshold: "nope" } }),
    4000,
    "resolveFreeShippingThresholdCents falls back on a non-numeric value"
  );
  eq(
    checkout.resolveFreeShippingThresholdCents({ shop: { freeShippingThreshold: 0 } }),
    0,
    'resolveFreeShippingThresholdCents treats 0 as "disabled", not as the default'
  );

  // End to end: a raised threshold has to reach the Stripe session.
  // $16 salve x 3 = $48: free under the default $40, charged under a $75
  // threshold. If the Worker were still hardcoded, this line would be free.
  p = await captureParams([{ id: "beard-salve", qty: 3 }], {
    _stub: { shop: { freeShippingThreshold: 75 } }
  });
  eq(shipAmount(p), "1000", "raised threshold: $48 order is below $75, so shipping is charged");
  eq(shipName(p), "Standard shipping", "raised threshold: shipping line is named as charged");

  p = await captureParams([{ id: "beard-salve", qty: 5 }], {
    _stub: { shop: { freeShippingThreshold: 75 } }
  });
  eq(shipAmount(p), "0", "raised threshold: $80 order clears $75 and ships free");
  eq(shipName(p), "Free shipping", "raised threshold: free line is named as free");

  // Lowered threshold, the same order: now free where the old constant charged.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    _stub: { shop: { freeShippingThreshold: 15 } }
  });
  eq(shipAmount(p), "0", "lowered threshold: $16 order clears $15 and ships free");

  // Exactly at the threshold counts as qualifying -- "orders over $X" on the
  // site has always meant the meter filling at $X in the cart drawer.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    _stub: { shop: { freeShippingThreshold: 16 } }
  });
  eq(shipAmount(p), "0", "threshold: an order exactly at the threshold ships free");

  // 0 = "Set to 0 to disable" (admin/config.yml). Nothing qualifies, however
  // large -- matching the announcement bar, which hides the promise entirely.
  p = await captureParams([{ id: "beard-salve", qty: 10 }], {
    _stub: { shop: { freeShippingThreshold: 0 } }
  });
  eq(shipAmount(p), "1000", "threshold 0: free shipping disabled even on a $160 order");

  // Missing/garbage config must not make shipping free by accident.
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {});
  eq(shipAmount(p), "1000", "no threshold configured: falls back to $40, so $16 is charged");
  p = await captureParams([{ id: "beard-salve", qty: 3 }], {});
  eq(shipAmount(p), "0", "no threshold configured: falls back to $40, so $48 ships free");
  p = await captureParams([{ id: "beard-salve", qty: 1 }], {
    _stub: { shop: { freeShippingThreshold: "forty" } }
  });
  eq(shipAmount(p), "1000", "non-numeric threshold: falls back rather than shipping free");

  // Gift cards never count toward the physical subtotal, whatever the
  // threshold is -- an emailed card can't push an order into free shipping.
  p = await captureParams(
    [
      { id: "beard-salve", qty: 1 },
      { id: "yallternative-gift-card", qty: 1, variant: "Preset $100" }
    ],
    { _stub: { shop: { freeShippingThreshold: 40 } } }
  );
  eq(shipAmount(p), "1000", "gift cards don't count toward the free-shipping threshold");

  /* ==========================================================
     7. Market pickup is taxed where the order is collected
     SC (like most states) sources tax to the point of delivery, so a market
     pickup belongs to the market's county, not the buyer's home county --
     a difference of up to ~2%. These assertions cover the happy path and,
     more importantly, every way it can degrade: all of them must fall back
     to the ordinary buyer-address flow rather than fail a sale.
     ========================================================== */
  const marketLabel = "Autumn Apothecary Faire — October 17, 2026 (Landrum, SC)";

  // The label sent by the client is re-derived from events.json, never
  // trusted -- same rule prices follow.
  eq(
    checkout.pickupLabelFor(taxEvents.upcoming[0]),
    marketLabel,
    "pickupLabelFor rebuilds the exact label cart.js renders"
  );
  eq(
    checkout.resolvePickupAddress(taxEvents, marketLabel),
    { state: "SC", postal_code: "29356", country: "US" },
    "resolvePickupAddress finds the market address"
  );
  eq(
    checkout.resolvePickupAddress(taxEvents, "Made Up Market — (Nowhere, SC)"),
    null,
    "resolvePickupAddress rejects a label not on the calendar"
  );
  eq(
    checkout.resolvePickupAddress(taxEvents, "No Zip Market — November 2, 2026 (Greer, SC)"),
    null,
    "resolvePickupAddress returns null when the market has no ZIP"
  );
  eq(
    checkout.resolvePickupAddress(taxEvents, "Flat Rock Fair — December 1, 2026 (Flat Rock, NC)"),
    { state: "NC", postal_code: "28731", country: "US" },
    "resolvePickupAddress reads the state off the location, not hardcoded SC"
  );
  eq(checkout.resolvePickupAddress(taxEvents, null), null, "resolvePickupAddress null-safe");
  eq(
    checkout.resolvePickupAddress(null, marketLabel),
    null,
    "resolvePickupAddress handles no events"
  );

  // Happy path: Customer carries the market address, and no shipping address
  // is collected -- a collected one would override it.
  let r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true" },
    { pickupMarket: marketLabel }
  );
  eq(
    r.customerParams.get("shipping[address][postal_code]"),
    "29356",
    "pickup: customer gets market ZIP"
  );
  eq(r.customerParams.get("shipping[address][state]"), "SC", "pickup: customer gets market state");
  eq(r.customerParams.get("shipping[address][country]"), "US", "pickup: customer address is US");
  eq(r.params.get("customer"), "cus_test123", "pickup: session uses the pinned customer");
  eq(r.params.get("customer_creation"), null, "pickup: no customer_creation alongside customer");
  eq(
    r.params.get("customer_update[address]"),
    "never",
    "pickup: billing address must not overwrite the pinned market address"
  );
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    null,
    "pickup: no shipping address collected (it would win over the market)"
  );
  eq(r.params.get("automatic_tax[enabled]"), "true", "pickup: tax still enabled");

  // Market with no ZIP recorded -> ordinary flow, no guessed rate.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true" },
    { pickupMarket: "No Zip Market — November 2, 2026 (Greer, SC)" }
  );
  eq(r.customerParams, null, "pickup without a ZIP: no customer created");
  eq(r.params.get("customer_creation"), "always", "pickup without a ZIP: normal customer flow");
  // The market is real, it just has no ZIP to rate against, so tax falls back
  // to the buyer's billing address. It is still a pickup: nothing ships, so
  // no delivery address is collected and no shipping line is added.
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    null,
    "pickup without a ZIP: still a pickup, so no shipping address is collected"
  );
  eq(
    r.params.get("metadata[pickup_market]"),
    "No Zip Market — November 2, 2026 (Greer, SC)",
    "pickup without a ZIP: the market is still recorded for the packing list"
  );

  // events.json unreachable must never block a sale.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true", _stub: { eventsOk: false } },
    { pickupMarket: marketLabel }
  );
  eq(r.params.get("customer"), null, "events.json down: no pinned customer");
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    "US",
    "events.json down: checkout still completes via the normal flow"
  );

  // Customer creation failing must also degrade, not throw.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true", _stub: { customerOk: false } },
    { pickupMarket: marketLabel }
  );
  eq(r.params.get("customer"), null, "customer create fails: no pinned customer");
  eq(r.params.get("customer_creation"), "always", "customer create fails: normal flow resumes");

  // A forged label can't smuggle in a cheaper jurisdiction -- and, since it
  // isn't a pickup at all, can't waive shipping either.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true" },
    { pickupMarket: "Fake Market — (Portland, OR)" }
  );
  eq(r.customerParams, null, "forged pickup label: no customer created");
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    "US",
    "forged pickup label: falls back to the buyer's real address"
  );
  eq(
    r.params.get("metadata[pickup_market]"),
    null,
    "forged pickup label: never recorded as a market on the order"
  );
  eq(
    r.params.get("metadata[pickup_market_rejected]"),
    "true",
    "forged pickup label: flagged as rejected in metadata"
  );
  eq(
    r.params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
    "1000",
    "forged pickup label: still pays shipping (it used to waive it for free)"
  );

  // Tax off is exactly the case that used to skip pickup validation
  // altogether: a real market is honoured, and still no address is collected.
  r = await captureStripeParams([{ id: "beard-salve", qty: 1 }], pending, {
    pickupMarket: marketLabel
  });
  eq(r.customerParams, null, "tax off: pickup does not create a customer");
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    null,
    "tax off: an honoured pickup collects no shipping address"
  );
  eq(
    r.params.get("metadata[pickup_market]"),
    marketLabel,
    "tax off: the market is validated and recorded"
  );

  // ... and an invented one is still rejected with tax off.
  r = await captureStripeParams([{ id: "beard-salve", qty: 1 }], pending, {
    pickupMarket: "Fake Market — (Portland, OR)"
  });
  eq(
    r.params.get("metadata[pickup_market_rejected]"),
    "true",
    "tax off: an invented market label is validated and rejected"
  );
  eq(
    r.params.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
    "1000",
    "tax off: an invented market label does not waive shipping"
  );

  // A calendar that won't load can't honour a pickup, so it fails closed
  // into the ordinary shipped flow rather than trusting the label.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "false", _stub: { eventsOk: false } },
    { pickupMarket: marketLabel }
  );
  eq(
    r.params.get("metadata[pickup_market_rejected]"),
    "true",
    "events.json down: pickup is not honoured"
  );
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    "US",
    "events.json down: checkout still completes as an ordinary shipped order"
  );

  // Pickup still records which market, for the packing list.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true" },
    { pickupMarket: marketLabel }
  );
  eq(r.params.get("metadata[pickup_market]"), marketLabel, "pickup: market recorded in metadata");

  /* ==========================================================
     7. 2oz Salve Mix-and-Match Volume Pricing Checkout Worker Tests
     ========================================================== */
  const fullSalveCatalog = {
    products: [
      {
        id: "frankincense-salve",
        name: "Y'all Heal Now Miracle Frankincense Salve",
        price: 20,
        category: "salves",
        variants: {
          name: "Size",
          options: [
            { label: "2oz", priceDelta: 0 },
            { label: "1oz", priceDelta: -6.0 }
          ]
        }
      },
      {
        id: "sleep-salve",
        name: "Hush Y'all Magnesium Arnica Sleep Salve",
        blurb: "A 2oz tin of magnesium and arnica.",
        price: 20,
        category: "salves"
      },
      {
        id: "beard-salve",
        name: "Bourbon Beard Salve",
        price: 14.0,
        category: "body"
      },
      {
        id: "miracle-balm",
        name: "Y'allternative Miracle Balm",
        price: 8.0,
        category: "salves"
      }
    ],
    bundles: [],
    shop: { freeShippingThreshold: 40 }
  };

  // 1. Single 2oz Frankincense -> 2000 cents
  p = await captureParams([{ id: "frankincense-salve", qty: 1, variant: "2oz" }], {
    _stub: { catalog: fullSalveCatalog }
  });
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "2000",
    "Worker: 1x 2oz Frankincense is 2000 cents"
  );

  // 2. 2x 2oz Frankincense -> 1500 cents each
  p = await captureParams([{ id: "frankincense-salve", qty: 2, variant: "2oz" }], {
    _stub: { catalog: fullSalveCatalog }
  });
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Worker: 2x 2oz Frankincense is 1500 cents each"
  );
  eq(p.get("line_items[0][quantity]"), "2", "Worker: quantity is 2");

  // 3. Mixed 1x Frankincense (2oz) + 1x Sleep Salve (2oz) -> 1500 cents each
  p = await captureParams(
    [
      { id: "frankincense-salve", qty: 1, variant: "2oz" },
      { id: "sleep-salve", qty: 1 }
    ],
    { _stub: { catalog: fullSalveCatalog } }
  );
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Worker: Mixed bundle Frankincense is 1500 cents"
  );
  eq(
    p.get("line_items[1][price_data][unit_amount]"),
    "1500",
    "Worker: Mixed bundle Sleep Salve is 1500 cents"
  );

  // 4. 1x 1oz Frankincense + 1x 2oz Sleep Salve -> 1400 cents + 2000 cents
  p = await captureParams(
    [
      { id: "frankincense-salve", qty: 1, variant: "1oz" },
      { id: "sleep-salve", qty: 1 }
    ],
    { _stub: { catalog: fullSalveCatalog } }
  );
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Worker: 1oz Frankincense is 1400 cents (no volume tier)"
  );
  eq(
    p.get("line_items[1][price_data][unit_amount]"),
    "2000",
    "Worker: 2oz Sleep Salve is 2000 cents (no volume tier)"
  );

  // 5. Client Price Tampering Defense
  p = await captureParams([{ id: "frankincense-salve", qty: 1, variant: "2oz", price: 5.0 }], {
    _stub: { catalog: fullSalveCatalog }
  });
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "2000",
    "Worker: Client price tampering ignored, charges 2000 cents"
  );

  // 6. Multi-Rule Volume Pricing (Salves + Soaks concurrently in Worker)
  const multiRuleCatalog = {
    products: [
      {
        id: "frankincense-salve",
        name: "Y'all Heal Now Miracle Frankincense Salve",
        price: 20,
        category: "salves",
        variants: {
          name: "Size",
          options: [
            { label: "2oz", priceDelta: 0 },
            { label: "1oz", priceDelta: -6.0 }
          ]
        }
      },
      {
        id: "lavender-soak",
        name: "Lavender Salt Soak",
        price: 18.0,
        category: "soaks"
      },
      {
        id: "ritual-soak",
        name: "Ritual Salt Soak",
        price: 18.0,
        category: "soaks"
      }
    ],
    bundles: [],
    shop: {
      freeShippingThreshold: 40,
      volumePricing: [
        {
          id: "salves-2oz",
          name: "2oz Salve Multi-Buy",
          category: "salves",
          qualifyingVariant: "2oz",
          minQuantity: 2,
          unitPrice: 15,
          label: "2+ for $15 each",
          enabled: true
        },
        {
          id: "soaks-all",
          name: "Soaks Multi-Buy",
          category: "soaks",
          minQuantity: 2,
          unitPrice: 16.0,
          label: "2+ for $16 each",
          enabled: true
        }
      ]
    }
  };

  p = await captureParams(
    [
      { id: "frankincense-salve", qty: 2, variant: "2oz" },
      { id: "lavender-soak", qty: 1 },
      { id: "ritual-soak", qty: 1 }
    ],
    { _stub: { catalog: multiRuleCatalog } }
  );
  eq(
    p.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Worker: Multi-rule Frankincense 2oz discounted to 1500 cents"
  );
  eq(p.get("line_items[0][quantity]"), "2", "Worker: Salve quantity is 2");
  eq(
    p.get("line_items[1][price_data][unit_amount]"),
    "1600",
    "Worker: Multi-rule Lavender Soak discounted to 1600 cents"
  );
  eq(
    p.get("line_items[2][price_data][unit_amount]"),
    "1600",
    "Worker: Multi-rule Ritual Soak discounted to 1600 cents"
  );

  global.fetch = globalFetch;

  /* submit-restock.js is gone; POST /api/restock replaced it. Its honeypot,
     validation, HTML-escaping and 503-with-no-mailer cases moved to
     scripts/worker-state.test.js section 13, where they run against the
     shipped route rather than a deleted file. */
  global.fetch = globalFetch;
}

/* ==========================================================
   12. workers/checkout.js: multi-unit gift card metadata allocation
   ========================================================== */
async function testMultiQuantityGiftCardCheckout() {
  const checkout = await import("../workers/checkout.js");
  const taxCatalog = {
    products: [{ id: "yallternative-gift-card", price: 25.0, category: "gift-cards" }],
    bundles: []
  };

  let captured = null;
  const globalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => taxCatalog };
    }
    if (u.includes("/v1/tax/settings")) {
      return { ok: true, json: async () => ({ status: "active" }) };
    }
    captured = new URLSearchParams(opts.body);
    return { ok: true, json: async () => ({ url: "https://checkout.stripe.com/c/test" }) };
  };

  const req = new Request("https://yallternativeliving.com/api/checkout", {
    method: "POST",
    headers: { Origin: "https://yallternativeliving.com", "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 2,
          variant: "Preset $50",
          giftRecipientEmail: "recipient@example.com",
          giftSenderName: "Taylor",
          giftMessage: "Treat yourself"
        }
      ]
    })
  });

  await checkout.default.fetch(
    req,
    {
      SITE_ORIGIN: "https://yallternativeliving.com",
      STRIPE_SECRET_KEY: "sk_test_x"
    },
    null
  );

  global.fetch = globalFetch;

  eq(
    captured.get("metadata[gift_card_1_amount_cents]"),
    "5000",
    "Worker assigns metadata for gift_card_1"
  );
  eq(
    captured.get("metadata[gift_card_1_recipient]"),
    "recipient@example.com",
    "Worker assigns recipient for gift_card_1"
  );
  // H-8: quantity travels as _qty on the single group for that line. Per-unit
  // expansion here is what used to push large orders past Stripe's 50-key
  // metadata cap, silently dropping paid-for cards before the webhook saw
  // them. fulfill-gift-card.js expands _qty when it derives the codes.
  eq(captured.get("metadata[gift_card_1_qty]"), "2", "Worker records qty=2 on the gift card line");
  eq(
    captured.get("metadata[gift_card_2_amount_cents]"),
    null,
    "Worker no longer expands one metadata group per gift card unit"
  );
  eq(captured.get("line_items[0][quantity]"), "2", "Both gift cards are still charged");
}

/* ==========================================================
   3. Cart toCheckoutPayload with a gift card, and the Worker's redemption path

   The Worker no longer looks a gift card up as a Stripe Promotion Code. The
   balance is a GiftCardLedger Durable Object row, capped at the order total,
   converted into a single-use coupon, and HELD against the session -- audit
   C-2, where the old path discounted the order and debited nothing.
   ========================================================== */
async function testCartAndWorkerGiftCardRedemption() {
  const cart = require("../assets/js/cart.js");
  const checkout = await import("../workers/checkout.js");
  const { GiftCardLedger, giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { makeNamespace } = require("./lib/d1-emulator.js");
  const globalFetch = global.fetch;

  // 1. toCheckoutPayload attaches giftCardCode
  const payload = cart.toCheckoutPayload(
    [{ id: "beard-salve", qty: 1 }],
    "Market 1",
    "yall-test1234"
  );
  eq(
    payload.giftCardCode,
    "YALL-TEST1234",
    "toCheckoutPayload uppercases and includes giftCardCode"
  );

  // 2. The Worker reads the ledger, caps the discount, and holds the money.
  const env = {
    SITE_ORIGIN: "https://yallternativeliving.com",
    STRIPE_SECRET_KEY: "sk_test_x",
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger)
  };
  await giftCardLedger(env, "YALL-GIFT-5000-0000").issue({
    initialCents: 5000,
    source: "test"
  });

  let capturedSessionParams = null;
  let capturedCouponParams = null;
  let promoCodeLookups = 0;

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => ({
          products: [{ id: "beard-salve", price: 16.0, category: "body" }],
          bundles: []
        })
      };
    }
    if (u.includes("/v1/promotion_codes")) {
      promoCodeLookups++;
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (u.includes("/v1/coupons")) {
      capturedCouponParams = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ id: "co_ephemeral_2600" }) };
    }
    if (u.includes("/v1/checkout/sessions")) {
      capturedSessionParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({ id: "cs_gc_test", url: "https://checkout.stripe.com/c/test_gc" })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  // $16 salve + $10 shipping = $26 total. A $50 card is capped at $26.
  const req = new Request("https://yallternativeliving.com/api/checkout", {
    method: "POST",
    headers: { Origin: "https://yallternativeliving.com", "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ id: "beard-salve", qty: 1 }],
      giftCardCode: "YALL-GIFT-5000-0000"
    })
  });

  const res = await checkout.default.fetch(req, env, { waitUntil: () => {} });
  eq(res.status, 200, "Worker completes a gift-card checkout");

  eq(
    promoCodeLookups,
    0,
    "Worker never asks Stripe for a promotion code -- the balance is the ledger's"
  );
  eq(
    capturedCouponParams.get("amount_off"),
    "2600",
    "Worker creates an ephemeral coupon for the full order amount (2600 cents = $26.00)"
  );
  eq(capturedCouponParams.get("duration"), "once", "Worker sets ephemeral coupon duration to once");
  eq(
    capturedCouponParams.get("max_redemptions"),
    "1",
    "Worker caps the ephemeral coupon at one redemption, so its id cannot be replayed"
  );
  eq(
    capturedSessionParams.get("discounts[0][coupon]"),
    "co_ephemeral_2600",
    "Worker attaches the ephemeral discount coupon to the checkout session"
  );
  eq(
    capturedSessionParams.get("metadata[gift_card_redeemed_code]"),
    "YALL-GIFT-5000-0000",
    "Worker attaches gift_card_redeemed_code to session metadata"
  );
  eq(
    capturedSessionParams.get("metadata[gift_card_amount_applied_cents]"),
    "2600",
    "Worker attaches gift_card_amount_applied_cents (2600) to metadata"
  );
  eq(
    capturedSessionParams.get("metadata[gift_card_ephemeral_coupon_id]"),
    "co_ephemeral_2600",
    "Worker records the coupon id so an abandoned session can be cleaned up"
  );

  // 3. The money is HELD, not merely discounted. This is the whole of C-2.
  const snapshot = await giftCardLedger(env, "YALL-GIFT-5000-0000").getBalance();
  eq(snapshot.pendingCents, 2600, "the applied amount is held against the card");
  eq(snapshot.balanceCents, 2400, "and is no longer spendable by a second checkout");

  global.fetch = globalFetch;
}

/* ==========================================================
   Runner: sections run strictly in order so nothing races over shared
   globals (console, global.fetch) and the summary only prints once every
   assertion has actually run.
   ========================================================== */
(async () => {
  await testWorkerModules();
  await testMultiQuantityGiftCardCheckout();
  await testCartAndWorkerGiftCardRedemption();

  console.log(`\nbackend-functions.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  // Fail loudly: an exception escaping a section used to surface as an
  // unhandled rejection with no summary line at all.
  console.error("backend-functions.test.js crashed:", err);
  process.exit(1);
});
