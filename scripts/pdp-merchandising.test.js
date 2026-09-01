/**
 * @fileoverview Unit tests for Milestone 3: PDP Merchandising, Scent Profiles,
 * Usage Accordions, and Freshness Badges.
 * Run: node scripts/pdp-merchandising.test.js
 */

const fs = require("fs");
const path = require("path");
const buildScript = require("./build-site-data.js");

const ROOT = path.resolve(__dirname, "..");
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

console.log("Running PDP & Merchandising (Milestone 3) unit tests...\n");

/* 1. Validate Product Catalog Data (assets/data/products.json) */
console.log("--- 1. Product Catalog Data Integrity ---");
const productsJsonPath = path.join(ROOT, "assets/data/products.json");
assert(fs.existsSync(productsJsonPath), "products.json exists");
const productsData = JSON.parse(fs.readFileSync(productsJsonPath, "utf8"));
assert(
  Array.isArray(productsData.products) && productsData.products.length === 19,
  "products.json contains exactly 19 products"
);

const VALID_INTENSITIES = new Set(["Subtle", "Medium", "Strong", "Bold", "Unscented"]);

productsData.products.forEach((p) => {
  // Every product must have a usageGuide
  assert(
    p.usageGuide &&
      typeof p.usageGuide.howToApply === "string" &&
      p.usageGuide.howToApply.trim().length > 0 &&
      typeof p.usageGuide.storage === "string" &&
      p.usageGuide.storage.trim().length > 0 &&
      typeof p.usageGuide.patchTest === "string" &&
      p.usageGuide.patchTest.trim().length > 0,
    `Product '${p.id}' contains complete usageGuide (howToApply, storage, patchTest)`
  );

  // Apothecary categories must have structured scentProfile
  const isApothecary = ["salves", "body", "soaks", "potions", "ritual"].includes(p.category);
  if (isApothecary) {
    assert(p.scentProfile !== undefined, `Apothecary product '${p.id}' has scentProfile defined`);
    if (p.scentProfile) {
      assert(
        VALID_INTENSITIES.has(p.scentProfile.intensity),
        `Product '${p.id}' intensity '${p.scentProfile.intensity}' is valid enum`
      );
      assert(
        typeof p.scentProfile.intensityScore === "number" &&
          p.scentProfile.intensityScore >= 0 &&
          p.scentProfile.intensityScore <= 5,
        `Product '${p.id}' intensityScore (${p.scentProfile.intensityScore}) is between 0 and 5`
      );
      assert(
        typeof p.scentProfile.top === "string" &&
          typeof p.scentProfile.heart === "string" &&
          typeof p.scentProfile.base === "string",
        `Product '${p.id}' has top, heart, base note strings`
      );
    }
  } else {
    assert(p.scentProfile === null, `Non-apothecary product '${p.id}' has null scentProfile`);
  }
});

/* 2. Validate Sveltia CMS Schema (admin/config.yml) */
console.log("\n--- 2. CMS Schema Declarations (admin/config.yml) ---");
const configYmlPath = path.join(ROOT, "admin/config.yml");
const configYml = fs.readFileSync(configYmlPath, "utf8");
assert(
  /name:\s*scentProfile/.test(configYml),
  "config.yml declares scentProfile in products collection"
);
assert(
  /name:\s*top/.test(configYml) &&
    /name:\s*heart/.test(configYml) &&
    /name:\s*base/.test(configYml) &&
    /name:\s*intensity/.test(configYml) &&
    /name:\s*intensityScore/.test(configYml),
  "config.yml declares all scentProfile sub-fields (top, heart, base, intensity, intensityScore)"
);
assert(
  /name:\s*usageGuide/.test(configYml),
  "config.yml declares usageGuide in products collection"
);
assert(
  /name:\s*howToApply/.test(configYml) &&
    /name:\s*storage/.test(configYml) &&
    /name:\s*patchTest/.test(configYml),
  "config.yml declares all usageGuide sub-fields (howToApply, storage, patchTest)"
);

/* 3. Validate Build Helper Functions */
console.log("\n--- 3. PDP Build Helper Functions ---");
const freshnessBadge = buildScript.renderFreshnessBadgeHtml();
assert(
  freshnessBadge.includes("pdp-freshness-badge") &&
    freshnessBadge.includes("Poured in Landrum, SC · Small-Batch Promise") &&
    freshnessBadge.includes("<svg"),
  "renderFreshnessBadgeHtml returns valid markup with icon and badge copy"
);

