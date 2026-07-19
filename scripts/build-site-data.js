#!/usr/bin/env node
/* ==========================================================
   Y'ALLTERNATIVE LIVING -- SEO/data build script
   ----------------------------------------------------------
   Regenerates every file on this site that's DERIVED from the four
   canonical source files in assets/data/ -- products.json, events.json,
   site-reviews.json, and content.json -- so adding, editing, or removing
   a product, event, review, or bit of page wording propagates
   everywhere automatically instead of requiring hand-edits in five
   different files.

   assets/data/products.json is plain JSON on purpose: it's the file
   Savanna's product editor (Sveltia CMS, see admin/config.yml and
   README section 20) commits to directly, and a CMS can't write into
   a hand-rolled JS file with a `window.YL_PRODUCTS = ...` wrapper
   around it. (Until mid-2026 this direction was reversed -- products-
   data.js was upstream and this script generated products.json FROM
   it. Flipped once the CMS needed a plain-JSON file to edit; if you're
   reading old notes that say to edit products-data.js directly, that's
   now stale -- edit products.json instead, by hand or via the CMS.)

   Run this any time you:
   - add/edit/remove a product, bundle, or FAQ entry in products.json
     (by hand, or by merging a commit the CMS made)
   - change a price
   - add/edit a page and want it in the sitemap
   This ALSO now runs automatically as part of every real deploy (see
   netlify.toml / vercel.json / .github/workflows/deploy-pages.yml) --
   see README section 20 for why that became necessary once a CMS
   commit could update products.json without a human remembering to
   run this script by hand first.

   Usage (from inside the site/ folder):
     node scripts/build-site-data.js

   What it regenerates:
   1. assets/js/products-data.js, events-data.js, site-reviews-data.js
      (`window.YL_* = ...` wrappers around the exact same JSON, for
      pages that load them as plain <script> tags with zero build
      step -- see the note at each file's own top; never hand-edit
      these, they're 100% generated now)
   2. assets/data/snipcart-products.json  (Snipcart order-validation manifest)
   3. shop.html's Product/ItemList JSON-LD block
   4. contact.html's FAQPage JSON-LD + visible FAQ prose (the site's ONE
      FAQ, generated from products.json's "faq" array -- shop.html
      just links to it instead of keeping its own copy)
   5. index.html/about.html's page copy (hero headline/text, About's
      story) -- generated from content.json, filled into the
      <!--YL:page.key-->...<!--/YL:page.key--> markers in each page
   5b. every page's <footer> -- one canonical copy in
      assets/data/footer.html, replaced into all 7 pages so the footer
      is edit-once instead of duplicated 7 times
   6. sitemap.xml
   7. robots.txt (its Sitemap: line always matches DOMAIN below)
   8. llms.txt (AI-agent-facing summary + auto-generated product list)
   9. Once a real DOMAIN is set below (see step 7 in the script itself):
      turns on every page's canonical link + og:url tag, and updates
      Plausible's data-domain plus every JSON-LD @id/url/image/
      breadcrumb entry, across all 7 pages in one pass -- no more
      manual find-and-replace across the whole site to go live.

   It never touches product PHOTOS -- those still need to be uploaded
   separately (the CMS's Image field handles this for CMS-added
   products; see README section 20). Safe to run as many times as you
   want.
   ========================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var ROOT = path.join(__dirname, "..");

/* Read + parse one of the canonical assets/data/*.json source files.
   A bare JSON.parse() on a file the CMS (or a hand-edit) broke throws
   "SyntaxError: Unexpected token } in JSON at position 1234" with no
   filename -- useless to a non-developer staring at a failed deploy
   log. This wraps every source read so a malformed file instead fails
   with the exact file name, the human-readable parser message, and a
   pointer at what to do. It still exits non-zero (the build MUST stop
   so nothing half-written ships), but now the log actually says which
   file to fix. The last-known-good deploy keeps serving in the
   meantime -- a broken commit can't take the live site down, only
   block the next publish until the JSON is valid again. */
function readJson(relPath) {
  var full = path.join(ROOT, relPath);
  var raw;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch (e) {
    console.error("\n[build] Could not read " + relPath + ": " + e.message);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(
      "\n[build] " +
        relPath +
        " is not valid JSON and the build can't continue.\n" +
        "        Parser said: " +
        e.message +
        "\n" +
        "        Most likely a stray comma, quote, or bracket from a hand-edit.\n" +
        "        The live site is unaffected -- it keeps serving the last good\n" +
        "        version until this file is valid again. (Editing through /admin\n" +
        "        instead of by hand avoids this: the editor writes valid JSON for you.)\n"
    );
    process.exit(1);
  }
}

