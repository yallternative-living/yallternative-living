/**
 * @fileoverview Unit test suite for Cloudflare Worker & Netlify function helpers:
 *   - netlify/functions/fulfill-gift-card.js
 *   - workers/checkout.js
 *   - workers/submit-form.js
 *
 * Run: node scripts/backend-functions.test.js
 */

const crypto = require("crypto");
const fulfillGiftCard = require("../netlify/functions/fulfill-gift-card.js");
const submitRestock = require("../netlify/functions/submit-restock.js");

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
   1. fulfill-gift-card.js: escapeHtml
   ========================================================== */
eq(
  fulfillGiftCard.escapeHtml("<script>alert(\"xss & 'hello'\")</script>"),
  "&lt;script&gt;alert(&quot;xss &amp; &#39;hello&#39;&quot;)&lt;/script&gt;",
  "fulfillGiftCard.escapeHtml escapes HTML special characters"
);
eq(
  fulfillGiftCard.escapeHtml("Clean String 123"),
  "Clean String 123",
  "fulfillGiftCard.escapeHtml passes safe strings"
);

/* ==========================================================
   2. fulfill-gift-card.js: generateRandomCode
   ========================================================== */
const code1 = fulfillGiftCard.generateRandomCode();
assert(code1.startsWith("YALL-"), "generateRandomCode starts with YALL-");
assert(code1.length === 13, "generateRandomCode is 13 chars long");
assert(/^YALL-[A-Z0-9]{8}$/.test(code1), "generateRandomCode matches YALL-[A-Z0-9]{8}");

const codeSet = new Set();
for (let i = 0; i < 100; i++) {
  codeSet.add(fulfillGiftCard.generateRandomCode());
}
eq(codeSet.size, 100, "generateRandomCode generates 100 unique codes");

/* ==========================================================
   3. fulfill-gift-card.js: verifyStripeSignature
   ========================================================== */
const testSecret = "whsec_test_secret_key_123456789";
const testPayload = JSON.stringify({
  id: "evt_123",
  type: "checkout.session.completed",
  data: { object: { id: "cs_123" } }
});
const testTime = Math.floor(Date.now() / 1000);
const validHmac = crypto
  .createHmac("sha256", testSecret)
  .update(`${testTime}.${testPayload}`)
  .digest("hex");
const validHeader = `t=${testTime},v1=${validHmac}`;

// Valid signature
const parsedEvt = fulfillGiftCard.verifyStripeSignature(testPayload, validHeader, testSecret);
eq(parsedEvt.id, "evt_123", "verifyStripeSignature accepts valid signature");

// Missing header
try {
  fulfillGiftCard.verifyStripeSignature(testPayload, null, testSecret);
  assert(false, "verifyStripeSignature throws on missing header");
} catch (e) {
  assert(
    e.message.includes("Missing Stripe-Signature header"),
    "verifyStripeSignature missing header error message"
  );
}

// Missing secret
try {
  fulfillGiftCard.verifyStripeSignature(testPayload, validHeader, null);
  assert(false, "verifyStripeSignature throws on missing secret");
} catch (e) {
  assert(
    e.message.includes("STRIPE_WEBHOOK_SECRET is not configured"),
    "verifyStripeSignature missing secret error message"
  );
}

// Malformed header
try {
  fulfillGiftCard.verifyStripeSignature(testPayload, "invalid_header", testSecret);
  assert(false, "verifyStripeSignature throws on malformed header");
} catch (e) {
  assert(
    e.message.includes("Malformed Stripe-Signature header"),
    "verifyStripeSignature malformed header error message"
  );
}

// Expired timestamp
const oldTime = testTime - 400; // 400s old > 300s tolerance
const oldHmac = crypto
  .createHmac("sha256", testSecret)
  .update(`${oldTime}.${testPayload}`)
  .digest("hex");
