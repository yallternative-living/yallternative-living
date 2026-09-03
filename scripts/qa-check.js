#!/usr/bin/env node
"use strict";

/* ==========================================================
   Y'ALLTERNATIVE LIVING -- automated QA suite ("npm test")
   ----------------------------------------------------------
   Turns the manual, one-off checks that used to get re-typed by hand
   after every content/code change into a permanent, repeatable script:

     - Every .js file in the project actually parses (node --check)
     - CSS braces balance (a real, if blunt, signal something got
       mismatched)
     - Every <script type="application/ld+json"> block on every page
       is valid JSON
     - Every internal href/src the pages reference points at a real
       file (no dead links, no 404'ing local assets)
     - Every image referenced anywhere (HTML/JS/CSS/JSON) exists on
       disk
     - image-manifest.js has both AVIF and WebP variants for every
       entry (nothing silently reverted to JPG-only)
     - products-data.js: every product has the required fields, and
       any variants block is well-formed (options array, numeric
       priceDelta, matches what build-site-data.js expects)
     - Gift card custom-field option string round-trips parse correctly
       (catches a malformed "Preset $NN[+X.XX]" before it ships)
     - WCAG contrast math for the site's actual current color tokens,
       parsed live out of styles.css -- not hardcoded historical
       values, so a future palette edit gets re-checked automatically
       instead of silently drifting out of compliance

   Run: node scripts/qa-check.js   (or: npm test)
   Exits non-zero if anything fails, so this is CI-friendly.
   ========================================================== */

var fs = require("fs");
var path = require("path");
var { execSync } = require("child_process");
/* The first-party analytics paths. They are served by proxy rules in
   netlify.toml / vercel.json, not by files in the repo, so the link checker
   below has to know about them -- and the CSP checks further down assert that
   NO Umami host is allow-listed precisely because these paths exist. */
var analyticsProxy = require("./lib/analytics-proxy");

/* Mirrors escapeHtml() in scripts/build-site-data.js -- this check
   independently re-derives the expected FAQ HTML and diffs it against
   what build-data actually wrote, so the two escaping implementations
   must stay in lockstep or every FAQ answer with an apostrophe "fails". */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

var ROOT = path.join(__dirname, "..");
var PAGES = [
  "index.html",
  "shop.html",
  "about.html",
  "contact.html",
  "events.html",
  "faq.html",
  "privacy.html",
  "terms.html",
  "policies.html",
  "404.html",
  "thank-you.html",
  "welcome.html",
  "journal.html",
  "reviews.html",
  "order-status.html",
  // The MoCRA adverse-event page. It ships the same chrome as every other
  // top-level page (Tawk block, search modal, footer, Umami marker), so it
  // belongs in this list or none of those assertions would ever see it.
  "safety.html"
];

var failures = [];
var passCount = 0;

function ok(label) {
  passCount++;
  console.log("  ✓ " + label);
}
function fail(label, detail) {
  failures.push(label + (detail ? " -- " + detail : ""));
  console.log("  ✗ " + label + (detail ? " -- " + detail : ""));
}

function section(title) {
  console.log("\n" + title);
}

/* ---------- 1) JS syntax ---------- */
section("JavaScript syntax");
var jsFiles = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(function (f) {
    var full = path.join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) return;
    var stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (f.endsWith(".js")) jsFiles.push(full);
  });
})(ROOT);
jsFiles.forEach(function (f) {
  try {
    execSync('node --check "' + f + '"', { stdio: "pipe" });
    ok(path.relative(ROOT, f));
  } catch (e) {
    fail(path.relative(ROOT, f), e.stderr ? e.stderr.toString().split("\n")[0] : e.message);
  }
});

/* ---------- 1b) Canonical source data files parse as JSON ----------
   The four assets/data/*.json files are what the CMS (and hand-edits)
   write to, and the build's readJson() bails hard if one is malformed.
   Checking them here too means `npm test` -- which is quick and can run
   pre-commit -- flags a broken data file up front with the exact name,
   instead of the owner only finding out when a deploy silently fails.
   Also confirms the expected top-level shape so a structurally-valid
   but wrong-shaped file (e.g. reviews.json missing its "reviews" key)
   is caught before it reaches the site. */
section("Source data files (assets/data/*.json)");
[
  { file: "assets/data/products.json", keys: ["products"] },
  { file: "assets/data/events.json", keys: ["upcoming", "past"] },
  { file: "assets/data/site-reviews.json", keys: ["reviews"] },
  { file: "assets/data/content.json", keys: ["site", "home", "about", "contact", "shop"] }
].forEach(function (spec) {
  var full = path.join(ROOT, spec.file);
  if (!fs.existsSync(full)) {
    fail(spec.file, "missing");
    return;
  }
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    fail(spec.file + " is not valid JSON", e.message);
    return;
  }
  var missingKeys = spec.keys.filter(function (k) {
    return !(k in parsed);
  });
  if (missingKeys.length) fail(spec.file + " missing expected key(s)", missingKeys.join(", "));
  else ok(spec.file + " parses + has " + spec.keys.join(", "));
});

/* ---------- 2) CSS brace balance ---------- */
section("CSS brace balance");
var cssPath = path.join(ROOT, "assets", "css", "styles.css");
var css = "";
if (!fs.existsSync(cssPath)) {
  fail("assets/css/styles.css", "missing");
} else {
  css = fs.readFileSync(cssPath, "utf8");
  var openCount = (css.match(/\{/g) || []).length;
  var closeCount = (css.match(/\}/g) || []).length;
  if (openCount === closeCount) ok("styles.css: " + openCount + " open / " + closeCount + " close");
  else fail("styles.css brace mismatch", openCount + " open vs " + closeCount + " close");
}

/* ---------- 3) JSON-LD validity ---------- */
section("JSON-LD validity");
PAGES.forEach(function (page) {
  var full = path.join(ROOT, page);
  if (!fs.existsSync(full)) {
    fail(page, "file missing");
    return;
  }
  var html = fs.readFileSync(full, "utf8");
  var blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  blocks.forEach(function (block, i) {
    var jsonText = block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    try {
      JSON.parse(jsonText);
      ok(page + " JSON-LD block #" + (i + 1));
    } catch (e) {
      fail(page + " JSON-LD block #" + (i + 1), e.message);
    }
  });
});

/* ---------- 4) Internal links + images resolve to real files ---------- */
section("Internal links & asset references");
var badLinks = [];
PAGES.forEach(function (page) {
  var full = path.join(ROOT, page);
  if (!fs.existsSync(full)) return;
  var html = fs.readFileSync(full, "utf8");
  var refs = html.match(/(?:href|src)="([^"]+)"/g) || [];
  refs.forEach(function (r) {
    var m = r.match(/"([^"]+)"$/);
    if (!m) return;
    var target = m[1].replace(/<!--[\s\S]*?-->/g, "");
    if (/^(https?:|mailto:|tel:|#|data:|\/\/)/.test(target)) return;
    var clean = target.split("#")[0].split("?")[0];
    if (!clean) return;
    /* Served by a proxy rule, not by a file in the publish root. Asserted for
       real -- that the rule exists in all three config files -- by
       scripts/analytics.test.js; skipping it here without that would just be
       an exemption. */
    if (clean === analyticsProxy.ANALYTICS_SCRIPT_PATH) return;
    if (!fs.existsSync(path.join(ROOT, clean))) badLinks.push(page + " -> " + target);
  });
});
if (!badLinks.length)
  ok("all internal href/src targets resolve (" + PAGES.length + " pages checked)");
else
  badLinks.forEach(function (b) {
    fail("broken reference", b);
  });

var imgRefs = new Set();
[]
  .concat(
    PAGES.map(function (p) {
      return path.join(ROOT, p);
    }),
    [
      "assets/js/products-data.js",
      "assets/js/image-manifest.js",
      "assets/data/products.json",
      "assets/data/content.json"
    ].map(function (p) {
      return path.join(ROOT, p);
    })
  )
  .forEach(function (f) {
    if (!fs.existsSync(f)) return;
    var text = fs.readFileSync(f, "utf8");
    (text.match(/assets\/img\/[A-Za-z0-9_\-.]+/g) || []).forEach(function (m) {
      imgRefs.add(m);
    });
  });
var missingImgs = Array.from(imgRefs).filter(function (r) {
  return !fs.existsSync(path.join(ROOT, r));
});
/* A floor, not a coverage target: this set is built by regex-scanning pages,
   so if that scan ever broke the filter below would find nothing missing and
   report "all 0 referenced image paths exist" as a pass. */
if (!imgRefs.size) {
  fail(
    "image reference scan found any references at all",
    "0 refs scanned -- the check below would pass vacuously"
  );
} else if (!missingImgs.length) ok("all " + imgRefs.size + " referenced image paths exist on disk");
else
  missingImgs.forEach(function (m) {
    fail("missing image file", m);
  });

/* ---------- 5) image-manifest.js: AVIF + WebP coverage ---------- */
section("Responsive image manifest (AVIF + WebP coverage)");
var manifestPath = path.join(ROOT, "assets/js/image-manifest.js");
var manifest = {};
if (!fs.existsSync(manifestPath)) {
  fail("assets/js/image-manifest.js", "missing -- run npm run optimize-images");
} else {
  global.window = {};
  try {
    delete require.cache[require.resolve(manifestPath)];
  } catch (e) {
    /* not loaded yet, fine */
  }
  require(manifestPath);
  manifest = global.window.YL_IMAGES || {};
}
var manifestKeys = Object.keys(manifest);
if (!manifestKeys.length) fail("image-manifest.js", "no entries found");
else {
  var incomplete = manifestKeys.filter(function (k) {
    var v = manifest[k].variants;
    return !v || !v.avif || !v.avif.length || !v.webp || !v.webp.length;
  });
  if (!incomplete.length) ok(manifestKeys.length + " photos, all with AVIF + WebP variants");
  else
    incomplete.forEach(function (k) {
      fail("incomplete variants", k);
    });

  // Every variant file the manifest claims to exist actually needs to.
  var missingVariantFiles = [];
  manifestKeys.forEach(function (k) {
    var v = manifest[k].variants;
    ["avif", "webp"].forEach(function (fmt) {
      (v[fmt] || []).forEach(function (variant) {
        if (!fs.existsSync(path.join(ROOT, variant.file))) missingVariantFiles.push(variant.file);
      });
    });
  });
  if (!missingVariantFiles.length) ok("every manifest variant file exists on disk");
  else
    missingVariantFiles.forEach(function (f) {
      fail("manifest references missing file", f);
    });
}

/* ---------- 6) products-data.js schema sanity ---------- */
section("Product catalog schema");
var productsDataPath = path.join(ROOT, "assets/js/products-data.js");
var PRODUCTS = [];
if (!fs.existsSync(productsDataPath)) {
  fail("assets/js/products-data.js", "missing -- run npm run build-data");
} else {
  try {
    delete require.cache[require.resolve(productsDataPath)];
  } catch (e) {
    /* not loaded yet, fine */
  }
  require(productsDataPath);
  PRODUCTS = (global.window.YL_PRODUCTS && global.window.YL_PRODUCTS.products) || [];
}
if (fs.existsSync(productsDataPath) && !PRODUCTS.length)
  fail("products-data.js", "no products found");
var REQUIRED_FIELDS = ["id", "name", "category", "price", "image", "blurb"];

/* The only product categories with nothing to declare: printed apparel and the
   digital gift card. Everything else is something applied to skin and must
   list what is in it -- the PDP, the JSON-LD and the label all read from that
   array. Keep this list, not the individual product ids: a new salve must fail
   the check, a new t-shirt must not need an entry here. */
var INGREDIENTS_EXEMPT_CATEGORIES = ["apparel", "gift-cards"];
var exemptCategoriesInUse = PRODUCTS.filter(function (p) {
  return INGREDIENTS_EXEMPT_CATEGORIES.indexOf(p.category) !== -1;
});
if (exemptCategoriesInUse.length)
  ok(
    "ingredients allowlist covers " +
      exemptCategoriesInUse.length +
      " product(s) in " +
      JSON.stringify(INGREDIENTS_EXEMPT_CATEGORIES)
  );
else
  fail(
    "ingredients allowlist " +
      JSON.stringify(INGREDIENTS_EXEMPT_CATEGORIES) +
      " matches no product -- delete it rather than leaving a dead exemption"
  );

PRODUCTS.forEach(function (p) {
  var missing = REQUIRED_FIELDS.filter(function (f) {
    return p[f] === undefined || p[f] === null || p[f] === "";
  });
  if (!missing.length) ok(p.id + ": required fields present");
  else fail(p.id + ": missing required field(s)", missing.join(", "));

  if (typeof p.price !== "number" || !(p.price > 0))
    fail(p.id + ": price must be a positive number", String(p.price));

  // These optional fields use a truthy/non-empty check rather than a
  // strict `!== undefined` -- the Sveltia CMS admin (see admin/config.yml,
  // DEVELOPMENT.md section 20) writes an untouched optional object field as
  // `null` and an untouched optional list field as `[]`, not as an
  // omitted key, once a product has been saved through the CMS even
  // once. Treat "present but empty/null" the same as "omitted" so a
  // CMS-saved product with no rating/stock/ingredients doesn't trip a
  // false failure here.
  if (p.rating != null) {
    var r = p.rating;
    var ratingOk =
      r &&
      typeof r.value === "number" &&
      r.value >= 0 &&
      r.value <= 5 &&
      typeof r.count === "number" &&
      Number.isInteger(r.count) &&
      r.count > 0;
    if (ratingOk) ok(p.id + ": rating well-formed (" + r.value + " / " + r.count + " reviews)");
    else fail(p.id + ": rating must be {value: 0-5, count: positive integer}", JSON.stringify(r));
  }

  if (p.stock != null) {
    var stockOk = typeof p.stock === "number" && Number.isInteger(p.stock) && p.stock >= 0;
    if (stockOk) ok(p.id + ": stock well-formed (" + p.stock + ")");
    else
      fail(
        p.id + ": stock must be a non-negative integer (or omitted entirely if not tracked)",
        JSON.stringify(p.stock)
      );
  }

  /* An `ingredients` array used to be checked only when it was already there,
     so a product that shipped without one was silently exempt -- the check
     could not catch the case it exists for (audit "vacuous passes"). Every
     product the shop makes is now required to list its ingredients; the only
     exemptions are the two categories that have none to list, and the
     allowlist is asserted rather than assumed, so a new category cannot join
     it by accident. */
  if (!(p.ingredients && p.ingredients.length)) {
    if (INGREDIENTS_EXEMPT_CATEGORIES.indexOf(p.category) !== -1) {
      ok(p.id + ": ingredients not required (category '" + p.category + "' is exempt)");
    } else {
      fail(
        p.id +
          ": every product outside " +
          JSON.stringify(INGREDIENTS_EXEMPT_CATEGORIES) +
          " must list ingredients",
        "category '" + p.category + "' has no ingredients array"
      );
    }
  }

  if (p.ingredients && p.ingredients.length) {
    var ingOk =
      Array.isArray(p.ingredients) &&
      p.ingredients.every(function (i) {
        return typeof i === "string" && i.trim().length > 0;
      });
    if (ingOk) ok(p.id + ": ingredients well-formed (" + p.ingredients.length + " item(s))");
    else
      fail(
        p.id + ": ingredients must be a non-empty array of non-empty strings",
        JSON.stringify(p.ingredients)
      );
    if (p.ingredientsLabel != null && typeof p.ingredientsLabel !== "string")
      fail(p.id + ": ingredientsLabel must be a string");
    if (p.ingredientsNote != null && typeof p.ingredientsNote !== "string")
      fail(p.id + ": ingredientsNote must be a string");
  }

  if (p.variants) {
    var v = p.variants;
    if (!v.name || typeof v.name !== "string") fail(p.id + ": variants.name missing/invalid");
    if (!Array.isArray(v.options) || !v.options.length) {
      fail(p.id + ": variants.options must be a non-empty array");
    } else {
      var labels = v.options.map(function (o) {
        return o.label;
      });
      var dupeLabels = labels.filter(function (l, i) {
        return labels.indexOf(l) !== i;
      });
      if (dupeLabels.length)
        fail(p.id + ": duplicate variant option labels", dupeLabels.join(", "));
      var hasZeroDelta = v.options.some(function (o) {
        return (o.priceDelta || 0) === 0;
      });
      if (!hasZeroDelta)
        fail(p.id + ": no variant option has priceDelta 0 -- base p.price won't match any option");
      v.options.forEach(function (o) {
        if (typeof o.label !== "string" || !o.label) fail(p.id + ": variant option missing label");
        if (o.priceDelta !== undefined && typeof o.priceDelta !== "number")
          fail(p.id + ": variant option priceDelta must be numeric", o.label);
        // Per-variant sold-out flag (main.js picker/addToCartHTML and the
        // checkout Worker all read it) -- must be a real boolean when set,
        // since a truthy string like "false" would sell out the option.
        if (o.soldOut !== undefined && typeof o.soldOut !== "boolean")
          fail(p.id + ": variant option soldOut must be true/false", o.label);
        // main.js builds each product's data-item-custom1-options attribute
        // as "Label[+X.XX]|Label[+X.XX]|..." (see addToCartHTML() there,
        // and cart.js's addItemFromButton() which parses it back apart) --
        // a literal "[", "]", or "|" inside the label itself would break
        // that round-trip, so catch it here before it ships.
        if (/[[\]|]/.test(o.label))
          fail(
            p.id + ": variant option label contains [ ] or | (breaks the custom1-options syntax)",
            o.label
          );
      });
      if (labels.length && !dupeLabels.length)
        ok(p.id + ": variants well-formed (" + v.name + ": " + labels.join(", ") + ")");
    }
  }
});

/* ---------- 6a) Sales schema sanity ---------- */
section("Sales schema sanity");
try {
  var RAW_CATALOG = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
  );
  var catIds = (RAW_CATALOG.categories || []).map(function (c) {
    return c.id;
  });
  (RAW_CATALOG.products || []).forEach(function (p) {
    if (p.sale) {
      if (typeof p.sale.price !== "number" || p.sale.price >= p.price) {
        fail(p.id + ": sale.price must be less than price");
      }
      if (typeof p.sale.label !== "string" || !p.sale.label.trim()) {
        fail(p.id + ": sale.label must be a non-empty string");
      }
    }
  });
  (RAW_CATALOG.sales || []).forEach(function (s, i) {
    if (catIds.indexOf(s.category) === -1) {
      fail("Category sale #" + i + ": references invalid category '" + s.category + "'");
    }
    if (typeof s.percentOff !== "number" || s.percentOff < 1 || s.percentOff > 99) {
      fail("Category sale #" + i + ": percentOff must be between 1 and 99");
    }
    if (typeof s.label !== "string" || !s.label.trim()) {
      fail("Category sale #" + i + ": label must be a non-empty string");
    }
  });
  ok("Sales schema is valid");
} catch (e) {
  fail("products.json", "could not parse to validate sales: " + e.message);
}

/* ---------- 6a-2) Volume pricing rules schema sanity ---------- */
section("Volume pricing rules schema sanity");
try {
  var volRules = RAW_CATALOG.volumePricing || (RAW_CATALOG.shop && RAW_CATALOG.shop.volumePricing);
  if (volRules) {
    if (!Array.isArray(volRules)) {
      fail("volumePricing must be an array");
    } else {
      var seenRuleIds = {};
      volRules.forEach(function (r, idx) {
        if (!r.id || typeof r.id !== "string" || !r.id.trim()) {
          fail("Volume pricing rule #" + idx + ": missing or invalid id");
        } else if (seenRuleIds[r.id]) {
          fail("Volume pricing rule #" + idx + ": duplicate id '" + r.id + "'");
        } else {
          seenRuleIds[r.id] = true;
        }
        if (!r.name || typeof r.name !== "string" || !r.name.trim()) {
          fail("Volume pricing rule '" + (r.id || idx) + "': missing or empty name");
        }
        if (!r.category || catIds.indexOf(r.category) === -1) {
          fail(
            "Volume pricing rule '" + (r.id || idx) + "': invalid category '" + r.category + "'"
          );
        }
        if (typeof r.minQuantity !== "number" || r.minQuantity < 2) {
          fail("Volume pricing rule '" + (r.id || idx) + "': minQuantity must be a number >= 2");
        }
        if (typeof r.unitPrice !== "number" || r.unitPrice <= 0) {
          fail("Volume pricing rule '" + (r.id || idx) + "': unitPrice must be a positive number");
        }
        if (!r.label || typeof r.label !== "string" || !r.label.trim()) {
          fail("Volume pricing rule '" + (r.id || idx) + "': label must be a non-empty string");
        }
        if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
          fail(
            "Volume pricing rule '" + (r.id || idx) + "': enabled must be a boolean if specified"
          );
        }
      });
      ok("Volume pricing rules schema is valid (" + volRules.length + " rules)");
    }
  } else {
    ok("No volume pricing rules defined (skipping)");
  }
} catch (e) {
  fail("products.json", "could not validate volume pricing rules: " + e.message);
}

/* ---------- 6b) Bundles / gift sets schema sanity ---------- */
section("Bundles / gift sets");
var BUNDLES = (global.window.YL_PRODUCTS && global.window.YL_PRODUCTS.bundles) || [];
var FAQ = (global.window.YL_PRODUCTS && global.window.YL_PRODUCTS.faq) || [];
if (!BUNDLES.length) {
  console.log("  (no bundles defined -- fine, the shop page just skips that section)");
} else {
  var productIds = PRODUCTS.map(function (p) {
    return p.id;
  });
  var seenBundleIds = {};
  BUNDLES.forEach(function (b) {
    var label = "bundle " + (b.id || "(missing id)");
    var problems = [];
    if (!b.id || typeof b.id !== "string") problems.push("missing/invalid id");
    else if (seenBundleIds[b.id]) problems.push("duplicate id");
    else seenBundleIds[b.id] = true;
    if (!b.name || typeof b.name !== "string") problems.push("missing/invalid name");
    if (!b.blurb || typeof b.blurb !== "string") problems.push("missing/invalid blurb");
    if (!Array.isArray(b.productIds) || b.productIds.length < 2) {
      problems.push("productIds must be an array of at least 2 product ids");
    } else {
      var missingIds = b.productIds.filter(function (id) {
        return productIds.indexOf(id) === -1;
      });
      if (missingIds.length)
        problems.push("references unknown product id(s): " + missingIds.join(", "));
    }
    if (typeof b.discountPercent !== "number" || b.discountPercent < 0 || b.discountPercent > 90) {
      problems.push("discountPercent must be a number between 0 and 90");
    }
    if (!problems.length) ok(label + ": well-formed");
    else fail(label, problems.join("; "));
  });
}

/* ---------- 7) Gift card custom-field round-trip ---------- */
section("Gift card custom-field syntax round-trip");
// The gift card is the one product whose price options live directly in
// static HTML rather than being built at runtime from products.json's
// variants.options (see build-site-data.js's giftCardOptionsList loop and
// workers/checkout.js's resolveGiftCardAmountCents(), which parses this
// same "Preset $NN[+X.XX]" syntax server-side). Check it round-trips here
// so a bad build-site-data.js edit gets caught before it ships.
var shopHtmlForGiftCard = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
var giftCardOptionsMatch = shopHtmlForGiftCard.match(/data-item-custom1-options="([^"]+)"/);
if (giftCardOptionsMatch) {
  var giftCardParts = giftCardOptionsMatch[1].split("|");
  var giftCardParsedOk = giftCardParts.every(function (part) {
    return /^.+\[[+-]\d+\.\d{2}\]$/.test(part);
  });
  if (giftCardParsedOk)
    ok(
      "shop.html gift card: data-item-custom1-options options parse correctly (" +
        giftCardParts.length +
        " option(s))"
    );
  else
    fail(
      'shop.html gift card: data-item-custom1-options don\'t all match "Label[+X.XX]" pattern',
      giftCardOptionsMatch[1].slice(0, 120) + "…"
    );
} else {
  fail(
    "shop.html gift card",
    "data-item-custom1-options attribute not found -- run npm run build-data"
  );
}

/* ---------- 8) WCAG contrast math (parsed live from styles.css) ---------- */
section("WCAG 2.2 AA contrast (live-parsed from styles.css)");

