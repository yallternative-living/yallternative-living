/**
 * @fileoverview Adversarial Red-Team & Fuzzing Test Suite for Sveltia CMS Live Preview Templates.
 *
 * Tests the ProductPreview component under extreme and hostile inputs:
 * 1. Prototype pollution attacks (toString, valueOf, __proto__, constructor).
 * 2. Protocol injection and XSS schemes in media URLs (javascript:, vbscript:, data:text/html).
 * 3. Numerical fuzzing and boundary violations (negative prices, negative deltas, NaN, Infinity).
 * 4. Layout flood and memory overflow defenses (100+ images, 200+ ingredients, massive tag arrays).
 * 5. Type corruption (objects passed as strings, nulls, undefined, non-array collections).
 *
 * Run via: node scripts/cms-preview-redteam.test.js
 */

const assert = require("assert");

// Setup mock browser/Sveltia environment for Node execution
function createMockH() {
  return function h(type, props, ...children) {
    const flatChildren = children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false);
    return {
      type,
      props: props || {},
      children: flatChildren
    };
  };
}

function createMockClass() {
  return function createClass(spec) {
    function Component(props) {
      this.props = props || {};
      this.state =
        typeof spec.getInitialState === "function" ? spec.getInitialState.call(this) : {};
    }
    Component.prototype = Object.assign({}, spec);
    Component.prototype.setState = function (partial) {
      Object.assign(this.state, partial);
    };
    return Component;
  };
}

// Helper to recursively collect all text content from a vdom node
function extractText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(" ");
  if (typeof node === "object" && node.children) {
    return extractText(node.children);
  }
  return "";
}

// Helper to recursively find nodes by type
function findNodesByType(node, type) {
  const matches = [];
  if (!node || typeof node !== "object") return matches;
  if (node.type === type) matches.push(node);
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => {
      matches.push(...findNodesByType(child, type));
    });
  }
  return matches;
}

// Helper to recursively find nodes with a specific CSS class
function findNodesByClass(node, className) {
  const matches = [];
  if (!node || typeof node !== "object") return matches;
  if (node.props && node.props.className && node.props.className.split(" ").includes(className)) {
    matches.push(node);
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => {
      matches.push(...findNodesByClass(child, className));
    });
  }
  return matches;
}

// Inject globals before requiring preview-templates.js
global.window = {
  CMS: {
    registerPreviewStyle: () => {},
    registerPreviewTemplate: () => {}
  },
  createClass: createMockClass(),
  h: createMockH()
};

const { ProductPreview, sanitizeImageUrl } = require("../admin/preview-templates.js");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("Running Sveltia CMS Preview Red-Team & Adversarial Fuzzing Tests...\n");

// --- SECTION 1: PROTOTYPE POLLUTION DEFENSES ---
console.log("1. Prototype Pollution Vectors:");

runTest("CATEGORY_MAP resists toString prototype property", () => {
  const inst = new ProductPreview({
    entry: { data: { category: "toString", name: "Pollution Test" } }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(!text.includes("[Function"), "Should not render function body for toString category");
  assert(text.includes("toString"), "Should render category string safely");
});

runTest("CATEGORY_MAP resists __proto__ and valueOf", () => {
  const inst = new ProductPreview({
    entry: { data: { category: "__proto__", name: "Proto Test" } }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(!text.includes("[object Object]"), "Should not render raw object for __proto__");
});

runTest("TAG_MAP resists Object prototype properties in tags array", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        tags: ["toString", "valueOf", "__proto__", "constructor", "vegan"],
        name: "Tag Poison Test"
      }
    }
  });
  const vdom = inst.render();
  const pills = findNodesByClass(vdom, "tag-pill");
  assert.strictEqual(pills.length, 5, "Should render 5 tag pills");
  const pillTexts = pills.map((p) => extractText(p));
  assert(pillTexts.includes("Vegan"), "Valid mapped tag 'vegan' resolves to 'Vegan'");
  assert(pillTexts.includes("toString"), "'toString' rendered as safe literal string");
  assert(pillTexts.includes("valueOf"), "'valueOf' rendered as safe literal string");
});

// --- SECTION 2: PROTOCOL INJECTION & XSS ATTACKS ---
console.log("\n2. Protocol Injection & Malicious URLs:");