try {
  fulfillGiftCard.verifyStripeSignature(testPayload, `t=${oldTime},v1=${oldHmac}`, testSecret);
  assert(false, "verifyStripeSignature throws on timestamp outside tolerance");
} catch (e) {
  assert(
    e.message.includes("outside tolerance"),
    "verifyStripeSignature timestamp tolerance error message"
  );
}

// Invalid signature mismatch
const badHmac = crypto
  .createHmac("sha256", testSecret)
  .update(`${testTime}.tampered`)
  .digest("hex");
try {
  fulfillGiftCard.verifyStripeSignature(testPayload, `t=${testTime},v1=${badHmac}`, testSecret);
  assert(false, "verifyStripeSignature throws on signature mismatch");
} catch (e) {
  assert(
    e.message.includes("Signature mismatch"),
    "verifyStripeSignature signature mismatch error message"
  );
}

/* ==========================================================
   4. fulfill-gift-card.js: createGiftCardPromotionCode
   ========================================================== */
(async () => {
  const globalFetch = global.fetch;

  // Coupon API failure
  global.fetch = async (url) => {
    if (url.includes("/v1/coupons")) {
      return { json: async () => ({ error: { message: "Invalid coupon amount" } }) };
    }
    return { json: async () => ({}) };
  };
  await throwsAsync(
    () => fulfillGiftCard.createGiftCardPromotionCode("cs_1", 1, 2500, "YALL-TEST"),
    "Stripe coupon creation failed: Invalid coupon amount",
    "createGiftCardPromotionCode handles coupon API error"
  );

  // Promo Code API failure
  global.fetch = async (url) => {
    if (url.includes("/v1/coupons")) {
      return { json: async () => ({ id: "co_123" }) };
    }
    if (url.includes("/v1/promotion_codes")) {
      return { json: async () => ({ error: { message: "Code already exists" } }) };
    }
    return { json: async () => ({}) };
  };
  await throwsAsync(
    () => fulfillGiftCard.createGiftCardPromotionCode("cs_1", 1, 2500, "YALL-TEST"),
    "Stripe promotion code creation failed: Code already exists",
    "createGiftCardPromotionCode handles promo code API error"
  );

  // Restore global.fetch
  global.fetch = globalFetch;
})();

/* ==========================================================
   5. fulfill-gift-card.js: handler (invalid signature)
   ========================================================== */
(async () => {
  const originalConsoleError = console.error;
  let errorLogged = false;
  console.error = () => {
    errorLogged = true;
  };

  const event = {
    httpMethod: "POST",
    body: "{}",
    headers: {
      "stripe-signature": "t=123,v1=bad_signature"
    }
  };

  const result = await fulfillGiftCard.handler(event);
  eq(result.statusCode, 400, "handler returns 400 on invalid signature");
  assert(result.body.includes("Invalid signature"), "handler returns invalid signature message");
  assert(errorLogged, "handler logs error on invalid signature");

  console.error = originalConsoleError;
})();

/* ==========================================================
   6. Dynamic import of ESM workers (workers/checkout.js & workers/submit-form.js)
   ========================================================== */
