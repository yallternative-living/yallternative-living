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
      stock: 8,
      variants: {
        name: "Size",
        options: [
          { label: "2oz", priceDelta: 0 },
          { label: "1oz", priceDelta: -6.0 },
          { label: "4oz", priceDelta: 15.0, soldOut: true }
        ]
      }
    },
    {
      id: "yallternative-gift-card",
      name: "Digital Gift Card",
      price: 25.0,
      variants: {
        name: "Amount",
        options: [{ label: "Preset $25", priceDelta: 0 }]
      }
    },
    {
      id: "coming-soon-oil",
      name: "Coming Soon Botanical Oil",
      price: 22.0,
      category: "body",
      comingSoon: true
    },
    {
      id: "sold-out-soak",
      name: "Sold Out Soak",
      price: 12.0,
      category: "soaks",
      inStock: false
    },
    {
      id: "last-three-balm",
      name: "Last Three Balm",
      price: 9.0,
      category: "salves",
      stock: 3
    }
  ],
  shop: {
    freeShippingThreshold: 40,
    shippingMilestones: [
      { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" },
      { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" }
    ]
  }
};

/* The Worker validates a pickup label against the real market calendar on
   every checkout now, so these tests need one. PICKUP_LABEL is byte-identical
   to what cart.js's pickup <select> renders for this event -- see
   pickupLabelFor() in workers/checkout.js. */
const mockEvents = {
  upcoming: [
    {
      id: "landrum-market",
      name: "Landrum Farmers Market",
      dateLabel: "Saturdays 9am-12pm",
      location: "Landrum, SC",
      zip: "29356"
    }
  ],
  past: []
};
const PICKUP_LABEL = "Landrum Farmers Market — Saturdays 9am-12pm (Landrum, SC)";

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
    if (u.includes("events.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => mockEvents
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

  // Test 5: Pickup Market validated against events.json (supports
  // pickup_market & pickupMarket). Tax is OFF in this harness, which is
  // exactly the case that used to skip validation entirely.
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: PICKUP_LABEL
    });

    eq(
      result.sessionParams.get("metadata[pickup_market]"),
      PICKUP_LABEL,
      "pickup_market captured in Stripe session metadata"
    );
    eq(
      result.sessionParams.get("metadata[pickup_market_rejected]"),
      null,
      "A calendar-matched pickup label is not flagged as rejected"
    );
    // A pickup isn't shipped anywhere: no shipping line, no address form.
    eq(
      result.sessionParams.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
      null,
      "Honoured pickup adds no shipping option at all"
    );
    eq(
      result.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      null,
      "Honoured pickup collects no shipping address"
    );
  }

  // Test 5b: An invented pickup label is ignored (it used to waive shipping
  // on any order that merely sent the field, tax on or off).
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: "Totally Made Up Market — Someday (Nowhere, SC)"
    });

    eq(
      result.sessionParams.get("metadata[pickup_market]"),
      null,
      "Unknown pickup label is never recorded as a real market"
    );
    eq(
      result.sessionParams.get("metadata[pickup_market_rejected]"),
      "true",
      "Unknown pickup label is flagged with pickup_market_rejected"
    );
    eq(
      result.sessionParams.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
      "1000",
      "Unknown pickup label still pays the $10 flat shipping rate"
    );
    eq(
      result.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      "US",
      "Unknown pickup label still collects a shipping address"
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
        pickup_market: PICKUP_LABEL,
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
      PICKUP_LABEL,
      "Combo: pickup_market captured"
    );
    eq(
      result.sessionParams.get("metadata[gift_card_redeemed_code]"),
      "YALL-PTS-COMBO1",
      "Combo: loyalty voucher code captured"
    );
  }

  // Test 9: Payment methods come from the Stripe Dashboard, not from code.
  // Sending an explicit payment_method_types list pinned every session to
  // exactly card/link/cashapp, so enabling (or urgently disabling) a method
  // in the Dashboard had no effect on the live checkout.
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }]
    });

    eq(result.status, 200, "Standard checkout returns HTTP 200");
    eq(
      result.sessionParams.get("payment_method_types[0]"),
      null,
      "No payment_method_types sent: the account's enabled methods apply"
    );
    eq(
      result.sessionParams.get("payment_method_types[1]"),
      null,
      "No second payment_method_types entry either"
    );
    eq(
      result.sessionParams.get("payment_method_options[card][request_three_d_secure]"),
      "automatic",
      "payment_method_options[card][request_three_d_secure] is still 'automatic'"
    );
  }

  // Test 10: Discount Code Parsing & Session Metadata (snake_case discount_code)
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      discount_code: "WELCOME10"
    });

    eq(result.status, 200, "Discount code checkout returns HTTP 200");
    eq(
      result.sessionParams.get("metadata[discount_code]"),
      "WELCOME10",
      "metadata.discount_code captures snake_case discount_code"
    );
  }

  // Test 11: Discount Code Parsing & Case Normalization (camelCase discountCode)
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      discountCode: "gothspring20"
    });

    eq(
      result.sessionParams.get("metadata[discount_code]"),
      "GOTHSPRING20",
      "metadata.discount_code normalizes camelCase discountCode to uppercase"
    );
  }

  // Test 12: Discount Code Sanitization & 100 Character Clamping
  {
    const longCode = "SAVE_" + "Z".repeat(150);
    const unprintable = "CODE\x00\x08TEST\x1F";
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      discount_code: longCode + unprintable
    });

    const code = result.sessionParams.get("metadata[discount_code]");
    assert(code != null, "Discount code is present in metadata");
    assert(code.length <= 100, "Discount code clamped to maximum 100 characters");
    assert(!code.includes("\x00"), "Null bytes stripped from discount_code");
    assert(!code.includes("\x1F"), "Control characters stripped from discount_code");
  }

  // Test 13: Non-discount order omits metadata[discount_code]
  {
    const result = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }]
    });

    eq(
      result.sessionParams.get("metadata[discount_code]"),
      null,
      "Non-discount order omits metadata[discount_code]"
    );
  }

  // Test 14: Comprehensive End-to-End Parameter & Metadata Integrity
  {
    const result = await executeCheckout({
      items: [
        { id: "lavender-soak", qty: 2 },
        { id: "frankincense-salve", qty: 1, variant: "2oz" }
      ],
      is_gift_order: true,
      gift_message: "Happy Holidays from the South!",
      pickup_market: PICKUP_LABEL,
      discount_code: "HOLIDAY25"
    });

    eq(result.status, 200, "Comprehensive checkout returns HTTP 200");
    eq(
      result.sessionParams.get("payment_method_types[0]"),
      null,
      "Comprehensive: no payment_method_types pinned"
    );
    eq(
      result.sessionParams.get("payment_method_options[card][request_three_d_secure]"),
      "automatic",
      "Comprehensive: 3DS options configured"
    );
    eq(
      result.sessionParams.get("metadata[is_gift_order]"),
      "true",
      "Comprehensive: is_gift_order captured"
    );
    eq(
      result.sessionParams.get("metadata[gift_message]"),
      "Happy Holidays from the South!",
      "Comprehensive: gift_message captured"
    );
    eq(
      result.sessionParams.get("metadata[pickup_market]"),
      PICKUP_LABEL,
      "Comprehensive: pickup_market captured"
    );
    eq(
      result.sessionParams.get("line_items[1][price_data][product_data][name]"),
      "Frankincense Salve (2oz)",
      "Comprehensive: line name carries the catalog's own variant label"
    );
    eq(
      result.sessionParams.get("metadata[discount_code]"),
      "HOLIDAY25",
      "Comprehensive: discount_code captured"
    );
  }

  // Test 14: Multi-Tier Free Gift Metadata Tagging (R3)
  {
    // Case A: Subtotal < $60 ($18.00) -> free_gift NOT set
    const resultBelow = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }] // $18.00 = 1800 cents
    });
    eq(resultBelow.status, 200, "Sub-$60 checkout returns HTTP 200");
    eq(
      resultBelow.sessionParams.get("metadata[free_gift]"),
      null,
      "Metadata does NOT contain free_gift when physicalSubtotalCents < 6000 ($18.00)"
    );

    // Case B: Subtotal >= $60 (4 x $18 = $72.00 = 7200 cents) -> free_gift: "true"
    const resultAbove = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 4 }] // $72.00
    });
    eq(resultAbove.status, 200, "Qualifying >=$60 checkout returns HTTP 200");
    eq(
      resultAbove.sessionParams.get("metadata[free_gift]"),
      "true",
      "Metadata contains free_gift='true' when physicalSubtotalCents >= 6000 ($72.00)"
    );

    // Case C: Digital gift cards do not count toward free gift threshold
    // $50 in gift cards + $18 in physical soak = $68 total, but physical = $18 (< $60)
    const resultMixed = await executeCheckout({
      items: [
        { id: "yallternative-gift-card", qty: 2, variant: "Preset $25" },
        { id: "lavender-soak", qty: 1 }
      ]
    });
    eq(resultMixed.status, 200, "Mixed gift card checkout returns HTTP 200");
    eq(
      resultMixed.sessionParams.get("metadata[free_gift]"),
      null,
      "Gift cards are excluded from physical subtotal for free_gift qualification"
    );
  }

  /* ==========================================================
     Test 15 (H-2): the promised free gift is a real $0 line on the order,
     not just a metadata flag nobody downstream ever sees. The threshold
     comes from shop.shippingMilestones, so moving it in the CMS moves both
     the promise and the order.
     ========================================================== */
  {
    const below = await executeCheckout({ items: [{ id: "lavender-soak", qty: 1 }] }); // $18
    eq(
      below.sessionParams.get("line_items[1][price_data][product_data][name]"),
      null,
      "Sub-milestone order has no free gift line item"
    );

    const above = await executeCheckout({ items: [{ id: "lavender-soak", qty: 4 }] }); // $72
    eq(above.status, 200, "Qualifying order returns HTTP 200");
    eq(
      above.sessionParams.get("line_items[1][price_data][product_data][name]"),
      "Free Handcrafted Pocket Salve (gift)",
      "Qualifying order carries the free gift as a real line item"
    );
    eq(
      above.sessionParams.get("line_items[1][price_data][unit_amount]"),
      "0",
      "Free gift line is charged $0"
    );
    eq(above.sessionParams.get("line_items[1][quantity]"), "1", "Free gift line is quantity 1");
    eq(
      above.sessionParams.get("line_items[1][price_data][product_data][tax_code]"),
      null,
      "Free gift line carries no tax code (tax is off in this harness anyway)"
    );

    // The milestone is read from the catalog, not hardcoded: $54 clears a
    // $50 milestone even though it is under the $60 default.
    const originalMilestones = mockCatalog.shop.shippingMilestones;
    mockCatalog.shop.shippingMilestones = [
      { threshold: 50, reward: "Free Handcrafted Pocket Salve", icon: "gift" }
    ];
    const cmsDriven = await executeCheckout({ items: [{ id: "lavender-soak", qty: 3 }] }); // $54
    mockCatalog.shop.shippingMilestones = originalMilestones;
    eq(
      cmsDriven.sessionParams.get("line_items[1][price_data][product_data][name]"),
      "Free Handcrafted Pocket Salve (gift)",
      "Free gift milestone follows shop.shippingMilestones from the CMS"
    );
  }

  /* ==========================================================
     Test 16 (H-1): variants are resolved against the catalog's own option
     list. An unknown label used to be ignored and charged at base price.
     ========================================================== */
  {
    const good = await executeCheckout({
      items: [{ id: "frankincense-salve", qty: 1, variant: "1oz" }]
    });
    eq(good.status, 200, "Known variant checks out");
    eq(
      good.sessionParams.get("line_items[0][price_data][unit_amount]"),
      "1399",
      "Known variant applies its priceDelta ($19.99 - $6.00)"
    );

    const spaced = await executeCheckout({
      items: [{ id: "frankincense-salve", qty: 1, variant: "  2OZ " }]
    });
    eq(
      spaced.sessionParams.get("line_items[0][price_data][product_data][name]"),
      "Frankincense Salve (2oz)",
      "Case/whitespace differences still resolve to the catalog label"
    );

    const unknown = await executeCheckout({
      items: [{ id: "frankincense-salve", qty: 1, variant: "24 oz " }]
    });
    eq(unknown.status, 400, "Unknown variant '24 oz ' is rejected, not charged at base price");
    eq(
      unknown.data.error,
      "Product not purchasable: frankincense-salve",
      "Unknown variant returns the curated not-purchasable message"
    );

    const soldOut = await executeCheckout({
      items: [{ id: "frankincense-salve", qty: 1, variant: "4oz" }]
    });
    eq(soldOut.status, 400, "Sold-out variant is rejected");

    const noVariant = await executeCheckout({
      items: [{ id: "frankincense-salve", qty: 1 }]
    });
    eq(noVariant.status, 400, "A product with options cannot be bought without choosing one");
  }

  /* ==========================================================
     Test 17 (H-4): coming-soon, sold-out and stock-limited products.
     ========================================================== */
  {
    const soon = await executeCheckout({ items: [{ id: "coming-soon-oil", qty: 1 }] });
    eq(soon.status, 400, "comingSoon product is rejected");
    eq(
      soon.data.error,
      "Not available yet: Coming Soon Botanical Oil",
      "comingSoon rejection is a curated shopper-facing message"
    );

    const gone = await executeCheckout({ items: [{ id: "sold-out-soak", qty: 1 }] });
    eq(gone.status, 400, "inStock === false product is rejected");
    eq(gone.data.error, "Sold out: Sold Out Soak", "Sold-out rejection names the product");

    const capped = await executeCheckout({ items: [{ id: "last-three-balm", qty: 25 }] });
    eq(capped.status, 200, "An over-ask on a stocked product still checks out");
    eq(
      capped.sessionParams.get("line_items[0][quantity]"),
      "3",
      "Quantity is clamped to the stock actually on hand"
    );
  }

  /* ==========================================================
     Test 18 (H-8): one metadata group per gift-card LINE, carrying qty.
     ========================================================== */
  {
    const single = await executeCheckout({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 1,
          variant: "Preset $25",
          giftRecipientEmail: "friend@example.com"
        }
      ]
    });
    eq(
      single.sessionParams.get("metadata[gift_card_1_amount_cents]"),
      "2500",
      "A single card writes exactly the keys it always did"
    );
    eq(
      single.sessionParams.get("metadata[gift_card_1_qty]"),
      null,
      "qty is omitted for a single card (unchanged output)"
    );

    const many = await executeCheckout({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 6,
          variant: "Preset $25",
          giftRecipientEmail: "friend@example.com",
          giftSenderName: "Sam",
          giftMessage: "Enjoy!"
        }
      ]
    });
    eq(
      many.sessionParams.get("metadata[gift_card_1_qty]"),
      "6",
      "A 6-card line records its quantity in one metadata group"
    );
    eq(
      many.sessionParams.get("metadata[gift_card_2_amount_cents]"),
      null,
      "No per-unit metadata expansion (that is what blew the 50-key cap)"
    );
    eq(many.sessionParams.get("line_items[0][quantity]"), "6", "All 6 cards are still charged");

    // The recipient address is validated, not just truncated.
    const badEmail = await executeCheckout({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 1,
          variant: "Preset $25",
          giftRecipientEmail: "not-an-email"
        }
      ]
    });
    eq(badEmail.status, 400, "An unmailable gift recipient address is rejected at checkout");
    eq(
      badEmail.data.error,
      "Please enter a valid email address for your gift card recipient.",
      "Gift recipient rejection is a curated shopper-facing message"
    );

    const injected = await executeCheckout({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 1,
          variant: "Preset $25",
          giftRecipientEmail: "friend@example.com\r\nBcc: attacker@evil.test"
        }
      ]
    });
    eq(injected.status, 400, "A header-injection attempt in the recipient address is rejected");
  }

  /* ==========================================================
     Test 19 (C-2a): the ephemeral gift-card coupon is single-use and its id
     is recorded so an abandoned session can be cleaned up. A cart that
     contains a gift card falls through to Stripe's own promo box instead.
     ========================================================== */
  {
    const promo = {
      data: [
        {
          id: "promo_gc_1",
          code: "YALL-CARD99",
          coupon: { id: "coupon_gc_1", amount_off: 5000 }
        }
      ]
    };

    const applied = await executeCheckout(
      { items: [{ id: "lavender-soak", qty: 1 }], gift_card_code: "YALL-CARD99" },
      { promoCode: promo }
    );
    eq(
      applied.couponParams.get("max_redemptions"),
      "1",
      "Ephemeral gift-card coupon is capped at a single redemption"
    );
    eq(
      applied.sessionParams.get("metadata[gift_card_ephemeral_coupon_id]"),
      "ephemeral_coupon_123",
      "Ephemeral coupon id is recorded so the webhook can clean it up"
    );

    const buyingACard = await executeCheckout(
      {
        items: [
          { id: "yallternative-gift-card", qty: 1, variant: "Preset $25" },
          { id: "lavender-soak", qty: 1 }
        ],
        gift_card_code: "YALL-CARD99"
      },
      { promoCode: promo }
    );
    eq(
      buyingACard.couponParams,
      null,
      "No ephemeral coupon is minted when the cart itself contains a gift card"
    );
    eq(
      buyingACard.sessionParams.get("allow_promotion_codes"),
      "true",
      "Buying a card with a card falls through to Stripe's promotion-code box"
    );
    eq(
      buyingACard.sessionParams.get("metadata[gift_card_redeemed_code]"),
      null,
      "No pre-applied redemption metadata when the pre-application is refused"
    );
  }

  /* ==========================================================
     Test 20 (H-8 guard): a metadata payload that would blow Stripe's 50-key
     cap is refused with a message the shopper can act on.
     ========================================================== */
  {
    const items = [];
    for (let i = 0; i < 12; i++) {
      items.push({
        id: "yallternative-gift-card",
        qty: 1,
        variant: "Preset $25",
        giftRecipientEmail: `friend${i}@example.com`,
        giftSenderName: "Sam",
        giftMessage: "Enjoy!"
      });
    }
    const res = await executeCheckout({ items });
    eq(res.status, 400, "An order whose metadata would exceed the cap is refused");
    eq(
      res.data.error,
      "Please split orders of more than 12 gift cards into separate checkouts.",
      "Metadata cap returns a curated shopper-facing message"
    );
  }

  console.log(`\nworker-checkout.test.js: ${passed} passed, ${failed} failed`);
  if (require.main === module) {
    process.exit(failed ? 1 : 0);
  }
  return { passed, failed };
}

if (require.main === module) {
  runWorkerCheckoutTests().catch((err) => {
    console.error("Worker checkout test suite error:", err);
    process.exit(1);
  });
}

module.exports = { runWorkerCheckoutTests, executeCheckout };
