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
/* Assertions that have to await a promise push it here; the summary at the
   foot of the file waits on all of them before counting. */
const asyncChecks = [];
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

/* startQtyFromAttr: parses & clamps a product page's data-item-quantity
   attribute (addItemFromButton's starting qty for a brand new line). A
   tampered or malformed value must never bypass the cart's MAX_QTY (99)
   ceiling here -- addToList()/clampQty() clamp again, against the
   product's own maxQty, when the line is actually merged. */
eq(cart.startQtyFromAttr("5"), 5, "startQtyFromAttr honours a valid data-item-quantity");
eq(cart.startQtyFromAttr("1"), 1, "startQtyFromAttr treats 1 as the default (not >1)");
eq(cart.startQtyFromAttr("0"), 1, "startQtyFromAttr defaults to 1 for 0");
eq(
  cart.startQtyFromAttr(undefined),
  1,
  "startQtyFromAttr defaults to 1 when the attribute is absent"
);
eq(cart.startQtyFromAttr(""), 1, "startQtyFromAttr defaults to 1 for an empty attribute");
eq(cart.startQtyFromAttr("abc"), 1, "startQtyFromAttr defaults to 1 for a non-numeric value");
eq(cart.startQtyFromAttr("-5"), 1, "startQtyFromAttr defaults to 1 for a negative value");
eq(
  cart.startQtyFromAttr("500"),
  99,
  "startQtyFromAttr clamps a tampered/huge quantity to the cart's MAX_QTY (99)"
);
eq(cart.startQtyFromAttr("99"), 99, "startQtyFromAttr allows exactly the MAX_QTY ceiling");

// End-to-end: the exact two-step pipeline addItemFromButton runs -- a
// data-item-quantity attribute parsed by startQtyFromAttr, then merged into
// the cart by addToList -- ends up honoured when reasonable and clamped
// twice over (once against MAX_QTY, once against the product's own stock)
// when it isn't.
let qtyPipeline = [];
qtyPipeline = cart.addToList(qtyPipeline, {
  id: "bath-tea",
  qty: cart.startQtyFromAttr("4"),
  maxQty: null
});
eq(qtyPipeline[0].qty, 4, "A reasonable data-item-quantity is honoured end to end");

let qtyPipelineCapped = [];
qtyPipelineCapped = cart.addToList(qtyPipelineCapped, {
  id: "bath-tea",
  qty: cart.startQtyFromAttr("500"),
  maxQty: 6 // e.g. data-item-max-quantity from a real stock count
});
eq(
  qtyPipelineCapped[0].qty,
  6,
  "A tampered data-item-quantity is clamped to the product's own stock cap on merge"
);

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

/* toCheckoutPayload = only {id, qty, variant} per line (never a client price),
   plus a top-level `locale`. The locale is the language the shopper is reading
   the shop in; the Worker validates it against the same six-code allow-list and
   forwards it as Stripe Checkout's `locale`, so a shopper browsing in Japanese
   is not handed an English payment page. It is asserted here as part of the
   payload SHAPE precisely so that adding another field to a checkout request
   stays a deliberate act -- everything in this object crosses the network. */
eq(
  cart.toCheckoutPayload([
    { id: "tank", variantLabel: "M", price: 25, variantDelta: 0, qty: 2 },
    { id: "salve", variantLabel: "", price: 16, qty: 1 }
  ]),
  {
    items: [
      { id: "tank", qty: 2, variant: "M" },
      { id: "salve", qty: 1 }
    ],
    locale: "en"
  },
  "toCheckoutPayload shape (no prices leaked, language carried)"
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
    ],
    locale: "en"
  },
  "toCheckoutPayload: gift metadata attached only to gift-card line"
);

// 2oz Salve Mix-and-Match Volume Pricing Test Suite
// 1. Single 2oz Frankincense (No volume discount)
const cart1 = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart1), 20, "1x 2oz Frankincense = $20.00");
eq(cart.unitPrice(cart1[0], cart1), 20, "1x 2oz Frankincense unit price = $20.00");

// 2. Single 2oz Sleep Salve (No volume discount)
const cart2 = [{ id: "sleep-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }];
eq(cart.subtotal(cart2), 20, "1x 2oz Sleep Salve = $20.00");

// 3. Two 2oz Frankincense Salves (Volume discount applies)
const cart3 = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 2 }
];
eq(cart.subtotal(cart3), 30, "2x 2oz Frankincense = $30.00 ($15.00 each)");
eq(cart.unitPrice(cart3[0], cart3), 15, "2x 2oz Frankincense unit price drops to $15.00");

