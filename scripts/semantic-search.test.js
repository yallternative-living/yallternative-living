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
check(
  "Hypernym query 'sore muscles' ranks Backroad Soak first with the magnesium salve and Frankincense",
  () => {
    // Miracle Balm used to be expected here; after the 2026-09 copy pass its
    // copy claims nothing about muscles (dry skin, cuticles, tired legs only),
    // so the products that still belong are the soak and the two salves.
    const ids = productIds("sore muscles");
    assert.strictEqual(ids[0], "backroad-soak", "Top match is backroad-soak");
    assert.ok(ids.includes("sleep-salve"), "Matches the magnesium-arnica salve");
    assert.ok(ids.includes("frankincense-salve"), "Matches frankincense-salve");
  }
);

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

/* Live audit M1. "shipping" used to be one synonym grab-bag holding "refund",
   "gift card balance", "balance" and "landrum", and a reverse match injected
   every sibling of that group -- tokenised down to single words -- into the
   query. Searching "refund" therefore led with six gift sets and four farmers'
   markets, and the return-policy FAQ never appeared at all. */
check("Policy query 'refund' leads with the return-policy FAQ and nothing else", () => {
  const res = mainJs.searchGlobal("refund");
  assert.ok(res.faq.length > 0, "the FAQ domain answers a refund question");
  assert.ok(
    /return policy/i.test(res.faq[0].question),
    'first FAQ hit is the return policy (got "' + (res.faq[0] && res.faq[0].question) + '")'
  );
  assert.strictEqual(res.products.length, 0, "no gift cards or gift sets are dragged in");
  assert.strictEqual(res.events.length, 0, "no farmers' markets are dragged in by 'landrum'");
});

check("A policy synonym group leaks no token from another intent", () => {
  const expanded = mainJs.expandTokensWithSynonyms(mainJs.tokenizeQuery("refund"));
  assert.ok(expanded.includes("return"), "refund still reaches the returns intent");
  assert.ok(!expanded.includes("gift"), "no gift-card token leaks in");
  assert.ok(!expanded.includes("card"), "no gift-card token leaks in");
  assert.ok(!expanded.includes("balance"), "no gift-card token leaks in");
  assert.ok(!expanded.includes("landrum"), "no location token leaks in");
});

check("Location query 'farmers market' reaches the events domain", () => {
  const events = mainJs.searchGlobal("farmers market").events;
  assert.ok(events.length > 0, "Events returned for a market query");
});

check("A nonsense query returns nothing rather than the whole catalogue", () => {
  const res = mainJs.searchGlobal("zzqqxvzz_nonexistent_term_98765");
  assert.strictEqual(res.totalCount, 0, "no fabricated matches");
});

// ---------------------------------------------------------------------------
// 8. The shop-grid quick filter's own synonym table (SYNONYM_GROUPS /
//    CATEGORY_TERMS, declared inside buildFilters() in main.js and consulted
//    by expandQuery()/matchesQuery() there). This is a second, separate
//    synonym table from the one above -- it powers shop.html's #shopSearch
//    box, not the #global-search-modal that searchGlobal() answers -- and it
//    is 2026-09 vocabulary work: Etsy/Amazon/Google-autocomplete-style query
//    coverage for salves, soaks, butters, scrubs, sprays, beard care, bug
//    defense, witchy/protection goods, gifting and pride/apparel intent.
//
// None of expandQuery(), matchesQuery(), SYNONYM_GROUPS or CATEGORY_TERMS
// are exported by main.js -- they are private to buildFilters()'s closure,
// and exporting them would mean editing the module.exports object that
// other in-flight agents are actively appending to in this same file this
// session (a real conflict, not a hypothetical one -- see the M on
// assets/js/main.js at session start). So rather than re-implementing the
// engine here -- the exact anti-pattern that let a fake copy of the OTHER
// search suite stay green for months while the shipped code went untested
// (H-19, docs/AUDIT-2026-09-01.md) -- this slices the REAL source text for
// that block straight out of main.js and evaluates it. Edit SYNONYM_GROUPS,
// CATEGORY_TERMS, expandQuery() or matchesQuery() in main.js and this
// harness picks the change up on the next run; it cannot go stale the way a
// hand-copied re-implementation would.
// ---------------------------------------------------------------------------
console.log("\n===============================================================");
console.log("🔍 TESTING SHOP-GRID QUICK-FILTER SYNONYM TABLE (buildFilters)");
console.log("===============================================================\n");