(async () => {
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
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[0], null, false),
    1600,
    "resolveUnitAmountCents standard product"
  );
  eq(
    checkout.resolveUnitAmountCents(mockCatalog, mockCatalog.products[0], "Large", false),
    2000,
    "resolveUnitAmountCents product with variant delta"
  );
  eq(
    checkout.resolveUnitAmountCents(
      mockCatalog,
      mockCatalog.products[0],
      "NonExistentVariant",
      false
    ),
    1600,
    "resolveUnitAmountCents ignores invalid variant"
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
      { id: "beard-salve", price: 16.0, category: "salves" },
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
        return { ok: true, clone: () => ({ body: null }), json: async () => taxCatalog };
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
    global.fetch = async (url, opts) => {
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
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    "US",
    "pickup without a ZIP: falls back to collecting an address"
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

  // A forged label can't smuggle in a cheaper jurisdiction.
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

  // With tax off there's no rate to get wrong, so skip the extra API call.
  r = await captureStripeParams([{ id: "beard-salve", qty: 1 }], pending, {
    pickupMarket: marketLabel
  });
  eq(r.customerParams, null, "tax off: pickup does not create a customer");
  eq(
    r.params.get("shipping_address_collection[allowed_countries][0]"),
    "US",
    "tax off: pickup behaviour unchanged"
  );

  // Pickup still records which market, for the packing list.
  r = await captureStripeParams(
    [{ id: "beard-salve", qty: 1 }],
    { STRIPE_TAX_ENABLED: "true" },
    { pickupMarket: marketLabel }
  );
  eq(r.params.get("metadata[pickup_market]"), marketLabel, "pickup: market recorded in metadata");

  global.fetch = globalFetch;

  /* ==========================================================
     8. submit-restock.js Netlify function
     ========================================================== */

  // HTTP method handling: Validate that an OPTIONS request returns a 204 status with CORS headers.
  let restockRes = await submitRestock.handler({
    httpMethod: "OPTIONS",
    headers: { origin: "https://yallternativeliving.com" },
    body: ""
  });
  eq(restockRes.statusCode, 204, "submitRestock returns 204 for OPTIONS");
  eq(
    restockRes.headers["Access-Control-Allow-Origin"],
    "https://yallternativeliving.com",
    "submitRestock CORS header correct"
  );

  // HTTP method handling: Validate that a GET request returns a 405 status with an error body.
  restockRes = await submitRestock.handler({
    httpMethod: "GET",
    headers: { origin: "https://yallternativeliving.com" },
    body: ""
  });
  eq(restockRes.statusCode, 405, "submitRestock returns 405 for GET");

  // Payload parsing: Validate that application/json payload works correctly.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: { origin: "https://yallternativeliving.com" },
    body: JSON.stringify({ email: "test@example.com", product: "Item1" })
  });
  eq(restockRes.statusCode, 200, "submitRestock parses JSON successfully");
  assert(
    JSON.parse(restockRes.body).message.includes("test@example.com"),
    "submitRestock JSON message includes email"
  );

  // Payload parsing: Validate that application/x-www-form-urlencoded payload works correctly.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: {
      origin: "https://yallternativeliving.com",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "email=form%40example.com&product=Item2"
  });
  eq(restockRes.statusCode, 200, "submitRestock parses x-www-form-urlencoded successfully");
  assert(
    JSON.parse(restockRes.body).message.includes("form@example.com"),
    "submitRestock form message includes email"
  );

  // Honeypot logic: Validate that a form submission with `website_hp` field set returns a 200 silent success.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: { origin: "https://yallternativeliving.com" },
    body: JSON.stringify({ email: "bot@example.com", website_hp: "botstuff" })
  });
  eq(restockRes.statusCode, 200, "submitRestock silent success for honeypot");
  eq(
    JSON.parse(restockRes.body).message,
    "Request received.",
    "submitRestock honeypot message correct"
  );

  // Email validation: Validate that a missing or invalid email address returns a 400 error.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: { origin: "https://yallternativeliving.com" },
    body: JSON.stringify({ email: "not-an-email", product: "Item1" })
  });
  eq(restockRes.statusCode, 400, "submitRestock returns 400 for invalid email");

  // Success response: Validate that a valid email and product ID returns a 200 success with properly sanitized email/product.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: { origin: "https://yallternativeliving.com" },
    body: JSON.stringify({ email: "test@example.com", product: "<script>alert('xss')</script>" })
  });
  eq(restockRes.statusCode, 200, "submitRestock sanitizes product string");
  assert(
    JSON.parse(restockRes.body).message.includes("&lt;script&gt;"),
    "submitRestock HTML escapes product"
  );

  // Payload parsing error: Validate that invalid JSON gracefully catches the error and returns a 400.
  restockRes = await submitRestock.handler({
    httpMethod: "POST",
    headers: { origin: "https://yallternativeliving.com" },
    body: "{ bad json"
  });
  eq(restockRes.statusCode, 400, "submitRestock returns 400 for invalid JSON payload");

  console.log(`\nbackend-functions.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
