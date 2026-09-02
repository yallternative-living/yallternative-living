/**
 * @fileoverview Unit tests for the browser-side cart functionality in assets/js/cart.js
 * Run: node scripts/cart.test.js
 */

const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
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
      },
      toggle: function (name) {
        if (this._list.has(name)) this._list.delete(name);
        else this._list.add(name);
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
    _listeners: {},
    addEventListener: function (type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter((f) => f !== fn);
    },
    // Test-only: run the handlers a real click would.
    _fire: function (type) {
      (this._listeners[type] || []).slice().forEach((fn) =>
        fn({
          type,
          target: this,
          preventDefault: () => {},
          stopPropagation: () => {}
        })
      );
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
        // if querying id, set the id
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

const mockDocument = {
  documentElement: createMockElement("html"),
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {},
  readyState: "complete",
  querySelectorAll: function () {
    return [createMockElement("div")];
  }
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  addEventListener: () => {},
  YL_CONTENT: { site: { loyaltyPointsPerDollar: 1 } }
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.crypto = { randomUUID: () => "uuid-1234" };

require("../assets/js/cart.js");

const YLCart = global.window.YLCart;

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

console.log("Running cart.js browser-side unit tests...\n");

/* Test load/save persistence */
storage.clear();
YLCart.clear();
eq(YLCart.items(), [], "clear resets items");
eq(YLCart.count(), 0, "clear resets count");

// Manually seed local storage
const mockItems = [{ id: "test", qty: 2, price: 10, name: "Test Item" }];
storage.set("yl-cart-v1", JSON.stringify(mockItems));

// Re-initialize to trigger load()
YLCart.init({ force: true });

eq(YLCart.items().length, 1, "load() reads from localStorage");
eq(YLCart.items()[0].id, "test", "load() sets correct items");
eq(YLCart.count(), 2, "count() matches loaded quantities");

/* The cart is persisted as {version, items} rather than a bare array, so
   these read it back through the same envelope the browser writes. */
function storedCart() {
  const raw = storage.get("yl-cart-v1");
  return raw ? JSON.parse(raw) : null;
}
function storedItems() {
  const parsed = storedCart();
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : parsed.items || [];
}

// Add an item using YLCart.addCustomBox (which triggers save)
YLCart.addCustomBox({ productIds: ["p1", "p2"], price: 30 });
eq(YLCart.items().length, 2, "addCustomBox adds to items");
const savedData = storedItems();
eq(savedData.length, 2, "save() writes back to localStorage");
assert(
  savedData.some((i) => i.id === "custom-box"),
  "save() includes the added item"
);

// Verify Drawer Rendering
// We need to trigger render(), which is called by openDrawer() and addCustomBox()
// The drawer is appended to the body
const drawer = mockDocument.body.children.find((el) => el.id === "yl-cart-drawer");
assert(drawer != null, "Drawer element is appended to body");

if (drawer) {
  const itemsEl = drawer.querySelector("#yl-cart-items");
  assert(itemsEl.innerHTML.includes("Test Item"), "render() populates items correctly");
  assert(
    itemsEl.innerHTML.includes("Build-Your-Own Box"),
    "render() populates custom box correctly"
  );

  const footEl = drawer.querySelector("#yl-cart-foot");
  assert(footEl.innerHTML.includes("Subtotal"), "render() populates subtotal footer");

  // Test drawer state
  YLCart.open();
  assert(drawer.getAttribute("data-open") === "true", "open() sets data-open");

  YLCart.close();
  assert(drawer.getAttribute("data-open") === null, "close() removes data-open");
}

// Malformed JSON recovery
storage.set("yl-cart-v1", "{bad json}");
YLCart.init({ force: true });
eq(YLCart.items(), [], "load() recovers from malformed JSON");
/* The stored payload is versioned, and a pre-version bare array -- which is
   what every existing shopper has in localStorage right now -- still loads
   and is rewritten in the new shape on the next save. */
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "legacy-item", qty: 3, price: 5, name: "Legacy Item" }])
);
YLCart.init({ force: true });
eq(YLCart.items().length, 1, "load() migrates a pre-version bare array");
eq(YLCart.count(), 3, "load() keeps quantities through the migration");
YLCart.addCustomBox({ productIds: ["p1"], price: 12 });
eq(storedCart().version, 1, "save() writes a versioned cart envelope");
assert(Array.isArray(storedCart().items), "save() keeps the lines under .items");
eq(storedItems().length, 2, "a migrated cart keeps its original line");

/* ==========================================================
   freeShipThreshold(): reads YL_PRODUCTS.shop.freeShippingThreshold
   ----------------------------------------------------------
   The drawer's free-shipping progress line used to be driven by a
   `window.YL_FREE_SHIP` global that nothing on the site ever assigned, so the
   threshold silently pinned to the DEFAULT_FREE_SHIP fallback of 40 no matter
   what products.json said. Editing shop.freeShippingThreshold moved the number
   on the product cards but not in the cart, so the two disagreed. The helper
   now reads the same products.json field the rest of the site does.

   Scope note: cart-engine.test.js covers freeShipThreshold() as a pure
   function (return values for configured / 0 / missing / non-numeric inputs).
   This block deliberately does NOT re-assert those numbers. It covers the
   layer above -- that render() actually threads the resolved threshold into
   the drawer copy a shopper reads -- which is where the original drift lived:
   the helper and the rendered promise disagreeing.

   These assertions therefore drive the helper through its observable output:
   the drawer footer rendered by render(), which openDrawer() calls.

   This block sets up its own cart state and restores every global it touches,
   so it neither depends on nor disturbs the sections above.
   ========================================================== */
const savedYlProducts = mockWindow.YL_PRODUCTS;
const savedYlFreeShip = mockWindow.YL_FREE_SHIP;