function parseTokens(block) {
  var tokens = {};
  var re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  var m;
  while ((m = re.exec(block))) tokens[m[1]] = m[2].trim();
  return tokens;
}
function resolveHex(tokens, value, depth) {
  depth = depth || 0;
  if (depth > 5) return null;
  var varMatch = value.match(/^var\(--([a-z0-9-]+)\)$/i);
  if (varMatch)
    return tokens[varMatch[1]] ? resolveHex(tokens, tokens[varMatch[1]], depth + 1) : null;
  var hexMatch = value.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  return hexMatch ? hexMatch[0] : null;
}
function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3)
    hex = hex
      .split("")
      .map(function (c) {
        return c + c;
      })
      .join("");
  var num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function relLuminance(rgb) {
  var chan = rgb.map(function (c) {
    var s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}
function contrastRatio(hexA, hexB) {
  var lumA = relLuminance(hexToRgb(hexA));
  var lumB = relLuminance(hexToRgb(hexB));
  var lighter = Math.max(lumA, lumB);
  var darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

// Base (dark theme) tokens live across MULTIPLE unqualified :root{}
// blocks in this file (a palette block plus a separate "theme-invariant
// tokens" block) -- merge every one of them, in file order, rather than
// just the first match, or tokens declared in a later block get missed.
function mergeAllBlocks(pattern) {
  var merged = {};
  var re = new RegExp(
    pattern.source,
    pattern.flags.indexOf("g") === -1 ? pattern.flags + "g" : pattern.flags
  );
  var m;
  while ((m = re.exec(css))) Object.assign(merged, parseTokens(m[1]));
  return merged;
}
var darkTokens = mergeAllBlocks(/:root\s*\{([\s\S]*?)\n\}/);
var lightOverrides = mergeAllBlocks(/:root\[data-theme=["']light["']\]\s*\{([\s\S]*?)\n\}/);
var lightTokens = Object.assign({}, darkTokens, lightOverrides);

// Pairs that matter in practice on this site (foreground token,
// background token, minimum ratio, human label). 4.5:1 = normal text,
// 3:1 = large text / non-text UI components per WCAG 2.2 SC 1.4.3 / 1.4.11.
var PAIRS = [
  ["paper", "ink", 4.5, "body text on primary background"],
  ["paper", "ink-2", 4.5, "body text on card background"],
  ["rose-text", "ink", 4.5, "rose-text on primary background"],
  ["rose-text", "ink-2", 4.5, "rose-text on card background"],
  ["whiskey", "ink", 4.5, "whiskey accent text on primary background"],
  ["whiskey", "ink-2", 4.5, "whiskey accent text on card background"],
  ["on-fill", "rose-dim", 4.5, "button text on filled rose button"],
  // Reverse of the "whiskey accent text" pair above: whiskey as a solid
  // FILL with ink as the text sitting on top (the cart badge). Added
  // after a swarm-audit finding that turned out to be a false positive
  // for this exact pair once actually computed (~7.7:1 dark / ~5.3:1
  // light) -- kept here so any future token change that WOULD break it
  // gets caught automatically instead of relying on manual recheck.
  ["ink", "whiskey", 4.5, "badge/button text on whiskey fill (e.g. cart badge)"],
  ["paper-dim", "ink", 4.5, "muted body text on primary background"],
  ["paper-dim", "ink-2", 4.5, "muted body text on card background"],
  ["paper-dim", "footer-bg", 4.5, "muted footer text on footer background"]
];

[
  ["dark", darkTokens],
  ["light", lightTokens]
].forEach(function (pair) {
  var theme = pair[0],
    tokens = pair[1];
  PAIRS.forEach(function (spec) {
    var fgHex = resolveHex(tokens, tokens[spec[0]] || "");
    var bgHex = resolveHex(tokens, tokens[spec[1]] || "");
    if (!fgHex || !bgHex) {
      fail(
        "[" + theme + "] " + spec[3],
        "couldn't resolve --" + spec[0] + " or --" + spec[1] + " to a hex value"
      );
      return;
    }
    var ratio = contrastRatio(fgHex, bgHex);
    var label =
      "[" +
      theme +
      "] " +
      spec[3] +
      " (" +
      fgHex +
      " on " +
      bgHex +
      "): " +
      ratio.toFixed(2) +
      ":1";
    if (ratio >= spec[2]) ok(label);
    else fail(label, "below " + spec[2] + ":1 floor");
  });
});

/* ---------- 9) DOMAIN placeholder not shipped ---------- */
section("Live-domain placeholder");
var DOMAIN_PLACEHOLDER = "your-domain-here.com";
var domainCheckFiles = ["sitemap.xml", "llms.txt", "robots.txt", "shop.html"].concat(PAGES);
var domainHits = [];
Array.from(new Set(domainCheckFiles)).forEach(function (rel) {
  var full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return;
  var text = fs.readFileSync(full, "utf8");
  // Commented-out reminders ("<!-- add once deployed: ... -->") are fine
  // and expected pre-launch -- only count the placeholder where it's
  // live in actual markup/data, i.e. NOT inside an HTML comment.
  var withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.indexOf(DOMAIN_PLACEHOLDER) !== -1) domainHits.push(rel);
});
if (!domainHits.length) {
  ok("no live (non-comment) references to the " + DOMAIN_PLACEHOLDER + " placeholder");
} else {
  fail(
    "placeholder domain still live in generated output",
    domainHits.join(", ") +
      " -- set a real DOMAIN in scripts/build-site-data.js and re-run npm run build-data"
  );
}

/* ---------- 10) Security header configs stay in sync ---------- */
section("Security header configs (_headers / vercel.json / netlify.toml)");
function extractHeadersFileCSP() {
  var text = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
  var m = text.match(/Content-Security-Policy:\s*(.+)/);
  return m ? m[1].trim() : null;
}
function extractVercelCSP() {
  var json = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  var group = json.headers && json.headers[0] && json.headers[0].headers;
  var entry = (group || []).find(function (h) {
    return h.key === "Content-Security-Policy";
  });
  return entry ? entry.value : null;
}
function extractNetlifyCSP() {
  var text = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  var m = text.match(/Content-Security-Policy\s*=\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}
try {
  var cspHeaders = extractHeadersFileCSP();
  var cspVercel = extractVercelCSP();
  var cspNetlify = extractNetlifyCSP();
  if (!cspHeaders || !cspVercel || !cspNetlify) {
    fail("could not extract CSP from all three files", "run npm run build-security-headers first");
  } else if (cspHeaders === cspVercel && cspVercel === cspNetlify) {
    ok("_headers, vercel.json, and netlify.toml all carry the identical CSP");
  } else {
    fail(
      "CSP drift between header configs",
      "_headers " +
        (cspHeaders === cspVercel ? "==" : "!=") +
        " vercel.json, " +
        "vercel.json " +
        (cspVercel === cspNetlify ? "==" : "!=") +
        " netlify.toml -- run npm run build-security-headers to resync"
    );
  }
} catch (e) {
  fail("security header sync check", e.message);
}

/* ---------- 10b) Every tracked top-level .md is blocked on Netlify ---------- */
section("Top-level Markdown files are blocked by an explicit Netlify rule");
try {
  // Netlify honours only a trailing "*" splat, so a "/*.md" rule matches
  // nothing: README.md was served with a 200 on the live domain while the
  // rule sat in netlify.toml looking like it covered it. Each file needs its
  // own rule. `git ls-files` is the honest list of what a deploy ships;
  // fall back to the directory listing when git is unavailable.
  var mdFiles = [];
  try {
    mdFiles = require("child_process")
      .execSync("git ls-files -- '*.md'", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(function (f) {
        return f && f.indexOf("/") === -1;
      });
  } catch (gitErr) {
    mdFiles = fs.readdirSync(ROOT).filter(function (f) {
      return /\.md$/i.test(f);
    });
  }
  if (mdFiles.length === 0) {
    fail("no top-level .md files found", "the repo has README.md at minimum -- the listing broke");
  }
  var netlifyText = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  if (/from\s*=\s*"\/\*\.md"/.test(netlifyText)) {
    fail('netlify.toml still carries a "/*.md" rule', "Netlify never matches it; list each file");
  }
  mdFiles.forEach(function (f) {
    var ruleRe = new RegExp(
      '\\[\\[redirects\\]\\]\\s*\\n\\s*from = "/' +
        f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        '"\\s*\\n\\s*to = "/404\\.html"\\s*\\n\\s*status = 404'
    );
    if (ruleRe.test(netlifyText)) {
      ok("/" + f + " has an explicit 404 rule in netlify.toml");
    } else {
      fail(
        "/" + f + " is not blocked on Netlify",
        "add it to BLOCKED_PATHS in scripts/build-security-headers.js and rebuild"
      );
    }
  });
} catch (e) {
  fail("top-level .md block-rule check", e.message);
}

/* ---------- 10b) Netlify HTML post-processing is off, and every
   extensionless twin 301s to its canonical .html (audit C: C1, M8, L6)
   ----------------------------------------------------------------------
   Netlify's deploy-time rewriter re-serialised attributes with single
   quotes, so `aria-label="Y'allternative Living home"` was truncated at
   the apostrophe and the site's primary home link announced as "Y" on all
   36 pages. Nothing in this repo could see it: the committed bytes were
   correct and axe's link-name rule passes as long as SOME name exists.
   The only place that failure is visible from here is the config that
   switches the rewriter off, so assert it. */
section("Netlify HTML post-processing off + clean-URL 301s (netlify.toml)");
try {
  var procToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  if (/\[build\.processing\.html\]\s*\n\s*pretty_urls\s*=\s*false/.test(procToml)) {
    ok("netlify.toml sets [build.processing.html] pretty_urls = false");
  } else {
    fail(
      "netlify.toml does not disable Netlify's HTML rewriter",
      "add [build.processing.html] pretty_urls = false to the template in scripts/build-security-headers.js"
    );
  }
  /* Netlify end-of-serviced Asset Optimization on 2023-10-17. Writing the
     dead switch would read as a working guard that guards nothing -- the
     exact failure mode AGENTS.md calls "checks that stop checking". */
  if (/^[^#\n]*\bskip_processing\s*=/m.test(procToml)) {
    fail(
      "netlify.toml writes the retired skip_processing key",
      "Netlify removed that feature in 2023; pretty_urls = false is the live switch"
    );
  } else {
    ok("netlify.toml does not write the retired skip_processing no-op");
  }

  var shippedPages = fs.readdirSync(ROOT).filter(function (f) {
    return /\.html$/.test(f);
  });
  var productPagesForRedirects = fs.existsSync(path.join(ROOT, "products"))
    ? fs.readdirSync(path.join(ROOT, "products")).filter(function (f) {
        return /\.html$/.test(f);
      })
    : [];
  shippedPages = shippedPages.concat(
    productPagesForRedirects.map(function (f) {
      return "products/" + f;
    })
  );
  /* index.html's canonical is the extensionless "/" (nothing to redirect to),
     safety.html keeps its printed-on-the-packaging status=200 rewrite, and
     404.html is asserted separately below with status 404. */
  var redirectSkip = ["index.html", "safety.html", "404.html"];
  var wantRedirects = shippedPages.filter(function (f) {
    return redirectSkip.indexOf(f) === -1;
  });
  if (wantRedirects.length < 20) {
    fail(
      "clean-URL redirect check found almost no pages",
      "expected the top-level pages plus 20 PDPs, got " + wantRedirects.length
    );
  } else {
    var missingRedirects = wantRedirects.filter(function (rel) {
      var clean = "/" + rel.replace(/\.html$/, "");
      var re = new RegExp(
        '\\[\\[redirects\\]\\]\\s*\\n\\s*from = "' +
          clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          '"\\s*\\n\\s*to = "/' +
          rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          '"\\s*\\n\\s*status = 301\\s*\\n\\s*force = true'
      );
      return !re.test(procToml);
    });
    if (missingRedirects.length === 0) {
      ok("all " + wantRedirects.length + " extensionless twins 301 to their canonical .html");
    } else {
      fail(
        "netlify.toml is missing clean-URL 301s",
        missingRedirects.join(", ") + " -- re-run npm run build-security-headers"
      );
    }
  }
  /* A catch-all here would sit in the same ordered list as the /api/* proxy
     that carries the entire money path. Never generate one. */
  if (/from = "\/\*"/.test(procToml)) {
    fail(
      'netlify.toml carries a catch-all from = "/*" redirect',
      "it can shadow the /api/* Cloudflare Worker proxy -- use explicit per-page rules"
    );
  } else {
    ok("no catch-all redirect that could shadow the /api/* checkout proxy");
  }

  ["/404", "/404.html"].forEach(function (p) {
    var re = new RegExp(
      '\\[\\[redirects\\]\\]\\s*\\n\\s*from = "' +
        p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        '"\\s*\\n\\s*to = "/404\\.html"\\s*\\n\\s*status = 404'
    );
    if (re.test(procToml)) ok(p + " is configured to answer HTTP 404, not 200");
    else fail(p + " still answers 200", "add a status = 404 rule for it");
  });
} catch (e) {
  fail("netlify.toml post-processing / clean-URL check", e.message);
}

/* ---------- 10c) brand link + nav label are serializer-proof (C1, N3) ----- */
section("Header chrome: entity-escaped brand label + named nav landmark");
(function () {
  var chromePages = PAGES.slice();
  var productsDirForChrome = path.join(ROOT, "products");
  if (fs.existsSync(productsDirForChrome)) {
    fs.readdirSync(productsDirForChrome)
      .filter(function (f) {
        return /\.html$/.test(f);
      })
      .forEach(function (f) {
        chromePages.push("products/" + f);
      });
  }
  if (chromePages.length < 30) {
    fail(
      "header-chrome check has almost nothing to scan",
      "expected 16 top-level pages plus 20 PDPs, got " + chromePages.length
    );
    return;
  }
  var rawApostrophe = [];
  var entityMissing = [];
  var navUnlabelled = [];
  chromePages.forEach(function (rel) {
    var p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    var text = fs.readFileSync(p, "utf8");
    if (text.indexOf('class="brand"') === -1) return;
    if (text.indexOf('aria-label="Y\'allternative Living home"') !== -1) rawApostrophe.push(rel);
    if (text.indexOf('aria-label="Y&#39;allternative Living home"') === -1) entityMissing.push(rel);
    if (text.indexOf('<nav class="nav" aria-label="Main Navigation">') === -1) {
      navUnlabelled.push(rel);
    }
  });
  if (rawApostrophe.length === 0) {
    ok("no page writes the brand aria-label with a raw apostrophe");
  } else {
    fail(
      "brand aria-label carries a raw apostrophe",
      rawApostrophe.join(", ") + " -- write it as Y&#39;allternative so no serializer can split it"
    );
  }
  if (entityMissing.length === 0) {
    ok("all " + chromePages.length + " pages carry the entity-escaped brand aria-label");
  } else {
    fail("brand aria-label missing or altered", entityMissing.join(", "));
  }
  if (navUnlabelled.length === 0) {
    ok('every <nav class="nav"> carries aria-label="Main Navigation"');
  } else {
    fail(
      "nav landmark is unlabelled on some pages",
      navUnlabelled.join(", ") + " -- the generated PDPs and hand-written pages must agree"
    );
  }
})();

/* ---------- 10d) Coming-soon PDPs tell the truth (audit C: H1, H2, H3) ----
   Five products are pre-launch. Their PDPs used to render the physical
   trust strip unconditionally ("ships in 1-3 business days", "Secure
   checkout by Stripe") directly under their own October batch date and
   notify-me form (H2); tell visitors "No reviews of this one yet" about
   products whose real Etsy reviews /reviews.html publishes on the same site
   (H1); and hand an SVG to og:image and to schema.org Product.image, where
   no social-card renderer and no product feed accepts one (H3). */
section("Coming-soon PDPs: no false shipping/checkout, no false 'no reviews', raster images");
(function () {
  var comingSoonProducts = [];
  var allProductsForPdp = [];
  try {
    var pj = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));
    allProductsForPdp = pj.products || [];
    comingSoonProducts = allProductsForPdp.filter(function (p) {
      return p && p.comingSoon === true;
    });
  } catch (e) {
    fail("coming-soon PDP check could not read products.json", e.message);
    return;
  }
  if (!allProductsForPdp.length) {
    fail("coming-soon PDP check has no catalogue to scan", "products.json parsed to zero products");
    return;
  }
  if (!comingSoonProducts.length) {
    /* Not a failure -- but say so out loud rather than printing a green tick
       for a check that examined nothing. */
    console.log("  (no comingSoon products in the catalogue right now -- H1/H2 have no subject)");
  }

  var reviewsById = {};
  try {
    var rj = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/site-reviews.json"), "utf8"));
    (rj.reviews || []).forEach(function (r) {
      if (!r || !r.productId) return;
      (reviewsById[r.productId] = reviewsById[r.productId] || []).push(r);
    });
  } catch (e) {
    fail("coming-soon PDP check could not read site-reviews.json", e.message);
    return;
  }

  var FALSE_ON_A_PRELAUNCH_PAGE = [
    "ships from Landrum, SC in 1&ndash;3 business days",
    "Secure checkout by Stripe",
    "exchange within 14 days"
  ];
  comingSoonProducts.forEach(function (p) {
    var pdp = path.join(ROOT, "products", p.id + ".html");
    if (!fs.existsSync(pdp)) {
      fail(p.id + ": PDP missing", "run npm run build-data");
      return;
    }
    var html = fs.readFileSync(pdp, "utf8");
    var lied = FALSE_ON_A_PRELAUNCH_PAGE.filter(function (s) {
      return html.indexOf(s) !== -1;
    });
    if (lied.length === 0) {
      ok(p.id + ": pre-launch PDP promises no shipping window, checkout or return clock");
    } else {
      fail(
        p.id + ": pre-launch PDP still promises things it cannot do",
        lied.join(" | ") + " -- gate renderPdpTrustHtml() on comingSoon"
      );
    }
    if (p.estimatedBatchDate) {
      if (html.indexOf("estimated batch date " + p.estimatedBatchDate) !== -1) {
        ok(p.id + ": trust strip states the real batch date (" + p.estimatedBatchDate + ")");
      } else {
        fail(p.id + ": trust strip does not state the batch date", p.estimatedBatchDate);
      }
    }
    var mine = reviewsById[p.id] || [];
    if (mine.length) {
      if (html.indexOf("No reviews of this one yet") === -1) {
        ok(p.id + ": does not claim 'no reviews' while " + mine.length + " are published");
      } else {
        fail(
          p.id + ": PDP says 'No reviews of this one yet'",
          "but site-reviews.json publishes " + mine.length + " review(s) of it"
        );
      }
      var missing = mine.filter(function (r) {
        return html.indexOf(escapeHtml(r.text)) === -1;
      });
      if (missing.length === 0) {
        ok(p.id + ": all " + mine.length + " real reviews are rendered on the PDP");
      } else {
        fail(p.id + ": PDP drops " + missing.length + " of its own published reviews", "");
      }
      if (html.indexOf('<p class="pdp-reviews-summary"><span class="stars"') === -1) {
        ok(p.id + ": no averaged star rating advertised for an unreleased batch");
      } else {
        fail(p.id + ": pre-launch PDP advertises an averaged star rating", "");
      }
    }
  });

  /* H3 applies to the whole catalogue, not just today's five: an SVG must
     never reach a social card or a product feed from any product. */
  var svgInSocial = [];
  allProductsForPdp.forEach(function (p) {
    var pdp = path.join(ROOT, "products", p.id + ".html");
    if (!fs.existsSync(pdp)) return;
    var html = fs.readFileSync(pdp, "utf8");
    var metaHits =
      html.match(/<meta (?:property="og:image"|name="twitter:image") content="[^"]*"/g) || [];
    if (!metaHits.length) {
      svgInSocial.push(p.id + " (no og:image at all)");
      return;
    }
    metaHits.forEach(function (tag) {
      if (/\.svg"/i.test(tag)) svgInSocial.push(p.id + " " + tag);
    });
    var ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    ld.forEach(function (block) {
      var body = block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
      var parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        return;
      }
      if (!parsed || parsed["@type"] !== "Product") return;
      var imgs = [].concat(parsed.image || []);
      imgs.forEach(function (u) {
        if (/\.svg$/i.test(String(u))) svgInSocial.push(p.id + " JSON-LD image " + u);
      });
    });
  });
  if (svgInSocial.length === 0) {
    ok("no PDP hands an SVG to og:image, twitter:image or schema.org Product.image");
  } else {
    fail(
      "SVG reaching a social card or product feed",
      svgInSocial.join(", ") + " -- route it through rasterImagePath() in build-site-data.js"
    );
  }
  [
    "assets/img/placeholder-coming-soon-og.jpg",
    "assets/img/placeholder-coming-soon-1200.png"
  ].forEach(function (rel) {
    if (fs.existsSync(path.join(ROOT, rel))) ok(rel + " exists on disk");
    else fail(rel + " is missing", "regenerate it -- see rasterImagePath() in build-site-data.js");
  });
})();

/* ---------- 10e) Live chat coverage matches what the privacy policy says
   (audit C, findings L3 and M9) -----------------------------------------
   The Tawk.to loader shipped on the 16 hand-written pages and on none of
   the 20 PDPs, while /privacy.html told readers it was "live on nearly
   every page of this site". 16 of 37 is not nearly every page, and the
   PDPs are exactly where a shopper has a question. Both halves are asserted
   here, together, because either one alone can drift into a lie. */
section("Live chat coverage (all PDPs) matches the privacy policy's claim");
(function () {
  var pdpDir = path.join(ROOT, "products");
  if (!fs.existsSync(pdpDir)) {
    fail("chat-coverage check found no products/ directory", "run npm run build-data");
    return;
  }
  var pdps = fs.readdirSync(pdpDir).filter(function (f) {
    return /\.html$/.test(f);
  });
  if (pdps.length < 15) {
    fail("chat-coverage check has almost no PDPs to scan", pdps.length + " found");
    return;
  }
  var withoutChat = pdps.filter(function (f) {
    var text = fs.readFileSync(path.join(pdpDir, f), "utf8");
    return text.indexOf("embed.tawk.to/") === -1 || text.indexOf("Tawk_LoadStart") === -1;
  });
  if (withoutChat.length === 0) {
    ok("all " + pdps.length + " product pages ship the deferred Tawk.to chat loader");
  } else {
    fail(
      withoutChat.length + " product page(s) ship no chat loader",
      withoutChat.join(", ") + " -- see renderTawkChatHtml() in build-site-data.js"
    );
  }
  /* The loader must stay deferred behind a real interaction: an idle-timeout
     fallback put the widget's iframe on screen with no user input and cost
     0.047 CLS on every page. */
  var eager = pdps.filter(function (f) {
    var text = fs.readFileSync(path.join(pdpDir, f), "utf8");
    return text.indexOf('["pointerdown", "keydown", "scroll", "touchstart"]') === -1;
  });
  if (eager.length === 0) ok("the PDP chat loader is deferred behind first interaction");
  else fail("PDP chat loader is not deferred", eager.join(", "));

  var privacyText = fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8");
  if (/live on nearly every page/.test(privacyText)) {
    fail(
      "privacy.html still says the chat is on 'nearly every page'",
      "it is on every page now -- say so, or say the real number"
    );
  } else if (/live on every page of this site/.test(privacyText)) {
    ok("privacy.html states the real (now complete) chat coverage");
  } else {
    fail("privacy.html no longer describes chat coverage at all", "M9 asked for a true claim");
  }
  /* The other half of M9: #reviewForm is on shop, reviews AND all 20 PDPs.
     The policy named 2 of 22 locations, and "where" is what a reader checks
     a privacy policy for. */
  var reviewFormPages = [];
  ["shop.html", "reviews.html"].forEach(function (rel) {
    if (fs.readFileSync(path.join(ROOT, rel), "utf8").indexOf('id="reviewForm"') !== -1) {
      reviewFormPages.push(rel);
    }
  });
  pdps.forEach(function (f) {
    if (fs.readFileSync(path.join(pdpDir, f), "utf8").indexOf('id="reviewForm"') !== -1) {
      reviewFormPages.push("products/" + f);
    }
  });
  if (reviewFormPages.length > 2) {
    if (/on every product page/.test(privacyText)) {
      ok(
        "privacy.html lists product pages among the " +
          reviewFormPages.length +
          " places the review form actually appears"
      );
    } else {
      fail(
        "privacy.html under-reports where the review form lives",
        "it is on " + reviewFormPages.length + " pages, including every PDP"
      );
    }
  } else {
    fail("review-form sweep found it on 2 pages or fewer", "expected shop, reviews and 20 PDPs");
  }
})();

/* ---------- 10f) Copy that contradicted other copy (audit C: M1-M5, L11)
   ----------------------------------------------------------------------
   These are one-line regressions to re-introduce and impossible to spot by
   reading a diff, so each is pinned against the shipped page or the CMS
   source it comes from. */
section("Content integrity: claims the rest of the site contradicts");
(function () {
  var catalog;
  var content;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));
    content = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
  } catch (e) {
    fail("content-integrity check could not read the CMS sources", e.message);
    return;
  }
  var products = catalog.products || [];
  if (!products.length) {
    fail("content-integrity check has no products to scan", "products.json parsed empty");
    return;
  }

  /* M1 -- "prescription" is drug vocabulary, on the same page as the
     sitewide "not medicine" disclaimer, in the shop's own words.

     Checked in BOTH places it lives. shop.html's quiz banner and modal
     subtitles are hand-written static copy, NOT wrapped in a YL: marker, so
     an earlier version of this check that read only content.json reported
     green while the shipped page still said "prescription" twice. Assert
     the bytes production serves as well as the CMS source. */
  var quiz = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/quiz.json"), "utf8"));
  var quizCopy = [quiz.subtitle, quiz.modalSubtitle].join(" ");
  if (!quizCopy.trim()) {
    fail("quiz copy is empty in quiz.json", "nothing to check for M1");
  } else if (/prescription/i.test(quizCopy)) {
    fail(
      "content.json's quiz copy offers a 'prescription'",
      "the footer on that same page says 'not medicine'"
    );
  } else {
    ok("content.json's quiz copy offers a match, not a prescription");
  }
  var drugWordPages = [];
  var quizBannerSeen = false;
  PAGES.forEach(function (rel) {
    var fp = path.join(ROOT, rel);
    if (!fs.existsSync(fp)) return;
    var text = fs.readFileSync(fp, "utf8");
    if (/Answer 3 quick questions/i.test(text)) quizBannerSeen = true;
    if (/prescription/i.test(text)) drugWordPages.push(rel);
  });
  if (!quizBannerSeen) {
    fail("the quiz banner copy was not found on any page", "M1 has no shipped subject to check");
  } else if (drugWordPages.length === 0) {
    ok("no shipped page uses the word 'prescription'");
  } else {
    fail("'prescription' still ships on a page", drugWordPages.join(", "));
  }
  /* The quiz's RESULT header is built at runtime by main.js, so it is on no
     page for the sweep above to find -- and that is exactly how the first
     pass at this fix missed it. The word also appears in
     SEARCH_SYNONYM_BANNED in build-site-data.js: this repo already refuses
     "prescription" as a search synonym because it reads as a treatment
     claim, while the shop's own quiz was saying it out loud. */
  var quizResultCopy = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
  if (quizResultCopy.indexOf("Your Apothecary Match") === -1) {
    fail("the quiz result header is missing from main.js", "M1 has no runtime subject to check");
  } else if (/Your Apothecary Prescription/i.test(quizResultCopy)) {
    fail("the quiz still hands the shopper a 'Prescription'", "assets/js/main.js result card");
  } else {
    ok("the quiz result card offers a match, not a prescription");
  }

  /* M2 -- a known contact allergen in the ingredient list must be named in
     the safety-facing copy, not just buried in the INCI string. */
  var allergenMisses = products.filter(function (p) {
    var ing = (p.ingredients || []).join(" ");
    if (!/methylisothiazolinone/i.test(ing)) return false;
    var safetyCopy = [(p.usageGuide || {}).patchTest, p.ingredientsNote].join(" ");
    return !/methylisothiazolinone/i.test(safetyCopy);
  });
  if (allergenMisses.length === 0) {
    ok("every product containing methylisothiazolinone names it in its own safety copy");
  } else {
    fail(
      "a known contact allergen is disclosed only in the INCI string",
      allergenMisses
        .map(function (p) {
          return p.id;
        })
        .join(", ")
    );
  }

  /* M3 -- "pure essential oils" is not true of a formula carrying a
     synthetic preservative system. */
  var purityOverclaims = products.filter(function (p) {
    var copy = [(p.usageGuide || {}).patchTest, p.blurb, p.ingredientsNote].join(" ");
    if (!/pure\s+essential\s+oils/i.test(copy)) return false;
    return /germall|preservative|phenoxyethanol|diazolidinyl|urea/i.test(
      (p.ingredients || []).join(" ")
    );
  });
  if (purityOverclaims.length === 0) {
    ok("no preserved formula describes itself as 'pure essential oils'");
  } else {
    fail(
      "'pure essential oils' claimed for a preserved formula",
      purityOverclaims
        .map(function (p) {
          return p.id;
        })
        .join(", ")
    );
  }

  /* M4 -- the site's only affirmative pet-safety claim, on a mist built
     from cedar and sage essential oils. No veterinary source supports it. */
  var petClaims = products.filter(function (p) {
    var copy = [p.blurb, p.ingredientsNote, (p.usageGuide || {}).howToApply].join(" ");
    return /safe (?:around|for) pets|pet[- ]safe|safe around cats/i.test(copy);
  });
  if (petClaims.length === 0) {
    ok("no product makes an affirmative pet-safety claim");
  } else {
    fail(
      "affirmative pet-safety claim in product copy",
      petClaims
        .map(function (p) {
          return p.id;
        })
        .join(", ") + " -- use access-control wording instead"
    );
  }

  /* M5 -- the FAQ and policies used to send shoppers to the product page
     for a per-item processing time that does not exist: 19 of 19 physical
     products carry the identical 1-3 day line. Assert BOTH halves: that the
     redirection is gone, and that the thing it lied about is still true. */
  var faqShipping = (catalog.faq || []).filter(function (f) {
    return /ship|processing/i.test(f.question || "");
  });
  if (!faqShipping.length) {
    fail("no shipping FAQ entry found", "M5 has no subject");
  } else {
    var stillRedirects = faqShipping.filter(function (f) {
      return /check the (?:specific )?product (?:description|page)/i.test(f.answer || "");
    });
    if (stillRedirects.length === 0) {
      ok("the shipping FAQ answers the processing-time question instead of deferring it");
    } else {
      fail(
        "the FAQ still defers processing time to the product page",
        "every physical product states the same 1-3 business days"
      );
    }
  }
  var policiesText = fs.readFileSync(path.join(ROOT, "policies.html"), "utf8");
  if (/processing times vary by product/i.test(policiesText)) {
    fail("policies.html still says processing times vary by product", "they do not");
  } else {
    ok("policies.html states the real processing time");
  }

  /* L11 -- workers/checkout.js waives shipping at >= the threshold, so an
     exactly-$40.00 cart ships free. "over $40" left that case undefined. */
  var overFortyPages = [];
  ["policies.html", "faq.html", "index.html", "shop.html"].forEach(function (rel) {
    var fp = path.join(ROOT, rel);
    if (!fs.existsSync(fp)) return;
    if (/(?:orders?|shipping)[^<.]{0,40}\bover \$\d/i.test(fs.readFileSync(fp, "utf8"))) {
      overFortyPages.push(rel);
    }
  });
  var announcement = (content.site && content.site.announcement) || {};
  if (/over \$\d/.test(String(announcement.text || ""))) overFortyPages.push("content.json banner");
  if (overFortyPages.length === 0) {
    ok('free-shipping copy says "$40 or more", matching the >= the Worker actually applies');
  } else {
    fail(
      'free-shipping copy still says "over $40"',
      overFortyPages.join(", ") + " -- the Worker ships a $40.00 cart free"
    );
  }
})();

/* ---------- 11) aggregateRating JSON-LD sanity (shop.html) ---------- */
section("Per-product aggregateRating JSON-LD");
var shopHtml = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
var shopLdMatch = shopHtml.match(
  /<script type="application\/ld\+json">\n(\{\s*\n\s*"@context": "https:\/\/schema\.org",\s*\n\s*"@type": "ItemList"[\s\S]*?\n)<\/script>/
);
if (!shopLdMatch) {
  fail("shop.html ItemList JSON-LD", "block not found -- run npm run build-data");
} else {
  try {
    var itemList = JSON.parse(shopLdMatch[1]);
    var items = itemList.itemListElement || [];
    var ratedCount = 0;
    items.forEach(function (li) {
      var prod = li.item || {};
      if (prod.aggregateRating === undefined) return;
      ratedCount++;
      var ar = prod.aggregateRating;
      var val = Number(ar.ratingValue);
      var cnt = Number(ar.reviewCount);
      var good =
        ar["@type"] === "AggregateRating" &&
        val >= 0 &&
        val <= 5 &&
        Number.isInteger(cnt) &&
        cnt > 0;
      if (good) ok(prod.name + ": aggregateRating well-formed (" + val + " / " + cnt + ")");
      else fail(prod.name + ": aggregateRating malformed", JSON.stringify(ar));
    });
    if (!ratedCount)
      console.log(
        "  (no products currently carry aggregateRating -- fine if none have real reviews yet)"
      );
    var productsWithDataRating = PRODUCTS.filter(function (p) {
      return p.rating;
    }).length;
    if (ratedCount === productsWithDataRating) {
      ok(
        "aggregateRating present for exactly the " +
          ratedCount +
          " product(s) with real rating data -- none fabricated, none missing"
      );
    } else {
      fail(
        "aggregateRating count mismatch",
        ratedCount +
          " in JSON-LD vs " +
          productsWithDataRating +
          " products with rating data in products-data.js -- run npm run build-data"
      );
    }
  } catch (e) {
    fail("shop.html ItemList JSON-LD", "invalid JSON -- " + e.message);
  }
}

/* ---------- 12) Site-submitted reviews (site-reviews-data.js) ----------
   These are hand-added by Savanna after reading a Formspree submission
   email (see that file's header comment + DEVELOPMENT.md section 16) -- nothing
   here auto-publishes, but a typo'd entry could still ship broken markup
   or a bogus rating to the live "Customer Reviews" section, so it gets
   the same shape validation as everything else that reaches the page. */
section("Site-submitted reviews (site-reviews-data.js)");
var siteReviewsPath = path.join(ROOT, "assets/js/site-reviews-data.js");
var SITE_REVIEWS = [];
if (!fs.existsSync(siteReviewsPath)) {
  fail("assets/js/site-reviews-data.js", "missing -- run npm run build-data");
} else {
  try {
    delete require.cache[require.resolve(siteReviewsPath)];
  } catch (e) {
    /* not loaded yet, fine */
  }
  require(siteReviewsPath);
  SITE_REVIEWS = global.window.YL_SITE_REVIEWS || [];
}
if (!SITE_REVIEWS.length) {
  console.log("  (no site reviews yet -- fine, the site falls back to an empty-state message)");
} else {
  var reviewProductIds = PRODUCTS.map(function (p) {
    return p.id;
  });
  var seenReviewIds = {};
  SITE_REVIEWS.forEach(function (r, i) {
    var label = "review #" + (i + 1) + (r.id ? " (" + r.id + ")" : "");
    var problems = [];
    if (!r.id || typeof r.id !== "string") problems.push("missing/invalid id");
    else if (seenReviewIds[r.id]) problems.push("duplicate id");
    else seenReviewIds[r.id] = true;
    if (!r.name || typeof r.name !== "string") problems.push("missing/invalid name");
    if (!r.text || typeof r.text !== "string") problems.push("missing/invalid text");
    if (!(
      typeof r.rating === "number" &&
      Number.isInteger(r.rating) &&
      r.rating >= 1 &&
      r.rating <= 5
    )) {
      problems.push("rating must be an integer 1-5");
    }
    if (
      r.productId !== null &&
      r.productId !== undefined &&
      reviewProductIds.indexOf(r.productId) === -1
    ) {
      problems.push(
        'productId "' + r.productId + "\" doesn't match any product in products-data.js"
      );
    }
    if (r.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(r.date))
      problems.push("date must be YYYY-MM-DD");

    if (!problems.length) ok(label + ": well-formed");
    else fail(label, problems.join("; "));
  });
}

/* ---------- 13) HTML comments hiding a literal "<script" (regression
   guard) ----------
   Real bug found and fixed this session: shop.html's Gift Up placeholder
   comment used to read "paste the real <div>/<script> snippet", and that
   literal "<script>" text -- even though it's inert, commented-out
   prose -- was enough to fool build-security-headers.js's regex-based
   inline-script extractor (which doesn't parse real HTML, just scans for
   "<script...>...</script>") into treating it as a real opening tag and
   swallowing everything up to the next actual "</script>" as bogus
   "script content". That silently broke the CSP hash generation with no
   error until the mismatched-hash exception happened to fire. Guard
   against this whole bug class recurring in ANY future comment on ANY
   page, not just this one spot. */
section('HTML comments don\'t contain a literal "<script" (build-security-headers.js regex trap)');
PAGES.forEach(function (page) {
  var full = path.join(ROOT, page);
  if (!fs.existsSync(full)) return;
  var html = fs.readFileSync(full, "utf8");
  var comments = html.match(/<!--[\s\S]*?-->/g) || [];
  var offenders = comments.filter(function (c) {
    return /<script\b/i.test(c);
  });
  if (!offenders.length) ok(page + ': no comment contains a literal "<script"');
  else
    fail(
      page + ': HTML comment contains literal "<script"',
      'this breaks build-security-headers.js\'s naive tag scanner -- reword the comment to avoid the exact substring "<script"'
    );
});

/* ---------- 14) CSP covers every currently-wired third-party integration ---------- */
section("CSP covers every currently-wired integration domain");
var cspText = null;
try {
  cspText = extractHeadersFileCSP();
} catch (e) {
  /* handled below */
}
if (!cspText) {
  fail("CSP domain coverage", "couldn't read _headers -- run npm run build-security-headers first");
} else {
  /* Umami is checked below rather than here: a substring match on "umami.is"
     is satisfied by cloud.umami.is alone, which is exactly how this site
     shipped analytics that recorded nothing. The two hosts live in different
     directives and both are mandatory. */
  var REQUIRED_CSP_SUBSTRINGS = [
    ["formspree.io", "Formspree (review submission form)"],
    ["embed.tawk.to", "Tawk.to (live chat script-src)"],
    ["*.tawk.to", "Tawk.to (connect/frame/img-src)"]
  ];
  /* The newsletter endpoint is derived, not pinned. This list used to require
     BOTH app.kit.com and app.convertkit.com -- the second was dead (nothing in
     the repo or on any live page reached it) and the 2026-09-02 live audit
     called it out as CSP dilution, but a hardcoded pin is also the wrong shape:
     it asserts a domain instead of asserting that the domain the site is
     actually configured to post to is allowed. Read site.kitFormAction and
     require ITS origin, so switching the CMS field to any other host fails
     here instead of silently breaking signups in the browser. */
  try {
    var cspContent = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
    );
    var kitAction = ((cspContent.site || {}).kitFormAction || "").trim();
    if (!kitAction || kitAction.indexOf("YOUR_") === 0) {
      ok("newsletter endpoint not configured yet -- no CSP origin to require");
    } else if (!/^https:\/\//.test(kitAction)) {
      fail("site.kitFormAction", "expected an https:// URL, got: " + kitAction);
    } else {
      var kitOrigin = "https://" + kitAction.split("/")[2];
      REQUIRED_CSP_SUBSTRINGS.push([kitOrigin, "newsletter form (site.kitFormAction)"]);
    }
  } catch (e) {
    fail("CSP newsletter origin check", "could not read content.json: " + e.message);
  }
  REQUIRED_CSP_SUBSTRINGS.forEach(function (pair) {
    if (cspText.indexOf(pair[0]) !== -1) ok("CSP includes " + pair[0] + " (" + pair[1] + ")");
    else
      fail(
        "CSP missing " + pair[0],
        pair[1] +
          " is wired into the site but not allowlisted -- it'll be silently blocked by the browser"
      );
  });
  /* Analytics takes one of TWO routes, chosen at runtime by
     assets/js/porch-light.js, and the policy has to allow both. Four
     assertions, none optional, because each failure is silent and each is
     silent in a different way:

       script-src cloud.umami.is  -- missing: the direct copy never loads, so
         EVERY visitor is demoted to the proxy and nobody's session id or
         country is their own. The dashboard still fills up. Nothing says why.
       connect-src gateway.umami.is -- missing: the direct copy loads
         perfectly and the browser refuses every pageview and every event it
         sends. This is not hypothetical; it is how this shop's dashboard read
         zero from the day analytics was switched on until 2026-09-02.
       'self' in both -- missing: the loader itself, or the fallback route,
         stops working, and blocked visitors go back to being uncounted.

     Note that a substring match on "umami.is" would pass on cloud.umami.is
     alone, which is exactly the check that let the outage above ship. The
     script origin and the collection origin are different hosts in different
     directives, so they are named separately here. */
  var connectSrcMatch = /connect-src ([^;]*)/.exec(cspText);
  var scriptSrcMatch = /script-src ([^;]*)/.exec(cspText);
  if (!connectSrcMatch || !scriptSrcMatch) {
    fail("CSP analytics directives", "could not find connect-src and script-src in _headers");
  } else {
    if (connectSrcMatch[1].indexOf(analyticsProxy.UMAMI_SEND_ORIGIN) !== -1) {
      ok(
        "CSP connect-src allows " +
          analyticsProxy.UMAMI_SEND_ORIGIN +
          " (where the direct tracker POSTs)"
      );
    } else {
      fail(
        "CSP connect-src does not allow " + analyticsProxy.UMAMI_SEND_ORIGIN,
        "the direct route posts every pageview and event there. cloud.umami.is is only where " +
          "the script is DOWNLOADED from -- allowing just that loads the tracker and then blocks " +
          "all of its data. connect-src was: " +
          connectSrcMatch[1].trim()
      );
    }
    if (scriptSrcMatch[1].indexOf(analyticsProxy.UMAMI_SCRIPT_ORIGIN) !== -1) {
      ok(
        "CSP script-src allows " +
          analyticsProxy.UMAMI_SCRIPT_ORIGIN +
          " (the direct tracker copy, tried first)"
      );
    } else {
      fail(
        "CSP script-src does not allow " + analyticsProxy.UMAMI_SCRIPT_ORIGIN,
        "without it the direct copy never loads and every visitor falls back to the proxy at " +
          analyticsProxy.ANALYTICS_SCRIPT_PATH +
          ", where the session and country are Netlify's"
      );
    }
    [
      [connectSrcMatch, "connect-src", analyticsProxy.ANALYTICS_SEND_PATH],
      [scriptSrcMatch, "script-src", analyticsProxy.ANALYTICS_LOADER_PATH]
    ].forEach(function (triple) {
      if (triple[0][1].indexOf("'self'") !== -1) {
        ok("CSP " + triple[1] + " allows 'self', which serves " + triple[2]);
      } else {
        fail(
          "CSP " + triple[1] + " does not allow 'self'",
          triple[2] + " is served from this origin -- without 'self' the browser blocks it"
        );
      }
    });
  }
  // Regression guard: Google Translate was replaced with a self-hosted,
  // cookieless in-place client localization engine (assets/js/translator.js).
  // No external Google Translate origins or scripts are permitted in the CSP.
  if (!/translate\.google/i.test(cspText)) {
    ok("CSP has no leftover Google Translate references (self-hosted localization)");
  } else {
    fail(
      "CSP still references Google Translate",
      "expected Google Translate to be fully removed from CSP"
    );
  }
  // Regression guard: Snipcart was fully removed in favor of a same-origin
  // cart + Stripe Checkout (see docs/STRIPE-MIGRATION.md). Stripe's hosted
  // checkout page is reached via a top-level redirect, not a fetch/frame/
  // form-action from this origin, so it never needs a CSP entry -- if
  // "snipcart" ever reappears here, something regressed.
  if (!/snipcart/i.test(cspText)) ok("CSP has no leftover Snipcart references");
  else fail("CSP still references Snipcart", "expected Snipcart to be fully removed from the CSP");
}

/* ---------- 15) Live chat (Tawk.to) placeholder wired consistently ---------- */
section("Live chat (Tawk.to) placeholder present + identical on every page");
var TAWK_RE = /<script type="text\/javascript">\s*var Tawk_API[\s\S]*?<\/script>/;
var tawkTexts = {};
PAGES.forEach(function (page) {
  var full = path.join(ROOT, page);
  if (!fs.existsSync(full)) return;
  var html = fs.readFileSync(full, "utf8");
  var m = html.match(TAWK_RE);
  if (!m) {
    fail(page + ": Tawk.to placeholder script", "not found");
    return;
  }
  tawkTexts[page] = m[0];
  ok(page + ": Tawk.to placeholder script present");
});
var tawkUnique = Array.from(new Set(Object.values(tawkTexts)));
if (Object.keys(tawkTexts).length === PAGES.length && tawkUnique.length === 1) {
  ok("Tawk.to placeholder script is byte-identical across all " + PAGES.length + " pages");
} else if (Object.keys(tawkTexts).length === PAGES.length) {
  fail(
    "Tawk.to placeholder script text diverges between pages",
    "found " + tawkUnique.length + " distinct version(s) -- should be exactly 1"
  );
}

/* ---------- 16) The retired Gift Up! placeholder stays deleted ----------
   This section used to assert the OPPOSITE: that shop.html still carried a
   hidden #giftUpContainer holding the literal string YOUR_GIFTUP_ID. That
   was an unshipped integration for a service the shop replaced with its own
   Cloudflare Worker gift-card system, and it was live in production's DOM
   on every visit to /shop.html (audit C, nit N2). The gift-card feature it
   was supposedly guarding is asserted for real below -- the modal, the
   balance lookup and the Worker route -- so nothing stopped being checked
   when the dead node went. */
section("Retired Gift Up! placeholder is gone; the real gift-card path is wired");
(function () {
  var giftUpLeftovers = [];
  var allPagesForGiftUp = PAGES.slice();
  var giftUpProducts = path.join(ROOT, "products");
  if (fs.existsSync(giftUpProducts)) {
    fs.readdirSync(giftUpProducts)
      .filter(function (f) {
        return /\.html$/.test(f);
      })
      .forEach(function (f) {
        allPagesForGiftUp.push("products/" + f);
      });
  }
  if (allPagesForGiftUp.length < 30) {
    fail("Gift Up! sweep has almost nothing to scan", allPagesForGiftUp.length + " page(s)");
    return;
  }
  allPagesForGiftUp.forEach(function (rel) {
    var fp = path.join(ROOT, rel);
    if (!fs.existsSync(fp)) return;
    var text = fs.readFileSync(fp, "utf8");
    /* Comments explaining the removal are fine; a real element or the
       marker the generator used to fill are not. */
    if (/id="giftUpContainer"/.test(text) || /<!--YL:site\.giftUpId-->/.test(text)) {
      giftUpLeftovers.push(rel);
    }
  });
  if (giftUpLeftovers.length === 0) {
    ok("no page ships the retired #giftUpContainer / YL:site.giftUpId placeholder");
  } else {
    fail("retired Gift Up! placeholder is back in the DOM", giftUpLeftovers.join(", "));
  }
  /* The feature that replaced it, asserted so this section still has a
     subject: the shop's own gift-card modal and its balance lookup. */
  if (/id="giftCardModal"/.test(shopHtml)) ok("shop.html has the on-site #giftCardModal");
  else fail("shop.html", "#giftCardModal not found -- the gift-card section is missing");
  if (/id="tabCheckGiftCardBalance"/.test(shopHtml)) {
    ok("shop.html has the gift-card balance lookup tab");
  } else {
    fail("shop.html", "#tabCheckGiftCardBalance not found");
  }
})();

/* ---------- 17) Shop on-site search wired ---------- */
section("Shop on-site search wired");
var mainJsText = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
if (/id="shopSearch"/.test(shopHtml)) ok("shop.html has #shopSearch input");
else fail("shop.html", "#shopSearch input not found");
if (/getElementById\("shopSearch"\)/.test(mainJsText)) ok("main.js reads #shopSearch");
else
  fail(
    "main.js",
    "doesn't reference #shopSearch -- search box would be inert markup with no listener"
  );

/* ---------- 18) The site's ONE FAQ: schema well-formed, generated
   content matches it, and shop.html doesn't keep its own copy ----------
   There used to be three hand-typed copies of most of this (contact.html's
   FAQPage JSON-LD, contact.html's visible prose, and a separate shop.html
   accordion) -- collapsed down to a single "faq" array in products-data.js
   that build-site-data.js generates contact.html's JSON-LD + visible Q&A
   from. This checks the source data is well-formed, that both generated
   parts of contact.html are actually fresh (not edited by hand since the
   last build-data run), and that shop.html doesn't quietly grow its own
   duplicate again. */
section("Site FAQ (single source, no duplication)");
(function () {
  if (!FAQ.length) {
    fail("products-data.js CATALOG.faq", "no questions found");
    return;
  }
  var seenQuestions = {};
  FAQ.forEach(function (item, i) {
    var label = "faq[" + i + "]" + (item.question ? ' "' + item.question + '"' : "");
    var problems = [];
    if (!item.question || typeof item.question !== "string")
      problems.push("missing/invalid question");
    else if (seenQuestions[item.question]) problems.push("duplicate question");
    else seenQuestions[item.question] = true;
    if (!item.answer || typeof item.answer !== "string") problems.push("missing/invalid answer");
    if (!problems.length) ok(label + ": well-formed");
    else fail(label, problems.join("; "));
  });

  var faqHtml = fs.readFileSync(path.join(ROOT, "faq.html"), "utf8");

  // JSON-LD freshness: rebuild what it SHOULD say from FAQ and compare.
  var expectedLd = {
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
  var ldMatch = faqHtml.match(
    /<script type="application\/ld\+json">\n(\{\s*\n\s*"@context": "https:\/\/schema\.org",\s*\n\s*"@type": "FAQPage"[\s\S]*?\n)<\/script>/
  );
  if (!ldMatch) {
    fail("faq.html FAQPage JSON-LD", "block not found -- run npm run build-data");
  } else {
    try {
      var actualLd = JSON.parse(ldMatch[1]);
      if (JSON.stringify(actualLd) === JSON.stringify(expectedLd)) {
        ok(
          "faq.html FAQPage JSON-LD matches products-data.js's faq array (" +
            FAQ.length +
            " question(s))"
        );
      } else {
        fail(
          "faq.html FAQPage JSON-LD is stale",
          "doesn't match products-data.js's faq array -- run npm run build-data"
        );
      }
    } catch (e) {
      fail("faq.html FAQPage JSON-LD", "invalid JSON -- " + e.message);
    }
  }

  // Visible prose freshness: pull every <h2>question</h2><p>answer</p>
  // pair out of the FAQ:START/FAQ:END markers and compare to FAQ.
  var markerMatch = faqHtml.match(/<!-- FAQ:START[\s\S]*?-->\n([\s\S]*?)\n\s*<!-- FAQ:END -->/);
  if (!markerMatch) {
    fail("faq.html FAQ:START/FAQ:END markers", "not found -- run npm run build-data");
  } else {
    var itemRe = /<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/g;
    var m,
      visibleItems = [];
    while ((m = itemRe.exec(markerMatch[1]))) visibleItems.push({ q: m[1].trim(), a: m[2].trim() });
    var expectedItems = FAQ.map(function (item) {
      var escAnswer = escapeHtml(item.answer);
      var renderedAnswer = escAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      return { q: escapeHtml(item.question), a: renderedAnswer };
    });
    if (JSON.stringify(visibleItems) === JSON.stringify(expectedItems)) {
      ok("faq.html visible FAQ prose matches products-data.js's faq array");
    } else {
      fail(
        "faq.html visible FAQ prose is stale",
        "doesn't match products-data.js's faq array -- run npm run build-data"
      );
    }
  }

  // Milestone 3: shop.html carries an on-site FAQ accordion section (#shop-faq) synced from products-data.js
  if (/class="faq-accordion"/.test(shopHtml) && /href="faq\.html"/.test(shopHtml)) {
    ok("shop.html has on-site FAQ accordion (.faq-accordion) and links to full faq.html");
  } else {
    fail(
      "shop.html",
      "missing .faq-accordion or link to faq.html -- expected on-site FAQ section synced from products-data.js"
    );
  }
})();

/* ---------- 19) Bundle pricing sanity (recomputed straight from
   products-data.js, no generated artifact to go stale) ----------
   Bundle price used to live in a separately-generated snipcart-
   products.json manifest, which could drift out of sync with the real
   catalog if someone forgot to rebuild. That's gone now: main.js's
   bundlesHTML() computes each bundle's price live in the browser, every
   page load, straight from window.YL_PRODUCTS -- so there's no static
   snapshot left to freshness-check against. What's still worth catching
   here is a bundle whose discount formula produces a nonsensical price
   (zero, negative, or not actually cheaper than buying the items apart),
   which would ship a broken-looking price to the shop page. */
section("Bundle pricing sanity (recomputed from products-data.js)");
if (!BUNDLES.length) {
  console.log("  (no bundles defined -- nothing to sanity-check)");
} else {
  var PRODUCTS_BY_ID_QA = {};
  PRODUCTS.forEach(function (p) {
    PRODUCTS_BY_ID_QA[p.id] = p;
  });
  BUNDLES.forEach(function (b) {
    var missing = b.productIds.filter(function (id) {
      return !PRODUCTS_BY_ID_QA[id];
    });
    if (missing.length) return; // already reported as a failure in section 6b
    var fullPrice = b.productIds.reduce(function (sum, id) {
      var original = PRODUCTS_BY_ID_QA[id].originalPrice || PRODUCTS_BY_ID_QA[id].price;
      return sum + original;
    }, 0);
    var bundlePrice = Math.round(fullPrice * (1 - (b.discountPercent || 0) / 100) * 100) / 100;
    if (bundlePrice <= 0) {
      fail("bundle-" + b.id + ": computed price is not positive", "$" + bundlePrice);
    } else if (bundlePrice >= fullPrice) {
      fail(
        "bundle-" + b.id + ": computed price isn't actually a discount off the full price",
        "$" + bundlePrice.toFixed(2) + " >= $" + fullPrice.toFixed(2)
      );
    } else {
      ok(
        "bundle-" +
          b.id +
          ": computed price $" +
          bundlePrice.toFixed(2) +
          " (full $" +
          fullPrice.toFixed(2) +
          ") is sane"
      );
    }
  });
}

/* ---------- 20) products-data.js is a fresh, faithful generated mirror
   of products.json (data-flow-flip freshness check) ----------
   Since the CMS work this session, assets/data/products.json is the
   canonical, hand/CMS-edited source and assets/js/products-data.js is
   100% generated FROM it by build-site-data.js (previously the reverse
   direction) -- see that script's header comment. If someone hand-edits
   one without re-running the build, or a future refactor breaks the
   generation step, this catches it immediately rather than shipping a
   stale/divergent catalog to the live site. */
section("products-data.js matches assets/data/products.json (data-flow-flip freshness)");
var productsJsonPath = path.join(ROOT, "assets/data/products.json");
if (!fs.existsSync(productsJsonPath)) {
  fail("assets/data/products.json", "file missing");
} else {
  try {
    var canonicalCatalog = JSON.parse(fs.readFileSync(productsJsonPath, "utf8"));
    // Mirror build-site-data.js's sale baking (its "Process Products" step):
    // the generated catalog carries sale-adjusted price/originalPrice/sale
    // keys, so the raw source needs the same transform before deep-comparing.
    // Without this, any active entry in products.json's "sales" array makes
    // this check fail forever -- even immediately after `npm run build-data`.
    var qaSalesByCategory = {};
    (canonicalCatalog.sales || []).forEach(function (s) {
      qaSalesByCategory[s.category] = s;
    });
    (canonicalCatalog.products || []).forEach(function (p) {
      if (p.sale && p.sale.price) {
        p.originalPrice = p.price;
        p.price = p.sale.price;
      } else if (qaSalesByCategory[p.category]) {
        var qaCatSale = qaSalesByCategory[p.category];
        p.originalPrice = p.price;
        p.price = Math.round(p.price * (1 - qaCatSale.percentOff / 100) * 100) / 100;
        p.sale = { label: qaCatSale.label };
      }
    });
    var generatedCatalog = global.window.YL_PRODUCTS || {};
    if (JSON.stringify(generatedCatalog) === JSON.stringify(canonicalCatalog)) {
      ok(
        "assets/js/products-data.js's window.YL_PRODUCTS deep-equals a fresh parse of products.json"
      );
    } else {
      fail(
        "assets/js/products-data.js is stale",
        "doesn't match assets/data/products.json (the real canonical source, e.g. after an /admin edit) -- run npm run build-data"
      );
    }
  } catch (e) {
    fail("assets/data/products.json", "invalid JSON -- " + e.message);
  }
}

/* ---------- 21) admin/config.yml (Sveltia CMS) structural sanity ----------
   Deliberately regex/string-matched rather than parsed with a real YAML
   library: every other non-JSON config file this QA suite checks
   (netlify.toml, see section 10) is already validated the same
   lightweight way, and this project's build/QA scripts otherwise use
   zero external dependencies on purpose (see build-site-data.js's own
   header comment) -- adding a devDependency just for this one file would
   break that pattern for no real benefit, since config.yml's structure
   here is simple and stable enough for substring/regex checks. */
section("admin/config.yml (Sveltia CMS) structural sanity");
var configYmlPath = path.join(ROOT, "admin/config.yml");
if (!fs.existsSync(configYmlPath)) {
  fail("admin/config.yml", "file missing");
} else {
  var configYml = fs.readFileSync(configYmlPath, "utf8");

  if (/backend:\s*\n\s*name:\s*github\b/.test(configYml)) ok("backend.name is github");
  else
    fail(
      "admin/config.yml",
      'backend.name isn\'t "github" -- expected the GitHub backend (see DEVELOPMENT.md section 20)'
    );

  if (/repo:\s*YOUR_GITHUB_USERNAME\/YOUR_REPO_NAME/.test(configYml)) {
    console.log(
      "  (repo is still the YOUR_GITHUB_USERNAME/YOUR_REPO_NAME placeholder -- expected until a real GitHub repo exists, see DEVELOPMENT.md section 20)"
    );
  } else if (/repo:\s*[\w.-]+\/[\w.-]+/.test(configYml)) {
    ok("backend.repo has been set to a real-looking owner/repo");
  } else {
    fail("admin/config.yml", "backend.repo doesn't look like a valid owner/repo value");
  }

  if (/file:\s*assets\/data\/products\.json/.test(configYml))
    ok("file collection points at assets/data/products.json");
  else
    fail(
      "admin/config.yml",
      "doesn't reference assets/data/products.json -- the CMS wouldn't be editing the real catalog file"
    );

  if (
    /media_folder:\s*\/assets\/img/.test(configYml) &&
    /public_folder:\s*\/assets\/img/.test(configYml)
  ) {
    ok("media_folder/public_folder both point at /assets/img");
  } else {
    fail("admin/config.yml", "media_folder/public_folder aren't both /assets/img");
  }

  // Every real top-level key in each CMS-editable JSON file needs a
  // corresponding field defined in config.yml, or the CMS would silently
  // drop/hide that data the next time someone saves through the editor.
  // Originally only checked products.json -- widened to cover all 4 file
  // collections config.yml actually defines (see the "2. Markets... 3.
  // Customer Reviews... 4. Page Wording" comment near the top of that
  // file) after a swarm audit flagged events/reviews/content as unchecked.
  var journalPostFiles = fs.existsSync(path.join(ROOT, "assets/data/journal"))
    ? fs
        .readdirSync(path.join(ROOT, "assets/data/journal"))
        .filter(function (f) {
          return f.endsWith(".json");
        })
        .map(function (f) {
          return "assets/data/journal/" + f;
        })
    : [];
  if (!journalPostFiles.length) fail("assets/data/journal", "no journal post files found");
  [
    "assets/data/products.json",
    "assets/data/events.json",
    "assets/data/site-reviews.json",
    "assets/data/content.json",
    "assets/data/quiz.json",
    "assets/data/social-feed.json"
  ]
    .concat(journalPostFiles)
    .forEach(function (relPath) {
      var full = path.join(ROOT, relPath);
      if (!fs.existsSync(full)) return; // already reported missing in section 1 above
      try {
        var topLevelKeys = Object.keys(JSON.parse(fs.readFileSync(full, "utf8")));
        topLevelKeys.forEach(function (key) {
          var fieldRe = new RegExp("-\\s*\\{?\\s*name:\\s*" + key + "\\b");
          if (fieldRe.test(configYml))
            ok("config.yml defines a field for " + relPath + "'s \"" + key + '" key');
          else
            fail(
              "admin/config.yml",
              'no "- name: ' +
                key +
                '" field found -- ' +
                relPath +
                " has this top-level key but the CMS has no field for it"
            );
        });
      } catch (e) {
        /* already reported as a failure in section 1 ("Source data files") above */
      }
    });
}

/* ---------- 22) Admin CSP (/admin/*) stays in sync across all 3 header
   configs (mirrors section 10's check for the main-site CSP) ---------- */
section("Admin CSP (/admin/*) configs (_headers / vercel.json / netlify.toml)");
function extractHeadersFileAdminCSP() {
  var text = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
  var m = text.match(/\/admin\/\*\s*\n\s*Content-Security-Policy:\s*(.+)/);
  return m ? m[1].trim() : null;
}
function extractVercelAdminCSP() {
  var json = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  var rule = (json.headers || []).find(function (h) {
    return h.source === "/admin/(.*)";
  });
  var entry =
    rule &&
    (rule.headers || []).find(function (h) {
      return h.key === "Content-Security-Policy";
    });
  return entry ? entry.value : null;
}
function extractNetlifyAdminCSP() {
  var text = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  var section2 = text.split(/for\s*=\s*"\/admin\/\*"/)[1];
  if (!section2) return null;
  var m = section2.match(/Content-Security-Policy\s*=\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}
try {
  var adminCspHeaders = extractHeadersFileAdminCSP();
  var adminCspVercel = extractVercelAdminCSP();
  var adminCspNetlify = extractNetlifyAdminCSP();
  if (!adminCspHeaders || !adminCspVercel || !adminCspNetlify) {
    fail(
      "could not extract /admin/* CSP from all three files",
      "run npm run build-security-headers first"
    );
  } else if (adminCspHeaders === adminCspVercel && adminCspVercel === adminCspNetlify) {
    ok("_headers, vercel.json, and netlify.toml all carry the identical /admin/* CSP");
  } else {
    fail(
      "/admin/* CSP drift between header configs",
      "_headers " +
        (adminCspHeaders === adminCspVercel ? "==" : "!=") +
        " vercel.json, " +
        "vercel.json " +
        (adminCspVercel === adminCspNetlify ? "==" : "!=") +
        " netlify.toml -- run npm run build-security-headers to resync"
    );
  }
  if (adminCspHeaders && cspHeaders && adminCspHeaders === cspHeaders) {
    fail(
      "/admin/* CSP is identical to the main-site CSP",
      "expected a separate, more permissive-for-Sveltia policy -- see build-security-headers.js's adminCsp"
    );
  } else if (adminCspHeaders) {
    ok("/admin/* CSP is a distinct policy from the main site's CSP (not accidentally reused)");
  }
} catch (e) {
  fail("admin CSP sync check", e.message);
}

/* ---------- 23) Sveltia CMS static image integrations ---------- */
section("Sveltia CMS static image integrations");
try {
  var contentData = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
  );
  var manifestData = global.window.YL_IMAGES || {};

  var imageKeys = [
    { section: "site", key: "logoDesktop", required: true },
    { section: "site", key: "logoMobile", required: true },
    { section: "site", key: "ogImage", required: true },
    { section: "home", key: "heroImage", required: true },
    { section: "home", key: "featureImage", required: true },
    { section: "about", key: "bioImage", required: true },
    { section: "about", key: "secondaryImage", required: true },
    { section: "contact", key: "image", required: true },
    { section: "shop", key: "giftCardImage", required: true }
  ];

  imageKeys.forEach(function (spec) {
    var val = contentData[spec.section] && contentData[spec.section][spec.key];
    if (!val) {
      fail("content.json missing key " + spec.section + "." + spec.key);
      return;
    }
    var cleanPath = val.replace(/^\/+/, "");
    var fullPath = path.join(ROOT, cleanPath);
    if (!fs.existsSync(fullPath)) {
      fail(
        "CMS static image " +
          spec.section +
          "." +
          spec.key +
          " points to non-existent file: " +
          cleanPath
      );
    } else {
      ok("CMS static image " + spec.section + "." + spec.key + " exists: " + cleanPath);
    }

    if (spec.key !== "logoDesktop" && spec.key !== "logoMobile") {
      if (!manifestData[cleanPath]) {
        fail(
          "CMS static image " +
            spec.section +
            "." +
            spec.key +
            " (" +
            cleanPath +
            ") is missing from image-manifest.js"
        );
      } else {
        ok("CMS static image " + spec.section + "." + spec.key + " is optimized in manifest");
      }
    }
  });

  var pageWrappers = [
    { page: "index.html", marker: "YL:home.heroImage" },
    { page: "index.html", marker: "YL:home.featureImage" },
    { page: "about.html", marker: "YL:about.bioImage" },
    { page: "about.html", marker: "YL:about.secondaryImage" },
    { page: "contact.html", marker: "YL:contact.image" },
    { page: "shop.html", marker: "YL:shop.giftCardImage", isCss: true },
    { page: "assets/data/footer.html", marker: "YL:site.logoDesktop" }
  ];

  pageWrappers.forEach(function (spec) {
    var full = path.join(ROOT, spec.page);
    if (!fs.existsSync(full)) return;
    var html = fs.readFileSync(full, "utf8");
    if (spec.isCss) {
      var re = new RegExp("\\/\\*" + spec.marker.replace(".", "\\.") + "\\*\\/");
      if (!re.test(html)) {
        fail(spec.page + " is missing CSS wrapper comment for " + spec.marker);
      } else {
        ok(spec.page + " has CSS wrapper comment for " + spec.marker);
      }
    } else {
      var m = spec.marker.replace(".", "\\.");
      var reOpen = new RegExp("<!--" + m + "-->");
      var reClose = new RegExp("<!--/" + m + "-->");
      if (!reOpen.test(html) || !reClose.test(html)) {
        fail(spec.page + " is missing HTML wrapper comment for " + spec.marker);
      } else {
        ok(spec.page + " has HTML wrapper comments for " + spec.marker);
      }
    }
  });
} catch (e) {
  fail("Sveltia CMS static images checks failed", e.message);
}

/* ---------- 24) Service Worker (sw.js) offline cache list ---------- */
section("Service Worker (sw.js) cache asset resolution");
var swPath = path.join(ROOT, "sw.js");
if (!fs.existsSync(swPath)) {
  fail("sw.js", "missing file");
} else {
  var swText = fs.readFileSync(swPath, "utf8");
  var matchAssets = swText.match(/const ASSETS_TO_CACHE = \[([\s\S]*?)\];/);
  if (!matchAssets) {
    fail("sw.js", "ASSETS_TO_CACHE array not found");
  } else {
    /* Strip comments first. The array is annotated, and an apostrophe in a
       comment ("every visitor's install budget") otherwise parses as the
       start of a quoted entry and turns the whole block into nonsense
       paths -- a red gate for a real, correct precache list. */
    var assetsBody = matchAssets[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    var rawAssets = assetsBody.match(/'([^']+)'/g) || [];
    var missingSwAssets = [];
    rawAssets.forEach(function (quoted) {
      var assetPath = quoted.slice(1, -1);
      if (assetPath === "/") assetPath = "/index.html";
      var clean = assetPath.replace(/^\/+/, "");
      var full = path.join(ROOT, clean);
      if (!fs.existsSync(full)) missingSwAssets.push(assetPath);
    });
    if (!rawAssets.length) {
      /* The array was located but no entries parsed out of it -- a quoting
         change in sw.js would do that. Without this, "all 0 cached assets
         exist" passes while the precache list goes unchecked. */
      fail("sw.js: ASSETS_TO_CACHE entries parsed", "0 entries parsed from the array");
    } else if (!missingSwAssets.length) {
      ok("sw.js: all " + rawAssets.length + " cached assets exist on disk");
    } else {
      missingSwAssets.forEach(function (ma) {
        fail("sw.js cached asset missing on disk", ma);
      });
    }

    /* Existing on disk is not the same as fetchable from the host. The site's
       own not-found page exists as a file and is served with a 404 status --
       that is what makes it the not-found page -- so precaching it can only
       ever fail. On 2026-09-03 it was on this list and, under cache.addAll(),
       took the whole 50-asset batch down with it: production had precached
       nothing at all, /offline.html included, behind a swallowed console
       warning. Both halves of that are asserted here. */
    var precached = rawAssets.map(function (quoted) {
      return quoted.slice(1, -1);
    });
    if (precached.indexOf("/404.html") === -1) {
      ok("sw.js: the 404 page is not precached (the host serves it with a 404 status)");
    } else {
      fail(
        "sw.js ASSETS_TO_CACHE",
        "includes '/404.html', which the host answers 404 -- it can never be cached"
      );
    }
    if (precached.indexOf("/offline.html") !== -1) {
      ok("sw.js: /offline.html is precached (the page the worker serves with no network)");
    } else {
      fail("sw.js ASSETS_TO_CACHE", "lost '/offline.html' -- the offline fallback is never cached");
    }
    /* Comments stripped first -- the note in sw.js explaining why addAll() was
       abandoned names it, and a gate that trips on its own decision record is
       worse than no gate. */
    var swCode = swText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    if (/\.addAll\s*\(|\[\s*["']addAll["']\s*\]|\.addAll\s*\.\s*(call|apply)\b/.test(swCode)) {
      fail(
        "sw.js install strategy",
        "uses cache.addAll(), which is all-or-nothing: one URL the host answers " +
          "with a non-2xx status empties the entire precache"
      );
    } else {
      ok("sw.js: install precaches per asset, so one bad URL cannot empty the cache");
    }
  }
}

/* ---------- 25) Cloudflare Worker scripts (workers/*.js) structural sanity ---------- */
section("Cloudflare Workers code integrity (workers/*.js)");
var checkoutWorkerPath = path.join(ROOT, "workers/checkout.js");
if (!fs.existsSync(checkoutWorkerPath)) {
  fail("workers/checkout.js", "missing file");
} else {
  var checkoutText = fs.readFileSync(checkoutWorkerPath, "utf8");
  if (/export default\s*\{/.test(checkoutText))
    ok("workers/checkout.js: exports default worker object");
  else fail("workers/checkout.js", "missing export default");
  if (/Stripe-Version/.test(checkoutText))
    ok("workers/checkout.js: includes Stripe-Version header");
  else fail("workers/checkout.js", "missing Stripe-Version header");
  if (/SITE_ORIGIN/.test(checkoutText)) ok("workers/checkout.js: references SITE_ORIGIN in CORS");
  else fail("workers/checkout.js", "missing SITE_ORIGIN reference");
}

var submitWorkerPath = path.join(ROOT, "workers/submit-form.js");
if (!fs.existsSync(submitWorkerPath)) {
  fail("workers/submit-form.js", "missing file");
} else {
  var submitText = fs.readFileSync(submitWorkerPath, "utf8");
  if (/export default\s*\{/.test(submitText))
    ok("workers/submit-form.js: exports default worker object");
  else fail("workers/submit-form.js", "missing export default");
  if (/emailRegex/.test(submitText))
    ok("workers/submit-form.js: validates email format with regex");
  else fail("workers/submit-form.js", "missing email format validation");
}

/* ---------- 26) Worker money-path routes (workers/routes/*.js) integrity ----------
   The Netlify Functions this section used to check were retired: gift-card
   fulfilment, balance lookup, order status and restock all live in the
   Cloudflare Worker now (docs/STATE-LAYER.md). Nothing may remain under
   netlify/functions -- a file there would be deployed by Netlify as a second,
   unaudited copy of the money path. */
section("Worker money-path routes integrity (workers/routes/*.js)");
var retiredFunctionsDir = path.join(ROOT, "netlify/functions");
if (fs.existsSync(retiredFunctionsDir) && fs.readdirSync(retiredFunctionsDir).length) {
  fail(
    "netlify/functions is empty",
    "found " +
      fs.readdirSync(retiredFunctionsDir).join(", ") +
      " -- the money path moved to the Worker"
  );
} else {
  ok("netlify/functions carries no code (money path lives in workers/)");
}
["gift-cards", "stripe-webhook", "gift-card-balance", "order-status", "restock", "stripe"].forEach(
  function (routeName) {
    var routePath = path.join(ROOT, "workers/routes/" + routeName + ".js");
    if (fs.existsSync(routePath)) ok("workers/routes/" + routeName + ".js exists");
    else fail("workers/routes/" + routeName + ".js", "missing file");
  }
);
var giftCardRoutePath = path.join(ROOT, "workers/routes/gift-cards.js");
if (fs.existsSync(giftCardRoutePath)) {
  var giftCardRouteText = fs.readFileSync(giftCardRoutePath, "utf8");
  if (/crypto\.getRandomValues|randomGiftCardCode/.test(giftCardRouteText))
    ok("gift-cards.js: uses a CSPRNG for gift-card codes");
  else fail("workers/routes/gift-cards.js", "missing CSPRNG code generation");
  if (/X-Entity-Ref-ID|Idempotency-Key/.test(giftCardRouteText))
    ok("gift-cards.js: sets a Resend idempotency header on gift-card emails");
  else fail("workers/routes/gift-cards.js", "missing Resend idempotency header");
}

/* ---------- 27) Project documentation files integrity (docs/*.md) ---------- */
section("Project documentation integrity (docs/*.md)");
var docFiles = [
  "docs/DEVELOPMENT.md",
  "docs/EDITING-GUIDE.md",
  "docs/SELF-HOSTING-FONTS.md",
  "docs/STRIPE-MIGRATION.md"
];
docFiles.forEach(function (rel) {
  var full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(rel, "missing file");
    return;
  }
  var text = fs.readFileSync(full, "utf8");
  if (text.trim().length > 100 && /^#\s+/m.test(text))
    ok(rel + ": non-empty markdown doc with H1 heading");
  else fail(rel, "file empty or missing top-level H1 header");
});

/* ---------- 28) Feature Expansion R1-R4 integrity ---------- */
section("Feature Expansion R1-R4 DOM & logic integrity");

var indexHtmlText = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
var eventsHtmlText = fs.readFileSync(path.join(ROOT, "events.html"), "utf8");
if (/id="yl-countdown-ticker"/.test(indexHtmlText)) {
  ok("index.html contains #yl-countdown-ticker announcement bar");
} else {
  fail("index.html", "missing #yl-countdown-ticker element");
}
if (/id="eventsCountdownBanner"/.test(eventsHtmlText)) {
  ok("events.html contains #eventsCountdownBanner element");
} else {
  fail("events.html", "missing #eventsCountdownBanner element");
}

var thankYouHtmlText = fs.readFileSync(path.join(ROOT, "thank-you.html"), "utf8");
var shopHtmlText = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
if (
  /id="order-status-modal"/.test(thankYouHtmlText) &&
  /id="order-status-modal"/.test(shopHtmlText)
) {
  ok("thank-you.html and shop.html contain #order-status-modal dialog");
} else {
  fail("order-status-modal", "missing #order-status-modal on thank-you.html or shop.html");
}

/* Alt-Points are switched off end to end. Nothing ever credits them (the only
   balance was localStorage), and the redeem endpoint that used to mint a real
   Stripe coupon for anyone who asked now answers 410 (audit C-1). So the
   drawer no longer shows a points total, promises "you'll earn N", or offers a
   redeem button.

   This check used to require #cart-points-count to be present, which meant
   removing the dead UI turned the gate red -- a test arguing for keeping a
   feature that mints money for free. Inverted: the assertion is now that the
   redeem path stays gone until a real server-side ledger exists. */
var cartJsText = fs.readFileSync(path.join(ROOT, "assets/js/cart.js"), "utf8");
var redeemMarkup = /data-redeem-points/.test(cartJsText);
var redeemFetch = /fetch\s*\(\s*["'`][^"'`]*redeem-points/.test(cartJsText);
if (!redeemMarkup && !redeemFetch) {
  ok("cart.js ships no Alt-Points redeem button and never calls redeem-points");
} else {
  fail(
    "assets/js/cart.js re-introduces Alt-Points redemption",
    [
      redeemMarkup ? "data-redeem-points markup found" : null,
      redeemFetch ? "fetch() to redeem-points found" : null
    ]
      .filter(Boolean)
      .join("; ") + " -- redeem-points answers 410 and no ledger credits points"
  );
}

if (
  /id="apothecary-quiz-section"/.test(shopHtmlText) &&
  /id="quiz-submit-btn"/.test(shopHtmlText)
) {
  ok("shop.html contains #apothecary-quiz-section and #quiz-submit-btn");
} else {
  fail("shop.html", "missing #apothecary-quiz-section or #quiz-submit-btn");
}

/* ---------- Unit Test Suites ----------
   Deliberately NOT run from here any more. This file used to shell out to
   each scripts/*.test.js with stdio:"pipe" and collapse the result to a
   single ✓/✗ per suite, which threw away every assertion name and truncated
   the error to its first line -- a real failure reported itself as
   "node:internal/modules/cjs/loader:1386", which tells you nothing.
   scripts/run-unit-tests.js runs them with inherited stdio instead, and
   `npm test` runs it first, so the suites still gate every push -- once,
   with readable output, rather than twice with the second run mute. */

/* ---------- Feature switches are actually wired ----------
   Every boolean in content.json's `site` block is a switch shown to Savanna
   in /admin. Nine of them once did nothing at all: three were switches for
   features that had never been built, and the rest were read from a
   window.YL_CONTENT global that no page ever emitted. A dashboard toggle that
   silently does nothing is worse than no toggle, so assert that each one is
   referenced by something that can actually act on it. */
section("Every CMS feature switch is wired to real code");
(function checkFeatureFlagsWired() {
  var contentJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
  );
  var siteCfg = contentJson.site || {};
  var workerSources = (function () {
    var out = "";
    ["workers", "workers/routes", "workers/state"].forEach(function (dir) {
      var abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return;
      fs.readdirSync(abs).forEach(function (f) {
        if (f.endsWith(".js")) out += fs.readFileSync(path.join(abs, f), "utf8");
      });
    });
    return out;
  })();
  var haystack =
    ["assets/js/main.js", "assets/js/cart.js", "scripts/build-site-data.js"]
      .map(function (f) {
        var full = path.join(ROOT, f);
        return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
      })
      .join("\n") + workerSources;

  var flags = Object.keys(siteCfg).filter(function (k) {
    return k.indexOf("enable") === 0 && typeof siteCfg[k] === "boolean";
  });
  if (!flags.length) {
    fail("feature switches", "no enable* booleans found in content.json");
  }
  flags.forEach(function (flag) {
    if (haystack.indexOf(flag) !== -1) ok(flag + ": referenced by site code");
    else
      fail(
        flag + " is a dead switch",
        "exposed in the CMS but never read by main.js, cart.js or the build -- " +
          "either wire it up or remove it from admin/config.yml"
      );
  });

  // The reverse: the CMS must not offer switches that content.json doesn't have.
  var cmsPath = path.join(ROOT, "admin/config.yml");
  if (fs.existsSync(cmsPath)) {
    var cms = fs.readFileSync(cmsPath, "utf8");
    var cmsFlags = (cms.match(/name:\s*(enable[A-Z][A-Za-z0-9]*)/g) || []).map(function (m) {
      return m.replace(/name:\s*/, "");
    });
    var orphans = cmsFlags.filter(function (f) {
      return !(f in siteCfg);
    });
    if (!orphans.length) ok("no CMS switches missing from content.json");
    else fail("CMS switches with no config", orphans.join(", "));
  }
})();

/* ---------- CMS form endpoints actually reach the pages ----------
   Same rule as the switches above, for the three string fields that carry an
   integration endpoint. They live in an action="..." attribute, where a
   <!--YL:key--> marker can't survive the build's cleanAttributeMarkers()
   pass -- so for a while /admin offered "Newsletter Form Link (Kit)" and
   "Contact Form Code (Formspree)" while every page stayed pinned to the
   hardcoded placeholder, and main.js kept showing the "not connected yet"
   fallback no matter what was typed in. Assert the shipped attribute is the
   one build-site-data.js derives from content.json, so it can't drift back. */
section("CMS form endpoints (Kit / Formspree) reach the built pages");
(function checkFormEndpointsWired() {
  var builder = require(path.join(ROOT, "scripts/build-site-data.js"));
  var contentJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
  );
  var siteCfg = contentJson.site || {};
  var expectations = [
    {
      page: "index.html",
      className: "footer-signup-form",
      expected: builder.newsletterAction(siteCfg.kitFormAction, "YOUR_KIT_FORM_ACTION_URL"),
      field: "site.kitFormAction"
    },
    {
      page: "contact.html",
      className: "contact-form",
      expected: builder.formspreeAction(siteCfg.formspreeContactId, "YOUR_FORM_ID"),
      field: "site.formspreeContactId"
    },
    {
      page: "shop.html",
      className: "review-form",
      expected: builder.formspreeAction(siteCfg.formspreeReviewId, "YOUR_FORMSPREE_FORM_ID"),
      field: "site.formspreeReviewId"
    }
  ];
  expectations.forEach(function (spec) {
    var full = path.join(ROOT, spec.page);
    if (!fs.existsSync(full)) {
      fail(spec.page, "missing file");
      return;
    }
    var html = fs.readFileSync(full, "utf8");
    var tags = html.match(/<form\b[^>]*>/g) || [];
    var match = null;
    tags.forEach(function (tag) {
      var cls = /\sclass="([^"]*)"/.exec(tag);
      if (!cls || cls[1].trim().split(/\s+/).indexOf(spec.className) === -1) return;
      var act = /\saction="([^"]*)"/.exec(tag);
      if (act) match = act[1];
    });
    if (match === null) {
      fail(spec.page + " ." + spec.className, "no form with that class and an action attribute");
    } else if (match === spec.expected) {
      ok(spec.page + " ." + spec.className + " action follows " + spec.field);
    } else {
      fail(
        spec.page + " ." + spec.className + " action ignores " + spec.field,
        'shipped "' + match + '" but content.json resolves to "' + spec.expected + '"'
      );
    }
  });
})();

/* ---------- HTML container-tag balance (regression guard) ----------
   Real bug this caught: shop.html's <div class="page-hero"> was never
   closed, so it wrapped the ENTIRE page instead of just the intro. That
   silently pulled every section on the page under the
   `.page-hero .container > * { max-width: 960px }` rule, capping the quiz,
   product grid and reviews at 960px and pinning them left -- the hero
   element measured 12,137px of a 12,937px page. <section id="reviews"> was
   unclosed too.

   Nothing caught it: browsers auto-correct unbalanced nesting rather than
   erroring, so the page still "worked" and only looked subtly wrong. This
   walks a tag stack over every page and fails on any container element that
   is never closed, closed out of order, or closed without being opened.

   Script/style bodies and comments are blanked out first (newlines kept so
   reported line numbers stay accurate) -- otherwise a "<div>" inside a JS
   string or a commented-out block counts as a real tag, which is exactly
   the false positive that made a naive open-vs-close count useless here. */
section("HTML container-tag balance (no unclosed/mismatched elements)");
(function checkTagBalance() {
  var VOID = [
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr"
  ];
  var TRACK = [
    "div",
    "section",
    "main",
    "header",
    "footer",
    "form",
    "dialog",
    "article",
    "nav",
    "ul",
    "ol",
    "li",
    "picture",
    "table",
    "figure"
  ];
  var blank = function (s) {
    return s.replace(/[^\n]/g, " ");
  };
  PAGES.forEach(function (page) {
    var full = path.join(ROOT, page);
    if (!fs.existsSync(full)) return;
    var raw = fs
      .readFileSync(full, "utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, blank)
      .replace(/<style[\s\S]*?<\/style>/gi, blank)
      .replace(/<!--[\s\S]*?-->/g, blank);
    var stack = [];
    var problems = [];
    var re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var closing = m[1] === "/";
      var tag = m[2].toLowerCase();
      var attrs = m[3] || "";
      if (TRACK.indexOf(tag) === -1) continue;
      if (VOID.indexOf(tag) !== -1 || attrs.trim().slice(-1) === "/") continue;
      var line = raw.slice(0, m.index).split("\n").length;
      if (!closing) {
        stack.push({ tag: tag, line: line });
        continue;
      }
      var i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i === -1) {
        problems.push("stray </" + tag + "> at line " + line);
        continue;
      }
      for (var j = stack.length - 1; j > i; j--) {
        problems.push("<" + stack[j].tag + "> opened at line " + stack[j].line + " never closed");
      }
      stack.length = i;
    }
    stack.forEach(function (s) {
      problems.push("<" + s.tag + "> opened at line " + s.line + " never closed");
    });
    if (!problems.length) ok(page + ": container tags balanced");
    else fail(page + ": unbalanced HTML", problems.slice(0, 3).join("; "));
  });
})();

/* ---------- 13) Milestone 3: FAQ Accordion & Post-Purchase Review Prompt ---------- */
section("Milestone 3: FAQ Accordion & Post-Purchase Review Prompt");
try {
  var shopHtmlContent = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
  if (
    shopHtmlContent.indexOf('id="shop-faq"') !== -1 &&
    shopHtmlContent.indexOf("<!-- SHOP_FAQ:START -->") !== -1 &&
    shopHtmlContent.indexOf("<!-- SHOP_FAQ:END -->") !== -1
  ) {
    ok("shop.html contains #shop-faq section with build markers");
  } else {
    fail("shop.html missing #shop-faq or SHOP_FAQ build markers");
  }

  var faqItemCount = (shopHtmlContent.match(/class="faq-accordion-item"/g) || []).length;
  if (faqItemCount >= 3) {
    ok("shop.html contains " + faqItemCount + " synced FAQ accordion items");
  } else {
    fail("shop.html FAQ accordion has fewer than 3 items (" + faqItemCount + " found)");
  }

  var thankYouHtmlContent = fs.readFileSync(path.join(ROOT, "thank-you.html"), "utf8");
  if (
    thankYouHtmlContent.indexOf('id="post-purchase-review"') !== -1 &&
    thankYouHtmlContent.indexOf("review-prompt-card") !== -1
  ) {
    ok("thank-you.html contains #post-purchase-review section");
  } else {
    fail("thank-you.html missing #post-purchase-review section");
  }

  var hasSiteReviewCta = thankYouHtmlContent.indexOf('href="shop.html#reviews"') !== -1;
  var hasEtsyReviewCta = /href="https:\/\/www\.etsy\.com\/shop\/YallternativeLivinCO[^"]*"/.test(
    thankYouHtmlContent
  );
  if (hasSiteReviewCta && hasEtsyReviewCta) {
    ok("thank-you.html contains dual CTAs (Write A Review On Our Site & Review On Etsy)");
  } else {
    fail(
      "thank-you.html missing dual review CTAs",
      "Site CTA: " + hasSiteReviewCta + ", Etsy CTA: " + hasEtsyReviewCta
    );
  }

  var requiredCssClasses = [
    ".shop-faq-section",
    ".faq-accordion",
    ".faq-accordion-item",
    ".faq-accordion-summary",
    ".faq-accordion-content",
    ".review-prompt-section",
    ".review-prompt-card",
    ".review-prompt-actions"
  ];
  var cssText = fs.readFileSync(path.join(ROOT, "assets/css/styles.css"), "utf8");
  var missingCss = requiredCssClasses.filter(function (cls) {
    return cssText.indexOf(cls) === -1;
  });
  if (!missingCss.length) {
    ok("styles.css contains all Milestone 3 required CSS classes");
  } else {
    fail("styles.css missing required CSS classes", missingCss.join(", "));
  }
} catch (e) {
  fail("Milestone 3 verification", e.message);
}

/* ---------- 2026 SOTA Architecture Verification ---------- */
section("2026 SOTA Modules & Serverless Endpoints");
try {
  var hasStoreProxy = fs.existsSync(path.join(ROOT, "assets/js/modules/store-proxy.js"));
  var hasUgcFeedModule = fs.existsSync(path.join(ROOT, "assets/js/modules/ugc-feed.js"));
  var hasRestockModalModule = fs.existsSync(path.join(ROOT, "assets/js/modules/restock-modal.js"));

  if (hasStoreProxy && hasUgcFeedModule && hasRestockModalModule) {
    ok("assets/js/modules contains store-proxy, ugc-feed, and restock-modal JS modules");
  } else {
    fail("Missing one or more SOTA JS modules in assets/js/modules");
  }

  var hasWorkerRestockRoute = fs.existsSync(path.join(ROOT, "workers/routes/restock.js"));
  if (hasWorkerRestockRoute) {
    ok("workers/routes/restock.js exists for first-party restock handling (/api/restock)");
  } else {
    fail("workers/routes/restock.js missing");
  }

  var hasSyncSocialFeedScript = fs.existsSync(path.join(ROOT, "scripts/sync-social-feed.js"));
  if (hasSyncSocialFeedScript) {
    ok("scripts/sync-social-feed.js exists for build-time UGC feed verification");
  } else {
    fail("scripts/sync-social-feed.js missing");
  }
} catch (e) {
  fail("2026 SOTA architecture verification", e.message);
}

/* ---------- 20) Lockfile hygiene ----------
   Netlify picks the package manager by which lockfile it finds, and it
   installs dependencies with --frozen-lockfile. A second, unmaintained
   lockfile therefore quietly becomes the one that decides production
   deploys: pnpm-lock.yaml sat here months out of date while every human
   and every CI workflow ran npm, so the commit that dropped two unused
   dependencies updated package-lock.json, left pnpm-lock.yaml stale, and
   broke every Netlify deploy from that day on -- with the site's own test
   suite still passing green the whole time. One lockfile, kept in step
   with package.json. */
section("Lockfile hygiene (one package manager, in sync with package.json)");
try {
  var rivalLockfiles = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"].filter(function (f) {
    return fs.existsSync(path.join(ROOT, f));
  });
  if (!fs.existsSync(path.join(ROOT, "package-lock.json"))) {
    fail(
      "package-lock.json exists",
      "npm is this project's package manager (see .github/workflows)"
    );
  } else if (rivalLockfiles.length) {
    fail(
      "package-lock.json is the only lockfile",
      "also found " +
        rivalLockfiles.join(", ") +
        " -- a deploy host will install from that one instead"
    );
  } else {
    ok("package-lock.json is the only lockfile");
  }

  var pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  var lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  var declared = Object.assign({}, pkgJson.dependencies, pkgJson.devDependencies);
  // The lockfile mirrors package.json's own dependency block under the ""
  // (root) importer. Comparing the two catches a hand-edited package.json
  // that nobody re-ran `npm install` after.
  var lockRoot = (lockJson.packages && lockJson.packages[""]) || {};
  var lockDeclared = Object.assign({}, lockRoot.dependencies, lockRoot.devDependencies);
  var drift = [];
  Object.keys(declared).forEach(function (name) {
    if (lockDeclared[name] !== declared[name]) {
      drift.push(
        name +
          " (package.json " +
          declared[name] +
          ", lock " +
          (lockDeclared[name] || "absent") +
          ")"
      );
    }
  });
  Object.keys(lockDeclared).forEach(function (name) {
    if (!(name in declared)) drift.push(name + " (in lock, removed from package.json)");
  });
  if (drift.length) {
    fail("package-lock.json matches package.json", drift.join("; ") + " -- run `npm install`");
  } else {
    ok("package-lock.json matches package.json's declared dependencies");
  }
} catch (e) {
  fail("lockfile hygiene", e.message);
}

/* ---------- 21) Checkout proxy actually points at the Worker ----------
   The cart POSTs to a same-origin path; Netlify proxies that path to the
   Cloudflare Worker that answers it. Three files have to agree on it --
   assets/js/cart.js (the path it calls), build-security-headers.js (the
   generator that emits the rule) and netlify.toml (the generated output).
   A mismatch has no visible symptom until a real shopper clicks Checkout and
   gets a 404, so it gets asserted rather than trusted. */
/* ---------- Deploy build needs devDependencies ----------
   scripts/optimize-images.js runs first in the deploy command and is the
   only build step that requires an npm package (sharp, a devDependency).
   If a deploy config ever asks for the optimizer without also guaranteeing
   devDependencies get installed, brand-new photos silently ship full-size.
   The script itself degrades rather than failing the build, which is what
   makes the regression silent -- so assert the pairing here instead. */
section("Deploy config installs devDependencies for the image optimizer");
try {
  var netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  /* Read the build command itself, not the whole file. A bare
     indexOf("optimize-images.js") is satisfied by any comment that merely
     mentions the script -- including the one this file's own generator writes
     above [build.environment] -- so it would pass on a config whose build
     command had lost the optimizer entirely. */
  var buildCommandMatch = /^\s*command\s*=\s*"([^"]*)"/m.exec(netlifyToml);
  var buildCommand = buildCommandMatch ? buildCommandMatch[1] : "";
  if (!buildCommandMatch) {
    fail("netlify.toml declares a [build] command", 'no command = "..." line found');
  } else if (buildCommand.indexOf("optimize-images.js") === -1) {
    /* This branch used to pass, on the reasoning that a build with no image
       optimizer has no devDependency to guarantee. That let the guard switch
       itself off exactly when it mattered: scripts/build-security-headers.js
       regenerates netlify.toml, its template had dropped optimize-images.js,
       and so running the documented pipeline step took image optimization off
       the deploy while this check still reported green. The optimizer is
       supposed to be in the build -- its absence is the failure. */
    fail(
      "netlify.toml runs the image optimizer",
      "optimize-images.js is missing from the build command, so new photos " +
        "deploy without AVIF/WebP variants"
    );
  } else if (/NPM_FLAGS\s*=\s*"[^"]*--include=dev/.test(netlifyToml)) {
    ok("netlify.toml runs the image optimizer and asks npm for devDependencies");
  } else {
    fail(
      'netlify.toml runs optimize-images.js without NPM_FLAGS="--include=dev"',
      "sharp is a devDependency -- without this, a host that skips devDependencies " +
        "ships new photos unoptimized"
    );
  }
} catch (e) {
  fail("netlify.toml devDependency check", e.message);
}

