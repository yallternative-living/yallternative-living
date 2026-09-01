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

// 12. Top-Level Volume Pricing (cat.volumePricing)
global.window.YL_PRODUCTS = {
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
    }
  ],
  products: [
    { id: "frankincense-salve", category: "salves", price: 19.99 },
    { id: "sleep-salve", category: "salves", price: 19.99 }
  ]
};
const cartTopLevelVol = [
  { id: "frankincense-salve", price: 19.99, variantDelta: 0, variantLabel: "2oz", qty: 1 },
  {
    id: "sleep-salve",
    category: "salves",
    price: 19.99,
    variantDelta: 0,
    variantLabel: "2oz",
    qty: 1
  }
];
eq(
  cart.unitPrice(cartTopLevelVol[0], cartTopLevelVol),
  14.99,
  "Top-level volumePricing: Frankincense Salve qualifies for $14.99 unit price"
);
eq(
  cart.unitPrice(cartTopLevelVol[1], cartTopLevelVol),
  14.99,
  "Top-level volumePricing: Sleep Salve qualifies for $14.99 unit price"
);
eq(cart.subtotal(cartTopLevelVol), 29.98, "Top-level volumePricing: 2x $14.99 = $29.98 subtotal");

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

// Milestone 1 Tests: Gifting, Share Cart URL, and Loyalty Wallet Math

// 1. toCheckoutPayload Gifting & Payload Serialization
const giftPayload1 = cart.toCheckoutPayload(
  [{ id: "lavender-soak", qty: 1 }],
  "Landrum SC Farmers Market",
  "YALL-PTS-ABC123",
  true,
  "Happy Birthday, hope you love this soak!"
);
eq(giftPayload1.isGiftOrder, true, "toCheckoutPayload sets isGiftOrder boolean");
eq(giftPayload1.is_gift_order, true, "toCheckoutPayload sets is_gift_order snake_case");
eq(
  giftPayload1.giftMessage,
  "Happy Birthday, hope you love this soak!",
  "toCheckoutPayload includes giftMessage"
);
eq(
  giftPayload1.gift_message,
  "Happy Birthday, hope you love this soak!",
  "toCheckoutPayload includes gift_message snake_case"
);
eq(
  giftPayload1.pickupMarket,
  "Landrum SC Farmers Market",
  "toCheckoutPayload includes pickupMarket"
);
eq(
  giftPayload1.pickup_market,
  "Landrum SC Farmers Market",
  "toCheckoutPayload includes pickup_market snake_case"
);
eq(giftPayload1.giftCardCode, "YALL-PTS-ABC123", "toCheckoutPayload includes giftCardCode");
eq(
  giftPayload1.gift_card_code,
  "YALL-PTS-ABC123",
  "toCheckoutPayload includes gift_card_code snake_case"
);

// Gifting message max length clamping (500 chars)
const longMsg = "A".repeat(600);
const giftPayload2 = cart.toCheckoutPayload(
  [{ id: "lavender-soak", qty: 1 }],
  null,
  null,
  true,
  longMsg
);
eq(giftPayload2.giftMessage.length, 500, "toCheckoutPayload clamps giftMessage to 500 characters");
eq(
  giftPayload2.gift_message.length,
  500,
  "toCheckoutPayload clamps gift_message to 500 characters"
);

// Gifting without isGiftOrder (falsy)
const giftPayload3 = cart.toCheckoutPayload(
  [{ id: "lavender-soak", qty: 1 }],
  null,
  null,
  false,
  "Should not be included"
);
eq(giftPayload3.isGiftOrder, undefined, "toCheckoutPayload omits isGiftOrder when false");
eq(giftPayload3.giftMessage, undefined, "toCheckoutPayload omits giftMessage when not a gift");

// 2. generateShareCartUrl
const shareItems = [
  { id: "frankincense-salve", qty: 2, variantLabel: "2oz" },
  { id: "lavender-soak", qty: 1 }
];
const shareUrl = cart.generateShareCartUrl(shareItems);
eq(
  shareUrl,
  "/shop.html?cart=frankincense-salve%3A2%3A2oz%2Clavender-soak%3A1",
  "generateShareCartUrl generates valid shop.html?cart= URL with encoded items"
);
eq(cart.generateShareCartUrl([]), "", "generateShareCartUrl returns empty string for empty cart");
eq(cart.generateShareCartUrl(null), "", "generateShareCartUrl returns empty string for null");

