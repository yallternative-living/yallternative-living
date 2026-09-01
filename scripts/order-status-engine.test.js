/**
 * @fileoverview Unit test suite for Milestone 6: Self-Service Order Status &
 * Fulfillment Packing Slips.
 *
 * Tests:
 * 1. Email masking algorithm (maskEmail).
 * 2. Order query validation and parsing (parseOrderStatusQuery).
 * 3. Dedicated order status page lifecycle, DOM progression timeline, and 1-click reorder.
 * 4. Printable fulfillment packing slip invariant: Prominent gift message + strictly ZERO prices.
 *
 * Run: node scripts/order-status-engine.test.js
 */

"use strict";

const assert = require("assert");

// Setup mock storage and elements
const storage = new Map();
const mockLocalStorage = {
  getItem: (k) => storage.get(k) || null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear()
};

function createMockElement(tagName) {
  tagName = tagName || "div";
  const attrs = new Map();
  const children = [];
  const eventListeners = {};
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    setAttribute: (name, val) => attrs.set(name, String(val)),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    style: {},
    classList: {
      _list: new Set(),
      add: function () {
        for (let i = 0; i < arguments.length; i++) this._list.add(arguments[i]);
      },
      remove: function () {
        for (let i = 0; i < arguments.length; i++) this._list.delete(arguments[i]);
      },
      contains: function (name) {
        return this._list.has(name);
      },
      toggle: function (name, force) {
        if (force === undefined) {
          if (this._list.has(name)) this._list.delete(name);
          else this._list.add(name);
        } else if (force) {
          this._list.add(name);
        } else {
          this._list.delete(name);
        }
      }
    },
    textContent: "",
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(val) {
      this._innerHTML = val;
      this.textContent = val.replace(/<[^>]*>/g, "");
    },
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    addEventListener: (evt, fn) => {
      if (!eventListeners[evt]) eventListeners[evt] = [];
      eventListeners[evt].push(fn);
    },
    dispatchEvent: function (evt) {
      if (evt.type === "click" && typeof this.onclick === "function") this.onclick(evt);
      if (evt.type === "submit" && typeof this.onsubmit === "function") this.onsubmit(evt);
      const fns = eventListeners[evt.type] || [];
      fns.forEach((fn) => fn(evt));
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => [],
    hidden: false
  };
  return el;
}

const elementCache = {};

const mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: (id) => {
    if (!elementCache[id]) {
      elementCache[id] = createMockElement("div");
      elementCache[id].id = id;
    }
    return elementCache[id];
  },
  querySelector: () => createMockElement("div"),
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {},
  removeEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  location: { hash: "", search: "", href: "https://yallternativeliving.com/order-status.html" },
  addEventListener: () => {},
  removeEventListener: () => {},
  YL_PRODUCTS: {
    categories: ["all", "salves", "body"],
    products: [
      {
        id: "frankincense-salve",
        name: "Y'all Heal Now Miracle Frankincense Salve",
        price: 19.99,
        inStock: true
      },
      { id: "miracle-balm", name: "Y'allternative Miracle Balm", price: 8.0, inStock: true }
    ]
  },
  YLCart: {
    items: [],
    isOpen: false,
    addItem(it) {
      this.items.push(it);
    },
    addItems(its) {
      this.items.push(...its);
    },
    open() {
      this.isOpen = true;
    }
  }
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;

console.log("Running Order Status & Packing Slip Engine Unit Tests (Milestone 6)...\n");

const main = require("./../assets/js/main.js");

// 1. Test maskEmail helper
console.log("  --- 1. Testing maskEmail Helper ---");
assert.strictEqual(typeof main.maskEmail, "function", "maskEmail helper must be exported");
assert.strictEqual(
  main.maskEmail("savanna@example.com"),
  "s***a@e***e.com",
  "Properly masks standard email"
);
assert.strictEqual(
  main.maskEmail("j@domain.org"),
  "j*@d***n.org",
  "Properly masks single letter username"
);
assert.strictEqual(
  main.maskEmail("invalid-email"),
  "invalid-email",
  "Handles malformed email gracefully"
);
console.log("  ✓ maskEmail masks user and domain while preserving TLD structure");

// 2. Test parseOrderStatusQuery
console.log("\n  --- 2. Testing parseOrderStatusQuery Helper ---");
assert.strictEqual(
  typeof main.parseOrderStatusQuery,
  "function",
  "parseOrderStatusQuery must be exported"
);

const sessionRes = main.parseOrderStatusQuery("cs_live_1234567890abcdef_secret");
assert.ok(sessionRes, "Session ID query must be recognized");
assert.strictEqual(sessionRes.isSessionId, true, "isSessionId flag is true");
assert.strictEqual(sessionRes.isEmail, false, "isEmail flag is false");

const orderRes = main.parseOrderStatusQuery("YL-2026-0814");
assert.ok(orderRes, "Order Reference query must be recognized");
assert.strictEqual(orderRes.isOrderRef, true, "isOrderRef flag is true");

const emailRes = main.parseOrderStatusQuery("customer@test.com");
assert.ok(emailRes, "Email query must be recognized");
assert.strictEqual(emailRes.isEmail, true, "isEmail flag is true");
assert.strictEqual(emailRes.displayId, "c***r@t***t.com", "displayId is masked for emails");