section("Checkout proxy (cart.js -> netlify.toml -> Cloudflare Worker)");
try {
  var cartSrc = fs.readFileSync(path.join(ROOT, "assets/js/cart.js"), "utf8");
  var cartMatch = cartSrc.match(/CHECKOUT_URL\s*=\s*"([^"]+)"/);
  var netlifySrc = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  // The Worker answers every /api/* route, so the proxy is a wildcard rule.
  // Find THAT block (the retired-function 410 rules come first in the file).
  var redirectMatch = netlifySrc.match(
    /\[\[redirects\]\]\s*\n\s*from\s*=\s*"(\/api\/\*)"[\s\S]*?to\s*=\s*"([^"]+)"[\s\S]*?status\s*=\s*(\d+)/
  );

  if (!cartMatch) {
    fail("cart.js declares a CHECKOUT_URL");
  } else if (!redirectMatch) {
    fail("netlify.toml has a [[redirects]] rule for /api/*", "none found");
  } else {
    var proxyPrefix = redirectMatch[1].replace(/\*$/, "");
    if (cartMatch[1].indexOf(proxyPrefix) === 0) {
      ok(
        "netlify.toml proxies the prefix cart.js posts under (" +
          cartMatch[1] +
          " via " +
          redirectMatch[1] +
          ")"
      );
    } else {
      fail(
        "netlify.toml proxy prefix covers cart.js CHECKOUT_URL",
        "cart.js posts to " + cartMatch[1] + ", netlify.toml proxies " + redirectMatch[1]
      );
    }

    // status 200 is a proxy; 301/302 would send the browser cross-origin to
    // workers.dev, where the CSP's connect-src 'self' blocks it and the POST
    // body is dropped on the redirect.
    if (redirectMatch[3] === "200") {
      ok("checkout rule is a proxy (status 200), not a redirect");
    } else {
      fail("checkout rule is a proxy (status 200)", "found status " + redirectMatch[3]);
    }

    // :splat forwards the matched remainder (/checkout, /gift-card-balance,
    // ...) to the Worker, which accepts paths with or without the /api prefix.
    if (/^https:\/\/[^/]+\.workers\.dev\/:splat$/.test(redirectMatch[2])) {
      ok("API proxy targets a Cloudflare workers.dev host over https and forwards :splat");
    } else {
      fail(
        "API proxy targets a workers.dev host over https with :splat",
        "found " + redirectMatch[2]
      );
    }
  }
} catch (e) {
  fail("checkout proxy wiring", e.message);
}