// 3. parseSharedCartParam
const mockCatalog = {
  products: [
    {
      id: "frankincense-salve",
      name: "Frankincense Salve",
      price: 19.99,
      category: "salves",
      stock: 5,
      variants: {
        name: "Size",
        options: [
          { name: "2oz", priceDelta: 0 },
          { name: "1oz", priceDelta: -6.0 }
        ]
      }
    },
    {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 18.0,
      category: "soaks",
      stock: 10
    }
  ],
  bundles: [
    {
      id: "duo-bundle",
      name: "Apothecary Duo",
      price: 32.0
    }
  ]
};

const parsed = cart.parseSharedCartParam(
  "frankincense-salve:2:1oz,lavender-soak:1,duo-bundle:1,non-existent-product:5",
  mockCatalog
);
eq(parsed.length, 3, "parseSharedCartParam drops invalid products");
eq(parsed[0].id, "frankincense-salve", "parseSharedCartParam sets product id");
eq(parsed[0].qty, 2, "parseSharedCartParam sets quantity");
eq(parsed[0].variantLabel, "1oz", "parseSharedCartParam sets variantLabel");
eq(parsed[0].variantDelta, -6.0, "parseSharedCartParam resolves variantDelta");
eq(parsed[1].id, "lavender-soak", "parseSharedCartParam resolves second product");
eq(parsed[2].id, "duo-bundle", "parseSharedCartParam resolves bundle");

// Stock ceiling clamping on shared cart hydration
const overstocked = cart.parseSharedCartParam("frankincense-salve:20:2oz", mockCatalog);
eq(overstocked[0].qty, 5, "parseSharedCartParam clamps quantity to stock level");

// Malformed string handling
eq(cart.parseSharedCartParam("", mockCatalog), [], "parseSharedCartParam handles empty string");
eq(cart.parseSharedCartParam(null, mockCatalog), [], "parseSharedCartParam handles null");
eq(
  cart.parseSharedCartParam(":::", mockCatalog),
  [],
  "parseSharedCartParam handles malformed token"
);

// 4. Alt-Points Loyalty Wallet storage helpers
const mockStorageMap = new Map();
global.localStorage = {
  getItem: (k) => mockStorageMap.get(k) || null,
  setItem: (k, v) => mockStorageMap.set(k, String(v)),
  removeItem: (k) => mockStorageMap.delete(k),
  clear: () => mockStorageMap.clear()
};

mockStorageMap.clear();
eq(cart.getWalletPoints(), 0, "getWalletPoints defaults to 0 when storage is empty");
cart.setWalletPoints(150);
eq(cart.getWalletPoints(), 150, "getWalletPoints returns updated balance after setWalletPoints");
cart.setWalletPoints(-50);
eq(cart.getWalletPoints(), 0, "setWalletPoints clamps negative points to 0");
cart.setWalletPoints("invalid");
eq(cart.getWalletPoints(), 0, "setWalletPoints handles non-numeric value gracefully");

