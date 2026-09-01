/**
 * @fileoverview Unit tests for the pure cart-math in assets/js/cart.js
 * (the Stripe cart engine). Run: node scripts/cart-engine.test.js
 *
 * These exercise the logic that can be verified without a browser: line
 * identity, variant-delta parsing, quantity clamping, unit price, subtotal,
 * merge-on-add, and the Stripe checkout payload shape.
 */

/* cart.js binds its `root` once, at load time (window when there is one), so
   a stand-in has to exist before the require for freeShipThreshold() to be
   testable against different catalogs. There's still no `document`, so the
   DOM half of cart.js stays inert exactly as before. */
global.window = global.window || {};

const cart = require("../assets/js/cart.js");

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

// deltaForLabel parses Snipcart-style "Label[+X.XX]|..." options
eq(cart.deltaForLabel("S[+0.00]|M[+0.00]|L[+2.00]", "L"), 2, "deltaForLabel positive");
eq(cart.deltaForLabel("Small[-1.50]|Large[+0.00]", "Small"), -1.5, "deltaForLabel negative");
eq(cart.deltaForLabel("S[+0.00]|M[+0.00]", "XL"), 0, "deltaForLabel missing label -> 0");
eq(cart.deltaForLabel("", "M"), 0, "deltaForLabel empty options -> 0");

// clampQty
eq(cart.clampQty(0), 1, "clampQty floor");
eq(cart.clampQty(5), 5, "clampQty normal");
eq(cart.clampQty(999), 99, "clampQty ceiling (no cap)");
eq(cart.clampQty("abc"), 1, "clampQty non-numeric");
// Per-product stock cap (data-item-max-quantity), always <= the hard 99 ceiling.
eq(cart.clampQty(3, 5), 3, "clampQty under per-product cap");
eq(cart.clampQty(9, 5), 5, "clampQty over per-product cap");
eq(cart.clampQty(999, 5), 5, "clampQty per-product cap wins over hard ceiling");
eq(cart.clampQty(999, 500), 99, "clampQty hard ceiling wins when cap is looser");

// addToList respects a per-product max-quantity cap on merge.
let cappedList = [];
cappedList = cart.addToList(cappedList, { id: "frankincense-salve", qty: 2, maxQty: 3 });
cappedList = cart.addToList(cappedList, { id: "frankincense-salve", qty: 5, maxQty: 3 });
eq(cappedList[0].qty, 3, "addToList: merge respects per-product maxQty cap");

// lineKey distinguishes variants
eq(cart.lineKey({ id: "tank-top", variantLabel: "M" }), "tank-top|M", "lineKey with variant");
eq(cart.lineKey({ id: "salve" }), "salve|", "lineKey no variant");

// unitPrice = base + delta, never negative
eq(cart.unitPrice({ price: 25, variantDelta: 2 }), 27, "unitPrice base+delta");
eq(cart.unitPrice({ price: 10, variantDelta: -50 }), 0, "unitPrice clamped at 0");

// subtotal + totalCount
const items = [
  { id: "a", price: 25, variantDelta: 0, qty: 2 },
  { id: "b", price: 10, variantDelta: 2, qty: 1 }
];
eq(cart.subtotal(items), 62, "subtotal 25*2 + 12");
eq(cart.totalCount(items), 3, "totalCount");

// addToList merges same line, caps qty, keeps variants separate
let list = [];
list = cart.addToList(list, { id: "tank", variantLabel: "M", qty: 1 });
list = cart.addToList(list, { id: "tank", variantLabel: "M", qty: 2 });
eq(list.length, 1, "addToList merges same line");
eq(list[0].qty, 3, "addToList sums qty");
list = cart.addToList(list, { id: "tank", variantLabel: "L", qty: 1 });
eq(list.length, 2, "addToList keeps different variants separate");
list = cart.addToList(list, { id: "tank", variantLabel: "M", qty: 500 });
eq(list[0].qty, 99, "addToList caps merged qty at 99");

// toCheckoutPayload = only {id, qty, variant} (never client price)
eq(
  cart.toCheckoutPayload([
    { id: "tank", variantLabel: "M", price: 25, variantDelta: 0, qty: 2 },
    { id: "salve", variantLabel: "", price: 16, qty: 1 }
  ]),
  {
    items: [
      { id: "tank", qty: 2, variant: "M" },
      { id: "salve", qty: 1 }
    ]
  },
  "toCheckoutPayload shape (no prices leaked)"
);