var CATALOG = readJson("assets/data/products.json");
var PRODUCTS = CATALOG.products;
var BUNDLES = CATALOG.bundles || [];
var FAQ = CATALOG.faq || [];
// Markets/Pride dates: assets/data/events.json is now the canonical, CMS-edited
// source (plain JSON, editable at /admin); assets/js/events-data.js -- the
// window.YL_EVENTS global the pages load -- is GENERATED from it below, exactly
// like products.json -> products-data.js. (Previously events-data.js was the
// hand-edited source; flipped so Savanna can edit dates in the /admin editor.)
var EVENTS = readJson("assets/data/events.json");
// Customer reviews: assets/data/site-reviews.json is the canonical, CMS-edited
// source (Savanna approves + adds reviews at /admin); assets/js/site-reviews-data.js
// -- the window.YL_SITE_REVIEWS global shop.html loads -- is generated from it
// below. These are NEVER folded into aggregateRating JSON-LD (reserved for
// genuine Etsy-verified ratings only).
var SITE_REVIEWS = readJson("assets/data/site-reviews.json").reviews || [];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

var PRODUCTS_BY_ID = {};
var SALES = CATALOG.sales || [];
var salesByCategory = {};
SALES.forEach(function (s) {
  salesByCategory[s.category] = s;
});

PRODUCTS.forEach(function (p) {
  PRODUCTS_BY_ID[p.id] = p;

  if (p.sale && p.sale.price) {
    p.originalPrice = p.price;
    p.price = p.sale.price;
  } else if (salesByCategory[p.category]) {
    var catSale = salesByCategory[p.category];
    p.originalPrice = p.price;
    p.price = Math.round(p.price * (1 - catSale.percentOff / 100) * 100) / 100;
    p.sale = { label: catSale.label };
  }
});

/* A bundle's real price is always computed from its real component
   products' base prices -- never hand-set -- so it's impossible for a
   bundle's price to silently drift out of sync after a product's price
   changes. Returns null (and lets the caller decide how to fail loudly)
   if a bundle references a product ID that doesn't exist. */
function bundlePricing(b) {
  var missing = b.productIds.filter(function (id) {
    return !PRODUCTS_BY_ID[id];
  });
  if (missing.length) return null;
  var fullPrice = b.productIds.reduce(function (sum, id) {
    var original = PRODUCTS_BY_ID[id].originalPrice || PRODUCTS_BY_ID[id].price;
    return sum + original;
  }, 0);
  var bundlePrice = Math.round(fullPrice * (1 - (b.discountPercent || 0) / 100) * 100) / 100;
  return { fullPrice: fullPrice, bundlePrice: bundlePrice };
}

// There's no live domain yet -- every generated absolute URL below uses this
// placeholder. Update this ONE constant (and re-run the script) once a real
// domain exists, instead of hand-editing every file again.
var DOMAIN = "https://yallternativeliving.com";

var CATEGORY_LABEL = {};
CATALOG.categories.forEach(function (c) {
  CATEGORY_LABEL[c.id] = c.label;
});

function readText(relPath, label) {
  var full = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (e) {
    console.error("\n[build] Could not read " + (label || relPath) + ": " + e.message);
    process.exit(1);
  }
}

function writeFile(relPath, contents) {
  var full = path.join(ROOT, relPath);
  var dir = path.dirname(full);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(full, contents);
    console.log("wrote " + relPath);
  } catch (e) {
    console.error("\n[build] Could not write " + relPath + ": " + e.message);
    process.exit(1);
  }
}

/* ---------- Variant helpers ----------
   A product's real Etsy listing sometimes sells more than one size/scent/
   blend under a single listing (confirmed via manual research against the
   live listings -- see products-data.js comments), stored as p.variants =
   { name: "Size", options: [{ label, priceDelta }, ...] }. These two
   helpers turn that one small structure into everything downstream needs:
   Snipcart's order-validation custom-field syntax, and a JSON-LD price
   range when the variants actually change the price. */
function variantPriceRange(p) {
  if (!p.variants || !Array.isArray(p.variants.options) || !p.variants.options.length) {
    return { low: p.price, high: p.price };
  }
  var prices = p.variants.options.map(function (o) {
    return p.price + (o.priceDelta || 0);
  });
  return { low: Math.min.apply(null, prices), high: Math.max.apply(null, prices) };
}
function snipcartCustomFields(p) {
  if (!p.variants || !Array.isArray(p.variants.options) || !p.variants.options.length) return [];
  // Snipcart's documented custom-field format: "Label[+delta]|Label[+delta]",
  // delta relative to the button's base data-item-price. See:
  // https://docs.snipcart.com/v3/setup/custom-fields
  var optionsStr = p.variants.options
    .map(function (o) {
      var delta = o.priceDelta || 0;
      var sign = delta < 0 ? "-" : "+";
      return o.label + "[" + sign + Math.abs(delta).toFixed(2) + "]";
    })
    .join("|");
  return [{ name: p.variants.name, options: optionsStr, value: p.variants.options[0].label }];
}