/* ---------- Feature flags: content.json stays the single source of truth ----------
   The build injects `YL:site.KEY` markers into HTML pages only -- never into
   assets/js/*.js -- so a flag literal baked into main.js is a second source of
   truth that content.json cannot correct. enableJournal drifted exactly that
   way: flipping it in /admin moved the nav link, sitemap.xml and the robots
   tag while main.js kept its own stale `false`, leaving a half-enabled
   Journal. Any flag main.js consumes must therefore read the live value from
   window.YL_CONTENT, keeping the literal only as a fallback. */
section("Feature flags (main.js reads content.json, not a baked-in literal)");
try {
  var mainJsSrc = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
  var flagMarkers = mainJsSrc.match(/\/\*YL:site\.([a-zA-Z0-9]+)\*\//g) || [];
  var seenFlags = [];
  flagMarkers.forEach(function (marker) {
    var key = marker.replace("/*YL:site.", "").replace("*/", "");
    if (seenFlags.indexOf(key) !== -1) return;
    seenFlags.push(key);
    if (mainJsSrc.indexOf("window.YL_CONTENT.site." + key) !== -1) {
      ok("main.js reads " + key + " from YL_CONTENT (literal is only a fallback)");
    } else {
      fail(
        "main.js reads " + key + " from YL_CONTENT",
        "only the baked-in literal is used, so content.json cannot change it"
      );
    }
  });
  if (!seenFlags.length) {
    fail("feature flag markers found in main.js", "expected at least one YL:site marker");
  }
} catch (e) {
  fail("feature flag single-source-of-truth check", e.message);
}

/* ---------- Welcome page script integrity ---------- */
section("Welcome page script integrity");
try {
  var welcomeHtmlSrc = fs.readFileSync(path.join(ROOT, "welcome.html"), "utf8");
  if (welcomeHtmlSrc.indexOf("thank-you.js") === -1) {
    ok("welcome.html does not load thank-you.js (preventing premature purchase attribution)");
  } else {
    fail(
      "welcome.html does not load thank-you.js",
      "found thank-you.js reference in welcome.html which would trigger false purchase conversions"
    );
  }
} catch (e) {
  fail("welcome.html script integrity check", e.message);
}

/* ---------- Milestone 6: Order Status & Fulfillment Packing Slip (R6) ---------- */
section("Milestone 6: Order Status & Printable Fulfillment Packing Slip (R6)");
try {
  var orderStatusHtmlSrc = fs.readFileSync(path.join(ROOT, "order-status.html"), "utf8");
  if (
    orderStatusHtmlSrc.indexOf('id="orderStatusPageForm"') !== -1 &&
    orderStatusHtmlSrc.indexOf('id="orderQueryInput"') !== -1
  ) {
    ok("order-status.html contains #orderStatusPageForm and #orderQueryInput");
  } else {
    fail("order-status.html lookup form", "missing #orderStatusPageForm or #orderQueryInput");
  }

  if (orderStatusHtmlSrc.indexOf('id="orderTimelineContainer"') !== -1) {
    ok("order-status.html contains #orderTimelineContainer");
  } else {
    fail("order-status.html progression timeline", "missing #orderTimelineContainer");
  }

  // Audit H-6: the page used to render a fabricated order (timeline, item
  // rows, a reorder button that added invented items to the cart, and a
  // printable packing slip) for any input. None of that may come back.
  [
    'id="reorderPastOrderBtn"',
    'id="printPackingSlipBtn"',
    'id="packingSlipContainer"',
    'class="packing-slip-table"',
    'id="slipItemsTableBody"',
    'id="order-verify-input"',
    "onclick="
  ].forEach(function (marker) {
    if (orderStatusHtmlSrc.indexOf(marker) === -1) {
      ok("order-status.html carries no fabricated-order markup: " + marker);
    } else {
      fail("order-status.html fabricated-order markup (H-6)", "found " + marker);
    }
  });

  if (orderStatusHtmlSrc.indexOf('id="slipItemsTableBody"') !== -1) {
    var tableBodyIdx = orderStatusHtmlSrc.indexOf('id="slipItemsTableBody"');
    var tableBodySlice = orderStatusHtmlSrc.substring(tableBodyIdx, tableBodyIdx + 800);
    if (tableBodySlice.indexOf("$") === -1) {
      ok("order-status.html template packing table contains strictly ZERO currency symbols ($)");
    } else {
      fail(
        "order-status.html template packing table",
        "contains price currency symbol ($), violating packing slip gift privacy invariant"
      );
    }
  }

  // The packing slip, the fabricated order card and the URL-parameter gift
  // certificate are gone from the markup (H-6); their stylesheet rules went
  // with them so they cannot quietly come back styled.
  var stylesCssSrc = fs.readFileSync(path.join(ROOT, "assets/css/styles.css"), "utf8");
  [".packing-slip-", ".order-status-card", ".reorder-past-order-btn", ".gift-cert-"].forEach(
    function (deadSelector) {
      if (stylesCssSrc.indexOf(deadSelector) === -1) {
        ok("styles.css carries no rules for retired markup: " + deadSelector);
      } else {
        fail("styles.css retired-markup rules (H-6)", "still defines " + deadSelector);
      }
    }
  );
} catch (e) {
  fail("Milestone 6 QA assertions", e.message);
}

/* ---------- Global Search Suite Markup, Data Index & Invariants ---------- */
section("Global Search Suite (2026 SOTA) Static QA");
try {
  var searchDataPath = path.join(ROOT, "assets/js/search-data.js");
  if (fs.existsSync(searchDataPath)) {
    var searchDataSrc = fs.readFileSync(searchDataPath, "utf8");
    if (searchDataSrc.indexOf("window.YL_SEARCH_INDEX =") !== -1) {
      ok("assets/js/search-data.js exists and initializes window.YL_SEARCH_INDEX");
    } else {
      fail("assets/js/search-data.js", "missing window.YL_SEARCH_INDEX assignment");
    }
  } else {
    fail("assets/js/search-data.js", "file not found on disk");
  }

  var swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  if (swSrc.indexOf("'/assets/js/search-data.js'") !== -1) {
    ok("sw.js ASSETS_TO_CACHE includes '/assets/js/search-data.js'");
  } else {
    fail("sw.js caching", "missing '/assets/js/search-data.js' in cache asset list");
  }

  var allPagesToVerify = PAGES.map(function (p) {
    return path.join(ROOT, p);
  });
  var productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir).forEach(function (f) {
      if (f.endsWith(".html")) {
        allPagesToVerify.push(path.join(productsDir, f));
      }
    });
  }

  var missingTriggers = [];
  var missingModals = [];
  var missingScripts = [];
  var emojiViolations = [];
  var emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  allPagesToVerify.forEach(function (filePath) {
    var relPath = path.relative(ROOT, filePath);
    var htmlContent = fs.readFileSync(filePath, "utf8");

    if (
      htmlContent.indexOf('id="globalSearchTrigger"') === -1 ||
      htmlContent.indexOf('aria-controls="global-search-modal"') === -1
    ) {
      missingTriggers.push(relPath);
    }

    if (
      htmlContent.indexOf('id="global-search-modal"') === -1 ||
      htmlContent.indexOf('id="globalSearchInput"') === -1 ||
      htmlContent.indexOf('id="globalSearchResultsList"') === -1 ||
      htmlContent.indexOf('id="globalSearchResultCount"') === -1
    ) {
      missingModals.push(relPath);
    }

    if (htmlContent.indexOf("search-data.js") === -1) {
      missingScripts.push(relPath);
    }

    var modalStart = htmlContent.indexOf('id="global-search-modal"');
    if (modalStart !== -1) {
      var modalEnd = htmlContent.indexOf("</dialog>", modalStart);
      if (modalEnd !== -1) {
        var modalSlice = htmlContent.substring(modalStart, modalEnd);
        if (emojiRegex.test(modalSlice)) {
          emojiViolations.push(relPath);
        }
      }
    }
  });

  if (missingTriggers.length === 0) {
    ok(
      "All " +
        allPagesToVerify.length +
        " pages contain #globalSearchTrigger with aria-controls contract"
    );
  } else {
    fail(
      "Pages missing #globalSearchTrigger",
      missingTriggers.slice(0, 5).join(", ") +
        (missingTriggers.length > 5 ? " and " + (missingTriggers.length - 5) + " more" : "")
    );
  }

  if (missingModals.length === 0) {
    ok(
      "All " +
        allPagesToVerify.length +
        ' pages contain <dialog id="global-search-modal"> with complete DOM contract'
    );
  } else {
    fail(
      "Pages missing #global-search-modal",
      missingModals.slice(0, 5).join(", ") +
        (missingModals.length > 5 ? " and " + (missingModals.length - 5) + " more" : "")
    );
  }

  if (missingScripts.length === 0) {
    ok("All " + allPagesToVerify.length + " pages include search-data.js script tag");
  } else {
    fail(
      "Pages missing search-data.js script",
      missingScripts.slice(0, 5).join(", ") +
        (missingScripts.length > 5 ? " and " + (missingScripts.length - 5) + " more" : "")
    );
  }

  if (emojiViolations.length === 0) {
    ok(
      "Zero system emojis in search modal across all " +
        allPagesToVerify.length +
        " pages (100% monoline SVGs)"
    );
  } else {
    fail("Search modal system emoji violations found in", emojiViolations.slice(0, 5).join(", "));
  }
} catch (e) {
  fail("Global Search Suite QA assertions", e.message);
}