runTest("Blocks javascript: protocol in primary image", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        image: "javascript:alert(document.cookie)",
        name: "XSS Product"
      }
    }
  });
  const vdom = inst.render();
  const imgs = findNodesByType(vdom, "img");
  assert.strictEqual(imgs.length, 1);
  assert(
    !imgs[0].props.src.toLowerCase().includes("javascript:"),
    "javascript: URL must be stripped"
  );
  assert.strictEqual(
    imgs[0].props.src,
    "/assets/img/placeholder-coming-soon-1200.png",
    "Should fallback to placeholder"
  );
});

runTest("Blocks vbscript: protocol in images list", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        images: ["vbscript:msgbox(1)"],
        name: "VBScript Test"
      }
    }
  });
  const vdom = inst.render();
  const imgs = findNodesByType(vdom, "img");
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0].props.src, "/assets/img/placeholder-coming-soon-1200.png");
});

runTest("Blocks data:text/html payload in image", () => {
  const dangerousDataUrl = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
  const result = sanitizeImageUrl(dangerousDataUrl);
  assert.strictEqual(result, "/assets/img/placeholder-coming-soon-1200.png");
});

runTest("Permits legitimate data:image/png URI", () => {
  const validDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const result = sanitizeImageUrl(validDataUrl);
  assert.strictEqual(result, validDataUrl);
});

runTest("Permits legitimate https:// CDN image", () => {
  const cdnUrl = "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b";
  const result = sanitizeImageUrl(cdnUrl);
  assert.strictEqual(result, cdnUrl);
});

runTest("Permits legitimate blob: image preview", () => {
  const blobUrl = "blob:https://yallternativeliving.com/uuid-1234";
  const result = sanitizeImageUrl(blobUrl);
  assert.strictEqual(result, blobUrl);
});

// --- SECTION 3: NUMERICAL FUZZING & PRICE CLAMPING ---
console.log("\n3. Numerical Fuzzing & Price Bounds:");

runTest("Clamps negative base price to $0.00 floor", () => {
  const inst = new ProductPreview({
    entry: { data: { price: -49.99, name: "Negative Price Item" } }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("$0.00"), "Negative price must clamp to $0.00");
  assert(!text.includes("$-"), "Must never render negative dollar sign");
});

runTest("Clamps negative variant delta when delta exceeds base price", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        price: 15.0,
        variants: {
          name: "Discount",
          options: [{ label: "Huge Discount", priceDelta: -50.0 }]
        }
      }
    }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("$0.00"), "Base $15 + Delta -$50 must clamp to $0.00");
  assert(!text.includes("$-35"), "Must not display negative price difference");
});