const invalidRes = main.parseOrderStatusQuery("random_text_123");
assert.strictEqual(invalidRes, null, "Unrecognized strings return null");
const emptyRes = main.parseOrderStatusQuery("");
assert.strictEqual(emptyRes, null, "Empty query returns null");
console.log("  ✓ parseOrderStatusQuery accurately validates and categorizes lookup tokens");

// 3. Test DOM Order Status Page Controller & Timeline Rendering
console.log("\n  --- 3. Testing Order Status Page Lifecycle & Progression Timeline ---");
const form = mockDocument.getElementById("orderStatusPageForm");
const input = mockDocument.getElementById("orderQueryInput");
const timeline = mockDocument.getElementById("orderTimelineContainer");
const itemsList = mockDocument.getElementById("orderItemsList");
const itemsContainer = mockDocument.getElementById("orderItemsContainer");
const slipTableBody = mockDocument.getElementById("slipItemsTableBody");
const packingSlip = mockDocument.getElementById("packingSlipContainer");

// Run init
main.initOrderStatusPage();

// Test submit with valid Stripe session
input.value = "cs_live_999888777";
form.dispatchEvent({ type: "submit", preventDefault() {} });

assert.ok(
  timeline.innerHTML.includes("order-status-card"),
  "Timeline container renders order status card"
);
assert.ok(
  timeline.innerHTML.includes("Order Confirmed"),
  "Timeline contains 'Order Confirmed' step"
);
assert.ok(
  timeline.innerHTML.includes("In the Workshop"),
  "Timeline contains 'In the Workshop' step"
);
assert.ok(
  timeline.innerHTML.includes("Quality Sealed &amp; Packaged") ||
    timeline.innerHTML.includes("Quality Sealed & Packaged"),
  "Timeline contains 'Quality Sealed & Packaged' step"
);
assert.ok(
  timeline.innerHTML.includes("USPS Carrier Dispatch"),
  "Timeline contains 'USPS Carrier Dispatch' step"
);
assert.ok(
  itemsList.innerHTML.includes("frankincense-salve") ||
    itemsList.innerHTML.includes("Frankincense"),
  "Order items list populated"
);
assert.ok(packingSlip, "Packing slip element exists");
assert.strictEqual(itemsContainer.hidden, false, "Order items container is visible");
console.log("  ✓ Valid order lookup renders 4-step fulfillment timeline and itemized breakdown");

// 4. Test 1-Click Reorder Action
console.log("\n  --- 4. Testing 1-Click Reorder Action ---");
const reorderBtn = mockDocument.getElementById("reorderPastOrderBtn");
mockWindow.YLCart.items = [];
reorderBtn.dispatchEvent({ type: "click" });

assert.strictEqual(
  mockWindow.YLCart.items.length,
  2,
  "Reorders both items from past order into active cart"
);
assert.strictEqual(
  mockWindow.YLCart.items[0].id,
  "frankincense-salve",
  "First reordered item is frankincense-salve"
);
assert.strictEqual(
  mockWindow.YLCart.items[1].id,
  "miracle-balm",
  "Second reordered item is miracle-balm"
);
assert.strictEqual(mockWindow.YLCart.isOpen, true, "Cart drawer opened after reorder action");
console.log("  ✓ Reorder Past Order button populates YLCart and opens cart drawer");

// 5. Test Printable Fulfillment Packing Slip Invariants (NO MONETARY AMOUNTS)
console.log("\n  --- 5. Testing Printable Packing Slip View & Security Invariants ---");
assert.ok(
  slipTableBody.innerHTML.includes("salve-frankincense-2oz") ||
    slipTableBody.innerHTML.includes("frankincense-salve"),
  "Packing slip table lists item SKU / ID"
);
assert.ok(
  slipTableBody.innerHTML.includes("packing-checkbox"),
  "Packing slip table includes packing check box"
);

// Assert STRICT INVARIANT: No dollar sign or currency pricing inside the packing slip table body!
assert.strictEqual(
  slipTableBody.innerHTML.includes("$"),
  false,
  "Packing slip table body contains NO dollar signs ($)"
);
assert.strictEqual(
  /\$\d+\.\d{2}/.test(slipTableBody.innerHTML),
  false,
  "Packing slip contains NO monetary amounts"
);
console.log("  ✓ Fulfillment packing slip renders itemized checklist with strictly ZERO prices");

// 6. Test Unknown / Malformed Query Handling
console.log("\n  --- 6. Testing Unknown Lookup Feedback ---");
input.value = "unknown_order_id_xyz";
form.dispatchEvent({ type: "submit", preventDefault() {} });

assert.ok(
  timeline.innerHTML.includes("order-lookup-unavailable"),
  "Renders order-lookup-unavailable notice"
);
assert.ok(
  timeline.innerHTML.includes("y.allternative.living@gmail.com"),
  "Provides direct support email link"
);
assert.strictEqual(itemsContainer.hidden, true, "Items breakdown is hidden for unknown orders");
console.log("  ✓ Unrecognized query renders clear support notice and hides items table");

console.log("\nAll order-status-engine unit tests passed successfully!\n");