// $50 of physical (non-gift-card) goods: enough to clear a 40 threshold and
// fall short of a 75 one, so the two cases produce different copy.
function seedPhysicalCart() {
  storage.set(
    "yl-cart-v1",
    JSON.stringify([{ id: "physical-item", qty: 2, price: 25, name: "Physical Item" }])
  );
  YLCart.init({ force: true });
}

function drawerFootHTML() {
  YLCart.open();
  const el = mockDocument.body.children
    .find((child) => child.id === "yl-cart-drawer")
    .querySelector("#yl-cart-foot");
  YLCart.close();
  return el.innerHTML;
}

seedPhysicalCart();
eq(YLCart.items().length, 1, "free-ship fixture seeded a single physical line");

// Fallback: no YL_PRODUCTS at all -> DEFAULT_FREE_SHIP of 40, which $50 clears.
delete mockWindow.YL_PRODUCTS;
let footHTML = drawerFootHTML();
assert(
  footHTML.includes("Free Tracked Shipping") && footHTML.includes("unlocked"),
  "freeShipThreshold falls back to 40 when YL_PRODUCTS is absent ($50 cart qualifies)"
);

// Configured: 75 leaves $25 to go, so the copy must switch to the shortfall
// message AND name the exact remaining amount.
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 75 } };
footHTML = drawerFootHTML();
assert(
  footHTML.includes("Add $25.00 for Free Tracked Shipping!"),
  "freeShipThreshold uses configured 75 (a $50 cart is $25.00 short)"
);
assert(
  !footHTML.includes("unlocked"),
  "freeShipThreshold does not report free shipping unlocked below the configured threshold"
);

// A configured threshold the $50 cart clears must flip the copy back, proving
// the helper tracks the config rather than latching onto one branch.
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 30 } };
footHTML = drawerFootHTML();
assert(
  footHTML.includes("unlocked"),
  "freeShipThreshold uses configured 30 (a $50 cart qualifies)"
);

// Regression pin for the actual bug: the OLD implementation read
// window.YL_FREE_SHIP. Setting only that global must now change nothing --
// this assertion is what fails if the helper is reverted to the old source.
delete mockWindow.YL_PRODUCTS;
mockWindow.YL_FREE_SHIP = 500;
footHTML = drawerFootHTML();
assert(
  footHTML.includes("unlocked"),
  "freeShipThreshold ignores the stale YL_FREE_SHIP global (reads products.json config only)"
);
assert(
  !footHTML.includes("Add $450.00"),
  "freeShipThreshold does not resurrect YL_FREE_SHIP as the threshold source"
);

/* A threshold of 0 is the CMS's documented "disable free shipping" switch
   ("Set to 0 to disable", admin/config.yml), NOT an unusable value: the drawer
   must drop the whole progress meter rather than fall back to 40 and keep
   advertising a tier checkout no longer honours. */
mockWindow.YL_FREE_SHIP = savedYlFreeShip;
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 0 } };
footHTML = drawerFootHTML();
assert(
  !footHTML.includes("free shipping") &&
    !footHTML.includes("Free Tracked Shipping") &&
    !footHTML.includes("yl-cart-ship") &&
    !footHTML.includes("yl-cart-milestones"),
  "drawer drops the free-shipping meter entirely when the threshold is 0 (disabled)"
);
assert(footHTML.includes("Subtotal"), "drawer still renders its subtotal with free shipping off");

// Genuinely unusable values fall back to 40 rather than rendering NaN copy.
for (const bad of ["not-a-number", null, undefined, ""]) {
  mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: bad } };
  footHTML = drawerFootHTML();
  assert(
    footHTML.includes("unlocked") && !footHTML.includes("NaN"),
    `drawer falls back to the default threshold for unusable value ${JSON.stringify(bad)}`
  );
}

/* ==========================================================
   Multi-Tier Milestone Progress Meter DOM Suite (R3)
   ========================================================== */
mockWindow.YL_PRODUCTS = {
  shop: {
    shippingMilestones: [
      { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" },
      { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" }
    ]
  }
};

// 1. Tier 0 ($25 subtotal) -> Short of $40 milestone 1
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "item-25", qty: 1, price: 25.0, name: "Item 25" }])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();

assert(
  footHTML.includes("Add $15.00 for Free Tracked Shipping!"),
  "Multi-tier DOM: $25 subtotal shows countdown to $40 shipping threshold"
);
assert(
  footHTML.includes('role="progressbar"'),
  "Multi-tier DOM: Progress bar includes role='progressbar'"
);
assert(
  footHTML.includes('aria-valuenow="25"'),
  "Multi-tier DOM: aria-valuenow reflects current physical subtotal ($25)"
);
assert(
  footHTML.includes('aria-valuemax="60"'),
  "Multi-tier DOM: aria-valuemax reflects highest milestone ($60)"
);
assert(
  footHTML.includes('aria-label="Shipping and reward milestones"'),
  "Multi-tier DOM: aria-label configured for accessibility"
);
assert(
  footHTML.includes('class="yl-cart-milestones-fill" style="width:42%"'),
  "Multi-tier DOM: fill bar rendered with correct width percentage (25/60 = 42%)"
);
assert(
  footHTML.includes('style="left:66.67%"') && footHTML.includes("<span>$40</span>"),
  "Multi-tier DOM: $40 milestone pin rendered at 66.67%"
);
assert(
  footHTML.includes('style="left:100.00%"') && footHTML.includes("<span>$60</span>"),
  "Multi-tier DOM: $60 milestone pin rendered at 100.00%"
);
assert(
  !footHTML.includes("is-reached"),
  "Multi-tier DOM: neither pin has .is-reached class at $25 subtotal"
);

