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
  { low: 20.0, high: 20.0, offerCount: 1 },
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
  { low: 20.0, high: 25.0, offerCount: 2 },
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
  { low: 15.0, high: 30.0, offerCount: 2 },
  "variantPriceRange supports negative price deltas"
);

const soldOutVariantMix = {
  price: 20.0,
  variants: {
    options: [
      { label: "1oz", priceDelta: -6, soldOut: true },
      { label: "2oz", priceDelta: 0 },
      { label: "4oz", priceDelta: 8 }
    ]
  }
};
eq(
  buildScript.variantPriceRange(soldOutVariantMix),
  { low: 20.0, high: 28.0, offerCount: 2 },
  "variantPriceRange excludes sold-out options from range and offerCount"
);

const allSoldOutVariants = {
  price: 20.0,
  variants: {
    options: [
      { label: "1oz", priceDelta: -6, soldOut: true },
      { label: "2oz", priceDelta: 0, soldOut: true }
    ]
  }
};
eq(
  buildScript.variantPriceRange(allSoldOutVariants),
  { low: 14.0, high: 20.0, offerCount: 2 },
  "variantPriceRange falls back to the full option list when every option is sold out"
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

/* 8. Form endpoints (action="...") are re-injectable every build.
   These can't go through <!--YL:key--> markers -- an HTML comment inside a
   quoted attribute isn't a comment, so cleanAttributeMarkers() strips it and
   the next build has nothing left to match. Matching the attribute itself is
   what keeps a CMS edit reaching the page more than once. */
eq(
  buildScript.formspreeAction("abcd1234", "YOUR_FORM_ID"),
  "https://formspree.io/f/abcd1234",
  "formspreeAction builds the endpoint from a configured id"
);
eq(
  buildScript.formspreeAction("", "YOUR_FORM_ID"),
  "https://formspree.io/f/YOUR_FORM_ID",
  "formspreeAction keeps the placeholder when the id is blank"
);
eq(
  buildScript.formspreeAction(undefined, "YOUR_FORM_ID"),
  "https://formspree.io/f/YOUR_FORM_ID",
  "formspreeAction keeps the placeholder when the id is unset"
);
eq(
  buildScript.formspreeAction('x" onload="alert(1)', "YOUR_FORM_ID"),
  "https://formspree.io/f/YOUR_FORM_ID",
  "formspreeAction refuses an id that would break out of the attribute"
);
eq(
  buildScript.newsletterAction("https://kit.com/f/abc", "YOUR_KIT_FORM_ACTION_URL"),
  "https://kit.com/f/abc",
  "newsletterAction passes a real https form URL through"
);
eq(
  buildScript.newsletterAction("javascript:alert(1)", "YOUR_KIT_FORM_ACTION_URL"),
  "YOUR_KIT_FORM_ACTION_URL",
  "newsletterAction rejects a javascript: URL"
);
eq(
  buildScript.newsletterAction("", "YOUR_KIT_FORM_ACTION_URL"),
  "YOUR_KIT_FORM_ACTION_URL",
  "newsletterAction keeps the placeholder while the field is empty"
);

const formHtml =
  '<form class="footer-signup-form" action="YOUR_KIT_FORM_ACTION_URL" method="post"></form>' +
  '<div class="contact-form-col">' +
  '<form action="https://formspree.io/f/YOUR_FORM_ID" method="POST" class="contact-form"></form>' +
  "</div>" +
  '<form class="other-form" action="keep-me"></form>';
const injected = buildScript.setFormAction(
  buildScript.setFormAction(formHtml, "footer-signup-form", "https://kit.com/f/abc"),
  "contact-form",
  "https://formspree.io/f/mabcdefg"
);
assert(
  injected.indexOf('class="footer-signup-form" action="https://kit.com/f/abc"') !== -1,
  "setFormAction rewrites the newsletter form action"
);
assert(
  injected.indexOf('action="https://formspree.io/f/mabcdefg"') !== -1,
  "setFormAction rewrites the contact form action (attribute before class)"
);
assert(
  injected.indexOf('class="other-form" action="keep-me"') !== -1,
  "setFormAction leaves unrelated forms alone"
);
assert(
  injected.indexOf('class="contact-form-col"') !== -1,
  'setFormAction matches whole class tokens ("contact-form" is not "contact-form-col")'
);
// Re-running must be a no-op, and must be able to walk the value back to the
// placeholder when the CMS field is cleared again.
eq(
  buildScript.setFormAction(injected, "contact-form", "https://formspree.io/f/mabcdefg"),
  injected,
  "setFormAction is idempotent"
);
assert(
  buildScript
    .setFormAction(injected, "footer-signup-form", "YOUR_KIT_FORM_ACTION_URL")
    .indexOf('action="YOUR_KIT_FORM_ACTION_URL"') !== -1,
  "setFormAction restores the placeholder when the CMS field is cleared"
);

console.log(`\nbuild-site-data.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
