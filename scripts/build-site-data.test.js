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
assert(
  existingIds.has("new-salve") && existingIds.has("salve-1-3") && existingIds.has("prod-3"),
  "generateUniqueId adds new ids to the existingSet"
);

const unslugifiableSet = new Set();
eq(
  buildScript.generateUniqueId(unslugifiableSet, "!!!", "prod", 0),
  "prod-1",
  "generateUniqueId falls back to prefix when slugify produces empty string"
);

const longCollisionSet = new Set(["base", "base-2", "base-3", "base-4", "base-5"]);
eq(
  buildScript.generateUniqueId(longCollisionSet, "base", "prod", 0),
  "base-6",
  "generateUniqueId correctly handles long collision chains"
);

const nullSet = new Set();
eq(
  buildScript.generateUniqueId(nullSet, null, "prod", 99),
  "prod-100",
  "generateUniqueId falls back to prefix when rawName is null"
);
eq(
  buildScript.generateUniqueId(nullSet, undefined, "prod", 100),
  "prod-101",
  "generateUniqueId falls back to prefix when rawName is undefined"
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

/* 9. PDP Merchandising Helper Functions */
const freshnessBadgeHtml = buildScript.renderFreshnessBadgeHtml();
assert(
  freshnessBadgeHtml.indexOf("pdp-freshness-badge") !== -1 &&
    freshnessBadgeHtml.indexOf("Poured in Landrum, SC · Small-Batch Promise") !== -1,
  "renderFreshnessBadgeHtml generates small-batch promise trust badge"
);

const testApothecaryProd = {
  id: "test-salve",
  name: "Test Botanical Salve",
  category: "salves",
  price: 19.99,
  image: "assets/img/frankincense-salve.jpg",
  blurb: "Handcrafted salve test.",
  scentProfile: {
    top: "Lavender, Bergamot",
    heart: "Chamomile, Tea Tree",
    base: "Frankincense, Beeswax",
    intensity: "Medium",
    intensityScore: 3
  },
  usageGuide: {
    howToApply: "Massage a small amount into skin.",
    storage: "Store in cool dry place. Shelf life 6-12 months.",
    patchTest: "Apply small dab to inner wrist 24 hours prior to use."
  }
};

const scentProfileMarkup = buildScript.renderScentProfileHtml(testApothecaryProd);
assert(
  scentProfileMarkup.indexOf("pdp-scent-profile") !== -1 &&
    scentProfileMarkup.indexOf("Lavender, Bergamot") !== -1 &&
    scentProfileMarkup.indexOf("Chamomile, Tea Tree") !== -1 &&
    scentProfileMarkup.indexOf("Frankincense, Beeswax") !== -1 &&
    scentProfileMarkup.indexOf("Intensity:") !== -1 &&
    scentProfileMarkup.indexOf("width:60%;") !== -1,
  "renderScentProfileHtml generates note pyramid and intensity badge"
);

const usageAccordionMarkup = buildScript.renderUsageAccordionsHtml(testApothecaryProd);
assert(
  usageAccordionMarkup.indexOf('<details class="pdp-accordion">') !== -1 &&
    usageAccordionMarkup.indexOf("How to Apply") !== -1 &&
    usageAccordionMarkup.indexOf("Storage &amp; Shelf Life") !== -1 &&
    usageAccordionMarkup.indexOf("Patch Test Guidelines") !== -1 &&
    usageAccordionMarkup.indexOf("Massage a small amount into skin.") !== -1,
  "renderUsageAccordionsHtml generates accessible details accordions"
);

const pdpHtmlOutput = buildScript.renderProductPdpHtml(
  testApothecaryProd,
  "https://yallternativeliving.com",
  "Salves & Balms"
);
assert(
  pdpHtmlOutput.indexOf("<!DOCTYPE html>") !== -1 &&
    pdpHtmlOutput.indexOf('class="pdp-page"') !== -1 &&
    pdpHtmlOutput.indexOf("pdp-freshness-badge") !== -1 &&
    pdpHtmlOutput.indexOf("pdp-scent-profile") !== -1 &&
    pdpHtmlOutput.indexOf("pdp-accordion") !== -1 &&
    pdpHtmlOutput.indexOf('href="../shop.html#salves"') !== -1,
  "renderProductPdpHtml generates complete PDP page with 4-tier breadcrumb markup"
);
assert(
  pdpHtmlOutput.indexOf("#category-salves") === -1,
  "PDP category breadcrumb has no dead #category- prefix"
);

/* H-15: PDPs redirect to shop.html and canonicalise there, so they carry no
   Product/Offer/BreadcrumbList schema of their own (shop.html's ItemList
   does) and they say noindex outright. */
assert(
  pdpHtmlOutput.indexOf('type="application/ld+json"') === -1,
  "PDP emits no JSON-LD (the shop page carries the catalogue schema)"
);
assert(
  pdpHtmlOutput.indexOf('<meta name="robots" content="noindex, follow">') !== -1,
  "PDP is explicitly noindex, follow"
);
assert(
  pdpHtmlOutput.indexOf(
    '<link rel="canonical" href="https://yallternativeliving.com/shop.html">'
  ) !== -1,
  "PDP still canonicalises to shop.html"
);

/* Meta descriptions are truncated at a word boundary; the visible blurb is
   not. */
const longDescProd = Object.assign({}, testApothecaryProd, {
  description:
    "Calendula, arnica and five other botanicals in a beeswax base for cracked hands, " +
    "windburn, razor bumps, dry cuticles, scraped knees and every other rough patch a " +
    "Southern summer can hand you, poured in very small batches in Landrum South Carolina."
});
const longDescPdp = buildScript.renderProductPdpHtml(
  longDescProd,
  "https://yallternativeliving.com",
  "Salves & Balms"
);
const metaDescMatch = longDescPdp.match(/<meta name="description" content="([^"]*)">/);
assert(Boolean(metaDescMatch), "PDP emits a meta description");
assert(
  metaDescMatch && metaDescMatch[1].length <= 155,
  "PDP meta description is trimmed to 155 characters or fewer"
);
assert(
  metaDescMatch && /\u2026$/.test(metaDescMatch[1]) && !/\s\u2026$/.test(metaDescMatch[1]),
  "PDP meta description is cut at a word boundary and ellipsised"
);
assert(
  longDescPdp.indexOf("poured in very small batches in Landrum South Carolina.") !== -1,
  "the visible on-page description keeps the full text"
);

