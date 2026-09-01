/**
 * @fileoverview Adversarial Stress Test Suite for Backend & Cart Logic
 *
 * Covers:
 * - R1: Gift message length truncation (>=200 chars, exact 500, >500), multiline messages,
 *       special characters, control characters, and HTML/script injection resistance.
 * - R4: Share Cart URL decoding robustness: corrupt base64/URL params, missing variant IDs,
 *       non-existent product IDs, negative/fractional quantities, zero items, stock limits.
 * - R5: Dispatch countdown math: Landrum, SC 2:00 PM ET cutoff across all days of the week,
 *       weekends, Friday after 2 PM ET, and all postal/federal holiday roll-forwards.
 * - R7: Gift card and points voucher regex validation: standard YALL-XXXXXXXX, points
 *       YALL-PTS-XXXXXXXX, lowercase normalization, invalid formats, zero/expired balances.
 *
 * Run: node scripts/adversarial-stress.test.js
 */

const assert = require("assert");
const cart = require("../assets/js/cart.js");
const checkoutModule = require("../workers/checkout.js");
const checkoutWorker = checkoutModule.default || checkoutModule;
const catalogData = require("../assets/data/products.json");
const giftCardBalance = require("../netlify/functions/gift-card-balance.js");
const redeemPoints = require("../netlify/functions/redeem-points.js");

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