// 4. Mix-and-match: 1x 2oz Frankincense + 1x 2oz Sleep Salve (Volume discount applies)
const cart4 = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 },
  { id: "sleep-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart4), 30, "1x 2oz Frankincense + 1x 2oz Sleep Salve = $30.00 ($15.00 each)");
eq(cart.unitPrice(cart4[0], cart4), 15, "Mix-and-match Frankincense unit price = $15.00");
eq(cart.unitPrice(cart4[1], cart4), 15, "Mix-and-match Sleep Salve unit price = $15.00");

// 5. 3x Qualifying 2oz Salves (Volume discount applies across all units)
const cart5 = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "sleep-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(cart.subtotal(cart5), 45, "3x 2oz qualifying salves = $45.00 ($15.00 each)");

// 6. 1oz Frankincense Variant Exclusion
const cart6 = [
  { id: "frankincense-salve", price: 20, variantDelta: -6.0, variantLabel: "1oz", qty: 1 },
  { id: "sleep-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart6),
  34,
  "1x 1oz Frankincense ($14.00) + 1x 2oz Sleep Salve ($20.00) = $34.00 (no discount)"
);

// 7. Beard Salve Exclusion
const cart7 = [
  { id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 1 },
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart7),
  34,
  "1x Beard Salve ($14.00) + 1x 2oz Frankincense ($20.00) = $34.00 (no discount)"
);

// 8. Miracle Balm (.5oz) Exclusion
const cart8 = [
  { id: "miracle-balm", price: 8.0, variantDelta: 0, qty: 1 },
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 }
];
eq(
  cart.subtotal(cart8),
  28,
  "1x Miracle Balm ($8.00) + 1x 2oz Frankincense ($20.00) = $28.00 (no discount)"
);

// 9. Mixed Basket (Qualifying + Excluded Items)
const cart9 = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "frankincense-salve", price: 20, variantDelta: -6.0, variantLabel: "1oz", qty: 1 },
  { id: "beard-salve", category: "body", price: 14.0, variantDelta: 0, qty: 1 },
  { id: "miracle-balm", price: 8.0, variantDelta: 0, qty: 1 }
];
eq(
  cart.subtotal(cart9),
  66,
  "2x 2oz ($30.00) + 1x 1oz ($14.00) + 1x Beard ($14) + 1x Miracle ($8) = $66.00"
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
        unitPrice: 15,
        label: "2+ for $15 each",
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
    { id: "frankincense-salve", category: "salves", price: 20 },
    { id: "sleep-salve", category: "salves", price: 20 },
    { id: "lavender-soak", category: "soaks", price: 18.0 },
    { id: "ritual-soak", category: "soaks", price: 18.0 }
  ]
};

const cartMulti = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 2 },
  { id: "lavender-soak", category: "soaks", price: 18.0, variantDelta: 0, qty: 1 },
  { id: "ritual-soak", category: "soaks", price: 18.0, variantDelta: 0, qty: 1 }
];
eq(cart.unitPrice(cartMulti[0], cartMulti), 15, "Multi-rule: Salves qualify for $15.00 unit price");
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
  62,
  "Multi-rule subtotal: 2x $15.00 ($30.00) + 2x $16.00 ($32.00) = $62.00"
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
  15,
  "Active salve rule: Frankincense Salve remains discounted at $15.00"
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
      unitPrice: 15,
      label: "2+ for $15 each",
      enabled: true
    }
  ],
  products: [
    { id: "frankincense-salve", category: "salves", price: 20 },
    { id: "sleep-salve", category: "salves", price: 20 }
  ]
};
const cartTopLevelVol = [
  { id: "frankincense-salve", price: 20, variantDelta: 0, variantLabel: "2oz", qty: 1 },
  {
    id: "sleep-salve",
    category: "salves",
    price: 20,
    variantDelta: 0,
    variantLabel: "2oz",
    qty: 1
  }
];
eq(
  cart.unitPrice(cartTopLevelVol[0], cartTopLevelVol),
  15,
  "Top-level volumePricing: Frankincense Salve qualifies for $15.00 unit price"
);
eq(
  cart.unitPrice(cartTopLevelVol[1], cartTopLevelVol),
  15,
  "Top-level volumePricing: Sleep Salve qualifies for $15.00 unit price"
);
eq(cart.subtotal(cartTopLevelVol), 30, "Top-level volumePricing: 2x $15.00 = $30.00 subtotal");

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
      price: 20,
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
eq(s0.message, "Add $40 for Free Tracked Shipping!", "Milestone at $0 subtotal");
eq(s0.progressPercent, 0, "Progress percent at $0 subtotal");
eq(s0.remaining, 40, "Remaining distance at $0 subtotal");
eq(s0.isAllUnlocked, false, "Not unlocked at $0 subtotal");
eq(s0.nextMilestone.threshold, 40, "Next milestone at $0 subtotal is $40");

