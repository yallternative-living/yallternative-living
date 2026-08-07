/**
 * @fileoverview Unit tests for shared site behavior in assets/js/main.js
 * Run: node scripts/main.test.js
 */
/* global window */

// Mock DOM environment for pure Node execution
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
    innerHTML: "",
    textContent: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const mockDocumentElement = createMockElement("html");
const themeToggleEl = createMockElement("button");
const wishBodyEl = createMockElement("div");

const mockDocument = {
  documentElement: mockDocumentElement,
  getElementById: (id) => {
    if (id === "themeToggle") return themeToggleEl;
    if (id === "wishBody") return wishBodyEl;
    return null;
  },
  querySelector: (sel) => {
    if (sel === "#themeToggle" || sel === ".theme-toggle") return themeToggleEl;
    if (sel === "#wishBody" || sel === ".wish-body") return wishBodyEl;
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel === ".wish-count") return [createMockElement("span")];
    return [];
  },
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  location: {
    href: "https://yallternativeliving.com",
    hash: "",
    search: "",
    pathname: "/",
    hostname: "yallternativeliving.com",
    origin: "https://yallternativeliving.com"
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const main = require("../assets/js/main.js");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

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

console.log("Running main.js unit tests...\n");

/* 1. attrEsc */
eq(
  main.attrEsc("<script>alert('xss & \"foo\"')</script>"),
  "&lt;script&gt;alert(&#39;xss &amp; &quot;foo&quot;&#39;)&lt;/script&gt;",
  "attrEsc escapes special HTML characters"
);
eq(main.attrEsc(null), "", "attrEsc handles null input");
eq(main.attrEsc(undefined), "", "attrEsc handles undefined input");
eq(main.attrEsc(123), "123", "attrEsc handles numeric input");
eq(main.attrEsc(0), "0", "attrEsc handles zero (falsy number)");
eq(main.attrEsc(true), "true", "attrEsc handles boolean input");
eq(main.attrEsc(false), "false", "attrEsc handles false (falsy boolean)");
eq(
  main.attrEsc({ toString: () => '<b>"x"</b>' }),
  "&lt;b&gt;&quot;x&quot;&lt;/b&gt;",
  "attrEsc coerces and escapes non-string objects"
);
eq(main.attrEsc(["<a>", "<b>"]), "&lt;a&gt;,&lt;b&gt;", "attrEsc coerces and escapes arrays");
eq(main.attrEsc("Clean String"), "Clean String", "attrEsc leaves clean string unchanged");

/* 1b. safeUrl */
eq(
  main.safeUrl("https://example.com/rsvp"),
  "https://example.com/rsvp",
  "safeUrl allows https URLs"
);
eq(main.safeUrl("http://example.com"), "http://example.com", "safeUrl allows http URLs");
eq(main.safeUrl("/local/path"), "/local/path", "safeUrl allows root-relative paths");
eq(main.safeUrl("javascript:alert(1)"), "", "safeUrl rejects javascript: URLs");
eq(main.safeUrl("data:text/html,evil"), "", "safeUrl rejects data: URLs");
eq(main.safeUrl(""), "", "safeUrl handles empty string");
eq(main.safeUrl(null), "", "safeUrl handles null input");

/* 2. pickFeatured */
const sampleProducts = [
  { id: "salve-1", featured: true },
  { id: "salve-2", featured: false },
  { id: "soak-1", featured: true }
];
eq(main.pickFeatured(sampleProducts).length, 2, "pickFeatured filters featured items");
eq(main.pickFeatured([{ id: "a", featured: false }]), [], "pickFeatured handles no featured items");
eq(main.pickFeatured([]), [], "pickFeatured handles empty array");

/* 3. addToCartHTML */
const giftCard = { id: "yallternative-gift-card" };
assert(
  main.addToCartHTML(giftCard).includes('href="#gift-cards"'),
  "addToCartHTML special-cases gift cards"
);

const soldOut = { id: "salve-1", name: "Salve", price: 15, stock: 0 };
assert(main.addToCartHTML(soldOut).includes("Sold Out"), "addToCartHTML handles sold out items");
assert(main.addToCartHTML(soldOut).includes("disabled"), "addToCartHTML disables sold out button");
assert(
  main.addToCartHTML(soldOut).includes("yl-notify-toggle"),
  "addToCartHTML includes notify button for sold out items"
);
assert(
  main.addToCartHTML(soldOut).includes("Notify Me When Back in Stock"),
  "addToCartHTML includes correct notify button label for sold out items"
);

const comingSoon = { id: "salve-1", name: "Salve", price: 15, comingSoon: true };
assert(
  main.addToCartHTML(comingSoon).includes("Coming Soon"),
  "addToCartHTML handles coming soon items"
);
assert(
  main.addToCartHTML(comingSoon).includes("yl-notify-toggle"),
  "addToCartHTML includes notify button for coming soon items"
);
assert(
  main.addToCartHTML(comingSoon).includes("Notify Me When Back in Stock"),
  "addToCartHTML includes correct notify button label for coming soon items"
);

// Gated with enableRestockAlerts === false
window.YL_CONTENT = { site: { enableRestockAlerts: false } };
assert(
  !main.addToCartHTML(soldOut).includes("yl-notify-toggle"),
  "addToCartHTML hides notify button when enableRestockAlerts is false (sold out)"
);
assert(
  !main.addToCartHTML(comingSoon).includes("yl-notify-toggle"),
  "addToCartHTML hides notify button when enableRestockAlerts is false (coming soon)"
);
window.YL_CONTENT = { site: { enableRestockAlerts: true } };

const cappedStock = { id: "salve-1", name: "Salve", price: 15.5, stock: 4 };
assert(
  main.addToCartHTML(cappedStock).includes('data-item-max-quantity="4"'),
  "addToCartHTML attaches stock limit"
);

const withVariants = {
  id: "tshirt",
  name: "T-Shirt",
  price: 25.0,
  variants: {
    name: "Size",
    options: [
      { label: "S", priceDelta: 0 },
      { label: "M", priceDelta: 2.5 }
    ]
  }
};
const variantHTML = main.addToCartHTML(withVariants);
assert(
  variantHTML.includes('data-item-custom1-name="Size"'),
  "addToCartHTML includes variant name"
);
assert(variantHTML.includes("S[+0.00]|M[+2.50]"), "addToCartHTML formats variant options");

/* 4. applyTheme & currentTheme */
main.applyTheme("dark");
eq(main.currentTheme(), "dark", "applyTheme sets dark theme");
eq(mockDocumentElement.getAttribute("data-theme"), "dark", "applyTheme sets document data-theme");

main.applyTheme("light");
eq(main.currentTheme(), "light", "applyTheme sets light theme");
eq(mockDocumentElement.getAttribute("data-theme"), "light", "applyTheme sets document data-theme");

/* 5. getWishlist, saveWishlist, toggleWish */
mockLocalStorage.clear();
main._resetState();
eq(main.getWishlist(), [], "getWishlist returns empty array initially");

main.saveWishlist(["item-1", "item-2"]);
eq(main.getWishlist(), ["item-1", "item-2"], "saveWishlist persists wishlist items");

main.toggleWish("item-3");
eq(main.getWishlist(), ["item-1", "item-2", "item-3"], "toggleWish adds item when absent");

main.toggleWish("item-1");
eq(main.getWishlist(), ["item-2", "item-3"], "toggleWish removes item when present");

main.saveWishlist("invalid-input");
eq(main.getWishlist(), [], "saveWishlist normalizes non-array input");

mockLocalStorage.setItem("yl-wishlist", "invalid-json{");
main._resetState();
eq(main.getWishlist(), [], "getWishlist handles invalid JSON gracefully");

/* 5b. isWished */
mockLocalStorage.clear();
main._resetState();
main.saveWishlist(["salve-1", "soak-2"]);
assert(main.isWished("salve-1"), "isWished returns true for a saved item");
assert(main.isWished("soak-2"), "isWished returns true for another saved item");
assert(!main.isWished("not-saved"), "isWished returns false for an unsaved item");
main.toggleWish("salve-1");
assert(!main.isWished("salve-1"), "isWished reflects removal after toggleWish");
main.toggleWish("brand-new");
assert(main.isWished("brand-new"), "isWished reflects addition after toggleWish");

/* 6. renderWishDrawer */
mockLocalStorage.clear();
main._resetState();
main.renderWishDrawer();
assert(
  wishBodyEl.innerHTML.includes("wish-empty") || wishBodyEl.innerHTML.includes("empty"),
  "renderWishDrawer handles empty wishlist state"
);

console.log(`\nmain.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