// 2. Tier 1 ($40 subtotal) -> Unlocks Tier 1 ($40), counts down to Tier 2 ($60)
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "item-40", qty: 2, price: 20.0, name: "Item 40" }])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();

assert(
  footHTML.includes("Add $20.00 more to unlock a Free Handcrafted Pocket Salve!"),
  "Multi-tier DOM: $40 subtotal unlocks shipping and prompts for gift milestone"
);
assert(
  footHTML.includes('class="yl-cart-milestones-fill" style="width:67%"'),
  "Multi-tier DOM: fill bar at 67% width for $40 subtotal"
);
assert(
  footHTML.includes('class="yl-cart-milestone-pin is-reached" style="left:66.67%"'),
  "Multi-tier DOM: $40 milestone pin has .is-reached class"
);

// 3. Float Precision Safety ($51.99 subtotal) -> Exactly $8.01 remaining
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "item-float", qty: 1, price: 51.99, name: "Item Float" }])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();

assert(
  footHTML.includes("Add $8.01 more to unlock a Free Handcrafted Pocket Salve!"),
  "Multi-tier DOM: $51.99 subtotal computes $8.01 without floating point noise"
);
assert(
  footHTML.includes('class="yl-cart-milestones-fill" style="width:87%"'),
  "Multi-tier DOM: fill bar at 87% width for $51.99 subtotal"
);

// 4. Tier 2 ($60 subtotal) -> Unlocks all perks
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "item-60", qty: 3, price: 20.0, name: "Item 60" }])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();

assert(
  footHTML.includes("🎉 All perks unlocked! Free Shipping + Free Handcrafted Pocket Salve!"),
  "Multi-tier DOM: $60 subtotal displays all perks unlocked celebration message"
);
assert(
  footHTML.includes('class="yl-cart-milestones-fill" style="width:100%"'),
  "Multi-tier DOM: fill bar at 100% width for $60 subtotal"
);
assert(
  footHTML.includes('class="yl-cart-milestone-pin is-reached" style="left:66.67%"') &&
    footHTML.includes('class="yl-cart-milestone-pin is-reached" style="left:100.00%"'),
  "Multi-tier DOM: both $40 and $60 pins carry .is-reached class"
);

// Restore globals so nothing after this block inherits the fixture.
if (savedYlProducts === undefined) delete mockWindow.YL_PRODUCTS;
else mockWindow.YL_PRODUCTS = savedYlProducts;
if (savedYlFreeShip === undefined) delete mockWindow.YL_FREE_SHIP;
else mockWindow.YL_FREE_SHIP = savedYlFreeShip;
/* ==========================================================
   2oz Salve Mix-and-Match Volume Pricing Drawer DOM Suite
   ========================================================== */
function drawerItemsHTML() {
  YLCart.open();
  const el = mockDocument.body.children
    .find((child) => child.id === "yl-cart-drawer")
    .querySelector("#yl-cart-items");
  YLCart.close();
  return el.innerHTML;
}

// 1. Single qualifying 2oz salve in cart
storage.set(
  "yl-cart-v1",
  JSON.stringify([
    {
      id: "frankincense-salve",
      category: "salves",
      qty: 1,
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Frankincense Salve"
    }
  ])
);
YLCart.init({ force: true });
let itemsHTML = drawerItemsHTML();
footHTML = drawerFootHTML();
assert(itemsHTML.includes("$19.99"), "1x 2oz salve renders at $19.99");
assert(
  !itemsHTML.includes("2+ for $14.99 applied"),
  "1x 2oz salve does not have 2+ for $14.99 applied badge"
);
assert(
  footHTML.includes("Add 1 more 2oz salve to get both for $14.99 each"),
  "1x 2oz salve renders mix-and-match nudge in footer"
);

// 2. Two qualifying 2oz salves in cart (2x Frankincense 2oz)
storage.set(
  "yl-cart-v1",
  JSON.stringify([
    {
      id: "frankincense-salve",
      category: "salves",
      qty: 2,
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Frankincense Salve"
    }
  ])
);
YLCart.init({ force: true });
itemsHTML = drawerItemsHTML();
footHTML = drawerFootHTML();
assert(itemsHTML.includes("$29.98"), "2x 2oz salve renders $29.98 total");
assert(itemsHTML.includes("$14.99 ea"), "2x 2oz salve renders $14.99 ea unit price");
assert(itemsHTML.includes("2+ for $14.99 applied"), "2x 2oz salve renders applied badge");
assert(footHTML.includes("$29.98"), "2x 2oz salve renders $29.98 subtotal in footer");
assert(
  footHTML.includes("$14.99/ea 2oz salve volume tier applied"),
  "2x 2oz salve renders celebration banner in footer"
);

// 3. Mix & Match: 1x Frankincense 2oz + 1x Sleep Salve 2oz
storage.set(
  "yl-cart-v1",
  JSON.stringify([
    {
      id: "frankincense-salve",
      category: "salves",
      qty: 1,
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Frankincense Salve"
    },
    {
      id: "sleep-salve",
      category: "salves",
      qty: 1,
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Sleep Salve"
    }
  ])
);
YLCart.init({ force: true });
itemsHTML = drawerItemsHTML();
footHTML = drawerFootHTML();
assert(
  itemsHTML.includes("2+ for $14.99 applied"),
  "Mix & match renders applied badge on both lines"
);
assert(footHTML.includes("$29.98"), "Mix & match renders $29.98 subtotal in footer");
assert(
  footHTML.includes("$14.99/ea 2oz salve volume tier applied"),
  "Mix & match renders celebration banner in footer"
);

// 4. Multi-Rule Volume Pricing Drawer DOM Rendering (Salves + Soaks)
mockWindow.YL_PRODUCTS = {
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
    { id: "lavender-soak", category: "soaks", price: 18.0 },
    { id: "ritual-soak", category: "soaks", price: 18.0 }
  ]
};

