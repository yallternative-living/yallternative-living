/**
 * @fileoverview Unit test suite for the order status page (H-6).
 *
 * The page used to answer any plausible-looking string with a confirmed order,
 * a four-step fulfilment timeline, a hardcoded two-item order and a printable
 * packing slip -- none of it fetched from anywhere. These tests hold the
 * honest replacement in place: validate the shape, then hand the visitor a
 * contact route with their reference pre-filled.
 *
 * Tests:
 * 1. Email masking algorithm (maskEmail).
 * 2. Order query validation and parsing (parseOrderStatusQuery).
 * 3. The page answers with the contact route and never asserts an order state.
 * 4. The fabricated timeline, packing slip, sample items and reorder are gone.
 * 5. Only a well-formed ?session_id= pre-fills, and nothing auto-submits.
 * 6. content.json's enableOrderStatusLookup actually gates the page.
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

console.log("Running Order Status Engine Unit Tests (H-6)...\n");

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

// 3. Test DOM Order Status Page Controller: honest contact flow only
console.log("\n  --- 3. Testing Order Status Page Lifecycle (no fabricated order) ---");
const form = mockDocument.getElementById("orderStatusPageForm");
const input = mockDocument.getElementById("orderQueryInput");
const timeline = mockDocument.getElementById("orderTimelineContainer");
const resultSection = mockDocument.getElementById("orderStatusResultSection");

// Run init
main.initOrderStatusPage();

// Test submit with a valid Stripe session id
input.value = "cs_live_999888777";
form.dispatchEvent({ type: "submit", preventDefault() {} });

assert.ok(
  timeline.innerHTML.includes("order-lookup-unavailable"),
  "Valid-looking reference still renders the contact route, not a status"
);
assert.ok(
  timeline.innerHTML.includes("cs_live_999888777"),
  "The reference the visitor typed is echoed back to them"
);
assert.strictEqual(resultSection.hidden, false, "Result section is revealed");
assert.ok(timeline.innerHTML.includes("within one business day"), "States the human reply window");
assert.ok(
  timeline.innerHTML.includes("mailto:y.allternative.living@gmail.com?subject="),
  "Contact link pre-fills a mail subject"
);
assert.ok(
  timeline.innerHTML.includes(encodeURIComponent("Order status: cs_live_999888777")),
  "The reference is pre-filled into the mail subject"
);

// H-6: nothing about a confirmed order, its contents or its progress may be
// asserted -- no request is ever made, so every one of these was invented.
const FABRICATIONS = [
  "Order Confirmed",
  "In the Workshop",
  "Quality Sealed",
  "USPS Carrier Dispatch",
  "order-status-card",
  "timeline-step",
  "Frankincense",
  "frankincense-salve",
  "miracle-balm",
  "Small-Batch Prep",
  "Standard Tracked Shipping"
];
FABRICATIONS.forEach((needle) => {
  assert.strictEqual(
    timeline.innerHTML.includes(needle),
    false,
    `Order status page must not fabricate "${needle}"`
  );
});
assert.strictEqual(
  /\$\d/.test(timeline.innerHTML),
  false,
  "Order status page quotes no prices for an order it never fetched"
);
console.log("  ✓ Lookup renders only the honest contact route, with the reference pre-filled");

// 4. The fabricated order furniture is gone from main.js and the page
console.log("\n  --- 4. Testing removal of the invented order, slip and reorder ---");
const fs = require("fs");
const path = require("path");
const repoRoot = path.resolve(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(repoRoot, "assets/js/main.js"), "utf8");
["sampleOrderItems", "slipItemsTableBody", "slipGiftMessageText", "reorderPastOrderBtn"].forEach(
  (needle) => {
    assert.strictEqual(
      mainSrc.includes(needle),
      false,
      `main.js must no longer reference ${needle}`
    );
  }
);
const orderStatusHtml = fs.readFileSync(path.join(repoRoot, "order-status.html"), "utf8");
["packingSlipContainer", "printPackingSlipBtn", "reorderPastOrderBtn", "orderVerifyInput"].forEach(
  (needle) => {
    assert.strictEqual(
      orderStatusHtml.includes(needle),
      false,
      `order-status.html must no longer contain ${needle}`
    );
  }
);
assert.strictEqual(
  /onclick=/.test(orderStatusHtml),
  false,
  "order-status.html carries no inline event handler (the CSP blocks them)"
);
assert.strictEqual(
  (orderStatusHtml.match(/<!--YL:/g) || []).length,
  (orderStatusHtml.match(/<!--\/YL:/g) || []).length,
  "order-status.html build markers stay paired"
);
console.log("  ✓ Fabricated timeline, packing slip, sample items and reorder are gone");

// 5. Query parameters: only session_id may pre-fill, and nothing auto-submits
console.log("\n  --- 5. Testing URL parameter handling ---");
function freshPageWith(search) {
  Object.keys(elementCache).forEach((k) => delete elementCache[k]);
  mockWindow.location.search = search;
  main.initOrderStatusPage();
  return {
    input: mockDocument.getElementById("orderQueryInput"),
    timeline: mockDocument.getElementById("orderTimelineContainer"),
    result: mockDocument.getElementById("orderStatusResultSection")
  };
}

let ctx = freshPageWith("?email=customer%40example.com");
assert.strictEqual(ctx.input.value, undefined, "?email= never reaches the input (PII reflection)");
assert.strictEqual(ctx.timeline.innerHTML, "", "?email= never runs a lookup");

ctx = freshPageWith("?q=YL-2026-0842");
assert.strictEqual(ctx.input.value, undefined, "?q= does not pre-fill");
assert.strictEqual(ctx.timeline.innerHTML, "", "?q= never runs a lookup");

ctx = freshPageWith("?session_id=cs_live_abc123");
assert.strictEqual(ctx.input.value, "cs_live_abc123", "?session_id= pre-fills the input");
assert.strictEqual(ctx.timeline.innerHTML, "", "?session_id= pre-fills but never auto-submits");

ctx = freshPageWith("?session_id=%3Cimg%20src%3Dx%20onerror%3D1%3E");
assert.strictEqual(ctx.input.value, undefined, "A malformed session_id is refused outright");
mockWindow.location.search = "";
console.log("  ✓ Only a well-formed ?session_id= pre-fills, and nothing auto-submits");

// 6. The CMS switch actually gates the page
console.log("\n  --- 6. Testing enableOrderStatusLookup gate ---");
assert.strictEqual(typeof main.siteFlagEnabled, "function", "siteFlagEnabled must be exported");
assert.strictEqual(
  main.siteFlagEnabled("enableOrderStatusLookup"),
  true,
  "An absent flag defaults to on"
);
mockWindow.YL_CONTENT = { site: { enableOrderStatusLookup: false } };
assert.strictEqual(
  main.siteFlagEnabled("enableOrderStatusLookup"),
  false,
  "siteFlagEnabled reads window.YL_CONTENT.site"
);
Object.keys(elementCache).forEach((k) => delete elementCache[k]);
main.initOrderStatusPage();
const gatedCard = mockDocument.getElementById("orderStatusLookupCard");
const gatedTimeline = mockDocument.getElementById("orderTimelineContainer");
const gatedForm = mockDocument.getElementById("orderStatusPageForm");
assert.strictEqual(gatedCard.hidden, true, "Lookup form is hidden when the switch is off");
assert.ok(
  gatedTimeline.innerHTML.includes("y.allternative.living@gmail.com"),
  "The contact route is shown in its place"
);
mockDocument.getElementById("orderQueryInput").value = "YL-2026-0842";
gatedForm.dispatchEvent({ type: "submit", preventDefault() {} });
assert.strictEqual(
  gatedTimeline.innerHTML.includes("YL-2026-0842"),
  false,
  "The form is not wired at all when the switch is off"
);
mockWindow.YL_CONTENT = undefined;
console.log("  ✓ enableOrderStatusLookup gates the page section");

// 7. Escaping of whatever the visitor typed
console.log("\n  --- 7. Testing escaping of the echoed reference ---");
Object.keys(elementCache).forEach((k) => delete elementCache[k]);
main.initOrderStatusPage();
const xssInput = mockDocument.getElementById("orderQueryInput");
const xssTimeline = mockDocument.getElementById("orderTimelineContainer");
xssInput.value = '<img src=x onerror="alert(1)">';
mockDocument
  .getElementById("orderStatusPageForm")
  .dispatchEvent({ type: "submit", preventDefault() {} });
assert.strictEqual(
  xssTimeline.innerHTML.includes("<img"),
  false,
  "A markup payload in the reference is escaped, not rendered"
);
assert.ok(xssTimeline.innerHTML.includes("&lt;img"), "...and is shown escaped");
console.log("  ✓ The echoed reference is escaped");

console.log("\nAll order-status-engine unit tests passed successfully!\n");