const sampleApothecary = {
  id: "test-salve",
  name: "Test Salve",
  scentProfile: {
    top: "Lavender, Bergamot",
    heart: "Rosemary, Thyme",
    base: "Frankincense, Cedar",
    intensity: "Medium",
    intensityScore: 3
  }
};
const scentHtml = buildScript.renderScentProfileHtml(sampleApothecary);
assert(
  scentHtml.includes("pdp-scent-profile") &&
    scentHtml.includes("pdp-intensity-bar") &&
    scentHtml.includes("Lavender, Bergamot") &&
    scentHtml.includes("Rosemary, Thyme") &&
    scentHtml.includes("Frankincense, Cedar") &&
    scentHtml.includes("width:60%;"),
  "renderScentProfileHtml formats scent pyramid notes and 60% intensity meter"
);

const sampleUnscented = {
  id: "test-unscented",
  name: "Test Unscented Balm",
  scentProfile: {
    top: "None",
    heart: "None",
    base: "None",
    intensity: "Unscented",
    intensityScore: 0
  }
};
const unscentedHtml = buildScript.renderScentProfileHtml(sampleUnscented);
assert(
  unscentedHtml.includes("pdp-scent-unscented") && unscentedHtml.includes("Naturally unscented"),
  "renderScentProfileHtml renders unscented note for unscented products"
);

const nullScentHtml = buildScript.renderScentProfileHtml({ id: "tee", scentProfile: null });
eq(nullScentHtml, "", "renderScentProfileHtml returns empty string for null scentProfile");

const sampleUsage = {
  id: "test-item",
  category: "salves",
  usageGuide: {
    howToApply: "Massage gently into skin.",
    storage: "Keep in a cool dry place.",
    patchTest: "Test on forearm 24h prior."
  }
};
const usageHtml = buildScript.renderUsageAccordionsHtml(sampleUsage);
assert(
  usageHtml.includes('<details class="pdp-accordion">') &&
    usageHtml.includes("How to Apply") &&
    usageHtml.includes("Storage &amp; Shelf Life") &&
    usageHtml.includes("Patch Test Guidelines") &&
    usageHtml.includes("Massage gently into skin."),
  "renderUsageAccordionsHtml renders 3 accessible details accordions"
);

/* 4. Validate Generated PDP HTML Files (products/*.html) */
console.log("\n--- 4. Generated PDP HTML Pages Verification ---");
productsData.products.forEach((p) => {
  const pFile = path.join(ROOT, "products", `${p.id}.html`);
  assert(fs.existsSync(pFile), `products/${p.id}.html exists on disk`);
  const html = fs.readFileSync(pFile, "utf8");

  assert(
    html.includes('class="pdp-freshness-badge"'),
    `products/${p.id}.html contains pdp-freshness-badge`
  );
  assert(
    html.includes("Poured in Landrum, SC · Small-Batch Promise"),
    `products/${p.id}.html contains small-batch trust badge text`
  );
  assert(
    html.includes('class="pdp-accordion"'),
    `products/${p.id}.html contains pdp-accordion elements`
  );
  assert(
    html.includes(buildScript.escapeHtml(p.usageGuide.howToApply)),
    `products/${p.id}.html contains howToApply text`
  );
  assert(
    html.includes("window.location.replace"),
    `products/${p.id}.html contains shop deep-link redirect script`
  );
  assert(
    html.includes('rel="canonical" href="https://yallternativeliving.com/shop.html"'),
    `products/${p.id}.html contains canonical link to shop.html`
  );

  if (p.scentProfile) {
    assert(
      html.includes('class="pdp-scent-profile'),
      `products/${p.id}.html contains pdp-scent-profile`
    );
    assert(
      html.includes('class="pdp-intensity-bar"'),
      `products/${p.id}.html contains pdp-intensity-bar`
    );
  }
});

/* 5. Validate Stylesheet Classes (assets/css/styles.css) */
console.log("\n--- 5. Stylesheet Classes Verification ---");
const stylesCssPath = path.join(ROOT, "assets/css/styles.css");
const stylesCss = fs.readFileSync(stylesCssPath, "utf8");
const expectedClasses = [
  ".pdp-accordion",
  ".pdp-accordion-summary",
  ".pdp-accordion-content",
  ".pdp-scent-profile",
  ".pdp-intensity-bar",
  ".pdp-freshness-badge",
  ".pdp-layout",
  ".scent-notes-grid",
  ".scent-note-card",
  ".pdp-ritual-section",
  ".pdp-ritual-header",
  ".pdp-ritual-title",
  ".pdp-ritual-card",
  ".pdp-ritual-items-grid",
  ".pdp-ritual-item",
  ".pdp-ritual-checkbox",
  ".pdp-ritual-footer",
  ".pdp-ritual-total-price",
  ".pdp-ritual-shipping-badge",
  ".pdp-ritual-add-btn"
];