storage.set(
  "yl-cart-v1",
  JSON.stringify([
    {
      id: "frankincense-salve",
      category: "salves",
      qty: 2,
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Frankincense Salve"
    },
    {
      id: "lavender-soak",
      category: "soaks",
      qty: 1,
      price: 18.0,
      variantDelta: 0,
      name: "Lavender Soak"
    },
    {
      id: "ritual-soak",
      category: "soaks",
      qty: 1,
      price: 18.0,
      variantDelta: 0,
      name: "Ritual Soak"
    }
  ])
);
YLCart.init({ force: true });
itemsHTML = drawerItemsHTML();
footHTML = drawerFootHTML();

assert(
  itemsHTML.includes("2+ for $14.99 applied"),
  "Multi-rule: Salves have 2+ for $14.99 badge in drawer"
);
assert(
  itemsHTML.includes("2+ for $16 applied"),
  "Multi-rule: Soaks have 2+ for $16 applied badge in drawer"
);
assert(footHTML.includes("$61.98"), "Multi-rule: Drawer renders combined subtotal $61.98");
assert(
  footHTML.includes("$14.99/ea 2oz salve volume tier applied"),
  "Multi-rule: Salve celebration banner present"
);
assert(
  footHTML.includes("$16.00/ea soak volume tier applied"),
  "Multi-rule: Soak celebration banner present"
);

/* ==========================================================
   Mix & Match nudge must never say "free shipping" once the $40 tier is
   already unlocked and a further milestone (here, $60) remains -- the
   nudge's "next perk" text used to be hardcoded to "free shipping"
   regardless of which milestone was actually next (see the "Name the NEXT
   perk, whatever it is" comment in cart.js's drawer renderer). This
   exercises the exact combination that bug shipped in: a qualifying
   volume-pricing item AND a multi-tier shippingMilestones config, at a
   subtotal past the first tier.
   ========================================================== */
mockWindow.YL_PRODUCTS = {
  shop: {
    shippingMilestones: [
      { threshold: 40, reward: "Free Tracked Shipping", icon: "truck" },
      { threshold: 60, reward: "Free Handcrafted Pocket Salve", icon: "gift" }
    ]
  }
};
storage.set(
  "yl-cart-v1",
  JSON.stringify([
    {
      id: "frankincense-salve",
      category: "salves",
      qty: 3, // 3 * $14.99 volume price = $44.97: past the $40 tier, short of $60
      price: 19.99,
      variantDelta: 0,
      variantLabel: "2oz",
      name: "Frankincense Salve"
    }
  ])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();
assert(
  footHTML.includes(
    "$14.99/ea 2oz salve volume tier applied! · Add $15.03 for Free Handcrafted Pocket Salve!"
  ),
  "Mix & Match nudge names the real next milestone reward once the $40 tier is already crossed"
);
assert(
  !/free shipping/i.test(footHTML),
  "Nothing in the drawer footer says 'free shipping' once the $40 tier is already unlocked and a further tier remains"
);
assert(
  footHTML.includes("Add $15.03 more to unlock a Free Handcrafted Pocket Salve!"),
  "The milestone banner itself also names the real next reward, not 'free shipping'"
);

mockWindow.YL_PRODUCTS = null;

// Milestone 1 Tests: Gifting UI, Share Cart Hydration & Loyalty Wallet in Cart Drawer

// 1. Gifting UI & Feature Flag Gate
mockWindow.YL_CONTENT = {
  site: {
    enableGiftOrders: true,
    enableShareCart: true,
    enableLoyaltyPoints: true,
    loyaltyPointsName: "Alt-Points",
    loyaltyPointsPerDollar: 1
  }
};
mockWindow.YL_PRODUCTS = {
  products: [
    { id: "lavender-soak", name: "Lavender Soak", price: 18.0, category: "soaks" },
    {
      id: "frankincense-salve",
      name: "Frankincense Salve",
      price: 19.99,
      category: "salves",
      variants: {
        name: "Size",
        options: [{ name: "2oz", priceDelta: 0 }]
      }
    }
  ]
};

storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "lavender-soak", qty: 1, price: 18.0, name: "Lavender Soak" }])
);
YLCart.init({ force: true });
footHTML = drawerFootHTML();
assert(
  footHTML.includes("yl-cart-giftorder-wrap"),
  "Gifting: Renders gift order wrap when enabled"
);
assert(footHTML.includes("This order is a gift"), "Gifting: Renders gift order checkbox label");
assert(footHTML.includes("yl-cart-giftmessage-input"), "Gifting: Renders gift message textarea");

// When enableGiftOrders is false
mockWindow.YL_CONTENT.site.enableGiftOrders = false;
footHTML = drawerFootHTML();
assert(
  !footHTML.includes("yl-cart-giftorder-wrap"),
  "Gifting: Omits gift order wrap when enableGiftOrders is false"
);
mockWindow.YL_CONTENT.site.enableGiftOrders = true;

// 2. Share Cart UI & Feature Flag Gate
footHTML = drawerFootHTML();
assert(footHTML.includes("yl-cart-share-wrap"), "Share Cart: Renders share cart wrap when enabled");
assert(footHTML.includes("yl-cart-share-btn"), "Share Cart: Renders share cart button");

// When enableShareCart is false
mockWindow.YL_CONTENT.site.enableShareCart = false;
footHTML = drawerFootHTML();
assert(
  !footHTML.includes("yl-cart-share-wrap"),
  "Share Cart: Omits share cart wrap when enableShareCart is false"
);
mockWindow.YL_CONTENT.site.enableShareCart = true;

// 3. Share Cart URL Hydration (restoreCartFromUrl)
storage.clear();
YLCart.init({ force: true });
eq(YLCart.items().length, 0, "Cart empty prior to shared URL hydration");