/* A negative price delta means the advertised price is the cheapest buyable
   variant, not the base price (frankincense-salve's 1oz option is -$6). */
const deltaProd = {
  id: "delta-salve",
  name: "Delta Salve",
  price: 19.99,
  image: "assets/img/x.jpg",
  blurb: "b",
  variants: { name: "Size", options: [{ label: "2oz" }, { label: "1oz", priceDelta: -6 }] }
};
const deltaPdp = buildScript.renderProductPdpHtml(
  deltaProd,
  "https://yallternativeliving.com",
  "Salves & Balms"
);
assert(
  deltaPdp.indexOf('<meta property="product:price:amount" content="13.99">') !== -1,
  "og price is the cheapest buyable variant, not the base price"
);
assert(
  deltaPdp.indexOf('itemprop="price" content="13.99"') !== -1,
  "microdata price matches the advertised low price"
);

/* 10. Google Merchant Rich Product JSON-LD & BreadcrumbList (R5) */
const singlePriceProd = {
  id: "lavender-salve",
  name: "Pure Lavender Salve",
  category: "salves",
  price: 16.5,
  image: "assets/img/lavender-salve.jpg",
  images: ["assets/img/lavender-salve-alt.jpg"],
  blurb: "Gentle lavender bedtime salve.",
  inStock: true
};

const singlePriceLd = buildScript.generateProductJsonLd(
  singlePriceProd,
  "https://yallternativeliving.com",
  "Salves & Balms"
);

