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
   5. Dynamic import of ESM workers (workers/checkout.js & workers/submit-form.js)
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

  console.log(`\nbackend-functions.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
