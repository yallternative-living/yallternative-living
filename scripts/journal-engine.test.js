/**
 * @fileoverview Unit tests for Milestone 4: Apothecary Journal & Content Hub.
 * Tests reading time calculation, topical tag rendering, featured mini-product card resolution
 * and 1-click cart markup, RSS 2.0 XML feed generation, and head alternate link integrity.
 *
 * Run: node scripts/journal-engine.test.js
 */

const fs = require("fs");
const path = require("path");

// Mock browser environment for Node.js test execution
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
    insertBefore: (newNode) => {
      children.unshift(newNode);
      return newNode;
    },
    firstChild: null,
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
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
    href: "https://yallternativeliving.com/journal.html",
    hash: "",
    search: "",
    pathname: "/journal.html",
    hostname: "yallternativeliving.com",
    origin: "https://yallternativeliving.com"
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const productsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/products.json"), "utf8")
);
const journalData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/journal.json"), "utf8")
);
const configYml = fs.readFileSync(path.join(__dirname, "../admin/config.yml"), "utf8");

global.window.YL_PRODUCTS = productsData;
global.window.YL_JOURNAL = journalData;

const main = require("../assets/js/main.js");
const buildSiteDataModule = require("./build-site-data.js");

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

console.log("Starting Milestone 4 Apothecary Journal Engine Tests...\n");

// ============================================================================
// 1. Reading Time Calculation Tests
// ============================================================================
console.log("--- 1. Reading Time Calculation ---");

const postWithExplicitReadingTime = {
  id: "test-post-1",
  title: "Test Post",
  readingTime: "4 min read",
  content: "Short content"
};
eq(
  main.getReadingTime(postWithExplicitReadingTime),
  "4 min read",
  "Returns explicit readingTime when provided in post object"
);

const words200 = new Array(200).fill("word").join(" ");
const postCalculated200 = {
  id: "test-post-2",
  title: "Calculated Post",
  content: words200
};
eq(main.getReadingTime(postCalculated200), "1 min read", "Calculates 1 min read for 200 words");

const words500 = new Array(500).fill("botanical").join(" ");
const postCalculated500 = {
  id: "test-post-3",
  title: "Calculated Post 500",
  content: words500
};
eq(
  main.getReadingTime(postCalculated500),
  "3 min read",
  "Calculates 3 min read for 500 words (ceil(500/200) = 3)"
);

const emptyPost = {
  id: "test-post-4",
  title: "Empty Post",
  content: ""
};
eq(main.getReadingTime(emptyPost), "1 min read", "Returns minimum 1 min read for empty content");

eq(main.getReadingTime(null), "1 min read", "Returns safe fallback for null post");

// ============================================================================
// 2. Topical Tags Rendering Tests
// ============================================================================
console.log("\n--- 2. Topical Tags Rendering ---");

const tagsSample = ["Apothecary", "Botanical Care", "Self-Care"];
const tagsHtml = main.renderJournalTagsHtml(tagsSample);

assert(
  tagsHtml.includes('class="journal-tags"'),
  "Renders container element with journal-tags class"
);
assert(
  tagsHtml.includes('class="journal-tag journal-tag-pill"'),
  "Renders interactive buttons with journal-tag and journal-tag-pill classes"
);
assert(tagsHtml.includes('data-tag="Apothecary"'), "Sets data-tag attribute for Apothecary");
assert(
  tagsHtml.includes('data-tag="Botanical Care"'),
  "Sets data-tag attribute for Botanical Care"
);
assert(tagsHtml.includes('data-tag="Self-Care"'), "Sets data-tag attribute for Self-Care");

const xssTags = ['<script>alert("xss")</script>', "Quotes \" & ' < >"];
const xssTagsHtml = main.renderJournalTagsHtml(xssTags);
assert(!xssTagsHtml.includes("<script>"), "Escapes script tags inside tag names");
assert(xssTagsHtml.includes("&lt;script&gt;"), "Properly HTML-escapes tag text");

eq(main.renderJournalTagsHtml([]), "", "Returns empty string for empty tags array");
eq(main.renderJournalTagsHtml(null), "", "Returns empty string for null tags");

// ============================================================================
// 3. Featured Product Resolution Tests
// ============================================================================
console.log("\n--- 3. Featured Product Resolution ---");

const directProduct = main.findFeaturedProduct("sleep-salve");
assert(
  directProduct !== null && directProduct.id === "sleep-salve",
  "Resolves direct product ID: sleep-salve"
);

const aliasMagnesium = main.findFeaturedProduct("magnesium-body-butter");
assert(
  aliasMagnesium !== null && aliasMagnesium.id === "sleep-salve",
  "Resolves alias 'magnesium-body-butter' to sleep-salve"
);

const aliasPineTar = main.findFeaturedProduct("pine-tar-salve");
assert(
  aliasPineTar !== null && aliasPineTar.id === "frankincense-salve",
  "Resolves alias 'pine-tar-salve' to frankincense-salve"
);

const directShea = main.findFeaturedProduct("shea-butter");
assert(
  directShea !== null && directShea.id === "shea-butter",
  "Resolves direct product ID: shea-butter"
);

const nonExistent = main.findFeaturedProduct("non-existent-product-id-9999");
assert(nonExistent === null, "Returns null for completely unknown product ID");

assert(main.findFeaturedProduct(null) === null, "Returns null for null product ID");

// ============================================================================
// 4. "Featured in this Article" Mini-Product Card Markup Tests
// ============================================================================
console.log("\n--- 4. Featured Mini-Product Card Markup ---");

const featuredCardSleep = main.renderFeaturedProductCardHtml("sleep-salve");