/* ---------- 1) assets/js/products-data.js ----------
   A thin `window.YL_PRODUCTS = ...;` wrapper around the exact same data
   in assets/data/products.json (the real, canonical, CMS-edited source
   -- see the big comment at the top of this file). Pages load this
   generated .js file directly as a plain <script> tag (no build step,
   works instantly off file://) rather than fetch()-ing the JSON, which
   would need a real HTTP server and CORS headers just to open the site
   locally. Never hand-edit this file -- edit products.json instead (by
   hand, or through the CMS at /admin) and re-run this script. */
var productsDataJs =
  "/* AUTO-GENERATED by scripts/build-site-data.js -- do not hand-edit.\n" +
  "   The real, canonical catalog lives in assets/data/products.json --\n" +
  "   edit that file (directly, or through the product editor at /admin,\n" +
  "   see README section 20), then run:\n" +
  "     node scripts/build-site-data.js\n" +
  "   This is just that same JSON wrapped in a `window.YL_PRODUCTS = ...`\n" +
  '   assignment so plain <script src="..."> pages can use it with zero\n' +
  "   build step and zero fetch()/CORS complications, even off file://.\n\n" +
  '   Optional "stock" field per product (integer, omit entirely if not\n' +
  "   tracked): manually maintained -- NOT synced from Etsy or Snipcart\n" +
  '   automatically. Setting a real number turns on a "Sold out"/"Only N\n' +
  "   left\" badge and Snipcart's data-item-max-quantity cap for that\n" +
  "   product. Once you have a real Snipcart account, its dashboard's own\n" +
  "   Inventory feature (Manage store -> Products) is the more automatic\n" +
  "   long-term option -- see README section 8. */\n" +
  "window.YL_PRODUCTS = " +
  JSON.stringify(CATALOG, null, 2) +
  ";\n";
writeFile("assets/js/products-data.js", productsDataJs);

/* ---------- 1b) assets/js/events-data.js ----------
   window.YL_EVENTS wrapper around assets/data/events.json (the canonical,
   CMS-edited source for markets/Pride dates). Pages load this generated file
   directly. Never hand-edit it -- edit events.json (by hand, or via /admin)
   and re-run this script. */
var eventsDataJs =
  "/* AUTO-GENERATED by scripts/build-site-data.js -- do not hand-edit.\n" +
  "   Markets, fairs & Pride dates live in assets/data/events.json -- edit that\n" +
  "   file (directly, or through the editor at /admin), then run:\n" +
  "     node scripts/build-site-data.js\n" +
  "   This is that same JSON wrapped in `window.YL_EVENTS = ...` so plain\n" +
  "   <script src> pages can use it with zero build step. */\n" +
  "window.YL_EVENTS = " +
  JSON.stringify(EVENTS, null, 2) +
  ";\n";
writeFile("assets/js/events-data.js", eventsDataJs);

/* ---------- 1c) assets/js/site-reviews-data.js ----------
   window.YL_SITE_REVIEWS wrapper around assets/data/site-reviews.json (the
   canonical, CMS-edited source). Generated -- never hand-edit; edit
   site-reviews.json (by hand, or via /admin) and re-run this script. */
var reviewsDataJs =
  "/* AUTO-GENERATED by scripts/build-site-data.js -- do not hand-edit.\n" +
  "   Site-submitted customer reviews live in assets/data/site-reviews.json --\n" +
  "   edit that file (directly, or through the editor at /admin), then run:\n" +
  "     node scripts/build-site-data.js\n" +
  "   These are NEVER folded into shop.html's aggregateRating JSON-LD -- that\n" +
  "   schema is reserved for genuine Etsy-verified-purchase ratings only. This\n" +
  "   is just the review list wrapped in `window.YL_SITE_REVIEWS = ...`. */\n" +
  "window.YL_SITE_REVIEWS = " +
  JSON.stringify(SITE_REVIEWS, null, 2) +
  ";\n";
writeFile("assets/js/site-reviews-data.js", reviewsDataJs);

/* ---------- 2) assets/data/snipcart-products.json ----------
   Snipcart's order-validation JSON crawler pattern for JS-rendered
   catalogs -- see README section 8 for why this file needs to exist. */
var snipcartManifest = PRODUCTS.map(function (p) {
  return {
    id: p.id,
    name: p.name,
    price: Number(p.price.toFixed(2)),
    url: "/assets/data/snipcart-products.json",
    image: p.image,
    categories: [p.category],
    customFields: snipcartCustomFields(p)
  };
});
// Bundles are their own Snipcart line item (id "bundle-<id>") at the
// computed discounted price -- simpler and less error-prone at checkout
// than trying to add 3 separate items with a cart-level percent-off.
BUNDLES.forEach(function (b) {
  var pricing = bundlePricing(b);
  if (!pricing) {
    throw new Error(
      'Bundle "' +
        b.id +
        "\" references a productId that doesn't exist in products-data.js -- fix before building."
    );
  }
  var firstProduct = PRODUCTS_BY_ID[b.productIds[0]];
  snipcartManifest.push({
    id: "bundle-" + b.id,
    name: b.name,
    price: pricing.bundlePrice,
    url: "/assets/data/snipcart-products.json",
    image: firstProduct.image,
    categories: ["bundle"]
  });
});
writeFile("assets/data/snipcart-products.json", JSON.stringify(snipcartManifest, null, 2) + "\n");

