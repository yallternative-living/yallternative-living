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

// --- backward compatibility: a post written before Markdown support existed
// must produce byte-for-byte the same HTML it always did. Checked against
// the real posts in assets/data/journal.json, not a hand-written fixture.
const realPosts = require("../assets/data/journal.json").posts;
const legacyRender = (content) =>
  content
    .split("\n\n")
    .map((p) => "<p>" + main.attrEsc(p) + "</p>")
    .join("");
assert(realPosts.length > 0, "journal.json has at least one real post to check against");
realPosts.forEach((post) => {
  eq(
    main.renderMarkdown(post.content),
    legacyRender(post.content),
    'renderMarkdown renders the existing "' + post.id + '" post exactly as the old code did'
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

console.log(`\nmain.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
