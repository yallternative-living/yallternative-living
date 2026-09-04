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

/* The Journal is a CMS switch. With site.enableJournal false the build leaves
   journal entries out of search-data.js altogether, so every journal
   expectation below is derived from the flag rather than hardcoded -- a test
   that assumes one setting fails the moment the shop owner flips it, and
   passing for that reason tells us nothing about the search engine. */
const siteConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "data", "content.json"), "utf8")
);
const JOURNAL_ENABLED = !!(siteConfig.site && siteConfig.site.enableJournal);

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
/* Surface 4's word list, read rather than re-typed: the compliance section
   below pins the shop-grid tables against it. */
const searchRules = require(path.join(ROOT, "scripts", "lib", "search-enrichment-rules.js"));

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
  if (JOURNAL_ENABLED) {
    assert.ok(
      index.journal.length >= 2,
      `journal count expected >= 2, got ${index.journal.length}`
    );
  } else {
    assert.strictEqual(
      index.journal.length,
      0,
      `journal is switched off, so the index must carry no articles, got ${index.journal.length}`
    );
  }
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
  /* The fixture is lay vocabulary because the shipped table is: "insomnia"
     and "pain" used to stand here and are medicalQueryTerms words now (brief
     7(b)). The mechanism under test is unchanged. */
  const synonyms = {
    sleep: ["restless", "bedtime", "rest", "night", "lavender", "slumber"],
    muscles: ["sore", "tension", "ache", "arnica", "stiffness", "magnesium"]
  };
  const expandedSleep = mainJs.expandTokensWithSynonyms(["sleep"], synonyms);
  assert.ok(expandedSleep.includes("restless"), "sleep should expand to restless");
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

it("searchGlobal('magnesium') matches products", () => {
  const res = mainJs.searchGlobal("magnesium");
  assert.ok(res.totalCount > 0, "Query 'magnesium' should return results");
  assert.ok(res.products.length > 0, "Query 'magnesium' should return products");
});

/* The journal domain of the engine is exercised against a synthetic index, not
   the generated one: whether search-data.js carries articles depends on the
   Journal switch, and an engine test that quietly stops testing anything the
   day a shop owner flips a toggle is worse than no test. */