/* ---------- 3) shop.html Product/ItemList JSON-LD ---------- */
var itemListElement = PRODUCTS.map(function (p, i) {
  // Schema.org's Product.image accepts either a single URL or an array --
  // include every real photo (hero + any extra gallery shots) when a
  // product has them, so search engines can surface more than one photo.
  // Normalize a leading "/" (the CMS public_folder writes "/assets/img/x.jpg",
  // hand-entered paths are relative "assets/img/x.jpg") so DOMAIN + "/" + img
  // never produces a double-slash "domain.com//assets/img" URL in the JSON-LD.
  var allPhotos = [p.image].concat(Array.isArray(p.images) ? p.images : []).map(function (img) {
    return String(img).replace(/^\/+/, "");
  });
  var imageField =
    allPhotos.length > 1
      ? allPhotos.map(function (img) {
          return DOMAIN + "/" + img;
        })
      : DOMAIN + "/" + allPhotos[0];
  // Variants that actually change the price (e.g. a bigger size) get an
  // AggregateOffer with a real low/high range instead of a single Offer --
  // same-price variants (a size-only or scent-only pick) don't need one.
  var range = variantPriceRange(p);
  var offers =
    range.low === range.high
      ? {
          "@type": "Offer",
          price: range.low.toFixed(2),
          priceCurrency: "USD",
          url: DOMAIN + "/shop.html",
          availability: "https://schema.org/InStock",
          seller: { "@type": "Organization", name: "Y'allternative Living" }
        }
      : {
          "@type": "AggregateOffer",
          lowPrice: range.low.toFixed(2),
          highPrice: range.high.toFixed(2),
          priceCurrency: "USD",
          offerCount: p.variants.options.length,
          url: DOMAIN + "/shop.html",
          availability: "https://schema.org/InStock",
          seller: { "@type": "Organization", name: "Y'allternative Living" }
        };
  var productLd = {
    "@type": "Product",
    name: p.name,
    description: p.blurb,
    image: imageField,
    url: DOMAIN + "/shop.html",
    category: CATEGORY_LABEL[p.category] || p.category,
    brand: { "@type": "Brand", name: "Y'allternative Living" },
    offers: offers
  };
  // Only attach aggregateRating when this SPECIFIC product has its own real
  // Etsy reviews (p.rating, set by hand from that product's own listing
  // page -- never the shop-wide 4.9/32). Applying a shop-wide rating to every
  // listing is against Google's structured-data guidelines and risks the
  // whole page's rich results being disabled, so products with zero reviews
  // of their own (see products-data.js) simply get no rating field at all.
  if (p.rating) {
    productLd.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: p.rating.value,
      reviewCount: p.rating.count
    };
  }
  return {
    "@type": "ListItem",
    position: i + 1,
    item: productLd
  };
});
var shopJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Y'allternative Living | Full Shop Catalog",
  itemListElement: itemListElement
};
var shopHtml = readText("shop.html", "shop page");

var NUMBER_WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
  "Twenty"
];
var productCount = CATALOG.products.length;
var productCountWord = NUMBER_WORDS[productCount] || String(productCount);

shopHtml = shopHtml.replace(/Shop \d+ handmade goods/, "Shop " + productCount + " handmade goods");
shopHtml = shopHtml.replace(
  /\b\d+ handmade goods across/g,
  productCount + " handmade goods across"
);

var countMarkerRe = /(<!--YL:productCount-->)\d+(<!--\/YL:productCount-->)/;
if (countMarkerRe.test(shopHtml)) {
  shopHtml = shopHtml.replace(countMarkerRe, "$1" + productCount + "$2");
}

var wordMarkerRe = /(<!--YL:productCountWord-->)[A-Za-z]+(<!--\/YL:productCountWord-->)/;
if (wordMarkerRe.test(shopHtml)) {
  shopHtml = shopHtml.replace(wordMarkerRe, "$1" + productCountWord + "$2");
}

