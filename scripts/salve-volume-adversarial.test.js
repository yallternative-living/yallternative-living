/**
 * @fileoverview Adversarial Stress Test Suite for 2oz Salve Mix-and-Match Volume Pricing
 * Tests complex cart baskets, category exclusions, variant distinctions, and server-side
 * security/anti-tampering protections across assets/js/cart.js and workers/checkout.js.
 */

const assert = require("assert");
const cart = require("../assets/js/cart.js");
const checkout = require("../workers/checkout.js");
const catalogData = require("../assets/data/products.json");

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
}

// Helper to simulate worker checkout session generation
async function runWorkerCheckout(items, bodyOverride) {
  let capturedStripeBody = null;
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
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
        json: async () => ({ upcoming: [], past: [] })
      };
    }
    if (u.includes("/v1/tax/settings")) {
      return { ok: true, json: async () => ({ status: "active" }) };
    }
    if (u.includes("/v1/checkout/sessions")) {
      capturedStripeBody = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({ url: "https://checkout.stripe.com/c/test_session_id" })
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
      body: JSON.stringify(bodyOverride || { items: items })
    });

    const env = {
      SITE_ORIGIN: "https://yallternativeliving.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_TAX_ENABLED: "false"
    };

    const res = await checkout.default.fetch(req, env, { waitUntil: () => {} });
    return { res, capturedStripeBody };
  } finally {
    global.fetch = originalFetch;
  }
}

