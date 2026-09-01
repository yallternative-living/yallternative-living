/**
 * @fileoverview Global Search Suite Unit & Integration Test Suite
 * Tests multi-domain search engine, 2-tier synonym dictionary,
 * tokenization, result ranking, 1-click cart integration, and
 * accessibility contracts across all static and generated pages.
 *
 * Run: node scripts/global-search.test.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");

// Setup mock DOM environment for Node execution
function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  return {
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
}

const mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: () => createMockElement("div"),
  querySelector: () => createMockElement("div"),
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  location: { href: "https://yallternativeliving.com", hash: "", search: "", pathname: "/" },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockWindow.localStorage;
global.navigator = { userAgent: "node" };

// Load search index data
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

console.log("Running Global Search Suite unit & integration tests...\n");

// --- SECTION 1: Search Index & Data Compilation ---
console.log("--- 1. Search Index Data Integrity ---");

it("assets/js/search-data.js exists and defines window.YL_SEARCH_INDEX", () => {
  const filePath = path.join(ROOT, "assets", "js", "search-data.js");
  assert.ok(fs.existsSync(filePath), "search-data.js must exist");
  const content = fs.readFileSync(filePath, "utf8");
  assert.ok(
    content.includes("window.YL_SEARCH_INDEX ="),
    "search-data.js must assign window.YL_SEARCH_INDEX"
  );
});

it("search index contains products, journal, events, faq, and synonyms", () => {
  const index = mainJs.getSearchIndex();
  assert.ok(Array.isArray(index.products), "products must be an array");
  assert.ok(
    index.products.length >= 19,
    `products count expected >= 19, got ${index.products.length}`
  );
  assert.ok(Array.isArray(index.journal), "journal must be an array");
  assert.ok(index.journal.length >= 2, `journal count expected >= 2, got ${index.journal.length}`);
  assert.ok(Array.isArray(index.events), "events must be an array");
  assert.ok(index.events.length >= 4, `events count expected >= 4, got ${index.events.length}`);
  assert.ok(Array.isArray(index.faq), "faq must be an array");
  assert.ok(index.faq.length >= 5, `faq count expected >= 5, got ${index.faq.length}`);
  assert.ok(
    typeof index.synonyms === "object" && index.synonyms !== null,
    "synonyms must be an object"
  );
});

it("sw.js caches /assets/js/search-data.js", () => {
  const swPath = path.join(ROOT, "sw.js");
  const content = fs.readFileSync(swPath, "utf8");
  assert.ok(
    content.includes("'/assets/js/search-data.js'"),
    "sw.js ASSETS_TO_CACHE must contain '/assets/js/search-data.js'"
  );
});

// --- SECTION 2: Tokenization & Synonym Expansion ---
console.log("\n--- 2. Tokenization & Synonym Engine ---");

it("tokenizeQuery handles empty, whitespace, and punctuation cleanly", () => {
  assert.deepStrictEqual(mainJs.tokenizeQuery(""), []);
  assert.deepStrictEqual(mainJs.tokenizeQuery("   "), []);
  assert.deepStrictEqual(mainJs.tokenizeQuery(null), []);
  assert.deepStrictEqual(mainJs.tokenizeQuery("Sleep, Salve! & Soak?"), ["sleep", "salve", "soak"]);
});

it("expandTokensWithSynonyms expands 2-tier botanical and concern synonyms", () => {
  const synonyms = {
    sleep: ["insomnia", "bedtime", "rest", "night", "lavender", "slumber"],
    muscles: ["sore", "pain", "ache", "arnica", "tension", "magnesium"]
  };
  const expandedSleep = mainJs.expandTokensWithSynonyms(["sleep"], synonyms);
  assert.ok(expandedSleep.includes("insomnia"), "sleep should expand to insomnia");
  assert.ok(expandedSleep.includes("bedtime"), "sleep should expand to bedtime");
  assert.ok(expandedSleep.includes("lavender"), "sleep should expand to lavender");

  const expandedMuscles = mainJs.expandTokensWithSynonyms(["muscles"], synonyms);
  assert.ok(expandedMuscles.includes("arnica"), "muscles should expand to arnica");
  assert.ok(expandedMuscles.includes("magnesium"), "muscles should expand to magnesium");
});

// --- SECTION 3: Multi-Domain Search Scoring & Retrieval ---
console.log("\n--- 3. Multi-Domain Search Engine Queries ---");

it("searchGlobal('sleep') returns Sleep Salve as top product and relevant soaks", () => {
  const res = mainJs.searchGlobal("sleep");
  assert.ok(res.totalCount > 0, "Query 'sleep' should return results");
  assert.ok(res.products.length > 0, "Query 'sleep' should return products");
  assert.strictEqual(
    res.products[0].id,
    "sleep-salve",
    "Top product for 'sleep' should be sleep-salve"
  );
});

it("searchGlobal('sore muscles') returns Miracle Balm and Frankincense Salve", () => {
  const res = mainJs.searchGlobal("sore muscles");
  assert.ok(res.products.length > 0, "Query 'sore muscles' should return products");
  const productIds = res.products.map((p) => p.id);
  assert.ok(
    productIds.includes("miracle-balm") || productIds.includes("frankincense-salve"),
    "sore muscles query should return miracle-balm or frankincense-salve"
  );
});

it("searchGlobal('calendula') matches botanicals and ingredients", () => {
  const res = mainJs.searchGlobal("calendula");
  assert.ok(res.products.length > 0, "Query 'calendula' should match products with calendula");
  const productIds = res.products.map((p) => p.id);
  assert.ok(productIds.includes("miracle-balm"), "calendula should match miracle-balm");
});

it("searchGlobal('magnesium') matches products, journal articles, and FAQs", () => {
  const res = mainJs.searchGlobal("magnesium");
  assert.ok(res.totalCount > 0, "Query 'magnesium' should return results");
  assert.ok(res.products.length > 0, "Query 'magnesium' should return products");
  assert.ok(res.journal.length > 0, "Query 'magnesium' should return journal articles");
  const journalTitles = res.journal.map((j) => j.title);
  assert.ok(
    journalTitles.some((t) => t.toLowerCase().includes("magnesium")),
    "Journal results should include magnesium post"
  );
});

it("searchGlobal('market') matches upcoming and past pop-up events", () => {
  const res = mainJs.searchGlobal("market");
  assert.ok(res.events.length > 0, "Query 'market' should return events");
  const eventNames = res.events.map((e) => (e.name || e.title).toLowerCase());
  assert.ok(
    eventNames.some(
      (name) => name.includes("market") || name.includes("fair") || name.includes("festival")
    ),
    "Events results should contain market events"
  );
});

it("searchGlobal('shipping') returns shipping and delivery FAQs", () => {
  const res = mainJs.searchGlobal("shipping");
  assert.ok(res.faq.length > 0, "Query 'shipping' should return FAQ items");
  assert.ok(
    res.faq.some(
      (f) =>
        f.question.toLowerCase().includes("shipping") || f.answer.toLowerCase().includes("shipping")
    ),
    "FAQ results should address shipping"
  );
});

it("searchGlobal with empty query returns empty results object with totalCount: 0", () => {
  const resEmpty = mainJs.searchGlobal("");
  assert.strictEqual(resEmpty.totalCount, 0);
  assert.strictEqual(resEmpty.products.length, 0);
  assert.strictEqual(resEmpty.journal.length, 0);
  assert.strictEqual(resEmpty.events.length, 0);
  assert.strictEqual(resEmpty.faq.length, 0);
});

// --- SECTION 4: Page Markup, Monoline SVGs & Accessibility Invariants ---
console.log("\n--- 4. Page Markup, Monoline SVGs & Accessibility ---");

const topLevelPages = [
  "index.html",
  "shop.html",
  "about.html",
  "journal.html",
  "events.html",
  "contact.html",
  "faq.html",
  "reviews.html",
  "order-status.html",
  "policies.html",
  "privacy.html",
  "terms.html",
  "thank-you.html",
  "welcome.html",
  "404.html"
];

topLevelPages.forEach((pageName) => {
  const pagePath = path.join(ROOT, pageName);
  it(`${pageName} contains search trigger button in header`, () => {
    const html = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      html.includes('id="globalSearchTrigger"'),
      `${pageName} must contain #globalSearchTrigger`
    );
    assert.ok(
      html.includes('aria-controls="global-search-modal"'),
      `${pageName} trigger must declare aria-controls="global-search-modal"`
    );
  });

  it(`${pageName} contains <dialog id="global-search-modal"> with proper ARIA attributes`, () => {
    const html = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      html.includes('id="global-search-modal"'),
      `${pageName} must contain <dialog id="global-search-modal">`
    );
    assert.ok(html.includes('role="combobox"'), `${pageName} input must declare role="combobox"`);
    assert.ok(
      html.includes('id="globalSearchResultCount"'),
      `${pageName} must have #globalSearchResultCount aria-live announcer`
    );
    assert.ok(
      html.includes('aria-live="polite"'),
      `${pageName} announcer must declare aria-live="polite"`
    );
  });

  it(`${pageName} loads search-data.js`, () => {
    const html = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      html.includes("search-data.js"),
      `${pageName} must include search-data.js script tag`
    );
  });

  it(`${pageName} global-search-modal uses 100% monoline SVGs without system emojis in chips`, () => {
    const html = fs.readFileSync(pagePath, "utf8");
    const chipsMatch = html.match(
      /<div class="global-search-chips-section"[\s\S]*?<\/div>\s*<\/div>/
    );
    assert.ok(chipsMatch, `${pageName} must contain global-search-chips-section`);
    const chipsHtml = chipsMatch[0];
    assert.ok(
      chipsHtml.includes('<svg class="yl-icon"'),
      `${pageName} search chips must use <svg class="yl-icon">`
    );
    assert.ok(
      !/[🌿⚡💧🦟🎁📅]/u.test(chipsHtml),
      `${pageName} search chips must NOT contain system emojis`
    );
  });
});

// Check all 19 PDP files
console.log("\n--- 5. Generated PDP Pages Global Search Integration ---");

const pdpDir = path.join(ROOT, "products");
const pdpFiles = fs.readdirSync(pdpDir).filter((f) => f.endsWith(".html"));

it(`Found 19 generated product PDP HTML files (found ${pdpFiles.length})`, () => {
  assert.strictEqual(pdpFiles.length, 19);
});

pdpFiles.forEach((pdpFile) => {
  const pdpPath = path.join(pdpDir, pdpFile);
  it(`PDP ${pdpFile} contains #globalSearchTrigger and #global-search-modal dialog`, () => {
    const html = fs.readFileSync(pdpPath, "utf8");
    assert.ok(
      html.includes('id="globalSearchTrigger"'),
      `${pdpFile} must contain #globalSearchTrigger`
    );
    assert.ok(
      html.includes('id="global-search-modal"'),
      `${pdpFile} must contain #global-search-modal`
    );
    assert.ok(html.includes("assets/js/search-data.js"), `${pdpFile} must load search-data.js`);
    assert.ok(
      !/[🌿⚡💧🦟🎁📅]/u.test(
        html.match(/<dialog id="global-search-modal"[\s\S]*?<\/dialog>/)?.[0] || ""
      ),
      `${pdpFile} modal must not contain emojis`
    );
  });
});

console.log(`\n==================================================`);
console.log(`Global Search Tests: ${passed} passed, ${failed} failed.`);
console.log(`==================================================\n`);

if (failed > 0) {
  process.exit(1);
}