expectedClasses.forEach((cls) => {
  assert(stylesCss.includes(cls), `styles.css contains required class '${cls}'`);
});

/* 6. Validate "Complete the Ritual" Data Integrity */
console.log("\n--- 6. Complete the Ritual Data Integrity ---");
const botanicalProds = productsData.products.filter((p) =>
  ["salves", "body", "soaks", "potions", "ritual"].includes(p.category)
);
assert(
  botanicalProds.length >= 16,
  `Catalog contains ${botanicalProds.length} botanical/apothecary products`
);

const allProductIds = new Set(productsData.products.map((p) => p.id));

botanicalProds.forEach((p) => {
  assert(
    Array.isArray(p.pairsWith) && p.pairsWith.length >= 1,
    `Product '${p.id}' has pairsWith array`
  );
  assert(
    typeof p.ritualTitle === "string" && p.ritualTitle.trim().length > 0,
    `Product '${p.id}' has non-empty ritualTitle '${p.ritualTitle}'`
  );
  if (Array.isArray(p.pairsWith)) {
    p.pairsWith.forEach((pairedId) => {
      assert(
        allProductIds.has(pairedId),
        `Product '${p.id}' pairsWith ID '${pairedId}' exists in catalog`
      );
      assert(pairedId !== p.id, `Product '${p.id}' does not self-reference in pairsWith`);
    });
  }
});

/* 7. Validate Sveltia CMS Ritual Declarations */
console.log("\n--- 7. CMS Schema Ritual Declarations ---");
assert(
  /name:\s*pairsWith/.test(configYml),
  "config.yml declares pairsWith relation widget in products collection"
);
assert(
  /name:\s*ritualTitle/.test(configYml),
  "config.yml declares ritualTitle string widget in products collection"
);

/* 8. Validate Ritual Build Helpers */
console.log("\n--- 8. Ritual Build Helper Functions ---");
assert(
  typeof buildScript.validatePairsWith === "function",
  "buildScript exports validatePairsWith function"
);
assert(
  typeof buildScript.renderRitualSectionHtml === "function",
  "buildScript exports renderRitualSectionHtml function"
);

// validatePairsWith test
const validMap = {};
productsData.products.forEach((p) => {
  validMap[p.id] = p;
});
assert(
  buildScript.validatePairsWith(productsData.products, validMap) === true,
  "validatePairsWith passes on canonical catalog"
);

let caughtSelfRef = false;
try {
  buildScript.validatePairsWith(
    [{ id: "item-a", pairsWith: ["item-a"], ritualTitle: "Self Pair" }],
    { "item-a": { id: "item-a", price: 10 } }
  );
} catch (e) {
  caughtSelfRef = true;
}
assert(caughtSelfRef, "validatePairsWith throws on self-referencing pairsWith");

let caughtUnknownId = false;
try {
  buildScript.validatePairsWith(
    [{ id: "item-a", pairsWith: ["missing-id"], ritualTitle: "Missing ID" }],
    { "item-a": { id: "item-a", price: 10 } }
  );
} catch (e) {
  caughtUnknownId = true;
}
assert(caughtUnknownId, "validatePairsWith throws on unknown paired product ID");

// renderRitualSectionHtml tests
const frankincenseProd = validMap["frankincense-salve"];
const ritualHtml = buildScript.renderRitualSectionHtml(frankincenseProd, validMap, {
  salves: "Salves & Balms",
  body: "Body & Skin"
});
assert(
  ritualHtml.includes('class="pdp-ritual-section"'),
  "renderRitualSectionHtml outputs pdp-ritual-section"
);
assert(
  ritualHtml.includes('id="pdpRitualSection"'),
  "renderRitualSectionHtml outputs id pdpRitualSection"
);
assert(
  ritualHtml.includes(
    "✦ Complete the Ritual: " + buildScript.escapeHtml(frankincenseProd.ritualTitle) + " ✦"
  ),
  "renderRitualSectionHtml contains formatted ritual title"
);
assert(
  ritualHtml.includes('id="pdpRitualAddBtn"'),
  "renderRitualSectionHtml contains pdpRitualAddBtn"
);
assert(
  ritualHtml.includes('data-ritual-ids="frankincense-salve,hand-scrub,miracle-balm"'),
  "renderRitualSectionHtml contains data-ritual-ids attribute"
);
assert(
  !ritualHtml.includes('class="reveal') && !ritualHtml.includes(" reveal"),
  "renderRitualSectionHtml does NOT use .reveal class (prevents reveal-check conflict)"
);

