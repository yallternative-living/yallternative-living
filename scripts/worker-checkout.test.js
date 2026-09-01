/**
 * @fileoverview Comprehensive unit tests for workers/checkout.js covering
 * Milestone 1 (Gifting, Alt-Points loyalty voucher checkout, and Pickup integration).
 *
 * Run: node scripts/worker-checkout.test.js
 */

const workerModule = require("../workers/checkout.js");
const worker = workerModule.default || workerModule;

let passed = 0;
let failed = 0;

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

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const mockCatalog = {
  products: [
    {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 18.0,
      category: "soaks"
    },
    {
      id: "frankincense-salve",
      name: "Frankincense Salve",
      price: 19.99,
      category: "salves",
      variants: {
        name: "Size",
        options: [{ name: "2oz", priceDelta: 0 }]
      }
    },
    {
      id: "yallternative-gift-card",
      name: "Digital Gift Card",
      price: 25.0,
      variants: {
        name: "Amount",
        options: [{ name: "Preset $25", priceDelta: 0 }]
      }
    }
  ],
  shop: {
    freeShippingThreshold: 40
  }
};

const mockEnv = {
  STRIPE_SECRET_KEY: "sk_test_mock_12345",
  SITE_ORIGIN: "https://yallternativeliving.com"
};

const mockCtx = {
  waitUntil: () => {}
};

async function executeCheckout(body, mockStripeResponses = {}) {
  let capturedSessionParams = null;
  let capturedCouponParams = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => mockCatalog
      };
    }
    if (u.includes("api.stripe.com/v1/promotion_codes")) {
      if (mockStripeResponses.promoCode) {
        return {
          ok: true,
          json: async () => mockStripeResponses.promoCode
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    }
    if (u.includes("api.stripe.com/v1/coupons")) {
      capturedCouponParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({ id: "ephemeral_coupon_123" })
      };
    }
    if (u.includes("api.stripe.com/v1/checkout/sessions")) {
      capturedSessionParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          id: "cs_test_mock_session",
          url: "https://checkout.stripe.com/pay/cs_test_mock_session"
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const req = new Request("https://yallternativeliving.com/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://yallternativeliving.com"
      },
      body: JSON.stringify(body)
    });

    const res = await worker.fetch(req, mockEnv, mockCtx);
    const data = await res.json();
    return {
      status: res.status,
      data: data,
      sessionParams: capturedSessionParams,
      couponParams: capturedCouponParams
    };
  } finally {
    global.fetch = originalFetch;
  }
}