function loadShopGridSearchEngine() {
  const src = require("fs").readFileSync(path.join(ROOT, "assets", "js", "main.js"), "utf8");
  const startMarker = "var STOPWORDS = new Set([";
  const fnMarker = "function matchesQuery(p, qContext) {";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "STOPWORDS block must still exist in main.js");
  const fnIdx = src.indexOf(fnMarker, startIdx);
  assert.ok(fnIdx !== -1, "matchesQuery() must still exist after STOPWORDS in main.js");

  // Brace-count from matchesQuery()'s opening brace to find where the real
  // function (and therefore the snippet we need) actually ends.
  let i = src.indexOf("{", fnIdx);
  let depth = 0;
  let endIdx = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
  assert.ok(endIdx !== -1, "could not find the end of matchesQuery() in main.js");
  const snippet = src.slice(startIdx, endIdx);

  const productData = JSON.parse(
    require("fs").readFileSync(path.join(ROOT, "assets", "data", "products.json"), "utf8")
  );
  const catLabel = {};
  (productData.categories || []).forEach((c) => {
    catLabel[c.id] = c.label;
  });
  const concernLabel = {};
  (productData.concerns || []).forEach((c) => {
    concernLabel[c.id] = c.name;
  });

  const factory = new Function(
    "catLabel",
    "concernLabel",
    snippet +
      "\nreturn { expandQuery: expandQuery, matchesQuery: matchesQuery, SYNONYM_GROUPS: SYNONYM_GROUPS, CATEGORY_TERMS: CATEGORY_TERMS };"
  );
  const engine = factory(catLabel, concernLabel);

  function rank(query) {
    const qCtx = engine.expandQuery(query);
    return productData.products
      .map((p) => ({ p, res: engine.matchesQuery(p, qCtx) }))
      .filter((x) => x.res.matched)
      .sort((a, b) => b.res.score - a.res.score)
      .map((x) => x.p.id);
  }

  return { engine, rank, productData };
}

const shopGrid = loadShopGridSearchEngine();
const rank = shopGrid.rank;
const REAL_PRODUCT_IDS = new Set(shopGrid.productData.products.map((p) => p.id));

function assertTop1(query, expectedId) {
  check(`Shop-grid: '${query}' ranks ${expectedId} first`, () => {
    const ids = rank(query);
    assert.ok(ids.length > 0, `'${query}' returns at least one product`);
    assert.strictEqual(
      ids[0],
      expectedId,
      `top result for '${query}' should be ${expectedId}, got ${ids[0]} (full: ${JSON.stringify(ids)})`
    );
  });
}

function assertTop3Includes(query, expectedId) {
  check(`Shop-grid: '${query}' surfaces ${expectedId} in the top 3`, () => {
    const top3 = rank(query).slice(0, 3);
    assert.ok(
      top3.includes(expectedId),
      `top 3 for '${query}' (${JSON.stringify(top3)}) should include ${expectedId}`
    );
  });
}

// --- Every CATEGORY_TERMS id is a real, current catalogue id ---------------
check("Every CATEGORY_TERMS product id exists in assets/data/products.json", () => {
  const bad = [];
  Object.entries(shopGrid.engine.CATEGORY_TERMS).forEach(([term, ids]) => {
    ids.forEach((id) => {
      if (!REAL_PRODUCT_IDS.has(id)) bad.push(`"${term}" -> "${id}"`);
    });
  });
  assert.deepStrictEqual(bad, [], `stale/invalid product ids in CATEGORY_TERMS: ${bad.join(", ")}`);
});