/* ---------- Structured data: real product pages + shop.html ItemList (R5) ----------
   Reversed on 2026-09-01. The products/*.html pages used to be "doorways":
   noindex, canonical to shop.html, no JSON-LD, and a redirect on load
   (audit H-15), with the whole catalogue's Product/Offer payload on
   shop.html's ItemList. Google's product rich results and merchant listings
   only support pages focused on a single product and exclude noindex pages,
   so that arrangement could never earn them. Product pages are now real,
   indexable, self-canonical pages carrying their own Product + Breadcrumb
   JSON-LD; shop.html keeps its ItemList (linking to the product URLs) as the
   category page.

   This section asserts both halves: every PDP is indexable, self-canonical,
   redirect-free and carries parseable Product + BreadcrumbList schema; and
   shop.html's ItemList still carries one priced, availability-bearing offer
   per product pointing at the product page. */
section("Structured data: indexable product pages + shop.html ItemList (R5)");
try {
  var pdpFiles = fs.readdirSync(path.join(ROOT, "products")).filter(function (f) {
    return f.endsWith(".html");
  });

  if (pdpFiles.length === 0) {
    fail("PDP HTML files", "No products/*.html files found -- run npm run build-data");
  } else {
    ok("Found " + pdpFiles.length + " PDP HTML files in products/ directory");
  }

  PRODUCTS.forEach(function (prod) {
    var prodHtmlPath = path.join(ROOT, "products", prod.id + ".html");
    if (!fs.existsSync(prodHtmlPath)) {
      fail("PDP file missing for " + prod.id, "products/" + prod.id + ".html does not exist");
      return;
    }

    var html = fs.readFileSync(prodHtmlPath, "utf8");

    // 1. Indexable: no noindex, no redirect away from the page.
    if (/<meta name="robots" content="[^"]*noindex/.test(html)) {
      fail(prod.id + ": PDP must not be noindex", "product pages are the canonical destination");
    } else if (html.indexOf("window.location.replace") !== -1) {
      fail(prod.id + ": PDP must not redirect on load", "the doorway redirect is back");
    } else {
      ok(prod.id + ": PDP is indexable and does not redirect");
    }

    // 2. ...and canonicalises to itself.
    var selfCanonical =
      '<link rel="canonical" href="https://yallternativeliving.com/products/' + prod.id + '.html">';
    if (html.indexOf(selfCanonical) !== -1) {
      ok(prod.id + ": PDP canonical points at itself");
    } else {
      fail(
        prod.id + ": PDP canonical must point at the product page",
        (html.match(/<link rel="canonical"[^>]*>/) || ["no canonical at all"])[0]
      );
    }

    // 3. Product + BreadcrumbList JSON-LD that parses and prices the product.
    var blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    var pdpLd = [];
    blocks.forEach(function (b) {
      try {
        pdpLd.push(
          JSON.parse(
            b
              .replace(/^<script[^>]*>/, "")
              .replace(/<\/script>$/, "")
              .trim()
          )
        );
      } catch (err) {
        fail(prod.id + ": PDP JSON-LD block does not parse", err.message);
      }
    });
    var productLd = pdpLd.find(function (ld) {
      return ld["@type"] === "Product";
    });
    var crumbLd = pdpLd.find(function (ld) {
      return ld["@type"] === "BreadcrumbList";
    });
    if (!productLd) {
      fail(prod.id + ": PDP must carry Product JSON-LD", blocks.length + " block(s) found");
    } else {
      var pdpOffers = productLd.offers || {};
      var pdpPriceOk =
        (pdpOffers["@type"] === "Offer" && typeof pdpOffers.price === "string") ||
        (pdpOffers["@type"] === "AggregateOffer" && typeof pdpOffers.lowPrice === "string");
      var pdpUrlOk =
        productLd.url === "https://yallternativeliving.com/products/" + prod.id + ".html";
      var digital = prod.id === "yallternative-gift-card";
      var shippingOk = digital
        ? !pdpOffers.shippingDetails && !pdpOffers.hasMerchantReturnPolicy
        : Array.isArray(pdpOffers.shippingDetails) && !!pdpOffers.hasMerchantReturnPolicy;
      if (pdpPriceOk && pdpUrlOk && pdpOffers.availability && shippingOk) {
        ok(prod.id + ": PDP Product JSON-LD has a priced offer, availability and its own URL");
      } else {
        fail(
          prod.id + ": PDP Product JSON-LD incomplete",
          JSON.stringify({
            url: productLd.url,
            offerType: pdpOffers["@type"],
            availability: pdpOffers.availability,
            shippingOk: shippingOk
          })
        );
      }
    }
    if (crumbLd) {
      ok(prod.id + ": PDP carries BreadcrumbList JSON-LD");
    } else {
      fail(prod.id + ": PDP must carry BreadcrumbList JSON-LD", "none found");
    }

    // 4. The visible breadcrumb still has to work for a human who lands here.
    //    Category and product anchors are plain ids now (shop.html#salves,
    //    shop.html#frankincense-salve); the old "#category-" prefix pointed at
    //    an anchor nothing on shop.html ever handled.
    var visibleBreadcrumbMatch = html.match(/<p class="breadcrumb">([\s\S]*?)<\/p>/);
    if (!visibleBreadcrumbMatch) {
      fail(prod.id + ": Visible breadcrumb element", 'Missing <p class="breadcrumb">');
    } else {
      var crumbHtml = visibleBreadcrumbMatch[1];
      var hasHome = crumbHtml.indexOf('<a href="../index.html">Home</a>') !== -1;
      var hasShop = crumbHtml.indexOf('<a href="../shop.html">Shop</a>') !== -1;
      var hasCategory = crumbHtml.indexOf('href="../shop.html#' + prod.category + '"') !== -1;
      var hasProdName = crumbHtml.indexOf(escapeHtml(prod.name)) !== -1;

      if (hasHome && hasShop && hasCategory && hasProdName) {
        ok(
          prod.id +
            ": Visible 4-tier breadcrumb navigation matches Home > Shop > Category > Product"
        );
      } else {
        fail(prod.id + ": Visible breadcrumbs missing required tier", crumbHtml);
      }
    }
  });

  /* ---- shop.html ItemList: one priced offer per product ---- */
  var shopPageHtml = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
  var shopLdBlocks =
    shopPageHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  var shopLd = [];
  shopLdBlocks.forEach(function (b, idx) {
    var jsonText = b
      .replace(/^<script[^>]*>/, "")
      .replace(/<\/script>$/, "")
      .trim();
    try {
      shopLd.push(JSON.parse(jsonText));
    } catch (err) {
      fail("shop.html JSON-LD block #" + (idx + 1) + " JSON parse error", err.message);
    }
  });

  var shopItemList = shopLd.find(function (ld) {
    return ld["@type"] === "ItemList";
  });

  if (!shopItemList || !Array.isArray(shopItemList.itemListElement)) {
    fail(
      "shop.html ItemList",
      "No @type: ItemList block with an itemListElement array -- the site's only " +
        "indexable structured product data is gone"
    );
  } else if (shopItemList.itemListElement.length !== PRODUCTS.length) {
    fail(
      "shop.html ItemList covers every product",
      "ItemList has " +
        shopItemList.itemListElement.length +
        " entries, catalogue has " +
        PRODUCTS.length
    );
  } else {
    ok("shop.html ItemList carries all " + PRODUCTS.length + " products");

    var bySku = {};
    shopItemList.itemListElement.forEach(function (entry) {
      if (entry && entry.item && entry.item.sku) bySku[entry.item.sku] = entry;
    });

    PRODUCTS.forEach(function (prod) {
      var entry = bySku[prod.id];
      if (!entry) {
        fail(prod.id + ": missing from shop.html ItemList", "no ListItem with sku " + prod.id);
        return;
      }

      var item = entry.item;
      var offers = item.offers;
      if (!offers) {
        fail(
          prod.id + ": shop.html ItemList entry has no offers",
          JSON.stringify(item).slice(0, 200)
        );
        return;
      }

      // A single-price product gets an Offer; one with priced variants gets an
      // AggregateOffer. Either way a price has to be there -- an offer with no
      // price is invisible in Google Merchant.
      var isAggregate = offers["@type"] === "AggregateOffer";
      var isSingle = offers["@type"] === "Offer";
      var priceStr = isAggregate ? offers.lowPrice : offers.price;
      var priceOk = typeof priceStr === "string" && /^\d+\.\d{2}$/.test(priceStr);
      if (isAggregate) {
        priceOk =
          priceOk &&
          typeof offers.highPrice === "string" &&
          /^\d+\.\d{2}$/.test(offers.highPrice) &&
          typeof offers.offerCount === "number" &&
          offers.offerCount >= 2;
      }

      // Availability is derived from the real catalogue flags, not from
      // whether the image path happens to contain "placeholder".
      var expectedAvailability = "https://schema.org/InStock";
      if (prod.inStock === false || prod.stock === 0) {
        expectedAvailability = "https://schema.org/OutOfStock";
      } else if (prod.comingSoon === true) {
        /* Not PreOrder: a coming-soon product cannot be ordered at all, only
           waitlisted -- see schemaAvailability() in build-site-data.js and the
           2026-09-02 live audit, M-5. */
        expectedAvailability = "https://schema.org/OutOfStock";
      }

      var offerValid =
        (isAggregate || isSingle) &&
        priceOk &&
        offers.priceCurrency === "USD" &&
        offers.availability === expectedAvailability &&
        offers.itemCondition === "https://schema.org/NewCondition" &&
        offers.url === "https://yallternativeliving.com/products/" + prod.id + ".html" &&
        offers.seller &&
        offers.seller["@type"] === "Organization" &&
        offers.seller.name === "Y'allternative Living";

      var itemValid =
        item["@type"] === "Product" &&
        item.name === prod.name &&
        item.url === "https://yallternativeliving.com/products/" + prod.id + ".html" &&
        item.brand &&
        item.brand["@type"] === "Brand" &&
        item.brand.name === "Y'allternative Living" &&
        // schema.org allows `image` as one URL or an array of URLs; the
        // generator emits a string for single-image products.
        (Array.isArray(item.image) ? item.image : [item.image]).length >= 1 &&
        (Array.isArray(item.image) ? item.image : [item.image]).every(function (img) {
          return typeof img === "string" && /^https?:\/\//.test(img);
        });

      if (itemValid && offerValid) {
        ok(
          prod.id +
            ": shop.html ItemList entry carries a valid " +
            offers["@type"] +
            " (" +
            priceStr +
            " USD, " +
            expectedAvailability.replace("https://schema.org/", "") +
            ")"
        );
      } else {
        fail(
          prod.id + ": shop.html ItemList entry invalid",
          JSON.stringify({ item: { name: item.name, url: item.url }, offers: offers }).slice(0, 300)
        );
      }

      // Ratings must still be backed by real data wherever they appear.
      if (prod.rating) {
        var ar = item.aggregateRating;
        if (
          ar &&
          ar["@type"] === "AggregateRating" &&
          Number(ar.ratingValue) === prod.rating.value &&
          Number(ar.reviewCount) === prod.rating.count
        ) {
          ok(prod.id + ": AggregateRating in shop.html matches product rating data");
        } else {
          fail(
            prod.id + ": AggregateRating mismatch in shop.html ItemList",
            JSON.stringify(ar) + " vs " + JSON.stringify(prod.rating)
          );
        }
      } else if (item.aggregateRating !== undefined) {
        fail(
          prod.id + ": Fabricated aggregateRating on an unrated product",
          JSON.stringify(item.aggregateRating)
        );
      } else {
        ok(prod.id + ": No ungrounded aggregateRating fabricated");
      }
    });
  }
} catch (e) {
  fail("Structured data QA check failed", e.message);
}