async function runWorkerCheckoutTests() {
  console.log("Running workers/checkout.js unit tests...\n");

  // Test 1: Basic Gift Order with Message in Stripe Session Metadata
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      is_gift_order: true,
      gift_message: "Happy Birthday! Enjoy the relaxing bath soak."
    });

    eq(result.status, 200, "Gift checkout returns HTTP 200");
    assert(result.sessionParams != null, "Stripe session was created");
    eq(
      result.sessionParams.get("metadata[is_gift_order]"),
      "true",
      "Metadata contains is_gift_order='true'"
    );
    eq(
      result.sessionParams.get("metadata[gift_message]"),
      "Happy Birthday! Enjoy the relaxing bath soak.",
      "Metadata contains sanitized gift_message"
    );
  }

  // Test 2: Gift Order using camelCase properties (backward-compatibility)
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      isGiftOrder: true,
      giftMessage: "Hope this salve brings comfort!"
    });

    eq(
      result.sessionParams.get("metadata[is_gift_order]"),
      "true",
      "camelCase isGiftOrder correctly mapped to session metadata"
    );
    eq(
      result.sessionParams.get("metadata[gift_message]"),
      "Hope this salve brings comfort!",
      "camelCase giftMessage correctly mapped to session metadata"
    );
  }

  // Test 3: Gift Message Sanitization & 500 Character Truncation
  {
    const longMsg = "Special Note ".repeat(50); // > 500 chars
    const maliciousChars = "Hello \x00\x08World\x1F\x7F!";
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      is_gift_order: true,
      gift_message: longMsg + maliciousChars
    });

    const msg = result.sessionParams.get("metadata[gift_message]");
    assert(msg.length <= 500, "Gift message truncated to max 500 characters");
    assert(!msg.includes("\x00"), "Control characters stripped from gift message");
    assert(!msg.includes("\x1F"), "Unprintable characters stripped from gift message");
  }

  // Test 4: Non-gift order (metadata does not include is_gift_order)
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      is_gift_order: false
    });

    eq(
      result.sessionParams.get("metadata[is_gift_order]"),
      null,
      "Non-gift order omits is_gift_order metadata"
    );
  }

  // Test 5: Pickup Market in Session Metadata (supports pickup_market & pickupMarket)
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: "Landrum SC Farmers Market (Saturdays 9am-12pm)"
    });

    eq(
      result.sessionParams.get("metadata[pickup_market]"),
      "Landrum SC Farmers Market (Saturdays 9am-12pm)",
      "pickup_market captured in Stripe session metadata"
    );
    eq(
      result.sessionParams.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
      "0",
      "Pickup market orders apply $0 shipping rate"
    );
    eq(
      result.sessionParams.get("shipping_options[0][shipping_rate_data][display_name]"),
      "Free shipping",
      "Pickup market orders display 'Free shipping'"
    );
  }

  // Test 6: Alt-Points Loyalty Voucher / Gift Card Redemption in Checkout
  {
    const mockPromoResponse = {
      data: [
        {
          id: "promo_pts_123",
          code: "YALL-PTS-TEST99",
          coupon: {
            id: "coupon_pts_123",
            amount_off: 500 // $5.00 voucher
          }
        }
      ]
    };

    const result = await executeCheckout(
      {
        items: [{ id: "lavender-soak", qty: 1 }], // $18.00 item
        gift_card_code: "YALL-PTS-TEST99"
      },
      { promoCode: mockPromoResponse }
    );

    eq(result.status, 200, "Alt-Points voucher checkout succeeds");
    eq(
      result.sessionParams.get("discounts[0][coupon]"),
      "ephemeral_coupon_123",
      "Stripe session receives ephemeral coupon discount"
    );
    eq(
      result.couponParams.get("amount_off"),
      "500",
      "Ephemeral coupon applied for $5.00 discount (500 cents)"
    );
    eq(
      result.sessionParams.get("metadata[gift_card_redeemed_code]"),
      "YALL-PTS-TEST99",
      "Session metadata records redeemed Alt-Points voucher code"
    );
    eq(
      result.sessionParams.get("metadata[gift_card_amount_applied_cents]"),
      "500",
      "Session metadata records applied discount cents"
    );
  }

  // Test 7: Balance Carryover Math (Voucher exceeds item total)
  {
    const mockLargeVoucher = {
      data: [
        {
          id: "promo_large_123",
          code: "YALL-PTS-BIGVOUCHER",
          coupon: {
            id: "coupon_large_123",
            amount_off: 5000 // $50.00 voucher
          }
        }
      ]
    };

    // Lavender Soak = $18.00 ($18.00 + $10.00 shipping = $28.00 / 2800 cents total)
    const result = await executeCheckout(
      {
        items: [{ id: "lavender-soak", qty: 1 }],
        gift_card_code: "YALL-PTS-BIGVOUCHER"
      },
      { promoCode: mockLargeVoucher }
    );

    // Applied discount clamped to order total ($18.00 + $10.00 shipping = 2800 cents)
    eq(
      result.couponParams.get("amount_off"),
      "2800",
      "Ephemeral discount capped at order total ($28.00) leaving remaining balance on voucher"
    );
    eq(
      result.sessionParams.get("metadata[gift_card_original_balance_cents]"),
      "5000",
      "Session metadata preserves original $50.00 balance for carryover tracking"
    );
  }

  // Test 8: Combined Gifting + Pickup + Alt-Points Loyalty Voucher
  {
    const mockPromoResponse = {
      data: [
        {
          id: "promo_pts_456",
          code: "YALL-PTS-COMBO1",
          coupon: {
            id: "coupon_pts_456",
            amount_off: 500
          }
        }
      ]
    };

    const result = await executeCheckout(
      {
        items: [{ id: "lavender-soak", qty: 1 }],
        pickup_market: "Landrum Market",
        gift_card_code: "YALL-PTS-COMBO1",
        is_gift_order: true,
        gift_message: "Enjoy this gift at the booth!"
      },
      { promoCode: mockPromoResponse }
    );

    eq(result.status, 200, "Combined feature checkout returns 200 OK");
    eq(result.sessionParams.get("metadata[is_gift_order]"), "true", "Combo: is_gift_order='true'");
    eq(
      result.sessionParams.get("metadata[gift_message]"),
      "Enjoy this gift at the booth!",
      "Combo: gift_message captured"
    );
    eq(
      result.sessionParams.get("metadata[pickup_market]"),
      "Landrum Market",
      "Combo: pickup_market captured"
    );
    eq(
      result.sessionParams.get("metadata[gift_card_redeemed_code]"),
      "YALL-PTS-COMBO1",
      "Combo: loyalty voucher code captured"
    );
  }

  console.log(`\nworker-checkout.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

runWorkerCheckoutTests().catch((err) => {
  console.error("Worker checkout test suite error:", err);
  process.exit(1);
});