eq(singlePriceLd["@context"], "https://schema.org", "generateProductJsonLd sets schema context");
eq(singlePriceLd["@type"], "Product", "generateProductJsonLd sets @type to Product");
eq(singlePriceLd.name, "Pure Lavender Salve", "generateProductJsonLd sets name");
eq(singlePriceLd.sku, "lavender-salve", "generateProductJsonLd sets sku");
eq(singlePriceLd.mpn, "lavender-salve", "generateProductJsonLd sets mpn");
eq(singlePriceLd.category, "Salves & Balms", "generateProductJsonLd sets category");
eq(
  singlePriceLd.image,
  [
    "https://yallternativeliving.com/assets/img/lavender-salve.jpg",
    "https://yallternativeliving.com/assets/img/lavender-salve-alt.jpg"
  ],
  "generateProductJsonLd aggregates all image URLs into array"
);
eq(
  singlePriceLd.brand,
  { "@type": "Brand", name: "Y'allternative Living" },
  "generateProductJsonLd sets Brand"
);
eq(singlePriceLd.offers["@type"], "Offer", "Single-price product generates Offer schema");
eq(singlePriceLd.offers.price, "16.50", "Offer price formatted to 2 decimal places");
eq(singlePriceLd.offers.priceCurrency, "USD", "Offer priceCurrency is USD");
eq(
  singlePriceLd.offers.availability,
  "https://schema.org/InStock",
  "In-stock product availability is InStock"
);
eq(
  singlePriceLd.offers.hasMerchantReturnPolicy,
  {
    "@type": "MerchantReturnPolicy",
    applicableCountry: "US",
    returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    merchantReturnDays: 30,
    returnMethod: "https://schema.org/ReturnByMail",
    returnFees: "https://schema.org/FreeReturn",
    returnLink: "https://yallternativeliving.com/policies.html"
  },
  "generateProductJsonLd attaches 30-day US MerchantReturnPolicy"
);
assert(
  Array.isArray(singlePriceLd.offers.shippingDetails) &&
    singlePriceLd.offers.shippingDetails.length === 2 &&
    singlePriceLd.offers.shippingDetails[0].shippingRate.value === "10.00" &&
    singlePriceLd.offers.shippingDetails[1].shippingRate.value === "0.00" &&
    singlePriceLd.offers.shippingDetails[1].freeShippingThreshold.eligibleTransactionVolume
      .price === "40.00",
  "generateProductJsonLd attaches flat-rate and free shippingDetails"
);
eq(
  singlePriceLd.aggregateRating,
  undefined,
  "generateProductJsonLd omits aggregateRating when product has no rating"
);

// Variant-price product JSON-LD
const variantProd = {
  id: "potion-var",
  name: "Magic Potion",
  category: "potions",
  price: 20.0,
  image: "assets/img/potion.jpg",
  variants: {
    options: [
      { label: "1oz", priceDelta: -5.0 },
      { label: "2oz", priceDelta: 0 },
      { label: "4oz", priceDelta: 10.0 }
    ]
  },
  rating: {
    value: 4.9,
    count: 22
  }
};

const variantLd = buildScript.generateProductJsonLd(
  variantProd,
  "https://yallternativeliving.com",
  "Potions & Mists"
);
eq(variantLd.offers["@type"], "AggregateOffer", "Variant product generates AggregateOffer schema");
eq(variantLd.offers.lowPrice, "15.00", "AggregateOffer lowPrice matches min variant");
eq(variantLd.offers.highPrice, "30.00", "AggregateOffer highPrice matches max variant");
eq(variantLd.offers.offerCount, 3, "AggregateOffer offerCount matches option count");
eq(
  variantLd.aggregateRating,
  {
    "@type": "AggregateRating",
    ratingValue: 4.9,
    reviewCount: 22,
    bestRating: "5",
    worstRating: "1"
  },
  "generateProductJsonLd attaches AggregateRating when rating data exists"
);

// Out of stock product
const oosProd = {
  id: "soldout-item",
  name: "Sold Out Item",
  category: "soaks",
  price: 18.0,
  inStock: false
};
const oosLd = buildScript.generateProductJsonLd(oosProd, "https://yallternativeliving.com");
eq(
  oosLd.offers.availability,
  "https://schema.org/OutOfStock",
  "OutOfStock availability when inStock is false"
);