var shopBlockRe =
  /<script type="application\/ld\+json">\n\{\n\s*"@context": "https:\/\/schema\.org",\n\s*"@type": "ItemList"[\s\S]*?\n<\/script>/;
if (!shopBlockRe.test(shopHtml)) {
  throw new Error(
    "Could not find the ItemList JSON-LD block in shop.html -- aborting so nothing gets corrupted. Check the block still starts with @type: ItemList."
  );
}
var newBlock =
  '<script type="application/ld+json">\n' + JSON.stringify(shopJsonLd, null, 2) + "\n</script>";
shopHtml = shopHtml.replace(shopBlockRe, function () {
  return newBlock;
});

var shopFaqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(function (item) {
    return {
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      }
    };
  })
};
var faqLdBlockRe =
  /<script type="application\/ld\+json">\n\{\n\s*"@context": "https:\/\/schema\.org",\n\s*"@type": "FAQPage"[\s\S]*?\n<\/script>/;
var newFaqLdBlock =
  '<script type="application/ld+json">\n' + JSON.stringify(shopFaqLd, null, 2) + "\n</script>";

if (faqLdBlockRe.test(shopHtml)) {
  shopHtml = shopHtml.replace(faqLdBlockRe, function () {
    return newFaqLdBlock;
  });
} else {
  shopHtml = shopHtml.replace("</head>", "\n  " + newFaqLdBlock + "\n</head>");
}

writeFile("shop.html", shopHtml);

/* ---------- 4) contact.html FAQ (JSON-LD + visible prose) ----------
   The site's ONE FAQ. products-data.js's "faq" array is the only place
   to add/edit/reorder a question -- this generates both the FAQPage
   JSON-LD and the visible Q&A prose in contact.html's #faq section from
   it, so the two can never drift out of sync with each other again
   (they used to be two separate hand-typed copies). shop.html doesn't
   duplicate any of this; it just links to contact.html#faq. */
var contactHtml = readText("contact.html", "contact page");

var faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(function (item) {
    return {
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      }
    };
  })
};
if (!faqLdBlockRe.test(contactHtml)) {
  throw new Error(
    "Could not find the FAQPage JSON-LD block in contact.html -- aborting so nothing gets corrupted. Check the block still starts with @type: FAQPage."
  );
}
newFaqLdBlock =
  '<script type="application/ld+json">\n' + JSON.stringify(faqJsonLd, null, 2) + "\n</script>";
contactHtml = contactHtml.replace(faqLdBlockRe, function () {
  return newFaqLdBlock;
});

var faqVisibleHtml = FAQ.map(function (item, i) {
  var escAnswer = escapeHtml(item.answer);
  var renderedAnswer = escAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  var block =
    '        <div class="reveal">\n' +
    "          <h3>" +
    escapeHtml(item.question) +
    "</h3>\n" +
    "          <p>" +
    renderedAnswer +
    "</p>\n" +
    "        </div>";
  return i < FAQ.length - 1 ? block + '\n        <hr class="rule">\n' : block;
}).join("\n");
var faqMarkerRe = /(<!-- FAQ:START[\s\S]*?-->)[\s\S]*?(<!-- FAQ:END -->)/;
if (!faqMarkerRe.test(contactHtml)) {
  throw new Error(
    "Could not find the FAQ:START/FAQ:END markers in contact.html's .contact-faq block -- aborting so nothing gets corrupted."
  );
}
contactHtml = contactHtml.replace(faqMarkerRe, function (m, start, end) {
  return start + "\n" + faqVisibleHtml + "\n        " + end;
});

writeFile("contact.html", contactHtml);

var shopHtmlWithFaq = readText("shop.html", "shop page");
if (!faqMarkerRe.test(shopHtmlWithFaq)) {
  throw new Error(
    "Could not find the FAQ:START/FAQ:END markers in shop.html -- aborting so nothing gets corrupted."
  );
}
shopHtmlWithFaq = shopHtmlWithFaq.replace(faqMarkerRe, function (m, start, end) {
  return start + "\n" + faqVisibleHtml + "\n        " + end;
});
writeFile("shop.html", shopHtmlWithFaq);

/* ---------- Page copy (index.html + about.html + contact.html + shop.html) ----------
   The homepage headline/intro, the About story, and page images are marker-delimited
   in those pages and filled in here from assets/data/content.json.
   If the key is an image, we resolve its AVIF/WebP responsive sources using the
   manifest generated by scripts/optimize-images.js. */
var MANIFEST = {};
try {
  var manifestText = fs.readFileSync(path.join(ROOT, "assets/js/image-manifest.js"), "utf8");
  var jsonText = manifestText.substring(manifestText.indexOf("{"), manifestText.lastIndexOf("}") + 1);
  MANIFEST = JSON.parse(jsonText);
} catch (e) {
  // Silent fallback if it doesn't exist yet
}

var CONTENT = readJson("assets/data/content.json");

