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

function throwsMatching(fn, re) {
  try {
    fn();
  } catch (e) {
    return re.test(String(e && e.message));
  }
  return false;
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

/* 3b. ensureEventId -- events.json has no built-in id like
   products/bundles/reviews/social posts, so this is the guard that keeps
   "events.html#" + ev.id from shipping as "events.html#undefined". */
const eventIds1 = new Set();
const marketNoId = { name: "Landrum Farmers Market", date: "2026-09-12" };
eq(
  buildScript.ensureEventId(marketNoId, eventIds1, 0),
  "landrum-farmers-market-2026-09-12",
  "ensureEventId assigns a slug to an event with no id"
);
assert(
  marketNoId.id === "landrum-farmers-market-2026-09-12",
  "ensureEventId writes the id onto the event"
);
assert(
  eventIds1.has("landrum-farmers-market-2026-09-12"),
  "ensureEventId adds the new id to the used set"
);

const eventIds2 = new Set();
const marketA = { name: "Pride Market", date: "2026-06-06" };
const marketB = { name: "Pride Market", date: "2026-10-31" };
buildScript.ensureEventId(marketA, eventIds2, 0);
buildScript.ensureEventId(marketB, eventIds2, 1);
assert(marketA.id !== marketB.id, "ensureEventId gives two same-named events distinct ids");
eq(
  marketA.id,
  "pride-market-2026-06-06",
  "ensureEventId's slug for the first same-named event includes its date"
);
eq(
  marketB.id,
  "pride-market-2026-10-31",
  "ensureEventId's slug for the second same-named event includes its date"
);

const eventIds3 = new Set(["hand-picked-slug"]);
const marketWithId = { name: "Renamed Market", date: "2026-11-01", id: "hand-picked-slug" };
eq(
  buildScript.ensureEventId(marketWithId, eventIds3, 0),
  "hand-picked-slug",
  "ensureEventId never rewrites an id that's already there"
);
assert(
  marketWithId.id === "hand-picked-slug",
  "ensureEventId leaves the existing id on the event untouched"
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

/* A hand-set `price` wins over discountPercent; fullPrice stays the sum of
   the parts, because it is the crossed-out "was" price on the card. */
eq(
  buildScript.bundlePricing(
    { productIds: ["salve-1", "soak-1"], discountPercent: 10, price: 30 },
    mockProductsMap
  ),
  { fullPrice: 35.0, bundlePrice: 30 },
  "bundlePricing prefers an explicit bundle price over the percentage"
);
eq(
  buildScript.bundlePricing(
    { productIds: ["salve-1", "soak-1"], discountPercent: 10, price: 0 },
    mockProductsMap
  ),
  { fullPrice: 35.0, bundlePrice: 31.5 },
  "bundlePricing falls back to the percentage when the price is absent or 0"
);

/* assertBundlePricesSane: a set that is not a saving must stop the build. */
function bundleSaneError(bundle) {
  try {
    buildScript.assertBundlePricesSane([bundle], mockProductsMap);
    return null;
  } catch (e) {
    return e.message;
  }
}
assert(
  /must be cheaper/.test(
    bundleSaneError({ id: "no-saving", productIds: ["salve-1", "soak-1"], price: 35 }) || ""
  ),
  "assertBundlePricesSane throws when the set costs the same as its parts"
);
assert(
  /must be cheaper/.test(
    bundleSaneError({ id: "costlier", productIds: ["salve-1", "soak-1"], price: 40 }) || ""
  ),
  "assertBundlePricesSane throws when the set costs more than its parts"
);
assert(
  bundleSaneError({ id: "fine", productIds: ["salve-1", "soak-1"], price: 31 }) === null,
  "assertBundlePricesSane accepts a set priced inside the usual discount band"
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

/* Product pages are real, indexable pages (the H-15 doorway decision was
   reversed on 2026-09-01): self-canonical, no noindex, no redirect, and they
   carry their own Product + BreadcrumbList JSON-LD. */
assert(
  pdpHtmlOutput.indexOf('name="robots"') === -1 || pdpHtmlOutput.indexOf('content="noindex') === -1,
  "PDP is indexable (no noindex robots meta)"
);
assert(
  pdpHtmlOutput.indexOf("window.location.replace") === -1,
  "PDP no longer redirects to shop.html"
);
assert(
  pdpHtmlOutput.indexOf(
    '<link rel="canonical" href="https://yallternativeliving.com/products/' +
      testApothecaryProd.id +
      '.html">'
  ) !== -1,
  "PDP canonicalises to itself"
);
{
  const ldBlocks =
    pdpHtmlOutput.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  const parsed = ldBlocks.map((b) =>
    JSON.parse(b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""))
  );
  assert(
    parsed.some((ld) => ld["@type"] === "Product" && ld.offers),
    "PDP carries Product JSON-LD with offers"
  );
  assert(
    parsed.some((ld) => ld["@type"] === "BreadcrumbList"),
    "PDP carries BreadcrumbList JSON-LD"
  );
}
assert(
  pdpHtmlOutput.indexOf('class="pdp-variant-group') !== -1 ||
    !(testApothecaryProd.variants && testApothecaryProd.variants.options),
  "PDP renders a radio-button variant picker when the product has variants"
);
assert(
  pdpHtmlOutput.indexOf('id="pdpAddToCart"') !== -1 ||
    testApothecaryProd.comingSoon ||
    testApothecaryProd.stock === 0,
  "PDP renders a real Add to Cart button"
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
/* The PDP's competing microdata Product entity is gone (audit C, finding
   L5): the page carried a thin second Product with a flat price alongside
   the complete JSON-LD one, and on this exact shape they disagreed -- the
   microdata said 19.99 while the JSON-LD declared an AggregateOffer of
   13.99-19.99. The visible headline is still the pre-selected option; it
   just is not a schema.org claim any more. */
assert(
  deltaPdp.indexOf("itemprop=") === -1 && deltaPdp.indexOf("itemscope") === -1,
  "no schema.org microdata is emitted alongside the JSON-LD Product"
);
assert(
  deltaPdp.indexOf('<span class="pdp-price-value">19.99</span>') !== -1,
  "visible headline price is the pre-selected option's price (2oz at 19.99); the range lives in JSON-LD"
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
/* The return policy is gated by category, because policies.html has two.
   Opened salves, scrubs, balms and soaks are FINAL SALE; only unworn apparel
   and still-sealed goods can be exchanged, within 14 days, at the buyer's
   postage cost. Every PDP used to advertise the 14-day window regardless --
   a return right promised to Google Shopping on exactly the products where
   the shop refuses it (live audit M4). */
eq(
  singlePriceLd.offers.hasMerchantReturnPolicy,
  {
    "@type": "MerchantReturnPolicy",
    applicableCountry: "US",
    returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
    returnLink: "https://yallternativeliving.com/policies.html"
  },
  "a final-sale category (salves) declares MerchantReturnNotPermitted, with no window/method/fee to contradict it"
);

const apparelLd = buildScript.generateProductJsonLd(
  {
    id: "test-tee",
    name: "Test Tee",
    category: "apparel",
    price: 25,
    image: "assets/img/test-tee.jpg",
    inStock: true
  },
  "https://yallternativeliving.com",
  "Apparel"
);
eq(
  apparelLd.offers.hasMerchantReturnPolicy,
  {
    "@type": "MerchantReturnPolicy",
    applicableCountry: "US",
    returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    merchantReturnDays: 14,
    returnMethod: "https://schema.org/ReturnByMail",
    returnFees: "https://schema.org/ReturnShippingFees",
    itemCondition: "https://schema.org/NewCondition",
    returnLink: "https://yallternativeliving.com/policies.html"
  },
  "apparel keeps the real 14-day exchange window policies.html actually offers"
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
  "https://schema.org/OutOfStock",
  "OutOfStock availability when comingSoon is true -- nothing is orderable yet (live audit M-5)"
);
assert(
  typeof preorderLd.offers.price === "string" && /^\d+\.\d{2}$/.test(preorderLd.offers.price),
  "a coming-soon offer still carries its price -- OutOfStock is about the purchase path, not the price"
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
/* "Show live chat" (site.enableLiveChat): off must ship the loader with EMPTY
   ids -- the loader's first guard then returns before requesting anything --
   rather than dropping the block, so the every-page/byte-identical gates in
   qa-check.js and the two approved CSP hashes (on/off) both keep holding. */
{
  const ids = { tawkToPropertyId: "6a9687f6adddbc3447585d73", tawkToWidgetId: "1k1e066pc" };
  const on = buildScript.renderTawkChatHtml(Object.assign({ enableLiveChat: true }, ids));
  const off = buildScript.renderTawkChatHtml(Object.assign({ enableLiveChat: false }, ids));
  const unset = buildScript.renderTawkChatHtml(ids);
  assert(on.indexOf('"6a9687f6adddbc3447585d73"') !== -1, "live chat on: property id is emitted");
  assert(
    off.indexOf("6a9687f6adddbc3447585d73") === -1 && off.indexOf("1k1e066pc") === -1,
    "live chat off: neither Tawk.to id reaches the page"
  );
  assert(
    /var propertyId = \/\*YL:site\.tawkToPropertyId\*\/ "" \/\*\/YL:site\.tawkToPropertyId\*\/;/.test(
      off
    ),
    "live chat off: the loader still ships, with an empty property id literal"
  );
  assert(off.indexOf("Tawk_LoadStart") !== -1, "live chat off: the block itself stays on the page");
  assert(
    unset.indexOf('"1k1e066pc"') !== -1,
    "live chat unset (older content.json): treated as on"
  );
}

/* Concern filters promise "Leave blank on a new one" in /admin; before
   2026-09-04 nothing generated one, so a blank id shipped a filter pill with
   data-concern="undefined" that matched nothing. */
{
  const gen = buildScript.generateUniqueId;
  const used = new Set();
  assert(
    gen(used, "Dry, Rough Skin", "concern", 0) === "dry-rough-skin",
    "a concern with no id gets one slugified from its name"
  );
  assert(
    gen(used, "Dry, Rough Skin", "concern", 1) === "dry-rough-skin-2",
    "two concerns with the same name get distinct ids"
  );
  const kept = new Set(["sleep-relaxation"]);
  assert(
    !kept.has("wind-down") && gen(kept, "Wind Down", "concern", 2) === "wind-down",
    "an existing concern id is left alone and never collides"
  );
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
  "https://schema.org/OutOfStock",
  "availability comes from comingSoon, not the image filename"
);
eq(
  buildScript.schemaAvailability({ image: "assets/img/placeholder-coming-soon.svg" }),
  "https://schema.org/InStock",
  "a placeholder photo alone does not imply an unavailable product"
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
  // Per-file rules: Netlify never matched the old "/*.md" glob, so README.md
  // was served on the live domain (see qa-check "Top-level Markdown files").
  "/README.md",
  "/AGENTS.md",
  "/PROJECT.md",
  "/TEST_INFRA.md",
  "/.eslintrc.json",
  "/run-launch-checks.command"
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
   forwards the matched remainder with :splat. No rule may exist for the
   retired /.netlify/functions/* paths: Netlify reserves that prefix and
   rejects such rules at deploy time. */
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
assert(
  netlifyToml.indexOf('from = "/.netlify/functions/') === -1,
  "netlify.toml carries no redirect rule on the reserved /.netlify/functions/ prefix"
);
assert(
  netlifyToml.indexOf('from = "/admin/*"') === -1,
  "/admin is still served (no 404 rule for it)"
);

/* ---------- Quiz Referential Integrity ---------- */
const testProductsMap = {
  "sleep-salve": { id: "sleep-salve", name: "Sleep Salve", price: 16 },
  "lavender-soak": { id: "lavender-soak", name: "Lavender Soak", price: 14 }
};
const testBundlesMap = {
  "night-ritual-set": { id: "night-ritual-set", name: "Night Set" }
};
const testCategoriesMap = {
  salves: "Salves & Balms",
  soaks: "Soaks"
};
const validQuiz = {
  questions: [
    {
      id: "vibe",
      options: [
        {
          value: "gothic-calm",
          recommendedProductIds: ["sleep-salve", "night-ritual-set"],
          categories: ["salves"]
        }
      ]
    }
  ]
};
assert(
  buildScript.validateQuizData(validQuiz, testProductsMap, testCategoriesMap, testBundlesMap) ===
    true,
  "validateQuizData passes on valid quiz data"
);

let threwUnknownProduct = false;
try {
  buildScript.validateQuizData(
    {
      questions: [
        {
          id: "vibe",
          options: [{ value: "bad", recommendedProductIds: ["non-existent-product"] }]
        }
      ]
    },
    testProductsMap,
    testCategoriesMap,
    testBundlesMap
  );
} catch (e) {
  threwUnknownProduct = true;
}
assert(threwUnknownProduct, "validateQuizData throws on unknown product ID");

let threwUnknownCategory = false;
try {
  buildScript.validateQuizData(
    {
      questions: [
        {
          id: "need",
          options: [{ value: "bad-cat", categories: ["non-existent-category"] }]
        }
      ]
    },
    testProductsMap,
    testCategoriesMap,
    testBundlesMap
  );
} catch (e) {
  threwUnknownCategory = true;
}
assert(threwUnknownCategory, "validateQuizData throws on unknown category ID");

/* ---------- Social Link Rendering & Sanitization ---------- */
const socialConfig = {
  instagram: "https://www.instagram.com/yallternativeliving",
  tiktok: "https://www.tiktok.com/@yallternativeliving",
  facebook: "https://www.facebook.com/p/Yallternative-Living-61577943406316/",
  etsy: "https://www.etsy.com/shop/YallternativeLivinCO",
  pinterest: "https://www.pinterest.com/yallternativeliving",
  youtube: ""
};
const socialRowHtml = buildScript.renderSocialRowHtml(socialConfig);
assert(socialRowHtml.indexOf("instagram.com") !== -1, "renderSocialRowHtml includes Instagram");
assert(socialRowHtml.indexOf("pinterest.com") !== -1, "renderSocialRowHtml includes Pinterest");
assert(socialRowHtml.indexOf("youtube") === -1, "renderSocialRowHtml excludes empty YouTube URL");

const maliciousSocial = {
  instagram: "javascript:alert(1)"
};
const sanitizedRowHtml = buildScript.renderSocialRowHtml(maliciousSocial);
assert(
  sanitizedRowHtml.indexOf("javascript:") === -1,
  "renderSocialRowHtml strips javascript: XSS URLs"
);

const activeSocials = buildScript.getActiveSocialUrls(socialConfig);
eq(
  activeSocials,
  [
    "https://www.etsy.com/shop/YallternativeLivinCO",
    "https://www.facebook.com/p/Yallternative-Living-61577943406316/",
    "https://www.instagram.com/yallternativeliving",
    "https://www.pinterest.com/yallternativeliving",
    "https://www.tiktok.com/@yallternativeliving"
  ],
  "getActiveSocialUrls returns sorted valid URLs and excludes empty ones"
);

/* ---------- Ritual Fallback Defaults ---------- */
const mockProductNoTitle = {
  id: "lavender-soak",
  name: "Lavender Soak",
  price: 14,
  pairsWith: ["sleep-salve"]
};
const mockRitualDefaults = {
  title: "Custom Fallback Pairing",
  subtitle: "Custom fallback subtitle copy."
};
const ritualHtml = buildScript.renderRitualSectionHtml(
  mockProductNoTitle,
  testProductsMap,
  testCategoriesMap,
  mockRitualDefaults
);
assert(
  ritualHtml.indexOf("✦ Complete the Ritual: Custom Fallback Pairing ✦") !== -1,
  "renderRitualSectionHtml uses fallback title from ritualDefaults"
);
assert(
  ritualHtml.indexOf("Custom fallback subtitle copy.") !== -1,
  "renderRitualSectionHtml uses fallback subtitle from ritualDefaults"
);

/* ---------- Batch Date Badge in PDP ---------- */
const comingSoonProductWithDate = {
  id: "autumn-salve",
  name: "Autumn Salve",
  price: 20,
  comingSoon: true,
  estimatedBatchDate: "Late October 2026",
  image: "assets/img/placeholder-coming-soon.svg"
};
const pdpHtmlWithBatch = buildScript.renderProductPdpHtml(
  comingSoonProductWithDate,
  "https://yallternativeliving.com",
  "Salves",
  testProductsMap,
  testCategoriesMap
);
assert(
  pdpHtmlWithBatch.indexOf("Estimated Batch Date: <strong>Late October 2026</strong>") !== -1,
  "renderProductPdpHtml renders batch date badge for coming soon item"
);

const standardProduct = {
  id: "sleep-salve",
  name: "Sleep Salve",
  price: 16,
  comingSoon: false,
  estimatedBatchDate: "Late October 2026",
  image: "assets/img/sleep-salve.jpg"
};
const pdpHtmlStandard = buildScript.renderProductPdpHtml(
  standardProduct,
  "https://yallternativeliving.com",
  "Salves",
  testProductsMap,
  testCategoriesMap
);
assert(
  pdpHtmlStandard.indexOf("Estimated Batch Date") === -1,
  "renderProductPdpHtml does not render batch date badge for regular in-stock item"
);

// ---------------------------------------------------------------------------
// content.json "search" (editable in /admin): extra synonyms and safety notes
// ---------------------------------------------------------------------------
(function () {
  function throwsMatching(fn, re) {
    try {
      fn();
    } catch (e) {
      return re.test(String(e && e.message));
    }
    return false;
  }
  const base = { lavender: ["lavendar"], sleep: ["insomnia", "bedtime"] };

  let merged = buildScript.buildSearchSynonyms(base, undefined);
  eq(merged, base, "buildSearchSynonyms: no extras returns the defaults");
  merged.lavender.push("x");
  eq(base.lavender.length, 1, "buildSearchSynonyms: must not mutate the defaults");

  merged = buildScript.buildSearchSynonyms(base, [
    { key: "Bath Tea", terms: ["Tub tea", "bath sachet", " "] },
    { key: "sleep", terms: ["lights out", "insomnia"] }
  ]);
  eq(
    merged.bath_tea,
    ["tub tea", "bath sachet"],
    "buildSearchSynonyms: CMS key is snake_cased and terms trimmed"
  );
  eq(
    merged.sleep,
    ["insomnia", "bedtime", "lights out"],
    "buildSearchSynonyms: existing key gains new terms without duplicates"
  );

  assert(
    throwsMatching(() => buildScript.buildSearchSynonyms(base, { key: "x" }), /list/),
    "buildSearchSynonyms: non-list extras are refused"
  );
  assert(
    throwsMatching(() => buildScript.buildSearchSynonyms(base, [{ terms: ["a"] }]), /needs a key/),
    "buildSearchSynonyms: entry without a key is refused"
  );
  assert(
    throwsMatching(
      () => buildScript.buildSearchSynonyms(base, [{ key: "x", terms: [] }]),
      /no words/
    ),
    "buildSearchSynonyms: entry without words is refused"
  );
  assert(
    throwsMatching(
      () => buildScript.buildSearchSynonyms(base, [{ key: "wound care", terms: ["a"] }]),
      /treatment claim/
    ),
    "buildSearchSynonyms: a claim word in the key is refused"
  );
  assert(
    throwsMatching(
      () => buildScript.buildSearchSynonyms(base, [{ key: "salve", terms: ["eczema treatment"] }]),
      /treatment claim/
    ),
    "buildSearchSynonyms: a claim word in a term is refused"
  );

  const notes = buildScript.resolveSafetyNotes({ stopUse: "  Stop if it stings. ", patchTest: "" });
  eq(
    notes.stopUse,
    "Stop if it stings.",
    "resolveSafetyNotes: CMS text overrides a line (trimmed)"
  );
  assert(
    /24 hours/.test(notes.patchTest),
    "resolveSafetyNotes: a blank override falls back to the default"
  );
  assert(
    /external use/i.test(buildScript.resolveSafetyNotes(null).externalUse),
    "resolveSafetyNotes: null overrides give the defaults"
  );

  const cfg = buildScript.getSearchConfig({
    search: {
      chipsTitle: "  Try these ",
      popularChips: [{ label: "Soaks", query: "soak", icon: "waves" }]
    }
  });
  eq(cfg.chipsTitle, "Try these", "getSearchConfig: title is trimmed");
  eq(
    cfg.popularChips,
    [{ label: "Soaks", query: "soak", icon: "waves" }],
    "getSearchConfig: valid CMS chips pass through"
  );
  const chipHtml = buildScript.renderSearchChipsHtml(
    [{ label: "A & B", query: '"x', icon: "moon" }],
    ""
  );
  assert(
    chipHtml.indexOf('data-search-query="&quot;x"') !== -1,
    "renderSearchChipsHtml: query is attribute-escaped"
  );
  assert(
    chipHtml.indexOf("<span>A &amp; B</span>") !== -1,
    "renderSearchChipsHtml: label is HTML-escaped"
  );
})();

/* 27. Localization */
(function testLocalizationAndSeo() {
  /* 1. There is no hreflang layer, and no way to bring one back by accident.
     generateHreflangTags used to live here and emit x-default + en + five
     ?lang= alternates per page. The 2026-09-02 audit (S5) established that
     every one of those annotations was false -- the alternate URLs serve the
     identical English file and canonicalise away from themselves -- so the
     function is gone along with the export. Asserting its absence is what
     stops it reappearing; the built-output side is covered by qa-check. */
  assert(
    typeof buildScript.generateHreflangTags === "undefined",
    "generateHreflangTags is no longer exported (the ?lang= SEO layer is not shipped)"
  );
  assert(
    Array.isArray(buildScript.SUPPORTED_LOCALES) && buildScript.SUPPORTED_LOCALES.length === 9,
    "SUPPORTED_LOCALES still drives the nine locale dictionaries"
  );

  // 2. validateLocalesAndGlossary
  const validGlossary = {
    protectedTerms: ["Y'allternative Living", "Porch Sweep Clearing Mist"]
  };
  const validLocales = {
    en: {
      meta: { name: "English" },
      phrases: { brand: "Y'allternative Living", prod: "Buy Porch Sweep Clearing Mist today" }
    },
    es: {
      meta: { name: "Español" },
      phrases: { brand: "Y'allternative Living", prod: "Compre Porch Sweep Clearing Mist hoy" }
    },
    de: {
      meta: { name: "Deutsch" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "Kaufen Sie Porch Sweep Clearing Mist heute"
      }
    },
    fr: {
      meta: { name: "Français" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "Achetez Porch Sweep Clearing Mist aujourd'hui"
      }
    },
    ja: {
      meta: { name: "日本語" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "Porch Sweep Clearing Mist を今日購入"
      }
    },
    zh: {
      meta: { name: "中文" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "今天购买 Porch Sweep Clearing Mist"
      }
    },
    vi: {
      meta: { name: "Tiếng Việt" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "Mua Porch Sweep Clearing Mist hôm nay"
      }
    },
    ko: {
      meta: { name: "한국어" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "오늘 Porch Sweep Clearing Mist 구매하기"
      }
    },
    pt: {
      meta: { name: "Português" },
      phrases: {
        brand: "Y'allternative Living",
        prod: "Compre Porch Sweep Clearing Mist hoje"
      }
    }
  };
  assert(
    buildScript.validateLocalesAndGlossary(validLocales, validGlossary) === true,
    "validateLocalesAndGlossary passes on valid locales and glossary"
  );

  // Corrupted protected term in non-English locale
  const invalidLocales = JSON.parse(JSON.stringify(validLocales));
  invalidLocales.es.phrases.prod = "Compre Niebla Limpiadora de Porche hoy"; // translated proprietary name!
  assert(
    throwsMatching(
      () => buildScript.validateLocalesAndGlossary(invalidLocales, validGlossary),
      /Protected term violation in locale 'es'/
    ),
    "validateLocalesAndGlossary fails when protected term is corrupted"
  );

  // Missing protectedTerms array
  assert(
    throwsMatching(
      () => buildScript.validateLocalesAndGlossary(validLocales, {}),
      /protectedTerms/
    ),
    "validateLocalesAndGlossary fails when protectedTerms is missing"
  );

  // Missing locale
  const missingLocales = { en: validLocales.en };
  assert(
    throwsMatching(
      () => buildScript.validateLocalesAndGlossary(missingLocales, validGlossary),
      /Locale 'es' is missing/
    ),
    "validateLocalesAndGlossary fails when a supported locale is missing"
  );

  // 3. Compiled locales-data.js + per-locale bundle verification
  const localesBundlePath = path.join(__dirname, "../assets/js/locales-data.js");
  assert(fs.existsSync(localesBundlePath), "assets/js/locales-data.js exists on disk");
  const localesBundle = require("../assets/js/locales-data.js");
  assert(
    localesBundle.BRAND_GLOSSARY && localesBundle.BRAND_GLOSSARY.protectedTerms.length > 0,
    "locales-data.js exports BRAND_GLOSSARY"
  );
  const manifest = localesBundle.LOCALE_MANIFEST;
  assert(
    Array.isArray(manifest) && manifest.length === buildScript.SUPPORTED_LOCALES.length,
    "locales-data.js manifest lists every supported locale"
  );
  /* The core file must NOT carry phrase data any more: that is the whole
     point of the split, and a regression here would silently put half a
     megabyte back into every first visit. Asserted by size as well as by
     shape, because an accidental `LOCALES` export would be caught by shape
     while a stray phrase blob under another name would not. */
  assert(
    !localesBundle.LOCALES && !localesBundle.YL_LOCALES,
    "locales-data.js no longer ships the dictionaries themselves"
  );
  const coreBytes = fs.statSync(localesBundlePath).size;
  assert(
    coreBytes < 60 * 1024,
    "locales-data.js is the small always-loaded core (" + Math.round(coreBytes / 1024) + "KB)"
  );
  const enPhraseCount = Object.keys(require("../assets/js/locales/en.js").phrases || {}).length;
  assert(enPhraseCount > 0, "assets/js/locales/en.js carries the English index");
  manifest.forEach((entry) => {
    const file = path.join(__dirname, "../assets/js/locales/" + entry.code + ".js");
    assert(fs.existsSync(file), "assets/js/locales/" + entry.code + ".js exists on disk");
    const doc = require(file);
    assert(
      doc && doc.meta && doc.meta.code === entry.code,
      "locales/" + entry.code + ".js declares its own meta"
    );
    assert(
      Object.keys(doc.phrases || {}).length === enPhraseCount,
      "locales/" + entry.code + ".js carries every English key"
    );
    assert(
      entry.src === "/assets/js/locales/" + entry.code + ".js",
      "the manifest points at " + entry.code + "'s real file"
    );
  });

  // 4. sitemap.xml verification
  const sitemapPath = path.join(__dirname, "../sitemap.xml");
  const sitemapContent = fs.readFileSync(sitemapPath, "utf8");
  /* The sitemap lists canonical URLs only. It used to carry 224
     <xhtml:link> alternates across 32 <url> entries -- an annotation set that
     was never reciprocal (the ?lang= URLs had no <url> entries of their own)
     and pointed at URLs that canonicalise away from themselves. Asserting a
     non-empty <loc> list first so "no alternates" cannot pass on an empty or
     truncated sitemap. */
  const locCount = (sitemapContent.match(/<loc>/g) || []).length;
  assert(locCount >= 30, "sitemap.xml lists " + locCount + " canonical URLs (>= 30)");
  assert(
    !sitemapContent.includes("xmlns:xhtml"),
    "sitemap.xml no longer declares the xhtml namespace"
  );
  assert(!sitemapContent.includes("<xhtml:link"), "sitemap.xml carries no xhtml:link alternates");
  assert(!sitemapContent.includes("?lang="), "sitemap.xml references no ?lang= URLs");
})();

// ---------------------------------------------------------------------------
// The dictionary gate's two speeds: hard for hand-authored keys, a warning for
// the bot's own auto.* keys.
//
// This is the one relaxation in validateDictionaryCoverage and it needs both
// branches pinned, because the failure mode of getting it wrong is silent in
// opposite directions: too strict and every CMS product edit emails the owner a
// failed deploy; too loose and a dead hand-written dictionary entry ships
// unnoticed, which is the exact bug rules 1 and 4 were written for.
//
// Reachability is satisfied through the runtime manifest rather than by
// hunting for a string that happens to be in a built page, so these cases do
// not silently start passing (or failing) when the site's copy changes.
// ---------------------------------------------------------------------------
(function dictionaryGateSpeeds() {
  const LANGS = ["es", "de", "fr", "ja", "zh", "vi", "ko", "pt"];
  const REACHABLE = "Free shipping on orders of $40 or more";
  const UNREACHABLE = "zzz this sentence is on no page and in no manifest zzz";

  /* A manifest entry the gate can verify: `source` must exist and every
     `verify` fragment must still be in it. package.json is a committed file
     whose name field is not going anywhere. */
  const manifest = {
    strings: [
      {
        key: "announcement.shipping",
        text: REACHABLE,
        source: "package.json",
        verify: ['"name"']
      }
    ]
  };

  function localesWith(phrases) {
    const out = { en: { meta: { code: "en" }, phrases: phrases } };
    LANGS.forEach(function (lang) {
      const translated = {};
      Object.keys(phrases).forEach(function (key) {
        translated[key] = "[" + lang + "] " + phrases[key];
      });
      out[lang] = { meta: { code: lang }, phrases: translated };
    });
    return out;
  }

  function basisFor(phrases, overrides) {
    const basis = {};
    Object.keys(phrases).forEach(function (key) {
      basis[key] = buildScript.digestEnglish(phrases[key]);
    });
    Object.keys(overrides || {}).forEach(function (key) {
      basis[key] = overrides[key];
    });
    return { basis: basis };
  }

  function run(phrases, basisOverrides) {
    const warned = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = function (line) {
      warned.push(String(line));
    };
    console.log = function () {};
    let error = null;
    try {
      buildScript.validateDictionaryCoverage(
        localesWith(phrases),
        manifest,
        basisFor(phrases, basisOverrides)
      );
    } catch (err) {
      error = err;
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    return { error: error, warned: warned.join("\n") };
  }

  assert(
    typeof buildScript.isBotManagedKey === "function" &&
      buildScript.isBotManagedKey("auto.x.aaaaaa") &&
      !buildScript.isBotManagedKey("nav.shop"),
    "isBotManagedKey recognises the auto.* namespace and nothing else"
  );

  /* Control: a clean dictionary passes and warns about nothing. Without this
     every assertion below could be passing for the wrong reason. */
  const clean = run({ "announcement.shipping": REACHABLE });
  assert(clean.error === null, "a clean dictionary passes the gate");
  assert(clean.warned === "", "and produces no warning");

  // Rule 1, hand-authored: unreachable is still a hard failure.
  const handUnreachable = run({
    "announcement.shipping": REACHABLE,
    "nav.retired": UNREACHABLE
  });
  assert(
    handUnreachable.error !== null && handUnreachable.error.message.indexOf("nav.retired") !== -1,
    "rule 1 still fails the build for an unreachable hand-authored key"
  );

  // Rule 1, bot-minted: unreachable is a warning that names the key.
  const botUnreachable = run({
    "announcement.shipping": REACHABLE,
    "auto.retired.aaaaaa": UNREACHABLE
  });
  assert(botUnreachable.error === null, "rule 1 only warns for an unreachable auto.* key");
  assert(
    botUnreachable.warned.indexOf("auto.retired.aaaaaa") !== -1,
    "and the warning names the key rather than passing silently"
  );

  // Rule 4, hand-authored: a stale digest is still a hard failure.
  const handStale = run(
    { "announcement.shipping": REACHABLE },
    {
      "announcement.shipping": "0000000000"
    }
  );
  assert(
    handStale.error !== null && handStale.error.message.indexOf("announcement.shipping") !== -1,
    "rule 4 still fails the build for a hand-authored key whose English drifted"
  );

  // Rule 4, bot-minted: a stale digest warns.
  const botStale = run(
    { "announcement.shipping": REACHABLE, "auto.blurb.bbbbbb": REACHABLE },
    { "auto.blurb.bbbbbb": "0000000000" }
  );
  assert(botStale.error === null, "rule 4 only warns for an auto.* key whose English drifted");
  assert(botStale.warned.indexOf("auto.blurb.bbbbbb") !== -1, "and the warning names that key too");

  /* The combination the softening exists for: the owner edits a product blurb
     in the CMS, so the old English is unreachable AND its digest is stale, on
     the same key, in the same build, before the bot has run. */
  const cmsEdit = run(
    { "announcement.shipping": REACHABLE, "auto.blurb.cccccc": UNREACHABLE },
    { "auto.blurb.cccccc": "0000000000" }
  );
  assert(
    cmsEdit.error === null,
    "a CMS copy edit that trips rules 1 and 4 at once on a bot key does not fail the deploy"
  );

  // Rules 2 and 3 stay hard for bot keys: those are never a timing artefact.
  const missingLocale = (function () {
    const phrases = { "announcement.shipping": REACHABLE, "auto.blurb.dddddd": REACHABLE };
    const locales = localesWith(phrases);
    locales.de.phrases["auto.blurb.dddddd"] = "";
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = function () {};
    console.log = function () {};
    let error = null;
    try {
      buildScript.validateDictionaryCoverage(locales, manifest, basisFor(phrases));
    } catch (err) {
      error = err;
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    return error;
  })();
  assert(
    missingLocale !== null && missingLocale.message.indexOf("auto.blurb.dddddd") !== -1,
    "rule 2 is still a hard failure for an auto.* key missing a locale"
  );

  const englishInLocale = (function () {
    const phrases = { "announcement.shipping": REACHABLE, "auto.blurb.eeeeee": REACHABLE };
    const locales = localesWith(phrases);
    locales.fr.phrases["auto.blurb.eeeeee"] = REACHABLE;
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = function () {};
    console.log = function () {};
    let error = null;
    try {
      buildScript.validateDictionaryCoverage(locales, manifest, basisFor(phrases));
    } catch (err) {
      error = err;
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    return error;
  })();
  assert(
    englishInLocale !== null && englishInLocale.message.indexOf("auto.blurb.eeeeee") !== -1,
    "rule 3 is still a hard failure for an auto.* key left in English"
  );
})();

console.log(`\nbuild-site-data.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