// 5. Multi-Tier Free Shipping & Reward Milestones (R3)
const customMilestones = [
  { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" },
  { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" }
];

// Fallback behavior when YL_PRODUCTS is unset or empty
const savedWindowYlProducts = global.window.YL_PRODUCTS;
delete global.window.YL_PRODUCTS;
eq(
  cart.getShippingMilestones(),
  [{ threshold: 40, reward: "Free Tracked Shipping", icon: "truck" }],
  "getShippingMilestones falls back to default $40 threshold when YL_PRODUCTS is absent"
);

// Reads shop.shippingMilestones and sorts ascending
global.window.YL_PRODUCTS = {
  shop: {
    shippingMilestones: [
      { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" },
      { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" }
    ]
  }
};
eq(
  cart.getShippingMilestones(),
  customMilestones,
  "getShippingMilestones parses and sorts milestones in ascending order"
);

// Malformed milestones fall back gracefully
global.window.YL_PRODUCTS = {
  shop: {
    shippingMilestones: [{ threshold: "invalid" }, null]
  }
};
eq(
  cart.getShippingMilestones(),
  [{ threshold: 40, reward: "Free Tracked Shipping", icon: "truck" }],
  "getShippingMilestones ignores non-numeric thresholds and falls back cleanly"
);

// Milestone calculations & copy across edge cases
// Subtotal $0 -> "Add $40.00 for Free Tracked Shipping!"
let s0 = cart.calculateMilestoneStatus(0, customMilestones, false);
eq(s0.message, "Add $40.00 for Free Tracked Shipping!", "Milestone at $0 subtotal");
eq(s0.progressPercent, 0, "Progress percent at $0 subtotal");
eq(s0.remaining, 40, "Remaining distance at $0 subtotal");
eq(s0.isAllUnlocked, false, "Not unlocked at $0 subtotal");
eq(s0.nextMilestone.threshold, 40, "Next milestone at $0 subtotal is $40");

// Subtotal $25 -> "Add $15.00 for Free Tracked Shipping!"
let s25 = cart.calculateMilestoneStatus(25, customMilestones, false);
eq(s25.message, "Add $15.00 for Free Tracked Shipping!", "Milestone at $25 subtotal");
eq(s25.progressPercent, 42, "Progress percent at $25 subtotal (25/60 = 42%)");
eq(s25.remaining, 15, "Remaining distance at $25 subtotal ($40 - $25 = $15)");
eq(s25.nextMilestone.threshold, 40, "Next milestone at $25 is $40");

// Subtotal $40 -> "Add $20.00 more to unlock a Free Handcrafted Pocket Salve!"
let s40 = cart.calculateMilestoneStatus(40, customMilestones, false);
eq(
  s40.message,
  "Add $20.00 more to unlock a Free Handcrafted Pocket Salve!",
  "Milestone at $40 subtotal unlocks tier 1, targets tier 2"
);
eq(s40.progressPercent, 67, "Progress percent at $40 subtotal (40/60 = 67%)");
eq(s40.remaining, 20, "Remaining distance at $40 subtotal ($60 - $40 = $20)");
eq(s40.nextMilestone.threshold, 60, "Next milestone at $40 is $60");

// Subtotal $51.99 -> "Add $8.01 more to unlock a Free Handcrafted Pocket Salve!" (Float precision safety)
let s5199 = cart.calculateMilestoneStatus(51.99, customMilestones, false);
eq(
  s5199.message,
  "Add $8.01 more to unlock a Free Handcrafted Pocket Salve!",
  "Milestone at $51.99 calculates $8.01 without floating-point drift"
);
eq(s5199.progressPercent, 87, "Progress percent at $51.99 (51.99/60 = 87%)");
eq(s5199.remaining, 8.01, "Remaining float distance at $51.99 is 8.01");
eq(s5199.nextMilestone.threshold, 60, "Next milestone at $51.99 is $60");

// Subtotal $60 -> "🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!"
let s60 = cart.calculateMilestoneStatus(60, customMilestones, false);
eq(
  s60.message,
  "🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!",
  "Milestone at $60 unlocks all perks"
);
eq(s60.progressPercent, 100, "Progress percent at $60 is 100%");
eq(s60.isAllUnlocked, true, "isAllUnlocked is true at $60");
eq(s60.nextMilestone, null, "nextMilestone is null when all unlocked");

// Subtotal $75 -> "🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!"
let s75 = cart.calculateMilestoneStatus(75, customMilestones, false);
eq(
  s75.message,
  "🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!",
  "Milestone at $75 stays capped at 100%"
);
eq(s75.progressPercent, 100, "Progress percent at $75 is capped at 100%");
eq(s75.isAllUnlocked, true, "isAllUnlocked is true at $75");

// Local pickup override
let sPickup = cart.calculateMilestoneStatus(25, customMilestones, true);
eq(
  sPickup.message,
  "Local SC Market Pick-up Selected ($0 Shipping)",
  "Local pickup override message"
);
eq(sPickup.progressPercent, 100, "Progress percent is 100% on pickup");

// Disabled threshold (0)
let sDisabled = cart.calculateMilestoneStatus(25, [{ threshold: 0, reward: "Disabled" }], false);
eq(sDisabled.message, "", "Disabled milestones (0 threshold) produce empty message");

// Restore window.YL_PRODUCTS
if (savedWindowYlProducts === undefined) delete global.window.YL_PRODUCTS;
else global.window.YL_PRODUCTS = savedWindowYlProducts;

/* ==========================================================
   C-3: the service worker must never intercept dynamic endpoints
   ----------------------------------------------------------
   sw.js ran every same-origin GET through its cache layer, which included
   /.netlify/functions/* (gift-card balance, order status) and /api/* (the
   Cloudflare Worker checkout proxy). Those responses are per-request and
   sometimes single-use, so caching one hands the next shopper a stale
   balance or a dead checkout session. The fetch handler now returns for
   those two prefixes BEFORE any caches.* call and before respondWith().

   This loads the real sw.js in a vm with a fake `self` and records whether
   respondWith() was called for each path. It fails against the old handler
   (which responded for every same-origin GET).
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const listeners = {};
  const swCaches = {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    match: async () => undefined,
    keys: async () => [],
    delete: async () => true
  };
  const sandbox = {
    self: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      location: { origin: "https://example.test" },
      registration: {},
      clients: { claim: async () => {} },
      skipWaiting: async () => {}
    },
    caches: swCaches,
    fetch: async () => ({ status: 200, clone: () => ({}) }),
    Request: class {
      constructor(u) {
        this.url = String(u);
      }
    },
    Response: { error: () => ({}) },
    URL,
    console: { warn: () => {}, log: () => {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8"), sandbox, {
    filename: "sw.js"
  });

  function respondedTo(url) {
    let called = false;
    listeners.fetch({
      request: {
        url,
        method: "GET",
        mode: "no-cors",
        headers: { get: () => null }
      },
      respondWith: () => {
        called = true;
      },
      preloadResponse: Promise.resolve(null)
    });
    return called;
  }

  eq(typeof listeners.fetch, "function", "sw.js registers a fetch listener");
  eq(
    respondedTo("https://example.test/.netlify/functions/gift-card-balance"),
    false,
    "sw.js does not intercept /.netlify/ function requests"
  );
  eq(
    respondedTo("https://example.test/.netlify/functions/order-status?id=cs_test_1"),
    false,
    "sw.js does not intercept /.netlify/ requests carrying a query string"
  );
  eq(
    respondedTo("https://example.test/api/checkout"),
    false,
    "sw.js does not intercept the /api/ checkout proxy"
  );
  eq(
    respondedTo("https://example.test/assets/js/cart.js"),
    true,
    "sw.js still caches ordinary same-origin static assets"
  );
}

/* ==========================================================
   H-7: thank-you.js only trusts a real Stripe redirect
   ----------------------------------------------------------
   The page used to fire the Purchase analytics event and clear the cart for
   ANY ?session_id= value, print a "$25.00" placeholder whenever the amount
   was missing, and render a printable gift certificate straight out of
   query-string parameters the Worker never emits.

   These run the real assets/js/thank-you.js against a fake window/document
   and assert the new gates. Every assertion below except the happy path
   fails against the previous version.
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  const thankYouPath = path.join(__dirname, "..", "assets", "js", "thank-you.js");

  function runThankYou(search, seenSession) {
    const els = {};
    const lookups = [];
    const purchases = [];
    const store = new Map();
    if (seenSession) store.set("yl-thankyou-session", seenSession);
    let cleared = 0;

    function element(id) {
      if (!els[id]) {
        els[id] = { id, textContent: "", hidden: true, addEventListener: () => {} };
      }
      return els[id];
    }

    const prevWindow = global.window;
    const prevDocument = global.document;
    global.window = {
      location: { search },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
      },
      plausible: (name, payload) => purchases.push({ name, payload }),
      YLCart: {
        clear: () => {
          cleared += 1;
        }
      }
    };
    global.document = {
      getElementById: (id) => {
        lookups.push(id);
        return element(id);
      }
    };
    try {
      delete require.cache[require.resolve(thankYouPath)];
      require(thankYouPath);
    } finally {
      global.window = prevWindow;
      global.document = prevDocument;
    }
    return { els, lookups, purchases, cleared };
  }

  // Happy path: a genuine Worker redirect still books revenue and clears.
  const good = runThankYou("?session_id=cs_test_a1B2c3&amount=42.00&currency=usd");
  eq(good.purchases.length, 1, "thank-you: real cs_test_ session fires one Purchase event");
  eq(good.purchases[0].name, "Purchase", "thank-you: analytics event is named Purchase");
  eq(
    good.purchases[0].payload.props.revenue,
    { currency: "USD", amount: 42 },
    "thank-you: Purchase carries the redirect's amount and currency"
  );
  eq(good.cleared, 1, "thank-you: real session clears the cart once");
  eq(
    good.els.thankYouAmountGroup.hidden,
    false,
    "thank-you: order total shown when amount present"
  );
  eq(
    good.els.thankYouAmountDisplay.textContent,
    "$42.00",
    "thank-you: order total renders the redirect amount"
  );
  eq(good.els.thankYouSessionRow.hidden, false, "thank-you: reference id shown for a real session");

  // A hand-crafted session_id is not a completed order.
  const forged = runThankYou("?session_id=not-a-session&amount=42.00");
  eq(forged.purchases.length, 0, "thank-you: non cs_ session_id fires no Purchase event");
  eq(forged.cleared, 0, "thank-you: non cs_ session_id does not clear the cart");
  eq(
    forged.els.thankYouSessionRow.hidden,
    true,
    "thank-you: non cs_ session_id shows no reference id"
  );

  // Same order re-opened (refresh / Back): still once per order.
  const repeat = runThankYou("?session_id=cs_live_ZZ9&amount=12.00", "cs_live_ZZ9");
  eq(repeat.purchases.length, 0, "thank-you: a repeat visit re-fires no Purchase event");
  eq(repeat.cleared, 0, "thank-you: a repeat visit does not re-clear the cart");

  // No amount at all: nothing is invented, and no revenue is booked.
  const noAmount = runThankYou("?session_id=cs_test_noamount");
  eq(noAmount.purchases.length, 0, "thank-you: a missing amount books no revenue");
  eq(
    noAmount.els.thankYouAmountGroup.hidden,
    true,
    "thank-you: the order-total block stays hidden when no amount is present"
  );
  eq(
    noAmount.els.thankYouAmountDisplay.textContent,
    "",
    "thank-you: no $25.00 placeholder is printed when the amount is absent"
  );

  // Implausible amounts are treated as no amount.
  const huge = runThankYou("?session_id=cs_test_huge&amount=99999.99");
  eq(huge.purchases.length, 0, "thank-you: an amount over $10,000 books no revenue");
  eq(huge.cleared, 0, "thank-you: an amount over $10,000 does not clear the cart");
  const negative = runThankYou("?session_id=cs_test_neg&amount=-5");
  eq(negative.purchases.length, 0, "thank-you: a negative amount books no revenue");

  // The URL-parameter gift certificate is gone, not merely hidden.
  const gift = runThankYou(
    "?session_id=cs_test_g1&amount=5.00&gift_code=YALL-FORGED&recipient=victim@example.com"
  );
  eq(
    gift.lookups.filter((id) => id.indexOf("giftCert") === 0),
    [],
    "thank-you: no gift-certificate element is addressed from query parameters"
  );
  const thankYouSrc = fs.readFileSync(thankYouPath, "utf8");
  eq(/gift_code|giftCertCode/.test(thankYouSrc), false, "thank-you.js has no gift-code parser");
  eq(/\$25\.00/.test(thankYouSrc), false, "thank-you.js has no hardcoded $25.00 fallback");
  const thankYouHtml = fs.readFileSync(path.join(__dirname, "..", "thank-you.html"), "utf8");
  eq(
    /giftCertificateSection|gift-certificate-section/.test(thankYouHtml),
    false,
    "thank-you.html no longer carries the gift-certificate markup"
  );
  eq(
    /id="thankYouAmountDisplay">\$/.test(thankYouHtml),
    false,
    "thank-you.html ships no hardcoded order total"
  );
}

/* ==========================================================
   Gift-card codes travel in a POST body, never in a URL
   ----------------------------------------------------------
   A GET put the code in the query string, where it lands in browser
   history, the Referer header and every proxy log between here and the
   function. Both callers (this helper and assets/js/gift-card.js) now POST
   {code} to the same endpoint, which answers Cache-Control: no-store.
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, balance: 10, code: "YALL-ABC123" })
    });
  };

  cart.checkGiftCardBalance("  yall-abc123  ");
  eq(calls.length, 1, "checkGiftCardBalance issues one request");
  eq(
    calls[0].url,
    "/.netlify/functions/gift-card-balance",
    "checkGiftCardBalance puts no code in the URL"
  );
  eq(calls[0].opts.method, "POST", "checkGiftCardBalance POSTs");
  eq(
    JSON.parse(calls[0].opts.body),
    { code: "YALL-ABC123" },
    "checkGiftCardBalance sends the normalised code in the body"
  );

  // Alt-Points redemption never reaches the network any more.
  calls.length = 0;
  let redeemRejection = null;
  cart.redeemPoints(100).catch((err) => {
    redeemRejection = err;
  });
  eq(calls.length, 0, "redeemPoints makes no network call");

  global.fetch = originalFetch;

  const giftCardSrc = fs.readFileSync(
    path.join(__dirname, "..", "assets", "js", "gift-card.js"),
    "utf8"
  );
  eq(
    /gift-card-balance\?code=/.test(giftCardSrc),
    false,
    "gift-card.js no longer builds a ?code= balance URL"
  );
  eq(
    /gift-card-balance"[\s\S]{0,120}method:\s*"POST"/.test(giftCardSrc),
    true,
    "gift-card.js POSTs the balance lookup"
  );
  eq(
    /localStorage\.setItem\(\s*"yl_applied_gift_card"/.test(giftCardSrc),
    false,
    "gift-card.js no longer writes the cart's gift-card key itself"
  );
  eq(
    /YLCart\.applyGiftCard\(/.test(giftCardSrc),
    true,
    "gift-card.js hands the card to YLCart.applyGiftCard"
  );
  eq(/catch\s*\(e\)\s*\{\}/.test(giftCardSrc), false, "gift-card.js has no empty catch block");
  eq(
    /escapeHtml\(\s*\n?\s*data\.formattedBalance/.test(giftCardSrc),
    true,
    "gift-card.js escapes the server-supplied formatted balance"
  );
  // Keep the rejection referenced so the promise is not unhandled.
  eq(redeemRejection === null || redeemRejection instanceof Error, true, "redeemPoints rejects");
}

/* ==========================================================
   The "all perks unlocked" copy names the configured reward
   ----------------------------------------------------------
   The top-tier reward name was hardcoded, so renaming the milestone in the
   CMS (and therefore in the $0 line item the Worker adds at that tier)
   changed every string in the drawer except the celebration, which went on
   promising a Pocket Salve the order no longer included.
   ========================================================== */
{
  const renamed = [
    { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" },
    { threshold: 60, reward: "Handcrafted Lavender Sachet", icon: "gift" }
  ];
  const unlocked = cart.calculateMilestoneStatus(75, renamed, false);
  eq(
    unlocked.message,
    "🎉 All perks unlocked! Free Shipping + Free Handcrafted Lavender Sachet!",
    "the celebration names the configured top-tier reward"
  );
  const threeTier = cart.calculateMilestoneStatus(
    999,
    [
      { threshold: 40, reward: "Free Tracked Shipping" },
      { threshold: 60, reward: "Free Pocket Salve" },
      { threshold: 120, reward: "Tote Bag" }
    ],
    false
  );
  eq(
    threeTier.message,
    "🎉 All perks unlocked! Free Shipping + Free Pocket Salve + Free Tote Bag!",
    "every bonus tier is named, in configured order"
  );
}

console.log(`\ncart-engine.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