async function runAllTests() {
  console.log("Starting Adversarial 2oz Salve Volume Pricing Tests...\n");

  /* =========================================================================
     TEST SCENARIO 1: 1x 2oz Frankincense ($20.00) - Single Base
     ========================================================================= */
  console.log("--- Scenario 1: 1x 2oz Frankincense ($20.00) ---");
  const basket1 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 1
    }
  ];
  eq(cart.qualifying2ozSalveCount(basket1), 1, "Scenario 1: count is 1");
  eq(cart.unitPrice(basket1[0], basket1), 20, "Scenario 1: cart unitPrice is $20.00");
  eq(cart.subtotal(basket1), 20, "Scenario 1: cart subtotal is $20.00");

  const checkout1 = await runWorkerCheckout([{ id: "frankincense-salve", qty: 1, variant: "2oz" }]);
  eq(checkout1.res.status, 200, "Scenario 1: worker returns 200");
  eq(
    checkout1.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "2000",
    "Scenario 1: worker unit amount is 2000 cents"
  );
  eq(checkout1.capturedStripeBody.get("line_items[0][quantity]"), "1", "Scenario 1: quantity is 1");

  /* =========================================================================
     TEST SCENARIO 2: 2x 2oz Frankincense ($30.00) - Multi-Buy Tier
     ========================================================================= */
  console.log("--- Scenario 2: 2x 2oz Frankincense ($30.00) ---");
  const basket2 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 2
    }
  ];
  eq(cart.qualifying2ozSalveCount(basket2), 2, "Scenario 2: count is 2");
  eq(cart.unitPrice(basket2[0], basket2), 15, "Scenario 2: cart unitPrice is $15.00");
  eq(cart.subtotal(basket2), 30, "Scenario 2: cart subtotal is $30.00");

  const checkout2 = await runWorkerCheckout([{ id: "frankincense-salve", qty: 2, variant: "2oz" }]);
  eq(checkout2.res.status, 200, "Scenario 2: worker returns 200");
  eq(
    checkout2.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Scenario 2: worker unit amount is 1500 cents"
  );
  eq(checkout2.capturedStripeBody.get("line_items[0][quantity]"), "2", "Scenario 2: quantity is 2");

  /* =========================================================================
     TEST SCENARIO 3: 1x 2oz Frankincense + 1x 2oz Sleep Salve ($30.00) - Mix & Match
     ========================================================================= */
  console.log("--- Scenario 3: 1x 2oz Frankincense + 1x 2oz Sleep Salve ($30.00) ---");
  const basket3 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 1
    },
    { id: "sleep-salve", category: "salves", price: 20, variantDelta: 0, qty: 1 }
  ];
  eq(cart.qualifying2ozSalveCount(basket3), 2, "Scenario 3: count is 2");
  eq(cart.unitPrice(basket3[0], basket3), 15, "Scenario 3: Frankincense unitPrice is $15.00");
  eq(cart.unitPrice(basket3[1], basket3), 15, "Scenario 3: Sleep Salve unitPrice is $15.00");
  eq(cart.subtotal(basket3), 30, "Scenario 3: cart subtotal is $30.00");

  const checkout3 = await runWorkerCheckout([
    { id: "frankincense-salve", qty: 1, variant: "2oz" },
    { id: "sleep-salve", qty: 1 }
  ]);
  eq(checkout3.res.status, 200, "Scenario 3: worker returns 200");
  eq(
    checkout3.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Scenario 3: Frankincense unit amount is 1500 cents"
  );
  eq(
    checkout3.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "1500",
    "Scenario 3: Sleep Salve unit amount is 1500 cents"
  );

  /* =========================================================================
     TEST SCENARIO 4: 3x 2oz Qualifying Salves ($45.00) - Multi-Buy Tier
     ========================================================================= */
  console.log("--- Scenario 4: 3x 2oz Qualifying Salves ($45.00) ---");
  const basket4 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 2
    },
    { id: "sleep-salve", category: "salves", price: 20, variantDelta: 0, qty: 1 }
  ];
  eq(cart.qualifying2ozSalveCount(basket4), 3, "Scenario 4: count is 3");
  eq(cart.unitPrice(basket4[0], basket4), 15, "Scenario 4: Frankincense unitPrice is $15.00");
  eq(cart.unitPrice(basket4[1], basket4), 15, "Scenario 4: Sleep Salve unitPrice is $15.00");
  eq(cart.subtotal(basket4), 45, "Scenario 4: cart subtotal is $45.00");

  const checkout4 = await runWorkerCheckout([
    { id: "frankincense-salve", qty: 2, variant: "2oz" },
    { id: "sleep-salve", qty: 1 }
  ]);
  eq(checkout4.res.status, 200, "Scenario 4: worker returns 200");
  eq(
    checkout4.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Scenario 4: Frankincense unit amount is 1500 cents"
  );
  eq(
    checkout4.capturedStripeBody.get("line_items[0][quantity]"),
    "2",
    "Scenario 4: Frankincense qty is 2"
  );
  eq(
    checkout4.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "1500",
    "Scenario 4: Sleep Salve unit amount is 1500 cents"
  );
  eq(
    checkout4.capturedStripeBody.get("line_items[1][quantity]"),
    "1",
    "Scenario 4: Sleep Salve qty is 1"
  );

  /* =========================================================================
     TEST SCENARIO 5: 4x 2oz Qualifying Salves ($60.00) - Multi-Buy Tier
     ========================================================================= */
  console.log("--- Scenario 5: 4x 2oz Qualifying Salves ($60.00) ---");
  const basket5 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 2
    },
    { id: "sleep-salve", category: "salves", price: 20, variantDelta: 0, qty: 2 }
  ];
  eq(cart.qualifying2ozSalveCount(basket5), 4, "Scenario 5: count is 4");
  eq(cart.subtotal(basket5), 60, "Scenario 5: cart subtotal is $60.00");

  const checkout5 = await runWorkerCheckout([
    { id: "frankincense-salve", qty: 2, variant: "2oz" },
    { id: "sleep-salve", qty: 2 }
  ]);
  eq(checkout5.res.status, 200, "Scenario 5: worker returns 200");
  eq(
    checkout5.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1500",
    "Scenario 5: Frankincense unit amount is 1500 cents"
  );
  eq(
    checkout5.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "1500",
    "Scenario 5: Sleep Salve unit amount is 1500 cents"
  );

  /* =========================================================================
     TEST SCENARIO 6: 1x 1oz Frankincense ($14.00) + 1x 2oz Sleep Salve ($20.00) -> $34.00 (no discount)
     ========================================================================= */
  console.log("--- Scenario 6: 1x 1oz Frankincense ($14.00) + 1x 2oz Sleep Salve ($20.00) ---");
  const basket6 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: -6.0,
      variantLabel: "1oz",
      qty: 1
    },
    { id: "sleep-salve", category: "salves", price: 20, variantDelta: 0, qty: 1 }
  ];
  eq(cart.qualifying2ozSalveCount(basket6), 1, "Scenario 6: qualifying 2oz count is 1");
  eq(cart.unitPrice(basket6[0], basket6), 14, "Scenario 6: 1oz Frankincense is $14.00");
  eq(cart.unitPrice(basket6[1], basket6), 20, "Scenario 6: 2oz Sleep Salve is $20.00");
  eq(cart.subtotal(basket6), 34, "Scenario 6: cart subtotal is $34.00");

  const checkout6 = await runWorkerCheckout([
    { id: "frankincense-salve", qty: 1, variant: "1oz" },
    { id: "sleep-salve", qty: 1 }
  ]);
  eq(checkout6.res.status, 200, "Scenario 6: worker returns 200");
  eq(
    checkout6.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Scenario 6: 1oz Frankincense is 1400 cents"
  );
  eq(
    checkout6.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "2000",
    "Scenario 6: 2oz Sleep Salve is 2000 cents"
  );

  /* =========================================================================
     TEST SCENARIO 7: 2x 1oz Frankincense ($14.00 ea = $28.00) -> $28.00 (no discount)
     ========================================================================= */
  console.log("--- Scenario 7: 2x 1oz Frankincense ($28.00) ---");
  const basket7 = [
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: -6.0,
      variantLabel: "1oz",
      qty: 2
    }
  ];
  eq(cart.qualifying2ozSalveCount(basket7), 0, "Scenario 7: qualifying 2oz count is 0");
  eq(cart.unitPrice(basket7[0], basket7), 14, "Scenario 7: 1oz unitPrice is $14.00");
  eq(cart.subtotal(basket7), 28, "Scenario 7: subtotal is $28.00");

  const checkout7 = await runWorkerCheckout([{ id: "frankincense-salve", qty: 2, variant: "1oz" }]);
  eq(checkout7.res.status, 200, "Scenario 7: worker returns 200");
  eq(
    checkout7.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Scenario 7: 1oz Frankincense is 1400 cents"
  );
  eq(checkout7.capturedStripeBody.get("line_items[0][quantity]"), "2", "Scenario 7: quantity is 2");

  /* =========================================================================
     TEST SCENARIO 8: 1x Beard Salve ($14.00) + 1x 2oz Frankincense ($20.00) -> $34.00 (no discount)
     ========================================================================= */
  console.log("--- Scenario 8: 1x Beard Salve + 1x 2oz Frankincense ($34.00) ---");
  const basket8 = [
    { id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 1 },
    {
      id: "frankincense-salve",
      category: "salves",
      price: 20,
      variantDelta: 0,
      variantLabel: "2oz",
      qty: 1
    }
  ];
  eq(cart.qualifying2ozSalveCount(basket8), 1, "Scenario 8: qualifying 2oz count is 1");
  eq(cart.unitPrice(basket8[0], basket8), 14.0, "Scenario 8: Beard Salve unitPrice is $14.00");
  eq(cart.unitPrice(basket8[1], basket8), 20, "Scenario 8: 2oz Frankincense unitPrice is $20.00");
  eq(cart.subtotal(basket8), 34, "Scenario 8: subtotal is $34.00");

  const checkout8 = await runWorkerCheckout([
    { id: "beard-salve", qty: 1 },
    { id: "frankincense-salve", qty: 1, variant: "2oz" }
  ]);
  eq(checkout8.res.status, 200, "Scenario 8: worker returns 200");
  eq(
    checkout8.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Scenario 8: Beard Salve is 1400 cents"
  );
  eq(
    checkout8.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "2000",
    "Scenario 8: Frankincense is 2000 cents"
  );

  /* =========================================================================
     TEST SCENARIO 9: 2x Beard Salve ($14.00 ea = $28.00) -> $28.00 (no discount)
     ========================================================================= */
  console.log("--- Scenario 9: 2x Beard Salve ($28.00) ---");
  const basket9 = [{ id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 2 }];
  eq(cart.qualifying2ozSalveCount(basket9), 0, "Scenario 9: qualifying count is 0");
  eq(cart.unitPrice(basket9[0], basket9), 14.0, "Scenario 9: Beard Salve unitPrice is $14.00");
  eq(cart.subtotal(basket9), 28.0, "Scenario 9: subtotal is $28.00");

  const checkout9 = await runWorkerCheckout([{ id: "beard-salve", qty: 2 }]);
  eq(checkout9.res.status, 200, "Scenario 9: worker returns 200");
  eq(
    checkout9.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Scenario 9: Beard Salve is 1400 cents"
  );
  eq(checkout9.capturedStripeBody.get("line_items[0][quantity]"), "2", "Scenario 9: quantity is 2");

  /* =========================================================================
     TEST SCENARIO 10: 1x Miracle Balm ($8.00) + 1x 2oz Sleep Salve ($20.00) -> $28.00 (no discount)
     ========================================================================= */
  console.log("--- Scenario 10: 1x Miracle Balm + 1x 2oz Sleep Salve ($28.00) ---");
  const basket10 = [
    { id: "miracle-balm", category: "salves", price: 8.0, variantDelta: 0, qty: 1 },
    { id: "sleep-salve", category: "salves", price: 20, variantDelta: 0, qty: 1 }
  ];
  eq(cart.qualifying2ozSalveCount(basket10), 1, "Scenario 10: qualifying count is 1");
  eq(cart.unitPrice(basket10[0], basket10), 8.0, "Scenario 10: Miracle Balm unitPrice is $8.00");
  eq(cart.unitPrice(basket10[1], basket10), 20, "Scenario 10: Sleep Salve unitPrice is $20.00");
  eq(cart.subtotal(basket10), 28, "Scenario 10: subtotal is $28.00");

  const checkout10 = await runWorkerCheckout([
    { id: "miracle-balm", qty: 1 },
    { id: "sleep-salve", qty: 1 }
  ]);
  eq(checkout10.res.status, 200, "Scenario 10: worker returns 200");
  eq(
    checkout10.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "800",
    "Scenario 10: Miracle Balm is 800 cents"
  );
  eq(
    checkout10.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "2000",
    "Scenario 10: Sleep Salve is 2000 cents"
  );

  /* =========================================================================
     TEST SCENARIO 11: Security & Anti-Tampering Vectors
     ========================================================================= */
  console.log("--- Scenario 11: Security & Anti-Tampering Vectors ---");

  // Attack 11A: Client price manipulation
  const attack11A = await runWorkerCheckout([
    { id: "frankincense-salve", variant: "2oz", qty: 1, price: 1.0, unitAmount: 100 }
  ]);
  eq(attack11A.res.status, 200, "Attack 11A: worker succeeds");
  eq(
    attack11A.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "2000",
    "Attack 11A: price override ignored; charges 2000 cents"
  );

  // Attack 11B: Negative delta tampering
  const attack11B = await runWorkerCheckout([
    { id: "frankincense-salve", variant: "2oz", qty: 1, variantDelta: -15.0 }
  ]);
  eq(attack11B.res.status, 200, "Attack 11B: worker succeeds");
  eq(
    attack11B.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "2000",
    "Attack 11B: variantDelta override ignored; charges 2000 cents"
  );

  // Attack 11C: Invalid variant name injection.
  // This used to "fall back safely to base price" -- which was not safe at
  // all: it sold a product at a price/size combination no page ever offered
  // and left the packing slip with a size that doesn't exist. A variant that
  // isn't in the catalog's own option list is now not purchasable.
  const attack11C = await runWorkerCheckout([
    { id: "frankincense-salve", variant: "10oz-free", qty: 1 }
  ]);
  eq(attack11C.res.status, 400, "Attack 11C: invented variant is rejected, not silently repriced");
  eq(
    attack11C.capturedStripeBody,
    null,
    "Attack 11C: no Stripe session is created for an invented variant"
  );
  const attack11C2 = await runWorkerCheckout([{ id: "frankincense-salve", qty: 1 }]);
  eq(
    attack11C2.res.status,
    400,
    "Attack 11C: a product sold by size cannot be ordered with no size at all"
  );

  // Attack 11D: Category spoofing on non-salve item
  // Attacker attempts to pass category: "salves" on beard-salve
  const attack11D = await runWorkerCheckout([
    { id: "beard-salve", qty: 2, category: "salves" },
    { id: "frankincense-salve", variant: "2oz", qty: 1 }
  ]);
  eq(attack11D.res.status, 200, "Attack 11D: worker responds");
  eq(
    attack11D.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "1400",
    "Attack 11D: Beard Salve is charged 1400 cents"
  );

  // Verify Frankincense is charged full base price (2000 cents) because server ignored spoofed category on beard-salve
  eq(
    attack11D.capturedStripeBody.get("line_items[1][price_data][unit_amount]"),
    "2000",
    "Attack 11D: Frankincense charged full base price 2000 cents (server ignored spoofed category on beard-salve)"
  );

  // Attack 11E: Miracle Balm variant spoofing
  const attack11E = await runWorkerCheckout([{ id: "miracle-balm", variant: "2oz", qty: 2 }]);
  eq(
    attack11E.res.status,
    200,
    "Attack 11E: Miracle Balm has no variants, falls back safely to base price"
  );
  eq(
    attack11E.capturedStripeBody.get("line_items[0][price_data][unit_amount]"),
    "800",
    "Attack 11E: charges base price 800 cents"
  );

  // Attack 11F: Non-existent product ID
  const attack11F = await runWorkerCheckout([{ id: "non-existent-herbal-salve", qty: 1 }]);
  eq(attack11F.res.status, 400, "Attack 11F: unknown product rejected with 400 ClientError");

  // Attack 11G: Zero and negative qty clamping
  const attack11G = await runWorkerCheckout([{ id: "sleep-salve", qty: 0 }]);
  eq(attack11G.res.status, 200, "Attack 11G: 0 qty clamped to 1");
  eq(
    attack11G.capturedStripeBody.get("line_items[0][quantity]"),
    "1",
    "Attack 11G: quantity clamped to 1"
  );

  // Attack 11H: Huge qty clamping
  const attack11H = await runWorkerCheckout([{ id: "sleep-salve", qty: 9999 }]);
  eq(attack11H.res.status, 200, "Attack 11H: huge qty clamped to MAX_QTY_PER_ITEM");
  eq(
    attack11H.capturedStripeBody.get("line_items[0][quantity]"),
    "99",
    "Attack 11H: quantity clamped to 99 (MAX_QTY_PER_ITEM)"
  );

  /* =========================================================================
     TEST SCENARIO 12: Dynamic Multi-Rule Concurrent Volume Pricing
     ========================================================================= */
  console.log("--- Scenario 12: Multi-Rule Concurrent Volume Pricing ---");
  const customCatalog = JSON.parse(JSON.stringify(catalogData));
  customCatalog.volumePricing = customCatalog.shop.volumePricing = [
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
      id: "body-all",
      name: "Body Care Multi-Buy",
      category: "body",
      minQuantity: 2,
      unitPrice: 12.0,
      label: "2+ for $12.00 each",
      enabled: true
    }
  ];

  const originalFetch12 = global.fetch;
  let customStripeBody = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => customCatalog };
    }
    if (u.includes("events.json")) {
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => ({ upcoming: [], past: [] })
      };
    }
    if (u.includes("/v1/tax/settings")) {
      return { ok: true, json: async () => ({ status: "active" }) };
    }
    if (u.includes("/v1/checkout/sessions")) {
      customStripeBody = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ url: "https://checkout.stripe.com/c/test" }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const req12 = new Request("https://yallternativeliving.com/api/checkout", {
      method: "POST",
      headers: { Origin: "https://yallternativeliving.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { id: "frankincense-salve", qty: 2, variant: "2oz" },
          { id: "beard-salve", qty: 2 }
        ]
      })
    });
    const res12 = await checkout.default.fetch(
      req12,
      {
        SITE_ORIGIN: "https://yallternativeliving.com",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_TAX_ENABLED: "false"
      },
      { waitUntil: () => {} }
    );
    eq(res12.status, 200, "Scenario 12: worker returns 200 for multi-rule checkout");
    eq(
      customStripeBody.get("line_items[0][price_data][unit_amount]"),
      "1500",
      "Scenario 12: 2x 2oz Frankincense charged 1500 cents each"
    );
    eq(
      customStripeBody.get("line_items[1][price_data][unit_amount]"),
      "1200",
      "Scenario 12: 2x Beard Salve (body category) charged 1200 cents each"
    );
  } finally {
    global.fetch = originalFetch12;
  }

  console.log("\nAll adversarial tests executed successfully!");
}

runAllTests().catch((err) => {
  console.error("Adversarial Test Suite Failed:", err);
  process.exit(1);
});