const restored = YLCart.restoreCartFromUrl("?cart=lavender-soak:2,frankincense-salve:1:2oz");
assert(restored, "restoreCartFromUrl returns true on successful parse and addition");
eq(YLCart.items().length, 2, "restoreCartFromUrl adds valid products to cart items");
eq(YLCart.count(), 3, "restoreCartFromUrl restores exact quantities (2 + 1 = 3)");
const storedAfterShare = storedItems();
eq(storedAfterShare.length, 2, "restoreCartFromUrl persists restored items to localStorage");

// 4. Alt-Points Loyalty Wallet UI & 1-Click Redemption
storage.clear();
storage.set(
  "yl-cart-v1",
  JSON.stringify([{ id: "lavender-soak", qty: 2, price: 18.0, name: "Lavender Soak" }])
);
// Seed 150 points in customer wallet
YLCart.setWalletPoints(150);
eq(YLCart.getWalletPoints(), 150, "Wallet points initialized to 150");

YLCart.init({ force: true });
footHTML = drawerFootHTML();

assert(footHTML.includes("yl-cart-loyalty-card"), "Loyalty: Renders loyalty wallet card");
assert(footHTML.includes("yl-loyalty-wallet-balance"), "Loyalty: Renders wallet balance element");
assert(footHTML.includes("150"), "Loyalty: Displays current 150 points balance");
/* Alt-Points are never credited and redeem-points answers 410, so the drawer
   promises neither. The wallet balance above is all that is left of it. */
assert(
  !footHTML.includes("Redeem 100") && !footHTML.includes("yl-cart-redeem-btn"),
  "Loyalty: no Alt-Points redeem button is rendered"
);
assert(
  !footHTML.includes("more points to unlock"),
  "Loyalty: no points-to-next-voucher nudge is rendered"
);
assert(
  !footHTML.includes("You'll earn") && !footHTML.includes("cart-points-count"),
  "Loyalty: the drawer no longer promises points this order will earn"
);
assert(
  !footHTML.includes("Add physical items to earn"),
  "Loyalty: the drawer no longer advertises earning points"
);