// Helper to mock Stripe responses and test workers/checkout.js
async function executeWorkerCheckout(body, mockStripe = {}) {
  let capturedSessionParams = null;
  let capturedCouponParams = null;

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
          id: "coup_test_ephemeral_123",
          amount_off: capturedCouponParams.get("amount_off")
        })
      };
    }
    if (u.includes("/v1/checkout/sessions")) {
      capturedSessionParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          id: "cs_test_stress_12345",
          url: "https://checkout.stripe.com/c/test_session_stress"
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
      STRIPE_SECRET_KEY: "sk_test_stress_dummy_key",
      SITE_ORIGIN: "https://yallternativeliving.com",
      STRIPE_TAX_ENABLED: "false"
    };

    const res = await checkoutWorker.fetch(req, env, { waitUntil: () => {} });
    const resJson = await res.json();
    return {
      status: res.status,
      body: resJson,
      sessionParams: capturedSessionParams,
      couponParams: capturedCouponParams
    };
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  console.log("\n==================================================");
  console.log("ADVERSARIAL STRESS TEST SUITE");
  console.log("==================================================\n");

  /* ==========================================================================
     R1: Gift Message Length Truncation, Multiline, Special Chars & Injection
     ========================================================================== */
  console.log("--- R1: Gift Message & Gifting Robustness ---");

  runTest("R1.1: toCheckoutPayload includes snake_case and camelCase flags", () => {
    const payload = cart.toCheckoutPayload(
      [{ id: "frankincense-salve", qty: 1 }],
      null,
      null,
      true,
      "Short note"
    );
    assert.strictEqual(payload.isGiftOrder, true);
    assert.strictEqual(payload.is_gift_order, true);
    assert.strictEqual(payload.giftMessage, "Short note");
    assert.strictEqual(payload.gift_message, "Short note");
  });

  runTest("R1.2: toCheckoutPayload preserves gift messages >= 200 chars", () => {
    const msg200 = "A".repeat(200);
    const msg350 = "B".repeat(350);
    const payload200 = cart.toCheckoutPayload(
      [{ id: "frankincense-salve", qty: 1 }],
      null,
      null,
      true,
      msg200
    );
    const payload350 = cart.toCheckoutPayload(
      [{ id: "frankincense-salve", qty: 1 }],
      null,
      null,
      true,
      msg350
    );
    assert.strictEqual(payload200.gift_message.length, 200);
    assert.strictEqual(payload350.gift_message.length, 350);
  });

  runTest("R1.3: toCheckoutPayload clamps messages exceeding 500 characters", () => {
    const hugeMsg = "X".repeat(5000);
    const payload = cart.toCheckoutPayload(
      [{ id: "frankincense-salve", qty: 1 }],
      null,
      null,
      true,
      hugeMsg
    );
    assert.strictEqual(payload.gift_message.length, 500);
    assert.strictEqual(payload.giftMessage.length, 500);
  });

  runTest("R1.4: toCheckoutPayload omits gift note when isGiftOrder is false", () => {
    const payload = cart.toCheckoutPayload(
      [{ id: "frankincense-salve", qty: 1 }],
      null,
      null,
      false,
      "Should be ignored"
    );
    assert.strictEqual(payload.isGiftOrder, undefined);
    assert.strictEqual(payload.is_gift_order, undefined);
    assert.strictEqual(payload.giftMessage, undefined);
    assert.strictEqual(payload.gift_message, undefined);
  });

  await runAsyncTest(
    "R1.5: Worker checkout handles multiline gift messages and strips control characters",
    async () => {
      const multilineMsg =
        "Line 1: Happy Birthday!\nLine 2: Enjoy the scents!\r\nLine 3: From Steven";
      const dirtyMsg = multilineMsg + "\x00\x07\x1F\x7F";
      const res = await executeWorkerCheckout({
        items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
        is_gift_order: true,
        gift_message: dirtyMsg
      });

      assert.strictEqual(res.status, 200);
      const savedMsg = res.sessionParams.get("metadata[gift_message]");
      assert.strictEqual(res.sessionParams.get("metadata[is_gift_order]"), "true");
      assert.ok(savedMsg.includes("Line 1: Happy Birthday!"));
      assert.ok(savedMsg.includes("\nLine 2:"));
      assert.ok(savedMsg.includes("\r\nLine 3:"));
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\x00\x07\x1F\x7F]/.test(savedMsg));
    }
  );

  await runAsyncTest(
    "R1.6: Worker checkout is resilient to HTML and script injection payloads in gift message",
    async () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        "<img src=x onerror=alert(1)>",
        '"><script src=//attacker.com/evil.js></script>',
        "& < > \" ' ` test"
      ];

      for (const xss of xssPayloads) {
        const res = await executeWorkerCheckout({
          items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
          is_gift_order: true,
          gift_message: xss
        });
        assert.strictEqual(res.status, 200);
        const metadataMsg = res.sessionParams.get("metadata[gift_message]");
        assert.strictEqual(metadataMsg, xss.trim());
      }
    }
  );

  await runAsyncTest(
    "R1.7: Worker checkout parses is_gift_order whether passed as boolean or string",
    async () => {
      const resBool = await executeWorkerCheckout({
        items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
        is_gift_order: true,
        gift_message: "Bool test"
      });
      assert.strictEqual(resBool.sessionParams.get("metadata[is_gift_order]"), "true");

      const resStr = await executeWorkerCheckout({
        items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
        is_gift_order: "true",
        gift_message: "String test"
      });
      assert.strictEqual(resStr.sessionParams.get("metadata[is_gift_order]"), "true");

      const resFalse = await executeWorkerCheckout({
        items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
        is_gift_order: false,
        gift_message: "False test"
      });
      assert.strictEqual(resFalse.sessionParams.get("metadata[is_gift_order]"), null);
    }
  );

  /* ==========================================================================
     R4: Share Cart URL Encoding / Decoding Robustness
     ========================================================================== */
  console.log("\n--- R4: Share Cart URL Robustness ---");

  runTest("R4.1: parseSharedCartParam handles valid single and multi-item strings", () => {
    const cartStr = "frankincense-salve:2,lavender-soak:1";
    const items = cart.parseSharedCartParam(cartStr, catalogData);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, "frankincense-salve");
    assert.strictEqual(items[0].qty, 2);
    assert.strictEqual(items[1].id, "lavender-soak");
    assert.strictEqual(items[1].qty, 1);
  });

  runTest("R4.2: parseSharedCartParam handles variants with options and deltas", () => {
    const cartStr = "unisex-tshirt:1:L";
    const items = cart.parseSharedCartParam(cartStr, catalogData);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, "unisex-tshirt");
    assert.strictEqual(items[0].variantLabel, "L");
  });

  runTest(
    "R4.3: parseSharedCartParam gracefully handles null, undefined, empty, and non-strings",
    () => {
      assert.deepStrictEqual(cart.parseSharedCartParam(null, catalogData), []);
      assert.deepStrictEqual(cart.parseSharedCartParam(undefined, catalogData), []);
      assert.deepStrictEqual(cart.parseSharedCartParam("", catalogData), []);
      assert.deepStrictEqual(cart.parseSharedCartParam(12345, catalogData), []);
      assert.deepStrictEqual(cart.parseSharedCartParam({}, catalogData), []);
      assert.deepStrictEqual(cart.parseSharedCartParam([], catalogData), []);
    }
  );

  runTest(
    "R4.4: parseSharedCartParam filters out non-existent product IDs and prototype injection",
    () => {
      const maliciousStr =
        "fake-prod-999:2,__proto__:1,constructor:1,toString:1,valueOf:1,frankincense-salve:1";
      const items = cart.parseSharedCartParam(maliciousStr, catalogData);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].id, "frankincense-salve");
      assert.strictEqual(items[0].qty, 1);
    }
  );

  runTest(
    "R4.5: parseSharedCartParam clamps negative, zero, NaN, fractional, and huge quantities",
    () => {
      // Negative -> clamps to 1
      const negItems = cart.parseSharedCartParam("frankincense-salve:-5", catalogData);
      assert.strictEqual(negItems[0].qty, 1);

      // Zero -> clamps to 1
      const zeroItems = cart.parseSharedCartParam("frankincense-salve:0", catalogData);
      assert.strictEqual(zeroItems[0].qty, 1);

      // Non-numeric / NaN -> clamps to 1
      const nanItems = cart.parseSharedCartParam("frankincense-salve:invalid_qty", catalogData);
      assert.strictEqual(nanItems[0].qty, 1);

      // Fractional -> parseInt truncates
      const fracItems = cart.parseSharedCartParam("frankincense-salve:3.75", catalogData);
      assert.strictEqual(fracItems[0].qty, 3);

      // Huge -> clamped to MAX_QTY (99)
      const hugeItems = cart.parseSharedCartParam("frankincense-salve:999999", catalogData);
      assert.strictEqual(hugeItems[0].qty, 99);
    }
  );

  runTest("R4.6: parseSharedCartParam handles malformed tokens, commas, and colons", () => {
    const messyStr = ", ,frankincense-salve:1, ,lavender-soak:2:Extra:Colon:Payload, ,";
    const items = cart.parseSharedCartParam(messyStr, catalogData);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, "frankincense-salve");
    assert.strictEqual(items[0].qty, 1);
    assert.strictEqual(items[1].id, "lavender-soak");
    assert.strictEqual(items[1].qty, 2);
    assert.strictEqual(items[1].variantLabel, "Extra:Colon:Payload");
  });

  runTest("R4.7: parseSharedCartParam supports bundles", () => {
    const bundleStr = "starter-self-care-set:1,bundle-starter-self-care-set:1";
    const items = cart.parseSharedCartParam(bundleStr, catalogData);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, "starter-self-care-set");
    assert.strictEqual(items[1].id, "starter-self-care-set");
  });

  runTest(
    "R4.8: generateShareCartUrl creates valid compact query strings and handles empty state",
    () => {
      assert.strictEqual(cart.generateShareCartUrl([]), "");
      assert.strictEqual(cart.generateShareCartUrl(null), "");

      const url = cart.generateShareCartUrl([
        { id: "frankincense-salve", qty: 2 },
        { id: "unisex-tshirt", qty: 1, variantLabel: "M" }
      ]);
      assert.ok(url.includes("/shop.html?cart="));
      const decodedParam = decodeURIComponent(url.split("?cart=")[1]);
      assert.strictEqual(decodedParam, "frankincense-salve:2,unisex-tshirt:1:M");
    }
  );

  /* ==========================================================================
     R5: Dispatch Countdown Math (Landrum, SC 2:00 PM ET Cutoff & Holiday Rolls)
     ========================================================================== */
  console.log("\n--- R5: Dispatch Countdown Math & Timezone/Holiday Robustness ---");

  runTest("R5.1: Weekday before 2:00 PM ET ships today", () => {
    // Wednesday June 10, 2026 at 09:30:00 EDT (13:30:00 UTC)
    const d = new Date("2026-06-10T13:30:00Z");
    const status = cart.calculateDispatchStatus(d);
    assert.strictEqual(status.shipsToday, true);
    assert.strictEqual(status.nextDispatchDayLabel, "Today");
    assert.strictEqual(status.hoursRemaining, 4);
    assert.strictEqual(status.minutesRemaining, 29);
    assert.ok(status.message.includes("Order in next 4h 29m to ship today from Landrum, SC!"));
  });

  runTest("R5.2: Weekday 1 minute before 2:00 PM ET cutoff", () => {
    // Wednesday June 10, 2026 at 13:59:00 EDT (17:59:00 UTC)
    const d = new Date("2026-06-10T17:59:00Z");
    const status = cart.calculateDispatchStatus(d);
    assert.strictEqual(status.shipsToday, true);
    assert.strictEqual(status.nextDispatchDayLabel, "Today");
    assert.strictEqual(status.hoursRemaining, 0);
    assert.strictEqual(status.minutesRemaining, 0);
    assert.ok(status.message.includes("Order in next 0m to ship today from Landrum, SC!"));
  });

  runTest("R5.3: Weekday at exactly 2:00 PM ET cutoff rolls to Tomorrow", () => {
    // Wednesday June 10, 2026 at 14:00:00 EDT (18:00:00 UTC)
    const d = new Date("2026-06-10T18:00:00Z");
    const status = cart.calculateDispatchStatus(d);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Tomorrow");
    assert.strictEqual(status.message, "Ships Tomorrow from Landrum, SC · Order by 2 PM ET");
  });

  runTest("R5.4: Friday after 2:00 PM ET rolls to Monday", () => {
    // Friday June 12, 2026 at 14:30:00 EDT (18:30:00 UTC)
    const d = new Date("2026-06-12T18:30:00Z");
    const status = cart.calculateDispatchStatus(d);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Monday");
    assert.strictEqual(status.message, "Ships Monday from Landrum, SC · Order by 2 PM ET");
  });

  runTest("R5.5: Saturday and Sunday roll to Monday", () => {
    // Saturday June 13, 2026 at 11:00:00 EDT (15:00:00 UTC)
    const sat = new Date("2026-06-13T15:00:00Z");
    const satStatus = cart.calculateDispatchStatus(sat);
    assert.strictEqual(satStatus.shipsToday, false);
    assert.strictEqual(satStatus.nextDispatchDayLabel, "Monday");

    // Sunday June 14, 2026 at 20:00:00 EDT (00:00:00 UTC June 15) -> Next dispatch is Monday (Tomorrow)
    const sun = new Date("2026-06-14T20:00:00-04:00");
    const sunStatus = cart.calculateDispatchStatus(sun);
    assert.strictEqual(sunStatus.shipsToday, false);
    assert.strictEqual(sunStatus.nextDispatchDayLabel, "Tomorrow");
    assert.strictEqual(sunStatus.message, "Ships Tomorrow from Landrum, SC · Order by 2 PM ET");
  });

  runTest("R5.6: MLK Day (Monday Jan 19, 2026) roll-forward", () => {
    // Friday Jan 16, 2026 at 15:00:00 EST (20:00:00 UTC) -> skips weekend & MLK Monday -> Tuesday Jan 20
    const fri = new Date("2026-01-16T20:00:00Z");
    const friStatus = cart.calculateDispatchStatus(fri);
    assert.strictEqual(friStatus.shipsToday, false);
    assert.strictEqual(friStatus.nextDispatchDayLabel, "Tuesday");

    // Monday Jan 19, 2026 10:00:00 EST (Holiday itself) -> Tomorrow (Tuesday Jan 20)
    const mlkDay = new Date("2026-01-19T15:00:00Z");
    const mlkStatus = cart.calculateDispatchStatus(mlkDay);
    assert.strictEqual(mlkStatus.shipsToday, false);
    assert.strictEqual(mlkStatus.nextDispatchDayLabel, "Tomorrow");
  });

  runTest("R5.7: Presidents' Day (Monday Feb 16, 2026) roll-forward", () => {
    // Friday Feb 13, 2026 at 16:00:00 EST -> Tuesday
    const fri = new Date("2026-02-13T21:00:00Z");
    const status = cart.calculateDispatchStatus(fri);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Tuesday");
  });

  runTest("R5.8: Memorial Day (Monday May 25, 2026) roll-forward", () => {
    // Friday May 22, 2026 at 15:00:00 EDT -> Tuesday
    const fri = new Date("2026-05-22T19:00:00Z");
    const status = cart.calculateDispatchStatus(fri);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Tuesday");
  });

  runTest("R5.9: Juneteenth (Friday June 19, 2026) roll-forward", () => {
    // Thursday June 18, 2026 at 15:00:00 EDT -> skips Friday holiday & weekend -> Monday
    const thu = new Date("2026-06-18T19:00:00Z");
    const status = cart.calculateDispatchStatus(thu);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Monday");

    // Friday June 19, 2026 (Holiday itself) -> Monday
    const fri = new Date("2026-06-19T14:00:00Z");
    const friStatus = cart.calculateDispatchStatus(fri);
    assert.strictEqual(friStatus.shipsToday, false);
    assert.strictEqual(friStatus.nextDispatchDayLabel, "Monday");
  });

  runTest("R5.10: Independence Day (Observed Friday July 3, 2026) roll-forward", () => {
    // Thursday July 2, 2026 at 16:00:00 EDT -> skips observed Friday & weekend -> Monday
    const thu = new Date("2026-07-02T20:00:00Z");
    const status = cart.calculateDispatchStatus(thu);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Monday");
  });

  runTest("R5.11: Labor Day (Monday Sep 7, 2026) roll-forward", () => {
    // Friday Sep 4, 2026 at 15:00:00 EDT -> Tuesday Sep 8
    const fri = new Date("2026-09-04T19:00:00Z");
    const status = cart.calculateDispatchStatus(fri);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Tuesday");
  });

  runTest("R5.12: Veterans Day (Wednesday Nov 11, 2026) mid-week holiday roll-forward", () => {
    // Tuesday Nov 10, 2026 at 15:00:00 EST -> skips Wednesday holiday -> Thursday
    const tue = new Date("2026-11-10T20:00:00Z");
    const status = cart.calculateDispatchStatus(tue);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Thursday");

    // Wednesday Nov 11, 2026 10:00:00 EST (Holiday itself) -> Tomorrow (Thursday)
    const wed = new Date("2026-11-11T15:00:00Z");
    const wedStatus = cart.calculateDispatchStatus(wed);
    assert.strictEqual(wedStatus.shipsToday, false);
    assert.strictEqual(wedStatus.nextDispatchDayLabel, "Tomorrow");
  });

  runTest("R5.13: Thanksgiving Day (Thursday Nov 26, 2026) roll-forward", () => {
    // Wednesday Nov 25, 2026 at 15:00:00 EST -> skips Thursday Thanksgiving -> Friday
    const wed = new Date("2026-11-25T20:00:00Z");
    const status = cart.calculateDispatchStatus(wed);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Friday");
  });

  runTest("R5.14: Christmas Day (Friday Dec 25, 2026) roll-forward", () => {
    // Thursday Dec 24, 2026 at 15:00:00 EST -> skips Friday Christmas & weekend -> Monday
    const thu = new Date("2026-12-24T20:00:00Z");
    const status = cart.calculateDispatchStatus(thu);
    assert.strictEqual(status.shipsToday, false);
    assert.strictEqual(status.nextDispatchDayLabel, "Monday");
  });

  /* ==========================================================================
     R7: Gift Card & Points Voucher Regex Validation & Balance Carryover
     ========================================================================== */
  console.log("\n--- R7: Gift Card & Points Voucher Validation & Math ---");

  const voucherRegex = /^YALL-(?:PTS-)?[A-Z0-9]{6,16}$/;

  runTest("R7.1: Standard gift card format regex matches valid codes", () => {
    const validCodes = [
      "YALL-12345678",
      "YALL-ABCD1234",
      "YALL-ABCDEFGH12345678",
      "YALL-MINLEN" // 6 chars suffix
    ];
    for (const code of validCodes) {
      assert.strictEqual(voucherRegex.test(code), true, `Code ${code} should match regex`);
    }
  });

  runTest("R7.2: Alt-Points reward voucher format regex matches valid codes", () => {
    const validPointCodes = ["YALL-PTS-ABC123", "YALL-PTS-12345678", "YALL-PTS-A1B2C3D4E5F6G7H8"];
    for (const code of validPointCodes) {
      assert.strictEqual(voucherRegex.test(code), true, `Points code ${code} should match regex`);
    }
  });

  runTest("R7.3: Voucher regex rejects invalid formats, bad prefixes, and bad characters", () => {
    const invalidCodes = [
      "YALL-", // no suffix
      "YALL-123", // too short (< 6 chars)
      "YALL-PTS-", // no suffix
      "YALL-PTS-123", // too short
      "YALL-12345678901234567", // > 16 chars suffix
      "YALL-PTS-12345678901234567", // > 16 chars suffix
      "YALL-SPECIAL#CHAR", // special char #
      "YALL_12345678", // underscore
      "PTS-12345678", // missing YALL-
      "DISCOUNT20", // generic coupon
      "yall-12345678", // lowercase before normalization
      "",
      "   "
    ];
    for (const code of invalidCodes) {
      assert.strictEqual(voucherRegex.test(code), false, `Code "${code}" should NOT match regex`);
    }
  });

  await runAsyncTest(
    "R7.4: lookupGiftCardBalance normalizes lowercase input and validates against regex",
    async () => {
      const invalidRes = await giftCardBalance.lookupGiftCardBalance(
        "invalid-code",
        "sk_test_mock"
      );
      assert.strictEqual(invalidRes.valid, false);
      assert.ok(invalidRes.error.includes("Invalid code format"));

      const emptyRes = await giftCardBalance.lookupGiftCardBalance("", "sk_test_mock");
      assert.strictEqual(emptyRes.valid, false);
      assert.ok(emptyRes.error.includes("Please enter a gift card code"));
    }
  );

  await runAsyncTest(
    "R7.5: lookupGiftCardBalance handles valid, zero, and missing balances",
    async () => {
      const originalFetch = global.fetch;
      try {
        // Mock Stripe active promo code with positive balance
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes("code=YALL-ACTIVE25")) {
            return {
              ok: true,
              json: async () => ({
                data: [
                  {
                    id: "promo_active_1",
                    code: "YALL-ACTIVE25",
                    coupon: { id: "coup_25", amount_off: 2500, currency: "usd" },
                    metadata: { initial_amount_cents: "2500" }
                  }
                ]
              })
            };
          }
          if (u.includes("code=YALL-ZERO00")) {
            return {
              ok: true,
              json: async () => ({
                data: [
                  {
                    id: "promo_zero_1",
                    code: "YALL-ZERO00",
                    coupon: { id: "coup_0", amount_off: 0, currency: "usd" }
                  }
                ]
              })
            };
          }
          return { ok: true, json: async () => ({ data: [] }) };
        };

        const activeRes = await giftCardBalance.lookupGiftCardBalance(
          "yall-active25",
          "sk_test_key"
        );
        assert.strictEqual(activeRes.valid, true);
        assert.strictEqual(activeRes.code, "YALL-ACTIVE25");
        assert.strictEqual(activeRes.balance, 25.0);
        assert.strictEqual(activeRes.formattedBalance, "$25.00");
        assert.strictEqual(activeRes.expires, null);

        // A spent card and a code that never existed must be INDISTINGUISHABLE:
        // a "no balance remaining" message confirmed to a guesser that the code
        // was real, turning the balance endpoint into an enumeration oracle.
        const zeroRes = await giftCardBalance.lookupGiftCardBalance("YALL-ZERO00", "sk_test_key");
        assert.strictEqual(zeroRes.valid, false);

        const notFoundRes = await giftCardBalance.lookupGiftCardBalance(
          "YALL-NOTFOUND1",
          "sk_test_key"
        );
        assert.strictEqual(notFoundRes.valid, false);
        assert.strictEqual(
          zeroRes.error,
          notFoundRes.error,
          "A spent card and an unknown code return the identical message"
        );
        assert.strictEqual(zeroRes.error, giftCardBalance.GENERIC_NOT_FOUND);
      } finally {
        global.fetch = originalFetch;
      }
    }
  );

  runTest("R7.6: deriveRewardCode generates valid YALL-PTS- codes with high entropy", () => {
    const codes = new Set();
    for (let i = 0; i < 50; i++) {
      const code = redeemPoints.deriveRewardCode();
      assert.strictEqual(voucherRegex.test(code), true);
      assert.ok(code.startsWith("YALL-PTS-"));
      assert.strictEqual(code.length, 15); // "YALL-PTS-" (9) + 6 chars = 15
      codes.add(code);
    }
    assert.strictEqual(codes.size, 50, "50 generated codes should all be unique");
  });

  await runAsyncTest(
    "R7.7: Worker checkout creates ephemeral coupon for gift card and caps discount at order total",
    async () => {
      // Basket: Frankincense Salve ($19.99) + $10 shipping = $29.99 ($2999 cents)
      // Gift Card: $50.00 ($5000 cents) -> discount should be capped at $29.99 ($2999 cents)
      const mockPromo = {
        data: [
          {
            id: "promo_gift_50",
            code: "YALL-GIFT50",
            coupon: { id: "coup_gift_50", amount_off: 5000, currency: "usd" }
          }
        ]
      };

      const res = await executeWorkerCheckout(
        {
          items: [{ id: "frankincense-salve", qty: 1, variant: "2oz" }],
          gift_card_code: "yall-gift50"
        },
        { promoCode: mockPromo }
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.couponParams.get("amount_off"), "2999");
      assert.strictEqual(res.couponParams.get("metadata[gift_card_code]"), "YALL-GIFT50");
      assert.strictEqual(res.couponParams.get("metadata[promo_id]"), "promo_gift_50");
    }
  );

  console.log("\n==================================================");
  console.log(`ALL ADVERSARIAL STRESS TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log("==================================================\n");
}

main().catch((err) => {
  console.error("\nFATAL TEST FAILURE:", err);
  process.exit(1);
});