/* ---------- Complete the Ritual Smart Cross-Sells (R2) ---------- */
section("Complete the Ritual Smart Cross-Sells (R2)");
try {
  var botanicalProducts = PRODUCTS.filter(function (p) {
    return ["salves", "body", "soaks", "potions", "ritual"].includes(p.category);
  });

  if (botanicalProducts.length >= 16) {
    ok("Found " + botanicalProducts.length + " botanical & apothecary products in catalog");
  } else {
    fail(
      "Botanical products count",
      "Expected at least 16 botanical products, found " + botanicalProducts.length
    );
  }

  var allProdIds = new Set(
    PRODUCTS.map(function (p) {
      return p.id;
    })
  );

  botanicalProducts.forEach(function (p) {
    // Check pairsWith and ritualTitle
    if (Array.isArray(p.pairsWith) && p.pairsWith.length >= 1) {
      ok(p.id + ": pairsWith array populated with " + p.pairsWith.length + " items");
    } else {
      fail(p.id + ": missing or empty pairsWith array", JSON.stringify(p.pairsWith));
    }

    if (typeof p.ritualTitle === "string" && p.ritualTitle.trim().length > 0) {
      ok(p.id + ": ritualTitle defined as '" + p.ritualTitle + "'");
    } else {
      fail(p.id + ": missing or empty ritualTitle", String(p.ritualTitle));
    }

    if (Array.isArray(p.pairsWith)) {
      p.pairsWith.forEach(function (pairedId) {
        if (allProdIds.has(pairedId)) {
          ok(p.id + " -> " + pairedId + ": referential integrity valid");
        } else {
          fail(p.id + ": pairsWith unknown ID '" + pairedId + "'");
        }
        if (pairedId !== p.id) {
          ok(p.id + ": no self-referencing in pairsWith");
        } else {
          fail(p.id + ": self-referencing pairsWith found");
        }
      });
    }

    // Check PDP HTML rendering
    var pdpHtmlPath = path.join(ROOT, "products", p.id + ".html");
    if (fs.existsSync(pdpHtmlPath)) {
      var pdpHtml = fs.readFileSync(pdpHtmlPath, "utf8");
      var hasRitualSection = pdpHtml.indexOf('class="pdp-ritual-section"') !== -1;
      var hasRitualId = pdpHtml.indexOf('id="pdpRitualSection"') !== -1;
      var hasRitualTitle = pdpHtml.indexOf(escapeHtml(p.ritualTitle)) !== -1;
      var hasAddBtn = pdpHtml.indexOf('id="pdpRitualAddBtn"') !== -1;
      var hasTotalPrice = pdpHtml.indexOf('id="pdpRitualTotalPrice"') !== -1;
      var hasNoReveal =
        pdpHtml.indexOf('class="pdp-ritual-section reveal"') === -1 &&
        pdpHtml.indexOf('class="reveal pdp-ritual-section"') === -1;

      // The build drops partners that cannot be bought (Coming Soon / no
      // stock), so a product whose every partner is unbuyable renders no
      // section at all -- and must not: "Add All" used to add one.
      var buyablePartners = (p.pairsWith || []).filter(function (pairedId) {
        var q = PRODUCTS.find(function (cand) {
          return cand && cand.id === pairedId;
        });
        return q && !q.comingSoon && q.stock !== 0;
      });
      // ...and the current product itself must be buyable: it is the disabled
      // "This Item" row inside "Add All", so a coming-soon or sold-out product
      // renders no ritual either (verify-C C-2).
      var selfUnbuyable = !!p.comingSoon || p.stock === 0;
      if (buyablePartners.length === 0 || selfUnbuyable) {
        if (!hasRitualSection && !hasRitualId && !hasAddBtn) {
          ok(
            p.id +
              ": PDP renders no ritual section (" +
              (selfUnbuyable ? "the product itself is not on sale" : "every partner is unbuyable") +
              ")"
          );
        } else {
          fail(
            p.id + ": PDP offers a ritual whose partners cannot be bought",
            "Coming-Soon / out-of-stock partners must be filtered out of the ritual markup"
          );
        }
      } else if (hasRitualSection && hasRitualId && hasRitualTitle && hasAddBtn && hasTotalPrice) {
        ok(p.id + ": PDP renders complete ritual cross-sell markup");
      } else {
        fail(
          p.id + ": PDP ritual markup incomplete",
          "Missing ritual elements in products/" + p.id + ".html"
        );
      }

      if (hasNoReveal) {
        ok(
          p.id +
            ": PDP ritual section does not use .reveal class (prevents scroll-reveal gate failure)"
        );
      } else {
        fail(p.id + ": PDP ritual section illegally carries .reveal class");
      }
    }
  });

  // Verify CMS config declarations
  var cmsConfig = fs.readFileSync(path.join(ROOT, "admin/config.yml"), "utf8");
  if (/name:\s*pairsWith/.test(cmsConfig) && /name:\s*ritualTitle/.test(cmsConfig)) {
    ok("admin/config.yml declares pairsWith relation widget and ritualTitle string widget");
  } else {
    fail("admin/config.yml missing pairsWith or ritualTitle declarations");
  }

  // Verify CSS styles exist
  var ritualCss = fs.readFileSync(path.join(ROOT, "assets/css/styles.css"), "utf8");
  if (
    ritualCss.indexOf(".pdp-ritual-section") !== -1 &&
    ritualCss.indexOf(".pdp-ritual-card") !== -1 &&
    ritualCss.indexOf(".pdp-ritual-item") !== -1 &&
    ritualCss.indexOf(".pdp-ritual-checkbox") !== -1 &&
    ritualCss.indexOf(".pdp-ritual-add-btn") !== -1
  ) {
    ok("assets/css/styles.css contains required .pdp-ritual-* style rules");
  } else {
    fail("assets/css/styles.css missing .pdp-ritual-* style rules");
  }
} catch (e) {
  fail("Complete the Ritual QA check failed", e.message);
}

/* ---------- Mobile Sticky Add-to-Cart Bottom Bar (R1) ---------- */
section("Mobile Sticky Add-to-Cart Bottom Bar (R1)");
try {
  var pdpProducts = PRODUCTS.filter(function (p) {
    return p && p.id;
  });

  if (pdpProducts.length >= 19) {
    ok("Found " + pdpProducts.length + " products for PDP sticky bar validation");
  } else {
    fail("PDP product count", "Expected >= 19 products, found " + pdpProducts.length);
  }

  pdpProducts.forEach(function (p) {
    var pdpHtmlPath = path.join(ROOT, "products", p.id + ".html");
    if (!fs.existsSync(pdpHtmlPath)) {
      fail("PDP file missing for " + p.id, "products/" + p.id + ".html does not exist");
      return;
    }

    var pdpHtml = fs.readFileSync(pdpHtmlPath, "utf8");
    var hasStickyBar = pdpHtml.indexOf('class="pdp-sticky-bar"') !== -1;
    var hasStickyId = pdpHtml.indexOf('id="pdpStickyBar"') !== -1;
    var hasAriaHidden = pdpHtml.indexOf('aria-hidden="true"') !== -1;
    var hasThumb = pdpHtml.indexOf('class="pdp-sticky-thumb"') !== -1;
    var hasInfo = pdpHtml.indexOf('class="pdp-sticky-info"') !== -1;
    var hasTitle =
      pdpHtml.indexOf('class="pdp-sticky-title"') !== -1 &&
      pdpHtml.indexOf(escapeHtml(p.name)) !== -1;
    var hasPrice = pdpHtml.indexOf('class="pdp-sticky-price"') !== -1;
    var hasAddBtn = pdpHtml.indexOf("pdp-sticky-add-btn") !== -1;
    var hasNoReveal =
      pdpHtml.indexOf('class="pdp-sticky-bar reveal"') === -1 &&
      pdpHtml.indexOf('class="reveal pdp-sticky-bar"') === -1;

    if (
      hasStickyBar &&
      hasStickyId &&
      hasAriaHidden &&
      hasThumb &&
      hasInfo &&
      hasTitle &&
      hasPrice &&
      hasAddBtn
    ) {
      ok(p.id + ": PDP renders complete sticky add-to-cart bottom bar markup");
    } else {
      fail(
        p.id + ": PDP sticky bottom bar markup incomplete",
        "Missing required elements in products/" + p.id + ".html"
      );
    }

    if (hasNoReveal) {
      ok(p.id + ": PDP sticky bar does not carry .reveal class (preserves reveal gate)");
    } else {
      fail(p.id + ": PDP sticky bar illegally carries .reveal class");
    }

    // If product has variants, check variant selector. The gift card's amount
    // is configured on shop.html (its bar links there), and a coming-soon
    // product has nothing to buy, so neither carries a picker.
    if (
      p.variants &&
      Array.isArray(p.variants.options) &&
      p.variants.options.length > 0 &&
      !p.comingSoon &&
      p.id !== "yallternative-gift-card"
    ) {
      var hasVariantSelect =
        pdpHtml.indexOf('class="pdp-sticky-variant-select variant-select"') !== -1;
      var hasAriaLabel = pdpHtml.indexOf('aria-label="Select variant"') !== -1;
      var hasBasePrice = pdpHtml.indexOf('data-base-price="') !== -1;
      if (hasVariantSelect && hasAriaLabel && hasBasePrice) {
        ok(p.id + ": PDP sticky bar includes accessible variant selector");
      } else {
        fail(p.id + ": PDP sticky bar missing variant selector or attributes");
      }
    }
  });

  // Verify CSS in styles.css
  var stylesCss = fs.readFileSync(path.join(ROOT, "assets/css/styles.css"), "utf8");
  if (
    stylesCss.indexOf(".pdp-sticky-bar") !== -1 &&
    stylesCss.indexOf(".pdp-sticky-bar.is-visible") !== -1 &&
    stylesCss.indexOf("@media (min-width: 768px)") !== -1 &&
    stylesCss.indexOf(".pdp-sticky-thumb") !== -1 &&
    stylesCss.indexOf(".pdp-sticky-add-btn") !== -1
  ) {
    ok("assets/css/styles.css contains required .pdp-sticky-bar style rules");
  } else {
    fail("assets/css/styles.css missing .pdp-sticky-bar style rules");
  }
} catch (e) {
  fail("Mobile Sticky Add-to-Cart Bottom Bar QA check failed", e.message);
}

/* ---------- 30) Milestone 3: CMS Merchandising, Schema Validation & Quiz Integrity ---------- */
section("Milestone 3: CMS Merchandising, Schema Validation & Quiz Integrity");