assert(
  featuredCardSleep.includes('class="journal-featured-card reveal"'),
  "Renders container with .journal-featured-card class"
);
assert(
  featuredCardSleep.includes('class="journal-featured-inner"'),
  "Renders inner wrapper with .journal-featured-inner class"
);
assert(
  featuredCardSleep.includes('class="journal-featured-thumb"'),
  "Renders thumbnail with .journal-featured-thumb class"
);
assert(
  featuredCardSleep.includes("Featured in this Article"),
  "Displays 'Featured in this Article' pill badge"
);
assert(
  featuredCardSleep.includes("Hush Y&#39;all Magnesium Arnica Sleep Salve") ||
    featuredCardSleep.includes("Hush Y'all Magnesium Arnica Sleep Salve"),
  "Renders product name"
);
assert(
  featuredCardSleep.includes('href="shop.html#sleep-salve"'),
  "Renders link to shop.html#sleep-salve"
);
assert(featuredCardSleep.includes("$19.99"), "Renders product price formatted with dollar sign");
assert(featuredCardSleep.includes("Lavender"), "Renders product scent badge");
assert(
  featuredCardSleep.includes("btn btn-sm btn-primary yl-add-item"),
  "Renders 1-click add-to-cart button with .yl-add-item class"
);
assert(
  featuredCardSleep.includes('data-item-id="sleep-salve"'),
  "Button contains data-item-id attribute"
);
assert(
  featuredCardSleep.includes('data-item-price="19.99"'),
  "Button contains data-item-price attribute"
);
assert(
  featuredCardSleep.includes('data-item-categories="salves"'),
  "Button contains data-item-categories attribute"
);
assert(featuredCardSleep.includes("+ Add to Cart"), "Button displays '+ Add to Cart' label");

const featuredCardMagnesium = main.renderFeaturedProductCardHtml("magnesium-body-butter");
assert(
  featuredCardMagnesium.includes('data-item-id="sleep-salve"'),
  "Featured card for alias 'magnesium-body-butter' renders valid 1-click cart button for sleep-salve"
);

eq(
  main.renderFeaturedProductCardHtml("invalid-id-xyz"),
  "",
  "Returns empty string for invalid product ID"
);

// ============================================================================
// 5. RSS 2.0 XML Feed Generation Tests
// ============================================================================
console.log("\n--- 5. RSS 2.0 XML Feed Generation ---");

const rssFeed = buildSiteDataModule.generateRssFeed(journalData, "https://yallternativeliving.com");

assert(
  rssFeed.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
  "RSS feed starts with valid XML declaration"
);
assert(
  rssFeed.includes('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">'),
  "RSS feed contains valid RSS 2.0 root element with atom namespace"
);
assert(rssFeed.includes("<channel>"), "RSS feed contains <channel> element");
assert(
  rssFeed.includes("<title>Apothecary Journal | Y'allternative Living</title>") ||
    rssFeed.includes("<title>Y'allternative Living Journal RSS Feed</title>"),
  "RSS feed contains valid channel title"
);
assert(
  rssFeed.includes("<link>https://yallternativeliving.com/journal.html</link>"),
  "RSS feed contains channel link to /journal.html"
);
assert(rssFeed.includes("<language>en-us</language>"), "RSS feed contains language tag");
assert(rssFeed.includes("<lastBuildDate>"), "RSS feed contains <lastBuildDate> timestamp");
assert(
  rssFeed.includes(
    '<atom:link href="https://yallternativeliving.com/feed.xml" rel="self" type="application/rss+xml"/>'
  ) ||
    rssFeed.includes(
      '<atom:link href="https://yallternativeliving.com/feed.xml" rel="self" type="application/rss+xml" />'
    ),
  "RSS feed contains atom:link rel='self'"
);

// Check journal items
journalData.posts.forEach((post) => {
  const postSlug = post.id || post.slug;
  const postUrl = `https://yallternativeliving.com/journal.html#post-${postSlug}`;

  assert(
    rssFeed.includes(`<link>${postUrl}</link>`),
    `RSS feed contains <link> for post: ${postSlug}`
  );
  assert(
    rssFeed.includes(`<guid isPermaLink="true">${postUrl}</guid>`),
    `RSS feed contains permalink <guid> for post: ${postSlug}`
  );

  if (Array.isArray(post.tags)) {
    post.tags.forEach((tag) => {
      assert(
        rssFeed.includes(`<category>${tag}</category>`),
        `RSS feed contains <category>${tag}</category> for post: ${postSlug}`
      );
    });
  }

  const postDate = new Date(post.date);
  assert(!isNaN(postDate.getTime()), `Post date for ${postSlug} parses to valid Date`);
});

// ============================================================================
// 6. Config YML and HTML Head Alternate Link Integrity
// ============================================================================
console.log("\n--- 6. Config YML and Head Alternate Link Integrity ---");

assert(
  configYml.includes("name: readingTime"),
  "admin/config.yml defines readingTime under journal collection"
);
assert(configYml.includes("name: tags"), "admin/config.yml defines tags under journal collection");
assert(
  configYml.includes("name: featuredProductId"),
  "admin/config.yml defines featuredProductId relation under journal collection"
);

const journalHtml = fs.readFileSync(path.join(__dirname, "../journal.html"), "utf8");
assert(
  journalHtml.includes('rel="alternate"') &&
    journalHtml.includes('type="application/rss+xml"') &&
    journalHtml.includes('href="https://yallternativeliving.com/feed.xml"'),
  "journal.html contains RSS alternate link in <head>"
);

console.log("\n==================================================");
if (failed > 0) {
  console.error(`Journal Engine Tests: ${passed} passed, ${failed} failed.`);
  process.exit(1);
} else {
  console.log(`Journal Engine Tests: ${passed} passed, 0 failed.`);
  console.log("All Milestone 4 journal engine tests passed!\n");
}
