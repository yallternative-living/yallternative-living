/**
 * @fileoverview Unit test suite for CMS label replacements and automatic
 * category-based Materials vs Ingredients resolution.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const { resolveIngredientsLabel } = require("./build-site-data.js");
const cmsLabels = require("../admin/cms-labels.js");

console.log("Running CMS Labels & Category Resolution Test Suite...");

// 1. Test resolveIngredientsLabel logic
console.log("--- 1. Testing resolveIngredientsLabel ---");

assert.strictEqual(
  resolveIngredientsLabel({ category: "potions" }),
  "Materials",
  "Category 'potions' must resolve to 'Materials'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "apparel" }),
  "Materials",
  "Category 'apparel' must resolve to 'Materials'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "salves" }),
  "Ingredients",
  "Category 'salves' must resolve to 'Ingredients'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "body" }),
  "Ingredients",
  "Category 'body' must resolve to 'Ingredients'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "soaks" }),
  "Ingredients",
  "Category 'soaks' must resolve to 'Ingredients'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "ritual" }),
  "Ingredients",
  "Category 'ritual' must resolve to 'Ingredients'"
);

assert.strictEqual(
  resolveIngredientsLabel({ category: "salves", ingredientsLabel: "Custom Heading" }),
  "Custom Heading",
  "Explicit non-empty ingredientsLabel must take precedence when present"
);

console.log("✓ resolveIngredientsLabel correctly resolves headings by category");

// 2. Test Sveltia CMS jargon replacement in admin/cms-labels.js
console.log("--- 2. Testing replaceJargonInText in admin/cms-labels.js ---");

const { replaceJargonInText } = cmsLabels;

assert.strictEqual(
  replaceJargonInText("Edit Slug"),
  "Edit Web Address",
  "Edit Slug must be replaced with Edit Web Address"
);

assert.strictEqual(
  replaceJargonInText("⁨Edit Slug⁩"),
  "⁨Edit Web Address⁩",
  "Edit Slug wrapped in isolate marks must be replaced with Edit Web Address"
);

assert.strictEqual(
  replaceJargonInText("Edit slug"),
  "Edit web address",
  "Edit slug must be replaced with Edit web address"
);

assert.strictEqual(
  replaceJargonInText("Slug"),
  "Web Address",
  "Standalone Slug label must be replaced with Web Address"
);

assert.strictEqual(
  replaceJargonInText("⁨Slug⁩"),
  "⁨Web Address⁩",
  "Standalone Slug label with isolate marks must be replaced with Web Address"
);

assert.strictEqual(
  replaceJargonInText("The slug cannot be empty."),
  "The web address cannot be empty.",
  "Empty slug error message must be translated"
);

assert.strictEqual(
  replaceJargonInText("The slug cannot contain special characters, including slashes and spaces."),
  "The web address cannot contain special characters, including slashes and spaces.",
  "Invalid slug error message must be translated"
);

assert.strictEqual(
  replaceJargonInText("This slug is used for another entry."),
  "This web address is already used for another entry.",
  "Duplicate slug error message must be translated"
);

assert.strictEqual(
  replaceJargonInText("Revert All Changes"),
  "Discard All Changes",
  "Revert All Changes must be replaced with Discard All Changes"
);

assert.strictEqual(
  replaceJargonInText("Revert Changes"),
  "Discard Changes",
  "Revert Changes must be replaced with Discard Changes"
);

assert.strictEqual(
  replaceJargonInText("View in Repository"),
  "View on GitHub",
  "View in Repository must be replaced with View on GitHub"
);

assert.strictEqual(
  replaceJargonInText("Show Second Pane"),
  "Show Side-by-Side Preview",
  "Show Second Pane must be replaced with Show Side-by-Side Preview"
);

assert.strictEqual(
  replaceJargonInText("Swap Panes"),
  "Swap Preview Sides",
  "Swap Panes must be replaced with Swap Preview Sides"
);

assert.strictEqual(
  replaceJargonInText("Normal Text Without Jargon"),
  "Normal Text Without Jargon",
  "Unrelated text must remain untouched"
);

console.log("✓ replaceJargonInText correctly replaces all technical jargon");

// 3. Test admin/config.yml invariants
console.log("--- 3. Testing admin/config.yml invariants ---");

const configContent = fs.readFileSync(path.join(ROOT, "admin/config.yml"), "utf8");
const config = yaml.load(configContent);

const productsCollection = config.collections.find((c) => c.name === "products");
assert(productsCollection, "products collection must exist in admin/config.yml");

const ingredientsLabelField = productsCollection.fields.find((f) => f.name === "ingredientsLabel");
assert.strictEqual(
  ingredientsLabelField,
  undefined,
  "ingredientsLabel field must NOT exist in admin/config.yml"
);

const ingredientsField = productsCollection.fields.find((f) => f.name === "ingredients");
assert(ingredientsField, "ingredients field must exist in admin/config.yml");
assert.strictEqual(
  ingredientsField.hint,
  undefined,
  "ingredients field must NOT contain the legacy Etsy migration hint"
);

console.log("✓ admin/config.yml is clean of ingredientsLabel and Etsy hint");

// 4. Test protection-keychain and other products in built assets
console.log("--- 4. Testing built PDP and search data invariants ---");

const searchDataContent = fs.readFileSync(path.join(ROOT, "assets/js/search-data.js"), "utf8");
const searchDataMatch = searchDataContent.match(/window\.YL_SEARCH_INDEX\s*=\s*(\{[\s\S]*\});/);
assert(searchDataMatch, "window.YL_SEARCH_INDEX must be found in search-data.js");
const searchData = JSON.parse(searchDataMatch[1]);

const keychainItem = searchData.products.find((p) => p.id === "protection-keychain");
assert(keychainItem, "protection-keychain must exist in search-data.js");
assert.strictEqual(
  keychainItem.ingredientsLabel,
  "Materials",
  "protection-keychain must have ingredientsLabel: 'Materials' in search-data.js"
);

const salveItem = searchData.products.find((p) => p.id === "frankincense-salve");
assert(salveItem, "frankincense-salve must exist in search-data.js");
assert.strictEqual(
  salveItem.ingredientsLabel,
  "Ingredients",
  "frankincense-salve must have ingredientsLabel: 'Ingredients' in search-data.js"
);

const keychainPdp = fs.readFileSync(path.join(ROOT, "products/protection-keychain.html"), "utf8");
assert(
  keychainPdp.includes('<h2 class="pdp-section-title">Materials</h2>'),
  "protection-keychain PDP must contain '<h2 class=\"pdp-section-title\">Materials</h2>'"
);

const salvePdp = fs.readFileSync(path.join(ROOT, "products/frankincense-salve.html"), "utf8");
assert(
  salvePdp.includes('<h2 class="pdp-section-title">Ingredients</h2>'),
  "frankincense-salve PDP must contain '<h2 class=\"pdp-section-title\">Ingredients</h2>'"
);

console.log("✓ Built PDPs and search data reflect automatic category headings");

console.log("==================================================");
console.log("CMS Labels & Category Resolution: All tests passed.");
console.log("==================================================");
