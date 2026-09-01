/**
 * @fileoverview Speculative Hover Prefetching Controller Unit Test Suite (M3)
 * Tests universal hover intent debouncing (65ms), Speculation Rules API injection,
 * link[rel=prefetch] fallback, connection speed guards (saveData / 2g / 3g),
 * same-origin candidate filtering, and prefetch URL deduplication.
 *
 * Run: node scripts/prefetch.test.js
 */

const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Mock element creator
function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    setAttribute: function (name, val) {
      attrs.set(name, String(val));
      this[name] = String(val);
    },
    getAttribute: function (name) {
      return attrs.has(name)
        ? attrs.get(name)
        : this[name] !== undefined
          ? String(this[name])
          : null;
    },
    removeAttribute: function (name) {
      attrs.delete(name);
      delete this[name];
    },
    hasAttribute: function (name) {
      return attrs.has(name) || this[name] !== undefined;
    },
    style: {},
    children,
    childNodes: children,
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
    innerHTML: "",
    textContent: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: function (child) {
      children.push(child);
      return child;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => [],
    closest: function (selector) {
      if (selector === "a[href]" && this.tagName === "A" && this.hasAttribute("href")) {
        return this;
      }
      return null;
    }
  };
  return el;
}

const mockHead = createMockElement("head");
const mockDocument = {
  documentElement: createMockElement("html"),
  head: mockHead,
  body: createMockElement("body"),
  createElement: (tag) => createMockElement(tag),
  getElementById: () => createMockElement("div"),
  querySelector: () => createMockElement("div"),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  location: {
    origin: "https://yallternativeliving.com",
    pathname: "/shop.html",
    search: "",
    href: "https://yallternativeliving.com/shop.html"
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockWindow.localStorage;

const connectionState = {
  saveData: false,
  effectiveType: "4g"
};

try {
  Object.defineProperty(global.navigator, "connection", {
    value: connectionState,
    writable: true,
    configurable: true
  });
} catch {
  global.navigator = {
    userAgent: "node",
    connection: connectionState
  };
}

global.HTMLScriptElement = {
  supports: (feat) => feat === "speculationrules"
};

// Load search index
require(path.join(ROOT, "assets", "js", "search-data.js"));

const mainJs = require(path.join(ROOT, "assets", "js", "main.js"));

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

console.log("Running Speculative Hover Prefetching Controller tests...\n");

// --- SECTION 1: Controller Initialization & API ---
console.log("--- 1. Prefetch Controller Interface ---");

it("mainJs exports initHoverPrefetch", () => {
  assert.strictEqual(typeof mainJs.initHoverPrefetch, "function");
});

it("initHoverPrefetch initializes and returns complete control interface", () => {
  const controller = mainJs.initHoverPrefetch();
  assert.ok(controller, "controller must be returned");
  assert.strictEqual(typeof controller.prefetchUrl, "function");
  assert.strictEqual(typeof controller.getPrefetchedUrls, "function");
  assert.strictEqual(typeof controller.isPrefetched, "function");
  assert.strictEqual(typeof controller.clearPrefetchCache, "function");
  assert.strictEqual(typeof controller._canPrefetch, "function");
  assert.strictEqual(typeof controller._getCleanCandidateUrl, "function");
});

// --- SECTION 2: URL Candidate Validation & Filtering ---
console.log("\n--- 2. URL Candidate Validation & Filtering ---");

it("accepts valid internal same-origin links", () => {
  const controller = mainJs.initHoverPrefetch();
  const validLink = createMockElement("a");
  validLink.setAttribute("href", "/products/sleep-salve.html");
  validLink.href = "https://yallternativeliving.com/products/sleep-salve.html";

  const candidate = controller._getCleanCandidateUrl(validLink);
  assert.strictEqual(candidate, "/products/sleep-salve.html");
});

it("rejects current active page (prevents self-prefetch loop)", () => {
  const controller = mainJs.initHoverPrefetch();
  const selfLink = createMockElement("a");
  selfLink.setAttribute("href", "/shop.html");
  selfLink.href = "https://yallternativeliving.com/shop.html";

  assert.strictEqual(controller._getCleanCandidateUrl(selfLink), null);
});

it("rejects external domains", () => {
  const controller = mainJs.initHoverPrefetch();
  const externalLink = createMockElement("a");
  externalLink.setAttribute("href", "https://instagram.com/yallternativeliving");
  externalLink.href = "https://instagram.com/yallternativeliving";

  assert.strictEqual(controller._getCleanCandidateUrl(externalLink), null);
});

it("rejects anchor hash jumps, javascript:, mailto:, and tel: schemes", () => {
  const controller = mainJs.initHoverPrefetch();

  const hashLink = createMockElement("a");
  hashLink.setAttribute("href", "#reviews");
  assert.strictEqual(controller._getCleanCandidateUrl(hashLink), null);

  const jsLink = createMockElement("a");
  jsLink.setAttribute("href", "javascript:void(0)");
  assert.strictEqual(controller._getCleanCandidateUrl(jsLink), null);

  const mailLink = createMockElement("a");
  mailLink.setAttribute("href", "mailto:howdy@yallternativeliving.com");
  assert.strictEqual(controller._getCleanCandidateUrl(mailLink), null);

  const telLink = createMockElement("a");
  telLink.setAttribute("href", "tel:8645551234");
  assert.strictEqual(controller._getCleanCandidateUrl(telLink), null);
});

it("rejects links with rel='nofollow', download, or data-no-prefetch attributes", () => {
  const controller = mainJs.initHoverPrefetch();

  const nofollowLink = createMockElement("a");
  nofollowLink.setAttribute("href", "/policies.html");
  nofollowLink.setAttribute("rel", "nofollow");
  nofollowLink.href = "https://yallternativeliving.com/policies.html";
  assert.strictEqual(controller._getCleanCandidateUrl(nofollowLink), null);

  const downloadLink = createMockElement("a");
  downloadLink.setAttribute("href", "/assets/doc.pdf");
  downloadLink.setAttribute("download", "");
  downloadLink.href = "https://yallternativeliving.com/assets/doc.pdf";
  assert.strictEqual(controller._getCleanCandidateUrl(downloadLink), null);

  const noPrefetchLink = createMockElement("a");
  noPrefetchLink.setAttribute("href", "/events.html");
  noPrefetchLink.setAttribute("data-no-prefetch", "true");
  noPrefetchLink.href = "https://yallternativeliving.com/events.html";
  assert.strictEqual(controller._getCleanCandidateUrl(noPrefetchLink), null);
});

it("rejects backend API, admin, and serverless paths", () => {
  const controller = mainJs.initHoverPrefetch();

  const apiLink = createMockElement("a");
  apiLink.setAttribute("href", "/api/checkout");
  apiLink.href = "https://yallternativeliving.com/api/checkout";
  assert.strictEqual(controller._getCleanCandidateUrl(apiLink), null);

  const adminLink = createMockElement("a");
  adminLink.setAttribute("href", "/admin/#/collections");
  adminLink.href = "https://yallternativeliving.com/admin/#/collections";
  assert.strictEqual(controller._getCleanCandidateUrl(adminLink), null);
});

// --- SECTION 3: Network & Data-Saver Invariants ---
console.log("\n--- 3. Network & Data-Saver Constraints ---");

it("blocks prefetch when navigator.connection.saveData === true", () => {
  connectionState.saveData = true;
  connectionState.effectiveType = "4g";
  const controller = mainJs.initHoverPrefetch();

  assert.strictEqual(controller._canPrefetch(), false);
  assert.strictEqual(controller.prefetchUrl("/products/miracle-balm.html"), false);
  connectionState.saveData = false;
});

it("blocks prefetch on slow network conditions (2g / 3g / slow-2g)", () => {
  const controller = mainJs.initHoverPrefetch();

  connectionState.effectiveType = "2g";
  assert.strictEqual(controller._canPrefetch(), false);

  connectionState.effectiveType = "slow-2g";
  assert.strictEqual(controller._canPrefetch(), false);

  connectionState.effectiveType = "3g";
  assert.strictEqual(controller._canPrefetch(), false);

  connectionState.effectiveType = "4g";
  assert.strictEqual(controller._canPrefetch(), true);
});

// --- SECTION 4: DOM Injection & Deduplication ---
console.log("\n--- 4. DOM Injection & Deduplication ---");

it("injects Speculation Rules script when supported by browser", () => {
  mockHead.children.length = 0;
  global.HTMLScriptElement.supports = (feat) => feat === "speculationrules";
  const controller = mainJs.initHoverPrefetch();
  controller.clearPrefetchCache();

  const success = controller.prefetchUrl("/products/frankincense-salve.html");
  assert.strictEqual(success, true);
  assert.strictEqual(controller.isPrefetched("/products/frankincense-salve.html"), true);

  const scriptTag = mockHead.children.find((el) => el.getAttribute("type") === "speculationrules");
  assert.ok(scriptTag, "Must inject script with type='speculationrules'");
  const parsed = JSON.parse(scriptTag.textContent);
  assert.ok(Array.isArray(parsed.prefetch), "speculationrules must include prefetch array");
  assert.deepStrictEqual(parsed.prefetch[0].urls, ["/products/frankincense-salve.html"]);
});

it("falls back to <link rel='prefetch'> when Speculation Rules API is not supported", () => {
  mockHead.children.length = 0;
  global.HTMLScriptElement.supports = () => false;
  const controller = mainJs.initHoverPrefetch();
  controller.clearPrefetchCache();

  const success = controller.prefetchUrl("/products/bath-tea.html");
  assert.strictEqual(success, true);

  const linkTag = mockHead.children.find((el) => el.getAttribute("rel") === "prefetch");
  assert.ok(linkTag, "Must inject <link rel='prefetch'>");
  assert.strictEqual(linkTag.getAttribute("href"), "/products/bath-tea.html");
  assert.strictEqual(linkTag.getAttribute("as"), "document");
});

it("deduplicates requests: multiple prefetch calls for the same URL execute once", () => {
  mockHead.children.length = 0;
  const controller = mainJs.initHoverPrefetch();
  controller.clearPrefetchCache();

  const firstCall = controller.prefetchUrl("/products/lavender-soak.html");
  const secondCall = controller.prefetchUrl("/products/lavender-soak.html");
  const thirdCall = controller.prefetchUrl("/products/lavender-soak.html");

  assert.strictEqual(firstCall, true, "First prefetch must succeed");
  assert.strictEqual(secondCall, false, "Second duplicate prefetch must be ignored");
  assert.strictEqual(thirdCall, false, "Third duplicate prefetch must be ignored");

  const urls = controller.getPrefetchedUrls();
  assert.strictEqual(urls.filter((u) => u === "/products/lavender-soak.html").length, 1);
});

it("clearPrefetchCache resets the prefetched set cleanly", () => {
  const controller = mainJs.initHoverPrefetch();
  controller.prefetchUrl("/products/shimmer-oil.html");
  assert.strictEqual(controller.isPrefetched("/products/shimmer-oil.html"), true);

  controller.clearPrefetchCache();
  assert.strictEqual(controller.isPrefetched("/products/shimmer-oil.html"), false);
  assert.strictEqual(controller.getPrefetchedUrls().length, 0);
});

console.log(`\n==================================================`);
console.log(`Prefetch Tests: ${passed} passed, ${failed} failed.`);
console.log(`==================================================\n`);

if (failed > 0) {
  process.exit(1);
}
