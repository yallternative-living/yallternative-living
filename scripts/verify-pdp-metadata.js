const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const productsJsonPath = path.join(ROOT, "assets/data/products.json");
const productsData = JSON.parse(fs.readFileSync(productsJsonPath, "utf8"));
const DOMAIN = "https://yallternativeliving.com";

console.log("===================================================================");
console.log("   EMPIRICAL PDP METADATA (JSON-LD & OPENGRAPH) VERIFICATION       ");
console.log("===================================================================\n");

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const msg = `  ✗ ${label}${detail ? " — " + detail : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

console.log(`Auditing metadata across all ${productsData.products.length} products...\n`);

productsData.products.forEach((product) => {
  const pdpPath = path.join(ROOT, "products", `${product.id}.html`);
  console.log(`--- Checking Metadata for: ${product.id} ---`);

  assert(fs.existsSync(pdpPath), `PDP file exists for ${product.id}`);
  if (!fs.existsSync(pdpPath)) return;

  const html = fs.readFileSync(pdpPath, "utf8");

  // 1. Title & Meta Description
  const expectedTitle = escapeHtml(product.name) + " | Y'allternative Living";
  const expectedDesc = escapeHtml(product.description || product.blurb || "");
  const expectedOgImage = DOMAIN + "/" + String(product.image).replace(/^\/+/, "");
  const expectedOgUrl = DOMAIN + "/products/" + product.id + ".html";

  assert(html.includes(`<title>${expectedTitle}</title>`), `${product.id}: <title> tag matches`);
  assert(
    html.includes(`<meta name="description" content="${expectedDesc}">`),
    `${product.id}: meta description matches`
  );
  assert(
    html.includes(`<link rel="canonical" href="${DOMAIN}/shop.html">`),
    `${product.id}: canonical link points to shop.html`
  );

  // 2. OpenGraph Meta Tags
  assert(
    html.includes('<meta property="og:type" content="product">'),
    `${product.id}: og:type is product`
  );
  assert(
    html.includes(`<meta property="og:title" content="${expectedTitle}">`),
    `${product.id}: og:title matches`
  );
  assert(
    html.includes(`<meta property="og:description" content="${expectedDesc}">`),
    `${product.id}: og:description matches`
  );
  assert(
    html.includes(`<meta property="og:image" content="${expectedOgImage}">`),
    `${product.id}: og:image is absolute and matches`
  );
  assert(
    html.includes(`<meta property="og:url" content="${expectedOgUrl}">`),
    `${product.id}: og:url is absolute and matches`
  );
  assert(
    html.includes('<meta property="og:site_name" content="Y\'allternative Living">'),
    `${product.id}: og:site_name matches`
  );

  // 3. Twitter Card Tags
  assert(
    html.includes('<meta name="twitter:card" content="summary_large_image">'),
    `${product.id}: twitter:card is summary_large_image`
  );
  assert(
    html.includes(`<meta name="twitter:title" content="${expectedTitle}">`),
    `${product.id}: twitter:title matches`
  );
  assert(
    html.includes(`<meta name="twitter:description" content="${expectedDesc}">`),
    `${product.id}: twitter:description matches`
  );
  assert(
    html.includes(`<meta name="twitter:image" content="${expectedOgImage}">`),
    `${product.id}: twitter:image matches`
  );

  // 4. E-Commerce OpenGraph Tags
  assert(
    html.includes(`<meta property="product:price:amount" content="${product.price.toFixed(2)}">`),
    `${product.id}: product:price:amount matches ${product.price.toFixed(2)}`
  );
  assert(
    html.includes('<meta property="product:price:currency" content="USD">'),
    `${product.id}: product:price:currency is USD`
  );
  const expectedAvailability = product.comingSoon ? "preorder" : "in stock";
  assert(
    html.includes(`<meta property="product:availability" content="${expectedAvailability}">`),
    `${product.id}: product:availability is ${expectedAvailability}`
  );

  // 5. Schema.org Product Microdata
  assert(
    html.includes('itemscope itemtype="https://schema.org/Product"'),
    `${product.id}: schema.org Product itemscope declaration present`
  );
  assert(
    html.includes(`itemprop="name">${escapeHtml(product.name)}</h1>`),
    `${product.id}: itemprop="name" matches`
  );
  assert(
    html.includes(`itemprop="image"`),
    `${product.id}: itemprop="image" present on main image`
  );
  assert(
    html.includes('itemprop="offers" itemscope itemtype="https://schema.org/Offer"'),
    `${product.id}: itemprop="offers" Offer declaration present`
  );
  assert(
    html.includes('itemprop="priceCurrency" content="USD"'),
    `${product.id}: itemprop="priceCurrency" is USD`
  );
  assert(
    html.includes(`itemprop="price" content="${product.price.toFixed(2)}"`),
    `${product.id}: itemprop="price" content matches ${product.price.toFixed(2)}`
  );
  assert(
    html.includes(`itemprop="description">${expectedDesc}</p>`),
    `${product.id}: itemprop="description" matches`
  );

  // 6. Image File Existence on Disk
  const imageLocalPath = path.join(ROOT, String(product.image).replace(/^\/+/, ""));
  assert(
    fs.existsSync(imageLocalPath),
    `${product.id}: image file exists on disk at ${product.image}`
  );
});

console.log("\n===================================================================");
console.log(`METADATA VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log("===================================================================");

if (failed > 0) {
  console.error(`\nFAILED ASSERTIONS:`);
  errors.forEach((e) => console.error(e));
  process.exit(1);
} else {
  console.log("\nALL PDP OPENGRAPH & SCHEMA.ORG METADATA ASSERTIONS PASSED (100% GREEN).");
  process.exit(0);
}