// Gift cards: lineKey must be unique per add (via lineId), so two gift
// cards -- even at the identical dollar amount -- never merge and each
// keeps its own recipient/sender/message.
eq(
  cart.lineKey({ id: "yallternative-gift-card", lineId: "aaa", variantLabel: "Preset $25" }),
  "yallternative-gift-card|aaa",
  "lineKey: gift card keyed by lineId, not variant"
);
let giftList = [];
giftList = cart.addToList(giftList, {
  id: "yallternative-gift-card",
  lineId: "line-1",
  variantLabel: "Preset $25",
  qty: 1
});
giftList = cart.addToList(giftList, {
  id: "yallternative-gift-card",
  lineId: "line-2",
  variantLabel: "Preset $25",
  qty: 1
});
eq(giftList.length, 2, "addToList: two gift cards at same amount stay separate lines");

// toCheckoutPayload: gift metadata included only for gift-card lines with
// values set; omitted entirely for ordinary products (no metadata bloat).
eq(
  cart.toCheckoutPayload([
    {
      id: "yallternative-gift-card",
      lineId: "line-1",
      variantLabel: "Preset $25",
      qty: 1,
      giftRecipientEmail: "friend@example.com",
      giftSenderName: "Sam",
      giftMessage: "Happy birthday!"
    },
    { id: "tank-top", variantLabel: "M", price: 25, variantDelta: 0, qty: 1 }
  ]),
  {
    items: [
      {
        id: "yallternative-gift-card",
        qty: 1,
        variant: "Preset $25",
        giftRecipientEmail: "friend@example.com",
        giftSenderName: "Sam",
        giftMessage: "Happy birthday!"
      },
      { id: "tank-top", qty: 1, variant: "M" }
    ]
  },
  "toCheckoutPayload: gift metadata attached only to gift-card line"
);

// 2oz Salve Mix-and-Match Volume Pricing Test Suite
// 1. Single 2oz Frankincense (No volume discount)
const cart1 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart1), 19.99, "1x 2oz Frankincense = $19.99");
eq(cart.unitPrice(cart1[0], cart1), 19.99, "1x 2oz Frankincense unit price = $19.99");

// 2. Single 2oz Sleep Salve (No volume discount)
const cart2 = [{ id: "sleep-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }];
eq(cart.subtotal(cart2), 19.99, "1x 2oz Sleep Salve = $19.99");

// 3. Two 2oz Frankincense Salves (Volume discount applies)
const cart3 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 2 }
];
eq(cart.subtotal(cart3), 29.98, "2x 2oz Frankincense = $29.98 ($14.99 each)");
eq(cart.unitPrice(cart3[0], cart3), 14.99, "2x 2oz Frankincense unit price drops to $14.99");

// 4. Mix-and-match: 1x 2oz Frankincense + 1x 2oz Sleep Salve (Volume discount applies)
const cart4 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 },
  { id: "sleep-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart4), 29.98, "1x 2oz Frankincense + 1x 2oz Sleep Salve = $29.98 ($14.99 each)");
eq(cart.unitPrice(cart4[0], cart4), 14.99, "Mix-and-match Frankincense unit price = $14.99");
eq(cart.unitPrice(cart4[1], cart4), 14.99, "Mix-and-match Sleep Salve unit price = $14.99");

// 5. 3x Qualifying 2oz Salves (Volume discount applies across all units)
const cart5 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "sleep-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart5), 44.97, "3x 2oz qualifying salves = $44.97 ($14.99 each)");

// 6. 1oz Frankincense Variant Exclusion
const cart6 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: -6.0, variantLabel: "1oz", qty: 1 },
  { id: "sleep-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart6),
  33.98,
  "1x 1oz Frankincense ($13.99) + 1x 2oz Sleep Salve ($19.99) = $33.98 (no discount)"
);

// 7. Beard Salve Exclusion
const cart7 = [
  { id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 1 },
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart7),
  33.99,
  "1x Beard Salve ($14.00) + 1x 2oz Frankincense ($19.99) = $33.99 (no discount)"
);