// Subtotal $25 -> "Add $15.00 for Free Tracked Shipping!"
let s25 = cart.calculateMilestoneStatus(25, customMilestones, false);
eq(s25.message, "Add $15 for Free Tracked Shipping!", "Milestone at $25 subtotal");
eq(s25.progressPercent, 42, "Progress percent at $25 subtotal (25/60 = 42%)");
eq(s25.remaining, 15, "Remaining distance at $25 subtotal ($40 - $25 = $15)");
eq(s25.nextMilestone.threshold, 40, "Next milestone at $25 is $40");

// Subtotal $40 -> "Add $20.00 more to unlock a Free Handcrafted Pocket Salve!"
let s40 = cart.calculateMilestoneStatus(40, customMilestones, false);
eq(
  s40.message,
  "Add $20 more to unlock a Free Handcrafted Pocket Salve!",
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
   Cloudflare Worker routes -- checkout, and now the gift-card balance).
   Those responses are per-request and sometimes single-use, so caching one
   hands the next shopper a stale balance or a dead checkout session. The
   fetch handler now returns for those two prefixes BEFORE any caches.* call
   and before respondWith().

   The Netlify prefix is still asserted even though nothing on the site calls
   it any more: those paths answer 410, and a cached 410 would outlive the
   deploy that fixed whatever old page was still asking for them.

   This loads the real sw.js in a vm with a fake `self` and records whether
   respondWith() was called for each path. It fails against the old handler
   (which responded for every same-origin GET).
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const { ANALYTICS_SCRIPT_PATH, ANALYTICS_SEND_PATH } = require("./lib/analytics-proxy.js");

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
  /* The analytics proxy is same-origin but is not this site's code: those two
     paths are rewritten straight through to Umami Cloud. The script ends in
     .js, so without an explicit skip the network-first branch would fetch it
     with cache:"reload" on every page load -- bypassing the browser's HTTP
     cache on a file Umami serves with max-age=86400 -- and would write a
     third-party script into this site's own cache, where the offline branch
     would go on serving it after a deploy. */
  eq(
    respondedTo("https://example.test" + ANALYTICS_SCRIPT_PATH),
    false,
    "sw.js does not intercept the proxied analytics script"
  );
  eq(
    respondedTo("https://example.test" + ANALYTICS_SEND_PATH),
    false,
    "sw.js does not intercept the proxied analytics send path"
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

  /* Synchronous thenables so the page's fetch().then().then().catch() chain
     settles inside require() and the assertions below stay synchronous. */
  function syncResolved(value) {
    return {
      then(fn) {
        try {
          const r = fn(value);
          return r && typeof r.then === "function" ? r : syncResolved(r);
        } catch (e) {
          return syncRejected(e);
        }
      },
      catch() {
        return this;
      }
    };
  }
  function syncRejected(err) {
    return {
      then() {
        return this;
      },
      catch(fn) {
        return syncResolved(fn(err));
      }
    };
  }
  const PAID_SUMMARY = {
    found: true,
    paymentStatus: "paid",
    status: "complete",
    amountTotalCents: 4200,
    amountDiscountCents: 0,
    giftCardAppliedCents: 0
  };

  /* opts.summary: what /api/order-summary answers (PAID_SUMMARY, a not-found
     body, or null for a network failure). The page now trusts nothing but
     that answer: no Purchase, no cart clear and no "paid" wording until the
     Worker has confirmed a paid, complete session. */
  function runThankYou(search, seenSession, opts) {
    opts = opts || {};
    const summary = "summary" in opts ? opts.summary : PAID_SUMMARY;
    const els = {};
    const lookups = [];
    const purchases = [];
    const store = new Map();
    if (seenSession) store.set("yl-thankyou-session", seenSession);
    let cleared = 0;

    function element(id) {
      if (!els[id]) {
        els[id] = {
          id,
          textContent: "",
          hidden: true,
          addEventListener: () => {},
          setAttribute: () => {},
          removeAttribute: () => {},
          /* The card holds two spans: the pulse dot and the label. Honour the
             selector so a test can tell them apart -- the plain "span"
             selector lands on the dot, exactly as the real DOM does. */
          querySelector: (sel) =>
            id !== "thankYouCard"
              ? null
              : /:not\(\.status-pulse\)/.test(sel)
                ? element("badgeText")
                : element("badgePulse"),
          classList: { add: () => {}, remove: () => {}, contains: () => false }
        };
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
    const prevFetch = global.fetch;
    global.fetch = () =>
      summary === null
        ? syncRejected(new Error("network"))
        : syncResolved({ ok: summary.found !== false, json: () => syncResolved(summary) });
    try {
      delete require.cache[require.resolve(thankYouPath)];
      require(thankYouPath);
    } finally {
      global.window = prevWindow;
      global.document = prevDocument;
      global.fetch = prevFetch;
    }
    return { els, lookups, purchases, cleared };
  }

  // Happy path: a genuine Worker redirect still books revenue and clears.
  const good = runThankYou("?session_id=cs_test_a1B2c3&amount=42.00&currency=usd");
  eq(good.purchases.length, 1, "thank-you: real cs_test_ session fires one Purchase event");
  eq(good.purchases[0].name, "Purchase", "thank-you: analytics event is named Purchase");
  /* NO revenue and NO currency on the client Purchase event any more. The
     money is booked once, server-side, by the Stripe webhook ("Order Paid" --
     workers/routes/stripe-webhook.js), off the amount Stripe actually
     captured. Sending it from here as well would double-count every order
     whose shopper makes it back to this page, because Umami's Revenue report
     sums the property wherever it finds it. Purchase stays as the funnel's
     last step and carries nothing at all. */
  eq(
    good.purchases[0].payload,
    undefined,
    "thank-you: Purchase carries no properties -- revenue is booked server-side"
  );
  eq(
    good.els.thankYouEyebrow.textContent,
    "Order Confirmed \u00b7 Receipt Issued",
    "thank-you: confirmed order says so"
  );

  // The same redirect with the Worker unable to vouch for it: nothing is
  // booked, nothing is cleared, and nothing says "paid" (verify-D H-1).
  const unconfirmed = runThankYou("?session_id=cs_live_totallyMadeUp&amount=9999.99", null, {
    summary: { found: false, error: "not_found" }
  });
  eq(unconfirmed.purchases.length, 0, "thank-you: an unconfirmed session fires no Purchase");
  eq(unconfirmed.cleared, 0, "thank-you: an unconfirmed session does not clear the cart");
  eq(
    unconfirmed.els.thankYouAmountGroup.hidden,
    true,
    "thank-you: an unconfirmed session shows no total"
  );
  eq(
    unconfirmed.els.thankYouBadgeWrap.hidden,
    true,
    "thank-you: an unconfirmed session shows no paid badge"
  );
  eq(
    unconfirmed.els.thankYouEyebrow.textContent,
    "Order Confirmation",
    "thank-you: an unconfirmed session is not called confirmed"
  );
  const offline = runThankYou("?session_id=cs_live_net1&amount=10.00", null, { summary: null });
  eq(offline.purchases.length, 0, "thank-you: a failed confirmation request fires no Purchase");
  eq(
    offline.els.thankYouAmountGroup.hidden,
    true,
    "thank-you: a failed confirmation shows no total"
  );
  eq(
    JSON.stringify(good.purchases.map((p) => p.name)),
    JSON.stringify(["Purchase"]),
    "thank-you: the only analytics event this page fires is Purchase"
  );
  eq(good.cleared, 1, "thank-you: real session clears the cart once");
  eq(
    good.els.thankYouAmountGroup.hidden,
    false,
    "thank-you: order total shown when amount present"
  );
  eq(
    good.els.thankYouAmountDisplay.textContent,
    "$42",
    "thank-you: order total renders the Worker-confirmed amount"
  );
  eq(good.els.thankYouSessionRow.hidden, false, "thank-you: reference id shown for a real session");
  /* Seen on a live order 2026-09-03: "Payment Received" rendered twice,
     staggered and overlapping. The badge's first <span> is the 8px pulse dot,
     and querySelector(".receipt-status-badge span") wrote the label into it,
     where it wrapped at 8px and sat beside the real label. */
  eq(
    good.els.badgeText.textContent,
    "Payment Received",
    "thank-you: the paid label goes into the badge's label span"
  );
  /* With the right selector the dot is never even looked up; the old one
     looked it up and filled it. Either way its text must stay empty. */
  eq(
    (good.els.badgePulse || { textContent: "" }).textContent,
    "",
    "thank-you: the pulse dot stays empty -- text in it renders as a second, overlapping label"
  );

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

  // No amount in the URL: nothing is invented from the URL; the confirmed
  // total is what gets shown and booked.
  const noAmount = runThankYou("?session_id=cs_test_noamount");
  eq(
    noAmount.purchases.length,
    1,
    "thank-you: a missing URL amount still books the confirmed total"
  );
  eq(
    noAmount.purchases[0].payload,
    undefined,
    "thank-you: ...and it still carries no revenue property"
  );
  eq(
    noAmount.els.thankYouAmountDisplay.textContent,
    "$42",
    "thank-you: no $25.00 placeholder -- the confirmed total is printed instead"
  );
  const noAmountUnconfirmed = runThankYou("?session_id=cs_test_noamount2", null, {
    summary: { found: false }
  });
  eq(noAmountUnconfirmed.purchases.length, 0, "thank-you: a missing amount books no revenue");
  eq(
    noAmountUnconfirmed.els.thankYouAmountDisplay.textContent,
    "",
    "thank-you: no $25.00 placeholder is printed when the amount is absent"
  );

  // Implausible URL amounts never reach analytics: the Worker's figure does.
  const huge = runThankYou("?session_id=cs_test_huge&amount=99999.99");
  eq(
    huge.purchases[0].payload,
    undefined,
    "thank-you: an implausible ?amount= in the URL reaches analytics either way -- it is not read"
  );
  const hugeUnconfirmed = runThankYou("?session_id=cs_test_huge2&amount=99999.99", null, {
    summary: { found: false }
  });
  eq(hugeUnconfirmed.purchases.length, 0, "thank-you: an amount over $10,000 books no revenue");
  eq(hugeUnconfirmed.cleared, 0, "thank-you: an amount over $10,000 does not clear the cart");
  const negative = runThankYou("?session_id=cs_test_neg&amount=-5", null, {
    summary: { found: false }
  });
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
   Gift-card codes are normalised, and travel in a POST body
   ----------------------------------------------------------
   A GET put the code in the query string, where it lands in browser
   history, the Referer header and every proxy log between here and the
   endpoint. Both callers (this helper and assets/js/gift-card.js) POST
   {code} to /api/gift-card-balance on the Worker, which answers
   Cache-Control: no-store.

   Codes are issued as YALL-XXXX-XXXX-XXXX. A shopper types that in
   lowercase, or pastes it with the dashes eaten, and every one of those is
   the same card -- so the code is folded to one canonical form before it
   goes anywhere, and shown back in that form. The legacy 8-character cards
   are still live and must survive the fold with their single dash intact.
   ========================================================== */
{
  /* input -> canonical form. Case and dashes are the only things that may
     change: no character is ever added, dropped or reordered. */
  const CODE_CASES = [
    ["YALL-ABC1-DEF2-GH34", "YALL-ABC1-DEF2-GH34"],
    ["yall-abc1-def2-gh34", "YALL-ABC1-DEF2-GH34"],
    ["yallabc1def2gh34", "YALL-ABC1-DEF2-GH34"],
    ["  YALL ABC1 DEF2 GH34  ", "YALL-ABC1-DEF2-GH34"],
    ["yall-abc1def2-gh34", "YALL-ABC1-DEF2-GH34"],
    // The 8-character legacy shape passes through with its one dash.
    ["YALL-AB12CD34", "YALL-AB12CD34"],
    ["yall-ab12cd34", "YALL-AB12CD34"],
    ["yallab12cd34", "YALL-AB12CD34"],
    // Neither 8 nor 12: no dashes are invented at positions that mean
    // nothing, because guessing would corrupt a code that does spend.
    ["yall-abc", "YALL-ABC"],
    ["YALL", "YALL"],
    ["", ""],
    ["   ", ""]
  ];

  CODE_CASES.forEach(([input, expected]) => {
    eq(
      cart.normalizeGiftCardCode(input),
      expected,
      `normalizeGiftCardCode(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`
    );
  });

  // Normalising a canonical code again must be a no-op.
  CODE_CASES.forEach(([, expected]) => {
    eq(
      cart.normalizeGiftCardCode(expected),
      expected,
      `normalizeGiftCardCode is idempotent for ${JSON.stringify(expected)}`
    );
  });
}

{
  const originalFetch = global.fetch;
  const calls = [];
  function stubFetch(response) {
    calls.length = 0;
    global.fetch = (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return Promise.resolve(response);
    };
  }

  stubFetch({
    ok: true,
    status: 200,
    json: async () => ({
      valid: true,
      code: "YALL-ABC1-DEF2-GH34",
      balanceCents: 1000,
      balance: 10,
      formattedBalance: "$10"
    })
  });

  asyncChecks.push(
    (async () => {
      const data = await cart.checkGiftCardBalance("  yall-abc1def2 gh34  ");
      eq(calls.length, 1, "checkGiftCardBalance issues one request");
      eq(calls[0].url, "/api/gift-card-balance", "checkGiftCardBalance posts to the Worker route");
      eq(
        /\.netlify/.test(calls[0].url),
        false,
        "checkGiftCardBalance no longer calls the Netlify function path"
      );
      eq(calls[0].opts.method, "POST", "checkGiftCardBalance POSTs");
      eq(
        JSON.parse(calls[0].opts.body),
        { code: "YALL-ABC1-DEF2-GH34" },
        "checkGiftCardBalance sends the normalised code in the body, and nothing else"
      );
      eq(data.balanceCents, 1000, "checkGiftCardBalance returns the Worker's balanceCents");
      eq(data.code, "YALL-ABC1-DEF2-GH34", "checkGiftCardBalance returns the normalised code");

      /* A 200 that echoes a bare code still displays in the canonical shape
         -- the code on screen has to match the code on the card. */
      stubFetch({
        ok: true,
        status: 200,
        json: async () => ({ valid: true, code: "yallabc1def2gh34", balance: 10 })
      });
      const bare = await cart.checkGiftCardBalance("YALL-ABC1-DEF2-GH34");
      eq(bare.code, "YALL-ABC1-DEF2-GH34", "a bare echoed code is re-normalised for display");

      /* 404: the endpoint's own words reach the shopper. */
      stubFetch({
        ok: false,
        status: 404,
        json: async () => ({ valid: false, error: "Gift card not found." })
      });
      let rejection = null;
      try {
        await cart.checkGiftCardBalance("YALL-NOPE-NOPE-NOPE");
      } catch (err) {
        rejection = err;
      }
      eq(rejection instanceof Error, true, "a 404 rejects");
      eq(rejection.message, "Gift card not found.", "a 404 shows the endpoint's message");

      /* 429 is the rate limiter, not a verdict on the code: saying "not
         found" would send the shopper hunting for a card in their hand. */
      stubFetch({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate_limited" })
      });
      rejection = null;
      try {
        await cart.checkGiftCardBalance("YALL-ABC1-DEF2-GH34");
      } catch (err) {
        rejection = err;
      }
      eq(rejection instanceof Error, true, "a 429 rejects");
      eq(
        rejection.message,
        "Too many attempts, try again in a minute.",
        "a 429 shows the throttle message, not the raw error or 'not found'"
      );

      /* A 429 whose body is an HTML error page must not surface a parser
         error in place of the throttle message. */
      stubFetch({
        ok: false,
        status: 429,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        }
      });
      rejection = null;
      try {
        await cart.checkGiftCardBalance("YALL-ABC1-DEF2-GH34");
      } catch (err) {
        rejection = err;
      }
      eq(
        rejection && rejection.message,
        "Too many attempts, try again in a minute.",
        "a non-JSON 429 still shows the throttle message"
      );

      // An empty code never reaches the network at all.
      stubFetch({ ok: true, status: 200, json: async () => ({}) });
      rejection = null;
      try {
        await cart.checkGiftCardBalance("   ");
      } catch (err) {
        rejection = err;
      }
      eq(calls.length, 0, "an empty code makes no request");
      eq(
        rejection && rejection.message,
        "Please enter a gift card code.",
        "an empty code asks for one"
      );

      global.fetch = originalFetch;
    })()
  );
}

/* ==========================================================
   The redeem-points plumbing is gone, not merely unused
   ----------------------------------------------------------
   C-1: store credit was minted from a localStorage counter. The endpoint
   answers 410 now, so the helper that called it is deleted outright --
   leaving a dormant caller around is how a "temporarily disabled" money path
   gets switched back on by accident. Only the inert redeemLoyaltyPoints stub
   survives, so a cached page's inline handler gets a rejected promise rather
   than a TypeError (asserted in cart.test.js against the live YLCart).
   ========================================================== */
{
  eq(typeof cart.redeemPoints, "undefined", "cart.js exports no redeemPoints helper");
  const fs = require("fs");
  const path = require("path");
  const cartSrc = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "cart.js"), "utf8");
  /* Comments may still explain why the path is gone; a string literal
     holding the URL is what would make it callable again. */
  eq(
    /["'][^"'\n]*redeem-points[^"'\n]*["']/.test(cartSrc),
    false,
    "cart.js holds no redeem-points URL in a string literal"
  );
  eq(
    /function\s+redeemPoints/.test(cartSrc),
    false,
    "cart.js defines no redeemPoints function at all"
  );
}

/* ==========================================================
   Nothing may call the retired Netlify function paths
   ----------------------------------------------------------
   They answer 410 now. A single surviving caller is a dead feature that
   fails silently in production, so this is asserted against the source of
   all three browser files rather than against any one code path.
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  ["cart.js", "gift-card.js", "thank-you.js"].forEach((file) => {
    const src = fs.readFileSync(path.join(__dirname, "..", "assets", "js", file), "utf8");
    eq(src.indexOf("/.netlify/"), -1, `${file} contains no /.netlify/ path`);
  });
}

/* ==========================================================
   assets/js/gift-card.js: the on-site balance checker
   ----------------------------------------------------------
   Driven for real, not grepped: the file is executed against a stand-in
   document, the balance form is submitted, and the request it makes and the
   markup it writes are inspected. gift-card.js keeps its own copy of the
   code normaliser (it must work on a page that does not load the cart), so
   the first assertion is that the copy has not drifted from cart.js's.
   ========================================================== */
{
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const giftCardSrc = fs.readFileSync(
    path.join(__dirname, "..", "assets", "js", "gift-card.js"),
    "utf8"
  );

  function makeEl(id) {
    return {
      id,
      value: "",
      innerHTML: "",
      textContent: "",
      hidden: true,
      disabled: false,
      style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      focus() {},
      close() {},
      click() {},
      _listeners: {},
      addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      }
    };
  }

  /* Submit the balance form with `input` and the given response, and hand
     back the request made plus the markup rendered. */
  function checkBalance(input, response) {
    const els = {
      giftCardBalanceForm: makeEl("giftCardBalanceForm"),
      giftCardBalanceInput: makeEl("giftCardBalanceInput"),
      giftCardBalanceResult: makeEl("giftCardBalanceResult"),
      checkBalanceSubmitBtn: makeEl("checkBalanceSubmitBtn")
    };
    const calls = [];
    const sandbox = {
      window: {},
      document: {
        // No preset buttons: the purchase half of the file bails out and
        // only the balance checker runs.
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: (id) => els[id] || null
      },
      fetch: (url, opts) => {
        calls.push({ url: String(url), opts: opts || {} });
        return Promise.resolve(response);
      },
      Promise,
      JSON,
      Number,
      String,
      console
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(giftCardSrc, sandbox, { filename: "gift-card.js" });

    els.giftCardBalanceInput.value = input;
    const submit = els.giftCardBalanceForm._listeners.submit;
    if (!submit || !submit.length) throw new Error("gift-card.js registered no submit handler");
    submit[0]({ preventDefault() {} });

    // Let the fetch chain settle.
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => ({
      calls,
      html: els.giftCardBalanceResult.innerHTML,
      btn: els.checkBalanceSubmitBtn
    }));
  }

  const okResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      valid: true,
      code: "YALL-ABC1-DEF2-GH34",
      balanceCents: 1000,
      balance: 10,
      formattedBalance: "$10"
    })
  });

  asyncChecks.push(
    (async () => {
      const out = await checkBalance("  yall-abc1def2 gh34  ", okResponse());
      eq(out.calls.length, 1, "gift-card.js issues one balance request");
      eq(out.calls[0].url, "/api/gift-card-balance", "gift-card.js posts to the Worker route");
      eq(out.calls[0].opts.method, "POST", "gift-card.js POSTs the balance lookup");
      eq(
        JSON.parse(out.calls[0].opts.body),
        { code: "YALL-ABC1-DEF2-GH34" },
        "gift-card.js sends the normalised code in the body"
      );
      eq(
        out.html.includes("YALL-ABC1-DEF2-GH34"),
        true,
        "gift-card.js displays the normalised code, not what was typed"
      );
      eq(out.html.includes("$10</div>"), true, "gift-card.js displays the formatted balance");
      eq(out.btn.disabled, false, "gift-card.js re-enables the Check Balance button");

      /* gift-card.js's normaliser must agree with cart.js's character for
         character, or the same card reads as two different codes depending
         on which box the shopper typed it into. */
      for (const [input, expected] of [
        ["yall-abc1-def2-gh34", "YALL-ABC1-DEF2-GH34"],
        ["yallabc1def2gh34", "YALL-ABC1-DEF2-GH34"],
        ["YALL-AB12CD34", "YALL-AB12CD34"],
        ["yall-ab12cd34", "YALL-AB12CD34"],
        ["  YALL AB12 CD34 ", "YALL-AB12CD34"]
      ]) {
        const res = await checkBalance(input, okResponse());
        eq(
          JSON.parse(res.calls[0].opts.body).code,
          cart.normalizeGiftCardCode(input),
          `gift-card.js normalises ${JSON.stringify(input)} exactly as cart.js does`
        );
        eq(
          JSON.parse(res.calls[0].opts.body).code,
          expected,
          `gift-card.js sends ${JSON.stringify(expected)} for ${JSON.stringify(input)}`
        );
      }

      // 429: the throttle message, not "not found".
      const throttled = await checkBalance("YALL-ABC1-DEF2-GH34", {
        ok: false,
        status: 429,
        json: async () => ({ error: "rate_limited" })
      });
      eq(
        throttled.html.includes("Too many attempts, try again in a minute."),
        true,
        "gift-card.js shows the throttle message on a 429"
      );
      eq(
        throttled.html.includes("rate_limited"),
        false,
        "gift-card.js does not leak the raw 429 error string"
      );
      eq(throttled.btn.disabled, false, "gift-card.js re-enables the button after a 429");

      // 404: the endpoint's own words, escaped on the way into innerHTML.
      const missing = await checkBalance("YALL-NOPE-NOPE-NOPE", {
        ok: false,
        status: 404,
        json: async () => ({ valid: false, error: 'Not found <img src=x onerror="alert(1)">' })
      });
      /* The endpoint's own words are no longer printed at all (verify-B L-6):
         fixed shopper copy replaces them, so nothing from the server can land
         in innerHTML, escaped or not. */
      eq(
        missing.html.includes("Not found") || missing.html.includes("onerror"),
        false,
        "gift-card.js never writes the endpoint's error string into innerHTML"
      );
      eq(
        /find a gift card with that code/.test(missing.html),
        true,
        "gift-card.js shows its own not-found copy instead"
      );
      eq(
        missing.html.includes("<img src=x"),
        false,
        "gift-card.js writes no live markup from the endpoint's error"
      );

      // An empty code never reaches the network.
      const empty = await checkBalance("   ", okResponse());
      eq(empty.calls.length, 0, "gift-card.js makes no request for an empty code");
    })()
  );

  eq(
    /gift-card-balance\?code=/.test(giftCardSrc),
    false,
    "gift-card.js no longer builds a ?code= balance URL"
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
/* ---- Bundle pricing: explicit price, upgrades, and cross-file agreement ----
   bundleLinePrice() (the drawer), resolveBundlePriceDollars() (the Worker,
   which actually charges) and bundlePricing() (the card) implement the same
   rule in three files. If they drift, the drawer quotes one price and the
   customer is billed another, so this pins all three to the same answers. */
const bundleCatalog = {
  products: [
    { id: "salve-1", price: 20 },
    {
      id: "shea-1",
      price: 18,
      variants: {
        name: "Size",
        options: [
          { label: "4 oz", priceDelta: 0 },
          { label: "8 oz", priceDelta: 5 }
        ]
      }
    }
  ],
  bundles: [{ id: "night", productIds: ["salve-1", "shea-1"], discountPercent: 10, price: 34 }]
};
const fixedBundle = bundleCatalog.bundles[0];
const percentBundle = { id: "night-pct", productIds: ["salve-1", "shea-1"], discountPercent: 10 };

eq(
  cart.bundleLinePrice(fixedBundle, null, bundleCatalog),
  34,
  "bundleLinePrice uses the set's own price, not the percentage"
);
eq(
  cart.bundleLinePrice(fixedBundle, { "shea-1": "8 oz" }, bundleCatalog),
  39,
  "bundleLinePrice adds an 8 oz upgrade to the set price at face value"
);
eq(
  cart.bundleLinePrice(percentBundle, null, bundleCatalog),
  34.2,
  "bundleLinePrice falls back to the percentage when the set has no price"
);
eq(
  cart.bundleLinePrice(percentBundle, { "shea-1": "8 oz" }, bundleCatalog),
  38.7,
  "bundleLinePrice still discounts the upgrade on the percentage path"
);

const checkoutWorker = require("../workers/checkout.js");
const buildScript = require("./build-site-data.js");
const bundleProductsMap = { "salve-1": { price: 20 }, "shea-1": { price: 18 } };
eq(
  [
    cart.bundleLinePrice(fixedBundle, null, bundleCatalog),
    checkoutWorker.resolveBundlePriceDollars(bundleCatalog, fixedBundle),
    buildScript.bundlePricing(fixedBundle, bundleProductsMap).bundlePrice
  ],
  [34, 34, 34],
  "drawer, Worker and card agree on the set price"
);
eq(
  [
    cart.bundleLinePrice(fixedBundle, { "shea-1": "8 oz" }, bundleCatalog),
    checkoutWorker.resolveBundlePriceDollars(bundleCatalog, fixedBundle, [{ priceDelta: 5 }])
  ],
  [39, 39],
  "drawer and Worker agree once an upgrade is chosen"
);

/* ---- A saved cart is re-priced from the live catalog on load ----
   Red-team finding (2026-09-03): a cart saved before a price change kept the
   old price in the drawer while the Worker charged the new one. */
global.window.YL_PRODUCTS = bundleCatalog;
const stale = cart.sanitizeStoredItems([
  { id: "salve-1", price: 19.99, qty: 1 },
  { id: "shea-1", price: 17, variantLabel: "8 oz", variantDelta: 3, qty: 2 },
  { id: "bundle-night", price: 34.2, qty: 1, bundleVariants: { "shea-1": "4 oz" } },
  { id: "gone-product", price: 5, qty: 1 }
]);
eq(stale.dropped, 1, "sanitizeStoredItems drops a line the catalog no longer has");
eq(
  stale.items.map(function (it) {
    return [it.id, it.price, it.variantDelta || 0];
  }),
  [
    ["salve-1", 20, 0],
    ["shea-1", 18, 5],
    ["bundle-night", 34, 0]
  ],
  "sanitizeStoredItems replaces stored prices and variant deltas with today's catalog values"
);
delete global.window.YL_PRODUCTS;

Promise.all(asyncChecks).then(
  () => {
    console.log(`\ncart-engine.test.js: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  },
  (err) => {
    console.error("  ✗ an async check threw", err);
    console.log(`\ncart-engine.test.js: ${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  }
);