function injectPageCopy(page, pageKey) {
  var html = readText(page, page + " page");
  var section = CONTENT[pageKey] || {};
  Object.keys(section).forEach(function (key) {
    var raw = String(section[key]);
    var isImage = ["heroImage", "featureImage", "bioImage", "secondaryImage", "image", "giftCardImage", "logoDesktop", "logoMobile"].indexOf(key) !== -1;

    if (isImage) {
      var imgPath = raw.replace(/^\/+/, "");
      
      // Inject fallback src
      var mSrc = "YL:src:" + pageKey + "\\." + key;
      var reSrc = new RegExp("(<!--" + mSrc + "-->)[\\s\\S]*?(<!--/" + mSrc + "-->)");
      if (reSrc.test(html)) {
        html = html.replace(reSrc, function(match, open, close) {
          return open + imgPath + close;
        });
      }

      // Check manifest for responsive sources
      var entry = MANIFEST[imgPath];
      var avifSrcset = "";
      var webpSrcset = "";
      if (entry && entry.variants) {
        avifSrcset = entry.variants.avif.map(function(v) { return v.file + " " + v.width + "w"; }).join(", ");
        webpSrcset = entry.variants.webp.map(function(v) { return v.file + " " + v.width + "w"; }).join(", ");
      } else {
        // Fallback to original image if no responsive sizes exist
        avifSrcset = imgPath;
        webpSrcset = imgPath;
      }

      // Inject avif srcset
      var mAvif = "YL:srcset-avif:" + pageKey + "\\." + key;
      var reAvif = new RegExp("(<!--" + mAvif + "-->)[\\s\\S]*?(<!--/" + mAvif + "-->)");
      if (reAvif.test(html)) {
        html = html.replace(reAvif, function(match, open, close) {
          return open + avifSrcset + close;
        });
      }

      // Inject webp srcset
      var mWebp = "YL:srcset-webp:" + pageKey + "\\." + key;
      var reWebp = new RegExp("(<!--" + mWebp + "-->)[\\s\\S]*?(<!--/" + mWebp + "-->)");
      if (reWebp.test(html)) {
        html = html.replace(reWebp, function(match, open, close) {
          return open + webpSrcset + close;
        });
      }
    } else {
      var rendered =
        key === "bio"
          ? raw
              .split(/\n\s*\n/)
              .map(function (para) {
                return "<p>" + escapeHtml(para.trim()) + "</p>";
              })
              .join("\n          ")
          : escapeHtml(raw);
      var m = "YL:" + pageKey + "\\." + key;
      var re = new RegExp("(<!--" + m + "-->)[\\s\\S]*?(<!--/" + m + "-->)");
      if (!re.test(html))
        throw new Error(
          "Page-copy marker <!--YL:" +
            pageKey +
            "." +
            key +
            "--> not found in " +
            page +
            " -- aborting so nothing gets corrupted."
        );
      html = html.replace(re, function (_match, open, close) {
        return open + rendered + close;
      });
    }
  });
  writeFile(page, html);
}

injectPageCopy("index.html", "home");
injectPageCopy("about.html", "about");
injectPageCopy("contact.html", "contact");
injectPageCopy("shop.html", "shop");

/* ---------- 4b) shared footer (single source -> all pages) ----------
   The <footer class="site-footer"> block is byte-identical on every
   page, so it lives in ONE file now: assets/data/footer.html. Editing
   the footer once there (a new social link, the real Kit newsletter
   URL, a policy tweak, an added tracking snippet) and rebuilding
   propagates it to all 7 pages -- no more hand-editing 7 files in sync
   and hoping you didn't fatfinger one. The whole existing footer block
   on each page is replaced wholesale, so no per-page marker comments
   are needed; the regex anchors on the class so the small <footer> tags
   inside review quote-cards are never touched. The copyright YEAR is
   still filled in live by main.js (getFullYear), so it stays correct
   without any yearly rebuild. */
var logoDesktop = (CONTENT.site && CONTENT.site.logoDesktop) || "assets/img/logo.png";
var logoMobile = (CONTENT.site && CONTENT.site.logoMobile) || "assets/img/logo.jpg";
logoDesktop = logoDesktop.replace(/^\/+/, "");
logoMobile = logoMobile.replace(/^\/+/, "");

var FOOTER_INNER = readText("assets/data/footer.html", "footer template").replace(/\s+$/, "");

// Inject logo path into footer template
var reFooterLogo = /<!--YL:src:site\.logoDesktop-->[\s\S]*?<!--\/YL:src:site\.logoDesktop-->/;
FOOTER_INNER = FOOTER_INNER.replace(reFooterLogo, logoDesktop);

