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
   DEVELOPMENT.md section 20) commits to directly, and a CMS can't write into
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
   netlify.toml / vercel.json) --
   see DEVELOPMENT.md section 20 for why that became necessary once a CMS
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
   2. Bundle referential-integrity check (every bundle's productIds must
      resolve to a real product -- fails the build loudly if not)
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
      every JSON-LD @id/url/image/
      breadcrumb entry, across all 7 pages in one pass -- no more
      manual find-and-replace across the whole site to go live.

   It never touches product PHOTOS -- those still need to be uploaded
   separately (the CMS's Image field handles this for CMS-added
   products; see DEVELOPMENT.md section 20). Safe to run as many times as you
   want.
   ========================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

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
  const full = path.join(ROOT, relPath);
  let raw;
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

function escapeHtml(s) {
  // Escapes the full set of HTML-significant characters, not just &/</>.
  // This runs on data pulled from assets/data/*.json (editable via the
  // Sveltia CMS at /admin) and lands in both text nodes AND attribute
  // values (meta content="...", href="...", og:* tags) -- so a stray
  // unescaped `"` in, say, a product description can break out of an
  // attribute and inject a new one (e.g. content="foo" onmouseover="...").
  // Quotes and backticks must be escaped too, matching attrEsc() in
  // assets/js/main.js and escapeHtml()/escapeAttr() in assets/js/cart.js.
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

function safeUrl(url) {
  // Only lets http(s) and protocol-relative/root-relative links through.
  // ev.url comes from assets/data/events.json (editable via /admin) and is
  // dropped straight into an <a href="..."> -- escapeHtml() alone stops
  // attribute-breakout but not a same-quote-safe `javascript:` URL, which
  // still executes on click. Empty string means "render no link" upstream.
  if (!url) return "";
  const trimmed = String(url).trim();
  if (/^(https?:)?\/\//i.test(trimmed) || /^\//.test(trimmed)) return trimmed;
  return "";
}

/* ---------- Form endpoints (action="...") ----------
   These three live inside a quoted HTML attribute, where a <!--YL:key-->
   marker can't survive: inside an attribute value an HTML comment isn't a
   comment, so the build's final cleanAttributeMarkers() pass deletes it --
   and with it the only hook the NEXT build had to re-inject through. The
   result was the same failure umamiWebsiteId used to have: /admin offers
   "Newsletter Form Link (Kit/ConvertKit)" and "Contact Form Code
   (Formspree)", and filling either one in changed nothing at all -- every
   page kept posting to YOUR_KIT_FORM_ACTION_URL / formspree.io/f/YOUR_FORM_ID
   and main.js kept telling visitors the form isn't connected yet.

   So these match the action attribute on the form's own class instead of a
   marker, which stays re-injectable on every build in BOTH directions:
   clearing the field in /admin restores the placeholder, which is exactly the
   string main.js looks for to show its honest "not connected yet" fallback
   rather than dropping a message on the floor. */

// A Formspree form id is a short token in a URL path. Anything else is a typo
// or an attempt to smuggle markup into an action="" attribute, so fall back
// to the placeholder (= the honest "not wired up yet" state) rather than
// emitting a broken or hostile endpoint.
function formspreeAction(rawId, placeholderId) {
  const id = String(rawId === null || rawId === undefined ? "" : rawId).trim();
  const useId = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : placeholderId;
  return "https://formspree.io/f/" + useId;
}

// Kit/ConvertKit hands out a full https form URL. safeUrl() already rejects
// javascript:/data:, and the placeholder is kept for anything else.
function newsletterAction(rawUrl, placeholder) {
  const url = safeUrl(rawUrl);
  return url && url !== placeholder ? escapeHtml(url) : placeholder;
}

// Rewrite the action="" of every <form> carrying `className`. Class matching
// is by whole token, so "contact-form" never matches "contact-form-col".
function setFormAction(html, className, actionValue) {
  return html.replace(/<form\b[^>]*>/g, function (tag) {
    const classAttr = /\sclass="([^"]*)"/.exec(tag);
    if (!classAttr || classAttr[1].trim().split(/\s+/).indexOf(className) === -1) return tag;
    if (!/\saction="/.test(tag)) return tag;
    return tag.replace(/(\saction=")[^"]*(")/, function (m, pre, post) {
      return pre + actionValue + post;
    });
  });
}

function slugify(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateUniqueId(existingSet, rawName, fallbackPrefix, index) {
  const base = slugify(rawName) || fallbackPrefix + "-" + (index + 1);
  let candidate = base;
  let counter = 2;
  while (existingSet.has(candidate)) {
    candidate = base + "-" + counter;
    counter++;
  }
  existingSet.add(candidate);
  return candidate;
}
/* A bundle's real price is always computed from its real component
   products' base prices -- never hand-set -- so it's impossible for a
   bundle's price to silently drift out of sync after a product's price
   changes. Returns null (and lets the caller decide how to fail loudly)
   if a bundle references a product ID that doesn't exist. */
function bundlePricing(b, productsMap) {
  const map = productsMap || PRODUCTS_BY_ID || {};
  const missing = b.productIds.filter(function (id) {
    return !map[id];
  });
  if (missing.length) return null;
  const fullPrice = b.productIds.reduce(function (sum, id) {
    const original = map[id].originalPrice || map[id].price;
    return sum + original;
  }, 0);
  const bundlePrice = Math.round(fullPrice * (1 - (b.discountPercent || 0) / 100) * 100) / 100;
  return { fullPrice: fullPrice, bundlePrice: bundlePrice };
}

function readText(relPath, label) {
  const full = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (e) {
    console.error("\n[build] Could not read " + (label || relPath) + ": " + e.message);
    process.exit(1);
  }
}

// The YL:key injection markers are HTML comments. Inside element text (and
// CSS /* */ context) they're invisible and are kept so the build can re-run
// idempotently. But when a templated value lands inside a real HTML ATTRIBUTE
// value (placeholder="...", href="mailto:...", action="..."), an HTML comment
// is NOT a comment -- it renders as literal text ("<!--YL:contact.name...-->")
// in the field, or breaks a mailto:/action URL. Strip the markers that sit
// inside a double-quoted attribute value, keeping the value itself. Element-
// text markers (between tags) are left untouched so re-injection still works.
function stripMarkersInsideAttributes(html) {
  return html.replace(/(=")([^"]*)(")/g, function (m, pre, val, post) {
    if (val.indexOf("<!--YL:") === -1 && val.indexOf("<!--/YL:") === -1) return m;
    return pre + val.replace(/<!--\/?YL:[^>]*?-->/g, "") + post;
  });
}

function writeFile(relPath, contents) {
  const full = path.join(ROOT, relPath);
  const dir = path.dirname(full);
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

/* ---------- Variant helpers ---------- */
function variantPriceRange(p) {
  if (!p.variants || !Array.isArray(p.variants.options) || !p.variants.options.length) {
    return { low: p.price, high: p.price, offerCount: 1 };
  }
  // Sold-out options are excluded: a sold-out size's price shouldn't set the
  // advertised low/high or be counted as a live offer. If every option is
  // sold out, fall back to the full list so the JSON-LD still carries a sane
  // price range (the shop page itself renders the product as Sold Out).
  const available = p.variants.options.filter(function (o) {
    return !o.soldOut;
  });
  const pool = available.length ? available : p.variants.options;
  const prices = pool.map(function (o) {
    return p.price + (o.priceDelta || 0);
  });
  return {
    low: Math.min.apply(null, prices),
    high: Math.max.apply(null, prices),
    offerCount: pool.length
  };
}

let PRODUCTS_BY_ID = {};

function buildSiteData() {
  PRODUCTS_BY_ID = {};
  const CATALOG = readJson("assets/data/products.json");
  const PRODUCTS = CATALOG.products;
  const BUNDLES = CATALOG.bundles || [];
  const FAQ = CATALOG.faq || [];
  // Markets/Pride dates: assets/data/events.json is now the canonical, CMS-edited
  // source (plain JSON, editable at /admin); assets/js/events-data.js -- the
  // window.YL_EVENTS global the pages load -- is GENERATED from it below, exactly
  // like products.json -> products-data.js. (Previously events-data.js was the
  // hand-edited source; flipped so Savanna can edit dates in the /admin editor.)
  const EVENTS = readJson("assets/data/events.json");
  // Customer reviews: assets/data/site-reviews.json is the canonical, CMS-edited
  // source (Savanna approves + adds reviews at /admin); assets/js/site-reviews-data.js
  // -- the window.YL_SITE_REVIEWS global shop.html loads -- is generated from it
  // below. These are NEVER folded into aggregateRating JSON-LD (reserved for
  // genuine Etsy-verified ratings only).
  try {
    const { syncSocialFeed } = require("./sync-social-feed");
    syncSocialFeed();
  } catch (e) {
    /* fallback if missing */
  }

  const SITE_REVIEWS = readJson("assets/data/site-reviews.json").reviews || [];
  const JOURNAL = readJson("assets/data/journal.json");
  const SOCIAL_FEED = readJson("assets/data/social-feed.json");
  const CONTENT = readJson("assets/data/content.json");
  const SITE_CONFIG = CONTENT.site || {};

  /* 1. Process Categories & Guards */
  const CATEGORY_IDS = new Set();
  const CATEGORY_LABEL = {};
  (CATALOG.categories || []).forEach(function (c, idx) {
    if (!c.id) {
      if (!c.label) {
        console.error(
          "\n[build] Category at index " + idx + " in products.json has no label or id."
        );
        process.exit(1);
      }
      c.id = generateUniqueId(CATEGORY_IDS, c.label, "category", idx);
    } else {
      if (CATEGORY_IDS.has(c.id)) {
        console.error("\n[build] Duplicate category ID found: '" + c.id + "'.");
        process.exit(1);
      }
      CATEGORY_IDS.add(c.id);
    }
    CATEGORY_LABEL[c.id] = c.label;
  });

  /* 2. Process Products & Guards */
  PRODUCTS_BY_ID = {};
  const USED_PRODUCT_IDS = new Set();
  const SALES = CATALOG.sales || [];
  const salesByCategory = {};
  SALES.forEach(function (s) {
    salesByCategory[s.category] = s;
  });

  PRODUCTS.forEach(function (p, idx) {
    if (!p.id) {
      if (!p.name) {
        console.error("\n[build] Product at index " + idx + " in products.json has no name or id.");
        process.exit(1);
      }
      p.id = generateUniqueId(USED_PRODUCT_IDS, p.name, "product", idx);
    } else {
      if (USED_PRODUCT_IDS.has(p.id)) {
        console.error(
          "\n[build] Duplicate product ID found: '" + p.id + "' on product '" + p.name + "'."
        );
        process.exit(1);
      }
      USED_PRODUCT_IDS.add(p.id);
    }
    PRODUCTS_BY_ID[p.id] = p;

    if (p.category && !CATEGORY_IDS.has(p.category)) {
      console.warn(
        "\n[build] Warning: Product '" +
          (p.name || p.id) +
          "' specifies unknown category '" +
          p.category +
          "'."
      );
    }

    // Sale baking below is mirrored by qa-check.js's products-data.js
    // freshness check AND workers/checkout.js's applySales() (the Worker
    // fetches the raw products.json, so it must bake sales itself before
    // validating checkout prices) -- change one, change all three.
    if (p.sale && p.sale.price) {
      p.originalPrice = p.price;
      p.price = p.sale.price;
    } else if (salesByCategory[p.category]) {
      const catSale = salesByCategory[p.category];
      p.originalPrice = p.price;
      p.price = Math.round(p.price * (1 - catSale.percentOff / 100) * 100) / 100;
      p.sale = { label: catSale.label };
    }
  });

  /* 3. Process Bundles & Guards */
  const USED_BUNDLE_IDS = new Set();
  BUNDLES.forEach(function (b, idx) {
    if (!b.id) {
      if (!b.name) {
        console.error("\n[build] Bundle at index " + idx + " in products.json has no name or id.");
        process.exit(1);
      }
      b.id = generateUniqueId(USED_BUNDLE_IDS, b.name, "bundle", idx);
    } else {
      if (USED_BUNDLE_IDS.has(b.id)) {
        console.error("\n[build] Duplicate bundle ID found: '" + b.id + "'.");
        process.exit(1);
      }
      USED_BUNDLE_IDS.add(b.id);
    }
  });

  /* 4. Process Reviews & Guards */
  const USED_REVIEW_IDS = new Set();
  SITE_REVIEWS.forEach(function (r, idx) {
    if (!r.id) {
      r.id = generateUniqueId(USED_REVIEW_IDS, r.name, "review", idx);
    } else {
      USED_REVIEW_IDS.add(r.id);
    }
  });

  /* 5. Process Journal Posts & Guards */
  const USED_JOURNAL_IDS = new Set();
  ((JOURNAL && JOURNAL.posts) || []).forEach(function (post, idx) {
    if (!post.id) {
      if (!post.title) {
        console.error(
          "\n[build] Journal post at index " + idx + " in journal.json has no title or id."
        );
        process.exit(1);
      }
      post.id = generateUniqueId(USED_JOURNAL_IDS, post.title, "post", idx);
    } else {
      USED_JOURNAL_IDS.add(post.id);
    }
  });

  /* 6. Process Social Feed & Guards */
  const USED_SOCIAL_IDS = new Set();
  ((SOCIAL_FEED && SOCIAL_FEED.posts) || []).forEach(function (post, idx) {
    if (!post.id) {
      const captionSnippet = post.caption ? post.caption.slice(0, 30) : "";
      post.id = generateUniqueId(USED_SOCIAL_IDS, captionSnippet, "social", idx);
    } else {
      USED_SOCIAL_IDS.add(post.id);
    }
  });

  /* 7. Auto-Archive Past Events & Sort Upcoming Events Chronologically */
  const todayStr = new Date().toISOString().slice(0, 10);
  if (EVENTS && Array.isArray(EVENTS.upcoming)) {
    const stillUpcoming = [];
    EVENTS.upcoming.forEach(function (evt) {
      // Multi-day events stay "upcoming" through their final day: archive by
      // endDate when present, otherwise by the single date.
      const evtCutoff = evt.endDate || evt.date;
      if (evtCutoff && evtCutoff < todayStr) {
        EVENTS.past = EVENTS.past || [];
        // Carry the dates across. main.js sorts "Where We've Been"
        // most-recent-first and falls back to 1970-01-01 for a dateless
        // entry, so dropping `date` here used to bury the market that JUST
        // happened at the bottom of the list -- past the 3-card carousel,
        // i.e. off the page entirely -- and left events.html rendering an
        // empty <time datetime="">.
        EVENTS.past.unshift({
          date: evt.date,
          endDate: evt.endDate,
          dateLabel: evt.dateLabel,
          name: evt.name,
          type: evt.type,
          location: evt.location,
          url: evt.url,
          note: evt.note
        });
      } else {
        stillUpcoming.push(evt);
      }
    });
    EVENTS.upcoming = stillUpcoming;
    EVENTS.upcoming.sort(function (a, b) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
  }

  /* 8. Auto-Calculate Estimated Reading Time for Journal Posts */
  if (JOURNAL && Array.isArray(JOURNAL.posts)) {
    JOURNAL.posts.forEach(function (post) {
      if (post.content && !post.readTime) {
        const wordCount = post.content.trim().split(/\s+/).length;
        const mins = Math.max(1, Math.ceil(wordCount / 200));
        post.readTime = mins + " min read";
      }
    });
  }

  // There's no live domain yet -- every generated absolute URL below uses this
  // placeholder. Update this ONE constant (and re-run the script) once a real
  // domain exists, instead of hand-editing every file again.
  const DOMAIN = "https://yallternativeliving.com";
  /* ---------- 1) assets/js/products-data.js ----------
   A thin `window.YL_PRODUCTS = ...;` wrapper around the exact same data
   in assets/data/products.json (the real, canonical, CMS-edited source
   -- see the big comment at the top of this file). Pages load this
   generated .js file directly as a plain <script> tag (no build step,
   works instantly off file://) rather than fetch()-ing the JSON, which
   would need a real HTTP server and CORS headers just to open the site
   locally. Never hand-edit this file -- edit products.json instead (by
   hand, or through the CMS at /admin) and re-run this script. */
  const productsDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated shop products catalog source of truth.\n" +
    " * Wrap of assets/data/products.json into a global variable YL_PRODUCTS.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_PRODUCTS = " +
    JSON.stringify(CATALOG, null, 2) +
    ";\n";
  writeFile("assets/js/products-data.js", productsDataJs);

  /* ---------- 1b) assets/js/events-data.js ----------
   window.YL_EVENTS wrapper around assets/data/events.json (the canonical,
   CMS-edited source for markets/Pride dates). Pages load this generated file
   directly. Never hand-edit it -- edit events.json (by hand, or via /admin)
   and re-run this script. */
  const eventsDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated events and markets appearances data.\n" +
    " * Wrap of assets/data/events.json into a global variable YL_EVENTS.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_EVENTS = " +
    JSON.stringify(EVENTS, null, 2) +
    ";\n";
  writeFile("assets/js/events-data.js", eventsDataJs);

  /* ---------- 1c) assets/js/site-reviews-data.js ----------
   window.YL_SITE_REVIEWS wrapper around assets/data/site-reviews.json (the
   canonical, CMS-edited source). Generated -- never hand-edit; edit
   site-reviews.json (by hand, or via /admin) and re-run this script. */
  const reviewsDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated site-submitted customer reviews data.\n" +
    " * Wrap of assets/data/site-reviews.json into a global variable YL_SITE_REVIEWS.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_SITE_REVIEWS = " +
    JSON.stringify(SITE_REVIEWS, null, 2) +
    ";\n";
  writeFile("assets/js/site-reviews-data.js", reviewsDataJs);

  /* ---------- assets/js/content-data.js ----------
   window.YL_CONTENT wrapper around assets/data/content.json.

   assets/js/cart.js and assets/js/main.js already read
   window.YL_CONTENT.site to decide whether loyalty points and local market
   pick-up are switched on -- but nothing ever emitted that global, so those
   reads always saw undefined. Both gates are written defensively as
   `site.enableX !== false`, which means undefined evaluated to TRUE and the
   features were permanently on: flipping either toggle in the CMS did
   nothing at all. Emitting the file makes those two switches real, and gives
   any future runtime flag a single place to come from. */
  const contentDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated site content/config.\n" +
    " * Wrap of assets/data/content.json into a global variable YL_CONTENT.\n" +
    " * Do not hand-edit this file -- edit assets/data/content.json (or use\n" +
    " * the CMS at /admin) and re-run scripts/build-site-data.js.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_CONTENT = " +
    JSON.stringify(CONTENT, null, 2) +
    ";\n";
  writeFile("assets/js/content-data.js", contentDataJs);

  const journalDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated Apothecary Journal data.\n" +
    " * Wrap of assets/data/journal.json into a global variable YL_JOURNAL.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_JOURNAL = " +
    JSON.stringify(JOURNAL, null, 2) +
    ";\n";
  writeFile("assets/js/journal-data.js", journalDataJs);

  const socialFeedDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated Social Feed data.\n" +
    " * Wrap of assets/data/social-feed.json into a global variable YL_SOCIAL_FEED.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_SOCIAL_FEED = " +
    JSON.stringify(SOCIAL_FEED, null, 2) +
    ";\n";
  writeFile("assets/js/social-feed-data.js", socialFeedDataJs);

  /* ---------- 2) Bundle referential integrity check ----------
   Every bundle in products.json's `bundles` array (each its own single
   cart line item, id "bundle-<id>", at a computed discounted price --
   simpler and less error-prone at checkout than trying to add multiple
   separate items with a cart-level percent-off) must reference real
   product IDs. Fail the build loudly here rather than let a typo'd
   productId silently produce a broken/undiscounted bundle at checkout. */
  BUNDLES.forEach(function (b) {
    if (!bundlePricing(b)) {
      throw new Error(
        'Bundle "' +
          b.id +
          "\" references a productId that doesn't exist in products-data.js -- fix before building."
      );
    }
  });

  /* ---------- 3) shop.html Product/ItemList JSON-LD ---------- */
  const itemListElement = PRODUCTS.map(function (p, i) {
    // Schema.org's Product.image accepts either a single URL or an array --
    // include every real photo (hero + any extra gallery shots) when a
    // product has them, so search engines can surface more than one photo.
    // Normalize a leading "/" (the CMS public_folder writes "/assets/img/x.jpg",
    // hand-entered paths are relative "assets/img/x.jpg") so DOMAIN + "/" + img
    // never produces a double-slash "domain.com//assets/img" URL in the JSON-LD.
    const allPhotos = [p.image].concat(Array.isArray(p.images) ? p.images : []).map(function (img) {
      return String(img).replace(/^\/+/, "");
    });
    const imageField =
      allPhotos.length > 1
        ? allPhotos.map(function (img) {
            return DOMAIN + "/" + img;
          })
        : DOMAIN + "/" + allPhotos[0];
    // Variants that actually change the price (e.g. a bigger size) get an
    // AggregateOffer with a real low/high range instead of a single Offer --
    // same-price variants (a size-only or scent-only pick) don't need one.
    const range = variantPriceRange(p);
    const offers =
      range.low === range.high
        ? {
            "@type": "Offer",
            price: range.low.toFixed(2),
            priceCurrency: "USD",
            url: DOMAIN + "/shop.html",
            availability:
              p.image && p.image.indexOf("placeholder") !== -1
                ? "https://schema.org/PreOrder"
                : "https://schema.org/InStock",
            seller: { "@type": "Organization", name: "Y'allternative Living" }
          }
        : {
            "@type": "AggregateOffer",
            lowPrice: range.low.toFixed(2),
            highPrice: range.high.toFixed(2),
            priceCurrency: "USD",
            offerCount: range.offerCount,
            url: DOMAIN + "/shop.html",
            availability:
              p.image && p.image.indexOf("placeholder") !== -1
                ? "https://schema.org/PreOrder"
                : "https://schema.org/InStock",
            seller: { "@type": "Organization", name: "Y'allternative Living" }
          };
    const productLd = {
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
  const shopJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Y'allternative Living | Full Shop Catalog",
    itemListElement: itemListElement
  };
  let shopHtml = readText("shop.html", "shop page");

  // Generate and inject the full $10 to $500 options string for the Gift Card button
  const giftCardOptionsList = [];
  for (let val = 10; val <= 500; val++) {
    const delta = val - 10;
    giftCardOptionsList.push("Preset $" + val + "[+" + delta.toFixed(2) + "]");
  }
  const giftCardOptionsStr = giftCardOptionsList.join("|");
  const optionsPlaceholderRe =
    /data-item-custom1-options="Preset \$10\[\+0\.00\].*?Preset \$500\[\+490\.00\]"/;
  if (optionsPlaceholderRe.test(shopHtml)) {
    shopHtml = shopHtml.replace(
      optionsPlaceholderRe,
      'data-item-custom1-options="' + giftCardOptionsStr + '"'
    );
  }

  const NUMBER_WORDS = [
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
  const productCount = CATALOG.products.filter(function (p) {
    return p.image && p.image.indexOf("placeholder") === -1 && p.id !== "yallternative-gift-card";
  }).length;
  const productCountWord = NUMBER_WORDS[productCount] || String(productCount);

  shopHtml = shopHtml.replace(
    /Shop \d+ handmade goods/,
    "Shop " + productCount + " handmade goods"
  );
  shopHtml = shopHtml.replace(
    /\b\d+ handmade goods across/g,
    productCount + " handmade goods across"
  );

  const countMarkerRe = /(<!--YL:productCount-->)\d+(<!--\/YL:productCount-->)/;
  if (countMarkerRe.test(shopHtml)) {
    shopHtml = shopHtml.replace(countMarkerRe, "$1" + productCount + "$2");
  }

  const wordMarkerRe = /(<!--YL:productCountWord-->)[A-Za-z]+(<!--\/YL:productCountWord-->)/;
  if (wordMarkerRe.test(shopHtml)) {
    shopHtml = shopHtml.replace(wordMarkerRe, "$1" + productCountWord + "$2");
  }

  const shopBlockRe =
    /<script type="application\/ld\+json">\n\{\n\s*"@context": "https:\/\/schema\.org",\n\s*"@type": "ItemList"[\s\S]*?\n<\/script>/;
  if (!shopBlockRe.test(shopHtml)) {
    throw new Error(
      "Could not find the ItemList JSON-LD block in shop.html -- aborting so nothing gets corrupted. Check the block still starts with @type: ItemList."
    );
  }
  const newBlock =
    '<script type="application/ld+json">\n' + JSON.stringify(shopJsonLd, null, 2) + "\n</script>";
  shopHtml = shopHtml.replace(shopBlockRe, function () {
    return newBlock;
  });

  const shopFaqLd = {
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
  const faqLdBlockRe =
    /<script type="application\/ld\+json">\n\{\n\s*"@context": "https:\/\/schema\.org",\n\s*"@type": "FAQPage"[\s\S]*?\n<\/script>/;
  let newFaqLdBlock =
    '<script type="application/ld+json">\n' + JSON.stringify(shopFaqLd, null, 2) + "\n</script>";

  if (faqLdBlockRe.test(shopHtml)) {
    shopHtml = shopHtml.replace(faqLdBlockRe, function () {
      return newFaqLdBlock;
    });
  } else {
    shopHtml = shopHtml.replace("</head>", function () {
      return "\n  " + newFaqLdBlock + "\n</head>";
    });
  }

  const shopFaqMarkerRe = /(<!-- SHOP_FAQ:START -->)[\s\S]*?(<!-- SHOP_FAQ:END -->)/;
  if (!shopFaqMarkerRe.test(shopHtml)) {
    throw new Error(
      "Could not find SHOP_FAQ:START/SHOP_FAQ:END markers in shop.html -- aborting so nothing gets corrupted."
    );
  }
  const topFaq = FAQ.slice(0, 5);
  const shopFaqAccordionHtml =
    '      <div class="faq-accordion">\n' +
    topFaq
      .map(function (item) {
        const escQuestion = escapeHtml(item.question);
        const escAnswer = escapeHtml(item.answer);
        const renderedAnswer = escAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        return (
          '        <details class="faq-accordion-item">\n' +
          '          <summary class="faq-accordion-summary">' +
          escQuestion +
          "</summary>\n" +
          '          <div class="faq-accordion-content">\n' +
          "            <p>" +
          renderedAnswer +
          "</p>\n" +
          "          </div>\n" +
          "        </details>"
        );
      })
      .join("\n") +
    "\n      </div>";

  shopHtml = shopHtml.replace(shopFaqMarkerRe, function (m, start, end) {
    return start + "\n" + shopFaqAccordionHtml + "\n      " + end;
  });

  writeFile("shop.html", shopHtml);

  /* ---------- 4) faq.html FAQ (JSON-LD + visible prose) ----------
   The site's ONE FAQ. products-data.js's "faq" array is the only place
   to add/edit/reorder a question -- this generates both the FAQPage
   JSON-LD and the visible Q&A prose in faq.html's .contact-faq block from
   it, so the two can never drift out of sync with each other again. */
  let faqHtml = readText("faq.html", "FAQ page");

  const faqJsonLd = {
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
  if (!faqLdBlockRe.test(faqHtml)) {
    throw new Error(
      "Could not find the FAQPage JSON-LD block in faq.html -- aborting so nothing gets corrupted. Check the block still starts with @type: FAQPage."
    );
  }
  newFaqLdBlock =
    '<script type="application/ld+json">\n' + JSON.stringify(faqJsonLd, null, 2) + "\n</script>";
  faqHtml = faqHtml.replace(faqLdBlockRe, function () {
    return newFaqLdBlock;
  });

  const faqVisibleHtml = FAQ.map(function (item, i) {
    const escAnswer = escapeHtml(item.answer);
    const renderedAnswer = escAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const block =
      '        <div class="reveal">\n' +
      "          <h2>" +
      escapeHtml(item.question) +
      "</h2>\n" +
      "          <p>" +
      renderedAnswer +
      "</p>\n" +
      "        </div>";
    return i < FAQ.length - 1 ? block + '\n        <hr class="rule">\n' : block;
  }).join("\n");
  const faqMarkerRe = /(<!-- FAQ:START[\s\S]*?-->)[\s\S]*?(<!-- FAQ:END -->)/;
  if (!faqMarkerRe.test(faqHtml)) {
    throw new Error(
      "Could not find the FAQ:START/FAQ:END markers in faq.html's .contact-faq block -- aborting so nothing gets corrupted."
    );
  }
  faqHtml = faqHtml.replace(faqMarkerRe, function (m, start, end) {
    return start + "\n" + faqVisibleHtml + "\n        " + end;
  });

  writeFile("faq.html", faqHtml);

  /* ---------- 4b) events.html Past Events Pre-population ---------- */
  let eventsHtml = readText("events.html", "events page");
  const eventsJson = readJson("assets/data/events.json");

  const rawUpcoming = eventsJson.upcoming || [];
  const rawPast = eventsJson.past || [];
  const buildTodayStr = new Date().toISOString().slice(0, 10);

  const upcoming = [];
  const past = [];

  rawUpcoming.forEach(function (ev) {
    const evCutoff = ev.endDate || ev.date;
    if (evCutoff && evCutoff < buildTodayStr) {
      past.push(ev);
    } else {
      upcoming.push(ev);
    }
  });

  rawPast.forEach(function (ev) {
    past.push(ev);
  });

  const sortedPast = past.slice().sort(function (a, b) {
    const dateA = a.date || "1970-01-01";
    const dateB = b.date || "1970-01-01";
    return new Date(dateB) - new Date(dateA);
  });

  const displayPast = sortedPast.slice(0, 3);

  let pastEventsHtml = "";
  if (displayPast.length) {
    pastEventsHtml =
      '        <div class="events-carousel-inner">\n' +
      displayPast
        .map(function (ev, index) {
          const activeClass = index === 0 ? "active" : "";
          const cardCat = ev.type
            ? '              <span class="card-cat">' + escapeHtml(ev.type) + "</span>\n"
            : "";
          const cardNote = ev.note
            ? '              <p class="event-desc">' + escapeHtml(ev.note) + "</p>\n"
            : "";
          const evUrl = safeUrl(ev.url);
          const cardUrl = evUrl
            ? '              <div class="event-cta">\n' +
              '                <a class="btn btn-primary btn-sm btn-block" href="' +
              escapeHtml(evUrl) +
              '" target="_blank" rel="noopener">More Info / RSVP<span class="sr-only"> (opens in new tab)</span></a>\n' +
              "              </div>\n"
            : "";
          return (
            '          <article class="card event-card ' +
            activeClass +
            '">\n' +
            '            <div class="card-body">\n' +
            cardCat +
            "              <h3>" +
            escapeHtml(ev.name) +
            "</h3>\n" +
            '              <p class="event-date"><time datetime="' +
            (ev.date || "") +
            '">📅 ' +
            escapeHtml(ev.dateLabel) +
            "</time></p>\n" +
            '              <p class="event-location">' +
            (ev.location ? "📍 " + escapeHtml(ev.location) : "") +
            "</p>\n" +
            cardNote +
            cardUrl +
            "            </div>\n" +
            "          </article>"
          );
        })
        .join("\n") +
      "\n        </div>";
  } else {
    pastEventsHtml =
      '        <p class="muted center">No past pop-ups logged yet. Check back soon.</p>';
  }

  const pastEventsRe = /(<!-- PAST_EVENTS:START -->)[\s\S]*?(<!-- PAST_EVENTS:END -->)/;
  if (!pastEventsRe.test(eventsHtml)) {
    throw new Error("Could not find PAST_EVENTS:START/PAST_EVENTS:END markers in events.html");
  }
  eventsHtml = eventsHtml.replace(pastEventsRe, function (m, start, end) {
    return start + "\n" + pastEventsHtml + "\n        " + end;
  });

  writeFile("events.html", eventsHtml);

  // shop.html no longer contains a duplicated visible FAQ accordion (now links directly to faq.html)

  /* ---------- Page copy (index.html + about.html + contact.html + shop.html) ----------
   The homepage headline/intro, the About story, and page images are marker-delimited
   in those pages and filled in here from assets/data/content.json.
   If the key is an image, we resolve its AVIF/WebP responsive sources using the
   manifest generated by scripts/optimize-images.js. */
  let MANIFEST = {};
  try {
    const manifestText = fs.readFileSync(path.join(ROOT, "assets/js/image-manifest.js"), "utf8");
    const startMarker = "window.YL_IMAGES =";
    const markerIdx = manifestText.indexOf(startMarker);
    if (markerIdx !== -1) {
      let jsonText = manifestText.substring(
        manifestText.indexOf("{", markerIdx),
        manifestText.lastIndexOf("}") + 1
      );
      // image-manifest.js is a JS object literal with UNQUOTED keys
      // (key:, width:, variants:, ...), which is not valid JSON. The old
      // JSON.parse here always threw and was swallowed by the catch below,
      // leaving MANIFEST empty -- so every content.json page-copy image
      // (homepage hero/feature, About bio/secondary, Contact photo, gift
      // card bg) was emitted with NO <picture> sources and served the full
      // raw JPEG. Quote the bare identifier keys first so it parses.
      jsonText = jsonText.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
      MANIFEST = JSON.parse(jsonText);
    }
  } catch (e) {
    // Surface a real parse failure instead of silently shipping unoptimized
    // page-copy images; a genuinely missing manifest still leaves MANIFEST {}.
    if (fs.existsSync(path.join(ROOT, "assets/js/image-manifest.js"))) {
      console.warn(
        "[build] WARNING: could not parse image-manifest.js -- page-copy images will not get responsive sources:",
        e.message
      );
    }
  }

  function injectPageCopy(page, pageKey) {
    let html = readText(page, page + " page");
    const section = CONTENT[pageKey] || {};
    // Flatten nested content objects into dotted marker keys so page copy can
    // be organized into grouped sub-objects in /admin (e.g. home.badges.badge1)
    // while still resolving to <!--YL:home.badges.badge1--> markers here.
    const __flat = [];
    (function walk(obj, prefix) {
      Object.keys(obj).forEach(function (k) {
        const v = obj[k];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          walk(v, prefix + "." + k);
          return;
        }
        __flat.push({ dotted: prefix + "." + k, leaf: k, value: v });
      });
    })(section, pageKey);
    __flat.forEach(function (entry) {
      const key = entry.leaf;
      const raw = String(entry.value);
      const isImage =
        [
          "heroImage",
          "featureImage",
          "bioImage",
          "secondaryImage",
          "image",
          "giftCardImage",
          "logoDesktop",
          "logoMobile",
          "ogImage"
        ].indexOf(key) !== -1;
      const m = "YL:" + entry.dotted.replace(/\./g, "\\.");

      if (isImage) {
        // The value comes from the CMS and is dropped into a src="..." attr
        // and a CSS url('...'), so strip anything that could break out of
        // either quoting context (quotes, angle brackets, parens, backticks,
        // backslashes, whitespace). A real image path never needs them.
        const imgPath = raw.replace(/^\/+/, "").replace(/["'`<>()\\\s]/g, "");
        const imgManifestEntry = MANIFEST[imgPath];

        const reHtml = new RegExp("(<!--" + m + "-->)[\\s\\S]*?(<!--/" + m + "-->)");
        const reCss = new RegExp(
          "(\\/\\*" + m + "\\*\\/)[\\s\\S]*?(\\/\\*(?:\\\\|\\/)?" + m + "\\*\\/)"
        );

        if (reHtml.test(html)) {
          html = html.replace(reHtml, function (match, open, close) {
            // Parse sizes attribute from the original block
            const sizesMatch = match.match(/sizes="([^"]*)"/i) || match.match(/sizes='([^']*)'/i);
            const sizes = sizesMatch ? sizesMatch[1] : "";

            // Extract the original <img> tag exactly as written
            const imgTagMatch = match.match(/<img\s+[^>]+>/i);
            let imgTag = imgTagMatch ? imgTagMatch[0] : "";

            // Replace ONLY the src attribute of the <img> tag, leaving all other custom/native attributes untouched
            if (imgTag) {
              imgTag = imgTag.replace(/(\bsrc=['"])[^'"]*(['"])/i, function (m, p1, p2) {
                return p1 + imgPath + p2;
              });
            } else {
              imgTag = '<img src="' + imgPath + '">';
            }

            const isPicture = /<picture/i.test(match);
            let innerTag = "";

            if (isPicture) {
              let avifSrcset = "";
              let webpSrcset = "";
              if (imgManifestEntry && imgManifestEntry.variants) {
                avifSrcset = imgManifestEntry.variants.avif
                  .map(function (v) {
                    return v.file + " " + v.width + "w";
                  })
                  .join(", ");
                webpSrcset = imgManifestEntry.variants.webp
                  .map(function (v) {
                    return v.file + " " + v.width + "w";
                  })
                  .join(", ");
              } else {
                // No optimized variants in the image manifest for this file.
                // Leave both srcsets empty so no <source> tags are emitted --
                // the old fallback put the original file (often a .jpg) inside
                // <source type="image/avif">/<source type="image/webp">, which
                // mislabels the format and makes browsers pick a "modern" source
                // that's really the unoptimized original.
                avifSrcset = "";
                webpSrcset = "";
              }

              innerTag = "<picture>";
              if (avifSrcset) {
                innerTag += '\n            <source type="image/avif" srcset="' + avifSrcset + '"';
                if (sizes) innerTag += ' sizes="' + sizes + '"';
                innerTag += ">";
              }
              if (webpSrcset) {
                innerTag += '\n            <source type="image/webp" srcset="' + webpSrcset + '"';
                if (sizes) innerTag += ' sizes="' + sizes + '"';
                innerTag += ">";
              }
              innerTag += "\n            " + imgTag;
              innerTag += "\n          </picture>";
            } else {
              innerTag = imgTag;
            }

            return open + "\n          " + innerTag + "\n          " + close;
          });
        } else if (reCss.test(html)) {
          html = html.replace(reCss, function (match) {
            // Replace ONLY the url() property inside the CSS block, preserving other background attributes (e.g. no-repeat center center / cover)
            return match.replace(/url\(['"]?[^'")]+['"]?\)/i, function () {
              return "url('" + imgPath + "')";
            });
          });
        }
      } else {
        const rendered =
          key === "bio" || key === "body" || /\n\s*\n/.test(raw)
            ? raw
                .split(/\n\s*\n/)
                .map(function (para) {
                  return "<p>" + escapeHtml(para.trim()) + "</p>";
                })
                .join("\n          ")
            : escapeHtml(raw);
        const re = new RegExp("(<!--" + m + "-->)[\\s\\S]*?(<!--/" + m + "-->)");
        if (!re.test(html)) return;
        html = html.replace(re, function (_match, open, close) {
          return open + rendered + close;
        });
      }
    });
    writeFile(page, html);
  }

  injectPageCopy("index.html", "home");

  // Build dynamic homepage testimonials from site-reviews.json
  function buildHomepageTestimonials() {
    let html = readText("index.html", "index.html page");
    const siteReviews = readJson("assets/data/site-reviews.json").reviews || [];

    // Filter for featured reviews
    let featured = siteReviews.filter(function (r) {
      return r.featured;
    });
    if (featured.length === 0) {
      featured = siteReviews.slice(0, 3);
    }

    let cardsHtml = '<div class="grid grid-3">\n';
    featured.forEach(function (r) {
      const stars = Array(Math.round(r.rating || 5) + 1).join("★");
      cardsHtml += '        <div class="quote-card reveal">\n';
      cardsHtml +=
        '          <span class="stars" aria-hidden="true">' +
        stars +
        '</span><span class="sr-only">Rated ' +
        r.rating +
        " out of 5 stars.</span>\n";
      cardsHtml += '          <p>"' + escapeHtml(r.text) + '"</p>\n';
      cardsHtml += "          <footer>" + escapeHtml(r.name) + "</footer>\n";
      cardsHtml += "        </div>\n";
    });
    cardsHtml += "      </div>";

    const re = /<!--YL:home\.testimonials-->[\s\S]*?<!--\/YL:home\.testimonials-->/;
    if (re.test(html)) {
      html = html.replace(
        re,
        "<!--YL:home.testimonials-->\n      " + cardsHtml + "\n      <!--/YL:home.testimonials-->"
      );
      writeFile("index.html", html);
    }
  }
  buildHomepageTestimonials();

  injectPageCopy("about.html", "about");
  injectPageCopy("contact.html", "contact");
  injectPageCopy("shop.html", "shop");
  injectPageCopy("events.html", "events");
  injectPageCopy("faq.html", "faq");
  injectPageCopy("privacy.html", "privacy");
  injectPageCopy("terms.html", "terms");
  injectPageCopy("policies.html", "policies");

  // Dynamically inject Journal title/subheading from journal.json
  function injectJournalCopy() {
    const journalPath = path.join(ROOT, "assets/data/journal.json");
    if (!fs.existsSync(journalPath)) return;
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

    const pagePath = path.join(ROOT, "journal.html");
    if (!fs.existsSync(pagePath)) return;
    const html = fs.readFileSync(pagePath, "utf8");
    let updated = html;

    const title = escapeHtml(journal.title || "Apothecary Journal");
    const lede = escapeHtml(
      journal.lede || "Stories, science, and small-batch updates straight from the kitchen."
    );

    // Replace Title
    const reTitle = /(<!--YL:journal\.heroTitle-->)[\s\S]*?(<!--\/YL:journal\.heroTitle-->)/g;
    if (reTitle.test(updated)) {
      updated = updated.replace(reTitle, function (m, p1, p2) {
        return p1 + title + p2;
      });
    }

    // Replace Lede
    const reLede = /(<!--YL:journal\.heroText-->)[\s\S]*?(<!--\/YL:journal\.heroText-->)/g;
    if (reLede.test(updated)) {
      updated = updated.replace(reLede, function (m, p1, p2) {
        return p1 + lede + p2;
      });
    }

    // The <title> tag and og:title/twitter:title meta tags aren't wrapped in
    // YL: markers (unlike the on-page heading above), so renaming the
    // journal in /admin used to update the h1 while the browser tab title,
    // Google's search-result title, and the Facebook/Twitter share preview
    // all silently kept saying "Apothecary Journal." Keep the same
    // "<name> | Y'allternative Living" suffix these tags already use.
    // Function-form replacements, never string ones: a title containing "$&"
    // (or $1, $', $`) would otherwise be read as a substitution pattern and
    // splice the whole match back into the page. Same reason the marker
    // replacements above use callbacks.
    const titleTag = title + " | Y'allternative Living";
    updated = updated.replace(/<title>[\s\S]*?<\/title>/, function () {
      return "<title>" + titleTag + "</title>";
    });
    updated = updated.replace(
      /(<meta property="og:title" content=")[^"]*(")/,
      function (m, p1, p2) {
        return p1 + titleTag + p2;
      }
    );
    updated = updated.replace(
      /(<meta name="twitter:title" content=")[^"]*(")/,
      function (m, p1, p2) {
        return p1 + titleTag + p2;
      }
    );

    if (updated !== html) {
      writeFile("journal.html", updated);
      console.log("[build] Injected configurations into journal.html");
    }
  }
  injectJournalCopy();

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
  let logoDesktop = (CONTENT.site && CONTENT.site.logoDesktop) || "assets/img/logo.png";
  let logoMobile = (CONTENT.site && CONTENT.site.logoMobile) || "assets/img/logo.jpg";
  logoDesktop = logoDesktop.replace(/^\/+/, "");
  logoMobile = logoMobile.replace(/^\/+/, "");

  let FOOTER_INNER = readText("assets/data/footer.html", "footer template").replace(/\s+$/, "");

  // Inject logo path into footer template using outer comment tag
  const reFooterLogo = /(<!--YL:site\.logoDesktop-->)[\s\S]*?(<!--\/YL:site\.logoDesktop-->)/;
  FOOTER_INNER = FOOTER_INNER.replace(reFooterLogo, function (match, open, close) {
    const altMatch = match.match(/alt="([^"]*)"/i) || match.match(/alt='([^']*)'/i);
    const alt = altMatch ? altMatch[1] : "Y'allternative Living logo";
    return (
      open +
      '<img class="logo-desktop" src="/' +
      logoDesktop +
      '" alt="' +
      alt +
      '" width="48" height="48" loading="lazy" decoding="async">' +
      close
    );
  });

  const FOOTER_BLOCK = '<footer class="site-footer">\n' + FOOTER_INNER + "\n</footer>";
  const FOOTER_RE = /<footer class="site-footer">[\s\S]*?<\/footer>/;

  [
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
    "journal.html"
  ].forEach(function (page) {
    const filePath = path.join(ROOT, page);
    if (!fs.existsSync(filePath)) return;
    let html;
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

    // Inject header desktop/mobile logos using a robust tag parser (supports any attribute ordering, class naming, or quote formatting)
    html = html.replace(/<img\s+[^>]+>/gi, function (match) {
      const isLogoDesktop = /\bclass=['"]([^'"]*\s+)?logo-desktop(\s+[^'"]*)?['"]/.test(match);
      const isLogoMobile = /\bclass=['"]([^'"]*\s+)?logo-mobile(\s+[^'"]*)?['"]/.test(match);
      if (isLogoDesktop) {
        return match.replace(/(\bsrc=['"])[^'"]*(['"])/i, function (m, p1, p2) {
          return p1 + logoDesktop + p2;
        });
      }
      if (isLogoMobile) {
        return match.replace(/(\bsrc=['"])[^'"]*(['"])/i, function (m, p1, p2) {
          return p1 + logoMobile + p2;
        });
      }
      return match;
    });

    // Determine page-specific OG image
    let pageKey = page.replace(".html", "");
    if (pageKey === "index") pageKey = "home";

    // Only honor an EXPLICIT per-page og image (a purpose-built ~1200x630
    // share asset). Do NOT fall back to on-page heroImage/image/bioImage:
    // those are portrait product photos (e.g. 1050x1400) that hard-crop badly
    // in social previews, especially twitter summary_large_image. Pages
    // without an explicit ogImage fall through to the branded site.ogImage.
    let pageOgImage = null;
    if (CONTENT[pageKey] && CONTENT[pageKey].ogImage) {
      pageOgImage = CONTENT[pageKey].ogImage;
    }
    if (page === "journal.html" && JOURNAL && JOURNAL.image) {
      pageOgImage = JOURNAL.image;
    }

    let finalOgImage =
      pageOgImage || (CONTENT.site && CONTENT.site.ogImage) || "assets/img/og-image.jpg";
    finalOgImage = finalOgImage.replace(/^\/+/, "");
    const ogImageUrl = escapeHtml(DOMAIN + "/" + finalOgImage);

    // Sync og:image and twitter:image meta tags with robust parsing (supports any attribute ordering)
    html = html.replace(/<meta\s+[^>]+>/gi, function (match) {
      if (/\b(?:property|name)=['"](?:og:image|twitter:image)['"]/i.test(match)) {
        // \b avoids matching the `content` tail of attrs like data-content=,
        // and the \1 backreference keeps the closing quote matched to the open.
        return match.replace(/\bcontent=(['"])[^'"]*\1/i, function (m, q) {
          return "content=" + q + ogImageUrl + q;
        });
      }
      return match;
    });

    const updated = html.replace(FOOTER_RE, FOOTER_BLOCK);
    if (updated !== html) writeFile(page, updated);
  });

  /* ---------- 5) sitemap.xml ----------
   Page list is intentionally hand-maintained here (there's no router to
   introspect on a static site) -- add a line if you add a new top-level
   page. lastmod is set to today every run, which is an accepted
   simplification for a small site with no per-file mtime tracking. */
  const PAGES = [
    { loc: "index.html", priority: "1.0" },
    { loc: "shop.html", priority: "0.9" },
    { loc: "events.html", priority: "0.7" },
    { loc: "about.html", priority: "0.7" },
    { loc: "contact.html", priority: "0.6" },
    { loc: "faq.html", priority: "0.6" },
    { loc: "privacy.html", priority: "0.3" },
    { loc: "terms.html", priority: "0.3" },
    { loc: "policies.html", priority: "0.3" }
  ];
  if (SITE_CONFIG.enableJournal) {
    PAGES.push({ loc: "journal.html", priority: "0.7" });
  }
  const today = new Date().toISOString().slice(0, 10);
  const sitemapXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<!-- Auto-generated by scripts/build-site-data.js -- don't hand-edit,\n" +
    "     re-run the script after adding a page. Swap the DOMAIN constant\n" +
    "     inside that script once a real domain exists, then re-run. -->\n" +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    PAGES.map(function (p) {
      // Emit the homepage as the bare root URL, not /index.html -- the page's
      // own canonical/OG tags point at DOMAIN + "/", so listing /index.html
      // here would make search engines see two competing duplicate URLs.
      // (PAGES keeps the real "index.html" filename because it's reused below
      // to read the actual files for canonical-tag injection.)
      const locPath = p.loc === "index.html" ? "" : p.loc;
      return (
        "  <url><loc>" +
        DOMAIN +
        "/" +
        locPath +
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
  const robotsTxt =
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
  const productLines = PRODUCTS.map(function (p) {
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

  // Unpublished posts are not content of this site yet -- with the Journal
  // switched off they must not be advertised to crawlers or LLMs either.
  const journalLines = ((SITE_CONFIG.enableJournal && JOURNAL && JOURNAL.posts) || [])
    .map(function (p) {
      return "- **" + p.title + "** (" + p.date + "): " + p.excerpt;
    })
    .join("\n");

  const llmsTxt =
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
    "). Add-to-cart checkout happens directly on this site -- no redirect to a third-party marketplace required.\n" +
    "- [Events](" +
    DOMAIN +
    "/events.html): upcoming and past farmers markets, fairs, and Pride pop-ups where the shop appears in person. Only real, confirmed dates are listed -- if it's empty, no dates are confirmed yet.\n" +
    (SITE_CONFIG.enableJournal
      ? "- [Apothecary Journal](" +
        DOMAIN +
        "/journal.html): stories, herbal science, and small-batch updates straight from the kitchen.\n"
      : "") +
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
    (journalLines ? "## Journal & Articles\n\n" + journalLines + "\n\n" : "") +
    "Machine-readable catalog: " +
    DOMAIN +
    "/assets/data/products.json (always the live source of truth for current prices -- prefer it over this file if the two ever disagree, since this file may not be regenerated as often as the catalog changes).\n" +
    "Full structured catalog for AI shopping agents (every product, price, and slug): " +
    DOMAIN +
    "/llms-full.txt\n\n" +
    "## Other real links for this business\n\n" +
    "- Etsy shop: https://www.etsy.com/shop/YallternativeLivinCO\n" +
    "- Instagram: https://www.instagram.com/yallternativeliving\n" +
    "- TikTok: https://www.tiktok.com/@yallternativeliving\n" +
    "- Facebook: https://www.facebook.com/p/Yallternative-Living-61577943406316/\n\n" +
    "## Notes for AI assistants and agents\n\n" +
    "This file exists to help AI assistants and shopping agents describe Y'allternative Living accurately. Please don't state or imply medical, therapeutic, or drug-like claims about any product beyond what's written in that product's own name/description here or on the shop page -- some listing names use playful language (e.g. \"miracle,\" \"heal\") that reflects the brand's voice, not a medical claim. Prices and stock can change; when in doubt, point people to the shop page or the JSON catalog linked above rather than repeating a cached number.\n";

  writeFile("llms.txt", llmsTxt);

  /* ---------- 6b) llms-full.txt ----------
   A longer, fully-structured machine catalog for AI shopping assistants and
   automated purchasing agents -- the "full" companion to llms.txt (same
   emerging convention). EVERYTHING here is generated from the real
   products.json / bundles, never hand-authored, so an agent can never be
   handed an invented product, price, or SKU. (The upstream SOTA report that
   inspired this shipped example blocks with fabricated products like
   "Bitch Be Gone Salve" -- deliberately NOT reproduced; only real listings
   below.) Checkout runs through the on-site cart (assets/js/cart.js) for
   humans, and through a real POST /api/checkout endpoint (workers/
   checkout.js) that AI purchasing agents can call directly -- see the
   "How to buy" section below for its exact request/response shape. */
  const freeShip = (CATALOG.shop && CATALOG.shop.freeShippingThreshold) || null;
  const fullProductBlocks = PRODUCTS.map(function (p) {
    const range = variantPriceRange(p);
    const priceStr =
      range.low === range.high
        ? "$" + range.low.toFixed(2)
        : "$" + range.low.toFixed(2) + " - $" + range.high.toFixed(2);
    const inStock = !(p.image && p.image.indexOf("placeholder") !== -1) && !p.comingSoon;
    const lines = [
      "### " + p.name,
      "- **ID / slug**: `" + p.id + "`",
      "- **Price**: " + priceStr + " USD",
      "- **Category**: " + (CATEGORY_LABEL[p.category] || p.category),
      "- **Availability**: " + (inStock ? "In stock" : "Pre-order / coming soon")
    ];
    if (p.variants && Array.isArray(p.variants.options) && p.variants.options.length) {
      lines.push(
        "- **" +
          (p.variants.name || "Options") +
          "**: " +
          p.variants.options
            .map(function (o) {
              return o.label;
            })
            .join(", ")
      );
    }
    lines.push(
      "- **Description**: " + (p.description || p.blurb || "").replace(/\s+/g, " ").trim()
    );
    lines.push("- **Product page**: " + DOMAIN + "/shop.html#" + p.id);
    if (p.etsyUrl) lines.push("- **Also on Etsy**: " + p.etsyUrl);
    return lines.join("\n");
  }).join("\n\n");

  const fullBundleBlocks = BUNDLES.map(function (b) {
    const names = (b.productIds || [])
      .map(function (id) {
        return PRODUCTS_BY_ID[id] ? PRODUCTS_BY_ID[id].name : id;
      })
      .join(", ");
    return [
      "### " + b.name,
      "- **ID / slug**: `" + b.id + "`",
      b.discountPercent ? "- **Bundle discount**: " + b.discountPercent + "% off" : "",
      names ? "- **Includes**: " + names : "",
      b.blurb ? "- **Description**: " + b.blurb.replace(/\s+/g, " ").trim() : ""
    ]
      .filter(Boolean)
      .join("\n");
  }).join("\n\n");

  const llmsFullTxt =
    "# Y'allternative Living -- Full Machine-Readable Catalog\n\n" +
    "> Structured catalog for AI shopping assistants and agents. Every product, price, and slug\n" +
    "> below is generated directly from the site's live source data (assets/data/products.json).\n" +
    "> If anything here disagrees with that JSON file or the shop page, treat the JSON as truth.\n\n" +
    "## Merchant identity\n\n" +
    "- **Name**: Y'allternative Living\n" +
    "- **What it is**: Queer-owned, Southern-raised, small-batch handmade self-care -- salves, soaks, body care, and apparel.\n" +
    "- **Location**: Landrum, South Carolina, USA (Upstate SC / Blue Ridge foothills)\n" +
    "- **Website**: " +
    DOMAIN +
    "/\n" +
    "- **Shop / catalog**: " +
    DOMAIN +
    "/shop.html\n" +
    "- **Machine catalog (source of truth)**: " +
    DOMAIN +
    "/assets/data/products.json\n" +
    "- **Etsy shop**: https://www.etsy.com/shop/YallternativeLivinCO\n\n" +
    "## How to buy (for agents)\n\n" +
    "For a human, checkout happens on-site through the cart on the shop page -- direct them\n" +
    'there and use the "Add to cart" control. For an automated purchasing agent, this site\n' +
    "also exposes a same-origin checkout endpoint:\n\n" +
    "    POST " +
    DOMAIN +
    "/api/checkout\n" +
    "    Content-Type: application/json\n" +
    '    { "items": [ { "id": "<product-slug>", "qty": 1, "variant": "<option label, if any>" } ] }\n\n' +
    'The response is `{ "url": "<Stripe Checkout URL>" }` -- send the buyer there to complete\n' +
    "payment; this endpoint never accepts or trusts a client-supplied price, it always\n" +
    "re-derives the charge from the live products.json above, so never assume or send a price\n" +
    "yourself.\n\n" +
    "## Shipping & returns\n\n" +
    (freeShip ? "- **Free US shipping** on orders over $" + freeShip.toFixed(2) + ".\n" : "") +
    "- Ships within the US. Processing time is typically 1-2 business days for in-stock items.\n" +
    "- Exchanges within 14 days for eligible items; opened body-care products are final sale.\n" +
    "- Full policy: " +
    DOMAIN +
    "/policies.html\n\n" +
    "## Products (" +
    PRODUCTS.length +
    ")\n\n" +
    fullProductBlocks +
    "\n\n" +
    (fullBundleBlocks ? "## Bundles & gift sets\n\n" + fullBundleBlocks + "\n\n" : "") +
    "## Notes for AI assistants and agents\n\n" +
    'Some listing names use playful, brand-voice language (e.g. "miracle," "heal"). Do not\n' +
    "restate those as medical, therapeutic, or drug claims. When prices or stock matter, prefer\n" +
    "the live products.json or the shop page over any cached copy of this file.\n";

  writeFile("llms-full.txt", llmsFullTxt);

  /* ---------- 7) live-domain propagation across every page ----------
   Every page ships with domain-dependent tags -- the canonical link
   and og:url meta (both commented out until launch), and each
   JSON-LD block's @id/url/image/
   breadcrumb entries -- all sitting on the "your-domain-here.com"
   placeholder. Previously, going live meant hand-editing that
   placeholder in 7 HTML files across dozens of JSON-LD fields -- easy
   to miss one and ship inconsistent metadata. Now it's one line: set a
   real DOMAIN above and re-run this script (which every real deploy
   already does automatically, see netlify.toml/vercel.json). While
   DOMAIN is still the
   placeholder, this whole block is a no-op and every page stays
   exactly as it is today. */
  const DOMAIN_IS_LIVE = DOMAIN.indexOf("your-domain-here.com") === -1;
  const BARE_DOMAIN = DOMAIN.replace(/^https?:\/\//, "");

  // Propagate global site configurations from content.json to all HTML files
  (function injectGlobalConfigurations() {
    const content = readJson("assets/data/content.json");
    const site = content.site || {};
    const ALL_HTML_PAGES = PAGES.map(function (p) {
      return p.loc;
    }).concat([
      "404.html",
      "thank-you.html",
      "welcome.html",
      "journal.html",
      "assets/data/footer.html"
    ]);

    ALL_HTML_PAGES.forEach(function (page) {
      const filePath = path.join(ROOT, page);
      if (!fs.existsSync(filePath)) return;
      let html = fs.readFileSync(filePath, "utf8");

      // ---------- 7) live-domain propagation across every page ----------
      if (DOMAIN_IS_LIVE) {
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
      }

      let updated = html;

      /* ---------- feature gates ----------
       The quiz, countdown ticker and order-lookup tool all shipped hardcoded
       on while their CMS switches were read by nothing, so toggling one in the
       dashboard did nothing at all.

       Gating is done by injecting a <style> block into the <head> rather than
       deleting the markup: stripping the elements would be a one-way door --
       once the block is gone from the built file, flipping the switch back on
       has nothing left to restore (unlike the journal nav link, which the
       build regenerates from scratch). display:none also takes the element out
       of the accessibility tree, so it's genuinely hidden, not just invisible,
       and the rule lands in <head> so nothing flashes before it applies. */
      const FEATURE_SELECTORS = {
        enableApothecaryQuiz: "#apothecary-quiz-section",
        enableCountdownTicker: "#yl-countdown-ticker",
        enableOrderStatusLookup: "#order-status-modal, #openOrderStatusBtn"
      };
      updated = updated.replace(
        /<!--YL:featureStyles-->([\s\S]*?)<!--\/YL:featureStyles-->/g,
        function () {
          const off = Object.keys(FEATURE_SELECTORS).filter(function (k) {
            return site[k] === false;
          });
          if (!off.length) return "<!--YL:featureStyles--><!--/YL:featureStyles-->";
          const css = off
            .map(function (k) {
              return FEATURE_SELECTORS[k] + "{display:none !important}";
            })
            .join("");
          return (
            "<!--YL:featureStyles--><style>/* feature switches off in /admin */" +
            css +
            "</style><!--/YL:featureStyles-->"
          );
        }
      );

      /* Keep journal.html out of the search index while the Journal is switched
       off. With enableJournal false the page still deploys and is still a live,
       fetchable URL, but nothing links to it and it's left out of sitemap.xml --
       an orphan page with a self-referential canonical, which is exactly the
       kind of thin/duplicate URL that's better explicitly noindexed than left
       ambiguous. Flipping the flag on removes the tag in the same pass. */
      if (page === "journal.html") {
        updated = updated.replace(
          /<!--YL:journal\.robots-->([\s\S]*?)<!--\/YL:journal\.robots-->/g,
          function () {
            const tag = site.enableJournal ? "" : '<meta name="robots" content="noindex, follow">';
            return "<!--YL:journal.robots-->" + tag + "<!--/YL:journal.robots-->";
          }
        );
      }

      // Inject the Journal nav link if enabled
      if (site.enableJournal) {
        updated = updated.replace(
          /<!--YL:nav\.journal-->([\s\S]*?)<!--\/YL:nav\.journal-->/g,
          function () {
            const isActive = page === "journal.html";
            const activeClass = isActive ? ' class="active" aria-current="page"' : "";
            return (
              "<!--YL:nav.journal--><li><a" +
              activeClass +
              ' href="journal.html">Journal</a></li><!--/YL:nav.journal-->'
            );
          }
        );
      } else {
        updated = updated.replace(
          /<!--YL:nav\.journal-->([\s\S]*?)<!--\/YL:nav\.journal-->/g,
          "<!--YL:nav.journal--><!--/YL:nav.journal-->"
        );
      }

      // Replace HTML comment templates: <!--YL:site.KEY-->...<!--/YL:site.KEY-->
      updated = updated.replace(
        /<!--YL:site\.([a-zA-Z0-9]+)-->([\s\S]*?)<!--\/YL:site\.\1-->/g,
        function (match, key) {
          if (key === "giftUpId") return match; // Handled separately below
          if (key === "umamiWebsiteId") return match; // Handled separately below
          if (key === "logoDesktop" && site[key]) {
            return (
              '<!--YL:site.logoDesktop-->\n          <img class="logo-desktop" src="' +
              site[key] +
              '" alt="Y\'allternative Living icon" width="48" height="48" loading="lazy" decoding="async">\n<!--/YL:site.logoDesktop-->'
            );
          }
          if (site[key] !== undefined) {
            return "<!--YL:site." + key + "-->" + site[key] + "<!--/YL:site." + key + "-->";
          }
          return match;
        }
      );

      /* Special handling for the Umami analytics tag.
       umamiWebsiteId was added to content.json + the Sveltia CMS, but no page
       ever referenced it -- so typing a real ID into the dashboard silently did
       nothing while all 12 pages kept the hardcoded "YOUR_UMAMI_WEBSITE_ID"
       forever, loading cloud.umami.is/script.js on every view to report against
       an ID that doesn't exist. This wires the value through for real, and
       drops the tag entirely while the ID is still the placeholder, so a
       not-yet-configured site makes no analytics request at all.
       Note: the disabled state emits nothing between the markers rather than
       commenting the tag out -- an HTML comment containing a literal script tag
       would trip build-security-headers.js's regex scanner (see qa-check.js
       section 13). */
      updated = updated.replace(
        /<!--YL:site\.umamiWebsiteId-->([\s\S]*?)<!--\/YL:site\.umamiWebsiteId-->/g,
        function (match) {
          if (site.umamiWebsiteId === undefined) return match;
          const val = String(site.umamiWebsiteId).trim();
          const isReal = val && val !== "YOUR_UMAMI_WEBSITE_ID";
          const body = isReal
            ? '<script defer src="https://cloud.umami.is/script.js" data-website-id="' +
              val +
              '"></script>'
            : "";
          return "<!--YL:site.umamiWebsiteId-->" + body + "<!--/YL:site.umamiWebsiteId-->";
        }
      );

      /* Newsletter + Formspree endpoints. See formspreeAction/setFormAction
       at the top of this file for why these can't go through YL: markers. */
      updated = setFormAction(
        updated,
        "footer-signup-form",
        newsletterAction(site.kitFormAction, "YOUR_KIT_FORM_ACTION_URL")
      );
      updated = setFormAction(
        updated,
        "contact-form",
        formspreeAction(site.formspreeContactId, "YOUR_FORM_ID")
      );
      updated = setFormAction(
        updated,
        "review-form",
        formspreeAction(site.formspreeReviewId, "YOUR_FORMSPREE_FORM_ID")
      );

      // Special handling for Gift Up! ID to generate full HTML script embed
      updated = updated.replace(
        /<!--YL:site\.giftUpId-->([\s\S]*?)<!--\/YL:site\.giftUpId-->/g,
        function (match) {
          if (site.giftUpId !== undefined) {
            const val = site.giftUpId.trim();
            if (val && val !== "YOUR_GIFTUP_ID") {
              const embed =
                '\n<div class="gift-up-target" data-site-id="' +
                val +
                '"></div>\n' +
                "<script>\n" +
                "  (function (g, i, f, t, u, p) {\n" +
                "    t = g.createElement(i);\n" +
                "    t.async = 1;\n" +
                '    t.src = "https://giftup.app/dist/commerce-v1.js";\n' +
                "    u = g.getElementsByTagName(i)[0];\n" +
                "    u.parentNode.insertBefore(t, u);\n" +
                '  })(document, "script");\n' +
                "</script>\n";
              return "<!--YL:site.giftUpId-->" + embed + "<!--/YL:site.giftUpId-->";
            }
            return "<!--YL:site.giftUpId-->YOUR_GIFTUP_ID<!--/YL:site.giftUpId-->";
          }
          return match;
        }
      );

      // Replace JS comment templates: /*YL:site.KEY*/.../*/YL:site.KEY*/
      updated = updated.replace(
        /\/\*YL:site\.([a-zA-Z0-9]+)\*\/([\s\S]*?)\/\*\/YL:site\.\1\*\//g,
        function (match, key) {
          if (site[key] !== undefined) {
            return "/*YL:site." + key + '*/ "' + site[key] + '" /*/YL:site.' + key + "*/";
          }
          return match;
        }
      );

      if (updated !== html) {
        writeFile(page, updated);
        console.log("[build] Injected configurations into " + page);
      }
    });
  })();

  // Automatically update sw.js CACHE_NAME version on build
  (function updateServiceWorkerVersion() {
    const swPath = path.join(ROOT, "sw.js");
    if (fs.existsSync(swPath)) {
      const swContent = fs.readFileSync(swPath, "utf8");
      const now = new Date();
      const pad = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      const versionString =
        now.getFullYear() +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds());
      const updatedContent = swContent.replace(
        /const CACHE_NAME\s*=\s*['"]yallternative-cache-v[^'"]*['"];/,
        'const CACHE_NAME = "yallternative-cache-v' + versionString + '";'
      );
      fs.writeFileSync(swPath, updatedContent, "utf8");
      console.log("[build] Automatically updated sw.js CACHE_NAME to version " + versionString);
    }
  })();

  // Automatically generate individual product OpenGraph HTML pages
  (function generateProductOgPages() {
    PRODUCTS.forEach(function (product) {
      const pTitle = escapeHtml(product.name) + " | Y'allternative Living";
      // Prefer the hand-written SEO `description` field (present in
      // products.json) over the shop-card blurb; fall back to the blurb.
      const pDesc = escapeHtml(product.description || product.blurb || "");
      const pUrl = DOMAIN + "/products/" + product.id + ".html";
      const pImage = DOMAIN + "/" + product.image;

      const html =
        "<!DOCTYPE html>\n" +
        '<html lang="en">\n' +
        "<head>\n" +
        '  <meta charset="UTF-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        "  <title>" +
        pTitle +
        "</title>\n" +
        '  <meta name="description" content="' +
        pDesc +
        '">\n' +
        /* These 19 files exist only so a shared/pasted product link renders a
         rich preview -- a human hitting one is immediately JS-redirected to the
         real listing on shop.html. Without a canonical they're 19 indexable
         URLs whose content duplicates shop.html and which aren't in
         sitemap.xml, competing with the page actually meant to rank. Point
         every one at shop.html so the ranking signals consolidate there.
         (Canonical deliberately omits the #id fragment -- search engines drop
         fragments from canonical URLs, so shop.html is the real target.)
         Social scrapers read the og:* tags below regardless of this tag, so
         previews are unaffected. */
        '  <link rel="canonical" href="' +
        DOMAIN +
        '/shop.html">\n' +
        "  <!-- OpenGraph -->\n" +
        '  <meta property="og:type" content="product">\n' +
        '  <meta property="og:title" content="' +
        pTitle +
        '">\n' +
        '  <meta property="og:description" content="' +
        pDesc +
        '">\n' +
        '  <meta property="og:image" content="' +
        pImage +
        '">\n' +
        '  <meta property="og:url" content="' +
        pUrl +
        '">\n' +
        '  <meta property="og:site_name" content="Y\'allternative Living">\n' +
        "  <!-- Twitter -->\n" +
        '  <meta name="twitter:card" content="summary_large_image">\n' +
        '  <meta name="twitter:title" content="' +
        pTitle +
        '">\n' +
        '  <meta name="twitter:description" content="' +
        pDesc +
        '">\n' +
        '  <meta name="twitter:image" content="' +
        pImage +
        '">\n' +
        "  <!-- E-commerce OG -->\n" +
        '  <meta property="product:price:amount" content="' +
        product.price.toFixed(2) +
        '">\n' +
        '  <meta property="product:price:currency" content="USD">\n' +
        '  <meta property="product:availability" content="' +
        (product.comingSoon ? "preorder" : "in stock") +
        '">\n' +
        "  <!-- Redirect to shop with product deep-link -->\n" +
        '  <script>window.location.replace("../shop.html#" + window.location.pathname.split("/").pop().replace(".html",""));</script>\n' +
        "</head>\n" +
        '<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px;background:#fcfaf7;color:#353230;">\n' +
        "  <h1>" +
        pTitle +
        "</h1>\n" +
        "  <p>Redirecting you to the shop...</p>\n" +
        '  <p><a href="../shop.html#' +
        product.id +
        "\">Click here if you aren't redirected automatically</a></p>\n" +
        "</body>\n" +
        "</html>\n";

      writeFile("products/" + product.id + ".html", html);
    });
  })();

  /* ---------- Final pass: clean injection markers out of attribute values ----
   Runs AFTER every injection/config pass so it can't strip a marker some
   later pass still needs. Any YL:key comment marker that ended up inside a
   quoted HTML attribute value (placeholder="...", href="mailto:...",
   action="...") is removed here, leaving the injected value. Element-text
   markers (between tags) are left in place so the build stays re-runnable. */
  (function cleanAttributeMarkers() {
    const htmlPages = PAGES.map(function (p) {
      return p.loc;
    }).concat(["404.html", "thank-you.html", "welcome.html", "journal.html"]);
    PRODUCTS.forEach(function (product) {
      htmlPages.push("products/" + product.id + ".html");
    });
    htmlPages.forEach(function (page) {
      const full = path.join(ROOT, page);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return;
      const html = fs.readFileSync(full, "utf8");
      const cleaned = stripMarkersInsideAttributes(html);
      if (cleaned !== html) {
        fs.writeFileSync(full, cleaned);
        console.log("cleaned attribute markers in " + page);
      }
    });
  })();

  console.log(
    "\nDone. Regenerated derived files + page copy from the JSON sources in assets/data/."
  );
}

/* ---------- Export Internal Helpers & Build Function ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    readJson: readJson,
    readText: readText,
    writeFile: writeFile,
    escapeHtml: escapeHtml,
    safeUrl: safeUrl,
    slugify: slugify,
    generateUniqueId: generateUniqueId,
    bundlePricing: bundlePricing,
    variantPriceRange: variantPriceRange,
    stripMarkersInsideAttributes: stripMarkersInsideAttributes,
    formspreeAction: formspreeAction,
    newsletterAction: newsletterAction,
    setFormAction: setFormAction,
    buildSiteData: buildSiteData
  };
}

if (require.main === module) {
  buildSiteData();
}