it("searchGlobal reaches the journal domain (synthetic index)", () => {
  const realIndex = mockWindow.YL_SEARCH_INDEX;
  mockWindow.YL_SEARCH_INDEX = {
    version: "test",
    products: [],
    journal: [
      {
        id: "magnesium-post",
        title: "Why Magnesium Belongs In Your Sleep Salve",
        excerpt: "Magnesium and arnica, and why we reach for them at bedtime.",
        tags: ["magnesium", "sleep"],
        url: "journal.html#magnesium-post"
      }
    ],
    events: [],
    faq: [],
    synonyms: {}
  };
  mainJs._resetState();
  try {
    const res = mainJs.searchGlobal("magnesium");
    assert.ok(res.journal.length > 0, "a matching article must surface in the journal domain");
    assert.ok(
      res.journal.map((j) => j.title).some((t) => t.toLowerCase().includes("magnesium")),
      "the matching article is the one returned"
    );
  } finally {
    mockWindow.YL_SEARCH_INDEX = realIndex;
    mainJs._resetState();
  }
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

it("every standalone product result links to products/<id>.html and carries a numeric price", () => {
  // A handful of real, varied queries -- not just one -- so a regression in
  // one product's data doesn't hide behind a single passing query. Curated
  // bundles (id prefixed "bundle-") intentionally link to their shop.html
  // anchor instead -- they have no standalone PDP page -- so they're
  // excluded here rather than asserted against the wrong destination.
  const queries = ["sleep", "sore muscles", "magnesium", "gift card", "bug spray"];
  const seen = [];
  queries.forEach((q) => {
    const res = mainJs.searchGlobal(q);
    res.products.filter((p) => !String(p.id).startsWith("bundle-")).forEach((p) => seen.push(p));
  });
  assert.ok(
    seen.length > 0,
    "at least one standalone product result was returned across the sample queries"
  );
  seen.forEach((p) => {
    assert.ok(
      typeof p.url === "string" && p.url.startsWith(`products/${p.id}.html`),
      `product '${p.id}' must link to products/${p.id}.html, got '${p.url}'`
    );
    assert.ok(
      p.url.indexOf("shop.html#") === -1,
      `product '${p.id}' must not link to the retired shop.html#id anchor form`
    );
    assert.ok(
      typeof p.price === "number" && p.price >= 0,
      `product '${p.id}' must carry a numeric price, got ${JSON.stringify(p.price)}`
    );
  });
});

it("renderNoResultsHtml suggests the full shop and the contact page", () => {
  const html = mainJs.renderNoResultsHtml("zzznonexistentquery");
  assert.ok(html.includes("zzznonexistentquery"), "echoes the searched query back to the shopper");
  assert.ok(html.includes('href="/shop.html"'), "links to the full shop catalog");
  assert.ok(html.includes('href="/contact.html"'), "links to the contact page");
  assert.ok(html.includes("search-empty-suggestions"), "keeps the existing popular-search chips");
});

it("renderNoResultsHtml escapes a hostile query rather than injecting it as markup", () => {
  const html = mainJs.renderNoResultsHtml("<img src=x onerror=alert(1)>");
  assert.ok(
    html.indexOf("<img src=x") === -1,
    "a raw hostile query never reaches the DOM as markup"
  );
  assert.ok(html.indexOf("&lt;img") !== -1, "the query is HTML-escaped instead");
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

// Check every PDP file (one per product in products.json)
console.log("\n--- 5. Generated PDP Pages Global Search Integration ---");

const pdpDir = path.join(ROOT, "products");
const pdpFiles = fs.readdirSync(pdpDir).filter((f) => f.endsWith(".html"));

const PRODUCT_COUNT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "data", "products.json"), "utf8")
).products.length;
it(`Found ${PRODUCT_COUNT} generated product PDP HTML files (found ${pdpFiles.length})`, () => {
  assert.strictEqual(pdpFiles.length, PRODUCT_COUNT);
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

// --- SECTION 6: Inline Variant Chip Picker Unit Contracts ---
console.log("\n--- 6. Search Inline Variant Chip Picker (R2) ---");

it("formatVariantChipLabel computes delta prices and formats labels accurately", () => {
  const frankincense = {
    id: "frankincense-salve",
    name: "Frankincense Salve",
    price: 19.99,
    variants: {
      name: "Size",
      options: [
        { label: "2oz", priceDelta: 0 },
        { label: "1oz", priceDelta: -6 }
      ]
    }
  };

  assert.strictEqual(
    mainJs.formatVariantChipLabel(frankincense, frankincense.variants.options[0]),
    "2oz - $19.99"
  );
  assert.strictEqual(
    mainJs.formatVariantChipLabel(frankincense, frankincense.variants.options[1]),
    "1oz - $13.99"
  );

  const tankTop = {
    id: "tank-top",
    name: "Tank Top",
    price: 30.0,
    variants: {
      name: "Size",
      options: [
        { label: "S", priceDelta: 0, soldOut: true },
        { label: "M", priceDelta: 0 },
        { label: "L", priceDelta: 0 }
      ]
    }
  };

  assert.strictEqual(mainJs.formatVariantChipLabel(tankTop, tankTop.variants.options[0]), "S");
  assert.strictEqual(mainJs.formatVariantChipLabel(tankTop, tankTop.variants.options[1]), "M");

  const giftCard = {
    id: "yallternative-gift-card",
    name: "Gift Card",
    price: 10.0,
    variants: {
      name: "Amount",
      options: [
        { label: "$10", priceDelta: 0 },
        { label: "$25", priceDelta: 15 },
        { label: "$50", priceDelta: 40 }
      ]
    }
  };

  assert.strictEqual(mainJs.formatVariantChipLabel(giftCard, giftCard.variants.options[1]), "$25");
  assert.strictEqual(mainJs.formatVariantChipLabel(giftCard, giftCard.variants.options[2]), "$50");
});

it("renderVariantChipsHtml emits accessible radiogroup with ARIA roles, chips, and price deltas", () => {
  const frankincense = {
    id: "frankincense-salve",
    name: "Frankincense Salve",
    price: 19.99,
    variants: {
      name: "Size",
      options: [
        { label: "2oz", priceDelta: 0 },
        { label: "1oz", priceDelta: -6 }
      ]
    }
  };

  const html = mainJs.renderVariantChipsHtml(frankincense);
  assert.ok(html.includes('role="radiogroup"'), "Variant picker must declare role='radiogroup'");
  assert.ok(
    html.includes('aria-label="Size for Frankincense Salve"'),
    "Radiogroup must declare descriptive aria-label"
  );
  assert.ok(html.includes('role="radio"'), "Variant chips must declare role='radio'");
  assert.ok(html.includes('aria-checked="false"'), "Variant chips must declare aria-checked");
  assert.ok(html.includes('data-variant-name="Size"'), "Chips must carry data-variant-name");
  assert.ok(html.includes('data-variant-label="1oz"'), "Chips must carry data-variant-label");
  assert.ok(html.includes('data-variant-delta="-6"'), "Chips must carry data-variant-delta");
  assert.ok(html.includes('data-price="13.99"'), "Chips must carry calculated unit data-price");
  assert.ok(html.includes("1oz - $13.99"), "1oz chip must display formatted price label");
});

it("renderVariantChipsHtml handles sold-out options with disabled state and class", () => {
  const tankTop = {
    id: "tank-top",
    name: "Tank Top",
    price: 30.0,
    variants: {
      name: "Size",
      options: [
        { label: "S", priceDelta: 0, soldOut: true },
        { label: "M", priceDelta: 0 }
      ]
    }
  };

  const html = mainJs.renderVariantChipsHtml(tankTop);
  assert.ok(html.includes("is-sold-out"), "Sold out option must include .is-sold-out class");
  assert.ok(
    html.includes('disabled aria-disabled="true"'),
    "Sold out option must include disabled and aria-disabled attributes"
  );
  assert.ok(html.includes("S (Sold Out)"), "Sold out chip must display (Sold Out) text");
});

it("renderVariantChipsHtml returns empty string for single-option or non-variant items", () => {
  const singleItem = {
    id: "sleep-salve",
    name: "Sleep Salve",
    price: 18.0,
    variants: null
  };
  assert.strictEqual(mainJs.renderVariantChipsHtml(singleItem), "");
});

// --- SECTION 7: FDA Compliance -- the shop-grid synonym table is query-side
// only ---
//
// The shop's product claims live on the page: the FDA reads what shoppers
// see, not what they type. Symptom/condition words (eczema, arthritis,
// insomnia, sore muscles, anxiety...) are allowed to exist ONLY inside the
// query-time synonym table (SYNONYM_GROUPS / CATEGORY_TERMS, declared
// inside buildFilters() in assets/js/main.js) so a shopper's own wording
// still finds a real cosmetic product -- never inside the product data
// itself, and never in visible copy like search chips, the search
// placeholder, or the no-results suggestions. This section checks both
// halves of that rule: that the table stays query-side-only by construction
// (nothing outside buildFilters() ever reads it), and that the page copy
// stays clean of condition words regardless of who last touched it.
console.log("\n--- 7. FDA Compliance: Query-Side-Only Synonym Table ---");

const mainJsSrc = fs.readFileSync(path.join(ROOT, "assets", "js", "main.js"), "utf8");

function findMatchingBraceEnd(src, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

it("SYNONYM_GROUPS and CATEGORY_TERMS (buildFilters' table) are referenced only inside buildFilters() -- query time, not product-rendering time", () => {
  const fnStart = mainJsSrc.indexOf("function buildFilters(");
  assert.ok(fnStart !== -1, "buildFilters() must still exist in main.js");
  const braceStart = mainJsSrc.indexOf("{", fnStart);
  const fnEnd = findMatchingBraceEnd(mainJsSrc, braceStart);
  assert.ok(fnEnd !== -1, "could not find the end of buildFilters()");

  ["SYNONYM_GROUPS", "CATEGORY_TERMS", "SYNONYM_MAP"].forEach((identifier) => {
    const totalOccurrences = mainJsSrc.split(identifier).length - 1;
    const withinBuildFilters = mainJsSrc.slice(fnStart, fnEnd).split(identifier).length - 1;
    assert.strictEqual(
      totalOccurrences,
      withinBuildFilters,
      `${identifier} appears ${totalOccurrences} time(s) in main.js but only ${withinBuildFilters} inside buildFilters() -- ` +
        "it must never be read from product-rendering code, only from the query-time filter/search closure"
    );
  });
});

/* Words that may not be wired to a product on ANY surface, query side
   included. This used to be a hand-typed twelve, with a comment reasoning that
   "eczema"/"arthritis"/"insomnia" were "established, precedented
   cosmetic-adjacent wellness vocabulary" and could stay. The legal brief of
   2026-09-04 rejects that reasoning at section 7(b): a named disease is a named
   disease, and eczema-in / psoriasis-out was an asymmetry with no principle
   behind it. The list is now READ from the rules module rather than re-typed,
   so surface 4 and this gate cannot drift apart -- adding a word to the router
   automatically forbids wiring it to a jar. */
const ROUTER_WORDS = searchRules.MEDICAL_QUERY_TERMS.map((e) => e.term);

/* The shop-grid table is PARSED rather than grepped. The old version searched
   the raw source slice for a substring, which was fine for a list of twelve
   long words and is not fine for a list of thirty-three that includes "heal",
   "treat", "pain", "tick" and "bite": a substring check on source text finds
   those inside prose, inside comments and inside innocent longer words, and
   the failure mode of a gate that cries wolf is that somebody deletes it. The
   two tables are declared as plain literals, so evaluating the slice gives the
   real objects, and the rules module's own containsPhrase() does the
   whole-word match the router itself uses. */
function loadShopGridTables() {
  const fnStart = mainJsSrc.indexOf("function buildFilters(");
  const braceStart = mainJsSrc.indexOf("{", fnStart);
  const fnEnd = findMatchingBraceEnd(mainJsSrc, braceStart);
  const tableStart = mainJsSrc.indexOf("var SYNONYM_GROUPS", fnStart);
  const tableEnd = mainJsSrc.indexOf("var SYNONYM_MAP = new Map()", tableStart);
  assert.ok(tableStart > -1 && tableEnd > tableStart && tableEnd < fnEnd, "table slice located");
  return new Function(
    mainJsSrc.slice(tableStart, tableEnd) +
      "\nreturn { SYNONYM_GROUPS: SYNONYM_GROUPS, CATEGORY_TERMS: CATEGORY_TERMS };"
  )();
}

it("the shop-grid synonym table wires no medicalQueryTerms word to a product", () => {
  const tables = loadShopGridTables();
  const offenders = [];
  tables.SYNONYM_GROUPS.forEach((group, i) => {
    group.forEach((member) => {
      ROUTER_WORDS.forEach((word) => {
        if (searchRules.containsPhrase(member, word)) {
          offenders.push(`SYNONYM_GROUPS[${i}] "${member}" <- "${word}"`);
        }
      });
    });
  });
  Object.keys(tables.CATEGORY_TERMS).forEach((key) => {
    ROUTER_WORDS.forEach((word) => {
      if (searchRules.containsPhrase(key, word)) {
        offenders.push(`CATEGORY_TERMS["${key}"] <- "${word}"`);
      }
    });
  });
  assert.deepStrictEqual(
    offenders,
    [],
    "CATEGORY_TERMS maps a typed phrase straight onto PRODUCT IDS, so a router word as a key " +
      "is a literal disease-to-product mapping in a shipped file (brief 7(b), C-657/11 para 58). " +
      "Recognise the word in the router; never wire it to a jar. Offenders: " +
      offenders.join(", ")
  );
});

/* The owner's own copy is judged by a much shorter list, and deliberately so.
   This one is hers -- scripts/lib/search-enrichment-rules.js says in its header
   that products.json is never filtered or rewritten -- and the router list
   holds words her live listings legitimately contain ("Y'all Heal Now", the bug
   spray's "mosquito repellent"). Those are the 2026-09-01 review's business,
   not a test's. What a test can hold is the severe end. */
const NEVER_EVEN_QUERY_SIDE = [
  "wound",
  "infection",
  "psoriasis",
  "cure",
  "cures",
  "curing",
  "treats",
  "treatment",
  "diagnose",
  "diagnosis",
  "prescription"
];

it("assets/data/products.json never carries a severe medical-claim word in shopper-facing fields", () => {
  const products = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets", "data", "products.json"), "utf8")
  );
  const offenders = [];
  (products.products || []).forEach((p) => {
    const shopperFacingText = [
      p.name,
      p.blurb,
      ...(p.keywords || []),
      ...(p.ingredients || []),
      ...(p.tags || [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    NEVER_EVEN_QUERY_SIDE.forEach((word) => {
      if (shopperFacingText.indexOf(word) !== -1) offenders.push(`${p.id}: "${word}"`);
    });
  });
  assert.deepStrictEqual(
    offenders,
    [],
    `product-facing copy must never carry a medical claim word: ${offenders.join(", ")}`
  );
});

const CONDITION_WORDS = [
  "eczema",
  "arthritis",
  "insomnia",
  "anxiety",
  "psoriasis",
  "dermatitis",
  "infection",
  "disease"
];

it("no global-search chip, placeholder or no-results suggestion names a symptom or condition", () => {
  // These ARE allowed as query-side synonyms (that's the whole point of the
  // table above) but must never surface as visible copy the FDA would read
  // as a claim about what a product treats.

  const offenders = [];

  // The #shopSearch (shop-grid) and #globalSearchInput (modal) placeholders.
  const placeholderSources = [
    { file: "shop.html", pattern: /id="shopSearch"[^>]*placeholder="([^"]*)"/ },
    { file: "index.html", pattern: /id="globalSearchInput"[^>]*placeholder="([^"]*)"/ }
  ];
  placeholderSources.forEach(({ file, pattern }) => {
    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    const match = html.match(pattern);
    assert.ok(match, `${file} must still declare its search placeholder`);
    const text = match[1].toLowerCase();
    CONDITION_WORDS.forEach((word) => {
      if (text.indexOf(word) !== -1) offenders.push(`${file} placeholder: "${word}"`);
    });
  });

  // The no-results suggestion chips + empty-state copy rendered by the
  // modal's own renderNoResultsHtml(), exercised exactly the way a shopper
  // would trigger it (a query with zero matches).
  const noResultsHtml = mainJs.renderNoResultsHtml("zzzznonexistentquery");
  CONDITION_WORDS.forEach((word) => {
    if (noResultsHtml.toLowerCase().indexOf(word) !== -1) {
      offenders.push(`renderNoResultsHtml() chip/copy: "${word}"`);
    }
  });

  assert.deepStrictEqual(
    offenders,
    [],
    "visible search copy must never name a symptom/condition -- found: " + offenders.join(", ")
  );
});

// =====================================================================
// SECTION 8: Shopper vocabulary for every product, including the
// coming-soon line (bath tea, sugar scrub, whipped body butter, the two
// clearing mists). The synonym table lives in scripts/build-site-data.js
// and ships in search-data.js; these queries are what real shoppers type
// (Etsy/Google vocabulary, misspellings, gift intent, scent families).
// =====================================================================

const EXPECT_TOP = {
  "bath tea": "bath-tea",
  "tub tea": "bath-tea",
  "herbal bath": "bath-tea",
  "sugar scrub": "sugar-scrub",
  "body scrub": "sugar-scrub",
  exfoliate: "sugar-scrub",
  "whipped butter": "whipped-body-butter",
  "body butter": "shea-butter",
  lotion: "shea-butter",
  "porch sweep": "porch-sweep-spray",
  "house blessing": "porch-sweep-spray",
  "spell jar": "protection-keychain",
  keychain: "protection-keychain",
  "key ring": "protection-keychain",
  "beard oil": "beard-salve",
  mustache: "beard-salve",
  "t-shirt": "unisex-tshirt",
  tee: "unisex-tshirt",
  "tank top": "tank-top",
  merch: "unisex-tshirt",
  unscented: "miracle-balm",
  "fragrance free": "miracle-balm",
  kids: "miracle-balm",
  "hand scrub": "hand-scrub",
  "tired legs": "backroad-soak",
  "after the gym": "backroad-soak",
  "wind down": "sleep-salve",
  skeeters: "bug-spray",
  "deet free": "bug-spray",
  "body oil": "shimmer-oil",
  glitter: "shimmer-oil",
  sparkle: "shimmer-oil",
  "epson salt": "lavender-soak",
  frankinsense: "frankincense-salve",
  "shay butter": "shea-butter",
  salve: "frankincense-salve",
  balm: "frankincense-salve",
  "bath salts": "lavender-soak",
  "foot soak": "lavender-soak",
  witchy: "protection-keychain",
  protection: "protection-keychain",
  goth: "tank-top",
  floral: "bath-tea",
  "gift card": "yallternative-gift-card",
  "gift for him": "yallternative-gift-card",
  "pride gift": "bundle-pride-set",
  /* WAS `insomnia: "sleep-salve"` and `eczema: "shea-butter"`, with the note
     "condition words are translated at query time only". Since 2026-09-04 they
     are not translated at all: both are medicalQueryTerms words that map to no
     product (brief 7(b)), and the pin that they now find NOTHING lives in
     EXPECT_NOTHING below. LAY symptom vocabulary is what stays here. */
  restless: "sleep-salve",
  "itchy skin": "shea-butter",
  "sore muscles": "backroad-soak"
};

const EXPECT_TOP3 = {
  "room spray": ["porch-sweep-spray", "cleansing-spray"],
  "smudge spray": ["porch-sweep-spray", "cleansing-spray"],
  "sage spray": ["cleansing-spray"],
  "linen spray": ["porch-sweep-spray", "cleansing-spray"],
  "clearing mist": ["cleansing-spray", "porch-sweep-spray"],
  "pillow spray": ["porch-sweep-spray", "cleansing-spray"],
  ritual: ["protection-keychain", "cleansing-spray", "porch-sweep-spray"],
  vegan: ["bug-spray", "cleansing-spray", "hand-scrub"],
  "plant based": ["bug-spray"],
  bourbon: ["hand-scrub", "beard-salve"],
  citrus: ["shimmer-oil", "sugar-scrub", "whipped-body-butter"],
  "chapped lips": ["miracle-balm", "frankincense-salve"],
  woodsy: ["frankincense-salve", "beard-salve"],
  "cracked heels": ["shea-butter", "frankincense-salve"],
  chapstick: ["frankincense-salve", "miracle-balm"],
  "stocking stuffer": ["yallternative-gift-card"],
  "self care gift": ["yallternative-gift-card"],
  lavendar: ["lavender-soak", "sleep-salve"]
};

/* The other half of the change that took "insomnia" and "eczema" out of
   EXPECT_TOP. A medicalQueryTerms word must find nothing at all in the engine
   -- the note is what answers it (brief 7(b), 7(c)) -- and the lay phrase
   beside it in EXPECT_TOP must still find the same shelf it always did. */
const EXPECT_NOTHING = [
  "insomnia",
  "eczema",
  "anxiety",
  "arthritis",
  "psoriasis",
  "wound",
  // the pest words, on the router since 2026-09-04 (brief 7(g), FIFRA)
  "mosquito",
  "mosquitoes",
  "ticks",
  "mosquito bites"
];

EXPECT_NOTHING.forEach((query) => {
  it(`searchGlobal('${query}') is a router word and returns no product`, () => {
    const ids = (mainJs.searchGlobal(query).products || []).map((prod) => prod.id);
    assert.deepStrictEqual(ids, [], `'${query}' must map to no product, got [${ids.join(", ")}]`);
  });
});

Object.keys(EXPECT_TOP).forEach((query) => {
  it(`searchGlobal('${query}') ranks ${EXPECT_TOP[query]} first`, () => {
    const res = mainJs.searchGlobal(query);
    const ids = (res.products || []).map((prod) => prod.id);
    assert.strictEqual(
      ids[0],
      EXPECT_TOP[query],
      `expected ${EXPECT_TOP[query]} first for "${query}", got [${ids.join(", ")}]`
    );
  });
});

Object.keys(EXPECT_TOP3).forEach((query) => {
  it(`searchGlobal('${query}') surfaces ${EXPECT_TOP3[query].join("+")} in the top 3`, () => {
    const res = mainJs.searchGlobal(query);
    const top3 = (res.products || []).slice(0, 3).map((prod) => prod.id);
    EXPECT_TOP3[query].forEach((id) => {
      assert.ok(
        top3.includes(id),
        `expected ${id} in top 3 for "${query}", got [${top3.join(", ")}]`
      );
    });
  });
});

it("coming-soon intent ('coming soon', 'preorder', 'waitlist', 'new arrivals') returns only upcoming products first", () => {
  const upcoming = new Set(
    (global.window.YL_SEARCH_INDEX.products || [])
      .filter((prod) => prod.comingSoon)
      .map((prod) => prod.id)
  );
  assert.ok(upcoming.size >= 3, "fixture: expected at least three coming-soon products");
  ["coming soon", "preorder", "waitlist", "new arrivals"].forEach((query) => {
    const top3 = (mainJs.searchGlobal(query).products || []).slice(0, 3).map((prod) => prod.id);
    assert.strictEqual(top3.length, 3, `"${query}" should return at least three products`);
    top3.forEach((id) => {
      assert.ok(upcoming.has(id), `"${query}" top result ${id} is not a coming-soon product`);
    });
  });
});

it("market / meet-up queries surface the in-person FAQ answer and an event", () => {
  ["pop up", "market", "where can i meet you"].forEach((query) => {
    const res = mainJs.searchGlobal(query);
    const faqTitles = (res.faq || []).map((f) => (f.question || f.title || "").toLowerCase());
    assert.ok(
      faqTitles.some((t) => t.indexOf("meet you in person") !== -1),
      `"${query}" should surface the in-person FAQ, got [${faqTitles.join(" | ")}]`
    );
    assert.ok((res.events || []).length > 0, `"${query}" should surface at least one event`);
  });
});

it("shipped synonym table: every entry is a non-empty string and no group carries a treatment claim word", () => {
  const synonyms = global.window.YL_SEARCH_INDEX.synonyms || {};
  /* WAS an eleven-word hand-typed list with the note "'treat yourself' is a
     gift phrase, so bare 'treat' is not banned". The 2026-09-04 brief closes
     that: "treat" is a 21 USC 321(g)(1)(B) verb wherever it stands, the phrase
     left `gift_cards` in the same commit as the disease words, and the ban list
     here is the router's own thirty-three, read rather than re-typed. Keys are
     checked as well as terms -- a key IS a synonym, the build's
     buildSearchSynonyms() tokenises it into the query alongside its group. */
  const banned = ROUTER_WORDS;
  const offenders = [];
  Object.keys(synonyms).forEach((key) => {
    assert.ok(
      Array.isArray(synonyms[key]) && synonyms[key].length > 0,
      `synonym group "${key}" must be a non-empty array`
    );
    synonyms[key].forEach((entry) => {
      assert.ok(
        typeof entry === "string" && entry.trim().length > 0,
        `synonym group "${key}" has an empty entry`
      );
      banned.forEach((word) => {
        if (searchRules.containsPhrase(entry, word)) {
          offenders.push(key + ': "' + entry + '" <- "' + word + '"');
        }
      });
    });
    banned.forEach((word) => {
      if (searchRules.containsPhrase(key.replace(/_/g, " "), word)) {
        offenders.push("key " + key + ' <- "' + word + '"');
      }
    });
  });
  assert.deepStrictEqual(
    offenders,
    [],
    "assets/js/search-data.js wires a medicalQueryTerms word to a product group. " +
      "Surface 4 recognises those words and maps them to NO product (brief 7(b), 7(c)); " +
      "a synonym entry maps one to a jar. Offenders: " +
      offenders.join(", ")
  );
  assert.ok(
    Object.keys(synonyms).length >= 45,
    "expected the expanded synonym table (45+ groups), got " + Object.keys(synonyms).length
  );
});

// =====================================================================
// SECTION 9: Popular-search chips are CMS copy (content.json "search").
// The build renders them into every page and the PDP template; main.js
// renders the same list in the no-results state. Both must stay in step
// and neither may put a condition word on screen.
// =====================================================================

const buildModule = require(path.join(ROOT, "scripts", "build-site-data.js"));

it("main.js and the build share an identical search-chip icon set", () => {
  assert.deepStrictEqual(
    Object.keys(mainJs.SEARCH_CHIP_ICONS).sort(),
    Object.keys(buildModule.SEARCH_CHIP_ICONS).sort(),
    "icon names differ between assets/js/main.js and scripts/build-site-data.js"
  );
  Object.keys(mainJs.SEARCH_CHIP_ICONS).forEach((k) => {
    assert.strictEqual(
      mainJs.SEARCH_CHIP_ICONS[k],
      buildModule.SEARCH_CHIP_ICONS[k],
      "icon markup for " + k + " differs"
    );
  });
  assert.deepStrictEqual(
    mainJs.DEFAULT_SEARCH_CHIPS,
    buildModule.DEFAULT_SEARCH_CHIPS,
    "default chips differ"
  );
});

it("content.json search.popularChips is valid CMS copy and names no condition", () => {
  const chips = (siteConfig.search && siteConfig.search.popularChips) || [];
  assert.ok(chips.length >= 3, "expected at least three popular chips in content.json");
  chips.forEach((c) => {
    assert.ok(c.label && c.query, "chip needs label and query: " + JSON.stringify(c));
    assert.ok(buildModule.SEARCH_CHIP_ICONS[c.icon], "unknown chip icon: " + c.icon);
    CONDITION_WORDS.forEach((w) => {
      assert.ok(
        c.label.toLowerCase().indexOf(w) === -1,
        "chip label names a condition: " + c.label
      );
    });
  });
  // The build resolves the same list the page renders.
  const cfg = buildModule.getSearchConfig(siteConfig);
  assert.deepStrictEqual(
    cfg.popularChips.map((c) => c.query),
    chips.map((c) => c.query.trim()),
    "getSearchConfig() must keep the CMS chip order"
  );
  // And falls back to the built-in six when the CMS list is empty or missing.
  assert.deepStrictEqual(
    buildModule.getSearchConfig({}).popularChips,
    buildModule.DEFAULT_SEARCH_CHIPS
  );
  assert.deepStrictEqual(
    buildModule.getSearchConfig({ search: { popularChips: [{ label: " ", query: "x" }] } })
      .popularChips,
    buildModule.DEFAULT_SEARCH_CHIPS
  );
  assert.strictEqual(
    buildModule.getSearchConfig({
      search: { popularChips: [{ label: "A", query: "a", icon: "nope" }] }
    }).popularChips[0].icon,
    "sparkle"
  );
});

it("every page and PDP renders the CMS chips inside the search.chips markers with no condition word", () => {
  const cfg = buildModule.getSearchConfig(siteConfig);
  const expectedQueries = cfg.popularChips.map((c) => c.query);
  const pages = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html") && f !== "offline.html")
    .concat(fs.readdirSync(path.join(ROOT, "products")).map((f) => "products/" + f));
  assert.ok(pages.length >= 20, "expected top-level pages plus PDPs, got " + pages.length);
  pages.forEach((page) => {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const list = /<div class="global-search-chips-list"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    assert.ok(list, page + ": search chip list missing");
    const queries = [];
    const re = /data-search-query="([^"]*)"><svg[\s\S]*?<span>([^<]*)<\/span>/g;
    let m;
    while ((m = re.exec(list[1]))) {
      queries.push(m[1]);
      CONDITION_WORDS.forEach((w) => {
        assert.ok(
          m[2].toLowerCase().indexOf(w) === -1,
          page + ': chip "' + m[2] + '" names a condition'
        );
      });
    }
    assert.deepStrictEqual(queries, expectedQueries, page + ": chips do not match content.json");
    if (page.indexOf("products/") !== 0) {
      assert.ok(
        /<!--YL:search\.chips-->/.test(list[1]),
        page + ": chips are not wrapped in the YL:search.chips marker"
      );
    }
  });
});

it("main.js no-results chips follow window.YL_CONTENT.search and fall back to the defaults", () => {
  const saved = mockWindow.YL_CONTENT;
  mockWindow.YL_CONTENT = {
    search: { popularChips: [{ label: "Porch Mists", query: "room spray", icon: "leaf" }] }
  };
  let html = mainJs.renderNoResultsHtml("zzz");
  assert.ok(html.indexOf('data-search-query="room spray"') !== -1, "CMS chip not rendered");
  assert.ok(html.indexOf("Porch Mists") !== -1);
  assert.ok(
    html.indexOf('data-search-query="sleep"') === -1,
    "defaults leaked in beside the CMS list"
  );
  mockWindow.YL_CONTENT = {
    search: { popularChips: [{ label: "<b>x</b>", query: '"><i>', icon: "moon" }] }
  };
  html = mainJs.renderNoResultsHtml("zzz");
  assert.ok(
    html.indexOf("<b>x</b>") === -1 && html.indexOf("<i>") === -1,
    "chip copy must be escaped"
  );
  mockWindow.YL_CONTENT = undefined;
  html = mainJs.renderNoResultsHtml("zzz");
  mainJs.DEFAULT_SEARCH_CHIPS.forEach((c) => {
    assert.ok(
      html.indexOf('data-search-query="' + c.query + '"') !== -1,
      "default chip missing: " + c.query
    );
  });
  mockWindow.YL_CONTENT = saved;
});

console.log(`\n==================================================`);
console.log(`Global Search Tests: ${passed} passed, ${failed} failed.`);
console.log(`==================================================\n`);

if (failed > 0) {
  process.exit(1);
}
