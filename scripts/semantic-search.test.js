/**
 * @fileoverview Unit tests for the 2-Tier FLIR-style semantic search engine
 * that ships in assets/js/main.js.
 *
 * This file used to re-implement the engine: it carried its own copies of
 * STOPWORDS, SYNONYM_GROUPS, CATEGORY_TERMS, expandQuery() and
 * matchProductSemantic(), and asserted against those. main.js was never
 * loaded, so the suite stayed green no matter what the shipped search did --
 * a test that could not fail (audit H-19). It now loads the real engine and
 * the real generated index exactly the way challenger-search-scoring.test.js
 * does, and asserts the semantic behaviours against them.
 *
 * Run: node scripts/semantic-search.test.js
 */

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
global.navigator = { userAgent: "node", platform: "MacIntel" };

// Load the generated search index and the real engine.
require(path.join(ROOT, "assets", "js", "search-data.js"));
const mainJs = require(path.join(ROOT, "assets", "js", "main.js"));

console.log("===============================================================");
console.log("🔍 TESTING 2-TIER FLIR-STYLE SEMANTIC SEARCH ENGINE (main.js)");
console.log("===============================================================\n");

let passed = 0;
let total = 0;

function check(testName, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${testName}: ${err.message}`);
  }
}

/** @return {!Array<string>} product ids the engine surfaces for a query. */
function productIds(query) {
  return mainJs.searchGlobal(query).products.map((p) => p.id);
}

// ---------------------------------------------------------------------------
// 0. The engine under test really is the shipped one
// ---------------------------------------------------------------------------
check("Engine is loaded from assets/js/main.js, not re-implemented here", () => {
  ["searchGlobal", "tokenizeQuery", "expandTokensWithSynonyms", "getSearchIndex"].forEach((fn) => {
    assert.strictEqual(typeof mainJs[fn], "function", `main.js exports ${fn}()`);
  });
});

check("Search runs against the generated index in assets/js/search-data.js", () => {
  const index = mainJs.getSearchIndex();
  assert.strictEqual(
    index,
    mockWindow.YL_SEARCH_INDEX || global.window.YL_SEARCH_INDEX,
    "getSearchIndex() returns window.YL_SEARCH_INDEX, not the in-memory fallback"
  );
  assert.notStrictEqual(index.version, "fallback", "index is the generated one, not the fallback");
  assert.ok(index.products.length >= 19, `index carries the catalogue (${index.products.length})`);
  assert.ok(
    Object.keys(index.synonyms || {}).length >= 20,
    "index ships a synonym map for the engine to expand against"
  );
});

// ---------------------------------------------------------------------------
// 1. Exact match guarantee
// ---------------------------------------------------------------------------
check("Exact name match 'Sleep Salve' ranks sleep-salve first", () => {
  const ids = productIds("Sleep Salve");
  assert.ok(ids.length > 0, "Matches found");
  assert.strictEqual(ids[0], "sleep-salve", "Top match is sleep-salve");
});

check("Case and punctuation do not change the top result", () => {
  assert.strictEqual(productIds("  sLeEp, salve!  ")[0], "sleep-salve");
});

// ---------------------------------------------------------------------------
// 2. Tier 1 bidirectional synonym & typo expansion
// ---------------------------------------------------------------------------
check("Typo query 'lavendar' matches lavender products via Tier 1 synonyms", () => {
  const ids = productIds("lavendar");
  assert.ok(ids.includes("lavender-soak"), "Matches lavender-soak");
  assert.ok(ids.includes("shea-butter"), "Matches shea-butter (Lavender Shea)");
  assert.ok(ids.includes("sleep-salve"), "Matches sleep-salve");
});

check("Botanical Latin name 'boswellia' resolves to frankincense-salve", () => {
  assert.strictEqual(productIds("boswellia")[0], "frankincense-salve");
});

check("Symptom synonym 'insomnia' matches Sleep Salve & Lavender Soak", () => {
  const ids = productIds("insomnia");
  assert.ok(ids.includes("sleep-salve"), "Matches sleep-salve for insomnia");
  assert.ok(ids.includes("lavender-soak"), "Matches lavender-soak for insomnia");
});

// ---------------------------------------------------------------------------
// 3. Tier 2 directional hypernym precision
// ---------------------------------------------------------------------------
check("Hypernym query 'sore muscles' matches Backroad Soak, Miracle Balm & Frankincense", () => {
  const ids = productIds("sore muscles");
  assert.ok(ids.includes("backroad-soak"), "Matches backroad-soak");
  assert.ok(ids.includes("miracle-balm"), "Matches miracle-balm");
  assert.ok(ids.includes("frankincense-salve"), "Matches frankincense-salve");
});

check("Directional precision: 'beard salve' surfaces beard-salve and no sprays", () => {
  const ids = productIds("beard salve");
  assert.strictEqual(ids[0], "beard-salve", "Top match is beard-salve");
  assert.ok(!ids.includes("bug-spray"), "Does NOT surface bug-spray");
  assert.ok(!ids.includes("cleansing-spray"), "Does NOT surface cleansing-spray");
});

check("Concern query 'bug bites' ranks bug-spray first", () => {
  assert.strictEqual(productIds("bug bites")[0], "bug-spray");
});

// ---------------------------------------------------------------------------
// 4. Botanical & ingredient recall
// ---------------------------------------------------------------------------
check("Ingredient query 'calendula' ranks miracle-balm first", () => {
  assert.strictEqual(productIds("calendula")[0], "miracle-balm");
});

check("Gift query 'gift card' ranks the gift card first", () => {
  assert.strictEqual(productIds("gift card")[0], "yallternative-gift-card");
});

// ---------------------------------------------------------------------------
// 5. Query hygiene: the tokenizer and the synonym expander
// ---------------------------------------------------------------------------
check("tokenizeQuery lowercases, strips punctuation and de-duplicates", () => {
  assert.deepStrictEqual(mainJs.tokenizeQuery("Sore, SORE muscles!! 2oz"), [
    "sore",
    "muscles",
    "2oz"
  ]);
  assert.deepStrictEqual(mainJs.tokenizeQuery("   "), []);
  assert.deepStrictEqual(mainJs.tokenizeQuery(null), []);
});

check("expandTokensWithSynonyms is a superset of its input and adds real synonyms", () => {
  const index = mainJs.getSearchIndex();
  const tokens = mainJs.tokenizeQuery("insomnia");
  const expanded = mainJs.expandTokensWithSynonyms(tokens, index.synonyms);
  tokens.forEach((t) => assert.ok(expanded.includes(t), `keeps original token "${t}"`));
  assert.ok(expanded.includes("sleep"), "expands insomnia -> sleep");
  assert.ok(expanded.length > tokens.length, "expansion actually widened the token set");
});

// ---------------------------------------------------------------------------
// 6. Empty and non-string query safety
//
// The shipped engine returns an empty envelope rather than the whole
// catalogue. The old in-test engine claimed the opposite ("Empty query returns
// all products") and nothing ever noticed, because nothing ever ran the real
// one.
// ---------------------------------------------------------------------------
check("Empty, whitespace and non-string queries return an empty envelope", () => {
  [null, undefined, "", "   ", 42, {}, []].forEach((q) => {
    const res = mainJs.searchGlobal(q);
    assert.strictEqual(res.totalCount, 0, `totalCount is 0 for ${JSON.stringify(q)}`);
    ["products", "journal", "events", "faq"].forEach((domain) => {
      assert.ok(Array.isArray(res[domain]), `${domain} is an array`);
      assert.strictEqual(res[domain].length, 0, `${domain} is empty`);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. The search is global: all four domains are reachable
// ---------------------------------------------------------------------------
check("A single query segments across products, journal, events and FAQ", () => {
  const res = mainJs.searchGlobal("Sleep Salve");
  assert.ok(res.products.length > 0, "products domain populated");
  // The Journal is a switchable feature (content.json site.enableJournal):
  // when it is off the build emits no journal entries into the search index,
  // and the search must return none -- asserting "> 0" here would only be
  // true while the switch is on. Read the switch instead of hardcoding it.
  const siteConfig = JSON.parse(
    require("fs").readFileSync(path.join(__dirname, "..", "assets", "data", "content.json"), "utf8")
  ).site;
  if (siteConfig && siteConfig.enableJournal === false) {
    assert.strictEqual(res.journal.length, 0, "journal domain empty while the Journal is off");
  } else {
    assert.ok(res.journal.length > 0, "journal domain populated");
  }
  assert.ok(res.events.length > 0, "events domain populated");
  assert.ok(res.faq.length > 0, "faq domain populated");
  assert.strictEqual(
    res.totalCount,
    res.products.length + res.journal.length + res.events.length + res.faq.length,
    "totalCount is the sum of the four domains"
  );
});

check("Policy query 'shipping' reaches the FAQ domain", () => {
  const faq = mainJs.searchGlobal("shipping").faq;
  assert.ok(faq.length > 0, "FAQ entries returned for a shipping question");
});

check("Location query 'farmers market' reaches the events domain", () => {
  const events = mainJs.searchGlobal("farmers market").events;
  assert.ok(events.length > 0, "Events returned for a market query");
});

check("A nonsense query returns nothing rather than the whole catalogue", () => {
  const res = mainJs.searchGlobal("zzqqxvzz_nonexistent_term_98765");
  assert.strictEqual(res.totalCount, 0, "no fabricated matches");
});

console.log("\n===============================================================");
console.log(`🎉 TEST RESULTS: ${passed} / ${total} CHECKS PASSED`);
console.log("===============================================================");

if (passed !== total) {
  process.exit(1);
}