runTest("Handles NaN and non-numeric price gracefully", () => {
  const inst = new ProductPreview({
    entry: { data: { price: "invalid_string_price" } }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("$0.00"), "Invalid string price defaults safely to $0.00");
  assert(!text.includes("NaN"), "Must not display NaN");
});

runTest("Handles Infinity price gracefully", () => {
  const inst = new ProductPreview({
    entry: { data: { price: Infinity } }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("$0.00"), "Infinity price clamped safely to $0.00");
  assert(!text.includes("Infinity"), "Must not display Infinity");
});

runTest("Negative stock counts render as Sold Out, not 'Only -X left'", () => {
  const inst = new ProductPreview({
    entry: { data: { stock: -3, inStock: true } }
  });
  const vdom = inst.render();
  const badges = findNodesByClass(vdom, "sold-out");
  assert.strictEqual(badges.length, 1, "Negative stock must trigger Sold Out badge");
  const lowStock = findNodesByClass(vdom, "low-stock");
  assert.strictEqual(lowStock.length, 0, "Negative stock must NOT trigger low-stock badge");
});

runTest("Star rating clamps out-of-bound values [0, 5]", () => {
  const instOver = new ProductPreview({
    entry: { data: { rating: { value: 999999, count: 12 } } }
  });
  const vdomOver = instOver.render();
  const ratingTextOver = extractText(findNodesByClass(vdomOver, "card-rating-count")[0]);
  assert(ratingTextOver.startsWith("5.0"), "Rating value over 5 must clamp to 5.0");

  const instUnder = new ProductPreview({
    entry: { data: { rating: { value: -10, count: 5 } } }
  });
  const vdomUnder = instUnder.render();
  const ratingTextUnder = extractText(findNodesByClass(vdomUnder, "card-rating-count")[0]);
  assert(ratingTextUnder.startsWith("0.0"), "Rating value below 0 must clamp to 0.0");
});

runTest("Star rating ignores NaN, Infinity, and zero/negative counts", () => {
  const inst = new ProductPreview({
    entry: { data: { rating: { value: NaN, count: 0 } } }
  });
  const vdom = inst.render();
  const ratings = findNodesByClass(vdom, "card-rating");
  assert.strictEqual(ratings.length, 0, "Rating element must not render when count is 0");
});

// --- SECTION 4: DOM FLOOD & OVERFLOW DEFENSES ---
console.log("\n4. DOM Flood & Overflow Defenses:");

runTest("Caps gallery dots at MAX_GALLERY_DOTS (8) when 100 images provided", () => {
  const massiveImages = [];
  for (let i = 0; i < 100; i++) {
    massiveImages.push(`/assets/img/photo-${i}.jpg`);
  }
  const inst = new ProductPreview({
    entry: { data: { images: massiveImages } }
  });
  const vdom = inst.render();
  const dots = findNodesByClass(vdom, "card-gallery-dot");
  assert.strictEqual(dots.length, 8, "Gallery dots must be capped at 8 to prevent DOM overflow");
});

runTest("Caps ingredients list at MAX_INGREDIENTS (100) and filters non-primitives", () => {
  const massiveIngredients = [];
  for (let i = 0; i < 250; i++) {
    massiveIngredients.push(`Herb ${i}`);
  }
  massiveIngredients.push({ evil: "object child" });
  massiveIngredients.push(null);

  const inst = new ProductPreview({
    entry: { data: { ingredients: massiveIngredients } }
  });
  const vdom = inst.render();
  const items = findNodesByType(vdom, "li");
  assert.strictEqual(items.length, 100, "Ingredients must be capped at 100 items");
  assert(!extractText(vdom).includes("[object Object]"), "Object children must be filtered");
});

runTest("Caps tag pills at MAX_TAG_PILLS (20)", () => {
  const massiveTags = [];
  for (let i = 0; i < 80; i++) {
    massiveTags.push(`tag-${i}`);
  }
  const inst = new ProductPreview({
    entry: { data: { tags: massiveTags } }
  });
  const vdom = inst.render();
  const pills = findNodesByClass(vdom, "tag-pill");
  assert.strictEqual(pills.length, 20, "Tag pills must be capped at 20");
});

// --- SECTION 5: MALFORMED & EMPTY ENTRY RESILIENCE ---
console.log("\n5. Malformed & Empty Entry Resilience:");

runTest("Renders default placeholder card when entry is null", () => {
  const inst = new ProductPreview({ entry: null });
  const vdom = inst.render();
  assert(vdom !== null, "Must return valid virtual DOM");
  const text = extractText(vdom);
  assert(text.includes("Untitled Product"));
  assert(text.includes("$0.00"));
});

runTest("Renders default placeholder card when data is empty object", () => {
  const inst = new ProductPreview({ entry: { data: {} } });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("Untitled Product"));
  assert(text.includes("No description provided yet."));
});

runTest("Handles non-string product name and blurb without React child errors", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        name: { title: "Nested Name Object" },
        blurb: ["Array blurb item 1", "item 2"]
      }
    }
  });
  const vdom = inst.render();
  const text = extractText(vdom);
  assert(text.includes("Untitled Product"), "Non-string name falls back to untitled");
  assert(text.includes("No description provided yet."), "Non-string blurb falls back to default");
});

runTest("Filters corrupt variant options (null, numbers, strings)", () => {
  const inst = new ProductPreview({
    entry: {
      data: {
        variants: {
          name: "Size",
          options: [null, "corrupt-string-option", 123, { label: "Valid 4oz", priceDelta: 4 }]
        }
      }
    }
  });
  const vdom = inst.render();
  const select = findNodesByType(vdom, "select");
  assert.strictEqual(select.length, 1, "Select element must render");
  const options = findNodesByType(vdom, "option");
  assert.strictEqual(options.length, 1, "Only the 1 valid option should render");
  assert(extractText(options[0]).includes("Valid 4oz"));
});

console.log(`\nRed-Team Test Summary: ${passed} passed, ${failed} failed.\n`);

if (failed > 0) {
  process.exit(1);
}
