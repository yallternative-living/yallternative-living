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
    addEventListener: () => {},
    removeEventListener: () => {},
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

// Add an item using YLCart.addCustomBox (which triggers save)
YLCart.addCustomBox({ productIds: ["p1", "p2"], price: 30 });
eq(YLCart.items().length, 2, "addCustomBox adds to items");
const savedData = JSON.parse(storage.get("yl-cart-v1"));
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
  footHTML.includes("unlocked free shipping"),
  "freeShipThreshold falls back to 40 when YL_PRODUCTS is absent ($50 cart qualifies)"
);

// Configured: 75 leaves $25 to go, so the copy must switch to the shortfall
// message AND name the exact remaining amount.
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 75 } };
footHTML = drawerFootHTML();
assert(
  footHTML.includes("Add $25.00 for free shipping"),
  "freeShipThreshold uses configured 75 (a $50 cart is $25.00 short)"
);
assert(
  !footHTML.includes("unlocked free shipping"),
  "freeShipThreshold does not report free shipping unlocked below the configured threshold"
);

// A configured threshold the $50 cart clears must flip the copy back, proving
// the helper tracks the config rather than latching onto one branch.
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 30 } };
footHTML = drawerFootHTML();
assert(
  footHTML.includes("unlocked free shipping"),
  "freeShipThreshold uses configured 30 (a $50 cart qualifies)"
);

// Regression pin for the actual bug: the OLD implementation read
// window.YL_FREE_SHIP. Setting only that global must now change nothing --
// this assertion is what fails if the helper is reverted to the old source.
delete mockWindow.YL_PRODUCTS;
mockWindow.YL_FREE_SHIP = 500;
footHTML = drawerFootHTML();
assert(
  footHTML.includes("unlocked free shipping"),
  "freeShipThreshold ignores the stale YL_FREE_SHIP global (reads products.json config only)"
);
assert(
  !footHTML.includes("Add $450.00 for free shipping"),
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
  !footHTML.includes("free shipping") && !footHTML.includes("yl-cart-ship"),
  "drawer drops the free-shipping meter entirely when the threshold is 0 (disabled)"
);
assert(footHTML.includes("Subtotal"), "drawer still renders its subtotal with free shipping off");

// Genuinely unusable values fall back to 40 rather than rendering NaN copy.
for (const bad of ["not-a-number", null, undefined, ""]) {
  mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: bad } };
  footHTML = drawerFootHTML();
  assert(
    footHTML.includes("unlocked free shipping") && !footHTML.includes("NaN"),
    `drawer falls back to the default threshold for unusable value ${JSON.stringify(bad)}`
  );
}

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

mockWindow.YL_PRODUCTS = null;

storage.clear();
YLCart.init({ force: true });

console.log(`\ncart.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
