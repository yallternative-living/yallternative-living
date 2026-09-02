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

/* Mirrors pdpPageTitle() in scripts/build-site-data.js. Long product names
   pushed the title past the ~60 characters Google renders, and the brand at
   the end was what got truncated (live audit 2026-09-02, L-7). */
const PDP_TITLE_MAX = 60;
function pdpPageTitle(name) {
  const clean = String(name == null ? "" : name).trim();
  const full = clean + " | Y'allternative Living";
  if (full.length <= PDP_TITLE_MAX) return full;
  if (/y'?allternative/i.test(clean)) return clean;
  const short = clean + " | Y'allternative";
  return short.length <= PDP_TITLE_MAX ? short : clean;
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
  const expectedTitle = escapeHtml(pdpPageTitle(product.name));
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
  /* Mirrors rasterImagePath() in scripts/build-site-data.js: og:/twitter:
     images are never SVG, because no social card renderer draws one. The
     five coming-soon products' placeholder SVG maps to its 1200x630 JPEG
     twin; every real photo passes through untouched (audit C, H3). */
  const expectedOgImage =
    DOMAIN +
    "/" +
    (/\.svg$/i.test(String(product.image))
      ? "assets/img/placeholder-coming-soon-og.jpg"
      : String(product.image).replace(/^\/+/, ""));
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
    ldBlocks.forEach((b) => {
      try {
        const ld = JSON.parse(b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
        types.push(ld["@type"]);
      } catch (e) {
        parsedOk = false;
      }
    });
    assert(parsedOk, `${product.id}: every JSON-LD block parses`);
    assert(
      types.includes("Product") && types.includes("BreadcrumbList"),
      `${product.id}: PDP carries Product and BreadcrumbList JSON-LD (got ${types.join(", ") || "none"})`
    );
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
  /* Coming-soon products report "out of stock", matching
     schemaAvailability() in build-site-data.js. They used to say "preorder",
     which asserts an order can be placed -- these pages offer a waitlist and
     a disabled buy button (2026-09-02 live audit, M-5). The og value and the
     JSON-LD value are checked against each other further down, so the two can
     never drift apart again. */
  const expectedAvailability =
    product.inStock === false || product.stock === 0 || product.comingSoon
      ? "out of stock"
      : "in stock";
  assert(
    html.includes(`<meta property="product:availability" content="${expectedAvailability}">`),
    `${product.id}: product:availability is ${expectedAvailability}`
  );

  /* The OG value and the JSON-LD value have to say the same thing. They have
     agreed so far by luck of both being derived from the same helper; nothing
     checked it, so the day one of the two mappings changed on its own the page
     would have advertised two different availabilities to two different
     crawlers. Parse the block rather than substring-matching, and assert it
     was found -- a missing offers object must fail, not quietly pass. */
  const OG_TO_SCHEMA = {
    "in stock": "https://schema.org/InStock",
    "out of stock": "https://schema.org/OutOfStock",
    preorder: "https://schema.org/PreOrder"
  };
  const productLdMatch = html.match(
    /<script type="application\/ld\+json">\s*(\{[\s\S]*?"@type": "Product"[\s\S]*?)\s*<\/script>/
  );
  let productLd = null;
  try {
    productLd = productLdMatch ? JSON.parse(productLdMatch[1].split("<\\/").join("</")) : null;
  } catch (e) {
    productLd = null;
  }
  assert(!!(productLd && productLd.offers), `${product.id}: Product JSON-LD offers block parses`);
  if (productLd && productLd.offers) {
    assert(
      productLd.offers.availability === OG_TO_SCHEMA[expectedAvailability],
      `${product.id}: JSON-LD availability agrees with product:availability`,
      `${productLd.offers.availability} vs ${OG_TO_SCHEMA[expectedAvailability]}`
    );
  }

  /* 5. Exactly ONE schema.org Product entity, and it is the JSON-LD one.
     Every PDP used to carry a second, thin Product in microdata alongside
     the complete JSON-LD block: name, image, description and a flat price,
     with no availability, url, brand or sku. Rich Results Test reported two
     Product items per page, and on frankincense-salve the microdata claimed
     a single price while the JSON-LD correctly declared an AggregateOffer of
     $13.99-$19.99 (audit C, finding L5). These assertions replace the old
     itemprop ones one-for-one -- same facts, asserted against the vocabulary
     the site actually kept, so nothing stopped being checked. */
  assert(
    !/\bitemscope\b/.test(html) && !/\bitemprop=/.test(html),
    `${product.id}: no schema.org microdata left to compete with the JSON-LD Product`
  );
  {
    const ldBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    const products = [];
    ldBlocks.forEach((b) => {
      try {
        const ld = JSON.parse(b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
        if (ld && ld["@type"] === "Product") products.push(ld);
      } catch (e) {
        /* the "every JSON-LD block parses" assertion above owns this case */
      }
    });
    assert(
      products.length === 1,
      `${product.id}: exactly one Product entity on the page (found ${products.length})`
    );
    const ld = products[0] || {};
    assert(ld.name === product.name, `${product.id}: JSON-LD Product name matches`);
    assert(
      ld.description === (product.description || product.blurb || ""),
      `${product.id}: JSON-LD Product description matches the visible blurb`
    );
    const ldImages = [].concat(ld.image || []);
    assert(
      ldImages.length > 0 && ldImages.every((u) => /^https:\/\//.test(u) && !/\.svg$/i.test(u)),
      `${product.id}: JSON-LD Product image(s) are absolute and raster (${ldImages.length})`
    );
    const offers = ld.offers || {};
    assert(
      offers.priceCurrency === "USD",
      `${product.id}: JSON-LD offer priceCurrency is USD (got ${offers.priceCurrency})`
    );
    /* The advertised floor: the cheapest buyable variant, which is what the
       AggregateOffer's lowPrice must be for a multi-price product and what a
       single Offer's price must be otherwise. This is the number the old
       microdata got wrong on frankincense-salve. */
    const ldLow =
      offers["@type"] === "AggregateOffer" ? String(offers.lowPrice) : String(offers.price);
    assert(
      ldLow === expectedLowPrice,
      `${product.id}: JSON-LD advertises the cheapest buyable variant (${expectedLowPrice}, got ${ldLow})`
    );
    assert(
      typeof offers.availability === "string" &&
        offers.availability.startsWith("https://schema.org/"),
      `${product.id}: JSON-LD offer declares availability (${offers.availability})`
    );
    assert(
      !!ld.url && !!ld.sku && !!ld.brand,
      `${product.id}: JSON-LD Product has url, sku and brand`
    );
  }
  /* The visible headline price is still the pre-selected option (the first
     variant not sold out), which is what the radio group starts on. It just
     is not a schema.org claim any more -- main.js rewrites it on every size
     change through the .pdp-price-value hook. */
  assert(
    html.includes(`<span class="pdp-price-value">${expectedSelectedPrice}</span>`),
    `${product.id}: visible headline price is the pre-selected option (${expectedSelectedPrice})`
  );
  assert(
    html.includes(`<p class="pdp-blurb">${expectedDesc}</p>`),
    `${product.id}: visible blurb matches products.json`
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