const zeroStockProd = {
  id: "zero-stock-item",
  name: "Zero Stock Item",
  category: "soaks",
  price: 18.0,
  stock: 0
};
const zeroStockLd = buildScript.generateProductJsonLd(
  zeroStockProd,
  "https://yallternativeliving.com"
);
eq(
  zeroStockLd.offers.availability,
  "https://schema.org/OutOfStock",
  "OutOfStock availability when stock is 0"
);

// Pre-order / coming soon product
const preorderProd = {
  id: "coming-soon-item",
  name: "Coming Soon Item",
  category: "apparel",
  price: 35.0,
  comingSoon: true
};
const preorderLd = buildScript.generateProductJsonLd(
  preorderProd,
  "https://yallternativeliving.com"
);
eq(
  preorderLd.offers.availability,
  "https://schema.org/PreOrder",
  "PreOrder availability when comingSoon is true"
);

// BreadcrumbList JSON-LD
const breadcrumbLd = buildScript.generateProductBreadcrumbJsonLd(
  singlePriceProd,
  "https://yallternativeliving.com",
  "Salves & Balms"
);
eq(breadcrumbLd["@context"], "https://schema.org", "generateProductBreadcrumbJsonLd sets context");
eq(
  breadcrumbLd["@type"],
  "BreadcrumbList",
  "generateProductBreadcrumbJsonLd sets @type to BreadcrumbList"
);
assert(
  Array.isArray(breadcrumbLd.itemListElement) && breadcrumbLd.itemListElement.length === 4,
  "generateProductBreadcrumbJsonLd generates 4-tier itemListElement"
);
eq(
  breadcrumbLd.itemListElement[0],
  {
    "@type": "ListItem",
    position: 1,
    name: "Home",
    item: "https://yallternativeliving.com/index.html"
  },
  "Breadcrumb Tier 1 is Home"
);
eq(
  breadcrumbLd.itemListElement[1],
  {
    "@type": "ListItem",
    position: 2,
    name: "Shop",
    item: "https://yallternativeliving.com/shop.html"
  },
  "Breadcrumb Tier 2 is Shop"
);
eq(
  breadcrumbLd.itemListElement[2],
  {
    "@type": "ListItem",
    position: 3,
    name: "Salves & Balms",
    item: "https://yallternativeliving.com/shop.html#salves"
  },
  "Breadcrumb Tier 3 is Category (plain #<categoryId>, the anchor shop.html actually has)"
);
eq(
  breadcrumbLd.itemListElement[3],
  {
    "@type": "ListItem",
    position: 4,
    name: "Pure Lavender Salve",
    item: "https://yallternativeliving.com/products/lavender-salve.html"
  },
  "Breadcrumb Tier 4 is Product"
);

/* ---------- C-4: escaping into script and attribute contexts ---------- */
eq(
  buildScript.escapeJsonForScript('{"name":"</script><img src=x>"}'),
  '{"name":"\\u003c/script\\u003e\\u003cimg src=x\\u003e"}',
  "escapeJsonForScript neutralises </script> inside JSON"
);
eq(
  buildScript.escapeJsonForScript('{"a":"x & y"}'),
  '{"a":"x \\u0026 y"}',
  "escapeJsonForScript escapes ampersands as \\u0026 (round-trips to '&')"
);
eq(
  JSON.parse(buildScript.escapeJsonForScript(JSON.stringify({ c: "Salves & Balms" }))).c,
  "Salves & Balms",
  "escaped JSON-LD still parses back to the exact original text"
);
eq(
  JSON.parse(buildScript.escapeJsonForScript(JSON.stringify({ n: "</script><b>" }))).n,
  "</script><b>",
  "escaped JSON-LD round-trips a </script> payload byte for byte"
);
assert(
  buildScript
    .jsonLdScriptBlock({ "@type": "Product", name: "</script>" }, "")
    .indexOf("</script>\n") === -1,
  "jsonLdScriptBlock never emits a nested closing script tag from data"
);

eq(
  buildScript.jsStringLiteral('"; fetch("https://evil.example"); //'),
  '"\\"; fetch(\\"https://evil.example\\"); //"',
  "jsStringLiteral keeps an injected quote inside the JS string literal"
);
eq(
  buildScript.jsStringLiteral("</script><script>alert(1)</script>"),
  '"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"',
  "jsStringLiteral escapes < so the inline script block cannot be closed"
);
eq(
  JSON.parse(buildScript.jsStringLiteral("6a9687f6adddbc3447585d73")),
  "6a9687f6adddbc3447585d73",
  "jsStringLiteral round-trips a real Tawk.to property id"
);

