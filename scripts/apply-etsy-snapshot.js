#!/usr/bin/env node
/* ==========================================================
   Y'ALLTERNATIVE LIVING -- Etsy sync applier
   ----------------------------------------------------------
   Applies a freshly-gathered snapshot of the live Etsy shop to
   products-data.js -- the single source of truth this whole site's
   build pipeline (build-site-data.js) reads from.

   IMPORTANT -- how the snapshot gets built:
   This script does NOT fetch anything from Etsy itself (Etsy blocks
   plain server-side requests -- confirmed 403 from this sandbox).
   Gathering the snapshot means fetching the shop page
   (https://www.etsy.com/shop/YallternativeLivinCO) plus each
   individual listing page and reading the real numbers off them --
   normally done by Claude using its web-fetch capability during a
   scheduled sync run. See etsy-snapshot.example.json for the exact
   shape to write to etsy-snapshot.json before running this script.

   WHAT THIS SCRIPT AUTO-APPLIES (safe, factual, reversible):
     - per-product star rating + review count, read from THAT
       LISTING'S OWN "Reviews for this item" section (never the
       shop-wide aggregate -- see build-site-data.js comments for why
       that distinction matters for Google's structured-data rules)

   WHAT THIS SCRIPT DELIBERATELY NEVER DOES AUTOMATICALLY:
     - add a brand-new Etsy listing as a live product (it needs real
       photos, a written blurb, a category, and a variant decision --
       none of which should be invented) -- instead it's written to
       the "new listings" section of etsy-sync-report.md for a human
       (or a follow-up conversation) to add properly
     - remove a product that didn't show up in a snapshot (could just
       be a transient fetch miss, or the snapshot wasn't a full pass)
     - change a price (money changes should always be seen by a human
       before they go live, even though the underlying fact-check is
       easy) -- reported as drift instead

   Usage:
     node scripts/apply-etsy-snapshot.js [path/to/snapshot.json]
     (defaults to scripts/etsy-snapshot.json next to this script)
   ========================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var ROOT = path.join(__dirname, "..");

var snapshotPath = process.argv[2] || path.join(__dirname, "etsy-snapshot.json");
if (!fs.existsSync(snapshotPath)) {
  console.error("No snapshot file found at " + snapshotPath);
  console.error("Gather one first (fetch the Etsy shop page + each listing page), write it there,");
  console.error("matching the shape in scripts/etsy-snapshot.example.json, then re-run.");
  process.exit(1);
}
var snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
if (!Array.isArray(snapshot.listings)) {
  console.error(
    "Snapshot is missing a `listings` array -- see etsy-snapshot.example.json for the expected shape."
  );
  process.exit(1);
}

var dataPath = path.join(ROOT, "assets/js/products-data.js");

// Same window-stub trick build-site-data.js uses, so this unmodified
// browser-global file loads fine under plain Node too.
global.window = {};
require(dataPath);
var CATALOG = global.window.YL_PRODUCTS;
var PRODUCTS = CATALOG.products;

function listingIdFromUrl(url) {
  // Trailing slash after the ID is optional -- every etsyUrl in
  // products-data.js currently includes a slug (".../listing/123/slug"),
  // but a bare ".../listing/123" with no slug is also a valid Etsy URL,
  // and the old /\/listing\/(\d+)\// pattern silently returned null for
  // that shape, dropping the product from rating sync AND from the
  // "missing from Etsy" report with no error surfaced anywhere.
  var m = /\/listing\/(\d+)(?:\/|$)/.exec(url || "");
  return m ? m[1] : null;
}

// A malformed or corrupted snapshot entry (bad scrape, hand-edited by
// mistake) shouldn't be able to write garbage into products-data.js and,
// from there, straight into the site's aggregateRating JSON-LD.
function isValidRating(r) {
  return (
    !!r &&
    typeof r.value === "number" &&
    r.value >= 0 &&
    r.value <= 5 &&
    typeof r.count === "number" &&
    Number.isInteger(r.count) &&
    r.count >= 0
  );
}

var byListingId = {};
PRODUCTS.forEach(function (p) {
  var id = listingIdFromUrl(p.etsyUrl);
  if (id) byListingId[id] = p;
});

var ratingChanges = [];
var flags = [];
var newListings = [];
var seenIds = {};

snapshot.listings.forEach(function (item) {
  if (!item.listingId) return;
  seenIds[item.listingId] = true;
  var product = byListingId[item.listingId];
  if (!product) {
    newListings.push(item);
    return;
  }

  // ---- rating sync (the only thing this script auto-applies) ----
  if (item.rating && !isValidRating(item.rating)) {
    flags.push(
      product.name +
        ": snapshot rating " +
        JSON.stringify(item.rating) +
        " failed validation (value must be 0-5, count a non-negative integer) -- ignored, not applied"
    );
  } else {
    var newRating =
      item.rating && item.rating.count > 0
        ? { value: item.rating.value, count: item.rating.count }
        : null;
    var oldRating = product.rating || null;
    var changed =
      !!newRating !== !!oldRating ||
      (newRating &&
        oldRating &&
        (newRating.value !== oldRating.value || newRating.count !== oldRating.count));

    if (newRating && changed) {
      ratingChanges.push({ name: product.name, from: oldRating, to: newRating });
      product.rating = newRating;
    } else if (!newRating && oldRating) {
      // Etsy reviews don't just disappear -- if a snapshot claims 0 where we
      // currently show real reviews, that's almost certainly a bad/partial
      // fetch, not a real change. Flag it, don't touch the data.
      flags.push(
        product.name +
          ": snapshot shows 0 reviews but site currently shows " +
          oldRating.value +
          " (" +
          oldRating.count +
          ") -- NOT auto-removed, please verify manually"
      );
    }
  }

  // ---- price drift (reported only, never auto-applied) ----
  if (typeof item.price === "number" && Math.abs(item.price - product.price) > 0.001) {
    flags.push(
      product.name +
        ": site shows $" +
        product.price.toFixed(2) +
        ", Etsy shows $" +
        item.price.toFixed(2)
    );
  }
});

// ---- products on the site but absent from a COMPLETE snapshot ----
var missing = [];
if (snapshot.complete) {
  Object.keys(byListingId).forEach(function (id) {
    if (!seenIds[id]) missing.push(byListingId[id]);
  });
}

// ---- write products-data.js back out only if something actually changed ----
if (ratingChanges.length) {
  var HEADER =
    "/* Auto-mirrors assets/data/products.json as a global,\n" +
    "   so the site works instantly off file:// with zero\n" +
    "   network/CORS issues, and just as fast once hosted.\n" +
    "   NOTE: ratings in this file are kept in sync with real per-listing\n" +
    "   Etsy reviews by scripts/apply-etsy-snapshot.js -- everything else\n" +
    "   here (photos, blurbs, prices, variants) is still hand-maintained. */\n";
  var out = HEADER + "window.YL_PRODUCTS = " + JSON.stringify(CATALOG, null, 2) + ";\n";
  fs.writeFileSync(dataPath, out);
}