// 8. Miracle Balm (.5oz) Exclusion
const cart8 = [
  { id: "miracle-balm", price: 8.0, variantDelta: 0, qty: 1 },
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart8),
  27.99,
  "1x Miracle Balm ($8.00) + 1x 2oz Frankincense ($19.99) = $27.99 (no discount)"
);

// 9. Mixed Basket (Qualifying + Excluded Items)
const cart9 = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "frankincense-salve", price: 19.99, variantDelta: -6.0, variantLabel: "1oz", qty: 1 },
  { id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 1 },
  { id: "miracle-balm", price: 8.0, variantDelta: 0, qty: 1 }
];
eq(
  cart.subtotal(cart9),
  65.97,
  "2x 2oz ($29.98) + 1x 1oz ($13.99) + 1x Beard ($14) + 1x Miracle ($8) = $65.97"
);

// 10. Multi-Rule Volume Pricing (Salves + Soaks concurrently)
global.window = global.window || {};
global.window.YL_PRODUCTS = {
  shop: {
    volumePricing: [
      {
        id: "salves-2oz",
        name: "2oz Salve Multi-Buy",
        category: "salves",
        qualifyingVariant: "2oz",
        minQuantity: 2,
        unitPrice: 14.99,
        label: "2+ for $14.99 each",
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
  },
  products: [
    { id: "frankincense-salve", category: "salves", price: 19.99 },
    { id: "sleep-salve", category: "salves", price: 19.99 },
    { id: "lavender-soak", category: "soaks", price: 18.0 },
    { id: "ritual-soak", category: "soaks", price: 18.0 }
  ]
};

const cartMulti = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "lavender-soak", category: "soaks", price: 18.0, variantDelta: 0, qty: 1 },
  { id: "ritual-soak", category: "soaks", price: 18.0, variantDelta: 0, qty: 1 }
];
eq(
  cart.unitPrice(cartMulti[0], cartMulti),
  14.99,
  "Multi-rule: Salves qualify for $14.99 unit price"
);
eq(
  cart.unitPrice(cartMulti[1], cartMulti),
  16.0,
  "Multi-rule: Lavender Soak qualifies for $16.00 unit price"
);
eq(
  cart.unitPrice(cartMulti[2], cartMulti),
  16.0,
  "Multi-rule: Ritual Soak qualifies for $16.00 unit price"
);
eq(
  cart.subtotal(cartMulti),
  61.98,
  "Multi-rule subtotal: 2x $14.99 ($29.98) + 2x $16.00 ($32.00) = $61.98"
);

// 11. Multi-Rule with Disabled Rule
global.window.YL_PRODUCTS.shop.volumePricing[1].enabled = false;
eq(
  cart.unitPrice(cartMulti[1], cartMulti),
  18.0,
  "Disabled soak rule: Lavender Soak reverts to base price $18.00"
);
eq(
  cart.unitPrice(cartMulti[0], cartMulti),
  14.99,
  "Active salve rule: Frankincense Salve remains discounted at $14.99"
);

global.window.YL_PRODUCTS = null;

/* freeShipThreshold reads products.json shop.freeShippingThreshold, the same
   CMS field the announcement bar and workers/checkout.js read. A 0 there means
   "Set to 0 to disable" (admin/config.yml) and must not silently become the
   default, or the drawer promises a tier Stripe no longer honours. */
eq(cart.freeShipThreshold(), 40, "freeShipThreshold defaults with no catalog loaded");
global.window.YL_PRODUCTS = { shop: { freeShippingThreshold: 75 } };
eq(cart.freeShipThreshold(), 75, "freeShipThreshold honours a CMS-configured threshold");
global.window.YL_PRODUCTS = { shop: { freeShippingThreshold: 0 } };
eq(cart.freeShipThreshold(), 0, "freeShipThreshold treats 0 as disabled, not as the default");
global.window.YL_PRODUCTS = { shop: {} };
eq(cart.freeShipThreshold(), 40, "freeShipThreshold falls back when the field is missing");
global.window.YL_PRODUCTS = { shop: { freeShippingThreshold: "forty" } };
eq(cart.freeShipThreshold(), 40, "freeShipThreshold falls back on a non-numeric value");
global.window.YL_PRODUCTS = null;
eq(cart.freeShipThreshold(), 40, "freeShipThreshold is safe with no catalog at all");

console.log(`\ncart-engine.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
