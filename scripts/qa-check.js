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
     - Snipcart custom-field option strings round-trip parse correctly
       (catches a malformed "Label[+X.XX]" before it ships)
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

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  "journal.html"
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
if (!missingImgs.length) ok("all " + imgRefs.size + " referenced image paths exist on disk");
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
        // Snipcart's "Label[+X.XX]" syntax breaks if the label itself
        // contains a literal "[" or "|" -- catch that before it ships.
        if (/[[\]|]/.test(o.label))
          fail(
            p.id + ": variant option label contains [ ] or | (breaks Snipcart's option syntax)",
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

/* ---------- 7) Snipcart custom-field round-trip ---------- */
section("Snipcart custom-field syntax round-trip");
var snipcartPath = path.join(ROOT, "assets/data/snipcart-products.json");
if (fs.existsSync(snipcartPath)) {
  var snipcartManifest = JSON.parse(fs.readFileSync(snipcartPath, "utf8"));
  snipcartManifest.forEach(function (p) {
    (p.customFields || []).forEach(function (cf) {
      var parts = cf.options.split("|");
      var parsedOk = parts.every(function (part) {
        return /^.+\[[+-]\d+\.\d{2}\]$/.test(part);
      });
      if (parsedOk)
        ok(
          p.id +
            ': customField "' +
            cf.name +
            '" options parse correctly (' +
            parts.length +
            " option(s))"
        );
      else
        fail(
          p.id + ': customField "' + cf.name + "\" options don't match Label[+X.XX] pattern",
          cf.options
        );
    });
  });
} else {
  fail("assets/data/snipcart-products.json", "file missing -- run npm run build-data");
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
  var REQUIRED_CSP_SUBSTRINGS = [
    ["cdn.snipcart.com", "Snipcart (checkout widget)"],
    ["plausible.io", "Plausible (analytics)"],
    ["app.convertkit.com", "Kit/ConvertKit (footer newsletter form, legacy domain)"],
    ["app.kit.com", "Kit/ConvertKit (footer newsletter form, current domain)"],
    ["formspree.io", "Formspree (review submission form)"],
    ["embed.tawk.to", "Tawk.to (live chat script-src)"],
    ["*.tawk.to", "Tawk.to (connect/frame/img-src)"]
  ];
  REQUIRED_CSP_SUBSTRINGS.forEach(function (pair) {
    if (cspText.indexOf(pair[0]) !== -1) ok("CSP includes " + pair[0] + " (" + pair[1] + ")");
    else
      fail(
        "CSP missing " + pair[0],
        pair[1] +
          " is wired into the site but not allowlisted -- it'll be silently blocked by the browser"
      );
  });
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

/* ---------- 16) Gift Up (gift cards) container present ---------- */
section("Gift Up! gift-card container present (shop.html)");
if (/id="giftUpContainer"/.test(shopHtml)) {
  ok("shop.html has #giftUpContainer");
  if (/YOUR_GIFTUP_ID/.test(shopHtml) || /YL:site.giftUpId/.test(shopHtml)) {
    console.log(
      "  (still the placeholder -- expected until Savanna has a real Gift Up! account, see DEVELOPMENT.md section 18)"
    );
  } else {
    ok(
      "placeholder text has been replaced with a real embed (or something else) -- if this is a real Gift Up! snippet, nice"
    );
  }
} else {
  fail(
    "shop.html",
    "#giftUpContainer not found -- gift-card section may have been removed or renamed"
  );
}

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

  // Regression guard: shop.html should link to the FAQ, not duplicate it.
  if (/class="faq-accordion"/.test(shopHtml)) {
    fail(
      "shop.html",
      "still has a .faq-accordion -- the site is only supposed to have one FAQ now (see faq.html); remove the duplicate"
    );
  } else if (/href="faq\.html"/.test(shopHtml)) {
    ok("shop.html links to faq.html instead of duplicating FAQ content");
  } else {
    fail(
      "shop.html",
      'doesn\'t appear to link to faq.html -- the "check our FAQ before checkout" pointer may have been removed'
    );
  }
})();

/* ---------- 19) Bundle pricing in snipcart-products.json matches a
   fresh recompute from products-data.js (catches stale-build drift) ---------- */
section("Bundle pricing matches a fresh recompute (build freshness check)");
if (!BUNDLES.length) {
  console.log("  (no bundles defined -- nothing to freshness-check)");
} else if (!fs.existsSync(snipcartPath)) {
  fail(
    "bundle pricing freshness",
    "assets/data/snipcart-products.json missing -- run npm run build-data"
  );
} else {
  var PRODUCTS_BY_ID_QA = {};
  PRODUCTS.forEach(function (p) {
    PRODUCTS_BY_ID_QA[p.id] = p;
  });
  var snipcartById = {};
  JSON.parse(fs.readFileSync(snipcartPath, "utf8")).forEach(function (item) {
    snipcartById[item.id] = item;
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
    var expectedPrice = Math.round(fullPrice * (1 - (b.discountPercent || 0) / 100) * 100) / 100;
    var snipcartEntry = snipcartById["bundle-" + b.id];
    if (!snipcartEntry) {
      fail("bundle-" + b.id + " missing from snipcart-products.json", "run npm run build-data");
    } else if (Math.abs(snipcartEntry.price - expectedPrice) < 0.001) {
      ok(
        "bundle-" +
          b.id +
          ": snipcart-products.json price ($" +
          snipcartEntry.price.toFixed(2) +
          ") matches fresh recompute from products-data.js"
      );
    } else {
      fail(
        "bundle-" + b.id + " price drift",
        "snipcart-products.json has $" +
          snipcartEntry.price +
          " but products-data.js currently computes $" +
          expectedPrice.toFixed(2) +
          " -- run npm run build-data"
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
  [
    "assets/data/products.json",
    "assets/data/events.json",
    "assets/data/site-reviews.json",
    "assets/data/content.json",
    "assets/data/journal.json",
    "assets/data/social-feed.json"
  ].forEach(function (relPath) {
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
