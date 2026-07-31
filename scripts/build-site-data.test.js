/**
 * @fileoverview Unit tests for build pipeline logic in scripts/build-site-data.js
 * Run: node scripts/build-site-data.test.js
 */

const fs = require("fs");
const path = require("path");
const buildScript = require("./build-site-data.js");

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

console.log("Running build-site-data.js unit tests...\n");

/* 1. slugify */
eq(
  buildScript.slugify("Frankincense & Myrrh Salve"),
  "frankincense-myrrh-salve",
  "slugify converts title to slug"
);
eq(buildScript.slugify("Savanna's Choice"), "savannas-choice", "slugify removes apostrophes");
eq(
  buildScript.slugify("   Upper & Lower Case!   "),
  "upper-lower-case",
  "slugify trims and normalizes case"
);
eq(buildScript.slugify(""), "", "slugify handles empty string");
eq(buildScript.slugify(null), "", "slugify handles null input");
eq(buildScript.slugify(undefined), "", "slugify handles undefined input");

/* 2. escapeHtml */
eq(
  buildScript.escapeHtml("<div>\"Hello\" & 'world'</div>"),
  "&lt;div&gt;&quot;Hello&quot; &amp; &#39;world&#39;&lt;/div&gt;",
  "escapeHtml escapes special characters (<, >, &, \", ', `)"
);
eq(buildScript.escapeHtml(123), "123", "escapeHtml converts non-strings");
eq(buildScript.escapeHtml(null), "", "escapeHtml handles null input");
eq(buildScript.escapeHtml(undefined), "", "escapeHtml handles undefined input");
eq(
  buildScript.escapeHtml('foo" onmouseover="alert(1)'),
  "foo&quot; onmouseover=&quot;alert(1)",
  "escapeHtml neutralizes attribute-breakout attempts"
);
eq(buildScript.escapeHtml("`template`"), "&#96;template&#96;", "escapeHtml escapes backticks");

/* 2b. safeUrl */
eq(
  buildScript.safeUrl("https://example.com/rsvp"),
  "https://example.com/rsvp",
  "safeUrl allows https URLs"
);
eq(buildScript.safeUrl("http://example.com"), "http://example.com", "safeUrl allows http URLs");
eq(buildScript.safeUrl("/local/path"), "/local/path", "safeUrl allows root-relative paths");
eq(buildScript.safeUrl("javascript:alert(1)"), "", "safeUrl rejects javascript: URLs");
eq(buildScript.safeUrl("data:text/html,evil"), "", "safeUrl rejects data: URLs");
eq(buildScript.safeUrl(""), "", "safeUrl handles empty string");
eq(buildScript.safeUrl(null), "", "safeUrl handles null input");

/* 3. generateUniqueId */
const existingIds = new Set(["salve-1", "salve-1-2"]);
eq(
  buildScript.generateUniqueId(existingIds, "New Salve", "prod", 0),
  "new-salve",
  "generateUniqueId creates new slug when unique"
);
eq(
  buildScript.generateUniqueId(existingIds, "Salve 1", "prod", 1),
  "salve-1-3",
  "generateUniqueId resolves collisions by incrementing suffix"
);
eq(
  buildScript.generateUniqueId(existingIds, "", "prod", 2),
  "prod-3",
  "generateUniqueId falls back to prefix when name is empty"
);

/* 4. variantPriceRange */
const noVariants = { price: 20.0 };
eq(
  buildScript.variantPriceRange(noVariants),
  { low: 20.0, high: 20.0 },
  "variantPriceRange handles single price product"
);

const prodWithVariants = {
  price: 20.0,
  variants: {
    options: [
      { label: "S", priceDelta: 0 },
      { label: "L", priceDelta: 5.0 }
    ]
  }
};
eq(
  buildScript.variantPriceRange(prodWithVariants),
  { low: 20.0, high: 25.0 },
  "variantPriceRange calculates min and max prices"
);

const negativeDeltaVariants = {
  price: 20.0,
  variants: {
    options: [
      { label: "Sample", priceDelta: -5.0 },
      { label: "Full", priceDelta: 10.0 }
    ]
  }
};
eq(
  buildScript.variantPriceRange(negativeDeltaVariants),
  { low: 15.0, high: 30.0 },
  "variantPriceRange supports negative price deltas"
);

/* 5. stripMarkersInsideAttributes */
const attrHtml = '<input placeholder="<!--YL:key-->injected text<!--/YL:key-->">';
eq(
  buildScript.stripMarkersInsideAttributes(attrHtml),
  '<input placeholder="injected text">',
  "stripMarkersInsideAttributes removes YL markers inside quotes"
);

const elementHtml = "<div><!--YL:key-->element text<!--/YL:key--></div>";
eq(
  buildScript.stripMarkersInsideAttributes(elementHtml),
  "<div><!--YL:key-->element text<!--/YL:key--></div>",
  "stripMarkersInsideAttributes preserves element-level comment markers"
);

/* 6. bundlePricing */
const mockProductsMap = {
  "salve-1": { price: 15.0 },
  "soak-1": { price: 20.0, originalPrice: 20.0 }
};
const validBundle = {
  productIds: ["salve-1", "soak-1"],
  discountPercent: 10
};
eq(
  buildScript.bundlePricing(validBundle, mockProductsMap),
  { fullPrice: 35.0, bundlePrice: 31.5 },
  "bundlePricing calculates component sum and discount"
);

const invalidBundle = {
  productIds: ["salve-1", "non-existent-product"]
};
eq(
  buildScript.bundlePricing(invalidBundle, mockProductsMap),
  null,
  "bundlePricing returns null for missing product references"
);

/* 7. readJson, readText, writeFile */
const realProductsJson = buildScript.readJson("assets/data/products.json");
assert(
  realProductsJson && Array.isArray(realProductsJson.products),
  "readJson parses canonical products.json"
);

const tempRelPath = "tmp/build-site-data-test-temp.txt";
const tempFull = path.join(__dirname, "..", tempRelPath);
buildScript.writeFile(tempRelPath, "temporary test content");

const readBack = buildScript.readText(tempRelPath);
eq(readBack, "temporary test content", "writeFile and readText function correctly");

// Clean up temporary file
try {
  if (fs.existsSync(tempFull)) {
    fs.unlinkSync(tempFull);
  }
} catch {
  /* cleanup best-effort */
}

console.log(`\nbuild-site-data.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
