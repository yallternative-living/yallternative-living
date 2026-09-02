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

/* Mirrors truncateForMeta() in scripts/build-site-data.js. Product blurbs
   run to 304 characters and Google cuts descriptions around 155-160, so the
   PDP meta/og/twitter description is trimmed at a word boundary while the
   visible on-page copy keeps the full text. */
function truncateForMeta(text, maxLen) {
  const limit = maxLen || 155;
  const clean = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  const slice = clean.slice(0, limit - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return base.replace(/[\s,;:.!?-]+$/, "") + "\u2026";
}

/* Mirrors variantPriceRange(): the advertised price is the cheapest buyable
   variant, which is not the base price when a variant has a negative delta
   (frankincense-salve's 1oz option is -$6). */
function advertisedLowPrice(product) {
  const options =
    product.variants && Array.isArray(product.variants.options) ? product.variants.options : [];
  const available = options.filter((o) => !o.soldOut);
  const pool = available.length ? available : options;
  if (!pool.length) return product.price;
  return Math.min.apply(
    null,
    pool.map((o) => product.price + (o.priceDelta || 0))
  );
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
  const rawDesc = product.description || product.blurb || "";
  const expectedDesc = escapeHtml(rawDesc);
  const expectedMetaDesc = escapeHtml(truncateForMeta(rawDesc, 155));
  const expectedLowPrice = advertisedLowPrice(product).toFixed(2);
  /* The headline price is the pre-selected option (first not sold out), the
     same figure the radio group starts on; the range lives in the JSON-LD. */
  const firstOpen =
    product.variants && Array.isArray(product.variants.options)
      ? product.variants.options.find(function (o) {
          return o && !o.soldOut;
        })
      : null;
  const expectedSelectedPrice = (
    firstOpen ? product.price + (Number(firstOpen.priceDelta) || 0) : advertisedLowPrice(product)
  ).toFixed(2);
  const expectedOgImage = DOMAIN + "/" + String(product.image).replace(/^\/+/, "");
  const expectedOgUrl = DOMAIN + "/products/" + product.id + ".html";

  assert(html.includes(`<title>${expectedTitle}</title>`), `${product.id}: <title> tag matches`);
  assert(
    html.includes(`<meta name="description" content="${expectedMetaDesc}">`),
    `${product.id}: meta description matches (truncated at a word boundary)`
  );
  // Measured on the text a reader (and Google) actually sees, i.e. before
  // HTML-escaping turns one apostrophe into six characters.
  assert(
    truncateForMeta(rawDesc, 155).length <= 155,
    `${product.id}: meta description is 155 characters or fewer`
  );
  assert(
    html.includes(`<link rel="canonical" href="${DOMAIN}/products/${product.id}.html">`),
    `${product.id}: canonical link points to the product page itself`
  );

  /* Real, indexable pages since 2026-09-01 (the H-15 doorway decision was
     reversed): no noindex, no redirect, and the page carries its own
     Product + BreadcrumbList JSON-LD. */
  assert(
    !/<meta name="robots" content="[^"]*noindex/.test(html),
    `${product.id}: PDP is indexable (no noindex)`
  );
  assert(!html.includes("window.location.replace"), `${product.id}: PDP does not redirect away`);
  {
    const ldBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    let parsedOk = true;
    const types = [];
    let productLd = null;
    ldBlocks.forEach((b) => {
      try {
        const ld = JSON.parse(b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
        types.push(ld["@type"]);
        if (ld["@type"] === "Product") productLd = ld;
      } catch (e) {
        parsedOk = false;
      }
    });
    assert(parsedOk, `${product.id}: every JSON-LD block parses`);
    assert(
      types.includes("Product") && types.includes("BreadcrumbList"),
      `${product.id}: PDP carries Product and BreadcrumbList JSON-LD (got ${types.join(", ") || "none"})`
    );

    /* The return policy Google reads has to agree with the one the shop
       publishes. policies.html makes opened salves, scrubs, balms and soaks
       FINAL SALE and offers a 14-day exchange only on unworn apparel and
       still-sealed goods; every PDP nonetheless advertised a blanket 14-day
       MerchantReturnFiniteReturnWindow, i.e. a return right on exactly the
       products where it is refused (live audit M4). */
    if (productLd) {
      const FINAL_SALE_CATEGORIES = ["salves", "body", "soaks", "ritual", "potions"];
      const offers = productLd.offers || {};
      const policy = offers.hasMerchantReturnPolicy;
      if (product.id === "yallternative-gift-card") {
        assert(
          !policy,
          `${product.id}: emailed gift card advertises no return policy`,
          JSON.stringify(policy || null)
        );
      } else if (FINAL_SALE_CATEGORIES.indexOf(product.category) !== -1) {
        assert(
          !!policy &&
            policy.returnPolicyCategory === "https://schema.org/MerchantReturnNotPermitted",
          `${product.id}: final-sale category "${product.category}" declares MerchantReturnNotPermitted`,
          JSON.stringify((policy && policy.returnPolicyCategory) || null)
        );
        assert(
          !!policy &&
            policy.merchantReturnDays === undefined &&
            policy.returnMethod === undefined &&
            policy.returnFees === undefined,
          `${product.id}: final-sale policy carries no return window, method or fee`,
          JSON.stringify(policy || null)
        );
      } else {
        assert(
          !!policy &&
            policy.returnPolicyCategory === "https://schema.org/MerchantReturnFiniteReturnWindow" &&
            policy.merchantReturnDays === 14,
          `${product.id}: exchangeable category "${product.category}" declares the real 14-day window`,
          JSON.stringify(policy || null)
        );
      }
    }
  }
  assert(
    !html.includes("#category-"),
    `${product.id}: no dead shop.html#category- breadcrumb anchor`
  );
  assert(
    html.includes(`href="../shop.html#${product.category}"`),
    `${product.id}: category breadcrumb points at shop.html#${product.category}`
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
    html.includes(`<meta property="og:description" content="${expectedMetaDesc}">`),
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
    html.includes(`<meta name="twitter:description" content="${expectedMetaDesc}">`),
    `${product.id}: twitter:description matches`
  );
  assert(
    html.includes(`<meta name="twitter:image" content="${expectedOgImage}">`),
    `${product.id}: twitter:image matches`
  );

  // 4. E-Commerce OpenGraph Tags
  assert(
    html.includes(`<meta property="product:price:amount" content="${expectedLowPrice}">`),
    `${product.id}: product:price:amount is the cheapest buyable variant (${expectedLowPrice})`
  );
  assert(
    html.includes('<meta property="product:price:currency" content="USD">'),
    `${product.id}: product:price:currency is USD`
  );
  const expectedAvailability =
    product.inStock === false || product.stock === 0
      ? "out of stock"
      : product.comingSoon
        ? "preorder"
        : "in stock";
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
    html.includes(`itemprop="price" content="${expectedSelectedPrice}"`),
    `${product.id}: itemprop="price" matches the pre-selected option price (${expectedSelectedPrice})`
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