// ---- human-readable report, overwritten every run ----
var lines = [];
lines.push("# Etsy sync report");
lines.push("");
lines.push("Snapshot fetched: " + (snapshot.fetchedAt || "unknown"));
lines.push(
  "Complete pass (safe to check for removed listings): " + (snapshot.complete ? "yes" : "no")
);
lines.push("");
lines.push("## Rating changes applied (" + ratingChanges.length + ")");
if (!ratingChanges.length) lines.push("_None this run._");
ratingChanges.forEach(function (c) {
  lines.push(
    "- " +
      c.name +
      ": " +
      (c.from ? c.from.value + " (" + c.from.count + ")" : "no rating yet") +
      " -> " +
      c.to.value +
      " (" +
      c.to.count +
      ")"
  );
});
lines.push("");
lines.push(
  "## New Etsy listings not on the site yet -- needs a real review, never auto-added (" +
    newListings.length +
    ")"
);
if (!newListings.length) lines.push("_None this run._");
newListings.forEach(function (n) {
  lines.push(
    "- " +
      (n.title || n.listingId) +
      " -- $" +
      (typeof n.price === "number" ? n.price.toFixed(2) : "?") +
      " -- https://www.etsy.com/listing/" +
      n.listingId
  );
});
lines.push("");
lines.push("## Flags needing a human look -- price drift, odd data (" + flags.length + ")");
if (!flags.length) lines.push("_None this run._");
flags.forEach(function (f) {
  lines.push("- " + f);
});
lines.push("");
lines.push("## On the site but not seen in this Etsy check (" + missing.length + ")");
if (!snapshot.complete) {
  lines.push("_(skipped -- snapshot wasn't a complete pass, so this can't be trusted this run)_");
} else if (!missing.length) {
  lines.push("_None -- every product's listing is still active on Etsy._");
} else {
  missing.forEach(function (p) {
    lines.push("- " + p.name + " (" + p.etsyUrl + ")");
  });
}
lines.push("");
fs.writeFileSync(path.join(__dirname, "etsy-sync-report.md"), lines.join("\n") + "\n");

console.log("Rating changes applied: " + ratingChanges.length);
console.log("New listings needing review: " + newListings.length);
console.log("Flags needing a human look: " + flags.length);
console.log(
  "Missing from this check: " +
    missing.length +
    (snapshot.complete ? "" : " (skipped -- incomplete snapshot)")
);
console.log("Full report: scripts/etsy-sync-report.md");
if (ratingChanges.length) {
  console.log("\nproducts-data.js changed -- now run: node scripts/build-site-data.js && npm test");
}
