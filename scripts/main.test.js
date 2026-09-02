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
  let _hidden = false;
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    get hidden() {
      return _hidden || attrs.has("hidden");
    },
    set hidden(val) {
      _hidden = !!val;
      if (val) attrs.set("hidden", "");
      else attrs.delete("hidden");
    },
    setAttribute: (name, val) => {
      attrs.set(name, String(val));
      if (name === "hidden") _hidden = true;
    },
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => {
      attrs.delete(name);
      if (name === "hidden") _hidden = false;
    },
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
    get className() {
      return Array.from(this.classList._list).join(" ");
    },
    set className(val) {
      this.classList._list = new Set(String(val).split(/\s+/).filter(Boolean));
    },
    get href() {
      return attrs.get("href") || "";
    },
    set href(val) {
      attrs.set("href", String(val));
    },
    _innerHTML: "",
    get innerHTML() {
      if (children.length > 0) {
        return children
          .map((c) => {
            if (c.tagName === "A") {
              return `<a href="${c.getAttribute("href") || c.href || ""}">${c.textContent || c.innerHTML}</a>`;
            }
            return c.innerHTML || c.textContent || "";
          })
          .join("");
      }
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
    dispatchEvent: function (evt) {
      const fns = this._listeners[evt.type] || [];
      fns.forEach((fn) => fn(evt));
    },
    closest: function (sel) {
      if (
        sel === "#quiz-submit-btn" &&
        (this.id === "quiz-submit-btn" ||
          (this.attributes && this.attributes.get("id") === "quiz-submit-btn"))
      )
        return this;
      if (sel === ".quiz-next-step" && this.classList.contains("quiz-next-step")) return this;
      if (sel === ".quiz-prev-step" && this.classList.contains("quiz-prev-step")) return this;
      return null;
    },
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    insertBefore: (newNode) => {
      children.unshift(newNode);
      return newNode;
    },
    get children() {
      return children;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const mockDocumentElement = createMockElement("html");
const themeToggleEl = createMockElement("button");
const wishBodyEl = createMockElement("div");
const recentlyViewedSectionEl = createMockElement("section");
const recentlyViewedTrackEl = createMockElement("div");
const pdpRecentlyViewedSectionEl = createMockElement("section");
const pdpRecentlyViewedTrackEl = createMockElement("div");

recentlyViewedSectionEl.querySelector = (sel) => {
  if (
    sel === ".recently-viewed-track" ||
    sel === "#recentlyViewedTrack" ||
    sel === "#pdpRecentlyViewedTrack"
  ) {
    return recentlyViewedTrackEl;
  }
  return null;
};
pdpRecentlyViewedSectionEl.querySelector = (sel) => {
  if (
    sel === ".recently-viewed-track" ||
    sel === "#recentlyViewedTrack" ||
    sel === "#pdpRecentlyViewedTrack"
  ) {
    return pdpRecentlyViewedTrackEl;
  }
  return null;
};

const elementsById = new Map();
const mockDocument = {
  documentElement: mockDocumentElement,
  getElementById: (id) => {
    if (elementsById.has(id)) return elementsById.get(id);
    if (id === "themeToggle") return themeToggleEl;
    if (id === "wishBody") return wishBodyEl;
    if (id === "recently-viewed-section") {
      return mockDocument.body.classList.contains("pdp-page") ? null : recentlyViewedSectionEl;
    }
    if (id === "recentlyViewedTrack") return recentlyViewedTrackEl;
    if (id === "pdpRecentlyViewedSection") {
      return mockDocument.body.classList.contains("pdp-page") ? pdpRecentlyViewedSectionEl : null;
    }
    if (id === "pdpRecentlyViewedTrack") return pdpRecentlyViewedTrackEl;
    return null;
  },
  querySelector: (sel) => {
    if (sel === "#themeToggle" || sel === ".theme-toggle") return themeToggleEl;
    if (sel === "#wishBody" || sel === ".wish-body") return wishBodyEl;
    if (sel === "#recently-viewed-section" || sel === ".recently-viewed-section") {
      return mockDocument.body.classList.contains("pdp-page") ? null : recentlyViewedSectionEl;
    }
    if (sel === "#pdpRecentlyViewedSection" || sel === ".pdp-recently-viewed-section") {
      return mockDocument.body.classList.contains("pdp-page") ? pdpRecentlyViewedSectionEl : null;
    }
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

/* 1c. safeLinkUrl -- the scheme gate for links typed into a journal post.
   Wider than safeUrl (mailto: and plain relative paths are legitimate in a
   blog post) but it still has to refuse anything that can execute. */
eq(
  main.safeLinkUrl("https://example.com/a?b=1&c=2"),
  "https://example.com/a?b=1&c=2",
  "safeLinkUrl allows https URLs"
);
eq(main.safeLinkUrl("http://example.com"), "http://example.com", "safeLinkUrl allows http URLs");
eq(
  main.safeLinkUrl("mailto:hello@example.com"),
  "mailto:hello@example.com",
  "safeLinkUrl allows mailto links"
);
eq(
  main.safeLinkUrl("shop.html#gift-cards"),
  "shop.html#gift-cards",
  "safeLinkUrl allows a plain relative page link"
);
eq(main.safeLinkUrl("/journal.html"), "/journal.html", "safeLinkUrl allows root-relative paths");
eq(main.safeLinkUrl("#ingredients"), "#ingredients", "safeLinkUrl allows same-page anchors");
eq(main.safeLinkUrl("javascript:alert(1)"), "", "safeLinkUrl rejects javascript: URLs");
eq(
  main.safeLinkUrl("JaVaScRiPt:alert(1)"),
  "",
  "safeLinkUrl rejects javascript: regardless of case"
);
eq(
  main.safeLinkUrl("   javascript:alert(1)"),
  "",
  "safeLinkUrl rejects javascript: hidden behind leading whitespace"
);
eq(
  main.safeLinkUrl("java\tscript:alert(1)"),
  "",
  "safeLinkUrl rejects javascript: split by a tab (browsers strip it before parsing)"
);
eq(main.safeLinkUrl("data:text/html,<h1>x</h1>"), "", "safeLinkUrl rejects data: URLs");
eq(main.safeLinkUrl("vbscript:msgbox(1)"), "", "safeLinkUrl rejects vbscript: URLs");
eq(main.safeLinkUrl(""), "", "safeLinkUrl handles empty string");
eq(main.safeLinkUrl(null), "", "safeLinkUrl handles null input");

/* 1d. renderMarkdown -- the journal post body renderer.
   It writes straight into innerHTML, so the security cases below matter more
   than the breadth of Markdown supported. */

// --- backward compatibility: content containing no Markdown at all must
// produce byte-for-byte the same HTML the pre-Markdown renderer did, so a
// post written as plain paragraphs never changes appearance.
//
// Deliberately checked against FIXTURES rather than the live
// assets/data/journal.json: the real posts are editable content and may
// legitimately start using headings/bold/lists (they now do), which would
// make a live-data assertion fail for a non-bug. The property worth locking
// down is about plain text, not about whatever happens to be published.
const legacyRender = (content) =>
  content
    .split("\n\n")
    .map((p) => "<p>" + main.attrEsc(p) + "</p>")
    .join("");
const plainTextPosts = [
  "A single paragraph with no formatting at all.",
  "First paragraph.\n\nSecond paragraph.\n\nThird one.",
  // Trailing spaces before the break: exactly how the pre-Markdown posts in
  // journal.json were written, and a case a naive trim() would break.
  "Ends with a space before the break. \n\nAnd continues here.",
  // Apostrophes/ampersands must still be escaped the same way.
  "We've all been there & it's fine.",
  // A line starting with a digit that is NOT a numbered list ("2012," has a
  // comma, not the "1. " marker) must stay an ordinary paragraph.
  "2012, was a year.\n\nSo was 2013."
];
plainTextPosts.forEach((content, i) => {
  eq(
    main.renderMarkdown(content),
    legacyRender(content),
    "renderMarkdown renders plain-text post #" + (i + 1) + " exactly as the old code did"
  );
});

// --- XSS: HTML in a post can never become live markup.
eq(
  main.renderMarkdown("<script>alert(1)</script>"),
  "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  "renderMarkdown escapes a <script> tag in post content"
);
assert(
  main.renderMarkdown('<img src=x onerror="alert(1)">').indexOf("<img") === -1,
  "renderMarkdown never emits an <img> tag from post content"
);
assert(
  main.renderMarkdown("## <iframe src=evil>").indexOf("<iframe") === -1,
  "renderMarkdown escapes HTML inside a heading"
);
assert(
  main.renderMarkdown("- <svg onload=alert(1)>").indexOf("<svg") === -1,
  "renderMarkdown escapes HTML inside a list item"
);
assert(
  main.renderMarkdown("**<b>bold</b>**") === "<p><strong>&lt;b&gt;bold&lt;/b&gt;</strong></p>",
  "renderMarkdown formats around escaped HTML instead of un-escaping it"
);
eq(
  main.renderMarkdown("[x](javascript:alert(1))"),
  "<p>x</p>",
  "renderMarkdown drops a javascript: link and keeps only its words"
);
assert(
  main.renderMarkdown("[x](javascript:alert(1))").indexOf("javascript") === -1,
  "renderMarkdown never puts javascript: in the output at all"
);
assert(
  main.renderMarkdown("[x](data:text/html,<script>alert(1)</script>)").indexOf("<a ") === -1,
  "renderMarkdown emits no anchor for a data: URL"
);
assert(
  main.renderMarkdown('[x](https://ok.test/" onmouseover="alert(1))').indexOf('"alert(1)"') === -1,
  "renderMarkdown can't be broken out of an href attribute"
);

// --- formatting a shop owner actually uses.
eq(
  main.renderMarkdown("First para.\n\nSecond para."),
  "<p>First para.</p><p>Second para.</p>",
  "renderMarkdown keeps blank-line-separated paragraphs"
);
eq(
  main.renderMarkdown("## Section\n\n### Sub-section"),
  "<h3>Section</h3><h4>Sub-section</h4>",
  "renderMarkdown starts post headings at h3 so the page outline never skips a level"
);
eq(
  main.renderMarkdown("**bold** and _italic_ and *italic* and __bold__"),
  "<p><strong>bold</strong> and <em>italic</em> and <em>italic</em> and <strong>bold</strong></p>",
  "renderMarkdown handles both bold and italic spellings"
);
eq(
  main.renderMarkdown("soap_batch_2 is a name"),
  "<p>soap_batch_2 is a name</p>",
  "renderMarkdown leaves underscores inside a word alone"
);
eq(
  main.renderMarkdown("- one\n- two"),
  "<ul><li>one</li><li>two</li></ul>",
  "renderMarkdown builds a bullet list"
);
eq(
  main.renderMarkdown("1. one\n2. two"),
  "<ol><li>one</li><li>two</li></ol>",
  "renderMarkdown builds a numbered list"
);
eq(
  main.renderMarkdown("Intro:\n- one\n\nAfter."),
  "<p>Intro:</p><ul><li>one</li></ul><p>After.</p>",
  "renderMarkdown closes a list before the next paragraph"
);
eq(
  main.renderMarkdown("[our shop](shop.html) and [email](mailto:hi@example.com)"),
  '<p><a href="shop.html">our shop</a> and <a href="mailto:hi@example.com">email</a></p>',
  "renderMarkdown links to a page and an email address"
);
eq(
  main.renderMarkdown("[Arnica](https://en.wikipedia.org/wiki/Arnica_(plant))"),
  '<p><a href="https://en.wikipedia.org/wiki/Arnica_(plant)">Arnica</a></p>',
  "renderMarkdown handles a URL containing parentheses"
);
eq(
  main.renderMarkdown("Tea & honey"),
  "<p>Tea &amp; honey</p>",
  "renderMarkdown escapes ampersands in ordinary text"
);
eq(main.renderMarkdown(""), "", "renderMarkdown handles empty content");
eq(main.renderMarkdown(null), "", "renderMarkdown handles missing content");

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
/* The mock document has no #giftCardModal, i.e. this is any page but
   shop.html: the link must carry the shopper TO the shop, where the dialog
   opens on that hash. A bare "#gift-cards" here was a dead link on the
   home page. */
assert(
  main.addToCartHTML(giftCard).includes('href="shop.html#gift-cards"'),
  "addToCartHTML special-cases gift cards (off-shop: links to the shop's configurator)"
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

/* Per-variant sold-out (soldOut: true on a variants option) */
const partialSoldOut = {
  id: "tank",
  name: "Tank",
  price: 30,
  blurb: "b",
  image: "i.jpg",
  category: "apparel",
  variants: {
    name: "Size",
    options: [
      { label: "S", priceDelta: 0, soldOut: true },
      { label: "M", priceDelta: 0 },
      { label: "L", priceDelta: 2 }
    ]
  }
};
const partialBtn = main.addToCartHTML(partialSoldOut);
assert(
  !partialBtn.includes("S[") && partialBtn.includes("M[+0.00]|L[+2.00]"),
  "addToCartHTML excludes sold-out options from data-item-custom1-options"
);
assert(
  partialBtn.includes('data-item-custom1-value="M"'),
  "addToCartHTML defaults custom1-value to the first available (non-sold-out) option"
);
assert(partialBtn.includes("Add to Cart"), "addToCartHTML stays buyable with sizes remaining");

const partialSelect = main.variantSelectHTML(partialSoldOut);
assert(
  /<option value="S"[^>]*disabled/.test(partialSelect),
  "variantSelectHTML disables a sold-out option"
);
assert(
  partialSelect.includes("S — sold out"),
  "variantSelectHTML labels a sold-out option as sold out"
);
assert(
  /<option value="M"[^>]*selected/.test(partialSelect),
  "variantSelectHTML pre-selects the first available option"
);
assert(
  !/<option value="L"[^>]*(disabled|selected)/.test(partialSelect),
  "variantSelectHTML leaves later available options plain"
);

const allSoldOut = {
  id: "tank",
  name: "Tank",
  price: 30,
  blurb: "b",
  image: "i.jpg",
  category: "apparel",
  variants: {
    name: "Size",
    options: [
      { label: "S", priceDelta: 0, soldOut: true },
      { label: "M", priceDelta: 0, soldOut: true }
    ]
  }
};
const allSoldOutBtn = main.addToCartHTML(allSoldOut);
assert(
  allSoldOutBtn.includes("Sold Out") && allSoldOutBtn.includes("disabled"),
  "addToCartHTML treats every-variant-sold-out as a sold-out product"
);
assert(
  allSoldOutBtn.includes("yl-notify-toggle"),
  "addToCartHTML keeps the restock-alert signup when every variant is sold out"
);

/* Sale badge + strikethrough price (sale/originalPrice baked by build-site-data.js) */
const onSale = {
  id: "salve-2",
  name: "Salve",
  price: 19,
  originalPrice: 20,
  sale: { label: "Healing Sale" },
  blurb: "b",
  image: "i.jpg",
  category: "salves"
};
assert(
  main.stockBadgeHTML(onSale).includes('class="stock-badge sale-badge"') &&
    main.stockBadgeHTML(onSale).includes("Healing Sale"),
  "stockBadgeHTML renders the sale badge with its label"
);
eq(
  main.stockBadgeHTML({ id: "x", price: 20 }),
  "",
  "stockBadgeHTML renders nothing without a sale or tracked stock"
);
assert(
  !main.stockBadgeHTML({ ...onSale, comingSoon: true }).includes("sale-badge"),
  "stockBadgeHTML suppresses the sale badge on coming-soon products"
);
assert(
  !main.stockBadgeHTML({ ...onSale, stock: 0 }).includes("sale-badge"),
  "stockBadgeHTML suppresses the sale badge on sold-out products"
);
assert(
  main.stockBadgeHTML({ ...onSale, stock: 3 }).includes("sale-badge") &&
    main.stockBadgeHTML({ ...onSale, stock: 3 }).includes("Only 3 left"),
  "stockBadgeHTML shows sale badge alongside a low-stock badge"
);
eq(
  main.priceHTML(onSale),
  '<span class="price">$19.00 <s class="original-price">$20.00</s></span>',
  "priceHTML strikes through the pre-sale price during a sale"
);
eq(
  main.priceHTML({ id: "x", price: 8 }),
  '<span class="price">$8.00</span>',
  "priceHTML renders a plain price when no sale is active"
);
eq(
  main.priceHTML({ id: "x", price: 8, originalPrice: 10 }),
  '<span class="price">$8.00</span>',
  "priceHTML ignores originalPrice without an active sale"
);

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

/* 7. pickNextEvent -- the countdown ticker's event selection.
   events.json is hand-ordered through the CMS, so none of this can lean on
   the array already being in date order. */
const TODAY = "2026-08-21";

eq(main.pickNextEvent([], TODAY), null, "pickNextEvent returns null with no events");
eq(main.pickNextEvent(null, TODAY), null, "pickNextEvent tolerates a missing list");

const outOfOrder = [
  { date: "2026-10-17T09:00:00-04:00", name: "Autumn Apothecary Faire" },
  { date: "2026-08-29", endDate: "2026-08-30", name: "Spartanburg Punk Flea Market" },
  { date: "2026-09-12", name: "Greenville Night Market" }
];
eq(
  main.pickNextEvent(outOfOrder, TODAY).event.name,
  "Spartanburg Punk Flea Market",
  "pickNextEvent picks the soonest event, not the first one listed"
);

eq(
  main.pickNextEvent(
    [
      { date: "2026-08-15", endDate: "2026-08-16", name: "Finished Market" },
      { date: "2026-08-29", name: "Spartanburg Punk Flea Market" }
    ],
    TODAY
  ).event.name,
  "Spartanburg Punk Flea Market",
  "pickNextEvent skips an event whose final day has passed"
);

const inProgress = main.pickNextEvent(
  [
    { date: "2026-08-20", endDate: "2026-08-21", name: "Two-Day Market" },
    { date: "2026-08-29", name: "Spartanburg Punk Flea Market" }
  ],
  TODAY
);
eq(
  inProgress.event.name,
  "Two-Day Market",
  "pickNextEvent keeps a multi-day market through its final day"
);
assert(
  inProgress.startTime < new Date(2026, 7, 21).getTime() + 24 * 3600 * 1000,
  "pickNextEvent reports the in-progress market's start time, so the ticker reads 'in progress'"
);

eq(
  main.pickNextEvent([{ date: "2026-08-21", name: "Starts Today" }], TODAY).event.name,
  "Starts Today",
  "pickNextEvent keeps an event that starts today"
);

eq(
  main.pickNextEvent([{ name: "No Date" }, null, { date: "not-a-date", name: "Bad Date" }], TODAY),
  null,
  "pickNextEvent ignores entries with a missing or unparseable date"
);

/* 8. Milestone 2: Calendar, Maps & Pickup deep-linking exports */
const testEv = {
  id: "punk-flea",
  name: "Summerville Punk Flea Market",
  date: "2026-08-15",
  endDate: "2026-08-16",
  dateLabel: "August 15–16, 2026 · Sat & Sun, 11am–7pm",
  location: "Ladson, SC",
  zip: "29456",
  note: "9850 Highway 78, Ladson, SC 29456. Two-day punk flea market."
};

const gCal = main.generateGoogleCalendarUrl(testEv);
assert(gCal.includes("action=TEMPLATE"), "generateGoogleCalendarUrl sets action=TEMPLATE");
assert(
  gCal.includes("dates=20260815%2F20260817"),
  "generateGoogleCalendarUrl percent-encodes the exclusive multi-day date range"
);

const icsUri = main.generateIcsDataUri(testEv);
assert(
  icsUri.startsWith("data:text/calendar;charset=utf-8,"),
  "generateIcsDataUri produces calendar data URI"
);

const icsText = main.generateIcsContent(testEv);
assert(icsText.includes("BEGIN:VCALENDAR"), "generateIcsContent starts VCALENDAR");
assert(
  icsText.includes("UID:yl-event-punk-flea-20260815@yallternativeliving.com"),
  "generateIcsContent sets UID"
);
assert(icsText.includes("DTSTART;VALUE=DATE:20260815"), "generateIcsContent sets DTSTART");
assert(icsText.includes("DTEND;VALUE=DATE:20260817"), "generateIcsContent sets DTEND");
assert(icsText.includes("END:VCALENDAR"), "generateIcsContent ends VCALENDAR");

const gMap = main.generateGoogleMapsDirUrl(testEv);
assert(
  gMap.includes("https://www.google.com/maps/dir/?api=1&destination="),
  "generateGoogleMapsDirUrl formats direction URL"
);

const appleMap = main.generateAppleMapsDirUrl(testEv);
assert(
  appleMap.includes("https://maps.apple.com/?daddr="),
  "generateAppleMapsDirUrl formats Apple directions URL"
);

const pickup = main.parsePickupMarketParam("punk-flea", { upcoming: [testEv] });
eq(
  pickup.marketName,
  "Summerville Punk Flea Market",
  "parsePickupMarketParam resolves event by id"
);

const cardMarkup = main.eventCardHTML(testEv);
assert(
  cardMarkup.includes("Reserve / Pick Up at This Booth"),
  "eventCardHTML includes Reserve / Pick Up button"
);
assert(
  cardMarkup.includes("Add to Google Calendar"),
  "eventCardHTML includes Add to Google Calendar button"
);
assert(cardMarkup.includes("iCal / Apple Calendar (.ics)"), "eventCardHTML includes iCal button");
assert(cardMarkup.includes("Google Maps"), "eventCardHTML includes Google Maps link");
assert(cardMarkup.includes("Apple Maps"), "eventCardHTML includes Apple Maps link");

/* 9. Milestone 3: Recently Viewed Products (R4) */
mockLocalStorage.clear();
main._resetState();

eq(main.getRecentlyViewed(), [], "getRecentlyViewed returns empty array initially");

// Corrupted JSON handling
mockLocalStorage.setItem("yl-recently-viewed", "{broken-json");
main._resetState();
eq(main.getRecentlyViewed(), [], "getRecentlyViewed handles corrupted JSON gracefully");

// Null / invalid inputs
mockLocalStorage.clear();
main._resetState();
eq(main.recordRecentlyViewed(null), [], "recordRecentlyViewed handles null safely");
eq(main.recordRecentlyViewed(undefined), [], "recordRecentlyViewed handles undefined safely");
eq(main.recordRecentlyViewed({}), [], "recordRecentlyViewed handles empty object safely");

// Recording products
const prodA = {
  id: "frankincense-salve",
  name: "Y'all Heal Now Miracle Frankincense Salve",
  price: 19.99,
  image: "assets/img/frankincense-salve.jpg",
  category: "salves"
};
const prodB = {
  id: "backroad-soak",
  name: "Backroad Recovery Epsom Salt Soak",
  price: 10.0,
  image: "assets/img/backroad-soak.jpg",
  category: "soaks"
};
const prodC = {
  id: "tank-top",
  name: "Y'allternative Living Tank Top",
  price: 30.0,
  image: "assets/img/tank-top.jpg",
  category: "apparel"
};

const recorded1 = main.recordRecentlyViewed(prodA);
eq(recorded1.length, 1, "recordRecentlyViewed adds first product");
eq(recorded1[0].id, "frankincense-salve", "recordRecentlyViewed saves product id");
eq(
  recorded1[0].name,
  "Y'all Heal Now Miracle Frankincense Salve",
  "recordRecentlyViewed saves product name"
);
eq(recorded1[0].price, 19.99, "recordRecentlyViewed saves product price");
eq(
  recorded1[0].image,
  "assets/img/frankincense-salve.jpg",
  "recordRecentlyViewed saves product image"
);
eq(recorded1[0].category, "salves", "recordRecentlyViewed saves product category");
assert(
  typeof recorded1[0].timestamp === "number",
  "recordRecentlyViewed attaches numeric timestamp"
);

// Unshift order (most recent first)
const recorded2 = main.recordRecentlyViewed(prodB);
eq(recorded2.length, 2, "recordRecentlyViewed adds second product");
eq(recorded2[0].id, "backroad-soak", "recordRecentlyViewed unshifts second product to index 0");
eq(recorded2[1].id, "frankincense-salve", "first product moved to index 1");

// Deduplication
const recorded3 = main.recordRecentlyViewed(prodA);
eq(recorded3.length, 2, "recordRecentlyViewed deduplicates by id");
eq(recorded3[0].id, "frankincense-salve", "re-viewed product moves to index 0");
eq(recorded3[1].id, "backroad-soak", "other product remains in list");

// Capping at 8 items
mockLocalStorage.clear();
main._resetState();
for (let i = 1; i <= 10; i++) {
  main.recordRecentlyViewed({
    id: `item-${i}`,
    name: `Item ${i}`,
    price: i * 5,
    image: `assets/img/item-${i}.jpg`,
    category: "salves"
  });
}
const cappedList = main.getRecentlyViewed();
eq(cappedList.length, 8, "recordRecentlyViewed caps list at exactly 8 items");
eq(cappedList[0].id, "item-10", "most recent item is at index 0");
eq(cappedList[7].id, "item-3", "oldest retained item is at index 7");
assert(
  !cappedList.some((item) => item.id === "item-1" || item.id === "item-2"),
  "items beyond 8 are pruned"
);

// Safe error handling on localStorage failure (e.g. private browsing / quota)
const origSetItem = mockLocalStorage.setItem;
mockLocalStorage.setItem = () => {
  throw new Error("QuotaExceededError");
};
const errorHandled = main.recordRecentlyViewed({
  id: "quota-test",
  name: "Quota Test Item",
  price: 15.0
});
assert(
  Array.isArray(errorHandled),
  "recordRecentlyViewed returns array despite localStorage failure"
);
eq(
  errorHandled[0].id,
  "quota-test",
  "recordRecentlyViewed still updates in-memory cache on storage error"
);
mockLocalStorage.setItem = origSetItem;

// Carousel rendering tests
mockLocalStorage.clear();
main._resetState();
recentlyViewedSectionEl.hidden = false;
recentlyViewedSectionEl.removeAttribute("hidden");
recentlyViewedTrackEl.innerHTML = "initial";

// With 0 items
main.renderRecentlyViewedCarousel();
assert(
  recentlyViewedSectionEl.hidden === true,
  "renderRecentlyViewedCarousel hides section with 0 items"
);

// With 1 item
main.recordRecentlyViewed(prodA);
main.renderRecentlyViewedCarousel();
assert(
  recentlyViewedSectionEl.hidden === true,
  "renderRecentlyViewedCarousel hides section with 1 item"
);

// With 2 items
main.recordRecentlyViewed(prodB);
main.renderRecentlyViewedCarousel();
assert(
  recentlyViewedSectionEl.hidden === false,
  "renderRecentlyViewedCarousel unhides section with >= 2 items"
);
assert(
  recentlyViewedTrackEl.innerHTML.includes("Backroad Recovery Epsom Salt Soak"),
  "carousel track contains product B"
);
assert(
  recentlyViewedTrackEl.innerHTML.includes("Y&#39;all Heal Now Miracle Frankincense Salve") ||
    recentlyViewedTrackEl.innerHTML.includes("Frankincense Salve"),
  "carousel track contains product A"
);
assert(
  recentlyViewedTrackEl.innerHTML.includes("recently-viewed-card"),
  "carousel track renders card elements"
);
assert(
  !recentlyViewedTrackEl.innerHTML.includes("reveal"),
  "carousel track does NOT apply .reveal class to dynamic cards"
);

// On PDP page: filters out the current PDP product
mockDocument.body.classList.add("pdp-page");
mockWindow.location.pathname = "/products/backroad-soak.html";
pdpRecentlyViewedSectionEl.hidden = false;
pdpRecentlyViewedSectionEl.removeAttribute("hidden");
pdpRecentlyViewedTrackEl.innerHTML = "initial";

main.renderRecentlyViewedCarousel();
// Out of prodA and prodB, prodB is filtered out -> 1 item remaining (< 2) -> section hidden
assert(
  pdpRecentlyViewedSectionEl.hidden === true,
  "PDP carousel hides section if remaining items < 2"
);

main.recordRecentlyViewed(prodC);
main.renderRecentlyViewedCarousel();
// prodA, prodB, prodC -> prodB filtered out -> prodA and prodC remain (2 items) -> unhidden
assert(
  pdpRecentlyViewedSectionEl.hidden === false,
  "PDP carousel unhides when >= 2 non-current items exist"
);
assert(
  !pdpRecentlyViewedTrackEl.innerHTML.includes("Backroad Recovery Epsom Salt Soak"),
  "PDP carousel excludes current PDP product"
);
assert(
  pdpRecentlyViewedTrackEl.innerHTML.includes("Y&#39;allternative Living Tank Top") ||
    pdpRecentlyViewedTrackEl.innerHTML.includes("Tank Top"),
  "PDP carousel includes other viewed products"
);

mockDocument.body.classList.remove("pdp-page");
mockWindow.location.pathname = "/";

// ============================================================================
// R1: Mobile Sticky Add-to-Cart Bottom Bar on PDPs
// ============================================================================
console.log("\n--- Testing initPdpStickyBar (R1) ---");

assert(typeof main.initPdpStickyBar === "function", "main.initPdpStickyBar is a function");

// Mock elements for PDP Sticky Bar testing
const testStickyBarEl = createMockElement("div");
testStickyBarEl.setAttribute("id", "pdpStickyBar");
testStickyBarEl.setAttribute("aria-hidden", "true");

const testPrimaryCtaEl = createMockElement("div");
testPrimaryCtaEl.classList.add("pdp-actions");

const testStickyPriceEl = createMockElement("p");
testStickyPriceEl.classList.add("pdp-sticky-price");
testStickyPriceEl.textContent = "$13.99";

const testStickyVariantSelect = createMockElement("select");
testStickyVariantSelect.classList.add("pdp-sticky-variant-select", "variant-select");
testStickyVariantSelect.setAttribute("data-base-price", "13.99");
testStickyVariantSelect._listeners = {};
testStickyVariantSelect.addEventListener = (evt, fn) => {
  if (!testStickyVariantSelect._listeners[evt]) testStickyVariantSelect._listeners[evt] = [];
  testStickyVariantSelect._listeners[evt].push(fn);
};

const opt1 = createMockElement("option");
opt1.value = "2oz";
opt1.setAttribute("data-delta", "0");
const opt2 = createMockElement("option");
opt2.value = "4oz";
opt2.setAttribute("data-delta", "6.00");
testStickyVariantSelect.options = [opt1, opt2];
testStickyVariantSelect.selectedIndex = 0;
testStickyVariantSelect.value = "2oz";

const testStickyAddBtn = createMockElement("button");
testStickyAddBtn.classList.add("pdp-sticky-add-btn", "yl-add-item");
testStickyAddBtn.setAttribute("data-item-id", "frankincense-salve");
testStickyAddBtn.setAttribute("data-item-custom1-value", "2oz");
testStickyAddBtn.setAttribute("data-item-price", "13.99");

const testMainDetailsEl = createMockElement("div");
testMainDetailsEl.classList.add("pdp-details");

const testMainSelect = createMockElement("select");
testMainSelect.classList.add("variant-select");
testMainSelect.setAttribute("data-base-price", "13.99");
testMainSelect._listeners = {};
testMainSelect.addEventListener = (evt, fn) => {
  if (!testMainSelect._listeners[evt]) testMainSelect._listeners[evt] = [];
  testMainSelect._listeners[evt].push(fn);
};
const mOpt1 = createMockElement("option");
mOpt1.value = "2oz";
mOpt1.setAttribute("data-delta", "0");
const mOpt2 = createMockElement("option");
mOpt2.value = "4oz";
mOpt2.setAttribute("data-delta", "6.00");
testMainSelect.options = [mOpt1, mOpt2];
testMainSelect.selectedIndex = 0;
testMainSelect.value = "2oz";

const testMainPriceEl = createMockElement("span");
testMainPriceEl.classList.add("pdp-price");
testMainPriceEl.textContent = "$13.99";
testMainPriceEl.querySelector = () => null;

const testMainAddBtn = createMockElement("button");
testMainAddBtn.classList.add("yl-add-item");
testMainAddBtn.setAttribute("data-item-id", "frankincense-salve");
testMainAddBtn.setAttribute("data-item-custom1-value", "2oz");
testMainAddBtn.setAttribute("data-item-price", "13.99");

testStickyBarEl.querySelector = (sel) => {
  if (sel === ".pdp-sticky-variant-select") return testStickyVariantSelect;
  if (sel === ".pdp-sticky-price") return testStickyPriceEl;
  if (sel === ".pdp-sticky-add-btn") return testStickyAddBtn;
  return null;
};

// Wire up mock document queries for PDP
const originalGetElementById = mockDocument.getElementById;
const originalQuerySelector = mockDocument.querySelector;

mockDocument.getElementById = (id) => {
  if (id === "pdpStickyBar") return testStickyBarEl;
  return originalGetElementById(id);
};

mockDocument.querySelector = (sel) => {
  if (sel === ".pdp-actions") return testPrimaryCtaEl;
  if (sel === ".pdp-details .variant-select") return testMainSelect;
  if (sel === ".pdp-details .pdp-price" || sel === ".pdp-price-row .price") return testMainPriceEl;
  if (sel === ".pdp-details .yl-add-item" || sel === ".pdp-actions .yl-add-item")
    return testMainAddBtn;
  return originalQuerySelector(sel);
};

// Mock IntersectionObserver
let observerCb = null;
let observedEl = null;
global.IntersectionObserver = class {
  constructor(cb) {
    observerCb = cb;
  }
  observe(el) {
    observedEl = el;
  }
  unobserve() {}
  disconnect() {}
};

// Initialize PDP Sticky Bar
main.initPdpStickyBar();

assert(observedEl === testPrimaryCtaEl, "initPdpStickyBar observes primary CTA element");

// Test mobile viewport: primary CTA scrolled past (out of view above)
mockWindow.innerWidth = 375;
observerCb([
  {
    isIntersecting: false,
    boundingClientRect: { top: -120 }
  }
]);

assert(
  testStickyBarEl.classList.contains("is-visible"),
  "sticky bar gains .is-visible when primary CTA scrolls past top on mobile"
);
assert(
  testStickyBarEl.getAttribute("aria-hidden") === "false",
  "sticky bar sets aria-hidden='false' when visible"
);

// Test primary CTA scrolled back into view
observerCb([
  {
    isIntersecting: true,
    boundingClientRect: { top: 50 }
  }
]);

assert(
  !testStickyBarEl.classList.contains("is-visible"),
  "sticky bar loses .is-visible when primary CTA is in view"
);
assert(
  testStickyBarEl.getAttribute("aria-hidden") === "true",
  "sticky bar sets aria-hidden='true' when hidden"
);

// Test desktop viewport: should remain hidden even if scrolled past
mockWindow.innerWidth = 1024;
observerCb([
  {
    isIntersecting: false,
    boundingClientRect: { top: -120 }
  }
]);

assert(
  !testStickyBarEl.classList.contains("is-visible"),
  "sticky bar does not gain .is-visible on desktop (width >= 768)"
);

// Test Two-way Variant Synchronization: sticky select changes to 4oz (+$6.00)
testStickyVariantSelect.selectedIndex = 1;
testStickyVariantSelect.value = "4oz";
if (testStickyVariantSelect._listeners["change"]) {
  testStickyVariantSelect._listeners["change"].forEach((fn) => fn());
}

assert(
  testStickyPriceEl.textContent === "$19.99",
  "sticky price updates to $19.99 on 4oz selection"
);
assert(
  testStickyAddBtn.getAttribute("data-item-custom1-value") === "4oz",
  "sticky add button custom1 value updates to 4oz"
);
/* The buttons keep the BASE price; cart.js adds the label's delta from
   data-item-custom1-options. Writing base+delta here used to double it. */
assert(
  testStickyAddBtn.getAttribute("data-item-price") === "13.99",
  "sticky add button keeps the base price (cart.js adds the variant delta)"
);
assert(testMainSelect.value === "4oz", "main variant selector synchronizes to 4oz");
assert(testMainPriceEl.textContent === "$19.99", "main PDP price updates to $19.99");
assert(
  testMainAddBtn.getAttribute("data-item-custom1-value") === "4oz",
  "main add button custom1 value updates to 4oz"
);
assert(
  testMainAddBtn.getAttribute("data-item-price") === "13.99",
  "main add button keeps the base price (cart.js adds the variant delta)"
);

// Test Two-way Variant Synchronization: main select changes back to 2oz ($13.99)
testMainSelect.selectedIndex = 0;
testMainSelect.value = "2oz";
if (testMainSelect._listeners["change"]) {
  testMainSelect._listeners["change"].forEach((fn) => fn());
}

assert(testStickyVariantSelect.value === "2oz", "sticky variant selector synchronizes to 2oz");
assert(testStickyPriceEl.textContent === "$13.99", "sticky price updates back to $13.99");
assert(
  testStickyAddBtn.getAttribute("data-item-custom1-value") === "2oz",
  "sticky add button custom1 value updates back to 2oz"
);
assert(
  testStickyAddBtn.getAttribute("data-item-price") === "13.99",
  "sticky add button still carries the base price after switching back"
);

// Restore mockDocument
mockDocument.getElementById = originalGetElementById;
mockDocument.querySelector = originalQuerySelector;

/* ---------- C-5: 404.html must work at any depth, and the translator load ----------
   Netlify serves 404.html at the requested URL, so a document-relative asset
   path on /products/anything resolves to /products/assets/... and the page
   renders unstyled with every escape route broken. Assert every same-origin
   reference in the file is root-absolute (or a fragment/mailto), and that
   main.js loads the translator from an absolute path for the same reason. */
const fs404 = require("fs");
const path404 = require("path");
const repoRoot = path404.resolve(__dirname, "..");
const notFoundSrc = fs404.readFileSync(path404.join(repoRoot, "404.html"), "utf8");
const relativeRefs = [];
notFoundSrc.replace(/\s(?:href|src)="([^"]*)"/g, function (_m, url) {
  if (!url) return _m;
  if (/^(https?:)?\/\//i.test(url)) return _m;
  if (url.charAt(0) === "/" || url.charAt(0) === "#") return _m;
  if (/^(mailto|tel):/i.test(url)) return _m;
  relativeRefs.push(url);
  return _m;
});
eq(relativeRefs, [], "404.html has no document-relative href/src (C-5)");
assert(
  notFoundSrc.indexOf('<link rel="manifest" href="/site.webmanifest">') !== -1,
  "404.html links the manifest root-absolutely"
);
assert(
  notFoundSrc.indexOf('src="/assets/js/main.js?v=2.0"') !== -1,
  "404.html loads main.js root-absolutely"
);
assert(
  notFoundSrc.indexOf("<!--YL:site.umamiWebsiteId--><!--/YL:site.umamiWebsiteId-->") !== -1 &&
    notFoundSrc.indexOf("<!--YL:nav.journal--><!--/YL:nav.journal-->") !== -1,
  "404.html keeps its build markers intact"
);

const mainSrc = fs404.readFileSync(path404.join(repoRoot, "assets/js/main.js"), "utf8");
assert(
  mainSrc.indexOf('s.src = "/assets/js/translator.js?v=2.0";') !== -1,
  "main.js loads translator.js from a root-absolute path (C-5)"
);

/* ---------- site.webmanifest identity ---------- */
const manifest = JSON.parse(fs404.readFileSync(path404.join(repoRoot, "site.webmanifest"), "utf8"));
eq(manifest.start_url, "/", "site.webmanifest start_url is root-absolute");
eq(manifest.scope, "/", "site.webmanifest declares a scope");
assert(
  typeof manifest.id === "string" && manifest.id.length > 0,
  "site.webmanifest declares a stable id"
);

/* ---------- Escaping, CSP and analytics hardening ---------- */

/* safeImageSrc: the src= counterpart of safeUrl. Catalogue and UGC images are
   written document-relative in the CMS JSON, so that shape is allowed; a
   scheme of any kind is not. */
eq(
  main.safeImageSrc("assets/img/shea-butter.jpg"),
  "assets/img/shea-butter.jpg",
  "safeImageSrc allows a document-relative asset path"
);
eq(
  main.safeImageSrc("/assets/img/x.png"),
  "/assets/img/x.png",
  "safeImageSrc allows a root-relative path"
);
eq(
  main.safeImageSrc("https://cdn.example.com/x.png"),
  "https://cdn.example.com/x.png",
  "safeImageSrc allows an absolute https image"
);
eq(main.safeImageSrc("javascript:alert(1)"), "", "safeImageSrc rejects javascript:");
eq(main.safeImageSrc("data:text/html,<script>"), "", "safeImageSrc rejects data:");
eq(main.safeImageSrc('x" onerror="alert(1)'), "", "safeImageSrc rejects an attribute breakout");
eq(main.safeImageSrc(null), "", "safeImageSrc handles null");

/* Regression guards on the sinks themselves. Each of these is a one-line
   omission that reads as harmless in review, so assert the call is present at
   the sink rather than only testing the helper in isolation. */
const mainJsSource = fs404.readFileSync(path404.join(repoRoot, "assets/js/main.js"), "utf8");

assert(
  mainJsSource.indexOf("(TAG_LABELS[t] || attrEsc(t))") !== -1,
  "an unknown product tag is escaped before it reaches the card (main.js tagPillsHTML)"
);
assert(
  mainJsSource.indexOf("attrEsc(safeImageSrc(post.image))") !== -1,
  "the UGC feed image src goes through safeImageSrc"
);
["prod", "art", "ev", "f"].forEach((v) => {
  assert(
    mainJsSource.indexOf("attrEsc(safeLinkUrl(" + v + ".url))") !== -1,
    `search result URLs for ${v} go through safeLinkUrl`
  );
  assert(
    mainJsSource.indexOf("attrEsc(" + v + ".url)") === -1,
    `no unchecked ${v}.url is left in a search result href`
  );
});
assert(
  mainJsSource.indexOf("window.location.href = activeItemMeta.url") === -1 &&
    mainJsSource.indexOf("var target = activeItemMeta ? safeLinkUrl(activeItemMeta.url)") !== -1,
  "the search modal's navigation sink runs the URL through safeLinkUrl"
);

/* CSP: the service-worker update toast's buttons were inline onclick handlers,
   which the site's CSP blocks -- so neither button did anything. */
assert(
  mainJsSource.indexOf("onclick=") === -1,
  "main.js emits no inline onclick handler anywhere (the CSP blocks them)"
);
assert(
  mainJsSource.indexOf('updateBtn.addEventListener("click"') !== -1 &&
    mainJsSource.indexOf('dismissBtn.addEventListener("click"') !== -1,
  "the service-worker update toast wires its buttons with addEventListener"
);

/* Analytics must never carry the raw search string. */
assert(
  mainJsSource.indexOf("props: { query: value.trim() }") === -1,
  "the Site Search event no longer sends the raw query"
);
assert(
  /window\.plausible\("Site Search", \{\s*props: \{\s*length: value\.trim\(\)\.length,\s*hasResults:/.test(
    mainJsSource
  ),
  "the Site Search event sends only {length, hasResults}"
);

/* Recently viewed: every id becomes a products/<id>.html href, and the list
   comes out of localStorage. */
mockLocalStorage.clear();
main._resetState();
mockLocalStorage.setItem(
  "yl-recently-viewed",
  JSON.stringify([
    { id: "frankincense-salve", name: "Frankincense Salve", price: 19.99, image: "a.jpg" },
    {
      id: '../evil.html?x="><img src=x onerror=alert(1)>',
      name: "Injected",
      price: 1,
      image: "b.jpg"
    },
    { id: "backroad-soak", name: "Backroad Soak", price: 18, image: "c.jpg" },
    { id: "Frank_Salve", name: "Wrong Case", price: 5, image: "d.jpg" }
  ])
);
recentlyViewedTrackEl.innerHTML = "";
main.renderRecentlyViewedCarousel();
assert(
  recentlyViewedTrackEl.innerHTML.indexOf("evil.html") === -1,
  "a recently-viewed id that is not a plain slug never reaches an href"
);
assert(
  recentlyViewedTrackEl.innerHTML.indexOf("Frank_Salve") === -1,
  "a recently-viewed id outside /^[a-z0-9-]+$/ is dropped"
);
assert(
  recentlyViewedTrackEl.innerHTML.indexOf('href="products/frankincense-salve.html"') !== -1,
  "well-formed recently-viewed ids still render their links"
);
mockLocalStorage.clear();
main._resetState();

/* ---------- Volume-tier badge parity with cart.js / workers/checkout.js ----------
   The badge decides on its own whether "2+ for $14.99 ea" appears on a card,
   and it used to decide with looser rules than the cart and the Worker (which
   agree byte for byte). This block runs the same product through both
   implementations and asserts they never disagree. */
const cartEngine = require("../assets/js/cart.js");
const volumeRule = {
  id: "salves-2oz",
  name: "2oz Salve Multi-Buy",
  category: "salves",
  qualifyingVariant: "2oz",
  minQuantity: 2,
  unitPrice: 14.99,
  label: "2+ for $14.99 each",
  enabled: true
};

const savedProducts = mockWindow.YL_PRODUCTS;

function withCatalog(products, fn) {
  mockWindow.YL_PRODUCTS = { products: products, volumePricing: [volumeRule] };
  main._resetState();
  try {
    return fn();
  } finally {
    mockWindow.YL_PRODUCTS = savedProducts;
    main._resetState();
  }
}

const frankincense = {
  id: "frankincense-salve",
  name: "Y'all Heal Now Miracle Frankincense Salve",
  category: "salves",
  price: 19.99,
  blurb: "Small-batch frankincense salve.",
  variants: { options: [{ label: "2oz" }, { label: "1oz", priceDelta: -6 }] }
};
const sleepSalve = {
  id: "sleep-salve",
  name: "Hush Y'all Magnesium Arnica Sleep Salve",
  category: "salves",
  price: 19.99,
  blurb: "Magnesium and arnica for bedtime."
};
const miracleBalm = {
  id: "miracle-balm",
  name: "Y'allternative Miracle Balm",
  category: "salves",
  price: 8.0,
  blurb: "All-purpose balm."
};
// A hypothetical future variantless salve whose copy names the size, and one
// priced at or under the tier. Both are the cases the badge got wrong.
const textMatchSalve = {
  id: "cedar-salve",
  name: "Cedar Woods Salve 2oz",
  category: "salves",
  price: 19.99,
  blurb: "Poured into a 2oz tin."
};
const cheapSalve = {
  id: "budget-salve",
  name: "Budget Salve 2oz",
  category: "salves",
  price: 13.99,
  blurb: "Poured into a 2oz tin."
};
const bodyProduct = {
  id: "shea-butter",
  name: "Lavender Shea Body Butter",
  category: "body",
  price: 16.0,
  blurb: "Whipped shea."
};

withCatalog(
  [frankincense, sleepSalve, miracleBalm, textMatchSalve, cheapSalve, bodyProduct],
  () => {
    assert(
      typeof main.getMatchingVolumeRule === "function",
      "getMatchingVolumeRule is exported for the parity check"
    );
    assert(
      typeof cartEngine.itemMatchesRule === "function",
      "cart.js exports itemMatchesRule to compare against"
    );

    /* Product-level: does any variant of this product qualify? */
    assert(
      !!main.getMatchingVolumeRule(frankincense),
      "frankincense-salve is badged (a 2oz option exists and $14.99 < $19.99)"
    );
    assert(
      !!main.getMatchingVolumeRule(sleepSalve),
      "sleep-salve is badged (cart.js includes it explicitly)"
    );
    assert(
      main.getMatchingVolumeRule(miracleBalm) === null,
      "miracle-balm is never badged (cart.js excludes it explicitly)"
    );
    assert(
      !!main.getMatchingVolumeRule(textMatchSalve),
      "a variantless salve whose copy names the size is badged, matching cart.js's text match"
    );
    assert(
      main.getMatchingVolumeRule(cheapSalve) === null,
      "a salve priced at or under the tier is not badged -- the tier is not a discount"
    );
    assert(
      main.getMatchingVolumeRule(bodyProduct) === null,
      "a product outside the rule's category is never badged"
    );

    /* Selected-variant level: the cart counts an item by its own variantLabel,
       so the badge must disappear when the shopper picks a non-qualifying one. */
    assert(
      !!main.getMatchingVolumeRule(frankincense, "2oz"),
      "the badge stays on the 2oz selection"
    );
    assert(
      main.getMatchingVolumeRule(frankincense, "1oz") === null,
      "the badge is hidden on the 1oz selection"
    );
    assert(
      !!main.getMatchingVolumeRule(frankincense, " 2 OZ "),
      "variant matching normalises whitespace and case, as cart.js does"
    );

    /* Parity: the two implementations must agree on every case above. */
    [
      [frankincense, "2oz"],
      [frankincense, "1oz"],
      [sleepSalve, null],
      [miracleBalm, null],
      [miracleBalm, "2oz"],
      [textMatchSalve, null],
      [cheapSalve, null],
      [bodyProduct, null]
    ].forEach(([product, label]) => {
      const badged = !!main.getMatchingVolumeRule(product, label === null ? undefined : label);
      const cartItem = { id: product.id, category: product.category, qty: 1 };
      if (label) cartItem.variantLabel = label;
      let cartQualifies = cartEngine.itemMatchesRule(cartItem, volumeRule);
      // The cart has no notion of "this tier is not cheaper than the item";
      // the Worker applies min(base, unitPrice) instead. The badge must not
      // advertise a tier in that case, so treat it as a non-match here too.
      if (product.price <= volumeRule.unitPrice) cartQualifies = false;
      eq(
        badged,
        cartQualifies,
        `badge and cart agree on ${product.id}${label ? " @" + label : ""}`
      );
    });
  }
);

/* ---------- CMS feature switches are honoured ---------- */
const savedContent = mockWindow.YL_CONTENT;
mockWindow.YL_CONTENT = undefined;
["enableOrderStatusLookup", "enableCountdownTicker", "enableApothecaryQuiz"].forEach((flag) => {
  eq(main.siteFlagEnabled(flag), true, `${flag} defaults to on when content.json is absent`);
});
mockWindow.YL_CONTENT = {
  site: {
    enableOrderStatusLookup: false,
    enableCountdownTicker: false,
    enableApothecaryQuiz: false
  }
};
["enableOrderStatusLookup", "enableCountdownTicker", "enableApothecaryQuiz"].forEach((flag) => {
  eq(main.siteFlagEnabled(flag), false, `${flag} is read from window.YL_CONTENT.site`);
});
mockWindow.YL_CONTENT = savedContent;
["enableOrderStatusLookup", "enableCountdownTicker", "enableApothecaryQuiz"].forEach((flag) => {
  assert(
    mainJsSource.indexOf('siteFlagEnabled("' + flag + '")') !== -1,
    `main.js actually reads ${flag}`
  );
});
const contentJson = JSON.parse(
  fs404.readFileSync(path404.join(repoRoot, "assets/data/content.json"), "utf8")
);
["enableOrderStatusLookup", "enableCountdownTicker", "enableApothecaryQuiz"].forEach((flag) => {
  assert(
    Object.prototype.hasOwnProperty.call(contentJson.site, flag),
    `content.json still declares ${flag}, so main.js has something to read`
  );
});

/* ---------- H-14: the privacy policy has to describe the site that exists ----------
   It claimed no form but the newsletter collected contact information (five
   others do), and stated as fact that Umami analytics runs (the website id is
   still a placeholder). It named none of the processors actually handling
   customer data. These assertions are derived from the code and config, not
   from a copy of the prose, so a new form or a new third party breaks them. */
const privacySrc = fs404.readFileSync(path404.join(repoRoot, "privacy.html"), "utf8");

/* Every processor the site actually talks to has to be named on the page. */
[
  "Stripe",
  "Cloudflare",
  "Netlify",
  "Formspree",
  "Kit",
  "Resend",
  "Tawk.to",
  "Google Fonts",
  "Google Translate",
  "Umami",
  "Etsy"
].forEach((processor) => {
  assert(
    privacySrc.indexOf(processor) !== -1,
    `privacy.html names ${processor}, which handles data for this site`
  );
});

/* Every form that collects something has to be described. */
[
  ["Contact form", /Contact form/],
  ["review", /Review form/],
  ["restock alert", /Restock &amp; launch alerts/],
  ["order lookup", /Order lookup/],
  ["gift card balance", /Gift card balance check/],
  ["gift card recipient", /Gift card recipient details/],
  ["newsletter", /Newsletter signup/],
  ["live chat", /Live chat/]
].forEach(([label, pattern]) => {
  assert(pattern.test(privacySrc), `privacy.html describes the ${label} form`);
});

/* The false claim that nothing else collects contact information is gone. */
assert(
  privacySrc.indexOf("There's no other form on this site that collects contact info") === -1,
  "privacy.html no longer claims the newsletter is the only form that collects contact info"
);

/* Analytics is conditional, so the page must not state it as running. The
   website id is still a placeholder, so nothing loads today. */
const contentSrc = JSON.parse(
  fs404.readFileSync(path404.join(repoRoot, "assets/data/content.json"), "utf8")
);
const umamiConfigured =
  !!contentSrc.site.umamiWebsiteId && contentSrc.site.umamiWebsiteId.indexOf("YOUR_") !== 0;
if (!umamiConfigured) {
  assert(
    privacySrc.indexOf('We run <a href="https://umami.is/"') === -1,
    "privacy.html does not assert that Umami is running while its id is a placeholder"
  );
  assert(
    /analytics may be enabled/i.test(privacySrc),
    "privacy.html says analytics may be enabled rather than that it is"
  );
}
assert(
  /cookieless/i.test(privacySrc),
  "privacy.html describes Umami as cookieless if it is enabled"
);

/* Tawk.to is live on this page and sets its own cookies -- that has to be said. */
assert(
  privacySrc.indexOf("tawk.to") !== -1 && /Tawk\.to[\s\S]{0,400}cookies/i.test(privacySrc),
  "privacy.html says the live chat sets its own cookies"
);

/* Browser storage: the cart, wishlist, recently viewed and applied gift card. */
[/wishlist/i, /Your cart/i, /Recently viewed/i, /gift card code you've applied/i].forEach(
  (pattern) => {
    assert(pattern.test(privacySrc), `privacy.html lists ${pattern} among what is stored locally`);
  }
);
assert(
  privacySrc.indexOf("localStorage") !== -1,
  "privacy.html still names localStorage as where that lives"
);

/* Build markers must survive the rewrite, in both comment syntaxes. */
eq(
  (privacySrc.match(/<!--YL:/g) || []).length,
  (privacySrc.match(/<!--\/YL:/g) || []).length,
  "privacy.html HTML build markers stay paired"
);
eq(
  (privacySrc.match(/\/\*YL:/g) || []).length,
  (privacySrc.match(/\/\*\/YL:/g) || []).length,
  "privacy.html script build markers stay paired"
);

/* ---------- Scroll reveal: the paint guard must not be a coin flip ----------
   main.js is the eighth deferred script on these pages, so it starts within a
   few milliseconds either side of the first paint. The old guard asked only
   "has anything painted at all", so which side of that line it landed on
   decided whether the entrance animation played -- and scripts/reveal-check.js
   failed on index.html with "paint entries = 2" and "first .reveal was not
   armed" whenever the coin came up the wrong way. */
assert(typeof main.paintIsStale === "function", "paintIsStale is exported for testing");
eq(main.PAINT_PROTECTION_MS, 200, "the paint-protection budget is 200ms");

eq(
  main.paintIsStale(300, 304),
  false,
  "a paint four milliseconds old is not stale -- nobody has read anything yet"
);
eq(
  main.paintIsStale(300, 300 + main.PAINT_PROTECTION_MS),
  false,
  "a paint exactly at the budget is still inside it"
);
eq(
  main.paintIsStale(300, 300 + main.PAINT_PROTECTION_MS + 1),
  true,
  "a paint past the budget is stale, and what it put on screen is left alone"
);
eq(
  main.paintIsStale(200, 1800),
  true,
  "the slow load -- a script arriving 1.6s after the paint -- still protects"
);

/* The paint buffer is filled asynchronously, so an empty one is not proof of a
   blank page. It is only trusted while the page is young. */
eq(main.paintIsStale(null, 120), false, "no paint reported early on means nothing has painted");
eq(
  main.paintIsStale(null, main.ASSUME_PAINTED_AFTER_MS + 1),
  true,
  "an empty paint buffer a second into the page is not believed"
);
eq(main.paintIsStale(undefined, 50), false, "an absent timestamp early on is not stale");

/* Unusable inputs must fail safe -- toward leaving visible content alone. */
eq(main.paintIsStale(NaN, 500), true, "an unusable paint timestamp is treated as stale");
eq(main.paintIsStale(Infinity, 500), true, "an infinite paint timestamp is treated as stale");
eq(main.paintIsStale(100, NaN), true, "an unusable clock is treated as stale");

assert(
  mainJsSource.indexOf('return performance.getEntriesByType("paint").length > 0;') === -1,
  "hasPainted is no longer a bare 'did anything paint' check"
);
assert(
  mainJsSource.indexOf("return paintIsStale(firstPaintTime, performance.now());") !== -1,
  "hasPainted decides on how old the paint is"
);

/* ---------- H-6: the order status page reports, it does not invent ----------
   The page used to answer any plausible-looking string with "Order Confirmed",
   a four-step timeline, a hardcoded two-item order, a printable packing slip
   and a Reorder button that pushed those invented items into the real cart --
   with no request made anywhere. It now asks a real endpoint and reports what
   comes back; when it cannot, it hands over to a person. These assertions hold
   both halves of that: the fabrication stays gone, and the lookup stays real.

   The branch-by-branch behaviour lives in scripts/order-status-engine.test.js;
   what is asserted here is the shape of the module itself. */
assert(
  mainJsSource.indexOf('var ORDER_STATUS_ENDPOINT = "/api/order-status"') !== -1,
  "main.js posts the lookup to the Worker route, same-origin via the /api/* proxy"
);
["sampleOrderItems", "slipItemsTableBody", "slipGiftMessageText", "reorderPastOrderBtn"].forEach(
  (needle) => {
    assert(
      mainJsSource.indexOf(needle) === -1,
      `main.js no longer references the fabricated ${needle}`
    );
  }
);

/* Every string in the Worker's answer -- Stripe line item names, a
   merchant-typed tracking URL -- reaches the page as text, never as markup. */
assert(
  typeof main.renderOrderStatusResult === "function",
  "renderOrderStatusResult is exported so its source can be gated"
);
assert(
  /innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(
    main.renderOrderStatusResult.toString()
  ) === false,
  "renderOrderStatusResult writes no server string through a markup sink"
);

/* Both fields are required before a request is spent, and the reference is
   Stripe's own shape rather than anything that merely looks like an id. */
eq(
  main.validateOrderLookup("cs_live_abc123", "").ok,
  false,
  "a reference without an email is refused (the email is the other half of the credential)"
);
eq(
  main.validateOrderLookup("", "savanna@example.com").ok,
  false,
  "an email without a reference is refused"
);
eq(
  main.validateOrderLookup("YL-2026-0842", "savanna@example.com").ok,
  false,
  "the invented YL-#### reference format is no longer accepted"
);
eq(
  main.validateOrderLookup("cs_live_abc123", "savanna@example.com").ok,
  true,
  "a Stripe session id plus an email is accepted"
);

/* The one place the site is still allowed to speak without a 200 behind it. */
const handoffHtml = main.orderStatusFallbackHTML("cs_live_abc123");
assert(
  handoffHtml.indexOf("order-lookup-unavailable") !== -1,
  "the hand-off is still the answer when the lookup cannot speak"
);
assert(
  handoffHtml.indexOf("mailto:y.allternative.living@gmail.com") !== -1,
  "the hand-off offers a real person to write to"
);
["Order Confirmed", "In the Workshop", "Quality Sealed", "timeline-step", "Reorder"].forEach(
  (needle) => {
    assert(
      handoffHtml.indexOf(needle) === -1,
      `the hand-off asserts nothing about an order it never fetched: ${needle}`
    );
  }
);

/* ---------- Milestone 2: Dynamic Merchandising & Scoring Engine ---------- */

/* 1. Announcement Bar */
console.log("\n--- Milestone 2: Announcement Bar Tests ---");
assert(typeof main.announcementBar === "function", "main.js exports announcementBar function");

// Test custom message and accent classes
const origContent = mockWindow.YL_CONTENT;
const origProducts = mockWindow.YL_PRODUCTS;

mockWindow.YL_CONTENT = {
  site: {
    announcement: {
      enabled: true,
      text: "Special Spring Drop ✦ Limited Quantities",
      link: "shop.html",
      accent: "moss"
    }
  }
};
mockDocument.body.children.length = 0;
main.announcementBar();
let renderedBar = mockDocument.body.children[0];
assert(renderedBar != null, "announcementBar renders bar into document body");
assert(
  renderedBar && renderedBar.classList.contains("announcement-accent-moss"),
  "announcementBar applies accent-moss class"
);
assert(
  renderedBar && renderedBar.innerHTML.includes("Special Spring Drop ✦ Limited Quantities"),
  "announcementBar renders custom text"
);
assert(
  renderedBar && renderedBar.innerHTML.includes('href="shop.html"'),
  "announcementBar wraps link when provided"
);

// Test disabled announcement
mockWindow.YL_CONTENT = {
  site: {
    announcement: {
      enabled: false,
      text: "Hidden Banner"
    }
  }
};
mockDocument.body.children.length = 0;
main.announcementBar();
eq(mockDocument.body.children.length, 0, "announcementBar renders nothing when enabled is false");

// Test free shipping threshold fallback
mockWindow.YL_CONTENT = { site: { announcement: { enabled: true, text: "" } } };
mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 40 } };
mockDocument.body.children.length = 0;
main.announcementBar();
renderedBar = mockDocument.body.children[0];
assert(renderedBar != null, "announcementBar renders fallback free shipping message");
assert(
  renderedBar && renderedBar.textContent.includes("$40"),
  "announcementBar fallback includes threshold amount"
);

/* 2. Stock Badge Batch Date */
console.log("\n--- Milestone 2: Stock Badge Batch Date Tests ---");
const comingSoonWithBatch = {
  id: "test-preorder",
  name: "Pre-order Salve",
  comingSoon: true,
  estimatedBatchDate: "October 15, 2026"
};
const badgeWithBatchHtml = main.stockBadgeHTML(comingSoonWithBatch);
assert(
  badgeWithBatchHtml.includes('class="stock-badge low-stock">Coming Soon</span>'),
  "stockBadgeHTML renders Coming Soon badge"
);
assert(
  badgeWithBatchHtml.includes(
    'class="stock-badge badge-batch-date">Batch: October 15, 2026</span>'
  ),
  "stockBadgeHTML renders badge-batch-date with estimatedBatchDate"
);

const comingSoonWithoutBatch = {
  id: "test-coming-soon",
  name: "Coming Soon Salve",
  comingSoon: true
};
const badgeWithoutBatchHtml = main.stockBadgeHTML(comingSoonWithoutBatch);
eq(
  badgeWithoutBatchHtml,
  '<span class="stock-badge low-stock">Coming Soon</span>',
  "stockBadgeHTML renders only Coming Soon when estimatedBatchDate is absent"
);

/* 3. Modal Ritual Fallback */
console.log("\n--- Milestone 2: Modal Ritual Fallback Tests ---");
mockWindow.YL_CONTENT = {
  site: {
    ritualDefaults: {
      title: "Botanical Pairing",
      subtitle: "Pair this item with complementary botanicals crafted to work together."
    }
  }
};
const testProductWithoutRitualTitle = {
  id: "sleep-salve",
  name: "Sweet Dreams Sleep Salve",
  price: 14,
  pairsWith: ["lavender-soak"]
};
const testProductMap = new Map([
  ["lavender-soak", { id: "lavender-soak", name: "Lavender Bath Soak", price: 16, stock: 5 }]
]);
const ritualModalHtml = main.renderModalRitualHtml(testProductWithoutRitualTitle, testProductMap);
assert(
  ritualModalHtml.includes("✦ Complete the Ritual: Botanical Pairing ✦"),
  "renderModalRitualHtml uses ritualDefaults.title fallback when ritualTitle is not set"
);
assert(
  ritualModalHtml.includes(
    "Pair this item with complementary botanicals crafted to work together."
  ),
  "renderModalRitualHtml includes ritualDefaults.subtitle"
);

// Restore original globals
mockWindow.YL_CONTENT = origContent;
mockWindow.YL_PRODUCTS = origProducts;

/* 4. Dynamic Apothecary Quiz Scoring */
console.log("\n--- Milestone 2: Apothecary Quiz Scoring Tests ---");
assert(
  typeof main.initApothecaryQuiz === "function",
  "main.js exports initApothecaryQuiz function"
);

// Setup mock DOM for apothecary quiz
const quizSection = createMockElement("section");
quizSection.id = "apothecary-quiz-section";
elementsById.set("apothecary-quiz-section", quizSection);

const quizModal = createMockElement("dialog");
quizModal.id = "apothecary-quiz-modal";
elementsById.set("apothecary-quiz-modal", quizModal);

const openBtn = createMockElement("button");
openBtn.id = "open-apothecary-quiz-btn";
elementsById.set("open-apothecary-quiz-btn", openBtn);

const closeBtn = createMockElement("button");
closeBtn.id = "close-apothecary-quiz-modal";
elementsById.set("close-apothecary-quiz-modal", closeBtn);

const resetBtn = createMockElement("button");
resetBtn.id = "start-apothecary-quiz-btn";
elementsById.set("start-apothecary-quiz-btn", resetBtn);

const resultsContainer = createMockElement("div");
resultsContainer.id = "quiz-results-container";
elementsById.set("quiz-results-container", resultsContainer);

const step1El = createMockElement("div");
step1El.id = "quiz-step-1";
step1El.classList.add("quiz-step");
elementsById.set("quiz-step-1", step1El);

const step2El = createMockElement("div");
step2El.id = "quiz-step-2";
step2El.classList.add("quiz-step");
elementsById.set("quiz-step-2", step2El);

const submitBtn = createMockElement("button");
submitBtn.id = "quiz-submit-btn";
elementsById.set("quiz-submit-btn", submitBtn);

// Mock quiz config in window.YL_CONTENT
mockWindow.YL_CONTENT = {
  site: {
    enableLoyaltyPoints: true,
    loyaltyBadgeEmoji: "✨",
    loyaltyPointsPerDollar: 1,
    loyaltyPointsName: "Alt-Points"
  },
  quiz: {
    questions: [
      {
        id: "mood",
        name: "quiz-mood",
        options: [
          {
            value: "calm",
            label: "Calm",
            scoreWeight: 10,
            recommendedProductIds: ["sleep-salve"]
          }
        ]
      }
    ]
  }
};

mockWindow.YL_PRODUCTS = {
  products: [
    {
      id: "sleep-salve",
      name: "Sweet Dreams Sleep Salve",
      price: 14,
      category: "salves",
      stock: 10,
      blurb: "Herbal sleep salve with lavender and cedar."
    },
    {
      id: "bath-tea",
      name: "Botanical Bath Tea",
      price: 12,
      category: "soaks",
      stock: 5,
      blurb: "Herbal bath tea soak."
    }
  ],
  bundles: []
};

// Mock radio selection in quizSection
const mockRadioInput = createMockElement("input");
mockRadioInput.checked = true;
mockRadioInput.value = "calm";
quizSection.querySelector = (sel) => {
  if (sel.includes('input[name="quiz-mood"]:checked')) return mockRadioInput;
  if (sel.includes('input[name="quiz-vibe"]:checked')) return { value: "gothic-calm" };
  if (sel.includes('input[name="quiz-need"]:checked')) return { value: "hydration" };
  if (sel.includes('input[name="quiz-intent"]:checked')) return { value: "treat-myself" };
  return null;
};
quizSection.querySelectorAll = (sel) => {
  if (sel === ".quiz-step") return [step1El, step2El];
  return [];
};

// Initialize quiz
main.initApothecaryQuiz();

// Simulate clicking the submit button
quizSection.dispatchEvent({
  type: "click",
  target: submitBtn
});

assert(resultsContainer.style.display === "block", "Submitting quiz displays results container");
assert(
  resultsContainer.innerHTML.includes("Sweet Dreams Sleep Salve"),
  "Quiz dynamically recommends highest scored product based on questions config"
);
assert(
  resultsContainer.innerHTML.includes("quiz-recommended-card"),
  "Quiz renders .quiz-recommended-card prescription card"
);
assert(
  resultsContainer.innerHTML.includes("Add Recommendation to Cart ($14.00)"),
  "Quiz renders add-to-cart button with price"
);
assert(
  resultsContainer.innerHTML.includes('Earn <span class="pts-val">14</span> Alt-Points'),
  "Quiz renders loyalty points badge"
);

console.log(`\nmain.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
