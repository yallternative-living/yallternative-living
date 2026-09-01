/**
 * @fileoverview Unit tests for the 2-Tier FLIR-Style Semantic Search Engine.
 * Run: node scripts/semantic-search.test.js
 */

const assert = require("assert");
const productsData = require("../assets/data/products.json").products;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "them",
  "some",
  "any",
  "can",
  "do",
  "does",
  "give",
  "help",
  "need",
  "looking",
  "want",
  "find",
  "good",
  "best",
  "something"
]);

// Tier 1: Tight bidirectional synonyms (abbreviations, typos, Latin/common, symptoms)
const SYNONYM_GROUPS = [
  ["lavender", "lavandula", "lavendula", "lavendar"],
  ["frankincense", "boswellia", "olibanum"],
  ["arnica", "arnica montana"],
  ["calendula", "marigold"],
  ["shea", "shea butter", "butyrospermum parkii", "butyrospermum"],
  ["cedarwood", "cedar"],
  ["eucalyptus", "blue gum"],
  ["peppermint", "mentha piperita", "mint"],
  ["chamomile", "matricaria"],
  ["sleep", "insomnia", "bedtime", "nighttime", "slumber", "restless", "unwind"],
  [
    "sore",
    "ache",
    "aching",
    "pain",
    "muscles",
    "muscle",
    "joint",
    "joints",
    "stiff",
    "stiffness",
    "sprain",
    "bruise",
    "tension",
    "arthritis"
  ],
  ["dry", "chapped", "cracked", "flaky", "ashy", "rough", "eczema", "hydration", "moisturizer"],
  [
    "bug",
    "bugs",
    "mosquito",
    "mosquitoes",
    "tick",
    "ticks",
    "gnat",
    "gnats",
    "insects",
    "insect",
    "repellent",
    "bites"
  ],
  ["smudge", "cleansing", "energy", "smoke-free", "aura", "protection", "banishing"],
  ["shimmer", "glow", "glitter", "sparkle", "radiance", "highlight", "highlighter"],
  ["beard", "mustache", "stubble", "facial hair", "grooming"],
  ["bath", "soak", "soaking", "tub", "epsom", "salts"],
  ["gift", "voucher", "present", "gift card", "certificate", "birthday"]
];

// Tier 2: Directional Hypernym -> Target Products / Concerns
const CATEGORY_TERMS = {
  sleep: ["sleep-salve", "lavender-soak", "bath-tea"],
  insomnia: ["sleep-salve", "lavender-soak", "bath-tea"],
  bedtime: ["sleep-salve", "lavender-soak", "bath-tea"],
  pain: ["miracle-balm", "backroad-soak", "frankincense-salve"],
  "sore muscles": ["miracle-balm", "backroad-soak", "frankincense-salve"],
  muscle: ["miracle-balm", "backroad-soak", "frankincense-salve"],
  joint: ["miracle-balm", "backroad-soak", "frankincense-salve"],
  arthritis: ["miracle-balm", "backroad-soak", "frankincense-salve"],
  "dry skin": [
    "shea-butter",
    "whipped-body-butter",
    "hand-scrub",
    "sugar-scrub",
    "frankincense-salve"
  ],
  eczema: ["shea-butter", "whipped-body-butter", "hand-scrub", "sugar-scrub", "frankincense-salve"],
  chapped: [
    "shea-butter",
    "whipped-body-butter",
    "hand-scrub",
    "sugar-scrub",
    "frankincense-salve"
  ],
  bug: ["bug-spray", "miracle-balm"],
  mosquito: ["bug-spray", "miracle-balm"],
  insect: ["bug-spray", "miracle-balm"],
  repellent: ["bug-spray", "miracle-balm"],
  smudge: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
  energy: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
  clearing: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
  beard: ["beard-salve"],
  grooming: ["beard-salve"],
  shimmer: ["shimmer-oil"],
  glow: ["shimmer-oil"],
  gift: ["yallternative-gift-card", "custom-box"],
  voucher: ["yallternative-gift-card"],
  shirt: ["unisex-tshirt", "tank-top"],
  tshirt: ["unisex-tshirt", "tank-top"],
  tank: ["tank-top"]
};

// Build fast bidirectional synonym map
const SYNONYM_MAP = new Map();
SYNONYM_GROUPS.forEach((group) => {
  group.forEach((term) => {
    const termNorm = term.toLowerCase().trim();
    if (!SYNONYM_MAP.has(termNorm)) {
      SYNONYM_MAP.set(termNorm, new Set());
    }
    group.forEach((sibling) => {
      if (sibling !== term) {
        SYNONYM_MAP.get(termNorm).add(sibling.toLowerCase().trim());
      }
    });
  });
});

function expandQuery(rawQuery) {
  const q = (rawQuery || "").toLowerCase().trim();
  if (!q) return { exact: "", tokens: [], expandedTokens: new Set(), hypernymTargets: new Set() };

  const tokens = q
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const expandedTokens = new Set(tokens);
  const hypernymTargets = new Set();

  // 1. Expand tokens via Tier 1 Bidirectional Synonyms
  tokens.forEach((t) => {
    if (SYNONYM_MAP.has(t)) {
      SYNONYM_MAP.get(t).forEach((syn) => {
        syn.split(/\s+/).forEach((st) => expandedTokens.add(st));
      });
    }
  });

  // 2. Expand phrase and tokens via Tier 2 Directional Hypernyms
  Object.keys(CATEGORY_TERMS).forEach((cat) => {
    if (q.indexOf(cat) !== -1 || tokens.includes(cat)) {
      CATEGORY_TERMS[cat].forEach((targetId) => hypernymTargets.add(targetId));
    }
  });

  return { exact: q, tokens, expandedTokens, hypernymTargets };
}