const emptyRitualHtml = buildScript.renderRitualSectionHtml(
  { id: "tee", pairsWith: [], price: 20 },
  validMap
);
eq(
  emptyRitualHtml,
  "",
  "renderRitualSectionHtml returns empty string for product without pairsWith"
);

/* 9. Validate Generated PDP Ritual HTML */
console.log("\n--- 9. Generated PDP Ritual HTML Verification ---");
productsData.products.forEach((p) => {
  const pFile = path.join(ROOT, "products", `${p.id}.html`);
  const html = fs.readFileSync(pFile, "utf8");

  if (Array.isArray(p.pairsWith) && p.pairsWith.length > 0) {
    assert(
      html.includes('class="pdp-ritual-section"'),
      `products/${p.id}.html renders pdp-ritual-section`
    );
    assert(
      html.includes('id="pdpRitualSection"'),
      `products/${p.id}.html renders id="pdpRitualSection"`
    );
    assert(
      html.includes('id="pdpRitualAddBtn"'),
      `products/${p.id}.html renders id="pdpRitualAddBtn"`
    );
    assert(
      html.includes('id="pdpRitualTotalPrice"'),
      `products/${p.id}.html renders id="pdpRitualTotalPrice"`
    );
    assert(
      html.includes('class="pdp-ritual-checkbox"'),
      `products/${p.id}.html renders pdp-ritual-checkbox elements`
    );
    assert(
      html.includes(buildScript.escapeHtml(p.ritualTitle)),
      `products/${p.id}.html renders ritualTitle text`
    );
    assert(
      !html.includes('class="pdp-ritual-section reveal"') &&
        !html.includes('class="reveal pdp-ritual-section"'),
      `products/${p.id}.html does not have reveal class on ritual section`
    );
  }
});

/* 10. Validate Client JS Module Exports & Functions */
console.log("\n--- 10. Client JS Ritual Exports ---");
function createMockEl(tag = "div") {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(),
    attributes: attrs,
    style: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, force) => {
        if (force !== undefined) {
          if (force) classes.add(x);
          else classes.delete(x);
        } else if (classes.has(x)) classes.delete(x);
        else classes.add(x);
      }
    },
    hidden: false,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) || null,
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    addEventListener: (evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    dispatchEvent: (evt) => {
      const fns = listeners.get(evt.type) || [];
      fns.forEach((fn) => fn(evt));
    },
    querySelector: () => createMockEl("div"),
    querySelectorAll: () => [],
    appendChild: (ch) => ch,
    textContent: "",
    innerHTML: ""
  };
}

const mockDoc = {
  documentElement: createMockEl("html"),
  body: createMockEl("body"),
  getElementById: () => createMockEl("div"),
  querySelector: () => createMockEl("div"),
  querySelectorAll: () => [],
  createElement: (tag) => createMockEl(tag),
  addEventListener: () => {}
};

const mockWin = {
  document: mockDoc,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {}
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  location: {
    href: "https://yallternativeliving.com",
    pathname: "/",
    search: "",
    hash: ""
  },
  YL_PRODUCTS: productsData,
  addEventListener: () => {}
};

global.window = mockWin;
global.document = mockDoc;
global.localStorage = mockWin.localStorage;
global.navigator = { userAgent: "node" };

const mainJs = require("../assets/js/main.js");
assert(
  typeof mainJs.initPdpRitualSection === "function",
  "main.js exports initPdpRitualSection function"
);
assert(
  typeof mainJs.renderModalRitualHtml === "function",
  "main.js exports renderModalRitualHtml function"
);

const modalRitualHtml = mainJs.renderModalRitualHtml(frankincenseProd, {
  get: (id) => validMap[id]
});
assert(
  modalRitualHtml.includes('class="pdp-ritual-section pdp-ritual-compact"'),
  "renderModalRitualHtml produces compact modal ritual section"
);
assert(
  modalRitualHtml.includes(
    "✦ Complete the Ritual: " + mainJs.attrEsc(frankincenseProd.ritualTitle) + " ✦"
  ),
  "renderModalRitualHtml includes ritualTitle"
);

console.log(`\npdp-merchandising.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