var FOOTER_BLOCK = '<footer class="site-footer">\n' + FOOTER_INNER + "\n</footer>";
var FOOTER_RE = /<footer class="site-footer">[\s\S]*?<\/footer>/;
[
  "index.html",
  "shop.html",
  "about.html",
  "contact.html",
  "events.html",
  "privacy.html",
  "terms.html",
  "policies.html",
  "404.html"
].forEach(function (page) {
  var filePath = path.join(ROOT, page);
  if (!fs.existsSync(filePath)) return;
  var html;
  try {
    html = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    console.error("\n[build] Could not read " + page + ": " + e.message);
    process.exit(1);
  }
  if (!FOOTER_RE.test(html)) {
    throw new Error(
      'No <footer class="site-footer"> block found in ' +
        page +
        " -- aborting so nothing gets corrupted."
    );
  }
  
  // Inject header desktop/mobile logos using class regex
  html = html.replace(/(<img class="logo-desktop" src=")[^"]*(")/g, '$1' + logoDesktop + '$2');
  html = html.replace(/(<img class="logo-mobile" src=")[^"]*(")/g, '$1' + logoMobile + '$2');

  var updated = html.replace(FOOTER_RE, FOOTER_BLOCK);
  if (updated !== html) writeFile(page, updated);
});

/* ---------- 5) sitemap.xml ----------
   Page list is intentionally hand-maintained here (there's no router to
   introspect on a static site) -- add a line if you add a new top-level
   page. lastmod is set to today every run, which is an accepted
   simplification for a small site with no per-file mtime tracking. */
var PAGES = [
  { loc: "index.html", priority: "1.0" },
  { loc: "shop.html", priority: "0.9" },
  { loc: "events.html", priority: "0.7" },
  { loc: "about.html", priority: "0.7" },
  { loc: "contact.html", priority: "0.6" },
  { loc: "privacy.html", priority: "0.3" },
  { loc: "terms.html", priority: "0.3" },
  { loc: "policies.html", priority: "0.3" }
];
var today = new Date().toISOString().slice(0, 10);
var sitemapXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<!-- Auto-generated by scripts/build-site-data.js -- don't hand-edit,\n" +
  "     re-run the script after adding a page. Swap the DOMAIN constant\n" +
  "     inside that script once a real domain exists, then re-run. -->\n" +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  PAGES.map(function (p) {
    return (
      "  <url><loc>" +
      DOMAIN +
      "/" +
      p.loc +
      "</loc><lastmod>" +
      today +
      "</lastmod><priority>" +
      p.priority +
      "</priority></url>"
    );
  }).join("\n") +
  "\n</urlset>\n";
writeFile("sitemap.xml", sitemapXml);

/* ---------- 5b) robots.txt ----------
   Previously a hand-maintained static file -- its one dynamic bit (the
   Sitemap: line) had to be manually kept in sync with the DOMAIN
   constant below, which is exactly the kind of easy-to-forget step
   this whole script exists to eliminate. Regenerated every run now, so
   setting a real DOMAIN and re-running is the only step required. The
   crawler allow-list itself is stable enough to live as a template
   string here rather than a separate source file. */
var robotsTxt =
  "User-agent: *\nAllow: /\n\n" +
  "# Explicit allow list for known AI crawlers (mid-2026). This is a small\n" +
  "# business marketing/commerce site that WANTS visibility -- being included\n" +
  "# in AI answers, shopping-agent recommendations, and model training all\n" +
  "# help, not hurt, so nothing here is blocked. The wildcard rule above\n" +
  "# already allows everyone; these entries are just explicit so intent is\n" +
  "# unambiguous to anyone (human or agent) reading this file.\n" +
  "User-agent: GPTBot\nAllow: /\n\n" +
  "User-agent: OAI-SearchBot\nAllow: /\n\n" +
  "User-agent: ChatGPT-User\nAllow: /\n\n" +
  "User-agent: ClaudeBot\nAllow: /\n\n" +
  "User-agent: Claude-SearchBot\nAllow: /\n\n" +
  "User-agent: Claude-User\nAllow: /\n\n" +
  "User-agent: PerplexityBot\nAllow: /\n\n" +
  "User-agent: Perplexity-User\nAllow: /\n\n" +
  "User-agent: Google-Extended\nAllow: /\n\n" +
  "User-agent: CCBot\nAllow: /\n\n" +
  "User-agent: Bingbot\nAllow: /\n\n" +
  "Sitemap: " +
  DOMAIN +
  "/sitemap.xml\n";
writeFile("robots.txt", robotsTxt);

/* ---------- 6) llms.txt ----------
   The community "llms.txt" convention: a plain-Markdown, token-efficient
   summary of the site for LLM/AI-agent crawlers, sitting at the site
   root next to robots.txt. Not an official W3C/IETF standard as of
   mid-2026, but real adoption exists among AI-native and doc-heavy
   sites, and it's a cheap, low-risk way to help AI assistants describe
   this real small business accurately instead of guessing. The product
   list below is generated from products-data.js, same as everything
   else in this script -- never hand-edit it directly, it'll just get
   overwritten. */
var productLines = PRODUCTS.map(function (p) {
  return (
    "- **" +
    p.name +
    "** -- $" +
    p.price.toFixed(2) +
    " -- " +
    (CATEGORY_LABEL[p.category] || p.category) +
    " -- " +
    p.blurb
  );
}).join("\n");

var llmsTxt =
  "# Y'allternative Living\n\n" +
  "> Queer-owned, Southern-raised handmade self-care -- small-batch salves, soaks, body care and apparel out of Landrum, SC. Sold directly on this site and on Etsy, plus in person at farmers markets and Pride events around Upstate SC and beyond.\n\n" +
  "Y'allternative Living is a small, queer-owned business run by founder Savanna out of Landrum, South Carolina (the Upstate SC / Blue Ridge foothills region). Everything is handmade in small batches. As of mid-2026 the shop has a 4.9-star average across 32 reviews and 105+ sales on its Etsy shop (a separate, longer-running sales channel from this site).\n\n" +
  "## Pages\n\n" +
  "- [Shop](" +
  DOMAIN +
  "/shop.html): the full catalog of " +
  PRODUCTS.length +
  " handmade products across " +
  CATALOG.categories.length +
  " categories (" +
  CATALOG.categories
    .map(function (c) {
      return c.label;
    })
    .join(", ") +
  "). Add-to-cart checkout happens directly on this site via Snipcart -- no redirect to a third-party marketplace required.\n" +
  "- [Events](" +
  DOMAIN +
  "/events.html): upcoming and past farmers markets, fairs, and Pride pop-ups where the shop appears in person. Only real, confirmed dates are listed -- if it's empty, no dates are confirmed yet.\n" +
  "- [Our Story](" +
  DOMAIN +
  "/about.html): founder background and brand story.\n" +
  "- [Contact](" +
  DOMAIN +
  "/contact.html): contact info, shipping/custom-order FAQ, and where to find the shop in person.\n" +
  "- [Privacy Policy](" +
  DOMAIN +
  "/privacy.html): plain-language privacy policy (not a substitute for legal advice).\n" +
  "- [Terms of Service](" +
  DOMAIN +
  "/terms.html): terms of service including health/allergy disclaimers, intellectual property, limitation of liability, and governing law (South Carolina).\n" +
  "- [Shipping & Returns](" +
  DOMAIN +
  "/policies.html): shipping policy (processing times, lost packages, address responsibility) and exchange policy (exchanges within 14 days for eligible items, final sale on opened body care).\n\n" +
  "## Products\n\n" +
  productLines +
  "\n\n" +
  "Machine-readable catalog: " +
  DOMAIN +
  "/assets/data/products.json (always the live source of truth for current prices -- prefer it over this file if the two ever disagree, since this file may not be regenerated as often as the catalog changes).\n\n" +
  "## Other real links for this business\n\n" +
  "- Etsy shop: https://www.etsy.com/shop/YallternativeLivinCO\n" +
  "- Instagram: https://www.instagram.com/yallternativeliving\n" +
  "- TikTok: https://www.tiktok.com/@yallternativeliving\n" +
  "- Facebook: https://www.facebook.com/p/Yallternative-Living-61577943406316/\n\n" +
  "## Notes for AI assistants and agents\n\n" +
  "This file exists to help AI assistants and shopping agents describe Y'allternative Living accurately. Please don't state or imply medical, therapeutic, or drug-like claims about any product beyond what's written in that product's own name/description here or on the shop page -- some listing names use playful language (e.g. \"miracle,\" \"heal\") that reflects the brand's voice, not a medical claim. Prices and stock can change; when in doubt, point people to the shop page or the JSON catalog linked above rather than repeating a cached number.\n";

writeFile("llms.txt", llmsTxt);

/* ---------- 7) live-domain propagation across every page ----------
   Every page ships with domain-dependent tags -- the canonical link
   and og:url meta (both commented out until launch), Plausible's
   data-domain attribute, and each JSON-LD block's @id/url/image/
   breadcrumb entries -- all sitting on the "your-domain-here.com"
   placeholder. Previously, going live meant hand-editing that
   placeholder in 7 HTML files across dozens of JSON-LD fields -- easy
   to miss one and ship inconsistent metadata. Now it's one line: set a
   real DOMAIN above and re-run this script (which every real deploy
   already does automatically, see netlify.toml/vercel.json/
   .github/workflows/deploy-pages.yml). While DOMAIN is still the
   placeholder, this whole block is a no-op and every page stays
   exactly as it is today. */
var DOMAIN_IS_LIVE = DOMAIN.indexOf("your-domain-here.com") === -1;
if (DOMAIN_IS_LIVE) {
  var BARE_DOMAIN = DOMAIN.replace(/^https?:\/\//, "");
  var ALL_HTML_PAGES = PAGES.map(function (p) {
    return p.loc;
  }).concat(["404.html"]);
  ALL_HTML_PAGES.forEach(function (page) {
    var filePath = path.join(ROOT, page);
    if (!fs.existsSync(filePath)) return;
    var html = fs.readFileSync(filePath, "utf8");

    // Turn the two "not live yet" comments into real, active tags.
    html = html.replace(
      /<!-- No live domain yet -- once deployed, add: (<link rel="canonical"[^>]*>) -->/,
      "$1"
    );
    html = html.replace(
      /<!-- og:url -- add once deployed: (<meta property="og:url"[^>]*>) -->/,
      "$1"
    );

    // Now that those tags are live (and already carry the placeholder
    // domain themselves), one blanket swap covers them plus every
    // JSON-LD @id/url/image/breadcrumb entry on the page.
    html = html.split("https://your-domain-here.com").join(DOMAIN);
    html = html
      .split('data-domain="your-domain-here.com"')
      .join('data-domain="' + BARE_DOMAIN + '"');

    writeFile(page, html);
  });
}

console.log("\nDone. Regenerated derived files + page copy from the JSON sources in assets/data/.");