function matchProductSemantic(product, queryContext) {
  if (!queryContext.exact) return { matched: true, score: 1.0, reason: "" };

  const q = queryContext.exact;
  const pName = (product.name || "").toLowerCase();
  const pBlurb = (product.blurb || "").toLowerCase();
  const pDesc = (product.description || "").toLowerCase();
  const pCat = (product.category || "").toLowerCase();
  const pScent = (product.scent || "").toLowerCase();
  const pIngredients = Array.isArray(product.ingredients)
    ? product.ingredients.join(" ").toLowerCase()
    : "";
  const pConcerns = Array.isArray(product.concerns) ? product.concerns.join(" ").toLowerCase() : "";
  const pKeywords = Array.isArray(product.keywords) ? product.keywords.join(" ").toLowerCase() : "";

  const haystack = `${pName} ${pBlurb} ${pDesc} ${pCat} ${pScent} ${pIngredients} ${pConcerns} ${pKeywords}`;

  let score = 0;
  let isExact = false;

  // 1. Exact Substring Match Guarantee (Floored >= 1.0, Ranked Highest)
  if (haystack.indexOf(q) !== -1) {
    isExact = true;
    score += 2.0;
    if (pName.indexOf(q) !== -1) score += 3.0; // Name exact bonus
  }

  // 2. Tier 2 Hypernym match
  if (queryContext.hypernymTargets.has(product.id)) {
    score += 1.8;
  }

  // 3. Token & Synonym Coverage
  let matchedTokens = 0;
  queryContext.expandedTokens.forEach((token) => {
    if (haystack.indexOf(token) !== -1) {
      matchedTokens++;
      score += 0.5;
      if (pName.indexOf(token) !== -1) score += 1.0;
      if (pKeywords.indexOf(token) !== -1) score += 0.8;
    }
  });

  // If query had tokens, require either an exact substring match, hypernym match, or matching tokens
  const passed = isExact || queryContext.hypernymTargets.has(product.id) || matchedTokens > 0;

  return {
    matched: passed && score > 0,
    score: score,
    isExact: isExact
  };
}

// -------------------------------------------------------------
// Test Suite Execution
// -------------------------------------------------------------
console.log("===============================================================");
console.log("🔍 TESTING 2-TIER FLIR-STYLE SEMANTIC SEARCH ENGINE");
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

// 1. Exact Match Guarantee
check("Exact name match 'Sleep Salve' returns sleep-salve with top score", () => {
  const ctx = expandQuery("Sleep Salve");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched)
    .sort((a, b) => b.score - a.score);

  assert(res.length > 0, "Matches found");
  assert.strictEqual(res[0].id, "sleep-salve", "Top match is sleep-salve");
  assert(res[0].isExact, "Flagged as exact match");
});

// 2. Tier 1 Bidirectional Synonym & Typo Expansion
check("Typo query 'lavendar' matches Lavender products via Tier 1 synonym", () => {
  const ctx = expandQuery("lavendar");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  const matchedIds = res.map((r) => r.id);
  assert(matchedIds.includes("lavender-soak"), "Matches lavender-soak");
  assert(matchedIds.includes("shea-butter"), "Matches shea-butter (Lavender Shea)");
  assert(matchedIds.includes("sleep-salve"), "Matches sleep-salve");
});

check("Synonym query 'insomnia' matches Sleep Salve & Lavender Soak", () => {
  const ctx = expandQuery("insomnia");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  const matchedIds = res.map((r) => r.id);
  assert(matchedIds.includes("sleep-salve"), "Matches sleep-salve for insomnia");
  assert(matchedIds.includes("lavender-soak"), "Matches lavender-soak for insomnia");
});

// 3. Tier 2 Directional Hypernym Precision
check("Hypernym query 'sore muscles' matches Miracle Balm, Frankincense & Backroad Soak", () => {
  const ctx = expandQuery("sore muscles");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  const matchedIds = res.map((r) => r.id);
  assert(matchedIds.includes("miracle-balm"), "Matches miracle-balm");
  assert(matchedIds.includes("backroad-soak"), "Matches backroad-soak");
  assert(matchedIds.includes("frankincense-salve"), "Matches frankincense-salve");
});

check("Directional Precision: Specific query 'beard salve' does NOT match 'bug-spray'", () => {
  const ctx = expandQuery("beard salve");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  const matchedIds = res.map((r) => r.id);
  assert(matchedIds.includes("beard-salve"), "Matches beard-salve");
  assert(!matchedIds.includes("bug-spray"), "Does NOT match bug-spray");
  assert(!matchedIds.includes("cleansing-spray"), "Does NOT match cleansing-spray");
});

// 4. Botanical & Ingredient Recall
check("Botanical query 'calendula' matches Miracle Balm", () => {
  const ctx = expandQuery("calendula");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  const matchedIds = res.map((r) => r.id);
  assert(matchedIds.includes("miracle-balm"), "Matches miracle-balm for calendula");
});

// 5. Empty Query Safety
check("Empty query returns all products", () => {
  const ctx = expandQuery("");
  const res = productsData
    .map((p) => ({ id: p.id, ...matchProductSemantic(p, ctx) }))
    .filter((r) => r.matched);

  assert.strictEqual(res.length, productsData.length, "All products returned for empty search");
});

console.log("\n===============================================================");
console.log(`🎉 TEST RESULTS: ${passed} / ${total} SUITES PASSED`);
console.log("===============================================================");

if (passed !== total) {
  process.exit(1);
}
