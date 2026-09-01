/**
 * @fileoverview Adversarial Stress Test Suite for Milestone 1
 *
 * Covers:
 * 1. workers/checkout.js checkout payload handling, Stripe metadata sanitization,
 *    and tax calculation under gift orders (digital, physical, apparel, pickup, discounts).
 * 2. Cart state transitions during share cart URL loading and simultaneous local cart merging.
 * 3. Browser storage boundary conditions (localStorage disabled, full, corrupt, or poisoned).
 *
 * Run: node scripts/challenger-m1-stress.test.js
 */

const workerModule = require("../workers/checkout.js");
const worker = workerModule.default || workerModule;
const cartEngine = require("../assets/js/cart.js");

let totalPassed = 0;
let totalFailed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPassed++;
  } else {
    totalFailed++;
    console.error(`  ✗ [FAIL] ${label}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

function assert(condition, label, details) {
  if (condition) {
    totalPassed++;
  } else {
    totalFailed++;
    console.error(`  ✗ [FAIL] ${label}${details ? ` (${details})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mock Data Fixtures for Worker & Cart
// ---------------------------------------------------------------------------
const mockCatalog = {
  products: [
    {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 18.0,
      category: "soaks",
      stock: 5
    },
    {
      id: "frankincense-salve",
      name: "Frankincense Salve",
      price: 19.99,
      category: "salves",
      stock: 4,
      variants: {
        name: "Size",
        options: [
          { name: "2oz", label: "2oz", priceDelta: 0 },
          { name: "1oz", label: "1oz", priceDelta: -6.0 },
          { name: "4oz-sold-out", label: "4oz", priceDelta: 15.0, soldOut: true }
        ]
      }
    },
    {
      id: "unisex-tshirt",
      name: "Unisex T-Shirt",
      price: 28.0,
      category: "apparel",
      stock: 10,
      variants: {
        name: "Size",
        options: [
          { name: "S", label: "S", priceDelta: 0 },
          { name: "M", label: "M", priceDelta: 0 },
          { name: "L", label: "L", priceDelta: 0 }
        ]
      }
    },
    {
      id: "yallternative-gift-card",
      name: "Digital Gift Card",
      price: 25.0,
      category: "gift-cards",
      variants: {
        name: "Amount",
        options: [{ name: "Preset $25", label: "Preset $25", priceDelta: 0 }]
      }
    },
    {
      id: "coming-soon-oil",
      name: "Coming Soon Botanical Oil",
      price: 22.0,
      category: "apothecary",
      comingSoon: true
    }
  ],
  bundles: [
    {
      id: "starter-self-care-set",
      name: "Starter Self-Care Set",
      productIds: ["lavender-soak", "frankincense-salve"],
      discountPercent: 10
    }
  ],
  shop: {
    freeShippingThreshold: 40,
    customBox: {
      minItems: 2,
      maxItems: 4,
      discountPercent: 10,
      eligibleCategories: ["soaks", "salves", "apothecary"]
    }
  }
};

const mockEvents = {
  upcoming: [
    {
      id: "landrum-market-1",
      name: "Landrum Farmers Market",
      dateLabel: "Saturdays 9am-12pm",
      location: "Landrum, SC",
      zip: "29356"
    },
    {
      id: "hendersonville-fair",
      name: "Hendersonville Pop-up",
      dateLabel: "Oct 12",
      location: "Hendersonville, NC",
      zip: "28792"
    },
    {
      id: "no-zip-market",
      name: "Rural Market",
      dateLabel: "Nov 5",
      location: "Somewhere, SC"
      // missing zip!
    }
  ]
};

const mockEnv = {
  STRIPE_SECRET_KEY: "sk_test_mock_secret_key",
  SITE_ORIGIN: "https://yallternativeliving.com",
  STRIPE_TAX_ENABLED: "true"
};

const mockCtx = {
  waitUntil: () => {}
};

async function executeWorkerCheckout(body, customEnv = mockEnv, mockStripeResponses = {}) {
  let capturedSessionParams = null;
  let capturedCouponParams = null;
  let capturedCustomerParams = null;

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
    if (u.includes("api.stripe.com/v1/customers")) {
      capturedCustomerParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({ id: "cus_mock_pickup_123" })
      };
    }
    if (u.includes("api.stripe.com/v1/promotion_codes")) {
      if (mockStripeResponses.promoCode) {
        return {
          ok: true,
          json: async () => mockStripeResponses.promoCode
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "Promo code not found" }) };
    }
    if (u.includes("api.stripe.com/v1/coupons")) {
      capturedCouponParams = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({ id: "coupon_ephemeral_mock" })
      };
    }
    if (u.includes("api.stripe.com/v1/checkout/sessions")) {
      capturedSessionParams = new URLSearchParams(opts.body);
      if (mockStripeResponses.sessionError) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: mockStripeResponses.sessionError } })
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: "cs_mock_123",
          url: "https://checkout.stripe.com/c/pay/cs_mock_123"
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
      body: typeof body === "string" ? body : JSON.stringify(body)
    });

    const res = await worker.fetch(req, customEnv, mockCtx);
    const data = await res.json();
    return {
      status: res.status,
      data,
      sessionParams: capturedSessionParams,
      couponParams: capturedCouponParams,
      customerParams: capturedCustomerParams
    };
  } finally {
    global.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE 1: workers/checkout.js Adversarial Payload, Sanitization & Tax
// ---------------------------------------------------------------------------
async function testWorkerAdversarial() {
  console.log("\n=======================================================");
  console.log("SUITE 1: workers/checkout.js Adversarial & Boundary Tests");
  console.log("=======================================================");

  // 1.1 Non-JSON and malformed body payloads
  {
    const res = await executeWorkerCheckout("This is not JSON");
    eq(res.status, 400, "Worker rejects non-JSON body with 400");
    assert(res.data.error != null, "Worker returns error message for non-JSON body");
  }

  // 1.2 Primitive body payloads (numbers, booleans, null, empty array)
  {
    const resNum = await executeWorkerCheckout(12345);
    eq(resNum.status, 400, "Worker rejects number body with 400");

    const resNull = await executeWorkerCheckout(null);
    eq(resNull.status, 400, "Worker rejects null body with 400");

    const resEmpty = await executeWorkerCheckout({ items: [] });
    eq(resEmpty.status, 400, "Worker rejects empty items array with 400");
  }

  // 1.3 Exceeding MAX_LINE_ITEMS (51 items)
  {
    const oversizedItems = [];
    for (let i = 0; i < 51; i++) {
      oversizedItems.push({ id: "lavender-soak", qty: 1 });
    }
    const res = await executeWorkerCheckout({ items: oversizedItems });
    eq(res.status, 400, "Worker rejects > 50 line items with 400");
    eq(res.data.error, "Too many line items.", "Worker returns exact item limit message");
  }

  // 1.4 Non-existent product ID
  {
    const res = await executeWorkerCheckout({
      items: [{ id: "ghost-item-does-not-exist", qty: 1 }]
    });
    eq(res.status, 400, "Worker rejects unknown product ID with 400");
    eq(
      res.data.error,
      "Product not found: ghost-item-does-not-exist",
      "Worker returns safe ClientError message"
    );
  }

  // 1.5 Sold-out variant option
  {
    const res = await executeWorkerCheckout({
      items: [{ id: "frankincense-salve", variant: "4oz", qty: 1 }]
    });
    eq(res.status, 400, "Worker rejects sold-out variant with 400");
    eq(
      res.data.error,
      "Product not purchasable: frankincense-salve",
      "Worker returns not purchasable message"
    );
  }

  // 1.6 Custom Box Validation: empty, invalid product, comingSoon, bounds
  {
    // Empty box
    const resEmptyBox = await executeWorkerCheckout({
      items: [{ id: "custom-box", boxProductIds: [] }]
    });
    eq(resEmptyBox.status, 400, "Worker rejects empty custom box with 400");

    // Invalid product inside box
    const resBadBox = await executeWorkerCheckout({
      items: [{ id: "custom-box", boxProductIds: ["lavender-soak", "fake-product"] }]
    });
    eq(resBadBox.status, 400, "Worker rejects box with invalid product with 400");

    // comingSoon product inside box
    const resSoonBox = await executeWorkerCheckout({
      items: [{ id: "custom-box", boxProductIds: ["lavender-soak", "coming-soon-oil"] }]
    });
    eq(resSoonBox.status, 400, "Worker rejects box with comingSoon product with 400");

    // Box with too many items (5 > maxItems 4)
    const resTooManyBox = await executeWorkerCheckout({
      items: [
        {
          id: "custom-box",
          boxProductIds: [
            "lavender-soak",
            "lavender-soak",
            "lavender-soak",
            "lavender-soak",
            "lavender-soak"
          ]
        }
      ]
    });
    eq(resTooManyBox.status, 400, "Worker rejects box exceeding maxItems with 400");
  }

  // 1.7 Quantity sanitization (negative, zero, NaN, float, huge integer)
  {
    const res = await executeWorkerCheckout({
      items: [
        { id: "lavender-soak", qty: -10 },
        { id: "lavender-soak", qty: 0 },
        { id: "lavender-soak", qty: "invalid" },
        { id: "lavender-soak", qty: 9999999 }
      ]
    });
    eq(res.status, 200, "Worker sanitizes invalid quantities and succeeds");
    eq(res.sessionParams.get("line_items[0][quantity]"), "1", "qty -10 clamped to 1");
    eq(res.sessionParams.get("line_items[1][quantity]"), "1", "qty 0 clamped to 1");
    eq(res.sessionParams.get("line_items[2][quantity]"), "1", "qty NaN clamped to 1");
    // lavender-soak carries stock: 5 in this fixture, and tracked stock now
    // caps the line -- you cannot buy 99 of the 5 that exist.
    eq(
      res.sessionParams.get("line_items[3][quantity]"),
      "5",
      "qty 9999999 clamped to the 5 units actually in stock"
    );

    // With no stock tracked (stock absent), the MAX_QTY_PER_ITEM cap applies.
    const untracked = await executeWorkerCheckout({
      items: [{ id: "coming-soon-oil", qty: 9999999 }]
    });
    eq(untracked.status, 400, "A comingSoon product is refused whatever the quantity");
    const giftCards = await executeWorkerCheckout({
      items: [{ id: "yallternative-gift-card", qty: 9999999, variant: "Preset $25" }]
    });
    eq(
      giftCards.sessionParams.get("line_items[0][quantity]"),
      "99",
      "Untracked stock still clamps to the 99-per-item cap"
    );
  }

  // 1.8 Stripe Metadata Sanitization & Gifting Fuzzing
  {
    // Extreme gift message with control chars, XSS script tags, emojis, and length > 500
    const rawGiftMsg =
      "\x00\x01\x08<script>alert('XSS')</script> 🎉 Special Gift Note with 💖 Emojis \x1F\x7F" +
      " Long text padding ".repeat(30);

    const res = await executeWorkerCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      is_gift_order: "true", // string true
      gift_message: rawGiftMsg
    });

    eq(res.status, 200, "Gift order checkout succeeds");
    eq(
      res.sessionParams.get("metadata[is_gift_order]"),
      "true",
      "is_gift_order='true' set in metadata"
    );
    const sanitizedMsg = res.sessionParams.get("metadata[gift_message]");
    assert(sanitizedMsg.length <= 500, "Gift message truncated to <= 500 chars");
    assert(!sanitizedMsg.includes("\x00"), "Control char \\x00 stripped");
    assert(!sanitizedMsg.includes("\x08"), "Control char \\x08 stripped");
    assert(!sanitizedMsg.includes("\x1F"), "Control char \\x1F stripped");
    assert(!sanitizedMsg.includes("\x7F"), "Control char \\x7F stripped");
    assert(sanitizedMsg.includes("🎉"), "Emojis preserved in gift message");
    assert(
      sanitizedMsg.includes("<script>alert('XSS')</script>"),
      "HTML tags safely stored as plain text"
    );
  }

  // 1.9 Non-gift falsy variations (is_gift_order: false, "false", null, 0)
  {
    for (const falsyVal of [false, "false", null, 0, undefined]) {
      const res = await executeWorkerCheckout({
        items: [{ id: "lavender-soak", qty: 1 }],
        is_gift_order: falsyVal,
        gift_message: "Should not be present"
      });
      eq(
        res.sessionParams.get("metadata[is_gift_order]"),
        null,
        `Metadata omits is_gift_order for falsy value ${JSON.stringify(falsyVal)}`
      );
      eq(
        res.sessionParams.get("metadata[gift_message]"),
        null,
        `Metadata omits gift_message for falsy value ${JSON.stringify(falsyVal)}`
      );
    }
  }

  // 1.10 Tax Calculation: All-Gift-Card Order (Digital goods, no shipping, txcd_10502000)
  {
    const res = await executeWorkerCheckout({
      items: [
        {
          id: "yallternative-gift-card",
          qty: 2,
          variant: "Preset $50",
          giftRecipientEmail: "recipient@example.com",
          giftSenderName: "Sender Name",
          giftMessage: "Enjoy your gift card!"
        }
      ]
    });

    eq(res.status, 200, "All-gift-card checkout succeeds");
    eq(
      res.sessionParams.get("automatic_tax[enabled]"),
      "true",
      "automatic_tax is enabled for gift card"
    );
    eq(
      res.sessionParams.get("billing_address_collection"),
      "required",
      "Billing address required so Stripe can rate tax"
    );
    eq(
      res.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      null,
      "No shipping address collected for all-gift-card order"
    );
    eq(
      res.sessionParams.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
      null,
      "No shipping options or charge added for digital gift card"
    );
    eq(
      res.sessionParams.get("line_items[0][price_data][product_data][tax_code]"),
      "txcd_10502000",
      "Gift card tax code txcd_10502000 assigned"
    );
    eq(
      res.sessionParams.get("line_items[0][price_data][tax_behavior]"),
      "exclusive",
      "Tax behavior is exclusive"
    );
    eq(
      res.sessionParams.get("metadata[gift_card_1_amount_cents]"),
      "5000",
      "Gift card 1 amount_cents is 5000"
    );
    // One metadata GROUP per gift-card line, carrying the quantity, rather
    // than one group per unit -- see H-8 in workers/checkout.js.
    eq(
      res.sessionParams.get("metadata[gift_card_1_qty]"),
      "2",
      "Gift card line records qty 2 in a single metadata group"
    );
    eq(
      res.sessionParams.get("metadata[gift_card_2_amount_cents]"),
      null,
      "No per-unit metadata expansion for a qty-2 gift card line"
    );
    eq(
      res.sessionParams.get("metadata[gift_card_1_recipient]"),
      "recipient@example.com",
      "Gift card recipient captured"
    );
  }

  // 1.11 Tax Calculation: Mixed Physical Goods + Apparel + Shipping Tax Code
  {
    const res = await executeWorkerCheckout({
      items: [
        { id: "lavender-soak", qty: 1 }, // $18.00 (General Tangible Goods)
        { id: "unisex-tshirt", variant: "M", qty: 1 } // $28.00 (Apparel)
      ]
    });

    eq(res.status, 200, "Mixed physical order succeeds");
    eq(
      res.sessionParams.get("line_items[0][price_data][product_data][tax_code]"),
      "txcd_99999999",
      "Lavender Soak assigned General Goods tax code (txcd_99999999)"
    );
    eq(
      res.sessionParams.get("line_items[1][price_data][product_data][tax_code]"),
      "txcd_30011000",
      "Unisex T-shirt assigned Apparel tax code (txcd_30011000)"
    );
    // Subtotal = $18 + $28 = $46 >= freeShippingThreshold ($40) -> Free shipping ($0)
    eq(
      res.sessionParams.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"),
      "0",
      "Shipping amount is 0 (qualifies for free shipping)"
    );
    eq(
      res.sessionParams.get("shipping_options[0][shipping_rate_data][tax_code]"),
      "txcd_92010001",
      "Shipping option assigned Shipping tax code (txcd_92010001)"
    );
  }

  // 1.12 Tax Calculation: Local Market Pickup Pinning vs Fallback
  {
    // Pickup with valid ZIP in Landrum, SC
    const validPickupLabel = "Landrum Farmers Market — Saturdays 9am-12pm (Landrum, SC)";
    const resValidPickup = await executeWorkerCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: validPickupLabel
    });

    eq(resValidPickup.status, 200, "Valid pickup checkout succeeds");
    eq(
      resValidPickup.sessionParams.get("customer"),
      "cus_mock_pickup_123",
      "Pins session to market Customer ID"
    );
    eq(
      resValidPickup.sessionParams.get("customer_update[address]"),
      "never",
      "Prevents checkout from overwriting market address"
    );
    eq(
      resValidPickup.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      null,
      "Skips shipping address form when pinned to market"
    );
    assert(resValidPickup.customerParams != null, "Created pickup customer in Stripe");
    eq(
      resValidPickup.customerParams.get("shipping[address][postal_code]"),
      "29356",
      "Customer postal code is Landrum 29356"
    );
    eq(resValidPickup.customerParams.get("shipping[address][state]"), "SC", "Customer state is SC");

    // Pickup with missing ZIP in events.json -> falls back to collecting shipping address
    const noZipPickupLabel = "Rural Market — Nov 5 (Somewhere, SC)";
    const resNoZip = await executeWorkerCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: noZipPickupLabel
    });

    eq(resNoZip.status, 200, "No-ZIP pickup falls back gracefully and succeeds");
    eq(
      resNoZip.sessionParams.get("customer"),
      null,
      "Does not pin customer when market ZIP is missing"
    );
    eq(
      resNoZip.sessionParams.get("customer_creation"),
      "always",
      "Creates new customer via standard Checkout flow"
    );
    // The market is real, it just has no ZIP recorded: tax falls back to the
    // buyer's own (billing) address, but the order is still a pickup, so no
    // delivery address is collected and no shipping is charged.
    eq(
      resNoZip.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      null,
      "A real market with no ZIP is still a pickup: no shipping address collected"
    );
    eq(
      resNoZip.sessionParams.get("billing_address_collection"),
      "required",
      "Billing address is still required so Stripe can rate the order"
    );

    // A label that is not on the calendar at all is ignored outright.
    const resForged = await executeWorkerCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: "Fake Market — Whenever (Portland, OR)"
    });
    eq(
      resForged.sessionParams.get("metadata[pickup_market]"),
      null,
      "A forged market label is never recorded as a pickup"
    );
    eq(
      resForged.sessionParams.get("metadata[pickup_market_rejected]"),
      "true",
      "A forged market label is flagged as rejected"
    );
    eq(
      resForged.sessionParams.get("shipping_address_collection[allowed_countries][0]"),
      "US",
      "A forged market label falls back to the ordinary shipped flow"
    );
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE 2: Cart State Transitions & Share Cart URL Loading & Merging
// ---------------------------------------------------------------------------
function testShareCartAndMerging() {
  console.log("\n=======================================================");
  console.log("SUITE 2: Cart State Transitions & Share Cart Merging");
  console.log("=======================================================");

  // 2.1 parseSharedCartParam with corrupted, malicious, and extreme inputs
  {
    // Empty / whitespace
    eq(cartEngine.parseSharedCartParam("", mockCatalog), [], "Empty string returns empty array");
    eq(
      cartEngine.parseSharedCartParam("   ,  , ", mockCatalog),
      [],
      "Whitespace commas return empty array"
    );

    // Prototype pollution attempts in slug
    const polluted = cartEngine.parseSharedCartParam(
      "__proto__:1,constructor:1,toString:1",
      mockCatalog
    );
    eq(polluted, [], "Prototype pollution keys are safely ignored and dropped");

    // XSS / SQL Injection in slug or variant
    const malicious = cartEngine.parseSharedCartParam(
      "<script>alert(1)</script>:1,'; DROP TABLE products;--:2",
      mockCatalog
    );
    eq(malicious, [], "Malicious script/SQL slugs are safely ignored and dropped");

    // Incomplete tokens and missing quantities
    const incomplete = cartEngine.parseSharedCartParam(
      "lavender-soak,lavender-soak:,lavender-soak::",
      mockCatalog
    );
    eq(incomplete.length, 3, "Incomplete tokens parsed");
    eq(incomplete[0].qty, 1, "Missing quantity defaults to 1");
    eq(incomplete[1].qty, 1, "Trailing colon quantity defaults to 1");

    // Quantity clamping to product stock (Frankincense stock is 4)
    const overstock = cartEngine.parseSharedCartParam("frankincense-salve:100:2oz", mockCatalog);
    eq(overstock[0].qty, 4, "Shared cart quantity clamped to catalog stock limit (4)");

    // Variant delta calculation
    const with1oz = cartEngine.parseSharedCartParam("frankincense-salve:2:1oz", mockCatalog);
    eq(with1oz[0].variantDelta, -6.0, "Variant delta correctly parsed for 1oz");
    eq(with1oz[0].variantLabel, "1oz", "Variant label correctly set");

    // Bundle slug parsing
    const withBundle = cartEngine.parseSharedCartParam("starter-self-care-set:1", mockCatalog);
    eq(withBundle.length, 1, "Bundle resolved from catalog");
    eq(withBundle[0].id, "starter-self-care-set", "Bundle id preserved");
  }

  // 2.2 Merging into existing cart list with addToList
  {
    // Existing list with 2x Frankincense (maxQty 4)
    let list = [{ id: "frankincense-salve", variantLabel: "2oz", qty: 2, maxQty: 4, price: 19.99 }];

    // Merge another 1x of same item
    list = cartEngine.addToList(list, {
      id: "frankincense-salve",
      variantLabel: "2oz",
      qty: 1,
      maxQty: 4,
      price: 19.99
    });
    eq(list.length, 1, "Same variant merges into single line");
    eq(list[0].qty, 3, "Quantities sum to 3");

    // Merge 5x of same item (should clamp to maxQty 4)
    list = cartEngine.addToList(list, {
      id: "frankincense-salve",
      variantLabel: "2oz",
      qty: 5,
      maxQty: 4,
      price: 19.99
    });
    eq(list[0].qty, 4, "Merged quantity clamped to maxQty 4");

    // Merge different variant (1oz)
    list = cartEngine.addToList(list, {
      id: "frankincense-salve",
      variantLabel: "1oz",
      qty: 1,
      maxQty: 4,
      price: 19.99,
      variantDelta: -6.0
    });
    eq(list.length, 2, "Different variant added as new line");

    // Merge Gift Cards (Each gift card must remain separate line)
    list = cartEngine.addToList(list, {
      id: "yallternative-gift-card",
      lineId: "gc-line-1",
      variantLabel: "Preset $25",
      qty: 1
    });
    list = cartEngine.addToList(list, {
      id: "yallternative-gift-card",
      lineId: "gc-line-2",
      variantLabel: "Preset $25",
      qty: 1
    });
    eq(list.length, 4, "Two gift cards stay distinct lines due to unique lineIds");
  }

  // 2.3 generateShareCartUrl roundtrip consistency
  {
    const originalItems = [
      { id: "lavender-soak", qty: 2, variantLabel: "" },
      { id: "frankincense-salve", qty: 1, variantLabel: "2oz" }
    ];
    const generatedUrl = cartEngine.generateShareCartUrl(originalItems);
    assert(generatedUrl.includes("cart="), "Generated share cart URL contains cart param");

    const paramValue = decodeURIComponent(generatedUrl.split("cart=")[1]);
    const parsedBack = cartEngine.parseSharedCartParam(paramValue, mockCatalog);
    eq(parsedBack.length, 2, "Roundtrip: parsed items match original item count");
    eq(parsedBack[0].id, "lavender-soak", "Roundtrip item 1 ID matches");
    eq(parsedBack[0].qty, 2, "Roundtrip item 1 qty matches");
    eq(parsedBack[1].id, "frankincense-salve", "Roundtrip item 2 ID matches");
    eq(parsedBack[1].variantLabel, "2oz", "Roundtrip item 2 variant matches");
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE 3: Browser Storage Boundary Conditions (Disabled, Full, Corrupt)
// ---------------------------------------------------------------------------
function testBrowserStorageBoundaries() {
  console.log("\n=======================================================");
  console.log("SUITE 3: Browser Storage Boundary Conditions");
  console.log("=======================================================");

  // 3.1 localStorage Completely Disabled (Throws SecurityError on all operations)
  {
    const storageThrower = {
      getItem: () => {
        const err = new Error("The operation is insecure.");
        err.name = "SecurityError";
        throw err;
      },
      setItem: () => {
        const err = new Error("The operation is insecure.");
        err.name = "SecurityError";
        throw err;
      },
      removeItem: () => {
        const err = new Error("The operation is insecure.");
        err.name = "SecurityError";
        throw err;
      }
    };

    global.localStorage = storageThrower;
    global.window = {
      localStorage: storageThrower,
      YL_PRODUCTS: mockCatalog,
      YL_CONTENT: { site: { loyaltyPointsPerDollar: 1 } }
    };

    // getWalletPoints & setWalletPoints should not throw
    let pts = -1;
    try {
      pts = cartEngine.getWalletPoints();
    } catch (e) {
      console.error(e);
    }
    eq(pts, 0, "getWalletPoints returns 0 when localStorage throws SecurityError");

    let setRes = -1;
    try {
      setRes = cartEngine.setWalletPoints(200);
    } catch (e) {
      console.error(e);
    }
    eq(setRes, 200, "setWalletPoints returns clean integer without throwing when storage blocked");
  }

  // 3.2 localStorage QuotaExceededError (Storage is full)
  {
    const storageMap = new Map();
    const quotaExceededStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: () => {
        const err = new Error("QuotaExceededError: DOM Exception 22");
        err.name = "QuotaExceededError";
        throw err;
      },
      removeItem: (k) => storageMap.delete(k)
    };

    global.localStorage = quotaExceededStorage;
    global.window.localStorage = quotaExceededStorage;

    // Setting points when quota exceeded should not crash
    let resPts = -1;
    try {
      resPts = cartEngine.setWalletPoints(100);
    } catch (e) {
      console.error(e);
    }
    eq(resPts, 100, "setWalletPoints handles QuotaExceededError gracefully");
  }

  // 3.3 Corrupted & Poisoned Storage Data
  {
    const storageMap = new Map();
    const mockStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      clear: () => storageMap.clear()
    };

    global.localStorage = mockStorage;
    global.window.localStorage = mockStorage;

    // Poison yl_loyalty_points with bad values
    for (const badVal of ["NaN", "-999", "undefined", "null", "{ bad: true }", "abc"]) {
      storageMap.set("yl_loyalty_points", badVal);
      const val = cartEngine.getWalletPoints();
      eq(
        val,
        0,
        `getWalletPoints returns safe 0 for poisoned storage value: ${JSON.stringify(badVal)}`
      );
    }

    // Huge points value
    storageMap.set("yl_loyalty_points", "999999");
    eq(cartEngine.getWalletPoints(), 999999, "getWalletPoints parses valid large numbers");
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE 4: DOM Lifecycle & Browser Cart Engine Adversarial Tests
// ---------------------------------------------------------------------------
async function testCartDOMAdversarial() {
  console.log("\n=======================================================");
  console.log("SUITE 4: DOM Lifecycle, Storage Failures & URL State");
  console.log("=======================================================");

  function createMockElement(tagName = "div") {
    const attrs = new Map();
    const children = [];
    const listeners = {};
    const el = {
      tagName: tagName.toUpperCase(),
      attributes: attrs,
      setAttribute: (name, val) => attrs.set(name, String(val)),
      getAttribute: (name) => attrs.get(name) || null,
      removeAttribute: (name) => attrs.delete(name),
      hasAttribute: (name) => attrs.has(name),
      dataset: {},
      style: {},
      classList: {
        _list: new Set(),
        add: function (...names) {
          names.forEach((n) => this._list.add(n));
        },
        remove: function (...names) {
          names.forEach((n) => this._list.delete(n));
        },
        contains: function (name) {
          return this._list.has(name);
        }
      },
      _innerHTML: "",
      get innerHTML() {
        return this._innerHTML;
      },
      set innerHTML(val) {
        this._innerHTML = val;
      },
      textContent: "",
      addEventListener: (evt, cb) => {
        if (!listeners[evt]) listeners[evt] = [];
        listeners[evt].push(cb);
      },
      removeEventListener: () => {},
      dispatchEvent: (evt) => {
        const type = typeof evt === "string" ? evt : evt.type;
        const list = listeners[type] || [];
        list.forEach((cb) => cb(evt));
      },
      appendChild: (child) => {
        children.push(child);
        return child;
      },
      insertBefore: (newNode) => {
        children.push(newNode);
        return newNode;
      },
      get children() {
        return children;
      },
      querySelector: function (sel) {
        if (!this._mockQs) this._mockQs = {};
        if (!this._mockQs[sel]) {
          this._mockQs[sel] = createMockElement("div");
          if (sel.startsWith("#")) {
            this._mockQs[sel].id = sel.substring(1);
          }
        }
        return this._mockQs[sel];
      },
      querySelectorAll: function (sel) {
        return [this.querySelector(sel)];
      },
      closest: () => null,
      focus: () => {}
    };
    return el;
  }

  const mockStorageMap = new Map();
  let throwOnStorage = null; // 'SecurityError' or 'QuotaExceededError' or null

  const resilientStorage = {
    getItem: (key) => {
      if (throwOnStorage === "SecurityError") {
        const err = new Error("SecurityError");
        err.name = "SecurityError";
        throw err;
      }
      return mockStorageMap.get(key) || null;
    },
    setItem: (key, val) => {
      if (throwOnStorage === "SecurityError") {
        const err = new Error("SecurityError");
        err.name = "SecurityError";
        throw err;
      }
      if (throwOnStorage === "QuotaExceededError") {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      mockStorageMap.set(key, String(val));
    },
    removeItem: (key) => {
      if (throwOnStorage === "SecurityError") {
        const err = new Error("SecurityError");
        err.name = "SecurityError";
        throw err;
      }
      mockStorageMap.delete(key);
    },
    clear: () => mockStorageMap.clear()
  };

  const mockDoc = {
    documentElement: createMockElement("html"),
    createElement: (tag) => createMockElement(tag),
    body: createMockElement("body"),
    addEventListener: () => {},
    readyState: "complete",
    querySelectorAll: () => [createMockElement("div")]
  };

  let replacedUrl = null;
  const mockWin = {
    document: mockDoc,
    localStorage: resilientStorage,
    addEventListener: () => {},
    location: {
      origin: "https://yallternativeliving.com",
      pathname: "/shop.html",
      search: "",
      hash: "#catalog"
    },
    history: {
      replaceState: (state, title, url) => {
        replacedUrl = url;
      }
    },
    YL_PRODUCTS: mockCatalog,
    YL_CONTENT: {
      site: {
        enableGiftOrders: true,
        enableShareCart: true,
        enableLoyaltyPoints: true,
        loyaltyPointsPerDollar: 1
      }
    }
  };

  global.window = mockWin;
  global.document = mockDoc;
  global.localStorage = resilientStorage;
  global.crypto = { randomUUID: () => "uuid-adversarial-123" };

  // Re-require / initialize cart DOM module
  delete require.cache[require.resolve("../assets/js/cart.js")];
  require("../assets/js/cart.js");
  const YLCart = global.window.YLCart;

  // 4.1 DOM init when localStorage throws SecurityError
  {
    mockStorageMap.clear();
    throwOnStorage = "SecurityError";
    let threw = false;
    try {
      YLCart.init({ force: true });
    } catch (e) {
      threw = true;
      console.error(e);
    }
    eq(threw, false, "YLCart.init does not throw when localStorage is blocked (SecurityError)");
    eq(YLCart.items().length, 0, "Cart initializes safely with empty items");
    throwOnStorage = null;
  }

  // 4.2 addItem and addItems when localStorage throws QuotaExceededError
  {
    mockStorageMap.clear();
    throwOnStorage = "QuotaExceededError";
    let threw = false;
    try {
      YLCart.addItem({ id: "lavender-soak", name: "Lavender Soak", price: 18.0, qty: 1 });
      YLCart.addItems([
        { id: "frankincense-salve", name: "Frankincense Salve", price: 19.99, qty: 2 }
      ]);
    } catch (e) {
      threw = true;
      console.error(e);
    }
    eq(
      threw,
      false,
      "YLCart.addItem / addItems do not throw when localStorage throws QuotaExceededError"
    );
    eq(YLCart.items().length, 2, "Items successfully added in-memory despite full storage");
    eq(YLCart.count(), 3, "Cart count accurately reflects in-memory state");
    throwOnStorage = null;
  }

  // 4.3 Corrupted storage recovery during init()
  {
    // Corrupted cart JSON
    mockStorageMap.set("yl-cart-v1", "{ malformed json: not valid");
    mockStorageMap.set("yl_applied_gift_card", "{ not a gift card");
    mockStorageMap.set("yl_loyalty_points", "invalid-points");

    YLCart.init({ force: true });
    eq(YLCart.items(), [], "Recovers from malformed yl-cart-v1 without crashing");
    eq(YLCart.count(), 0, "Cart count resets to 0");
    eq(YLCart.getWalletPoints(), 0, "Wallet points recover safely to 0");
  }

  // 4.4 Array containing poisoned non-objects in yl-cart-v1
  {
    mockStorageMap.set("yl-cart-v1", JSON.stringify([null, 42, "string", {}, { id: "" }]));
    let loadCrashed = false;
    let crashError = null;
    try {
      YLCart.init({ force: true });
    } catch (e) {
      loadCrashed = true;
      crashError = e.message;
    }
    // Record empirical observation: load() blindly accepts Array.isArray(parsed)
    // without filtering non-null items, causing totalCount() to throw TypeError.
    assert(
      loadCrashed === true && crashError.includes("Cannot read properties of null"),
      "Empirical vulnerability confirmed: poisoned array [null] in localStorage crashes totalCount() during init()",
      `Observed error: ${crashError}`
    );
  }

  // 4.5 restoreCartFromUrl with URL state cleanup
  {
    mockStorageMap.clear();
    YLCart.clear();
    mockWin.location.search =
      "?utm_source=fb&cart=lavender-soak:2,frankincense-salve:1:2oz&tag=alt";
    replacedUrl = null;

    const restored = YLCart.restoreCartFromUrl();
    eq(restored, true, "restoreCartFromUrl returns true on valid URL cart parameter");
    eq(YLCart.items().length, 2, "Cart restored 2 distinct products");
    eq(YLCart.count(), 3, "Cart total count is 3");
    assert(replacedUrl != null, "history.replaceState was called to clean URL");
    assert(!replacedUrl.includes("cart="), "Cleaned URL does not contain cart param");
    assert(replacedUrl.includes("utm_source=fb"), "Cleaned URL preserved utm_source param");
    assert(replacedUrl.includes("tag=alt"), "Cleaned URL preserved tag param");
    assert(replacedUrl.includes("#catalog"), "Cleaned URL preserved hash fragment");
  }

  // 4.6 Loyalty points 1-click redemption error handling
  {
    mockStorageMap.clear();
    YLCart.clear();
    YLCart.addItem({ id: "lavender-soak", price: 18.0, qty: 2 });
    YLCart.setWalletPoints(150);

    const originalFetch = global.fetch;

    // Simulate network error on redeem-points
    global.fetch = async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "Server database connection failed" })
      };
    };

    let threwError = false;
    try {
      await YLCart.redeemLoyaltyPoints(100);
    } catch (e) {
      threwError = true;
    }
    eq(threwError, true, "redeemLoyaltyPoints rejects on server error response");
    eq(
      YLCart.getWalletPoints(),
      150,
      "Wallet points NOT deducted on failed redemption (remains 150)"
    );

    // Restore fetch
    global.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------
async function runAllChallengerTests() {
  console.log("Starting Adversarial Stress Testing for Milestone 1...\n");

  await testWorkerAdversarial();
  testShareCartAndMerging();
  testBrowserStorageBoundaries();
  await testCartDOMAdversarial();

  console.log("\n=======================================================");
  console.log(`Challenger M1 Stress Results: ${totalPassed} Passed, ${totalFailed} Failed`);
  console.log("=======================================================\n");

  if (totalFailed > 0) {
    console.error(`\nFAILED: ${totalFailed} tests failed.`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All adversarial stress test vectors passed cleanly.");
    process.exit(0);
  }
}

runAllChallengerTests().catch((err) => {
  console.error("Unhandled error in challenger test suite:", err);
  process.exit(1);
});