/* ---------- C-4: content.json integration IDs are validated ---------- */
const originalExit = process.exit;
const originalError = console.error;
function siteIdsRejected(site) {
  let exited = false;
  process.exit = function () {
    exited = true;
    throw new Error("__exit__");
  };
  console.error = function () {};
  try {
    buildScript.validateSiteIds(site);
  } catch (e) {
    if (e.message !== "__exit__") throw e;
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return exited;
}
assert(
  siteIdsRejected({ tawkToWidgetId: '"; fetch("https://evil.example"); //' }),
  "build refuses a Tawk.to widget id carrying a JS payload"
);
assert(
  siteIdsRejected({ tawkToPropertyId: "</script><script>alert(1)</script>" }),
  "build refuses a Tawk.to property id carrying markup"
);
assert(
  siteIdsRejected({ umamiWebsiteId: 'x" onload="alert(1)' }),
  "build refuses an Umami id that breaks out of its attribute"
);
assert(
  siteIdsRejected({ formspreeContactId: "../../evil" }),
  "build refuses a Formspree id with path characters"
);
assert(
  !siteIdsRejected({
    tawkToPropertyId: "6a9687f6adddbc3447585d73",
    tawkToWidgetId: "1k1e066pc",
    umamiWebsiteId: "YOUR_UMAMI_WEBSITE_ID",
    giftUpId: "YOUR_GIFTUP_ID",
    formspreeContactId: "xoeqevqv",
    formspreeReviewId: "xzebezbl",
    formspreeRestockId: "xwlklppo"
  }),
  "the real content.json values pass validation"
);
assert(!siteIdsRejected({ umamiWebsiteId: "", giftUpId: "" }), "empty ids mean 'not configured'");

/* ---------- ratings, availability, meta truncation ---------- */
eq(buildScript.clampRating(500, 5), 5, "clampRating caps a rating at 5");
eq(buildScript.clampRating(-2, 5), 0, "clampRating floors a rating at 0");
eq(buildScript.clampRating("not a number", 5), 5, "clampRating falls back for non-numeric input");
eq(buildScript.clampRating(4.5, 5), 4.5, "clampRating leaves a valid rating alone");

eq(
  buildScript.schemaAvailability({ comingSoon: true, image: "assets/img/real-photo.jpg" }),
  "https://schema.org/PreOrder",
  "availability comes from comingSoon, not the image filename"
);
eq(
  buildScript.schemaAvailability({ image: "assets/img/placeholder-coming-soon.svg" }),
  "https://schema.org/InStock",
  "a placeholder photo alone no longer implies PreOrder"
);
eq(
  buildScript.schemaAvailability({ inStock: false }),
  "https://schema.org/OutOfStock",
  "inStock:false is OutOfStock"
);
eq(
  buildScript.schemaAvailability({ stock: 0 }),
  "https://schema.org/OutOfStock",
  "stock:0 is OutOfStock"
);

eq(buildScript.truncateForMeta("short one", 155), "short one", "truncateForMeta leaves short text");
const longMeta = buildScript.truncateForMeta("word ".repeat(60), 155);
assert(longMeta.length <= 155, "truncateForMeta respects the 155-character limit");
assert(/word\u2026$/.test(longMeta), "truncateForMeta cuts at a word boundary");

/* ---------- FAQ markdown links ---------- */
eq(
  buildScript.renderFaqAnswerHtml("See the [events page](events.html) for dates."),
  'See the <a href="events.html">events page</a> for dates.',
  "FAQ markdown keeps a legitimate relative link"
);
eq(
  buildScript.renderFaqAnswerHtml("Click [here](javascript:alert%281%29) now."),
  "Click here now.",
  "FAQ markdown drops a javascript: link and keeps the text"
);
eq(
  buildScript.renderFaqAnswerHtml("[x](data:text/html;base64,PHNjcmlwdD4=)"),
  "x",
  "FAQ markdown drops a data: link"
);
eq(
  buildScript.renderFaqAnswerHtml("[y](JaVaScRiPt:alert%281%29)"),
  "y",
  "FAQ markdown scheme check is case-insensitive"
);
assert(
  buildScript.renderFaqAnswerHtml("<img src=x onerror=alert(1)>").indexOf("<img") === -1,
  "FAQ answers are HTML-escaped before the markdown pass"
);

/* ---------- feed.xml determinism + XML legality ---------- */
eq(
  buildScript.stripXmlControlChars("a\u000bb\u0000c"),
  "abc",
  "XML-illegal control characters are stripped from feed text"
);
const feedA = buildScript.generateRssFeed(
  { posts: [{ id: "p1", title: "One", date: "2026-07-15", excerpt: "e" }] },
  "https://yallternativeliving.com"
);
assert(
  feedA.indexOf("<lastBuildDate>Wed, 15 Jul 2026 00:00:00 GMT</lastBuildDate>") !== -1,
  "feed lastBuildDate comes from the newest post date, not the wall clock"
);
eq(
  buildScript.generateRssFeed(
    { posts: [{ id: "p1", title: "One", date: "2026-07-15", excerpt: "e" }] },
    "https://yallternativeliving.com"
  ),
  feedA,
  "two feed builds of the same data are byte-identical"
);
assert(
  buildScript
    .generateRssFeed(
      { posts: [{ id: "p1", title: "One", date: "2026-07-15", excerpt: "e" }] },
      "https://yallternativeliving.com",
      { includeItems: false }
    )
    .indexOf("<item>") === -1,
  "feed carries no items while the Journal is switched off"
);

/* ---------- netlify.toml: the repository source must not be served ---------- */
const netlifyToml = fs.readFileSync(path.join(__dirname, "..", "netlify.toml"), "utf8");
[
  "/scripts/*",
  "/docs/*",
  "/workers/*",
  "/cms-auth/*",
  "/netlify/*",
  "/package.json",
  "/package-lock.json",
  "/*.md",
  "/.eslintrc.json",
  "/run-launch-checks.command",
  "/TEST_INFRA.md"
].forEach(function (blocked) {
  const idx = netlifyToml.indexOf('from = "' + blocked + '"');
  assert(idx !== -1, "netlify.toml has a redirect rule for " + blocked);
  if (idx !== -1) {
    const rule = netlifyToml.slice(idx, idx + 200);
    assert(/status = 404/.test(rule), "netlify.toml returns 404 for " + blocked);
  }
});
/* The Worker answers every /api/* route (checkout, gift-card-balance,
   stripe-webhook, order-status, restock), so the proxy is a wildcard that
   forwards the matched remainder with :splat. The retired Netlify Function
   paths are 410 rules ahead of it; none of them overlap /api/. */
const checkoutIdx = netlifyToml.indexOf('from = "/api/*"');
assert(checkoutIdx !== -1, "netlify.toml proxies /api/* to the Worker");
assert(
  netlifyToml.indexOf('from = "/scripts/*"') > checkoutIdx,
  "the /api/* proxy precedes the source-blocking 404 rules"
);
assert(
  /from = "\/api\/\*"\n\s+to = "https:\/\/[^"]+\.workers\.dev\/:splat"\n\s+status = 200/.test(
    netlifyToml
  ),
  "/api/* is a 200 proxy to the Worker with :splat forwarding"
);
[
  "/.netlify/functions/gift-card-balance",
  "/.netlify/functions/redeem-points",
  "/.netlify/functions/fulfill-gift-card",
  "/.netlify/functions/submit-restock"
].forEach(function (retired) {
  const idx = netlifyToml.indexOf('from = "' + retired + '"');
  assert(idx !== -1, "netlify.toml has a rule for the retired function " + retired);
  if (idx !== -1) {
    assert(
      /status = 410/.test(netlifyToml.slice(idx, idx + 200)),
      "netlify.toml returns 410 Gone for " + retired
    );
  }
});
assert(
  netlifyToml.indexOf('from = "/admin/*"') === -1,
  "/admin is still served (no 404 rule for it)"
);

console.log(`\nbuild-site-data.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
