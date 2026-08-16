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

console.log(`\ncart.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