(async () => {
  try {
    const originalFetch = global.fetch;

    /* ==========================================================
       Alt-Points redemption is unavailable end to end: it must reject
       without touching the network and without moving the wallet.
       ========================================================== */
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ code: "YALL-PTS-NOPE", balance: 5 }) };
    };

    let redeemError = null;
    try {
      await YLCart.redeemLoyaltyPoints(100);
    } catch (err) {
      redeemError = err;
    }
    assert(redeemError instanceof Error, "redeemLoyaltyPoints rejects");
    eq(
      redeemError && redeemError.message,
      "Alt-Points redemption is not available yet.",
      "redeemLoyaltyPoints rejects with the unavailable message"
    );
    eq(fetchCalls, 0, "redeemLoyaltyPoints makes no network call");
    eq(YLCart.getWalletPoints(), 150, "redeemLoyaltyPoints leaves the wallet balance alone");
    footHTML = drawerFootHTML();
    assert(
      !footHTML.includes("Gift Card Discount"),
      "A refused redemption applies no voucher to the drawer"
    );

    /* ==========================================================
       Gift cards: applied through YLCart.applyGiftCard, stored as
       {code, balance, valid}, capped against subtotal + shipping, and
       dropped by clear().
       ========================================================== */
    mockWindow.YL_PRODUCTS = null;
    storage.clear();
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "physical-item", qty: 1, price: 20, name: "Physical Item" }]
      })
    );
    YLCart.init({ force: true });

    eq(typeof YLCart.applyGiftCard, "function", "YLCart exposes applyGiftCard");
    eq(YLCart.applyGiftCard(null), false, "applyGiftCard rejects a missing object");
    eq(
      YLCart.applyGiftCard({ code: "YALL-NOPE" }),
      false,
      "applyGiftCard rejects a card with no balance"
    );
    eq(
      YLCart.applyGiftCard({ code: "YALL-NOPE", balance: 5, valid: false }),
      false,
      "applyGiftCard rejects a card the endpoint marked invalid"
    );
    eq(
      YLCart.applyGiftCard({ code: "  yall-good1  ", balance: 50, valid: true }),
      true,
      "applyGiftCard accepts a well-formed card"
    );
    eq(
      JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card")),
      { code: "YALL-GOOD1", balance: 50, valid: true },
      "applyGiftCard stores only {code, balance, valid}"
    );

    /* The same card typed three ways is one card. gift-card.js hands
       whatever the endpoint echoed straight to applyGiftCard, so the
       canonical form has to be enforced here rather than at the caller. */
    eq(
      typeof YLCart.normalizeGiftCardCode,
      "function",
      "YLCart exposes normalizeGiftCardCode for the balance checker"
    );
    eq(
      YLCart.normalizeGiftCardCode("yallabc1def2gh34"),
      "YALL-ABC1-DEF2-GH34",
      "YLCart.normalizeGiftCardCode restores the dashes of a 12-character code"
    );
    eq(
      YLCart.normalizeGiftCardCode("yall-ab12cd34"),
      "YALL-AB12CD34",
      "YLCart.normalizeGiftCardCode passes a legacy 8-character code through"
    );
    [" yall-abc1-def2-gh34 ", "yallabc1def2gh34", "YALL-ABC1DEF2-GH34"].forEach((typed) => {
      YLCart.applyGiftCard({ code: typed, balance: 50, valid: true });
      eq(
        JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card")).code,
        "YALL-ABC1-DEF2-GH34",
        `applyGiftCard stores ${JSON.stringify(typed)} in its canonical form`
      );
    });
    YLCart.applyGiftCard({ code: "  yall-good1  ", balance: 50, valid: true });

    footHTML = drawerFootHTML();
    /* $20 of goods is under the $40 default threshold, so $10 shipping
       applies and the card must cover all $30 -- the Worker caps its coupon
       at subtotal + shipping too. */
    assert(
      footHTML.includes("<span>Shipping</span><strong>$10.00"),
      "Shipping line charges $10.00 below the threshold"
    );
    assert(
      footHTML.includes("-$30.00"),
      "Gift card is capped on subtotal + shipping, not the subtotal alone"
    );
    assert(
      footHTML.includes("Estimated total (before tax)"),
      "Totals row is labelled as an estimate before tax"
    );
    assert(!footHTML.includes("Total Due"), "The old Total Due label is gone");

    YLCart.applyGiftCard({
      code: "YALL-GOOD2",
      balance: 12.34,
      valid: true,
      formattedBalance: "$12.34",
      initialAmount: 50
    });
    eq(
      Object.keys(JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card"))).sort(),
      ["balance", "code", "valid"],
      "applyGiftCard drops every other field the balance endpoint returns"
    );

    YLCart.clear();
    eq(
      mockLocalStorage.getItem("yl_applied_gift_card"),
      null,
      "clear() removes the stored gift card"
    );
    footHTML = drawerFootHTML();
    assert(!footHTML.includes("Gift Card Discount"), "clear() drops the applied gift card");

    /* ==========================================================
       Shipping line
       ========================================================== */
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "physical-item", qty: 2, price: 25, name: "Physical Item" }]
      })
    );
    YLCart.init({ force: true });
    footHTML = drawerFootHTML();
    assert(
      footHTML.includes("<span>Shipping</span><strong>Free"),
      "A $50 cart clears the default $40 threshold and ships free"
    );

    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "physical-item", qty: 1, price: 10, name: "Physical Item" }]
      })
    );
    YLCart.init({ force: true });
    footHTML = drawerFootHTML();
    assert(
      footHTML.includes("<span>Shipping</span><strong>$10.00"),
      "A $10 cart is under the threshold and is quoted $10.00 shipping"
    );
    assert(
      footHTML.includes("Estimated total (before tax)</span><strong>$20.00"),
      "Estimated total adds shipping to the subtotal"
    );

    /* ==========================================================
       Pick-up survives a reload and is re-validated against the
       markets the site is currently advertising.
       ========================================================== */
    mockWindow.YL_EVENTS = {
      upcoming: [
        { name: "Landrum Market", dateLabel: "Sat Sep 6", location: "Landrum, SC" },
        { name: "Tryon Market", dateLabel: "Sat Sep 13", location: "Tryon, NC" }
      ]
    };
    storage.set("yl_cart_is_pickup", "true");
    storage.set("yl_cart_pickup_market", "Tryon Market — Sat Sep 13 (Tryon, NC)");
    YLCart.init({ force: true });
    footHTML = drawerFootHTML();
    assert(
      footHTML.includes('id="yl-cart-pickup-checkbox" checked'),
      "A stored pick-up preference survives a reload"
    );
    assert(
      footHTML.includes('value="Tryon Market — Sat Sep 13 (Tryon, NC)" selected'),
      "The stored market label is re-selected"
    );
    assert(
      footHTML.includes("<span>Shipping</span><strong>Free"),
      "Pick-up ships free whatever the subtotal"
    );

    storage.set("yl_cart_pickup_market", "Ghost Market — Sat Jan 1 (Nowhere, SC)");
    YLCart.init({ force: true });
    footHTML = drawerFootHTML();
    assert(
      !footHTML.includes("Ghost Market"),
      "A stored market that is no longer upcoming is discarded on load"
    );
    assert(
      footHTML.includes('value="Landrum Market — Sat Sep 6 (Landrum, SC)" selected'),
      "The next real market is selected in its place"
    );
    delete mockWindow.YL_EVENTS;
    storage.delete("yl_cart_is_pickup");
    storage.delete("yl_cart_pickup_market");

    /* ==========================================================
       load() drops lines the catalog no longer has, and lines that are
       not priceable at all, and says how many it dropped.
       ========================================================== */
    mockWindow.YL_PRODUCTS = {
      products: [{ id: "lavender-soak", name: "Lavender Soak", price: 18.0 }],
      bundles: [{ id: "starter-kit", name: "Starter Kit", price: 40 }]
    };
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [
          { id: "lavender-soak", qty: 1, price: 18, name: "Lavender Soak" },
          { id: "bundle-starter-kit", qty: 1, price: 40, name: "Starter Kit" },
          { id: "custom-box", qty: 1, price: 30, name: "Build-Your-Own Box" },
          { id: "yallternative-gift-card", qty: 1, price: 25, name: "Gift Card" },
          { id: "discontinued-salve", qty: 1, price: 19, name: "Discontinued" },
          { id: "lavender-soak", qty: 1, price: "not-a-price", name: "Broken Price" },
          { id: "", qty: 1, price: 5, name: "No Id" },
          null,
          42
        ]
      })
    );
    YLCart.init({ force: true });
    eq(
      YLCart.items().map((i) => i.id),
      ["lavender-soak", "bundle-starter-kit", "custom-box", "yallternative-gift-card"],
      "load() keeps catalog products, bundles and the two pseudo-ids only"
    );
    eq(storedItems().length, 4, "load() persists the cleaned cart so bad lines do not come back");

    const liveRegion = mockDocument.body.children.find(
      (el) => el.getAttribute && el.getAttribute("aria-live") === "polite"
    );
    eq(
      liveRegion && liveRegion.textContent,
      "Removed 5 unavailable item(s) from your cart",
      "load() announces how many lines it dropped"
    );

    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "lavender-soak", qty: 5000, price: 18, name: "Lavender Soak" }]
      })
    );
    YLCart.init({ force: true });
    eq(YLCart.count(), 99, "load() clamps a stored quantity to the hard ceiling");

    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [
          {
            id: "lavender-soak",
            qty: "<img src=x onerror=alert(1)>",
            price: 18,
            name: "Lavender Soak"
          }
        ]
      })
    );
    YLCart.init({ force: true });
    itemsHTML = drawerItemsHTML();
    assert(
      !itemsHTML.includes("<img src=x"),
      "A non-numeric stored quantity never reaches the drawer as markup"
    );

    /* With no catalog on the page there is nothing to validate against, so
       nothing may be dropped. */
    mockWindow.YL_PRODUCTS = null;
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "some-unknown-id", qty: 1, price: 9, name: "Unknown" }]
      })
    );
    YLCart.init({ force: true });
    eq(YLCart.items().length, 1, "load() keeps every line when no catalog is loaded");

    /* ==========================================================
       Checkout: one request in flight at a time, curated 400 text
       shown verbatim, a 409 that also drops the spent gift card, and a
       generic message for everything else.
       ========================================================== */
    storage.clear();
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "physical-item", qty: 1, price: 20, name: "Physical Item" }]
      })
    );
    YLCart.init({ force: true });

    function drawerFoot() {
      return mockDocument.body.children
        .find((child) => child.id === "yl-cart-drawer")
        .querySelector("#yl-cart-foot");
    }
    function checkoutButton() {
      return drawerFoot().querySelector(".yl-cart-checkout");
    }
    function errorText() {
      const el = drawerFoot().querySelector(".yl-cart-error");
      return el ? el.textContent : "";
    }

    /* ==========================================================
       Checkout Start analytics: fires the moment the checkout POST is
       issued, carrying item count, subtotal in cents, and isPickup --
       so a real dashboard can build the Add to Cart -> Checkout Start ->
       Purchase funnel (docs/research-2026-09-01/research-L-analytics.md
       §3). window.plausible is never called by this repo's own code --
       it's the Umami adapter main.js defines -- so this spies on it
       directly rather than asserting a network call.
       ========================================================== */
    const plausibleCalls = [];
    mockWindow.plausible = (name, opts) => plausibleCalls.push({ name, opts });
    global.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://checkout.stripe.com/pay/cs_test_xyz" })
      });
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const checkoutStartCall = plausibleCalls.find((c) => c.name === "Checkout Start");
    assert(
      checkoutStartCall,
      "Checkout Start analytics event fires the moment the checkout POST is issued"
    );
    eq(
      checkoutStartCall && checkoutStartCall.opts.props,
      { itemCount: 1, subtotalCents: 2000, isPickup: false },
      "Checkout Start carries item count, subtotal in cents, and isPickup"
    );
    delete mockWindow.plausible;

    let checkoutCalls = 0;
    let lastCheckoutOpts = null;
    let resolveCheckout = null;
    global.fetch = (url, opts) => {
      checkoutCalls++;
      lastCheckoutOpts = opts;
      return new Promise((resolve) => {
        resolveCheckout = resolve;
      });
    };

    // Drop handlers accumulated by earlier renders, then render once so the
    // button carries exactly one click handler.
    checkoutButton()._listeners = {};
    YLCart.open();

    checkoutButton()._fire("click");
    checkoutButton()._fire("click");
    eq(checkoutCalls, 1, "A second click while a checkout is in flight starts no second session");
    assert(
      lastCheckoutOpts && lastCheckoutOpts.signal,
      "The checkout request carries an AbortController signal"
    );
    YLCart.open();
    eq(
      checkoutButton().disabled,
      true,
      "A re-render mid-request keeps the Checkout button disabled"
    );

    resolveCheckout({
      ok: false,
      status: 400,
      json: async () => ({ error: "That gift card has already been used." })
    });
    await new Promise((r) => setTimeout(r, 0));
    eq(
      errorText(),
      "That gift card has already been used.",
      "A 400 shows the Worker's curated message verbatim"
    );
    eq(checkoutButton().disabled, false, "The Checkout button is usable again after a failure");

    /* ==========================================================
       C-2 follow-on: the 409 the gift-card ledger returns when a
       concurrent spend beat this session to the card.
       ----------------------------------------------------------
       It reads like a 400 to the shopper -- the Worker's own words, and
       Checkout usable again -- but the card in state is spent, so it has to
       go from state AND from localStorage. Leaving it there sends the same
       dead code on every retry and fails the same way forever, and a reload
       resurrects it.
       ========================================================== */
    eq(
      YLCart.applyGiftCard({ code: "yall-abc1-def2-gh34", balance: 25, valid: true }),
      true,
      "409 setup: a gift card is applied before checkout"
    );
    eq(
      JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card")).code,
      "YALL-ABC1-DEF2-GH34",
      "409 setup: the applied card is stored in its normalised form"
    );
    assert(
      drawerFootHTML().includes("Gift Card Discount"),
      "409 setup: the drawer shows the gift card discount line"
    );

    let conflictBody = null;
    global.fetch = (url, opts) => {
      conflictBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: "That gift card balance changed; please re-apply it." })
      });
    };
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    eq(
      conflictBody && conflictBody.giftCardCode,
      "YALL-ABC1-DEF2-GH34",
      "The checkout payload carried the normalised gift card code"
    );
    eq(
      errorText(),
      "That gift card balance changed; please re-apply it.",
      "A 409 shows the Worker's message verbatim, like a 400"
    );
    eq(checkoutButton().disabled, false, "A 409 leaves the Checkout button usable again");
    eq(
      mockLocalStorage.getItem("yl_applied_gift_card"),
      null,
      "A 409 removes the spent gift card from storage"
    );
    assert(
      !drawerFootHTML().includes("Gift Card Discount"),
      "A 409 drops the gift card discount line from the drawer"
    );

    // The retry after a 409 must not re-send the code that just failed.
    conflictBody = null;
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    eq(
      conflictBody && conflictBody.giftCardCode,
      undefined,
      "The retry after a 409 sends no gift card code at all"
    );

    /* A 409 with no usable body still says something true, and still drops
       the card -- the conflict is real whether or not the Worker explained
       it. */
    global.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      }
    });
    YLCart.applyGiftCard({ code: "YALL-ZZZZ-ZZZZ-ZZZZ", balance: 25, valid: true });
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    eq(
      errorText(),
      "That gift card balance changed; please re-apply it.",
      "A bodyless 409 falls back to the balance-changed message"
    );
    eq(
      mockLocalStorage.getItem("yl_applied_gift_card"),
      null,
      "A bodyless 409 still removes the spent gift card"
    );

    /* A 400 is not a gift-card conflict: whatever else is wrong with the
       cart, the shopper's card must survive it. */
    YLCart.applyGiftCard({ code: "YALL-KEEP-KEEP-KEEP", balance: 25, valid: true });
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Product not found: some-unknown-id" })
    });
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    eq(
      errorText(),
      "Product not found: some-unknown-id",
      "A 400 still shows the Worker's curated message"
    );
    eq(
      JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card") || "null") &&
        JSON.parse(mockLocalStorage.getItem("yl_applied_gift_card")).code,
      "YALL-KEEP-KEEP-KEEP",
      "A 400 leaves the applied gift card alone"
    );
    YLCart.clear();
    storage.set(
      "yl-cart-v1",
      JSON.stringify({
        version: 1,
        items: [{ id: "physical-item", qty: 1, price: 20, name: "Physical Item" }]
      })
    );
    YLCart.init({ force: true });

    global.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      }
    });
    checkoutButton()._listeners = {};
    YLCart.open();
    checkoutButton()._fire("click");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    eq(
      errorText(),
      "Sorry -- checkout isn't available right now. Please try again in a moment.",
      "A non-JSON 500 falls back to the generic message instead of a parser error"
    );

    global.fetch = originalFetch;

    /* ==========================================================
       H-12: the footer scrolls instead of pushing Checkout off screen
       ========================================================== */
    const fs = require("fs");
    const path = require("path");
    const cartCss = fs.readFileSync(
      path.join(__dirname, "..", "assets", "css", "cart.css"),
      "utf8"
    );
    const footRule = cartCss.match(/\.yl-cart-foot\s*\{[^}]*\}/);
    assert(
      footRule && /overflow-y:\s*auto/.test(footRule[0]),
      "cart.css: .yl-cart-foot scrolls on its own"
    );
    assert(
      footRule && /max-height:\s*min\(62dvh,\s*560px\)/.test(footRule[0]),
      "cart.css: .yl-cart-foot is capped at min(62dvh, 560px)"
    );
    const itemsRule = cartCss.match(/\.yl-cart-items\s*\{[^}]*\}/);
    assert(
      itemsRule && /min-height:\s*0/.test(itemsRule[0]),
      "cart.css: .yl-cart-items may shrink below its content"
    );
    assert(
      /@media\s*\(max-height:\s*480px\)\s*\{\s*\.yl-cart-foot\s*\{[^}]*padding:/.test(cartCss),
      "cart.css: a short-viewport media query trims the footer padding"
    );
    assert(
      cartCss.indexOf("*/") < cartCss.indexOf("/* Monoline SVG Icon System */"),
      "cart.css: the file header comment is closed before the next comment"
    );

    /* ==========================================================
       Milestone 2: Cart Drawer Seasonal Workshop / Hiatus Notice
       ========================================================== */
    console.log("\n--- Milestone 2: Cart Drawer Seasonal Notice Tests ---");
    // 1. Enabled with link and showInCart = true
    mockWindow.YL_CONTENT = {
      site: {
        seasonalNotice: {
          enabled: true,
          showInCart: true,
          text: "Spring Foraging Hiatus: Orders ship next week.",
          link: "events.html"
        }
      }
    };
    YLCart.render();
    const seasonalEl = drawer.querySelector("#yl-cart-seasonal-notice");
    assert(seasonalEl != null, "Drawer contains #yl-cart-seasonal-notice element");
    eq(
      seasonalEl.style.display,
      "block",
      "Seasonal notice is visible when enabled and showInCart is true"
    );
    assert(
      seasonalEl.innerHTML.includes("Spring Foraging Hiatus: Orders ship next week."),
      "Seasonal notice renders configured text"
    );
    assert(
      seasonalEl.innerHTML.includes('href="events.html"'),
      "Seasonal notice renders link when provided"
    );
    assert(
      seasonalEl.innerHTML.includes("yl-cart-seasonal-content"),
      "Seasonal notice contains .yl-cart-seasonal-content container"
    );

    // 2. Disabled seasonalNotice (enabled = false)
    mockWindow.YL_CONTENT = {
      site: {
        seasonalNotice: {
          enabled: false,
          showInCart: true,
          text: "Hidden notice"
        }
      }
    };
    YLCart.render();
    eq(seasonalEl.style.display, "none", "Seasonal notice is hidden when enabled is false");
    eq(seasonalEl.innerHTML, "", "Seasonal notice innerHTML is cleared when disabled");

    // 3. showInCart = false
    mockWindow.YL_CONTENT = {
      site: {
        seasonalNotice: {
          enabled: true,
          showInCart: false,
          text: "Header only notice"
        }
      }
    };
    YLCart.render();
    eq(seasonalEl.style.display, "none", "Seasonal notice is hidden when showInCart is false");

    // Clean up
    mockWindow.YL_PRODUCTS = null;
    storage.clear();
    YLCart.init({ force: true });

    console.log(`\ncart.test.js: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error("Async cart test failure:", err);
    process.exit(1);
  }
})();