// 1. Sveltia CMS Schema Validation (admin/config.yml)
(function checkCmsSchemaExpansion() {
  try {
    var configYmlPath = path.join(ROOT, "admin/config.yml");
    if (!fs.existsSync(configYmlPath)) {
      fail("admin/config.yml", "file missing");
      return;
    }
    var cmsText = fs.readFileSync(configYmlPath, "utf8");

    // announcement schema
    var hasAnnouncement =
      /name:\s*announcement\b/.test(cmsText) &&
      /name:\s*accent\b[\s\S]*?options:\s*[\r\n]+\s*-\s*\{\s*label:[^}]+value:\s*["']?default["']?/i.test(
        cmsText
      ) &&
      /value:\s*["']?whiskey["']?/i.test(cmsText) &&
      /value:\s*["']?moss["']?/i.test(cmsText) &&
      /value:\s*["']?lavender["']?/i.test(cmsText) &&
      /value:\s*["']?rust["']?/i.test(cmsText);
    if (hasAnnouncement) {
      ok(
        "admin/config.yml declares site.announcement with all accent options (whiskey, moss, lavender, rust)"
      );
    } else {
      fail(
        "admin/config.yml",
        "missing or incomplete site.announcement schema with accent options"
      );
    }

    // seasonalNotice schema
    var seasonalNoticeBlock = (cmsText.match(
      /-\s*name:\s*seasonalNotice\b[\s\S]*?(?=\r?\n\s*-\s*name:|$)/i
    ) || [""])[0];
    var hasSeasonalNotice =
      /name:\s*seasonalNotice\b/.test(cmsText) &&
      /name:\s*showInCart\b/.test(seasonalNoticeBlock) &&
      /name:\s*showInHeader\b/.test(seasonalNoticeBlock);
    if (hasSeasonalNotice) {
      ok("admin/config.yml declares site.seasonalNotice with showInCart and showInHeader toggles");
    } else {
      fail("admin/config.yml", "missing site.seasonalNotice schema or toggles");
    }

    // social schema with regex guards
    var hasSocial = /name:\s*social\b/.test(cmsText);
    var socialFields = ["instagram", "tiktok", "facebook", "etsy", "pinterest", "youtube"];
    var allSocialGuarded = socialFields.every(function (field) {
      var fieldBlockRegex = new RegExp(
        "-\\s*name:\\s*" + field + "\\b([\\s\\S]*?)(?=\\r?\\n\\s*-\\s*(?:name:|\\{)|$)",
        "i"
      );
      var match = cmsText.match(fieldBlockRegex);
      if (!match) return false;
      return /pattern:\s*\[\s*['"]\^\$?\|?\^https\?:\/\//i.test(match[0]);
    });
    if (hasSocial && allSocialGuarded) {
      ok(
        "admin/config.yml declares site.social with strict HTTPS regex guards across all 6 channels"
      );
    } else {
      fail("admin/config.yml", "site.social missing or lacks regex URL pattern guards");
    }

    // ritualDefaults schema
    var ritualBlock = (cmsText.match(
      /-\s*name:\s*ritualDefaults\b[\s\S]*?(?=\r?\n\s*-\s*name:|$)/i
    ) || [""])[0];
    var hasRitualDefaults =
      /name:\s*ritualDefaults\b/.test(cmsText) &&
      /name:\s*title\b/.test(ritualBlock) &&
      /name:\s*subtitle\b/.test(ritualBlock);
    if (hasRitualDefaults) {
      ok("admin/config.yml declares site.ritualDefaults (title, subtitle)");
    } else {
      fail("admin/config.yml", "missing site.ritualDefaults schema");
    }

    // estimatedBatchDate product schema
    var hasEstimatedBatchDate = /name:\s*estimatedBatchDate\b/.test(cmsText);
    if (hasEstimatedBatchDate) {
      ok("admin/config.yml declares products[].estimatedBatchDate widget");
    } else {
      fail("admin/config.yml", "missing products[].estimatedBatchDate widget");
    }

    // quiz schema
    var hasQuizSchema =
      /name:\s*quiz\b/.test(cmsText) &&
      /name:\s*questions\b/.test(cmsText) &&
      /name:\s*options\b/.test(cmsText) &&
      /name:\s*recommendedProductIds\b/.test(cmsText) &&
      /name:\s*categories\b/.test(cmsText) &&
      /name:\s*scoreWeight\b/.test(cmsText);
    if (hasQuizSchema) {
      ok(
        "admin/config.yml declares top-level quiz schema with questions, options, relation widgets, and scoreWeight"
      );
    } else {
      fail("admin/config.yml", "missing or incomplete top-level quiz schema");
    }
  } catch (e) {
    fail("CMS Schema Validation QA check failed", e.message);
  }
})();

// 2. Canonical Data Validation (content.json & products.json)
(function checkCanonicalDataDefaults() {
  try {
    var contentJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
    );
    var site = contentJson.site || {};

    // announcement defaults
    if (
      site.announcement &&
      typeof site.announcement.enabled === "boolean" &&
      typeof site.announcement.text === "string" &&
      site.announcement.text.trim().length > 0 &&
      ["default", "whiskey", "moss", "lavender", "rust"].includes(site.announcement.accent)
    ) {
      ok(
        "content.json site.announcement defaults valid (enabled=" +
          site.announcement.enabled +
          ", accent=" +
          site.announcement.accent +
          ")"
      );
    } else {
      fail("content.json site.announcement invalid", JSON.stringify(site.announcement));
    }

    // seasonalNotice defaults
    if (
      site.seasonalNotice &&
      typeof site.seasonalNotice.enabled === "boolean" &&
      typeof site.seasonalNotice.text === "string" &&
      site.seasonalNotice.text.trim().length > 0 &&
      typeof site.seasonalNotice.showInCart === "boolean" &&
      typeof site.seasonalNotice.showInHeader === "boolean"
    ) {
      ok(
        "content.json site.seasonalNotice defaults valid (enabled=" +
          site.seasonalNotice.enabled +
          ", showInCart=" +
          site.seasonalNotice.showInCart +
          ")"
      );
    } else {
      fail("content.json site.seasonalNotice invalid", JSON.stringify(site.seasonalNotice));
    }

    // social profile URLs
    var social = site.social || {};
    var socialKeys = ["instagram", "tiktok", "facebook", "etsy", "pinterest", "youtube"];
    var primarySocials = ["instagram", "tiktok", "facebook", "etsy"];
    var allSocialsValid = socialKeys.every(function (k) {
      var val = social[k];
      if (typeof val !== "string") return false;
      if (val.length === 0) return true;
      return val.startsWith("https://");
    });
    var primaryPopulated = primarySocials.every(function (k) {
      return typeof social[k] === "string" && social[k].startsWith("https://");
    });
    if (allSocialsValid && primaryPopulated) {
      ok(
        "content.json site.social contains valid HTTPS profile URLs (primary channels populated, all non-empty URLs use https://)"
      );
    } else {
      fail("content.json site.social invalid", JSON.stringify(social));
    }

    // ritualDefaults
    if (
      site.ritualDefaults &&
      typeof site.ritualDefaults.title === "string" &&
      site.ritualDefaults.title.trim().length > 0 &&
      typeof site.ritualDefaults.subtitle === "string" &&
      site.ritualDefaults.subtitle.trim().length > 0
    ) {
      ok("content.json site.ritualDefaults valid ('" + site.ritualDefaults.title + "')");
    } else {
      fail("content.json site.ritualDefaults invalid", JSON.stringify(site.ritualDefaults));
    }

    // quiz structure (assets/data/quiz.json, merged into YL_CONTENT.quiz by the build)
    var quiz = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/quiz.json"), "utf8"));
    if (
      typeof quiz.eyebrow === "string" &&
      typeof quiz.title === "string" &&
      typeof quiz.subtitle === "string" &&
      Array.isArray(quiz.questions) &&
      quiz.questions.length >= 3
    ) {
      ok("content.json quiz structure valid with " + quiz.questions.length + " questions");
    } else {
      fail("content.json quiz structure missing or incomplete");
    }

    // products.json estimatedBatchDate on comingSoon products
    var productsJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
    );
    var comingSoonProducts = (productsJson.products || []).filter(function (p) {
      return p.comingSoon === true;
    });
    if (comingSoonProducts.length >= 5) {
      ok("Found " + comingSoonProducts.length + " coming-soon products in products.json");
    } else {
      fail(
        "products.json comingSoon products count",
        "Expected >= 5, found " + comingSoonProducts.length
      );
    }
    var allBatchDatesValid = comingSoonProducts.every(function (p) {
      return typeof p.estimatedBatchDate === "string" && p.estimatedBatchDate.trim().length > 0;
    });
    if (allBatchDatesValid) {
      ok(
        "All " +
          comingSoonProducts.length +
          " coming-soon products define valid non-empty estimatedBatchDate strings"
      );
    } else {
      fail("products.json comingSoon products missing valid estimatedBatchDate");
    }
  } catch (e) {
    fail("Canonical Data Validation QA check failed", e.message);
  }
})();

// 3. Footer & HTML Marker Checks (footer.html & built HTML pages)
(function checkFooterAndSocialMarkers() {
  try {
    var footerPath = path.join(ROOT, "assets/data/footer.html");
    if (!fs.existsSync(footerPath)) {
      fail("assets/data/footer.html missing");
      return;
    }
    var footerHtml = fs.readFileSync(footerPath, "utf8");

    if (
      footerHtml.indexOf("<!--YL:site.socialRow-->") !== -1 &&
      footerHtml.indexOf("<!--/YL:site.socialRow-->") !== -1 &&
      footerHtml.indexOf("<!--YL:site.social.etsy-->") !== -1 &&
      footerHtml.indexOf("<!--/YL:site.social.etsy-->") !== -1
    ) {
      ok(
        "assets/data/footer.html contains comment markers <!--YL:site.socialRow--> and <!--YL:site.social.etsy-->"
      );
    } else {
      fail("assets/data/footer.html missing required social comment markers");
    }

    var contentJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
    );
    var social = contentJson.site.social || {};
    var activeSocialUrls = Object.keys(social)
      .map(function (k) {
        return social[k];
      })
      .filter(function (url) {
        return typeof url === "string" && url.startsWith("https://");
      });

    PAGES.forEach(function (pageFile) {
      var pagePath = path.join(ROOT, pageFile);
      if (!fs.existsSync(pagePath)) return;
      var pageHtml = fs.readFileSync(pagePath, "utf8");

      var hasSocialRow = pageHtml.indexOf('class="social-row"') !== -1;
      var hasAllActiveLinks = activeSocialUrls.every(function (url) {
        return pageHtml.indexOf('href="' + url + '"') !== -1;
      });

      if (hasSocialRow && hasAllActiveLinks) {
        ok(
          pageFile +
            ": contains rendered .social-row with all active social links matching content.json"
        );
      } else {
        fail(pageFile, "missing .social-row or active social link matching content.json");
      }
    });
  } catch (e) {
    fail("Footer & Social Markers QA check failed", e.message);
  }
})();

// 4. Quiz Referential Integrity
(function checkQuizReferentialIntegrity() {
  try {
    var productsJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
    );
    var productIds = new Set(
      (productsJson.products || []).map(function (p) {
        return p.id;
      })
    );
    var bundleIds = new Set(
      (productsJson.bundles || []).map(function (b) {
        return b.id;
      })
    );
    var categoryIds = new Set(
      (productsJson.categories || []).map(function (c) {
        return c.id;
      })
    );
    var validItemIds = new Set([...productIds, ...bundleIds]);

    var quizJson = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/quiz.json"), "utf8"));
    var questions = quizJson.questions || [];

    var allProductRefsValid = true;
    var allCategoryRefsValid = true;
    var allWeightsValid = true;
    var totalOptions = 0;

    questions.forEach(function (q) {
      (q.options || []).forEach(function (opt) {
        totalOptions++;
        (opt.recommendedProductIds || []).forEach(function (id) {
          if (!validItemIds.has(id)) {
            allProductRefsValid = false;
            fail("Quiz option " + opt.value, "references unknown product/bundle ID '" + id + "'");
          }
        });
        (opt.categories || []).forEach(function (cat) {
          if (!categoryIds.has(cat)) {
            allCategoryRefsValid = false;
            fail("Quiz option " + opt.value, "references unknown category ID '" + cat + "'");
          }
        });
        if (typeof opt.scoreWeight !== "number" || opt.scoreWeight <= 0) {
          allWeightsValid = false;
          fail("Quiz option " + opt.value, "invalid scoreWeight: " + opt.scoreWeight);
        }
      });
    });

    if (allProductRefsValid && allCategoryRefsValid && allWeightsValid && totalOptions >= 6) {
      ok(
        "Quiz referential integrity valid: all " +
          totalOptions +
          " options resolve to real catalog products, bundles, and categories with positive score weights"
      );
    }
  } catch (e) {
    fail("Quiz Referential Integrity QA check failed", e.message);
  }
})();

// 5. Announcement Accent Theme Contrast
(function checkAnnouncementAccentContrast() {
  try {
    var ACCENTS = [
      { name: "whiskey", bgToken: "whiskey", fgToken: "ink" },
      { name: "moss", bgHex: "#3e5a4a", fgHex: "#f3ead9" },
      { name: "lavender", bgHex: "#4a385c", fgHex: "#f3ead9" },
      { name: "rust", bgHex: "#8a381e", fgHex: "#f3ead9" }
    ];

    ACCENTS.forEach(function (acc) {
      if (acc.bgToken && acc.fgToken) {
        ["dark", "light"].forEach(function (themeName) {
          var tokens = themeName === "dark" ? darkTokens : lightTokens;
          var fgHex = resolveHex(tokens, tokens[acc.fgToken] || "");
          var bgHex = resolveHex(tokens, tokens[acc.bgToken] || "");
          if (!fgHex || !bgHex) {
            fail(
              "Announcement accent " + acc.name + " (" + themeName + ")",
              "cannot resolve tokens"
            );
            return;
          }
          var ratio = contrastRatio(fgHex, bgHex);
          var label =
            "Announcement accent " +
            acc.name +
            " [" +
            themeName +
            "] (" +
            fgHex +
            " on " +
            bgHex +
            "): " +
            ratio.toFixed(2) +
            ":1";
          if (ratio >= 4.5) ok(label + " (meets WCAG 2.2 AA >= 4.5:1)");
          else fail(label, "fails WCAG 2.2 AA contrast");
        });
      } else {
        var ratio = contrastRatio(acc.fgHex, acc.bgHex);
        var label =
          "Announcement accent " +
          acc.name +
          " (" +
          acc.fgHex +
          " on " +
          acc.bgHex +
          "): " +
          ratio.toFixed(2) +
          ":1";
        if (ratio >= 4.5) ok(label + " (meets WCAG 2.2 AA >= 4.5:1)");
        else fail(label, "fails WCAG 2.2 AA contrast");
      }
    });

    // Verify CSS classes exist in styles.css
    var stylesCss = fs.readFileSync(path.join(ROOT, "assets/css/styles.css"), "utf8");
    var allAccentsStyled = ["whiskey", "moss", "lavender", "rust"].every(function (acc) {
      return (
        stylesCss.indexOf(".announcement-accent-" + acc) !== -1 &&
        stylesCss.indexOf("#yl-countdown-ticker.announcement-accent-" + acc) !== -1
      );
    });
    if (allAccentsStyled) {
      ok(
        "assets/css/styles.css contains .announcement-accent-* style rules for all 4 theme accents"
      );
    } else {
      fail("assets/css/styles.css missing .announcement-accent-* style rules");
    }
  } catch (e) {
    fail("Announcement Accent Contrast QA check failed", e.message);
  }
})();

/* ---------- Report a Reaction (safety.html) -- MoCRA adverse-event page ----------
   The page whose URL is printed on the packaging. Everything asserted here is
   something that, if it silently broke, would leave a jar in someone's hand
   pointing at a dead end: the clean-URL rewrite, the form's endpoint and field
   names, the eight serious-event checkboxes the FDA definition turns on, and
   the absence of any inline script (the CSP would refuse one, and this page is
   the last one that may fail to load).

   Note the shape of these checks: each one reads the real file and asserts the
   subject EXISTS before asserting anything about it. An `every()` over a
   selector that matched nothing is how four checks in this repo went green
   while examining nothing at all (AGENTS.md, "checks that stop checking"). */
section("CSP baseline vs shipped pages (every inline script hash must be in _headers)");
(function () {
  var crypto = require("crypto");
  var headersText = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
  var cspLine =
    headersText.split("\n").filter(function (l) {
      return /^\s*Content-Security-Policy:/.test(l);
    })[0] || "";
  var pageList = PAGES.slice();
  var productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir).forEach(function (f) {
      if (f.endsWith(".html")) pageList.push("products/" + f);
    });
  }
  var missing = [];
  var scanned = 0;
  pageList.forEach(function (page) {
    var file = path.join(ROOT, page);
    if (!fs.existsSync(file)) return;
    var html = fs.readFileSync(file, "utf8");
    var re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    var mm;
    while ((mm = re.exec(html))) {
      var attrs = mm[1] || "";
      if (/\bsrc\s*=/i.test(attrs)) continue;
      if (/type\s*=\s*["']?(application\/ld\+json|speculationrules|text\/template)/i.test(attrs))
        continue;
      var body = mm[2];
      if (!body.trim()) continue;
      scanned++;
      var hash = "sha256-" + crypto.createHash("sha256").update(body, "utf8").digest("base64");
      if (cspLine.indexOf("'" + hash + "'") === -1) missing.push(page + " " + hash);
    }
  });
  if (!cspLine) fail("CSP line", "_headers carries no Content-Security-Policy line");
  else if (!scanned)
    fail("inline scripts", "no inline scripts found on any page -- the scan is broken");
  else if (missing.length) {
    fail(
      "inline scripts not covered by the shipped CSP (run npm run build-security-headers)",
      missing.join(", ")
    );
  } else
    ok(
      "all " +
        scanned +
        " inline scripts across " +
        pageList.length +
        " pages are hashed in _headers"
    );
})();

section("Report a Reaction page (safety.html) -- MoCRA adverse-event intake");
(function checkSafetyPage() {
  var safetyPath = path.join(ROOT, "safety.html");
  if (!fs.existsSync(safetyPath)) {
    fail("safety.html", "missing -- this URL is printed on the packaging and cannot 404");
    return;
  }
  var safetyHtml = fs.readFileSync(safetyPath, "utf8");

  /* --- the same chrome every other top-level page ships (contact.html is the
     model; the shared PAGES loops above cover the Tawk block, the search modal,
     the footer and the JSON-LD, so this is what those do not check). --- */
  var chrome = [
    ["skip link", '<a href="#main-content" class="skip-link">'],
    ["header nav", '<header class="site-header">'],
    ["main landmark", '<main id="main-content">'],
    ["Umami marker", "<!--YL:site.umamiWebsiteId-->"],
    ["feature-style marker", "<!--YL:featureStyles-->"],
    ["cart drawer script", "assets/js/cart.js"],
    ["main.js", "assets/js/main.js"],
    ["page script (safety.js)", 'src="assets/js/safety.js"']
  ];
  chrome.forEach(function (pair) {
    if (safetyHtml.indexOf(pair[1]) !== -1) ok("safety.html has the " + pair[0]);
    else fail("safety.html is missing the " + pair[0], pair[1]);
  });

  if (/<script src="assets\/js\/safety\.js" defer><\/script>/.test(safetyHtml)) {
    ok("safety.html loads safety.js deferred");
  } else {
    fail("safety.html: safety.js must be loaded with defer", "found no deferred tag");
  }

  /* --- the theme-init snippet is the ONLY inline script. Anything else would
     need a new hash in scripts/inline-script-hashes.json, and a page that
     cannot execute its own form handler under the CSP is a page that silently
     stops accepting reports. --- */
  var inlineScripts = (
    safetyHtml.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []
  ).filter(function (block) {
    return !/type\s*=\s*["']application\/ld\+json["']/.test(block);
  });
  var contactHtmlForTheme = fs.readFileSync(path.join(ROOT, "contact.html"), "utf8");
  var themeRe = /<script>\s*\n\s*\/\/ No-flash theme init[\s\S]*?<\/script>/;
  var contactTheme = contactHtmlForTheme.match(themeRe);
  var safetyTheme = safetyHtml.match(themeRe);
  if (contactTheme && safetyTheme && contactTheme[0] === safetyTheme[0]) {
    ok(
      "safety.html's theme-init script is byte-identical to contact.html's (hash already approved)"
    );
  } else {
    fail(
      "safety.html theme-init script diverges from contact.html's",
      "its CSP hash would change -- see scripts/inline-script-hashes.json"
    );
  }
  if (inlineScripts.length === 2) {
    ok("safety.html ships exactly 2 inline scripts (theme init + the shared Tawk.to loader)");
  } else {
    fail(
      "safety.html inline script count",
      "expected 2 (theme init + Tawk.to), found " +
        inlineScripts.length +
        " -- a new inline script needs a new CSP hash"
    );
  }

  /* --- the form itself --- */
  var formTag = (safetyHtml.match(/<form\b[^>]*class="safety-form"[^>]*>/) || [])[0];
  if (!formTag) {
    fail("safety.html .safety-form", "no form with that class -- there is no way to report");
  } else {
    if (/action="\/api\/safety-report"/.test(formTag)) {
      ok("safety.html form posts to /api/safety-report");
    } else {
      fail("safety.html form action", formTag);
    }
    if (/method="post"/i.test(formTag)) ok("safety.html form is a POST");
    else fail("safety.html form method", "must be POST -- the Worker refuses anything else");
  }

  var REQUIRED_FIELDS = [
    ["product_id", "which product"],
    ["lot", "lot or batch number"],
    ["channel", "purchase channel"],
    ["first_use_date", "date of first use"],
    ["reaction_date", "date the reaction started"],
    ["body_area", "where on the body"],
    ["description", "description of the reaction"],
    ["outcomes", "what happened next"],
    ["stopped_use", "whether they stopped using it"],
    ["reporter_name", "reporter name"],
    ["email", "reporter email"],
    ["reporter_phone", "reporter phone"],
    ["age_range", "age range"],
    ["sex", "sex"],
    ["contact_consent", "consent to follow-up"],
    ["website_hp", "honeypot"]
  ];
  var missingFields = REQUIRED_FIELDS.filter(function (pair) {
    return safetyHtml.indexOf('name="' + pair[0] + '"') === -1;
  });
  if (!missingFields.length) {
    ok(
      "safety.html carries all " +
        REQUIRED_FIELDS.length +
        " MedWatch 3500A fields the Worker reads, honeypot included"
    );
  } else {
    missingFields.forEach(function (pair) {
      fail("safety.html is missing the " + pair[1] + " field", 'name="' + pair[0] + '"');
    });
  }

  if (/name="email"[^>]*required|required[^>]*name="email"/.test(safetyHtml)) {
    ok("safety.html marks the email field required");
  } else {
    fail("safety.html email field", "must be required -- it is how the reference gets back");
  }
  if (/name="description"[^>]*required|required[^>]*name="description"/.test(safetyHtml)) {
    ok("safety.html marks the description field required");
  } else {
    fail("safety.html description field", "must be required -- there is no report without one");
  }

  /* --- the eight outcomes that make an event SERIOUS. These are the values
     the Worker computes its `serious` flag from; if a checkbox value here is
     renamed the flag silently stops being set and a 15-business-day FDA
     deadline is missed with no error anywhere. --- */
  var SERIOUS_VALUES = [
    "death",
    "life-threatening",
    "hospitalization",
    "disability",
    "congenital-anomaly",
    "infection",
    "disfigurement",
    "intervention"
  ];
  var missingSerious = SERIOUS_VALUES.filter(function (value) {
    return safetyHtml.indexOf('name="outcomes" value="' + value + '"') === -1;
  });
  if (!missingSerious.length) {
    ok("safety.html offers all 8 serious-adverse-event outcomes as checkboxes");
  } else {
    fail(
      "safety.html serious-outcome checkboxes missing",
      missingSerious.join(", ") + " -- the Worker's serious flag reads these exact values"
    );
  }
  ["doctor-visit", "otc-product", "cleared-up"].forEach(function (value) {
    if (safetyHtml.indexOf('name="outcomes" value="' + value + '"') !== -1) {
      ok('safety.html offers the "' + value + '" outcome');
    } else {
      fail("safety.html is missing the outcome " + value);
    }
  });

  var workerRoute = fs.readFileSync(path.join(ROOT, "workers/routes/safety-report.js"), "utf8");
  var pageValues = (safetyHtml.match(/name="outcomes" value="([a-z-]+)"/g) || []).map(function (m) {
    return m.replace(/^name="outcomes" value="/, "").replace(/"$/, "");
  });
  if (!pageValues.length) {
    fail("safety.html outcome checkboxes", "none parsed -- the check below would be vacuous");
  } else {
    var unknown = pageValues.filter(function (value) {
      return workerRoute.indexOf('"' + value + '"') === -1;
    });
    if (!unknown.length) {
      ok(
        "all " +
          pageValues.length +
          " outcome values on the page are known to workers/routes/safety-report.js"
      );
    } else {
      fail("safety.html offers outcomes the Worker discards", unknown.join(", "));
    }
  }

  /* --- brand-voice / regulatory copy. This is a cosmetics page: it must not
     read as a drug claim, and it must say what happens to the record. The
     shared footer disclaimer legitimately contains "treat"/"cure" ("not
     intended to diagnose, treat, cure, or prevent"), so the page's own <main>
     is what is scanned. --- */
  var mainStart = safetyHtml.indexOf('<main id="main-content">');
  var mainEnd = safetyHtml.indexOf("</main>");
  if (mainStart === -1 || mainEnd === -1 || mainEnd < mainStart) {
    fail("safety.html <main>", "could not be isolated -- the copy checks below would be vacuous");
  } else {
    // Product names are injected into the product <select> at build time and
    // are the shop's own listing names, not this page's copy; scan around them.
    var mainCopy = safetyHtml
      .slice(mainStart, mainEnd)
      .replace(/<option[^>]*>[\s\S]*?<\/option>/gi, "");
    var claimWords = ["treat", "cure", "heal"].filter(function (word) {
      return new RegExp("\\b" + word, "i").test(mainCopy);
    });
    if (!claimWords.length) {
      ok('safety.html\'s own copy makes no drug claim (no "treat", "cure" or "heal")');
    } else {
      fail(
        "safety.html copy uses drug-claim language",
        claimWords.join(", ") + " -- this is a cosmetics page, not a medicine one"
      );
    }
    [
      ["15 business days", /15 business days/i],
      ["the MedWatch / FDA 3500A form", /3500A|MedWatch/i],
      ["the retention promise", /three years/i],
      ["what to do first (stop using it)", /stop using/i],
      ["emergency guidance (911)", /\b911\b/],
      ["Poison Control", /1-800-222-1222/]
    ].forEach(function (pair) {
      if (pair[1].test(mainCopy)) ok("safety.html tells the reader about " + pair[0]);
      else fail("safety.html does not mention " + pair[0]);
    });
  }

  /* --- the wiring around the page --- */
  var footerSrc = fs.readFileSync(path.join(ROOT, "assets/data/footer.html"), "utf8");
  if (/href="\/safety\.html"/.test(footerSrc)) {
    ok("assets/data/footer.html links to the reaction-report page");
  } else {
    fail("footer template has no link to /safety.html");
  }
  var pagesWithoutFooterLink = PAGES.filter(function (page) {
    var full = path.join(ROOT, page);
    if (!fs.existsSync(full)) return false;
    return fs.readFileSync(full, "utf8").indexOf('href="/safety.html"') === -1;
  });
  if (!pagesWithoutFooterLink.length) {
    ok("the reaction-report link reached all " + PAGES.length + " built footers");
  } else {
    fail(
      "pages whose footer is missing the reaction-report link",
      pagesWithoutFooterLink.join(", ") + " -- run npm run build-data"
    );
  }

  var netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  if (
    /from = "\/safety"[\s\S]{0,80}to = "\/safety\.html"[\s\S]{0,40}status = 200/.test(netlifyToml)
  ) {
    ok("netlify.toml rewrites /safety to /safety.html (200, not a redirect)");
  } else {
    fail(
      "netlify.toml has no /safety rewrite",
      "that path is PRINTED ON THE PACKAGING and cannot 404 -- see build-security-headers.js"
    );
  }

  var sitemap = path.join(ROOT, "sitemap.xml");
  if (!fs.existsSync(sitemap)) {
    fail("sitemap.xml", "missing");
  } else if (fs.readFileSync(sitemap, "utf8").indexOf("/safety.html</loc>") !== -1) {
    ok("sitemap.xml lists safety.html");
  } else {
    fail("sitemap.xml does not list safety.html", "run npm run build-data");
  }

  var llms = path.join(ROOT, "llms.txt");
  if (!fs.existsSync(llms)) {
    fail("llms.txt", "missing");
  } else if (/\/safety\.html/.test(fs.readFileSync(llms, "utf8"))) {
    ok("llms.txt points assistants at the reaction-report page");
  } else {
    fail("llms.txt does not mention safety.html", "run npm run build-data");
  }

  var privacyHtml = fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8");
  [
    ["how long reaction reports are kept", /three years/i],
    ["that the FDA only sees them when the law requires it", /FDA/],
    ["that Resend delivers the email", /Resend/],
    ["it carries a link to the reporting page", /href="\/safety\.html"/]
  ].forEach(function (pair) {
    if (pair[1].test(privacyHtml)) ok("privacy.html says " + pair[0]);
    else fail("privacy.html does not say " + pair[0]);
  });

  /* --- the Worker end --- */
  var checkoutSrc = fs.readFileSync(path.join(ROOT, "workers/checkout.js"), "utf8");
  if (/"\/safety-report": handleSafetyReport/.test(checkoutSrc)) {
    ok("workers/checkout.js routes /safety-report");
  } else {
    fail("workers/checkout.js does not route /safety-report", "the form would 404");
  }
  if (/POST \/api\/safety-report/.test(checkoutSrc)) {
    ok("workers/checkout.js documents the route in its header comment");
  } else {
    fail("workers/checkout.js header comment does not list /api/safety-report");
  }

  var migrations = fs.readFileSync(path.join(ROOT, "workers/state/migrations.js"), "utf8");
  var schemaSql = fs.readFileSync(path.join(ROOT, "workers/schema.sql"), "utf8");
  if (/CREATE TABLE IF NOT EXISTS adverse_events/.test(migrations)) {
    ok("workers/state/migrations.js creates the adverse_events table");
  } else {
    fail("workers/state/migrations.js has no adverse_events table");
  }
  if (/CREATE TABLE IF NOT EXISTS adverse_events/.test(schemaSql)) {
    ok("workers/schema.sql documents the adverse_events table");
  } else {
    fail("workers/schema.sql has no adverse_events table");
  }
})();

/* ---------- /.well-known/security.txt is present and not about to lapse ----------
   RFC 9116 requires Contact (at least once) and Expires (exactly once), and
   recommends an expiry under a year out. An expired security.txt is worse
   than no file: it tells a researcher the address is abandoned. The build
   hardcodes the date so the output stays reproducible, which means the only
   thing that can move it is a person -- so this gate is the reminder, and it
   goes red 30 days before the file lapses rather than on the day. */
/* ---------- journal + feed are 404'd while the journal is switched off ----------
   site.enableJournal gates the whole feature, but journal.html and feed.xml
   are still written to disk and were still served 200 -- an orphan page with
   nothing on it and an RSS feed with zero items that a reader could subscribe
   to and never hear from (live audit 2026-09-02, L-2). build-security-headers
   .js adds a 404 rule for both while the flag is off. Assert the two agree,
   in both directions: a flag flipped on with the rules still in place would
   take the journal down silently, which is the worse failure of the two. */
section("journal gate matches the emitted redirect rules");
(function checkJournalGate() {
  var tomlPath = path.join(ROOT, "netlify.toml");
  if (!fs.existsSync(tomlPath)) {
    fail("netlify.toml", "missing -- run npm run build-security-headers");
    return;
  }
  var toml = fs.readFileSync(tomlPath, "utf8");
  var jsonPath = path.join(ROOT, "assets/data/content.json");
  var enabled;
  try {
    enabled = !!(JSON.parse(fs.readFileSync(jsonPath, "utf8")).site || {}).enableJournal;
  } catch (e) {
    fail("content.json", "unreadable: " + e.message);
    return;
  }
  ["/journal.html", "/feed.xml"].forEach(function (p404) {
    var blocked = toml.indexOf('from = "' + p404 + '"') !== -1;
    if (enabled && blocked) {
      fail(
        "journal is enabled but " + p404 + " is 404'd in netlify.toml",
        "re-run npm run build-security-headers"
      );
    } else if (!enabled && !blocked) {
      fail(
        "journal is disabled but " + p404 + " is still served",
        "re-run npm run build-security-headers"
      );
    } else {
      ok(p404 + " matches site.enableJournal=" + enabled + (blocked ? " (404'd)" : " (served)"));
    }
  });
})();

section("security.txt (RFC 9116)");
(function checkSecurityTxt() {
  var stPath = path.join(ROOT, ".well-known", "security.txt");
  if (!fs.existsSync(stPath)) {
    fail("/.well-known/security.txt", "missing -- run npm run build-data");
    return;
  }
  var st = fs.readFileSync(stPath, "utf8");
  var contacts = st.split("\n").filter(function (l) {
    return /^Contact:\s*\S/.test(l);
  });
  var expires = st.split("\n").filter(function (l) {
    return /^Expires:\s*\S/.test(l);
  });
  if (contacts.length >= 1) ok("security.txt has " + contacts.length + " Contact field(s)");
  else fail("security.txt has no Contact field", "RFC 9116 requires at least one");
  if (expires.length === 1) {
    ok("security.txt has exactly one Expires field");
    var when = Date.parse(expires[0].replace(/^Expires:\s*/, "").trim());
    if (isNaN(when)) {
      fail("security.txt Expires is not a parseable date", expires[0]);
    } else {
      var daysLeft = Math.floor((when - Date.now()) / 86400000);
      if (daysLeft <= 30) {
        fail(
          "security.txt expires in " + daysLeft + " day(s)",
          "move SECURITY_TXT_EXPIRES in scripts/build-site-data.js forward (under a year out) " +
            "and re-run npm run build-data"
        );
      } else if (daysLeft > 366) {
        fail(
          "security.txt expires " + daysLeft + " days out",
          "RFC 9116 recommends less than a year"
        );
      } else {
        ok("security.txt expiry is " + daysLeft + " days out (RFC 9116 wants under a year)");
      }
    }
  } else {
    fail("security.txt Expires field count is " + expires.length, "RFC 9116 requires exactly one");
  }
})();

/* ---------- SERP-safe <title> and meta description on every page ----------
   Google renders roughly the first 60 characters of a title and 155 of a
   description before it truncates. Nothing checked either, so four product
   titles and three page descriptions had drifted past those limits -- and the
   half of a title that gets cut is the end, which is where the brand lives
   (live audit 2026-09-02, L-6 and L-7). Lengths are measured on the DECODED
   text: "Y&#39;all" is one apostrophe to a search engine, not five characters.
   Uniqueness is checked in the same pass because a duplicated title is the
   other way this silently goes wrong. */
section("SERP-safe titles and meta descriptions");
(function checkSerpText() {
  var TITLE_MAX = 60;
  var DESC_MAX = 155;
  var serpPages = PAGES.slice();
  var productDir = path.join(ROOT, "products");
  if (fs.existsSync(productDir)) {
    fs.readdirSync(productDir)
      .filter(function (f) {
        return f.endsWith(".html");
      })
      .sort()
      .forEach(function (f) {
        serpPages.push("products/" + f);
      });
  }
  var decode = function (str) {
    return String(str)
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&mdash;/g, "\u2014")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  };
  var titles = {};
  var descs = {};
  var checked = 0;
  var longTitles = [];
  var longDescs = [];
  var dupes = [];
  serpPages.forEach(function (page) {
    var full = path.join(ROOT, page);
    if (!fs.existsSync(full)) return;
    var html = fs.readFileSync(full, "utf8");
    var tm = html.match(/<title>([\s\S]*?)<\/title>/);
    var dm = html.match(/<meta name="description" content="([\s\S]*?)">/);
    if (!tm) {
      fail(page + ": no <title>", "every page needs one");
      return;
    }
    /* 404.html, thank-you.html and welcome.html are noindex, nofollow -- they
       never appear in a result page, so there is no snippet for a description
       to fill. Everything indexable must have one. */
    var isNoindex = /<meta name="robots" content="[^"]*noindex/i.test(html);
    if (!dm && !isNoindex) {
      fail(page + ": no meta description", "every indexable page needs one");
      return;
    }
    checked++;
    var t = decode(tm[1]);
    if (t.length > TITLE_MAX) longTitles.push(page + " (" + t.length + "): " + t);
    if (titles[t]) dupes.push("title shared by " + titles[t] + " and " + page);
    else titles[t] = page;
    if (dm) {
      var d = decode(dm[1]);
      if (d.length > DESC_MAX) longDescs.push(page + " (" + d.length + ")");
      if (descs[d]) dupes.push("description shared by " + descs[d] + " and " + page);
      else descs[d] = page;
    }
  });
  /* An empty page list would make every "0 pages over the limit" line below
     pass while examining nothing. */
  if (checked < serpPages.length) {
    fail(
      "SERP text coverage",
      "only " + checked + " of " + serpPages.length + " pages passed the title/description check"
    );
  } else {
    ok("all " + checked + " pages carry a <title>, and every indexable one a description");
  }
  if (longTitles.length) {
    longTitles.forEach(function (t) {
      fail("<title> over " + TITLE_MAX + " chars -- Google will truncate it", t);
    });
  } else if (checked) {
    ok("all " + checked + " titles are within " + TITLE_MAX + " characters");
  }
  if (longDescs.length) {
    longDescs.forEach(function (d) {
      fail("meta description over " + DESC_MAX + " chars -- Google will truncate it", d);
    });
  } else if (checked) {
    ok("all " + checked + " meta descriptions are within " + DESC_MAX + " characters");
  }
  if (dupes.length) {
    dupes.forEach(function (d) {
      fail("duplicate SERP text", d);
    });
  } else if (checked) {
    ok("every title and description is unique across " + checked + " pages");
  }
})();

/* ---------- Milestone 4: Self-Hosted Localization Suite & Static QA Invariants ---------- */
section("Milestone 4: Self-Hosted Localization Suite & Static QA Invariants");
(function checkLocalizationInvariants() {
  // 1. Zero Google Translate domains in deploy configs (_headers, netlify.toml, vercel.json)
  var deployFiles = ["_headers", "netlify.toml", "vercel.json"];
  var forbiddenDomains = [
    "translate.google.com",
    "translate.googleapis.com",
    "translate-pa.googleapis.com"
  ];
  deployFiles.forEach(function (file) {
    var filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) {
      fail(file, "deploy config file missing");
      return;
    }
    var content = fs.readFileSync(filePath, "utf8");
    forbiddenDomains.forEach(function (domain) {
      if (content.indexOf(domain) === -1) {
        ok(file + ": zero occurrences of " + domain);
      } else {
        fail(file + " contains legacy Google Translate domain", domain);
      }
    });
  });

  // 2. CSP byte-parity between _headers, netlify.toml, and vercel.json
  try {
    var cspHeaders = extractHeadersFileCSP();
    var cspVercel = extractVercelCSP();
    var cspNetlify = extractNetlifyCSP();
    if (cspHeaders && cspHeaders === cspVercel && cspVercel === cspNetlify) {
      ok("M4: CSP byte-parity strictly maintained across _headers, vercel.json, and netlify.toml");
    } else {
      fail("M4: CSP drift detected between _headers, vercel.json, and netlify.toml");
    }
  } catch (e) {
    fail("M4: CSP byte-parity check failed", e.message);
  }

  // 3. Zero legacy Google Translate CSS hacks in assets/css/styles.css
  var stylesPath = path.join(ROOT, "assets/css/styles.css");
  if (fs.existsSync(stylesPath)) {
    var stylesContent = fs.readFileSync(stylesPath, "utf8");
    var legacyCssHacks = [
      ".skiptranslate",
      "#google_translate_element",
      ".goog-te-banner-frame",
      "html.translated-ltr body",
      "body.translated-ltr",
      ".goog-te-combo"
    ];
    legacyCssHacks.forEach(function (hack) {
      if (stylesContent.indexOf(hack) === -1) {
        ok("styles.css: zero legacy Google Translate CSS hack (" + hack + ")");
      } else {
        fail("styles.css contains legacy Google Translate CSS hack", hack);
      }
    });
  } else {
    fail("assets/css/styles.css", "missing stylesheet file");
  }

  // 4. assets/data/locales/*.json exist and validate brand glossary terms
  var expectedLocales = ["en", "es", "de", "fr", "ja", "zh"];
  expectedLocales.forEach(function (lang) {
    var localePath = path.join(ROOT, "assets/data/locales", lang + ".json");
    if (fs.existsSync(localePath)) {
      try {
        var parsedLocale = JSON.parse(fs.readFileSync(localePath, "utf8"));
        if (parsedLocale.meta && parsedLocale.meta.code === lang && parsedLocale.phrases) {
          var phraseCount = Object.keys(parsedLocale.phrases).length;
          if (phraseCount >= 40) {
            ok(
              "assets/data/locales/" +
                lang +
                ".json: valid dictionary with " +
                phraseCount +
                " phrases"
            );
          } else {
            fail("assets/data/locales/" + lang + ".json", "too few phrases (" + phraseCount + ")");
          }
        } else {
          fail("assets/data/locales/" + lang + ".json", "invalid schema structure");
        }
      } catch (err) {
        fail("assets/data/locales/" + lang + ".json", "JSON parse error: " + err.message);
      }
    } else {
      fail("assets/data/locales/" + lang + ".json", "locale file not found");
    }
  });

  // Brand glossary validation
  var glossaryPath = path.join(ROOT, "assets/data/brand-glossary.json");
  if (fs.existsSync(glossaryPath)) {
    try {
      var glossary = JSON.parse(fs.readFileSync(glossaryPath, "utf8"));
      if (Array.isArray(glossary.protectedTerms) && glossary.categories && glossary.rules) {
        ok(
          "assets/data/brand-glossary.json: structural schema valid with " +
            glossary.protectedTerms.length +
            " protected terms"
        );
        var requiredTerms = [
          "Y'allternative Living",
          "Porch Sweep",
          "Cathedral Dust",
          "Bless Your Heart",
          "Unbothered",
          "Calendula officinalis",
          "Arnica montana",
          "Boswellia carterii",
          "Lavandula angustifolia",
          "Magnesium chloride"
        ];
        requiredTerms.forEach(function (term) {
          if (glossary.protectedTerms.indexOf(term) !== -1) {
            ok("Brand glossary protects term: " + term);
          } else {
            fail("Brand glossary missing protected term", term);
          }
        });
      } else {
        fail("assets/data/brand-glossary.json", "missing protectedTerms, categories, or rules");
      }
    } catch (err) {
      fail("assets/data/brand-glossary.json", "JSON parse error: " + err.message);
    }
  } else {
    fail("assets/data/brand-glossary.json", "file not found");
  }

  // Locales-data.js compiled bundle validation
  var localesBundlePath = path.join(ROOT, "assets/js/locales-data.js");
  if (fs.existsSync(localesBundlePath)) {
    ok("assets/js/locales-data.js exists on disk");
  } else {
    fail("assets/js/locales-data.js", "missing bundle file -- run npm run build-data");
  }

  /* 5. NO hreflang anywhere.
     The branch that added the translator also advertised five localised
     sites to search engines: x-default + en + five ?lang= alternates on 33
     pages, plus 224 <xhtml:link> elements in sitemap.xml. Every claim was
     false -- /shop.html?lang=es serves the byte-identical English file, with
     an English <title> and <meta description> the client-side engine never
     touches, and it canonicalises away from itself, which is exactly what
     Google's rule says an hreflang alternate must not do. The 2026-09-02
     audit (S5) called it: ship the picker, drop the SEO layer.

     These assertions are the inverse of the ones they replace, and they are
     written so an absent subject fails: the page list is asserted non-empty
     before anything is asserted over it. */
  var allHtmlPages = PAGES.map(function (p) {
    return path.join(ROOT, p);
  });
  var productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir).forEach(function (f) {
      if (f.endsWith(".html")) {
        allHtmlPages.push(path.join(productsDir, f));
      }
    });
  }

  if (allHtmlPages.length >= 30) {
    ok("hreflang scan has " + allHtmlPages.length + " HTML pages to examine");
  } else {
    fail(
      "hreflang scan page list",
      "expected >= 30 pages (13 static + 19 PDPs), found " + allHtmlPages.length
    );
  }

  var hreflangPages = allHtmlPages.filter(function (filePath) {
    return /<link\s+rel="alternate"\s+hreflang=/i.test(fs.readFileSync(filePath, "utf8"));
  });

  if (hreflangPages.length === 0) {
    ok(
      "None of the " +
        allHtmlPages.length +
        " HTML pages carries an hreflang alternate (the ?lang= SEO layer is not shipped)"
    );
  } else {
    fail(
      "Pages still carrying hreflang tags",
      hreflangPages
        .map(function (f) {
          return path.relative(ROOT, f);
        })
        .join("; ") + " -- run npm run build-data, which strips them"
    );
  }

  // 6. sitemap.xml carries canonical URLs only -- no ?lang= alternates.
  var sitemapPath = path.join(ROOT, "sitemap.xml");
  if (fs.existsSync(sitemapPath)) {
    var sitemapContent = fs.readFileSync(sitemapPath, "utf8");

    var locCount = (sitemapContent.match(/<loc>/g) || []).length;
    if (locCount >= 30) {
      ok("sitemap.xml lists " + locCount + " canonical URLs");
    } else {
      fail("sitemap.xml", "expected >= 30 <loc> entries, found " + locCount);
    }

    var xhtmlLinkCount = (sitemapContent.match(/<xhtml:link/g) || []).length;
    if (xhtmlLinkCount === 0) {
      ok("sitemap.xml contains no <xhtml:link> localization alternates");
    } else {
      fail(
        "sitemap.xml alternate links",
        "expected 0 <xhtml:link> elements, found " + xhtmlLinkCount
      );
    }

    if (sitemapContent.indexOf("?lang=") === -1) {
      ok("sitemap.xml references no ?lang= URLs");
    } else {
      fail("sitemap.xml", "still references ?lang= URLs");
    }
  } else {
    fail("sitemap.xml", "file not found");
  }

  // 6b. robots.txt keeps crawlers off the ?lang= duplicates.
  var robotsPath = path.join(ROOT, "robots.txt");
  if (fs.existsSync(robotsPath)) {
    var robotsContent = fs.readFileSync(robotsPath, "utf8");
    if (/^Disallow: \/\*\?lang=$/m.test(robotsContent)) {
      ok("robots.txt disallows /*?lang= (no crawlable duplicate of every page)");
    } else {
      fail("robots.txt", "missing 'Disallow: /*?lang=' -- run npm run build-data");
    }
  } else {
    fail("robots.txt", "file not found");
  }

  // 7. sw.js includes /assets/js/locales-data.js and /assets/js/translator.js in ASSETS_TO_CACHE
  var swPath = path.join(ROOT, "sw.js");
  if (fs.existsSync(swPath)) {
    var swContent = fs.readFileSync(swPath, "utf8");
    if (swContent.indexOf("'/assets/js/locales-data.js'") !== -1) {
      ok("sw.js ASSETS_TO_CACHE includes '/assets/js/locales-data.js'");
    } else {
      fail("sw.js", "missing '/assets/js/locales-data.js' in ASSETS_TO_CACHE");
    }
    if (swContent.indexOf("'/assets/js/translator.js'") !== -1) {
      ok("sw.js ASSETS_TO_CACHE includes '/assets/js/translator.js'");
    } else {
      fail("sw.js", "missing '/assets/js/translator.js' in ASSETS_TO_CACHE");
    }
  } else {
    fail("sw.js", "file not found");
  }
})();