check("SYNONYM_GROUPS is a non-empty list of non-empty string arrays", () => {
  assert.ok(shopGrid.engine.SYNONYM_GROUPS.length > 15, "at least 15 synonym groups exist");
  shopGrid.engine.SYNONYM_GROUPS.forEach((group, idx) => {
    assert.ok(Array.isArray(group) && group.length > 1, `group ${idx} has 2+ members`);
    group.forEach((term) => {
      assert.strictEqual(typeof term, "string", `group ${idx} members are strings`);
      assert.ok(term.trim().length > 0, `group ${idx} has no blank members`);
    });
  });
});

// --- Symptom/condition-word queries still resolve to real cosmetic goods,
//     never to nothing and never to the whole catalogue -----------------
check(
  "Disease-word queries (insomnia, eczema, arthritis) resolve narrowly, not to the whole catalog",
  () => {
    ["insomnia", "eczema", "arthritis"].forEach((q) => {
      const ids = rank(q);
      assert.ok(ids.length > 0, `'${q}' returns results`);
      assert.ok(
        ids.length < shopGrid.productData.products.length,
        `'${q}' (${ids.length} results) must not just be the entire catalogue (${shopGrid.productData.products.length})`
      );
    });
  }
);

// --- Botanicals, INCI names & common misspellings ---------------------
assertTop1("boswellia", "frankincense-salve");
assertTop3Includes("lavendar", "lavender-soak");
assertTop1("arnika", "sleep-salve");
assertTop1("calendual", "miracle-balm");
assertTop1("patchouli", "shimmer-oil");
assertTop1("palo santo", "porch-sweep-spray");
assertTop1("witch hazel", "cleansing-spray");
assertTop3Includes("witch hazel", "porch-sweep-spray");

// --- Sleep / wind-down intent (symptom words route to real products only,
//     never appear in the product data itself -- see the compliance suite
//     in scripts/global-search.test.js and scripts/challenger-search-
//     scoring.test.js) ---
assertTop1("insomnia", "sleep-salve");
assertTop1("insomniac", "sleep-salve");
assertTop1("anxiety", "sleep-salve");
assertTop1("relax", "sleep-salve");
assertTop1("calm", "sleep-salve");
assertTop1("stressed", "sleep-salve");
assertTop1("sleepy", "sleep-salve");

// --- Sore muscles / joints / workout recovery intent ---
assertTop1("arthritis", "backroad-soak");
assertTop3Includes("arthritis", "frankincense-salve");
assertTop1("sore muscles", "backroad-soak");
assertTop3Includes("sore muscles", "miracle-balm");
assertTop1("workout recovery", "backroad-soak");
assertTop1("post workout", "backroad-soak");
assertTop1("gym", "backroad-soak");
assertTop1("knots", "backroad-soak");
assertTop1("tightness", "backroad-soak");
assertTop1("cramps", "backroad-soak");

// --- Dry / rough / chapped skin intent ---
assertTop1("eczema", "shea-butter");
assertTop3Includes("eczema", "whipped-body-butter");
assertTop1("cuticles", "frankincense-salve");
assertTop3Includes("cuticles", "miracle-balm");
assertTop1("windburn", "frankincense-salve");
assertTop1("hand cream", "hand-scrub");
assertTop3Includes("hand cream", "miracle-balm");
assertTop1("moisturizer", "whipped-body-butter");
assertTop1("hydration", "shea-butter");

// --- Exfoliation intent ---
assertTop1("exfoliate", "sugar-scrub");
assertTop1("scrub", "sugar-scrub");

// --- Bug / outdoor-defense intent (real Etsy/Amazon vocabulary: camping,
//     hiking, chiggers -- the very Southern cousin of ticks and gnats) ---
assertTop1("mosquito", "bug-spray");
assertTop1("chiggers", "bug-spray");
assertTop1("camping", "bug-spray");
assertTop1("hiking", "bug-spray");

// --- Witchy / cleansing / protection intent ---
assertTop1("witchy", "protection-keychain");
assertTop1("spell", "protection-keychain");
assertTop1("protection", "protection-keychain");
assertTop3Includes("ritual", "protection-keychain");

// --- Beard / grooming intent ---
assertTop1("beard oil", "beard-salve");
assertTop1("beard balm", "beard-salve");
assertTop1("mustache", "beard-salve");
check(
  "Directional precision holds after the vocabulary expansion: 'beard salve' still excludes sprays",
  () => {
    const ids = rank("beard salve");
    assert.strictEqual(ids[0], "beard-salve", "top match is still beard-salve");
    assert.ok(!ids.includes("bug-spray"), "still does NOT surface bug-spray");
    assert.ok(!ids.includes("cleansing-spray"), "still does NOT surface cleansing-spray");
  }
);

// --- Shimmer / glow intent ---
assertTop1("glow", "shimmer-oil");
assertTop1("glitter", "shimmer-oil");
assertTop1("highlighter", "shimmer-oil");
assertTop1("daily glow", "shimmer-oil");
assertTop3Includes("daily glow", "miracle-balm");

// --- Fragrance-free / sensitive-skin intent ---
assertTop1("unscented", "miracle-balm");
assertTop1("fragrance free", "miracle-balm");
assertTop1("sensitive skin", "miracle-balm");

// --- Vegan / plant-based intent: a tag-only fact (p.tags), unreachable
//     through the haystack matchesQuery() builds (it never includes tags),
//     so the CATEGORY_TERMS hypernym bonus is the only path a "vegan" query
//     has to the 11 vegan-tagged products and away from the 8 that aren't. ---
check("'vegan' resolves to exactly the vegan-tagged catalogue, not the rest", () => {
  const veganIds = new Set(rank("vegan"));
  const expectedVegan = shopGrid.productData.products
    .filter((p) => Array.isArray(p.tags) && p.tags.includes("vegan"))
    .map((p) => p.id);
  const expectedNonVegan = shopGrid.productData.products
    .filter((p) => !Array.isArray(p.tags) || !p.tags.includes("vegan"))
    .map((p) => p.id);
  assert.ok(expectedVegan.length >= 10, "sanity: catalogue actually has vegan-tagged products");
  expectedVegan.forEach((id) =>
    assert.ok(veganIds.has(id), `vegan-tagged ${id} surfaces for 'vegan'`)
  );
  expectedNonVegan.forEach((id) =>
    assert.ok(!veganIds.has(id), `non-vegan ${id} does NOT surface for 'vegan'`)
  );
});

// --- Gifting intent (Etsy/Amazon-style gift-occasion phrasing) ---
assertTop1("gift for him", "yallternative-gift-card");
assertTop1("gift for her", "yallternative-gift-card");
assertTop1("self care gift", "yallternative-gift-card");
assertTop1("bridesmaid gift", "yallternative-gift-card");
assertTop1("hostess gift", "yallternative-gift-card");
assertTop3Includes("stocking stuffer", "protection-keychain");

// --- Pride / queer apparel intent ---
assertTop1("pride", "unisex-tshirt");
assertTop3Includes("queer", "tank-top");
assertTop3Includes("lgbtq", "tank-top");
assertTop1("shirt", "unisex-tshirt");
assertTop1("tshirt", "unisex-tshirt");
assertTop1("tank", "tank-top");

console.log("\n===============================================================");
console.log(`🎉 TEST RESULTS: ${passed} / ${total} CHECKS PASSED`);
console.log("===============================================================");

if (passed !== total) {
  process.exit(1);
}