/* ---------- Dictionary coverage ---------- */
section("Localization: dictionary coverage");
(function checkDictionaryCoverage() {
  /* The 2026-09-01 audit found 120 of 206 English dictionary values (58%)
     matching nothing on any page: the dictionary had been authored against an
     imagined shop, and nothing checked it against the real markup. The gate
     that catches that now lives in scripts/build-site-data.js and runs on every
     build; this re-asserts it from the static gate as well, so a dictionary
     edit committed without re-running the build cannot reach CI green. */
  var buildData;
  try {
    buildData = require("./build-site-data.js");
  } catch (err) {
    fail("build-site-data.js", "could not be required: " + err.message);
    return;
  }
  if (typeof buildData.validateDictionaryCoverage !== "function") {
    fail("build-site-data.js", "does not export validateDictionaryCoverage");
    return;
  }

  var LANGS = ["en", "es", "de", "fr", "ja", "zh"];
  var locales = {};
  var loadFailed = false;
  LANGS.forEach(function (lang) {
    try {
      locales[lang] = JSON.parse(
        fs.readFileSync(path.join(ROOT, "assets/data/locales", lang + ".json"), "utf8")
      );
    } catch (err) {
      loadFailed = true;
      fail("assets/data/locales/" + lang + ".json", "unreadable: " + err.message);
    }
  });
  if (loadFailed) return;

  var runtimeManifest = null;
  var basis = null;
  try {
    runtimeManifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/i18n-runtime-strings.json"), "utf8")
    );
  } catch (err) {
    fail("assets/data/i18n-runtime-strings.json", "unreadable: " + err.message);
    return;
  }
  try {
    basis = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/i18n-translation-basis.json"), "utf8")
    );
  } catch (err) {
    fail("assets/data/i18n-translation-basis.json", "unreadable: " + err.message);
    return;
  }

  /* Count the subject before asserting over it: a dictionary that had somehow
     become empty would otherwise sail through every loop below. */
  var keyCount = Object.keys(locales.en.phrases || {}).length;
  if (keyCount >= 300) {
    ok("en.json carries " + keyCount + " dictionary keys");
  } else {
    fail("assets/data/locales/en.json", "only " + keyCount + " keys -- expected 300 or more");
    return;
  }
  var runtimeCount = (runtimeManifest.strings || []).length;
  if (runtimeCount > 0) {
    ok("i18n-runtime-strings.json declares " + runtimeCount + " runtime-only string(s)");
  } else {
    fail("assets/data/i18n-runtime-strings.json", "declares no strings");
  }
  var basisCount = Object.keys(basis.basis || {}).length;
  if (basisCount === keyCount) {
    ok("i18n-translation-basis.json records a basis for all " + basisCount + " key(s)");
  } else {
    fail(
      "assets/data/i18n-translation-basis.json",
      "records " + basisCount + " key(s) but en.json has " + keyCount
    );
  }

  try {
    buildData.validateDictionaryCoverage(locales, runtimeManifest, basis);
    ok(
      "every English dictionary value is reachable in the built site or the runtime " +
        "manifest, every locale is complete, and no English value has drifted from its " +
        "recorded translation basis"
    );
  } catch (err) {
    fail("dictionary coverage", err.message);
  }

  /* The three keys the audit found identical in all five locales
     (pdp.completeTheRitual, pdp.botanicalPairing, quiz.title). They were dead
     entries -- none of those English strings existed on the site -- so they are
     now keyed to the strings the pages really show. Pinned by the real string,
     not by key name, so renaming a key cannot quietly retire the check. */
  var mustDiffer = [
    "✦ COMPLETE THE RITUAL ✦",
    "Pair this item with complementary botanicals crafted to work together.",
    "Find Your Custom Self-Care Match"
  ];
  mustDiffer.forEach(function (englishText) {
    var key = null;
    Object.keys(locales.en.phrases).forEach(function (k) {
      if (locales.en.phrases[k] === englishText) key = k;
    });
    if (!key) {
      fail("dictionary", "no key holds the English string " + JSON.stringify(englishText));
      return;
    }
    var same = LANGS.slice(1).filter(function (lang) {
      return locales[lang].phrases[key] === englishText;
    });
    if (same.length === 0) {
      ok("'" + key + "' is translated in all five non-English locales");
    } else {
      fail("'" + key + "'", "still identical to English in: " + same.join(", "));
    }
  });

  /* The four pages whose body copy stays English carry a line saying so.
     Asserted on the built HTML rather than on a template, because it is the
     shipped page a shopper reads. */
  var LEGAL_PAGES = ["terms.html", "privacy.html", "policies.html", "safety.html"];
  var governsText =
    "Heads up: we keep this page in English on purpose. If your browser or our " +
    "language picker shows it another way, the English text is the one that counts.";
  var governsKey = null;
  Object.keys(locales.en.phrases).forEach(function (k) {
    if (locales.en.phrases[k] === governsText) governsKey = k;
  });
  if (governsKey) {
    ok("the governing-language line is a dictionary entry ('" + governsKey + "')");
    /* It may be translated -- but the translation has to still SAY that the
       English governs, so every locale must name English. Checking for the
       endonym is the cheap version of that and catches the failure that
       matters: a locale that quietly drops the clause or inverts it. */
    var englishWord = {
      es: ["inglés"],
      de: ["Englisch", "englische"],
      fr: ["anglais"],
      ja: ["英語"],
      zh: ["英文", "英语"]
    };
    LANGS.slice(1).forEach(function (lang) {
      var value = locales[lang].phrases[governsKey] || "";
      var hit = englishWord[lang].some(function (w) {
        return value.indexOf(w) !== -1;
      });
      if (hit) {
        ok("the governing-language line still names English in " + lang);
      } else {
        fail(
          "governing-language line [" + lang + "]",
          "does not mention English, so it no longer says the English text governs: " +
            JSON.stringify(value)
        );
      }
    });
  } else {
    fail("dictionary", "no key holds the governing-language line");
  }
  LEGAL_PAGES.forEach(function (page) {
    var p = path.join(ROOT, page);
    if (!fs.existsSync(p)) {
      fail(page, "file not found");
      return;
    }
    var html = fs.readFileSync(p, "utf8");
    if (html.indexOf("legal-lang-note") !== -1 && html.indexOf(governsText) !== -1) {
      ok(page + " states that the English version governs");
    } else {
      fail(page, "missing the 'English version governs' line");
    }
  });
})();

/* ---------- Summary ---------- */
console.log("\n" + "=".repeat(50));
console.log(passCount + " checks passed, " + failures.length + " failed.");
if (failures.length) {
  console.log("\nFAILURES:");
  failures.forEach(function (f) {
    console.log("  - " + f);
  });
  process.exit(1);
} else {
  console.log("All good.");
  process.exit(0);
}
