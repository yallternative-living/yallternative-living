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
const crypto = require("crypto");
/* The first-party analytics paths. Shared with build-security-headers.js,
   which emits the proxy rules these paths depend on -- a mismatch between the
   two would load a tracker that posts into a 404, so they come from one file.
   scripts/analytics.test.js asserts the emitted tag and the emitted rules
   still agree. */
const { ANALYTICS_LOADER_PATH } = require("./lib/analytics-proxy");
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

/* Journal posts are one JSON file each in assets/data/journal/ -- a Sveltia
   folder collection, so /admin shows a real post list with a "New post"
   button instead of one giant file. The FILE NAME is the post id (the CMS
   names a new file from its title); an `id` key inside a file is ignored so
   a renamed file can never disagree with itself. The page title and lede
   live in content.json's `journal` key, edited under "Site Images & Page
   Wording". Posts come back newest first so journal.html, feed.xml and the
   search index read like a blog without each sorting on its own. */
const JOURNAL_DIR = "assets/data/journal";
function listJournalFiles() {
  const dir = path.join(ROOT, JOURNAL_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(function (f) {
      return f.endsWith(".json");
    })
    .sort()
    .map(function (f) {
      return JOURNAL_DIR + "/" + f;
    });
}
function loadJournal(content) {
  const wording = (content && content.journal) || {};
  const posts = listJournalFiles().map(function (rel) {
    const post = readJson(rel);
    post.id = path.basename(rel, ".json");
    return post;
  });
  posts.sort(function (a, b) {
    return (
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(a.title || "").localeCompare(String(b.title || ""))
    );
  });
  return {
    title: wording.title || "Apothecary Journal",
    lede: wording.lede || "Stories, science, and small-batch updates straight from the kitchen.",
    posts: posts
  };
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

/* ---------- JSON embedded in HTML ----------
   The contents of a <script> element are RAW TEXT: the HTML parser never
   decodes entities inside them, but it DOES end the element at the first
   "</script" and treats "<!--" as the start of a comment-like state. So a
   product name, blurb or FAQ answer containing "</script>" -- all of them
   CMS-editable -- closes a JSON-LD block early and everything after it is
   parsed as markup. That is finding C-4 in docs/AUDIT-2026-09-01.md, and it
   applied to every JSON-LD block this script emits.

   The fix neutralizes those characters INSIDE the JSON source text using
   JSON's own \uXXXX escapes rather than HTML entities. Both stop the
   breakout; only this one round-trips. Script content is not entity-decoded,
   so writing "&amp;" would put those literal five characters into the
   structured data every consumer reads (this catalogue has 32 ampersands in
   category and scent names alone), whereas the JSON \u0026 escape parses
   back to exactly "&". Same technique the CMS auth worker uses at
   cms-auth/sveltia-auth.js:94-96.

   U+2028/U+2029 are legal in JSON strings but are line terminators in
   JavaScript, so they are escaped too. */
function escapeJsonForScript(jsonText) {
  return String(jsonText)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/* Serialize a value into a JS string literal that is safe both as JavaScript
   and inside an HTML <script> block. Used for the Tawk.to IDs the CMS writes
   into the inline chat snippet on 11 pages -- previously concatenated raw
   between two quote characters, so a value of `"; fetch(...); //` executed,
   and build-security-headers.js then certified the result with a fresh CSP
   hash (C-4 / H-13). */
function jsStringLiteral(value) {
  const str = String(value === null || value === undefined ? "" : value);
  return escapeJsonForScript(JSON.stringify(str));
}

/* One JSON-LD <script> block, escaped as above. `indent` is the leading
   whitespace the block's closing tag carries in the page, so re-running the
   build re-finds and replaces the block byte-for-byte. */
function jsonLdScriptBlock(data, indent) {
  const pad = indent || "";
  return (
    '<script type="application/ld+json">\n' +
    escapeJsonForScript(JSON.stringify(data, null, 2)) +
    "\n" +
    pad +
    "</script>"
  );
}

/* Clamp a CMS-supplied star rating into the 0-5 range schema.org allows.
   A non-numeric rating used to reach `Array(NaN)` and crash the build, and a
   rating of 500 used to be published verbatim (Low findings in the audit). */
function clampRating(value, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return typeof fallback === "number" ? fallback : 0;
  return Math.min(5, Math.max(0, n));
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

/* A link target for CMS-authored Markdown ([text](url)) in the FAQ.
   safeUrl() above is deliberately stricter -- it only allows absolute and
   root-relative URLs, because an event's "More info" link is always one of
   those -- but the FAQ legitimately links to "events.html", a document-
   relative path safeUrl() would drop. This mirrors safeLinkUrl() in
   assets/js/main.js:622: strip control characters, allow http/https/mailto
   and anything with no scheme at all, reject every other scheme
   (javascript:, data:, vbscript:). Empty string means "render the link text
   without a link", which is what the FAQ renderer below does. */
function safeLinkUrl(url) {
  if (!url) return "";
  let cleaned = "";
  const raw = String(url);
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code > 32 && code !== 127) cleaned += raw.charAt(i);
  }
  if (!cleaned) return "";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== "http" && name !== "https" && name !== "mailto") return "";
  }
  return cleaned;
}

/* ---------- Search settings (content.json "search", editable in /admin) ----------
   The popular-search chips are visible copy, so they are validated like copy:
   a label, a query and an icon name from the fixed set below. The same icon
   set lives in assets/js/main.js (SEARCH_CHIP_ICONS) for the no-results
   state; scripts/global-search.test.js asserts the two stay identical. */
const SEARCH_CHIP_ICONS = {
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  waves:
    '<path d="M2 6c2 0 3-1.5 5-1.5S10 6 12 6s3-1.5 5-1.5S20 6 22 6"/><path d="M2 12c2 0 3-1.5 5-1.5S10 12 12 12s3-1.5 5-1.5S20 12 22 12"/><path d="M2 18c2 0 3-1.5 5-1.5S10 18 12 18s3-1.5 5-1.5S20 18 22 18"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'
};

const DEFAULT_SEARCH_CHIPS = [
  { label: "Bedtime & Wind-Down", query: "sleep", icon: "moon" },
  { label: "Bath Soaks", query: "soak", icon: "waves" },
  { label: "Dry, Rough Skin", query: "dry skin", icon: "droplet" },
  { label: "Bug Defense", query: "bug spray", icon: "shield" },
  { label: "Pop-Up Markets", query: "events", icon: "calendar" },
  { label: "Gift Cards", query: "gift card", icon: "gift" }
];

function getSearchConfig(content) {
  const raw = (content && content.search) || {};
  const title =
    typeof raw.chipsTitle === "string" && raw.chipsTitle.trim()
      ? raw.chipsTitle.trim().slice(0, 60)
      : "Popular Searches";
  let chips = Array.isArray(raw.popularChips) ? raw.popularChips : [];
  chips = chips
    .filter(function (c) {
      return c && typeof c.label === "string" && typeof c.query === "string";
    })
    .map(function (c) {
      return {
        label: c.label.trim().slice(0, 40),
        query: c.query.trim().slice(0, 60),
        icon: SEARCH_CHIP_ICONS[c.icon] ? c.icon : "sparkle"
      };
    })
    .filter(function (c) {
      return c.label && c.query;
    })
    .slice(0, 8);
  if (!chips.length) chips = DEFAULT_SEARCH_CHIPS.slice();
  return { chipsTitle: title, popularChips: chips };
}

function renderSearchChipsHtml(chips, indent) {
  const pad = indent || "";
  return chips
    .map(function (c) {
      return (
        pad +
        '<button type="button" class="search-chip" data-search-query="' +
        escapeHtml(c.query) +
        '"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        SEARCH_CHIP_ICONS[c.icon] +
        "</svg><span>" +
        escapeHtml(c.label) +
        "</span></button>"
      );
    })
    .join("\n");
}

/* Extra search words from /admin are merged into the built-in synonym
   table. They only ever translate what a shopper typed (query side), which
   is why symptom words are acceptable here and not in product keywords --
   but the build still refuses the handful of words that would read as a
   treatment claim anywhere. */
const SEARCH_SYNONYM_BANNED = [
  "wound",
  "infection",
  "psoriasis",
  "cure",
  "cures",
  "treats",
  "treatment",
  "diagnose",
  "prescription",
  "medicine",
  "medical"
];

function buildSearchSynonyms(defaults, extra) {
  const out = {};
  Object.keys(defaults).forEach(function (k) {
    out[k] = defaults[k].slice();
  });
  if (extra === undefined || extra === null) return out;
  if (!Array.isArray(extra)) {
    throw new Error("content.json search.extraSynonyms must be a list of { key, terms } entries");
  }
  extra.forEach(function (entry, i) {
    if (!entry || typeof entry.key !== "string") {
      throw new Error("search.extraSynonyms[" + i + "] needs a key");
    }
    const key = entry.key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, "")
      .replace(/\s+/g, "_");
    if (!key) throw new Error("search.extraSynonyms[" + i + "] has an empty key");
    const terms = (Array.isArray(entry.terms) ? entry.terms : [])
      .filter(function (t) {
        return typeof t === "string" && t.trim();
      })
      .map(function (t) {
        return t.trim().toLowerCase().slice(0, 60);
      });
    if (!terms.length)
      throw new Error("search.extraSynonyms[" + i + "] (" + key + ") has no words");
    [key.replace(/_/g, " ")].concat(terms).forEach(function (t) {
      t.split(/\s+/).forEach(function (w) {
        if (SEARCH_SYNONYM_BANNED.indexOf(w) !== -1) {
          throw new Error(
            'search.extraSynonyms: "' +
              t +
              '" (' +
              key +
              ") reads as a treatment claim and is refused"
          );
        }
      });
    });
    out[key] = (out[key] || []).concat(
      terms.filter(function (t) {
        return (out[key] || []).indexOf(t) === -1;
      })
    );
  });
  return out;
}

/* Render one FAQ answer: HTML-escape first, then turn [text](url) into a
   real link with the URL run through safeLinkUrl(). A javascript: URL used
   to be emitted verbatim here (Low finding in the audit -- only the CSP
   stopped it executing); now the link is dropped and the text survives. The
   answer is escaped BEFORE the Markdown pass, so `url` is already
   attribute-safe by the time it reaches the href. */
function renderFaqAnswerHtml(answer) {
  return escapeHtml(answer).replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, text, url) {
    const href = safeLinkUrl(url);
    return href ? '<a href="' + href + '">' + text + "</a>" : text;
  });
}

/* ---------- Localization ----------
   The locale codes whose dictionaries assets/data/locales/ ships. This drives
   the dictionary load and the build-time validation below. It deliberately
   does NOT drive any SEO annotation -- see the note on hreflang at the
   robots.txt block. */
const SUPPORTED_LOCALES = ["en", "es", "de", "fr", "ja", "zh"];

function validateLocalesAndGlossary(locales, glossary) {
  if (!glossary || !Array.isArray(glossary.protectedTerms) || !glossary.protectedTerms.length) {
    throw new Error("brand-glossary.json must define a non-empty protectedTerms array.");
  }
  const protectedTerms = glossary.protectedTerms;
  const nonEnglishLocales = ["es", "de", "fr", "ja", "zh"];

  if (!locales || !locales.en || !locales.en.phrases) {
    throw new Error("Canonical English locale (en.json) is missing or has no phrases.");
  }

  const enPhrases = locales.en.phrases;

  nonEnglishLocales.forEach(function (lang) {
    const loc = locales[lang];
    if (!loc || !loc.phrases) {
      throw new Error("Locale '" + lang + "' is missing or has no phrases.");
    }

    Object.keys(enPhrases).forEach(function (key) {
      const enText = enPhrases[key];
      const targetText = loc.phrases[key];
      if (!targetText) return;
      protectedTerms.forEach(function (term) {
        if (enText.indexOf(term) !== -1) {
          if (targetText.indexOf(term) === -1) {
            throw new Error(
              "Protected term violation in locale '" +
                lang +
                "' for key '" +
                key +
                "': expected protected term '" +
                term +
                "' to be preserved verbatim in '" +
                targetText +
                "'."
            );
          }
        }
      });
    });
  });
  return true;
}

/* ---------- Dictionary coverage gate ----------

   The first cut of the locale files was authored against an imagined shop:
   120 of its 206 English values (58%) matched nothing on any page, because
   the lookup in assets/js/translator.js is exact string equality on a node's
   trimmed text. "Your cart is empty" never fired because the DOM says "Your
   cart is empty."; "Patch Test" never fired because the DOM says "Patch
   Test:". Nothing caught it: validateLocalesAndGlossary only checks that a
   translation keeps its protected terms, and it `return`s early on a missing
   key, so a locale missing half its entries passed.

   These four rules are the check that would have caught all of it:

     1. every English value is reachable -- it appears verbatim in a built
        HTML file, or in the runtime manifest of strings that only
        main.js/cart.js render;
     2. every locale carries every key, non-empty;
     3. every locale value differs from English, unless the key/locale pair is
        on IDENTICAL_BY_DESIGN below with a stated reason;
     4. every English value still matches the digest recorded in
        assets/data/i18n-translation-basis.json, so editing a page's copy
        cannot quietly leave five stale translations behind reporting green.

   All four are static and browserless on purpose: they have to run inside
   `npm run build-data` and CI's `qa` job, which sets PUPPETEER_SKIP_DOWNLOAD.
   scripts/extract-i18n-strings.js is the browser-driven authoring tool that
   produces the candidate strings; this is the gate that keeps them honest. */

/* Locale values that are legitimately identical to the English. Every entry
   needs a reason -- "the word is the same in that language" is a reason,
   "we did not get to it" is not. */
const IDENTICAL_BY_DESIGN = {
  "nav.shop": { de: "Shop is the ordinary German retail word" },
  "nav.contact": { fr: "Contact is the ordinary French word" },
  "nav.faq": { de: "FAQ is used as-is", fr: "FAQ is used as-is" },
  "nav.slashShop": { de: "breadcrumb of nav.shop" },
  "nav.slashFaq": { de: "breadcrumb of nav.faq", fr: "breadcrumb of nav.faq" },
  "search.esc": {
    es: "ESC is the key legend printed on the keyboard",
    de: "ESC is the key legend printed on the keyboard",
    ja: "ESC is the key legend printed on the keyboard",
    zh: "ESC is the key legend printed on the keyboard"
  },
  "shop.vegan": { de: "Vegan is the ordinary German word", fr: "Vegan is used as-is" },
  "cart.subtotal": { es: "Subtotal is the ordinary Spanish word" },
  "box.optional": { de: "Optional is the ordinary German word" },
  "box.catPotions": { fr: "POTIONS is the ordinary French word" },
  "gift.optional": { de: "Optional is the ordinary German word" },
  "reviews.name": { de: "Name is the ordinary German word" },
  "reviews.general": { es: "General is the ordinary Spanish word" }
};

/* Every named entity the built pages actually use, plus the structural four.
   This list is not decoration: "Next Step &rarr;" is a single text node in the
   DOM and the dictionary key for it is "Next Step →", so a decoder that stops
   at &amp; reports a live string as a dead one. */
const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&middot;": "·",
  "&times;": "×",
  "&mdash;": "—",
  "&ndash;": "–",
  "&minus;": "−",
  "&copy;": "©",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&hellip;": "…",
  "&rarr;": "→",
  "&larr;": "←",
  "&bull;": "•",
  "&deg;": "°",
  "&apos;": "'",
  "&nbsp;": " "
};

function decodeHtmlEntities(html) {
  let out = html;
  Object.keys(HTML_ENTITIES).forEach(function (ent) {
    out = out.split(ent).join(HTML_ENTITIES[ent]);
  });
  out = out.replace(/&#(\d+);/g, function (_m, dec) {
    return String.fromCodePoint(Number(dec));
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, function (_m, hex) {
    return String.fromCodePoint(parseInt(hex, 16));
  });
  return out;
}

function collectBuiltHtml() {
  const files = fs
    .readdirSync(ROOT)
    .filter(function (f) {
      return f.endsWith(".html");
    })
    .map(function (f) {
      return path.join(ROOT, f);
    });
  const productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir)
      .filter(function (f) {
        return f.endsWith(".html");
      })
      .forEach(function (f) {
        files.push(path.join(productsDir, f));
      });
  }
  return files.map(function (p) {
    /* Comments are stripped because build-site-data wraps replaceable copy in
       <!--YL:key--> markers, which land in the middle of a sentence that the
       browser still exposes as one text node. */
    const raw = fs.readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    return { name: path.relative(ROOT, p), text: decodeHtmlEntities(raw) };
  });
}

function digestEnglish(value) {
  return crypto.createHash("sha1").update(value, "utf8").digest("hex").slice(0, 10);
}

function validateDictionaryCoverage(locales, runtimeManifest, basisDoc) {
  const problems = [];
  const enPhrases = locales.en.phrases;
  const keys = Object.keys(enPhrases);
  if (!keys.length) {
    throw new Error("Canonical English locale has no phrases -- nothing to gate.");
  }

  const manifestStrings = (runtimeManifest && runtimeManifest.strings) || [];
  if (!manifestStrings.length) {
    throw new Error(
      "assets/data/i18n-runtime-strings.json declares no strings. The cart drawer, " +
        "search results and quiz results exist only at runtime, so an empty manifest " +
        "means this gate would report them as dead dictionary entries."
    );
  }
  const runtimeTexts = new Set(
    manifestStrings.map(function (s) {
      return s.text;
    })
  );

  /* The manifest is only trustworthy while the copy it describes still exists.
     Without this, editing a string in cart.js would leave the manifest
     asserting a string nothing renders, and rule 1 would keep passing over a
     dictionary entry that can never match again. Each entry names the file that
     decides its wording and the literal fragments of that file which have to
     survive -- for a string the site assembles from data plus a template
     ("+ Item 1", "SALVES") the fragments are the template and the datum, since
     the finished string is a literal nowhere. */
  const sourceCache = {};
  function readSource(rel) {
    if (!Object.prototype.hasOwnProperty.call(sourceCache, rel)) {
      const p = path.join(ROOT, rel);
      sourceCache[rel] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    }
    return sourceCache[rel];
  }
  manifestStrings.forEach(function (entry) {
    const src = entry.source ? readSource(entry.source) : null;
    if (src === null) {
      problems.push(
        "runtime manifest entry '" +
          entry.key +
          "' names a source that does not exist: " +
          JSON.stringify(entry.source)
      );
      return;
    }
    const decoded = decodeHtmlEntities(src);
    const fragments =
      Array.isArray(entry.verify) && entry.verify.length ? entry.verify : [entry.text];
    const missing = fragments.filter(function (frag) {
      return src.indexOf(frag) === -1 && decoded.indexOf(frag) === -1;
    });
    if (missing.length) {
      problems.push(
        "runtime manifest entry '" +
          entry.key +
          "' no longer matches " +
          entry.source +
          " -- missing " +
          JSON.stringify(missing)
      );
    }
  });

  // Rule 1: reachability.
  const pages = collectBuiltHtml();
  if (!pages.length) {
    throw new Error("No built HTML pages found -- refusing to report dictionary coverage.");
  }
  const unreachable = [];
  keys.forEach(function (key) {
    const value = enPhrases[key];
    if (runtimeTexts.has(value)) return;
    const found = pages.some(function (page) {
      return page.text.indexOf(value) !== -1;
    });
    if (!found) unreachable.push(key + " = " + JSON.stringify(value));
  });
  if (unreachable.length) {
    problems.push(
      unreachable.length +
        " English dictionary value(s) appear nowhere in the built site and are not " +
        "declared as runtime strings, so the translator can never match them:\n    " +
        unreachable.join("\n    ")
    );
  }

  // Rules 2 and 3: completeness, and difference from English.
  SUPPORTED_LOCALES.slice(1).forEach(function (lang) {
    const phrases = locales[lang] && locales[lang].phrases;
    if (!phrases) {
      problems.push("locale '" + lang + "' has no phrases");
      return;
    }
    const missing = [];
    const identical = [];
    keys.forEach(function (key) {
      const value = phrases[key];
      if (typeof value !== "string" || !value.trim()) {
        missing.push(key);
        return;
      }
      if (value === enPhrases[key]) {
        const allowed = IDENTICAL_BY_DESIGN[key] && IDENTICAL_BY_DESIGN[key][lang];
        if (!allowed) identical.push(key + " = " + JSON.stringify(value));
      }
    });
    const extra = Object.keys(phrases).filter(function (k) {
      return !Object.prototype.hasOwnProperty.call(enPhrases, k);
    });
    if (missing.length) {
      problems.push(
        "locale '" +
          lang +
          "' is missing or has empty values for " +
          missing.length +
          " key(s): " +
          missing.slice(0, 12).join(", ") +
          (missing.length > 12 ? ", ..." : "")
      );
    }
    if (extra.length) {
      problems.push(
        "locale '" +
          lang +
          "' has " +
          extra.length +
          " key(s) that en.json does not: " +
          extra.slice(0, 12).join(", ")
      );
    }
    if (identical.length) {
      problems.push(
        "locale '" +
          lang +
          "' leaves " +
          identical.length +
          " value(s) identical to English with no entry in IDENTICAL_BY_DESIGN:\n    " +
          identical.join("\n    ")
      );
    }
  });

  // Rule 4: the English has not drifted away from what was translated.
  const basis = (basisDoc && basisDoc.basis) || null;
  if (!basis) {
    throw new Error(
      "assets/data/i18n-translation-basis.json is missing or has no `basis` map. " +
        "Without it nothing detects an English string that changed after it was translated."
    );
  }
  const stale = [];
  keys.forEach(function (key) {
    const recorded = basis[key];
    const actual = digestEnglish(enPhrases[key]);
    if (recorded === undefined) {
      stale.push(key + " (no recorded basis)");
    } else if (recorded !== actual) {
      stale.push(key + " -> " + JSON.stringify(enPhrases[key]));
    }
  });
  if (stale.length) {
    problems.push(
      stale.length +
        " key(s) whose English changed since the five translations were authored " +
        "against it. Re-translate them, then re-record with " +
        "`node scripts/extract-i18n-strings.js --record-basis`:\n    " +
        stale.join("\n    ")
    );
  }

  if (problems.length) {
    throw new Error("Dictionary coverage gate failed:\n  - " + problems.join("\n  - "));
  }
  console.log(
    "[build] dictionary coverage: " +
      keys.length +
      " key(s) x " +
      SUPPORTED_LOCALES.length +
      " locales, all reachable in " +
      pages.length +
      " built pages or the runtime manifest"
  );
  return true;
}

/* ---------- CMS integration IDs ----------
   Every one of these lands in either an HTML attribute or a JavaScript
   string literal inside a CSP-hashed inline script, and all of them are
   editable from /admin. The sinks below escape properly now, but a value
   that isn't a plausible ID is a mistake or an attack either way, so the
   build refuses it outright rather than shipping an escaped payload. The
   same patterns are declared as `pattern:` validators in admin/config.yml so
   the CMS rejects them before they are ever committed -- this check is the
   backstop for a hand-edit or a direct commit. */
const SITE_ID_RULES = [
  {
    key: "tawkToPropertyId",
    re: /^[A-Za-z0-9]{1,40}$/,
    placeholders: ["YOUR_TAWKTO_PROPERTY_ID"],
    describe: "letters and digits only, 1-40 characters"
  },
  {
    key: "tawkToWidgetId",
    re: /^[A-Za-z0-9]{1,40}$/,
    placeholders: ["YOUR_TAWKTO_WIDGET_ID"],
    describe: "letters and digits only, 1-40 characters"
  },
  {
    key: "umamiWebsiteId",
    re: /^[A-Za-z0-9-]{0,64}$/,
    placeholders: ["YOUR_UMAMI_WEBSITE_ID"],
    describe: "letters, digits and hyphens only, up to 64 characters"
  },
  {
    key: "giftUpId",
    re: /^[A-Za-z0-9-]{0,64}$/,
    placeholders: ["YOUR_GIFTUP_ID"],
    describe: "letters, digits and hyphens only, up to 64 characters"
  },
  {
    key: "formspreeContactId",
    re: /^[A-Za-z0-9_-]{1,64}$/,
    placeholders: ["YOUR_FORM_ID"],
    describe: "letters, digits, underscore and hyphen only, 1-64 characters"
  },
  {
    key: "formspreeReviewId",
    re: /^[A-Za-z0-9_-]{1,64}$/,
    placeholders: ["YOUR_FORMSPREE_FORM_ID"],
    describe: "letters, digits, underscore and hyphen only, 1-64 characters"
  },
  {
    key: "formspreeRestockId",
    re: /^[A-Za-z0-9_-]{1,64}$/,
    placeholders: ["YOUR_FORMSPREE_FORM_ID"],
    describe: "letters, digits, underscore and hyphen only, 1-64 characters"
  }
];

function validateSiteIds(site) {
  const problems = [];
  SITE_ID_RULES.forEach(function (rule) {
    const value = site ? site[rule.key] : undefined;
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    // An empty field means "not configured yet" -- every one of these is
    // optional in /admin and the sinks below already handle the empty case.
    if (str === "") return;
    if (rule.placeholders.indexOf(str) !== -1) return;
    if (!rule.re.test(str)) {
      problems.push(
        "  - site." +
          rule.key +
          ' is "' +
          str +
          '"\n      allowed: ' +
          rule.describe +
          " (or the placeholder " +
          rule.placeholders[0] +
          ")"
      );
    }
  });
  if (problems.length) {
    console.error(
      "\n[build] assets/data/content.json has integration IDs that don't look like IDs:\n" +
        problems.join("\n") +
        "\n\n        These values are written into HTML attributes and into the inline\n" +
        "        live-chat script, so the build stops rather than publishing them.\n" +
        "        Fix the field in /admin (Site Settings) or in content.json and rebuild.\n"
    );
    process.exit(1);
  }
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

function validatePairsWith(products, productsMap) {
  const map = productsMap || PRODUCTS_BY_ID || {};
  (products || []).forEach(function (p) {
    if (p.pairsWith !== undefined && p.pairsWith !== null) {
      if (!Array.isArray(p.pairsWith)) {
        throw new Error("Product '" + (p.id || "unknown") + "' pairsWith must be an array");
      }
      p.pairsWith.forEach(function (pairedId) {
        if (pairedId === p.id) {
          throw new Error("Product '" + p.id + "' cannot pair with itself in pairsWith");
        }
        if (!map[pairedId]) {
          throw new Error(
            "Product '" + p.id + "' pairsWith references unknown product ID: '" + pairedId + "'"
          );
        }
      });
      if (p.ritualTitle !== undefined && p.ritualTitle !== null) {
        if (typeof p.ritualTitle !== "string" || !p.ritualTitle.trim()) {
          throw new Error("Product '" + p.id + "' ritualTitle must be a non-empty string");
        }
      }
    }
  });
  return true;
}

function renderSocialRowHtml(social) {
  const soc = social || {};
  const links = [];

  const icons = {
    instagram: {
      label: "Instagram (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></svg>'
    },
    tiktok: {
      label: "TikTok (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3c.4 2.3 2 4 4.7 4.2v3c-1.7 0-3.3-.5-4.7-1.4v6.7c0 3.1-2.5 5.5-5.6 5.5S3.8 18.6 3.8 15.5c0-3 2.4-5.5 5.6-5.5.4 0 .8 0 1.1.1v3.1c-.3-.1-.7-.2-1.1-.2-1.3 0-2.4 1.1-2.4 2.5s1.1 2.5 2.4 2.5 2.5-1 2.6-2.4V3H15z"/></svg>'
    },
    facebook: {
      label: "Facebook (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 8.5h2.5V5H14c-2 0-3.5 1.6-3.5 3.5V11H8v3.5h2.5V21H14v-6.5h2.3l.7-3.5h-3V9c0-.3.2-.5.5-.5z"/></svg>'
    },
    etsy: {
      label: "Etsy shop (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8l1-4h14l1 4"/><path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8z"/><path d="M9 12a3 3 0 0 0 6 0"/></svg>'
    },
    pinterest: {
      label: "Pinterest (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2a10 10 0 0 0-3.6 19.3c-.05-.8-.1-2.1.02-3 .12-.8 1-4.2 1-4.2s-.25-.5-.25-1.3c0-1.2.7-2.1 1.6-2.1.75 0 1.1.56 1.1 1.24 0 .76-.48 1.9-.74 2.95-.2.9.46 1.63 1.34 1.63 1.6 0 2.85-1.7 2.85-4.14 0-2.16-1.55-3.68-3.77-3.68-2.57 0-4.08 1.93-4.08 3.92 0 .78.3 1.6.67 2.06a.3.3 0 0 1 .07.29c-.07.3-.23.95-.26 1.09-.04.18-.15.22-.34.13-1.27-.6-2.07-2.45-2.07-3.95 0-3.2 2.33-6.15 6.72-6.15 3.53 0 6.27 2.52 6.27 5.88 0 3.5-2.21 6.33-5.28 6.33-1.03 0-2-.54-2.33-1.17l-.64 2.43c-.23.9-.86 2.02-1.28 2.72A10 10 0 1 0 12 2z"/></svg>'
    },
    youtube: {
      label: "YouTube (opens in new tab)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="currentColor"/></svg>'
    }
  };

  ["instagram", "tiktok", "facebook", "etsy", "pinterest", "youtube"].forEach(function (key) {
    const rawUrl = soc[key];
    if (typeof rawUrl === "string" && rawUrl.trim()) {
      const sanitized = safeUrl(rawUrl.trim());
      if (sanitized) {
        const item = icons[key];
        links.push(
          '          <a href="' +
            escapeHtml(sanitized) +
            '" target="_blank" rel="noopener" aria-label="' +
            item.label +
            '">\n            ' +
            item.svg +
            "\n          </a>"
        );
      }
    }
  });

  return '<div class="social-row">\n' + links.join("\n") + "\n        </div>";
}

function getActiveSocialUrls(social) {
  const soc = social || {};
  const urls = [];
  ["etsy", "facebook", "instagram", "tiktok", "pinterest", "youtube"].forEach(function (key) {
    const rawUrl = soc[key];
    if (typeof rawUrl === "string" && rawUrl.trim()) {
      const sanitized = safeUrl(rawUrl.trim());
      if (sanitized && urls.indexOf(sanitized) === -1) {
        urls.push(sanitized);
      }
    }
  });
  urls.sort();
  return urls;
}

function validateQuizData(quiz, productsMap, categoriesMap, bundlesMap) {
  if (!quiz) return true;
  const questions = quiz.questions || quiz.steps || [];
  if (!Array.isArray(questions)) {
    throw new Error("Quiz questions must be an array");
  }

  const pMap = productsMap || {};
  const cMap = categoriesMap || {};
  const bMap = bundlesMap || {};

  questions.forEach(function (q, qIdx) {
    if (!q || typeof q !== "object") {
      throw new Error("Quiz question at index " + qIdx + " must be an object");
    }
    const options = q.options || [];
    if (!Array.isArray(options)) {
      throw new Error("Quiz question '" + (q.id || qIdx) + "' options must be an array");
    }
    options.forEach(function (opt, optIdx) {
      if (!opt || typeof opt !== "object") {
        throw new Error(
          "Quiz question '" + (q.id || qIdx) + "' option at index " + optIdx + " must be an object"
        );
      }
      if (Array.isArray(opt.recommendedProductIds)) {
        opt.recommendedProductIds.forEach(function (id) {
          if (!pMap[id] && !bMap[id]) {
            throw new Error(
              "Quiz option '" +
                (opt.value || optIdx) +
                "' in question '" +
                (q.id || qIdx) +
                "' references unknown product/bundle ID: '" +
                id +
                "'"
            );
          }
        });
      }
      if (Array.isArray(opt.categories)) {
        opt.categories.forEach(function (cat) {
          if (cMap && Object.keys(cMap).length && !cMap[cat]) {
            throw new Error(
              "Quiz option '" +
                (opt.value || optIdx) +
                "' in question '" +
                (q.id || qIdx) +
                "' references unknown category ID: '" +
                cat +
                "'"
            );
          }
        });
      }
    });
  });
  return true;
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

/* Availability for schema.org, derived from the real catalogue flags.
   shop.html's ItemList used to read `p.image.indexOf("placeholder")` instead,
   so the day a coming-soon product got a real photo the shop page started
   advertising it as InStock while the PDP still said PreOrder (Medium finding
   in the audit's data-integrity section). One helper, one answer. */
function schemaAvailability(product) {
  const p = product || {};
  if (p.inStock === false || p.stock === 0) return "https://schema.org/OutOfStock";
  /* Coming-soon products used to be marked PreOrder. schema.org/PreOrder means
     "orderable now, ships later" -- and Google Merchant reads it that way too,
     expecting a working purchase path and a ship date. Nothing here is
     orderable: the only control on a coming-soon PDP is a "Notify me when it
     launches" toggle, and the sticky bar's buy button is `disabled` and reads
     "Coming Soon". A shopping crawler that believed the old markup would have
     listed a buyable price against a page with no way to buy, which is the
     classic availability-mismatch disapproval (live audit 2026-09-02, M-5).
     BackOrder is no better -- Merchant Center defines it as a previously
     stocked item coming back that you ARE accepting orders for, and it wants
     an availability_date too. OutOfStock is the term in this vocabulary that
     means exactly what is true: not purchasable right now. Google supports it
     directly and it carries no disapproval risk, unlike advertising a price
     as orderable against a page with no purchase path.

     The alternative considered and rejected: drop the whole `offers` block
     while the waitlist is the only action, so the page asserts nothing at all
     about price or availability. That is arguably the purest answer, but it
     costs the page its Product offer and price signal for a state that ends
     on launch day, and it would mean loosening four existing gates that
     currently assert every product carries a priced offer (qa-check's
     ItemList section, challenger-r2-r5, verify-pdp-metadata,
     build-site-data.test). OutOfStock keeps every one of those honest and
     still tells the truth. The price stays on the Offer -- an Offer with no
     price is invisible in Merchant Center, and the price IS what the product
     will cost. The page stays indexable, because a launch page that ranks
     before launch day is the entire point of the waitlist. */
  if (p.comingSoon === true) return "https://schema.org/OutOfStock";
  return "https://schema.org/InStock";
}

/* Page <title> for a product, kept inside the ~60 characters Google renders
   before it truncates. Four product names are long enough that the full
   " | Y'allternative Living" suffix pushed the title past that and the brand
   -- the half most worth keeping -- was what got cut (live audit 2026-09-02,
   L-7). Shorten the suffix rather than the product name: a shopper scanning a
   SERP needs the product, and "Y'allternative" alone still reads as the shop.
   A name that already carries the brand drops the suffix entirely instead of
   saying it twice. scripts/qa-check.js enforces the 60-character ceiling on
   every page so this cannot quietly regress. */
const PDP_TITLE_MAX = 60;
function pdpPageTitle(name) {
  const clean = String(name == null ? "" : name).trim();
  const full = clean + " | Y'allternative Living";
  if (full.length <= PDP_TITLE_MAX) return full;
  if (/y'?allternative/i.test(clean)) return clean;
  const short = clean + " | Y'allternative";
  return short.length <= PDP_TITLE_MAX ? short : clean;
}

/* ---------- raster stand-ins for the coming-soon SVG (audit C, H3) ----------
   The five coming-soon products carry assets/img/placeholder-coming-soon.svg
   as their only photo. That renders fine ON the page, but it was also being
   emitted as <meta property="og:image"> and as the schema.org Product image,
   and neither of those consumers accepts SVG: Facebook, X, LinkedIn, Slack
   and iMessage all render an imageless card, and Google Merchant rejects SVG
   product imagery outright. Every share of those five produced a blank card.

   So social and structured-data images go through here and never see an SVG.
   The two rasters are pre-rendered from the same SVG with the "sharp" dep
   this repo already uses; regenerate them after editing the SVG with:

     node -e "const s=require('sharp');const bg={r:0x17,g:0x13,b:0x0f,alpha:1};\
     const f='assets/img/placeholder-coming-soon';\
     s(f+'.svg',{density:400}).resize({width:1200,height:1200,fit:'contain',background:bg})\
       .flatten({background:bg}).png({compressionLevel:9}).toFile(f+'-1200.png');\
     s(f+'.svg',{density:400}).resize({width:1200,height:630,fit:'contain',background:bg})\
       .flatten({background:bg}).jpeg({quality:86,progressive:true}).toFile(f+'-og.jpg')"

   Any OTHER .svg that ever becomes a product image falls back to the site's
   own og-image.jpg, which is a known-good 1200x630 JPEG -- a generic brand
   card beats a card that renders nothing. */
const COMING_SOON_SVG = "assets/img/placeholder-coming-soon.svg";
const RASTER_SOCIAL_IMAGE = "assets/img/placeholder-coming-soon-og.jpg"; // 1200x630
const RASTER_PRODUCT_IMAGE = "assets/img/placeholder-coming-soon-1200.png"; // 1200x1200
const SITE_OG_IMAGE = "assets/img/og-image.jpg"; // 1200x630

function rasterImagePath(imagePath, kind) {
  const raw = String(imagePath == null ? "" : imagePath).replace(/^\/+/, "");
  if (!/\.svg$/i.test(raw)) return raw;
  if (raw === COMING_SOON_SVG) {
    return kind === "product" ? RASTER_PRODUCT_IMAGE : RASTER_SOCIAL_IMAGE;
  }
  return SITE_OG_IMAGE;
}

/* Meta descriptions are cut to <=155 characters at a word boundary.
   Google truncates around 155-160 and the raw product blurbs run to 304, so
   20 of them were being cut mid-word by the search engine instead (Medium
   finding in the audit's SEO section). The visible on-page description is
   never truncated -- only what goes into <meta>/og:/twitter: tags. */
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

let PRODUCTS_BY_ID = {};

/* The shop's canonical origin. Module-scoped because both the in-build DOMAIN
   constant (canonical URLs, sitemap, JSON-LD) and the analytics tag's
   data-domains allow-list have to agree about what "this site" is. */
const SITE_ORIGIN = "https://yallternativeliving.com";

/* Umami analytics, emitted only when the CMS holds a real website id. Both
   halves (the preconnect and the script) come from here so the hand-written
   pages and the generated PDPs cannot drift apart -- the PDPs, where Add to
   Cart actually happens, shipped without analytics until 2026-09-02. */
function umamiIsConfigured(site) {
  if (!site || site.umamiWebsiteId === undefined) return false;
  const val = String(site.umamiWebsiteId).trim();
  return Boolean(val && val !== "YOUR_UMAMI_WEBSITE_ID");
}

/* The hostnames that ARE this shop. data-domains is a client-side allow-list
   matched against window.location.hostname: on anything else the tracker
   disables itself entirely -- no pageview, no events, no request. That is what
   keeps localhost, 127.0.0.1 (the port the Puppeteer suites serve on), Netlify
   deploy previews at *.netlify.app and any agent's local checkout out of the
   production dataset. It is not a nicety: Umami's server-side bot filter is the
   `isbot` User-Agent matcher, and Chrome's modern headless mode sends an
   ordinary Chrome User-Agent, so nothing upstream would have caught a test run.
   Umami Cloud's IP-filter feature, the other lever, starts at the Pro plan.
   Derived from DOMAIN so it cannot drift from the canonical URLs. */
function umamiDomains() {
  const host = SITE_ORIGIN.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return host + ",www." + host;
}

/* Tracker attributes, and why each one is there:
   - src: this tag does NOT load the tracker. It loads our own
     assets/js/porch-light.js, which injects exactly one of two copies: the
     direct cloud.umami.is one first, and the first-party /porch-light/ one
     only if that fails to load. Read that file, and docs/ANALYTICS.md §7, for
     why -- the short version is that proxying everybody would cost everybody
     their real session id and country to recover the blocked minority, so the
     proxy is the fallback rather than the default.

     Every data-* attribute below is copied verbatim onto whichever copy the
     loader injects, so this list stays the single description of the tracker's
     configuration. The loader adds two of its own to the fallback copy only:
     data-host-url (the first-party send path) and data-tag="fallback", which
     is what lets the dashboard tell proxied sessions apart from real ones.
   - data-domains: see umamiDomains() above.
   - data-performance: Core Web Vitals (LCP, INP, CLS, FCP, TTFB) measured on
     real visitors' devices instead of guessed at from a lab run. One extra
     request per page load, which on the free Hobby tier costs one of the
     100,000 events a month -- roughly doubling the pageview spend. Worth it for
     a shop whose visitors are mostly on phones on rural connections; set it
     back to "false" (or drop the attribute) if the quota ever gets tight.
     Requires tracker v3.1.0+.
   - data-exclude-search: the tracker drops the query string from the recorded
     URL *and* the recorded referrer before anything is sent. This site puts a
     Stripe Checkout Session id in thank-you.html?session_id=, a subscriber's
     address in welcome.html?email= and an adverse-reaction report reference in
     safety.html?ref=, and the in-page history.replaceState() scrubs those pages
     perform all run too late to help -- the tracker reads location.href when its
     own script evaluates. Excluding the search string is the layer that fails
     closed if none of our own JavaScript runs at all.
   - data-exclude-hash: the fragment is dropped too. Nothing secret lives in a
     hash here, but it keeps /shop.html and /shop.html#apparel from splitting
     into two rows in the Pages report, and it closes the channel rather than
     leaving it open for whatever a later feature decides to put there.
   - data-do-not-track is deliberately ABSENT. Umami ignores the browser's Do
     Not Track header unless that attribute is set to "true", and this shop
     does not set it: DNT was retired by the browsers that shipped it (Firefox
     removed the setting, Safari removed it in 2018), it carries no legal force
     over cookieless aggregate measurement that stores no personal data, and
     the only thing honouring it achieved here was a smaller number. What the
     privacy page promises instead is what the code actually does -- no
     cookies, no cross-site identity, no personal data in any payload -- plus
     the localStorage switch that turns analytics off completely
     (`localStorage.setItem("umami.disabled", 1)`), which is honoured by the
     tracker itself. Owner decision, 2026-09-02.
   - data-before-send: names window.ylAnalyticsBeforeSend (assets/js/main.js),
     which puts the utm_* campaign parameters back so Etsy/Instagram/market-QR
     attribution still works, drops prerendered pageviews, and scrubs event
     properties. Umami resolves the name on window at send time, so it does not
     matter that main.js runs after this tag on some pages. */
function umamiScriptHtml(site) {
  return umamiIsConfigured(site)
    ? '<script defer src="' +
        escapeHtml(ANALYTICS_LOADER_PATH) +
        '" data-website-id="' +
        escapeHtml(String(site.umamiWebsiteId).trim()) +
        '" data-domains="' +
        escapeHtml(umamiDomains()) +
        '" data-exclude-search="true" data-exclude-hash="true"' +
        ' data-performance="true" data-before-send="ylAnalyticsBeforeSend"></script>'
    : "";
}
/* Deliberately empty now, and the marker stays so the slot is still there.
   The tracker is served from THIS origin (see umamiScriptHtml above), which
   the browser is already connected to, so a preconnect would buy nothing --
   and the old `<link rel="preconnect" href="https://cloud.umami.is">` opened a
   TLS connection to Umami on every page load, handing them the visitor's IP
   and the SNI for their hostname before any decision to track had been made.
   The proxy removes that; emitting nothing here is what removes it from the
   already-built pages. */
function umamiPreconnectHtml() {
  return "";
}

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
  const SOCIAL_FEED = readJson("assets/data/social-feed.json");
  const CONTENT = readJson("assets/data/content.json");
  /* The quiz has its own file so /admin can offer it as its own section;
     main.js still reads it as YL_CONTENT.quiz, so it is merged back here. */
  CONTENT.quiz = readJson("assets/data/quiz.json");
  const JOURNAL = loadJournal(CONTENT);
  const BRAND_GLOSSARY = readJson("assets/data/brand-glossary.json");
  const LOCALES = {};
  SUPPORTED_LOCALES.forEach(function (lang) {
    LOCALES[lang] = readJson("assets/data/locales/" + lang + ".json");
  });
  validateLocalesAndGlossary(LOCALES, BRAND_GLOSSARY);
  const I18N_RUNTIME_STRINGS = readJson("assets/data/i18n-runtime-strings.json");
  const I18N_TRANSLATION_BASIS = readJson("assets/data/i18n-translation-basis.json");

  const SEARCH_CONFIG = getSearchConfig(CONTENT);
  const SITE_CONFIG = CONTENT.site || {};
  validateSiteIds(SITE_CONFIG);

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

  /* 2b. Validate PairsWith Referential Integrity */
  validatePairsWith(PRODUCTS, PRODUCTS_BY_ID);

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

  /* 5. Journal post guards (ids come from the file names, see loadJournal) */
  JOURNAL.posts.forEach(function (post) {
    if (!post.title || !post.date) {
      console.error(
        "\n[build] " + JOURNAL_DIR + "/" + post.id + ".json needs both a title and a date."
      );
      process.exit(1);
    }
  });

  /* 5b. Journal -> product referential integrity.
   Bundles and pairsWith have been checked since they existed; this relation
   was not, and both shipped posts pointed at products that do not exist
   ("magnesium-body-butter", "pine-tar-salve"), so journal.html rendered a
   featured-product card for nothing at all. */
  ((JOURNAL && JOURNAL.posts) || []).forEach(function (post) {
    if (post.featuredProductId && !PRODUCTS_BY_ID[post.featuredProductId]) {
      console.error(
        "\n[build] Journal post '" +
          (post.id || post.title) +
          "' has featuredProductId '" +
          post.featuredProductId +
          "', which is not a product in products.json.\n" +
          "        Set it to a real product id (or clear the field) and rebuild.\n"
      );
      process.exit(1);
    }
  });

  /* 5c. Ratings must be backed by something real.
   A product's aggregateRating is published to Google. It is legitimate when
   the product has a live Etsy listing in scripts/etsy-snapshot.json (whose
   per-listing rating is what apply-etsy-snapshot.js writes) OR when at least
   one review for it exists in assets/data/site-reviews.json -- website
   reviews are real reviews and keep arriving. Anything else is a fabricated
   rating and a structured-data manual-action risk (audit, data integrity,
   High), so the build stops. */
  const REVIEWED_PRODUCT_IDS = {};
  SITE_REVIEWS.forEach(function (r) {
    if (r && r.productId) REVIEWED_PRODUCT_IDS[r.productId] = true;
  });
  let ETSY_LISTING_IDS = null;
  try {
    const snapPath = path.join(__dirname, "etsy-snapshot.json");
    if (fs.existsSync(snapPath)) {
      const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
      ETSY_LISTING_IDS = {};
      (snap.listings || []).forEach(function (l) {
        if (l && l.listingId) ETSY_LISTING_IDS[String(l.listingId)] = true;
      });
    }
  } catch (e) {
    console.warn("[build] Warning: could not read scripts/etsy-snapshot.json: " + e.message);
    ETSY_LISTING_IDS = null;
  }
  const unbackedRatings = [];
  PRODUCTS.forEach(function (p) {
    if (!p.rating) return;
    const listingMatch = /\/listing\/(\d+)(?:\/|$)/.exec(String(p.etsyUrl || ""));
    const hasEtsyListing =
      ETSY_LISTING_IDS === null
        ? !!listingMatch // no snapshot to check against -- don't fail on it
        : !!(listingMatch && ETSY_LISTING_IDS[listingMatch[1]]);
    const hasSiteReview = !!REVIEWED_PRODUCT_IDS[p.id];
    if (!hasEtsyListing && !hasSiteReview) {
      unbackedRatings.push(p.id + " (" + p.name + ")");
    }
    if (p.comingSoon && (hasEtsyListing || hasSiteReview)) {
      console.warn(
        "[build] Warning: '" +
          p.id +
          "' is marked coming soon but carries a rating -- check that is intended."
      );
    }
  });
  if (unbackedRatings.length) {
    console.error(
      "\n[build] These products carry a `rating` with nothing behind it:\n" +
        unbackedRatings
          .map(function (x) {
            return "  - " + x;
          })
          .join("\n") +
        "\n\n        A rating needs EITHER an Etsy listing present in\n" +
        "        scripts/etsy-snapshot.json (matched on the /listing/<id> in etsyUrl)\n" +
        "        OR at least one review for that product in\n" +
        "        assets/data/site-reviews.json. Remove the rating, or add the review.\n"
    );
    process.exit(1);
  }

  /* 5d. "Verified buyer" reviews on products nobody can have bought yet.
   A warning, not a failure: the review may be a real tester's, and the owner
   decides. Only the verifiedBuyer badge is in question, not the review. */
  SITE_REVIEWS.forEach(function (r) {
    if (!r || r.verifiedBuyer !== true) return;
    // A review copied from Etsy is a purchase on Etsy: the product may be
    // coming soon HERE and still have been bought there.
    if (/\(Etsy\)\s*$/.test(String(r.name || ""))) return;
    const target = PRODUCTS_BY_ID[r.productId];
    if (target && target.comingSoon) {
      console.warn(
        "[build] Warning: review '" +
          r.id +
          "' is flagged verifiedBuyer but '" +
          r.productId +
          "' has never been on sale (comingSoon). Set verifiedBuyer to false unless it really was purchased."
      );
    }
  });

  /* 5f. Quiz -> product referential integrity */
  const BUNDLES_BY_ID = {};
  BUNDLES.forEach(function (b) {
    if (b.id) BUNDLES_BY_ID[b.id] = b;
  });
  const CATEGORIES_BY_ID = {};
  (CATALOG.categories || []).forEach(function (c) {
    if (c.id) CATEGORIES_BY_ID[c.id] = c;
  });
  try {
    validateQuizData(CONTENT.quiz, PRODUCTS_BY_ID, CATEGORIES_BY_ID, BUNDLES_BY_ID);
  } catch (e) {
    console.error("\n[build] Quiz data validation failed: " + e.message);
    process.exit(1);
  }

  /* 5e. Volume-pricing sanity.
   The rule advertises "N+ for $unitPrice each", so a qualifying product whose
   own price is already at or below unitPrice makes the badge a lie (and the
   Worker's min(base, rule) means the shopper is charged the lower one
   anyway). Matching mirrors itemMatchesVolumeRule() in workers/checkout.js:
   whitespace-stripped, case-insensitive, variant labels first and the
   product's own text only when it has no variants. */
  (CATALOG.volumePricing || []).forEach(function (rule) {
    if (!rule || rule.enabled === false) return;
    const normQ = String(rule.qualifyingVariant || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    PRODUCTS.forEach(function (p) {
      if (p.category !== rule.category) return;
      let qualifies = true;
      if (normQ) {
        const options = (p.variants && p.variants.options) || [];
        if (options.length) {
          qualifies = options.some(function (o) {
            return String(o.label).trim().toLowerCase().replace(/\s+/g, "") === normQ;
          });
        } else {
          const text = (
            String(p.name || "") +
            " " +
            String(p.blurb || "") +
            " " +
            String(p.description || "")
          )
            .toLowerCase()
            .replace(/\s+/g, "");
          qualifies = text.indexOf(normQ) !== -1;
        }
      }
      if (!qualifies) return;
      if (typeof rule.unitPrice === "number" && !(p.price > rule.unitPrice)) {
        console.warn(
          "[build] Warning: '" +
            p.id +
            "' qualifies for volume rule '" +
            (rule.id || rule.name) +
            "' but its price ($" +
            Number(p.price).toFixed(2) +
            ") is not above the rule unit price ($" +
            rule.unitPrice.toFixed(2) +
            '), so "' +
            (rule.label || "the multi-buy offer") +
            '" offers no saving.'
        );
      }
    });
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
          // `id` and `zip` used to be dropped here. Search results link to
          // "events.html#" + ev.id, so three of eight results pointed at
          // events.html#undefined, and the pickup ZIP that decides sales-tax
          // sourcing vanished the moment a market moved to the past list.
          id: evt.id,
          date: evt.date,
          endDate: evt.endDate,
          dateLabel: evt.dateLabel,
          name: evt.name,
          type: evt.type,
          location: evt.location,
          zip: evt.zip,
          emoji: evt.emoji,
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
  const DOMAIN = SITE_ORIGIN;
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

  /* With the Journal switched off in /admin the page is unlinked, noindexed
   and out of the sitemap -- but both posts still shipped here in full, so an
   unpublished draft was one view-source away and searchable on every page.
   The wrapper is still emitted (journal.html and the search engine both read
   the global unconditionally); it just carries no posts until the switch is
   on. Same gate is applied to the search index, feed.xml and the service
   worker's precache below. */
  const journalPublished = !!SITE_CONFIG.enableJournal;
  const journalForPages = journalPublished ? JOURNAL : Object.assign({}, JOURNAL, { posts: [] });
  const journalDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated Apothecary Journal data.\n" +
    " * Wrap of assets/data/journal/*.json (plus content.json's journal wording) into YL_JOURNAL.\n" +
    " * Posts are only included while site.enableJournal is on in content.json.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_JOURNAL = " +
    JSON.stringify(journalForPages, null, 2) +
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

  /* ---------- assets/js/locales-data.js ----------
   window.YL_LOCALES and window.YL_BRAND_GLOSSARY wrapper around
   assets/data/locales/*.json and assets/data/brand-glossary.json.
   Precached in sw.js for zero-network, offline translation. */
  const localesDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated localization dictionaries and brand glossary.\n" +
    " * Wrap of assets/data/locales/*.json and assets/data/brand-glossary.json.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "/* global module */\n" +
    "(function () {\n" +
    "  var LOCALES = " +
    JSON.stringify(LOCALES, null, 2) +
    ";\n" +
    "  var BRAND_GLOSSARY = " +
    JSON.stringify(BRAND_GLOSSARY, null, 2) +
    ";\n\n" +
    "  if (typeof window !== 'undefined') {\n" +
    "    window.YL_LOCALES = LOCALES;\n" +
    "    window.YL_BRAND_GLOSSARY = BRAND_GLOSSARY;\n" +
    "  }\n\n" +
    "  if (typeof module !== 'undefined' && module.exports) {\n" +
    "    module.exports = {\n" +
    "      LOCALES: LOCALES,\n" +
    "      BRAND_GLOSSARY: BRAND_GLOSSARY,\n" +
    "      YL_LOCALES: LOCALES,\n" +
    "      YL_BRAND_GLOSSARY: BRAND_GLOSSARY\n" +
    "    };\n" +
    "  }\n" +
    "})();\n";
  writeFile("assets/js/locales-data.js", localesDataJs);

  /* ---------- assets/js/search-data.js (Global Search Index) ---------- */
  const searchProducts = PRODUCTS.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      categoryLabel: CATEGORY_LABEL[p.category] || p.category || "Apothecary",
      price: p.price,
      originalPrice: p.originalPrice || null,
      formattedPrice: "$" + p.price.toFixed(2),
      image: p.image,
      inStock: p.inStock !== false && p.stock !== 0,
      comingSoon: !!p.comingSoon,
      estimatedBatchDate: p.estimatedBatchDate || null,
      featured: !!p.featured,
      blurb: p.blurb || p.description || "",
      ingredients: Array.isArray(p.ingredients) ? p.ingredients : [],
      ingredientsLabel: p.ingredientsLabel || "Ingredients",
      scent: p.scent || "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      concerns: Array.isArray(p.concerns) ? p.concerns : [],
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      variants: p.variants || null,
      pairsWith: Array.isArray(p.pairsWith) ? p.pairsWith : [],
      ritualTitle: p.ritualTitle || "",
      url: "products/" + p.id + ".html",
      shopUrl: "shop.html#" + p.id
    };
  });

  const searchBundles = BUNDLES.map(function (b) {
    const pricing = bundlePricing(b, PRODUCTS_BY_ID) || { fullPrice: 0, bundlePrice: 0 };
    const firstProd = PRODUCTS_BY_ID[b.productIds[0]];
    const bundleImg = b.image || (firstProd && firstProd.image) || "assets/img/gift-card.png";
    return {
      id: "bundle-" + b.id,
      name: b.name,
      category: "gift-sets",
      categoryLabel: "Gift Sets & Bundles",
      price: pricing.bundlePrice,
      originalPrice: pricing.fullPrice,
      formattedPrice: "$" + pricing.bundlePrice.toFixed(2),
      image: bundleImg,
      inStock: true,
      comingSoon: false,
      estimatedBatchDate: null,
      featured: !!b.featured,
      blurb:
        b.description || b.blurb || "Curated botanical bundle with special multi-item savings.",
      ingredients: [],
      scent: "",
      tags: ["bundle", "gift-set", "bestseller"],
      concerns: [],
      keywords: ["bundle", "set", "gift set", "package", "gift", "deal", "discount", "gift box"],
      variants: null,
      url: "shop.html#bundle-" + b.id,
      shopUrl: "shop.html#bundle-" + b.id
    };
  });

  const allSearchProducts = searchProducts.concat(searchBundles);

  const searchJournalSource = journalPublished
    ? Array.isArray(JOURNAL)
      ? JOURNAL
      : JOURNAL.posts || []
    : [];
  const searchJournal = searchJournalSource.map(function (post) {
    return {
      id: post.id,
      title: post.title,
      date: post.date,
      formattedDate: post.formattedDate || post.date,
      image: post.image || "assets/img/sleep-salve.jpg",
      readTime: post.readingTime || post.readTime || "4 min read",
      tags: Array.isArray(post.tags) ? post.tags : [],
      excerpt: post.excerpt || post.lede || "",
      content: (post.content || "")
        .replace(/[#*`_[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      featuredProductId: post.featuredProductId || "",
      url: "journal.html#post-" + post.id
    };
  });

  const searchFaq = FAQ.map(function (f, idx) {
    return {
      id: "faq-" + idx,
      question: f.question,
      answer: f.answer,
      category: f.category || "General",
      keywords: Array.isArray(f.keywords) ? f.keywords : [],
      url: "faq.html#faq-" + idx
    };
  });

  const searchEvents = (EVENTS.upcoming || []).concat(EVENTS.past || []).map(function (ev) {
    return {
      id: ev.id,
      name: ev.name,
      title: ev.name,
      date: ev.date,
      dateLabel: ev.dateLabel || ev.date,
      endDate: ev.endDate || null,
      type: ev.type || "Market",
      location: ev.location || "",
      zip: ev.zip || "",
      note: ev.note || "",
      description: ev.note || "",
      isUpcoming: (EVENTS.upcoming || []).some(function (u) {
        return u.id === ev.id;
      }),
      url: "events.html#" + ev.id
    };
  });

  const searchSynonymDefaults = {
    // Tier 1: Botanicals, herbs, ingredients
    lavender: ["lavendar", "lavandre", "lavandula", "french lavender", "lavender oil", "sleep"],
    magnesium: [
      "mg",
      "mag",
      "magnesium oil",
      "magnesium salve",
      "mineral soak",
      "transdermal",
      "muscle"
    ],
    arnica: ["arnica montana", "mountain arnica", "bruise herb", "arnika", "soreness", "bruises"],
    calendula: [
      "marigold",
      "calendula officinalis",
      "calendula flower",
      "calendula oil",
      "healing"
    ],
    chamomile: ["camomile", "german chamomile", "matricaria", "calming tea", "soothing"],
    frankincense: [
      "olibanum",
      "boswellia",
      "frankensense",
      "frankencense",
      "frankinsense",
      "frankinscense",
      "frankinsence",
      "resin"
    ],
    shea: [
      "shea butter",
      "karite",
      "raw shea",
      "african shea",
      "shay butter",
      "tallow",
      "body butter",
      "moisture"
    ],
    beeswax: ["cera alba", "wax", "natural wax", "honeycomb"],
    peppermint: ["mint", "mentha piperita", "cooling mint", "pepermint"],
    eucalyptus: ["eucalypt", "blue gum", "eucalyptus oil"],
    citronella: ["citronela", "cymbopogon", "fever grass", "lemon grass", "lemongrass", "bug"],
    lemongrass: ["lemon grass", "citronella", "cymbopogon"],
    cedarwood: ["cedar", "red cedar", "juniperus", "woodsy"],
    epsom: [
      "epsom salt",
      "epson salt",
      "epsum salt",
      "magnesium sulfate",
      "bath salt",
      "mineral salt",
      "soak"
    ],
    salt: ["epsom salt", "bath salt", "lava salt", "black salt", "sea salt"],
    tea_tree: ["melaleuca", "tea tree oil", "teatree"],
    sage: ["white sage", "salvia apiana", "smudge", "clearing"],
    palo_santo: ["holy wood", "sacred wood", "bursera", "smudge"],
    lanolin: ["wool wax", "lanoline", "emollient"],
    squalane: ["shimmer", "glow", "oil"],
    pumice: ["exfoliant", "scrub", "pumice stone"],

    // Tier 2: Concerns, symptoms, intent
    sleep: [
      "insomnia",
      "bedtime",
      "nighttime",
      "tired",
      "restless",
      "rest",
      "unwind",
      "calm",
      "relax",
      "anxiety",
      "stress",
      "sleepy",
      "somnolence",
      "wind down",
      "wind-down",
      "night",
      "evening",
      "lights out",
      "bedtime ritual",
      "chill",
      "de-stress",
      "decompress",
      "overthinking",
      "drowsy"
    ],
    muscles: [
      "sore muscles",
      "muscle ache",
      "joint pain",
      "tension",
      "stiffness",
      "workout",
      "gym",
      "arthritis",
      "recovery",
      "sore",
      "pain",
      "cramps",
      "long day",
      "tired legs",
      "legs",
      "feet",
      "neck",
      "shoulders",
      "back",
      "knots",
      "post hike",
      "after the gym",
      "post workout",
      "leg day",
      "yard work",
      "hard day",
      "on my feet all day"
    ],
    dry_skin: [
      "dry skin",
      "eczema",
      "cracked heels",
      "chapped hands",
      "ashy",
      "rough skin",
      "cuticles",
      "rash",
      "dry",
      "moisturizer",
      "hydrate",
      "barrier",
      "cracked",
      "chapped",
      "flaky",
      "itchy",
      "windburn",
      "winter skin",
      "heels",
      "elbows",
      "knees",
      "hands",
      "lips",
      "chapped lips",
      "hardworking hands",
      "gardener hands",
      "mechanic hands",
      "lotion",
      "moisturizing",
      "hydrating"
    ],
    bug_spray: [
      "bug spray",
      "mosquito",
      "bugs",
      "bites",
      "gnats",
      "ticks",
      "repellent",
      "camping",
      "hiking",
      "outdoor",
      "bug off",
      "insect",
      "mosquitos",
      "skeeters",
      "chiggers",
      "no see ums",
      "deet free",
      "deet-free",
      "trail",
      "porch",
      "picnic",
      "bonfire",
      "fishing",
      "yard",
      "backyard",
      "summer nights"
    ],
    sensitive_skin: [
      "sensitive skin",
      "unscented",
      "fragrance free",
      "allergy",
      "hypoallergenic",
      "baby safe",
      "gentle",
      "pure"
    ],
    gift_cards: [
      "gift card",
      "gift certificate",
      "voucher",
      "present",
      "birthday",
      "e-gift",
      "store credit",
      "gifting",
      "gifts",
      "gift for him",
      "gift for her",
      "gift for mom",
      "gift for dad",
      "gift for friend",
      "stocking stuffer",
      "stocking stuffers",
      "bridesmaid gift",
      "hostess gift",
      "housewarming",
      "care package",
      "self care gift",
      "treat yourself",
      "holiday gift",
      "christmas",
      "valentines",
      "mothers day",
      "fathers day",
      "graduation",
      "teacher gift",
      "last minute gift"
    ],
    pride: [
      "queer",
      "rainbow",
      "lgbtq",
      "stag",
      "festival",
      "pride gift",
      "queer owned",
      "lgbt",
      "gay",
      "trans",
      "nonbinary",
      "ally",
      "parade"
    ],
    witchy: [
      "spell",
      "amulet",
      "energy",
      "smudge",
      "clearing",
      "ritual",
      "protection",
      "potion",
      "magic",
      "talisman"
    ],
    /* Policy and service intents are FOUR groups, deliberately, and every
       term in each is chosen so that its INDIVIDUAL words stay on-intent.

       Both halves of that matter. These used to be a single "shipping"
       grab-bag holding "refund", "gift card balance", "balance" and
       "landrum" side by side, and because a reverse match pulls in every
       sibling of whatever group it matched -- tokenised down to single
       words -- typing "refund" injected "gift", "card", "balance" and
       "landrum" into the query. A return-policy question came back as six
       gift sets and four farmers' markets with the return-policy FAQ
       nowhere in the results (live audit M1).

       The tokenisation itself is deliberate and is not the thing to change:
       the ingredient and intent groups rely on it ("body butter" has to
       contribute "body" and "butter" for shea-butter to rank first, which
       scripts/global-search.test.js pins). So the rule here is that a
       policy group may not carry a term with an off-intent word in it --
       no "free shipping" (leaks "free" into every fragrance-free product),
       no "money back" or "final sale" (leaks "money", "back", "final",
       "sale"), and no place names. */
    shipping: [
      "delivery",
      "dispatch",
      "postage",
      "courier",
      "shipped",
      "ships",
      "shipment",
      "transit"
    ],
    returns: [
      "return",
      "returns",
      "return policy",
      "refund",
      "refunds",
      "refunded",
      "exchange",
      "exchanges",
      "exchanged"
    ],
    tracking: [
      "track",
      "tracked",
      "order tracking",
      "track my order",
      "where is my order",
      "order status"
    ],
    gift_card_balance: [
      "gift card balance",
      "check balance",
      "card balance",
      "remaining balance",
      "redeem gift card"
    ],

    // Tier 3: product types and forms (added 2026-09-02 from shopper-vocabulary research;
    // query-side only, never rendered as product copy)
    salve: ["salves", "balm", "balms", "ointment", "herbal salve", "chapstick", "lip balm"],
    soak: [
      "soaks",
      "bath soak",
      "bath soaks",
      "bath salts",
      "bath salt",
      "tub soak",
      "foot soak",
      "spa night",
      "bath night",
      "self care night",
      "bath"
    ],
    bath_tea: [
      "bath tea",
      "tub tea",
      "tea bath",
      "herbal bath",
      "botanical bath",
      "bath sachet",
      "bath herbs",
      "flower bath",
      "petal bath",
      "steep",
      "tea"
    ],
    scrub: [
      "scrubs",
      "body polish",
      "exfoliator",
      "exfoliant",
      "exfoliate",
      "exfoliating",
      "exfoliation",
      "polish",
      "smoothing"
    ],
    body_butter: [
      "body butter",
      "whipped butter",
      "whipped body butter",
      "body cream",
      "body lotion",
      "lotion",
      "cream",
      "butter",
      "fluffy",
      "whipped"
    ],
    shimmer_oil: [
      "body shimmer",
      "shimmer oil",
      "glow oil",
      "glitter oil",
      "body glitter",
      "highlighter",
      "illuminator",
      "bronzer",
      "bronzing oil"
    ],
    beard: [
      "beard salve",
      "beard balm",
      "beard oil",
      "beard butter",
      "beard conditioner",
      "beard care",
      "mustache",
      "moustache",
      "facial hair",
      "stubble",
      "grooming",
      "barber",
      "for him",
      "mens",
      "boyfriend",
      "husband",
      "dad"
    ],
    room_spray: [
      "room spray",
      "room mist",
      "linen spray",
      "pillow spray",
      "air freshener",
      "home fragrance",
      "space clearing",
      "smudge spray",
      "sage spray",
      "cleansing spray",
      "clearing mist",
      "clearing spray",
      "aura spray",
      "energy spray",
      "house blessing",
      "porch sweep",
      "banishing",
      "smokeless",
      "mist",
      "spray"
    ],
    keychain: [
      "key chain",
      "keyring",
      "key ring",
      "spell jar",
      "protection jar",
      "charm",
      "car charm",
      "bag charm",
      "keychains",
      "wax sealed",
      "witch bottle"
    ],
    apparel: [
      "tee",
      "t-shirt",
      "tshirt",
      "t shirt",
      "shirt",
      "shirts",
      "tank",
      "tank top",
      "merch",
      "clothing",
      "clothes",
      "graphic tee",
      "unisex tee",
      "racerback",
      "rainbow stag",
      "wear"
    ],
    vegan: [
      "plant based",
      "plant-based",
      "beeswax free",
      "no beeswax",
      "vegan friendly",
      "no animal products",
      "cruelty free"
    ],
    unscented: [
      "fragrance free",
      "scent free",
      "no scent",
      "no fragrance",
      "plain",
      "family safe",
      "kid safe",
      "kids",
      "babies",
      "sensitive"
    ],
    coming_soon: [
      "coming soon",
      "preorder",
      "pre-order",
      "pre order",
      "waitlist",
      "notify me",
      "restock",
      "back in stock",
      "upcoming",
      "new products",
      "new arrivals",
      "whats new",
      "new"
    ],
    events: [
      "pop up",
      "popup",
      "pop-up",
      "market",
      "markets",
      "farmers market",
      "flea market",
      "vendor",
      "booth",
      "fair",
      "faire",
      "in person",
      "where to find",
      "meet you",
      "upcoming events",
      "calendar",
      "spartanburg",
      "greenville",
      "upstate",
      "south carolina"
    ],

    deodorant: [
      "deoderant",
      "natural deodorant",
      "cream deodorant",
      "aluminum free",
      "aluminium free",
      "underarm",
      "underarms",
      "pit cream",
      "body odor",
      "odor",
      "sweat",
      "feral"
    ],

    // Tier 4: scent families (match the product scent labels)
    bourbon: ["bourbon vanilla", "whiskey", "whisky", "boozy", "vanilla", "smoky", "warm", "cozy"],
    citrus: [
      "citrusy",
      "lemon",
      "orange",
      "grapefruit",
      "bergamot",
      "bright",
      "zesty",
      "sunny",
      "summer"
    ],
    woodsy: ["woody", "woods", "forest", "pine", "earthy", "cabin", "campfire", "herbal", "green"],
    floral: ["flowery", "flowers", "rose", "jasmine", "meadow", "botanical", "petals"],
    fresh: ["clean", "crisp", "rain", "airy", "light scent", "subtle"],

    // Tier 5: brand and place words shoppers use
    southern: [
      "appalachian",
      "appalachia",
      "carolina",
      "landrum",
      "upstate sc",
      "holler",
      "yall",
      "y all",
      "yallternative"
    ],
    goth: ["gothic", "southern gothic", "punk", "emo", "alternative", "moody", "edgy", "dark"]
  };

  const searchSynonyms = buildSearchSynonyms(
    searchSynonymDefaults,
    (CONTENT.search || {}).extraSynonyms
  );

  const searchIndex = {
    version: "2026.09.01",
    products: allSearchProducts,
    journal: searchJournal,
    events: searchEvents,
    faq: searchFaq,
    synonyms: searchSynonyms
  };

  const searchDataJs =
    "/**\n" +
    " * @fileoverview Auto-generated Global Search Index.\n" +
    " * Generated by scripts/build-site-data.js -- Do not hand-edit.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_SEARCH_INDEX = " +
    JSON.stringify(searchIndex, null, 2) +
    ";\n";
  writeFile("assets/js/search-data.js", searchDataJs);

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
    // rasterImagePath() also swaps the coming-soon SVG for its PNG twin:
    // schema.org Product images must be raster (audit C, finding H3), and
    // the PDP's own Product JSON-LD does the same, so the two agree.
    const allPhotos = [p.image].concat(Array.isArray(p.images) ? p.images : []).map(function (img) {
      return rasterImagePath(img, "product");
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
    /* This page is now the ONLY place the catalogue's Product schema lives:
       products/*.html canonicalise here and are noindex (see
       renderProductPdpHtml), so the per-item Offer they used to carry --
       price, availability, condition, seller, return policy and shipping --
       moved onto these ItemList entries. Availability comes from the real
       comingSoon/inStock/stock flags via schemaAvailability(), never from the
       image filename. */
    const availability = schemaAvailability(p);
    const offerCommon = {
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      itemCondition: "https://schema.org/NewCondition",
      availability: availability,
      url: DOMAIN + "/products/" + p.id + ".html",
      seller: { "@type": "Organization", name: "Y'allternative Living" }
    };
    const offers =
      range.low === range.high
        ? Object.assign({ "@type": "Offer", price: range.low.toFixed(2) }, offerCommon)
        : Object.assign(
            {
              "@type": "AggregateOffer",
              lowPrice: range.low.toFixed(2),
              highPrice: range.high.toFixed(2),
              offerCount: range.offerCount
            },
            offerCommon
          );
    const productLd = {
      "@type": "Product",
      name: p.name,
      description: p.blurb,
      image: imageField,
      url: DOMAIN + "/products/" + p.id + ".html",
      sku: p.sku || p.id,
      mpn: p.mpn || p.sku || p.id,
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

  /* ---------- gift card amount options ----------
   The gift card button's data-item-custom1-options attribute used to
   enumerate every dollar value from $10 to $500 -- 491 options, a 10 KB
   attribute in the HTML of every visitor's shop page (Medium finding in the
   audit's SEO section). Only the presets the catalogue actually declares are
   emitted now. The custom-amount path does not need them: gift-card.js
   builds the label itself ("Preset $" + clamped amount, see
   assets/js/gift-card.js:156,190) and workers/checkout.js re-derives the
   charge from that label alone via resolveGiftCardAmountCents(), clamped
   server-side to $10-$500. The labels live in products.json's variants so
   the published catalogue, the button and the Worker's parser all agree --
   they used to read "$200", which the Worker's /^Preset \$(\d+)$/ does not
   match, so it fell back to the $10 floor. */
  const giftCardProduct = PRODUCTS_BY_ID["yallternative-gift-card"];
  const giftCardOptions =
    giftCardProduct && giftCardProduct.variants && Array.isArray(giftCardProduct.variants.options)
      ? giftCardProduct.variants.options
      : [];
  if (giftCardOptions.length) {
    giftCardOptions.forEach(function (o) {
      if (!/^Preset \$\d+(?:\.\d{1,2})?$/.test(String(o.label))) {
        console.error(
          "\n[build] Gift card variant label '" +
            o.label +
            "' does not match the checkout protocol.\n" +
            '        workers/checkout.js parses these as "Preset $NN" and falls back to the\n' +
            "        $10 minimum for anything else -- a $200 card would be charged $10.\n" +
            "        Fix the label in assets/data/products.json (or /admin) and rebuild.\n"
        );
        process.exit(1);
      }
    });
    const giftCardOptionsStr = giftCardOptions
      .map(function (o) {
        const delta = o.priceDelta || 0;
        return (
          escapeHtml(o.label) + "[" + (delta < 0 ? "-" : "+") + Math.abs(delta).toFixed(2) + "]"
        );
      })
      .join("|");
    const optionsPlaceholderRe = /data-item-custom1-options="Preset \$10\[\+0\.00\][^"]*"/;
    if (optionsPlaceholderRe.test(shopHtml)) {
      shopHtml = shopHtml.replace(
        optionsPlaceholderRe,
        'data-item-custom1-options="' + giftCardOptionsStr + '"'
      );
    }
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
  const newBlock = jsonLdScriptBlock(shopJsonLd, "");
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
  let newFaqLdBlock = jsonLdScriptBlock(shopFaqLd, "");

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
        const renderedAnswer = renderFaqAnswerHtml(item.answer);
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
  newFaqLdBlock = jsonLdScriptBlock(faqJsonLd, "");
  faqHtml = faqHtml.replace(faqLdBlockRe, function () {
    return newFaqLdBlock;
  });

  const faqVisibleHtml = FAQ.map(function (item, i) {
    const renderedAnswer = renderFaqAnswerHtml(item.answer);
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

  /* ---------- Event structured data (events.html) ----------
   These five helpers are a deliberate, line-for-line mirror of the ones in
   assets/js/main.js (getEventStreetAddress / getEasternOffsetForDate /
   buildEventDateTimeISO / buildEventJsonLdLocation / buildEventJsonLd).
   main.js has injected this markup at runtime for a while, which is exactly
   the problem the 2026-09-02 live audit found in M-4: events.html shipped
   LocalBusiness + BreadcrumbList and nothing else, so a crawler that does not
   execute JavaScript saw no Event at all for a fully-specified upcoming
   market -- free local/rich-result distribution for a business whose in-person
   markets are a primary sales channel.

   It is emitted ONCE, into a tag carrying main.js's own id, so main.js
   updates it in place rather than appending a duplicate. scripts/main.test.js
   asserts the two produce byte-identical JSON for the real events.json, so
   this copy cannot drift from the runtime one without failing the build.

   Why a copy and not a require(): main.js is a browser IIFE that needs a full
   DOM mock before Node will even load it (see the top of scripts/main.test.js);
   pulling that into the build to reach two pure functions would be a far
   bigger liability than a mirrored pair the test pins together. */
  function getEventStreetAddress(ev) {
    if (!ev || !ev.note || !ev.zip) return "";
    const note = String(ev.note);
    if (!/^\d/.test(note.trim())) return "";
    if (note.indexOf(ev.zip) === -1) return "";
    const match = note.match(/^([^.]+?\b\d{5}\b)/);
    if (!match) return "";
    const full = match[1].trim();
    const commaIdx = full.indexOf(",");
    return commaIdx > 0 ? full.slice(0, commaIdx).trim() : full;
  }

  function getEasternOffsetForDate(dateObj) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "shortOffset"
      }).formatToParts(dateObj);
      const tzPart = parts.find(function (part) {
        return part.type === "timeZoneName";
      });
      const raw = tzPart ? tzPart.value : "";
      const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(raw);
      if (!m) return null;
      return m[1] + m[2].padStart(2, "0") + ":" + (m[3] || "00");
    } catch {
      return null;
    }
  }

  function buildEventDateTimeISO(dateStr) {
    if (!dateStr) return null;
    const str = String(dateStr);
    const datePart = str.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    const timeMatch = /T(\d{2}:\d{2}:\d{2})/.exec(str);
    if (!timeMatch) return { iso: datePart, hasTime: false };
    const parts = datePart.split("-").map(Number);
    const noonUtc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
    const offset = getEasternOffsetForDate(noonUtc);
    return { iso: datePart + "T" + timeMatch[1] + (offset || ""), hasTime: true };
  }

  function buildEventJsonLdLocation(ev) {
    const address = { "@type": "PostalAddress", addressCountry: "US" };
    const loc = ev && ev.location ? String(ev.location) : "";
    const locParts = loc.split(",");
    const city = locParts[0] ? locParts[0].trim() : "";
    const region = locParts[1] ? locParts[1].trim() : "";
    if (city) address.addressLocality = city;
    if (region) address.addressRegion = region;
    if (ev && ev.zip) address.postalCode = ev.zip;
    const street = getEventStreetAddress(ev);
    if (street) address.streetAddress = street;
    return { "@type": "Place", address: address };
  }

  function buildEventJsonLd(ev) {
    if (!ev || !ev.name) return null;
    const start = buildEventDateTimeISO(ev.date);
    if (!start) return null;
    const ld = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Y'allternative Living at " + ev.name,
      startDate: start.iso,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: buildEventJsonLdLocation(ev)
    };
    if (ev.endDate) {
      const end = buildEventDateTimeISO(ev.endDate);
      if (end) ld.endDate = end.iso;
    }
    return ld;
  }

  function buildEventsJsonLd(events) {
    return (Array.isArray(events) ? events : []).map(buildEventJsonLd).filter(function (ld) {
      return !!ld;
    });
  }

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
            escapeHtml(ev.date || "") +
            '"><svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ' +
            escapeHtml(ev.dateLabel) +
            "</time></p>\n" +
            '              <p class="event-location">' +
            (ev.location
              ? '<svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg> ' +
                escapeHtml(ev.location)
              : "") +
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

  /* Upcoming events, sorted the same way main.js sorts them before calling
     injectEventJsonLd, so the static tag and the runtime rewrite agree. The
     CMS switch (site.enableEventJsonLd) gates both; when it is off, or when
     nothing is upcoming, the markers are emitted empty rather than wrapping
     an empty <script>, which would be worse structured data than none. */
  const eventJsonLdRe = /(<!-- EVENT_JSONLD:START -->)[\s\S]*?(<!-- EVENT_JSONLD:END -->)/;
  if (!eventJsonLdRe.test(eventsHtml)) {
    throw new Error(
      "Could not find EVENT_JSONLD:START/EVENT_JSONLD:END markers in events.html -- " +
        "refusing to silently ship the page with no Event structured data."
    );
  }
  const sortedUpcomingForLd = upcoming
    .map(function (ev) {
      return { ev: ev, t: new Date(ev.date).getTime() };
    })
    .sort(function (a, b) {
      return a.t - b.t;
    })
    .map(function (x) {
      return x.ev;
    });
  const eventLdObjects =
    SITE_CONFIG.enableEventJsonLd === false ? [] : buildEventsJsonLd(sortedUpcomingForLd);
  const eventLdBody = eventLdObjects.length
    ? '\n<script type="application/ld+json" id="yl-event-jsonld">\n' +
      JSON.stringify(eventLdObjects.length === 1 ? eventLdObjects[0] : eventLdObjects, null, 2)
        .split("</")
        .join("<\\/") +
      "\n</" +
      "script>\n"
    : "";
  eventsHtml = eventsHtml.replace(eventJsonLdRe, function (m, start, end) {
    return start + eventLdBody + end;
  });

  writeFile("events.html", eventsHtml);

  // shop.html no longer contains a duplicated visible FAQ accordion (now links directly to faq.html)

  /* ---------- 4c) shop.html filter toolbar, pre-rendered ----------
   assets/js/main.js builds both pill rows from window.YL_PRODUCTS on load.
   Neither had its height reserved: #filterRow shipped completely empty (no
   min-height at all) and #concernFilterRow shipped empty behind a
   min-height:38px that is wrong for a row which actually renders 121px tall
   on desktop and mobile (78px on tablet). Everything below them jumped the
   moment main.js ran -- the largest single layout shift on the site (live
   audit 2026-09-02, L-8; the audit named the two elements that MOVED,
   #concernFilterWrap and .shop-sort, and reserving height on the wrapper
   alone does not fix it because #filterRow above them grows too).
   A taller magic number would only be right until someone adds a category or
   a concern, and both lists are static build-time data -- so paint the real
   pills and let main.js overwrite them with byte-identical markup. Nothing
   moves, and the filters are usable with JS off. */
  (function prerenderShopFilters() {
    const concerns = Array.isArray(CATALOG.concerns) ? CATALOG.concerns : [];
    const categories = Array.isArray(CATALOG.categories) ? CATALOG.categories : [];
    let shopHtmlForFilter;
    try {
      shopHtmlForFilter = readText("shop.html", "shop page");
    } catch (e) {
      return;
    }

    const rowRe = (id) => new RegExp('(<div id="' + id + '"[^>]*>)[\\s\\S]*?(</div>)');
    [
      ["filterRow", categories.length],
      ["concernFilterRow", concerns.length]
    ].forEach(function (pair) {
      if (!rowRe(pair[0]).test(shopHtmlForFilter)) {
        throw new Error(
          'Could not find <div id="' +
            pair[0] +
            '"> in shop.html -- refusing to ship the shop toolbar with an unreserved height.'
        );
      }
    });

    const categoryPills = categories.length
      ? '<button class="filter-pill active" type="button" data-filter="all" aria-pressed="true">All</button>' +
        categories
          .map(function (c) {
            return (
              '<button class="filter-pill" type="button" data-filter="' +
              escapeHtml(c.id) +
              '" aria-pressed="false">' +
              escapeHtml(c.label) +
              "</button>"
            );
          })
          .join("")
      : "";
    const concernPills = concerns.length
      ? '<button class="concern-pill active" type="button" data-concern="all" aria-pressed="true">All Concerns</button>' +
        concerns
          .map(function (c) {
            return (
              '<button class="concern-pill" type="button" data-concern="' +
              escapeHtml(c.id) +
              '" aria-pressed="false">' +
              (c.icon
                ? '<span class="concern-icon" aria-hidden="true">' + escapeHtml(c.icon) + "</span> "
                : "") +
              escapeHtml(c.name) +
              "</button>"
            );
          })
          .join("")
      : "";

    let updatedShop = shopHtmlForFilter.replace(rowRe("filterRow"), function (m, open, close) {
      return open + categoryPills + close;
    });
    updatedShop = updatedShop.replace(rowRe("concernFilterRow"), function (m, open, close) {
      return open + concernPills + close;
    });
    if (updatedShop !== shopHtmlForFilter) writeFile("shop.html", updatedShop);
  })();

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
      // A CMS-entered rating is neither trusted to be a number nor to be in
      // range: `Array(Math.round("x") + 1)` threw and killed the build, and a
      // rating of 500 rendered 500 stars into the page. Clamp, then escape --
      // the value is also read out to screen readers as text.
      const ratingValue = clampRating(r.rating, 5);
      const stars = Array(Math.round(ratingValue) + 1).join("★");
      cardsHtml += '        <div class="quote-card reveal">\n';
      cardsHtml +=
        '          <span class="stars" aria-hidden="true">' +
        stars +
        '</span><span class="sr-only">Rated ' +
        escapeHtml(ratingValue) +
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

  // Inject the Journal title/subheading (content.json's `journal` key)
  function injectJournalCopy() {
    const journal = JOURNAL;

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
    return open + logoPictureHtml(logoDesktop, MANIFEST, "desktop", { loading: "lazy" }) + close;
  });

  // Inject social row into footer template using outer comment tag
  const reFooterSocial = /(<!--YL:site\.socialRow-->)[\s\S]*?(<!--\/YL:site\.socialRow-->)/;
  if (reFooterSocial.test(FOOTER_INNER)) {
    const socialRowHtml = renderSocialRowHtml(CONTENT.site && CONTENT.site.social);
    FOOTER_INNER = FOOTER_INNER.replace(reFooterSocial, function (match, open, close) {
      return open + "\n        " + socialRowHtml + "\n" + close;
    });
  }

  // Inject etsy link into footer template using comment tag
  const reFooterEtsy = /(<!--YL:site\.social\.etsy-->)[\s\S]*?(<!--\/YL:site\.social\.etsy-->)/;
  if (reFooterEtsy.test(FOOTER_INNER)) {
    const etsyUrl =
      (CONTENT.site && CONTENT.site.social && CONTENT.site.social.etsy) ||
      "https://www.etsy.com/shop/YallternativeLivinCO";
    FOOTER_INNER = FOOTER_INNER.replace(reFooterEtsy, function (match, open, close) {
      return open + escapeHtml(etsyUrl) + close;
    });
  }

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
    "journal.html",
    "reviews.html",
    "order-status.html",
    "safety.html"
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

    /* Inject header desktop/mobile logos. replaceLogoBlocks() emits the full
       <picture> over the manifest's 48/96/144 variants and is idempotent, so
       a rebuild replaces the whole block rather than editing the <img> inside
       an already-generated one. Paths inside are root-absolute: 404.html is
       served at the requested URL (audit C-5), so a document-relative logo
       path 404s under /products/. */
    html = replaceLogoBlocks(html, logoDesktop, logoMobile, MANIFEST);

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

    // Dynamic Schema.org sameAs injection
    const activeSocialList = getActiveSocialUrls(CONTENT.site && CONTENT.site.social);
    const sameAsJson = JSON.stringify(activeSocialList, null, 2)
      .split("\n")
      .map((line, idx) => (idx === 0 ? line : "  " + line))
      .join("\n");

    html = html.replace(/"sameAs":\s*\[[\s\S]*?\]/, '"sameAs": ' + sameAsJson);

    const updated = html.replace(FOOTER_RE, FOOTER_BLOCK);
    if (updated !== html) writeFile(page, updated);
  });

  /* ---------- 5) sitemap.xml ----------
   Page list is intentionally hand-maintained here (there's no router to
   introspect on a static site) -- add a line if you add a new top-level
   page. lastmod is the newest date found in the content sources (journal
   posts, events, reviews) rather than the wall clock, so a rebuild with
   unchanged inputs produces byte-identical output (build reproducibility
   is asserted by scripts/verify-build-reproducibility.js). */
  function contentLastmod() {
    const dates = [];
    const pick = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return obj.forEach(pick);
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && /date/i.test(k)) {
          dates.push(v.slice(0, 10));
        } else if (v && typeof v === "object") {
          pick(v);
        }
      });
    };
    listJournalFiles()
      .concat(["assets/data/events.json", "assets/data/site-reviews.json"])
      .forEach((f) => {
        const p = path.join(ROOT, f);
        if (!fs.existsSync(p)) return;
        try {
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          // Only finished events count: an upcoming market's date would be a
          // future lastmod, and comparing against "now" would reintroduce the
          // wall clock this function exists to remove.
          pick(f.endsWith("events.json") ? data.past : data);
        } catch {
          /* a malformed file is reported elsewhere; it just contributes no date */
        }
      });
    dates.sort();
    return dates.length ? dates[dates.length - 1] : "2026-09-01";
  }
  const PAGES = [
    { loc: "index.html", priority: "1.0" },
    { loc: "shop.html", priority: "0.9" },
    { loc: "events.html", priority: "0.7" },
    { loc: "about.html", priority: "0.7" },
    { loc: "reviews.html", priority: "0.8" },
    { loc: "order-status.html", priority: "0.7" },
    { loc: "contact.html", priority: "0.6" },
    { loc: "faq.html", priority: "0.6" },
    // The MoCRA adverse-event page. Low priority for search, but it MUST be in
    // this list: ALL_HTML_PAGES below is derived from it, and that is what
    // injects the Tawk.to ids, the Umami marker and the feature-gate styles.
    { loc: "safety.html", priority: "0.4" },
    { loc: "privacy.html", priority: "0.3" },
    { loc: "terms.html", priority: "0.3" },
    { loc: "policies.html", priority: "0.3" }
  ];
  if (SITE_CONFIG.enableJournal) {
    PAGES.push({ loc: "journal.html", priority: "0.7" });
  }
  /* ---------- per-URL <lastmod> ----------
     Every one of the 32 entries used to carry the SAME date -- the newest
     date found inside the content JSON (a past event, as it happened), which
     is a date about the CONTENT, not about when the page last changed. So it
     sat at 2026-08-30 through a deploy on 2026-09-02 that shipped real
     content changes (live audit 2026-09-02, L-1). Google only uses lastmod
     "if it's consistently and verifiably accurate", checked against the
     page's own last-modification signals, and its trust in the tag is
     all-or-nothing per site -- a sitemap full of dates that do not move is
     worse than one with no dates at all.

     So ask git when each page's real inputs last changed. That is verifiable
     from the outside (it is the deploy that changed the file) and it moves
     when, and only when, something did. The inputs are the SOURCES, not the
     generated HTML: a CMS edit commits assets/data/products.json and lets
     Netlify regenerate products/*.html at deploy time, so the generated
     file's own commit date would stand still while the page changed.

     Still deterministic for a given commit, so
     scripts/verify-build-reproducibility.js stays green. If git is not
     available (a tarball export, say) every page falls back to the old
     content-derived date rather than losing the tag. */
  const today = contentLastmod();
  const gitDateCache = {};
  function gitLastModified(file) {
    if (Object.prototype.hasOwnProperty.call(gitDateCache, file)) return gitDateCache[file];
    let out = "";
    try {
      out = require("child_process")
        .execSync("git log -1 --format=%cs -- " + JSON.stringify(file), {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        })
        .trim();
    } catch (e) {
      out = "";
    }
    gitDateCache[file] = /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : "";
    return gitDateCache[file];
  }
  /* Newest git date across a page's inputs, or the content-derived fallback
     when git answers for none of them. */
  function pageLastmod(files) {
    const dates = files.map(gitLastModified).filter(Boolean);
    if (!dates.length) return today;
    dates.sort();
    return dates[dates.length - 1];
  }
  const SHARED_SOURCES = ["assets/data/content.json", "assets/data/footer.html"];
  const PAGE_EXTRA_SOURCES = {
    "index.html": [
      "assets/data/products.json",
      "assets/data/events.json",
      "assets/data/site-reviews.json"
    ],
    "shop.html": ["assets/data/products.json", "assets/data/site-reviews.json"],
    "events.html": ["assets/data/events.json"],
    "reviews.html": ["assets/data/site-reviews.json"],
    "journal.html": listJournalFiles()
  };
  const sitemapXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<!-- Auto-generated by scripts/build-site-data.js. Do not hand-edit;\n" +
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
      const fullUrl = DOMAIN + "/" + locPath;
      return (
        "  <url>\n" +
        "    <loc>" +
        fullUrl +
        "</loc>\n" +
        "    <lastmod>" +
        pageLastmod([p.loc].concat(SHARED_SOURCES, PAGE_EXTRA_SOURCES[p.loc] || [])) +
        "</lastmod>\n    <priority>" +
        p.priority +
        "</priority>\n  </url>"
      );
    }).join("\n") +
    "\n" +
    // Product pages: indexable since 2026-09-01 (see renderProductPdpHtml).
    PRODUCTS.map(function (p) {
      const fullUrl = DOMAIN + "/products/" + p.id + ".html";
      return (
        "  <url>\n" +
        "    <loc>" +
        fullUrl +
        "</loc>\n" +
        "    <lastmod>" +
        pageLastmod(
          ["products/" + p.id + ".html", "assets/data/products.json"].concat(SHARED_SOURCES)
        ) +
        "</lastmod>\n    <priority>0.8</priority>\n  </url>"
      );
    }).join("\n") +
    "\n</urlset>\n";
  writeFile("sitemap.xml", sitemapXml);

  /* ---------- 5c) feed.xml (Apothecary Journal RSS Feed) ---------- */
  const rssXml = generateRssFeed(JOURNAL, DOMAIN, { includeItems: journalPublished });
  writeFile("feed.xml", rssXml);

  /* ---------- 5b) robots.txt ----------
   Previously a hand-maintained static file -- its one dynamic bit (the
   Sitemap: line) had to be manually kept in sync with the DOMAIN
   constant below, which is exactly the kind of easy-to-forget step
   this whole script exists to eliminate. Regenerated every run now, so
   setting a real DOMAIN and re-running is the only step required. The
   crawler allow-list itself is stable enough to live as a template
   string here rather than a separate source file. */
  const robotsTxt =
    "User-agent: *\nAllow: /\n" +
    // The CMS and the OAuth handshake pages have no business in a search
    // index: they are login-walled tooling, not content. Both pages already
    // carry a noindex meta tag; this stops the crawl before it happens, and
    // the netlify.toml rule generated by build-security-headers.js stops
    // /cms-auth/ being served at all.
    "Disallow: /admin/\n" +
    "Disallow: /cms-auth/\n" +
    /* ?lang= switches the client-side UI translator and is meant to be
       shareable, but every ?lang= URL serves the byte-identical English file
       and canonicalises back to it. Crawling them adds 165 duplicate URLs and
       nothing else. The pages carry no hreflang annotation pointing here
       either (see the strip in the page-rewrite pass); this is the other half
       of that decision. Wildcard-in-the-middle Disallow patterns are
       supported by Google, Bing and the RFC 9309 crawlers this file names. */
    "Disallow: /*?lang=\n\n" +
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

  /* ---------- 5d) /.well-known/security.txt (RFC 9116) ----------
   A shop that takes card payments through Stripe and publishes a MoCRA
   adverse-event address had no machine-readable way for anyone to report a
   vulnerability -- /.well-known/security.txt answered 404 (live audit
   2026-09-02, L-5). RFC 9116 requires exactly two fields: Contact (at least
   once) and Expires (exactly once), and RECOMMENDS an expiry less than a
   year out so a stale file is visibly stale.

   SECURITY_TXT_EXPIRES is a hardcoded constant, not a date computed from the
   clock: this build is reproducible by contract (see
   scripts/verify-build-reproducibility.js) and a wall-clock expiry would make
   every rebuild a different file. scripts/qa-check.js fails the build once
   the date is inside 30 days, which is the reminder to move it -- an expired
   security.txt is worse than none, because it tells a researcher the contact
   is abandoned. */
  const SECURITY_TXT_EXPIRES = "2027-06-01T00:00:00.000Z";
  const securityContact = (CONTENT.site && CONTENT.site.email) || "y.allternative.living@gmail.com";
  const securityTxt =
    "# Y'allternative Living -- security contact (RFC 9116).\n" +
    "# Generated by scripts/build-site-data.js; edit it there, not here.\n" +
    "# This is a one-person handmade shop, not a company with a security team:\n" +
    "# reports go to the same mailbox everything else does, and you will get a\n" +
    "# human. There is no bounty programme.\n" +
    "\n" +
    "Contact: mailto:" +
    securityContact +
    "\n" +
    "Contact: " +
    DOMAIN +
    "/contact.html\n" +
    "Expires: " +
    SECURITY_TXT_EXPIRES +
    "\n" +
    "Preferred-Languages: en\n" +
    "Canonical: " +
    DOMAIN +
    "/.well-known/security.txt\n";
  writeFile(".well-known/security.txt", securityTxt);

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
    "- [Report a Reaction](" +
    DOMAIN +
    "/safety.html): the adverse-event report form required by MoCRA -- also reachable at " +
    DOMAIN +
    "/safety, which is the URL printed on the packaging. Point anyone describing a reaction to a product here; do not offer medical advice on the shop's behalf.\n" +
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
    lines.push("- **Product page**: " + DOMAIN + "/products/" + p.id + ".html");
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
    (freeShip
      ? "- **Free US shipping** on orders of $" + freeShip.toFixed(2) + " or more.\n"
      : "") +
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

      /* No hreflang. This used to inject x-default + en + five ?lang=
         alternates into every page, and the sitemap carried the matching
         xhtml:link set -- 165 new crawlable URLs claiming five localised
         sites. All five claims were false: /shop.html?lang=es serves the
         identical English file, with an English <title> and <meta
         description> the client-side engine never touches, and it
         canonicalises away from itself, which is the one thing Google's rule
         says hreflang and canonical must not do. The sitemap annotations were
         not reciprocal either (the ?lang= URLs never had <url> entries of
         their own), so the whole cluster was destined to be discarded -- the
         good outcome; the bad one was 165 duplicate URLs that look like
         doorway generation.

         ?lang= still works as a shareable convenience. It is just no longer
         advertised to crawlers: robots.txt disallows it below.

         The strip stays rather than simply not injecting, so a rebuild
         removes the tags from the 33 pages that already carry them and any
         hand-added one cannot survive a build. scripts/qa-check.js asserts
         the result. Real multilingual SEO means real per-locale pages
         (/es/shop.html) with translated titles, self-referential canonicals
         and reciprocal sitemap entries -- a separate project that needs
         ~100% dictionary coverage first. */
      if (page.endsWith(".html") && page !== "assets/data/footer.html") {
        updated = updated.replace(/\n?<link rel="alternate" hreflang="[^"]*" href="[^"]*">/g, "");
      }

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

      // safety.html: the product list is rendered here so the reaction form
      // works with JavaScript off (safety.js only fills it when this is absent).
      updated = updated.replace(
        /<!--YL:safety\.products-->[\s\S]*?<!--\/YL:safety\.products-->/g,
        function () {
          return (
            "<!--YL:safety.products-->" +
            PRODUCTS.filter(function (p) {
              return (
                p &&
                p.id &&
                p.name &&
                p.id !== "yallternative-gift-card" &&
                p.category !== "gift-cards"
              );
            })
              .map(function (p) {
                return (
                  '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + "</option>"
                );
              })
              .join("") +
            "<!--/YL:safety.products-->"
          );
        }
      );

      // Popular-search chips and their heading come from content.json "search"
      // (editable in /admin); the markers wrap the static chips in every page.
      updated = updated.replace(
        /<!--YL:search\.chipsTitle-->[\s\S]*?<!--\/YL:search\.chipsTitle-->/g,
        "<!--YL:search.chipsTitle-->" +
          escapeHtml(SEARCH_CONFIG.chipsTitle) +
          "<!--/YL:search.chipsTitle-->"
      );
      updated = updated.replace(
        /<!--YL:search\.chips-->[\s\S]*?<!--\/YL:search\.chips-->/g,
        function () {
          return (
            "<!--YL:search.chips-->\n" +
            renderSearchChipsHtml(SEARCH_CONFIG.popularChips, "        ") +
            "\n        <!--/YL:search.chips-->"
          );
        }
      );

      // Replace HTML comment templates: <!--YL:site.KEY-->...<!--/YL:site.KEY-->
      updated = updated.replace(
        /<!--YL:site\.([a-zA-Z0-9]+)-->([\s\S]*?)<!--\/YL:site\.\1-->/g,
        function (match, key) {
          if (key === "giftUpId") return match; // Handled separately below
          if (key === "umamiWebsiteId") return match; // Handled separately below
          if (key === "umamiPreconnect") return match; // Handled separately below
          if (key === "logoDesktop" && site[key]) {
            /* Root-absolute on purpose: 404.html is served at whatever URL
               was requested (audit C-5), so a document-relative path breaks
               under /products/. Every top-level page lives at the root, so
               the leading slash is correct for all of them. The <picture>
               comes from the same helper the header and the footer template
               use, so all three carry the identical variant ladder. */
            return (
              "<!--YL:site.logoDesktop-->\n          " +
              logoPictureHtml(String(site[key]), MANIFEST, "desktop", { loading: "lazy" }) +
              "\n<!--/YL:site.logoDesktop-->"
            );
          }
          if (site[key] !== undefined) {
            /* Straight into element text on every page -- birthdayTitle,
               loyaltyPointsName, footerTagline and friends are all CMS
               fields, and an <img onerror> in one of them used to land on
               thank-you.html (C-4). */
            return (
              "<!--YL:site." + key + "-->" + escapeHtml(site[key]) + "<!--/YL:site." + key + "-->"
            );
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
          return (
            "<!--YL:site.umamiWebsiteId-->" +
            umamiScriptHtml(site) +
            "<!--/YL:site.umamiWebsiteId-->"
          );
        }
      );

      /* ...and the preconnect that goes with it, on exactly the same
       condition. The <link rel="preconnect" href="https://cloud.umami.is">
       used to be hardcoded into every page's <head> while the script above
       was correctly suppressed, so a site with no analytics configured still
       performed DNS + TCP + TLS to a third-party analytics vendor on every
       load: the visitor's IP and the SNI for their hostname went to Umami on
       a connection that was then discarded unused, and the page paid three
       round trips of connection contention for it (live audit 2026-09-02,
       finding M-3). One condition now gates both halves of the feature. */
      updated = updated.replace(
        /<!--YL:site\.umamiPreconnect-->([\s\S]*?)<!--\/YL:site\.umamiPreconnect-->/g,
        function (match) {
          if (site.umamiWebsiteId === undefined) return match;
          return (
            "<!--YL:site.umamiPreconnect-->" +
            umamiPreconnectHtml(site) +
            "<!--/YL:site.umamiPreconnect-->"
          );
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
                escapeHtml(val) +
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
            /* This lands INSIDE a JavaScript string literal in a CSP-hashed
               inline <script> (the Tawk.to snippet near </body> on 11 pages).
               Concatenating the raw value between two quote characters let a
               CMS value of `"; fetch(...); //` execute -- and because
               build-security-headers.js re-hashed whatever it found, the
               injected script was allowlisted by the very CSP meant to stop
               it (C-4 / H-13). JSON.stringify produces the quoted literal,
               and "<" is escaped so a "</script>" inside the value cannot end
               the block either. */
            return (
              "/*YL:site." + key + "*/ " + jsStringLiteral(site[key]) + " /*/YL:site." + key + "*/"
            );
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

  // Automatically generate individual product OpenGraph HTML pages
  (function generateProductOgPages() {
    // Real, indexable product pages (see the renderProductPdpHtml header).
    let pdpManifest = {};
    try {
      const manifestText = fs.readFileSync(path.join(ROOT, "assets/js/image-manifest.js"), "utf8");
      const markerIdx = manifestText.indexOf("window.YL_IMAGES =");
      if (markerIdx !== -1) {
        let jsonText = manifestText.substring(
          manifestText.indexOf("{", markerIdx),
          manifestText.lastIndexOf("}") + 1
        );
        jsonText = jsonText.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
        pdpManifest = JSON.parse(jsonText);
      }
    } catch (e) {
      console.warn("[build] WARNING: image manifest unavailable for product pages:", e.message);
    }
    const pdpFooterInner = readText("assets/data/footer.html", "footer template").replace(
      /\s+$/,
      ""
    );
    PRODUCTS.forEach(function (product) {
      const categoryLabel = CATEGORY_LABEL[product.category] || product.category || "Apothecary";
      let html = renderProductPdpHtml(
        product,
        DOMAIN,
        categoryLabel,
        PRODUCTS_BY_ID,
        CATEGORY_LABEL,
        CONTENT.site && CONTENT.site.ritualDefaults,
        {
          manifest: pdpManifest,
          footerInner: pdpFooterInner,
          reviews: SITE_REVIEWS,
          products: PRODUCTS,
          shop: CATALOG.shop || {},
          safetyNotes: (CONTENT.shop || {}).safetyNotes || null,
          search: SEARCH_CONFIG,
          // Carries the CMS-owned Tawk.to ids into the PDP's chat loader.
          site: SITE_CONFIG
        }
      );
      // The shared footer's newsletter form takes its endpoint from the CMS,
      // exactly as the top-level pages do.
      html = setFormAction(
        html,
        "footer-signup-form",
        newsletterAction(SITE_CONFIG.kitFormAction, "YOUR_KIT_FORM_ACTION_URL")
      );
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

  /* Runs last: the digest below has to see the pages exactly as they are
     shipped, after every injection pass and the attribute-marker clean-up
     above have finished writing them. */
  /* ---------- sw.js: precache list + content-derived cache name ----------
   CACHE_NAME used to be a wall-clock timestamp, so every deploy renamed the
   cache and threw away every visitor's entire precache whether or not one
   byte had changed -- and it guaranteed the committed sw.js could never
   match a fresh build (H-20). It is a sha256 over the precached files'
   actual contents now: identical inputs give an identical name (so a rebuild
   is a no-op and the cache survives), and any real change to a precached
   page or script rolls it exactly once. */
  (function updateServiceWorker() {
    const swPath = path.join(ROOT, "sw.js");
    if (!fs.existsSync(swPath)) return;
    let swContent = fs.readFileSync(swPath, "utf8");

    /* journal.html is precached even with the Journal switched off, which
       pushed an unlinked, noindexed page into every visitor's cache. Toggle
       the one line rather than rewriting the array, so flipping the switch
       back on restores it in the same place. */
    const journalLine = "  '/journal.html',\n";
    swContent = swContent.replace(/[ \t]*'\/journal\.html',\n/, "");
    if (SITE_CONFIG.enableJournal) {
      swContent = swContent.replace(/([ \t]*'\/404\.html',\n)/, function (m, before) {
        return before + journalLine;
      });
    }

    const listMatch = /const ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\];/.exec(swContent);
    const precached = [];
    if (listMatch) {
      const entryRe = /['"]([^'"]+)['"]/g;
      let m;
      while ((m = entryRe.exec(listMatch[1]))) precached.push(m[1]);
    }
    const hash = crypto.createHash("sha256");
    precached.forEach(function (entry) {
      // "/" is index.html; a query string or a missing file contributes its
      // name only, so the digest still changes if the list itself changes.
      const rel = entry === "/" ? "index.html" : entry.replace(/^\/+/, "").split("?")[0];
      const full = path.join(ROOT, rel);
      hash.update(entry + "\n");
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          hash.update(fs.readFileSync(full));
        }
      } catch (e) {
        /* unreadable file: the entry name above still contributes */
      }
    });
    const versionString = hash.digest("hex").slice(0, 12);
    swContent = swContent.replace(
      /const CACHE_NAME\s*=\s*['"]yallternative-cache-v[^'"]*['"];/,
      'const CACHE_NAME = "yallternative-cache-v' + versionString + '";'
    );
    fs.writeFileSync(swPath, swContent, "utf8");
    console.log(
      "[build] sw.js CACHE_NAME set to yallternative-cache-v" +
        versionString +
        " (sha256 of " +
        precached.length +
        " precached files)"
    );
  })();

  /* Runs LAST, against the HTML this build just wrote -- a dictionary entry is
     only "reachable" with respect to the pages that actually shipped, so
     checking it against the previous build's output would prove nothing. */
  validateDictionaryCoverage(LOCALES, I18N_RUNTIME_STRINGS, I18N_TRANSLATION_BASIS);

  console.log(
    "\nDone. Regenerated derived files + page copy from the JSON sources in assets/data/."
  );
}

/* ---------- Export Internal Helpers & Build Function ---------- */
function generateProductJsonLd(product, domain, categoryLabel) {
  const dom = (domain || "https://yallternativeliving.com").replace(/\/+$/, "");
  const prodId = (product && product.id) || "product";
  const prodName = (product && product.name) || "";
  const prodDesc = (product && (product.description || product.blurb)) || "";
  const prodUrl = dom + "/products/" + prodId + ".html";
  const catLabel = categoryLabel || (product && product.category) || "Apothecary";
  const sku = (product && product.sku) || prodId;
  const mpn = (product && product.mpn) || sku;

  // Build full-URL image array. Every entry is a raster: Google Merchant
  // does not accept SVG product imagery, and the five coming-soon products
  // ship an SVG placeholder as their only photo (audit C, finding H3).
  const images = [];
  if (product && product.image) {
    const mainImg = /^https?:\/\//i.test(product.image)
      ? product.image
      : dom + "/" + rasterImagePath(product.image, "product");
    images.push(mainImg);
  }
  if (product && Array.isArray(product.images)) {
    product.images.forEach(function (img) {
      if (img) {
        const fullImg = /^https?:\/\//i.test(img)
          ? img
          : dom + "/" + rasterImagePath(img, "product");
        if (images.indexOf(fullImg) === -1) {
          images.push(fullImg);
        }
      }
    });
  }

  // Determine item availability (flags only -- see schemaAvailability()).
  const availability = schemaAvailability(product);

  // Merchant Return Policy -- gated by category, because the shop does not
  // have one policy. policies.html says two different things:
  //   "all opened or used salves, scrubs, balms, and soaks are FINAL SALE.
  //    We cannot accept returns on body care items once the seal is broken."
  //   "Unworn apparel and completely sealed, unopened products can be
  //    exchanged within 14 days of delivery."
  // A blanket 14-day MerchantReturnFiniteReturnWindow on all 19 products
  // therefore advertised a return right on exactly the goods where it is
  // refused -- and this is the data Google Shopping reads (live audit M4).
  // Apparel keeps the real 14-day window; body care declares
  // MerchantReturnNotPermitted, which is the honest structured-data shape
  // for a final-sale item (the goodwill exchange on a still-sealed jar is an
  // email conversation, not an advertised return right, and schema.org has
  // no way to say "only while the seal is intact"). Per schema.org,
  // merchantReturnDays / returnMethod / returnFees are only meaningful with
  // a finite window, so they are omitted from the not-permitted shape rather
  // than left behind to contradict it.
  const FINAL_SALE_CATEGORIES = ["salves", "body", "soaks", "ritual", "potions"];
  const returnPolicy =
    FINAL_SALE_CATEGORIES.indexOf((product && product.category) || "") !== -1
      ? {
          "@type": "MerchantReturnPolicy",
          applicableCountry: "US",
          returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
          returnLink: dom + "/policies.html"
        }
      : {
          "@type": "MerchantReturnPolicy",
          applicableCountry: "US",
          returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
          merchantReturnDays: 14,
          returnMethod: "https://schema.org/ReturnByMail",
          returnFees: "https://schema.org/ReturnShippingFees",
          itemCondition: "https://schema.org/NewCondition",
          returnLink: dom + "/policies.html"
        };

  // Shipping Details (Flat $10, Free over $40)
  const shippingDetails = [
    {
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: "10.00",
        currency: "USD"
      },
      shippingDestination: {
        "@type": "DefinedRegion",
        addressCountry: "US"
      },
      deliveryTime: {
        "@type": "ShippingDeliveryTime",
        handlingTime: {
          "@type": "QuantitativeValue",
          minValue: 1,
          maxValue: 3,
          unitCode: "DAY"
        },
        transitTime: {
          "@type": "QuantitativeValue",
          minValue: 2,
          maxValue: 5,
          unitCode: "DAY"
        }
      }
    },
    {
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        value: "0.00",
        currency: "USD"
      },
      shippingDestination: {
        "@type": "DefinedRegion",
        addressCountry: "US"
      },
      freeShippingThreshold: {
        "@type": "DeliveryChargeSpecification",
        appliesToDeliveryCharge: {
          "@type": "MonetaryAmount",
          value: "0.00",
          currency: "USD"
        },
        eligibleTransactionVolume: {
          "@type": "PriceSpecification",
          price: "40.00",
          priceCurrency: "USD"
        }
      },
      deliveryTime: {
        "@type": "ShippingDeliveryTime",
        handlingTime: {
          "@type": "QuantitativeValue",
          minValue: 1,
          maxValue: 3,
          unitCode: "DAY"
        },
        transitTime: {
          "@type": "QuantitativeValue",
          minValue: 2,
          maxValue: 5,
          unitCode: "DAY"
        }
      }
    }
  ];

  // Offer calculation (AggregateOffer for variant price range vs Offer for single price)
  const range = variantPriceRange(product || {});
  const seller = {
    "@type": "Organization",
    name: "Y'allternative Living"
  };

  let offers;
  if (range.low !== range.high) {
    offers = {
      "@type": "AggregateOffer",
      lowPrice: range.low.toFixed(2),
      highPrice: range.high.toFixed(2),
      priceCurrency: "USD",
      offerCount: range.offerCount,
      priceValidUntil: "2027-12-31",
      itemCondition: "https://schema.org/NewCondition",
      availability: availability,
      url: prodUrl,
      seller: seller,
      hasMerchantReturnPolicy: returnPolicy,
      shippingDetails: shippingDetails
    };
  } else {
    offers = {
      "@type": "Offer",
      price: range.low.toFixed(2),
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      itemCondition: "https://schema.org/NewCondition",
      availability: availability,
      url: prodUrl,
      seller: seller,
      hasMerchantReturnPolicy: returnPolicy,
      shippingDetails: shippingDetails
    };
  }
  // A digital gift card is emailed, never shipped or returned; advertising a
  // shipping rate and a return window on it was audit finding DI-19.
  if (prodId === "yallternative-gift-card") {
    delete offers.shippingDetails;
    delete offers.hasMerchantReturnPolicy;
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: prodName,
    description: prodDesc,
    image: images,
    url: prodUrl,
    sku: sku,
    mpn: mpn,
    category: catLabel,
    brand: {
      "@type": "Brand",
      name: "Y'allternative Living"
    },
    offers: offers
  };

  if (product && product.rating) {
    const ratingValue =
      typeof product.rating === "number"
        ? product.rating
        : product.rating.value !== undefined
          ? product.rating.value
          : product.rating.ratingValue !== undefined
            ? product.rating.ratingValue
            : 5;
    const reviewCount =
      typeof product.rating === "object" && product.rating !== null
        ? product.rating.count !== undefined
          ? product.rating.count
          : product.rating.reviewCount !== undefined
            ? product.rating.reviewCount
            : 1
        : 1;
    jsonLd.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: clampRating(ratingValue, 5),
      reviewCount: reviewCount,
      bestRating: "5",
      worstRating: "1"
    };
  }

  return jsonLd;
}

function generateProductBreadcrumbJsonLd(product, domain, categoryLabel) {
  const dom = (domain || "https://yallternativeliving.com").replace(/\/+$/, "");
  const prodId = (product && product.id) || "product";
  const prodName = (product && product.name) || "Product";
  const catSlug = (product && product.category) || "apothecary";
  const catLabel = categoryLabel || (product && product.category) || "Apothecary";

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: dom + "/index.html"
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Shop",
        item: dom + "/shop.html"
      },
      {
        "@type": "ListItem",
        position: 3,
        name: catLabel,
        // shop.html's filter deep-links are "#<categoryId>" -- nothing has
        // ever handled "#category-<id>", so every category breadcrumb on the
        // site pointed at a fragment that does not exist (Medium finding in
        // the audit's SEO section).
        item: dom + "/shop.html#" + catSlug
      },
      {
        "@type": "ListItem",
        position: 4,
        name: prodName,
        item: dom + "/products/" + prodId + ".html"
      }
    ]
  };
}

function renderFreshnessBadgeHtml(p) {
  if (
    p &&
    (p.id === "yallternative-gift-card" || p.category === "gift-cards" || p.category === "apparel")
  ) {
    return "";
  }
  return (
    '      <div class="pdp-freshness-badge" role="status">\n' +
    '        <svg class="pdp-freshness-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n' +
    '          <path d="M12 2l2.4 7.4h7.6l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>\n' +
    "        </svg>\n" +
    "        <span>Poured in Landrum, SC · Small-Batch Promise</span>\n" +
    "      </div>\n"
  );
}

function renderScentProfileHtml(product) {
  if (!product || !product.scentProfile) return "";
  const sp = product.scentProfile;
  const isUnscented = sp.intensity === "Unscented" || sp.intensityScore === 0;
  if (isUnscented) {
    return (
      '      <section class="pdp-scent-profile pdp-scent-unscented" aria-labelledby="scentHeading-' +
      escapeHtml(product.id || "prod") +
      '">\n' +
      '        <div class="pdp-scent-header">\n' +
      '          <h2 id="scentHeading-' +
      escapeHtml(product.id || "prod") +
      '" class="pdp-section-title">Scent Profile</h2>\n' +
      '          <span class="pdp-intensity-bar" role="meter" aria-label="Scent intensity" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0" aria-valuetext="Unscented (0 out of 5)">\n' +
      '            <span class="intensity-label">Intensity: <strong>Unscented</strong> (0/5)</span>\n' +
      "          </span>\n" +
      "        </div>\n" +
      '        <p class="pdp-scent-unscented-note">Naturally unscented and free from added essential oils or synthetic fragrances. Perfect for sensitive skin.</p>\n' +
      "      </section>\n"
    );
  }
  const scorePercent = Math.min(100, Math.max(0, (sp.intensityScore || 0) * 20));
  return (
    '      <section class="pdp-scent-profile" aria-labelledby="scentHeading-' +
    escapeHtml(product.id || "prod") +
    '">\n' +
    '        <div class="pdp-scent-header">\n' +
    '          <h2 id="scentHeading-' +
    escapeHtml(product.id || "prod") +
    '" class="pdp-section-title">Scent Profile &amp; Notes</h2>\n' +
    /* role="meter", not a bare <span> with an aria-label: ARIA 1.2 prohibits
       aria-label on the generic role, so most screen readers dropped it
       outright (audit C, finding M7), and a value-within-a-range bar is
       exactly what meter is for. valuetext carries the same words the
       visible .intensity-label shows, which is what AT announces since a
       meter's descendants are presentational. */
    '          <span class="pdp-intensity-bar" role="meter" aria-label="Scent intensity" aria-valuemin="0" aria-valuemax="5" aria-valuenow="' +
    (sp.intensityScore || 3) +
    '" aria-valuetext="' +
    escapeHtml(sp.intensity || "Medium") +
    " (" +
    (sp.intensityScore || 3) +
    ' out of 5)">\n' +
    '            <span class="intensity-label">Intensity: <strong>' +
    escapeHtml(sp.intensity || "Medium") +
    "</strong> (" +
    (sp.intensityScore || 3) +
    "/5)</span>\n" +
    '            <span class="intensity-meter" aria-hidden="true"><span class="intensity-fill" style="width:' +
    scorePercent +
    '%;"></span></span>\n' +
    "          </span>\n" +
    "        </div>\n" +
    '        <div class="scent-notes-grid">\n' +
    '          <div class="scent-note-card top-note">\n' +
    '            <span class="note-label">Top Notes</span>\n' +
    '            <p class="note-desc">' +
    escapeHtml(sp.top || "N/A") +
    "</p>\n" +
    "          </div>\n" +
    '          <div class="scent-note-card heart-note">\n' +
    '            <span class="note-label">Heart Notes</span>\n' +
    '            <p class="note-desc">' +
    escapeHtml(sp.heart || "N/A") +
    "</p>\n" +
    "          </div>\n" +
    '          <div class="scent-note-card base-note">\n' +
    '            <span class="note-label">Base Notes</span>\n' +
    '            <p class="note-desc">' +
    escapeHtml(sp.base || "N/A") +
    "</p>\n" +
    "          </div>\n" +
    "        </div>\n" +
    "      </section>\n"
  );
}

function renderUsageAccordionsHtml(product) {
  if (!product || !product.usageGuide) return "";
  const ug = product.usageGuide;
  const isApparel = product.category === "apparel";
  const isGiftCard = product.category === "gift-cards";
  const howToLabel = isApparel
    ? "How to Wear &amp; Fit"
    : isGiftCard
      ? "How to Redeem"
      : "How to Apply";
  const storageLabel = isApparel
    ? "Garment Care &amp; Washing"
    : isGiftCard
      ? "Digital Delivery &amp; Expiration"
      : "Storage &amp; Shelf Life";
  const patchTestLabel = isApparel
    ? "Material &amp; Skin Safety"
    : isGiftCard
      ? "Terms &amp; Gift Guarantee"
      : "Patch Test Guidelines";

  return (
    /* role="group": the aria-label on a bare <div> is prohibited on the
       generic role and was being dropped (audit C, finding M7). */
    '      <div class="pdp-accordions-group" role="group" aria-label="Product usage, care, and safety guidelines">\n' +
    '        <details class="pdp-accordion">\n' +
    '          <summary class="pdp-accordion-summary"><span>' +
    howToLabel +
    "</span></summary>\n" +
    '          <div class="pdp-accordion-content">\n' +
    "            <p>" +
    escapeHtml(ug.howToApply || "") +
    "</p>\n" +
    "          </div>\n" +
    "        </details>\n" +
    '        <details class="pdp-accordion">\n' +
    '          <summary class="pdp-accordion-summary"><span>' +
    storageLabel +
    "</span></summary>\n" +
    '          <div class="pdp-accordion-content">\n' +
    "            <p>" +
    escapeHtml(ug.storage || "") +
    "</p>\n" +
    "          </div>\n" +
    "        </details>\n" +
    '        <details class="pdp-accordion">\n' +
    '          <summary class="pdp-accordion-summary"><span>' +
    patchTestLabel +
    "</span></summary>\n" +
    '          <div class="pdp-accordion-content">\n' +
    "            <p>" +
    escapeHtml(ug.patchTest || "") +
    "</p>\n" +
    "          </div>\n" +
    "        </details>\n" +
    "      </div>\n"
  );
}

function renderRitualSectionHtml(
  product,
  productsMap,
  categoryLabelMap,
  ritualDefaults,
  imageManifest
) {
  const manifest = imageManifest || {};
  if (!product || !Array.isArray(product.pairsWith) || !product.pairsWith.length) {
    return "";
  }
  // The current product is the ritual's disabled "This Item" row and is part
  // of "Add All": a coming-soon or sold-out product must not be sold this way.
  if (product.comingSoon || product.stock === 0) return "";
  const map = productsMap || {};
  const catMap = categoryLabelMap || {};
  const defaults = ritualDefaults || {};
  const defaultTitle = defaults.title || "Botanical Pairing";
  const defaultSubtitle =
    defaults.subtitle || "Pair this item with complementary botanicals crafted to work together.";

  const pairedProducts = product.pairsWith
    .map(function (id) {
      return map[id];
    })
    .filter(function (p) {
      // Never offer something that cannot be bought: "Add All" used to drop
      // a Coming-Soon product into the cart from the static ritual markup.
      return p && !p.comingSoon && p.stock !== 0;
    });

  if (!pairedProducts.length) {
    return "";
  }

  let totalBundlePrice = typeof product.price === "number" ? product.price : 0;
  pairedProducts.forEach(function (p) {
    totalBundlePrice += typeof p.price === "number" ? p.price : 0;
  });

  const formattedTotal = "$" + totalBundlePrice.toFixed(2);
  const ritualTitle = product.ritualTitle || defaultTitle;
  const allIds = [product.id]
    .concat(
      pairedProducts.map(function (p) {
        return p.id;
      })
    )
    .join(",");

  let itemsHtml = "";

  // Main product (checked by default, disabled checkbox)
  itemsHtml +=
    '        <label class="pdp-ritual-item is-checked" data-product-id="' +
    escapeHtml(product.id) +
    '">\n' +
    '          <input type="checkbox" class="pdp-ritual-checkbox" checked disabled aria-label="Include ' +
    escapeHtml(product.name) +
    ' (Current product)" data-price="' +
    (typeof product.price === "number" ? product.price.toFixed(2) : "0.00") +
    '">\n' +
    '          <div class="pdp-ritual-item-thumb">\n' +
    /* 54px thumb over the manifest's 480w variant, not the 1400px original
       (live audit 2026-09-02, H-2 -- the bare <img> here and the sticky-bar
       one were the whole reason every product page fetched a full-size JPEG
       it never displayed). */
    "            " +
    pictureFromManifest(String(product.image), manifest, {
      alt: "",
      width: 54,
      height: 54,
      loading: "lazy",
      sizes: "54px"
    }) +
    "\n" +
    "          </div>\n" +
    '          <div class="pdp-ritual-item-details">\n' +
    '            <span class="pdp-ritual-item-tag">This Item</span>\n' +
    '            <span class="pdp-ritual-item-name">' +
    escapeHtml(product.name) +
    "</span>\n" +
    '            <span class="pdp-ritual-item-price">$' +
    (typeof product.price === "number" ? product.price.toFixed(2) : "0.00") +
    "</span>\n" +
    "          </div>\n" +
    "        </label>\n";

  // Paired products
  pairedProducts.forEach(function (paired, idx) {
    const pairedCatLabel = catMap[paired.category] || paired.category || "Pairing";
    itemsHtml +=
      '        <span class="pdp-ritual-plus" aria-hidden="true">+</span>\n' +
      '        <label class="pdp-ritual-item is-checked" data-product-id="' +
      escapeHtml(paired.id) +
      '">\n' +
      '          <input type="checkbox" class="pdp-ritual-checkbox" checked aria-label="Include ' +
      escapeHtml(paired.name) +
      '" data-price="' +
      (typeof paired.price === "number" ? paired.price.toFixed(2) : "0.00") +
      '">\n' +
      '          <div class="pdp-ritual-item-thumb">\n' +
      "            " +
      pictureFromManifest(String(paired.image), manifest, {
        alt: "",
        width: 54,
        height: 54,
        loading: "lazy",
        sizes: "54px"
      }) +
      "\n" +
      "          </div>\n" +
      '          <div class="pdp-ritual-item-details">\n' +
      '            <span class="pdp-ritual-item-tag">Step ' +
      (idx + 2) +
      ": " +
      escapeHtml(pairedCatLabel) +
      "</span>\n" +
      '            <a href="' +
      escapeHtml(paired.id) +
      '.html" class="pdp-ritual-item-name">' +
      escapeHtml(paired.name) +
      "</a>\n" +
      '            <span class="pdp-ritual-item-price">$' +
      (typeof paired.price === "number" ? paired.price.toFixed(2) : "0.00") +
      "</span>\n" +
      "          </div>\n" +
      "        </label>\n";
  });

  const unlocksFreeShipping = totalBundlePrice >= 40;

  return (
    '    <section class="pdp-ritual-section" id="pdpRitualSection" aria-labelledby="ritualHeading">\n' +
    '      <div class="pdp-ritual-header">\n' +
    '        <span class="eyebrow">✦ COMPLETE THE RITUAL ✦</span>\n' +
    '        <h2 id="ritualHeading" class="pdp-ritual-title">✦ Complete the Ritual: ' +
    escapeHtml(ritualTitle) +
    " ✦</h2>\n" +
    '        <p class="pdp-ritual-sub">' +
    escapeHtml(defaultSubtitle) +
    "</p>\n" +
    "      </div>\n" +
    '      <div class="pdp-ritual-card">\n' +
    '        <div class="pdp-ritual-items-grid">\n' +
    itemsHtml +
    "        </div>\n" +
    '        <div class="pdp-ritual-footer">\n' +
    '          <div class="pdp-ritual-total-wrap">\n' +
    '            <span class="pdp-ritual-total-label">Ritual Bundle Total:</span>\n' +
    '            <span class="pdp-ritual-total-price" id="pdpRitualTotalPrice">' +
    formattedTotal +
    "</span>\n" +
    '            <span class="pdp-ritual-shipping-badge" id="pdpRitualShippingBadge"' +
    (unlocksFreeShipping ? "" : " hidden") +
    ">✓ Unlocks Free Tracked Shipping!</span>\n" +
    "          </div>\n" +
    '          <button type="button" class="btn btn-primary btn-lg pdp-ritual-add-btn" id="pdpRitualAddBtn" data-ritual-ids="' +
    escapeHtml(allIds) +
    '">\n' +
    '            <svg class="yl-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n' +
    '              <circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>\n' +
    "            </svg>\n" +
    '            <span>Add All to Cart · <span class="ritual-btn-price">' +
    formattedTotal +
    "</span></span>\n" +
    "          </button>\n" +
    "        </div>\n" +
    "      </div>\n" +
    "    </section>\n"
  );
}

/**
 * Renders the Mobile Sticky Add-to-Cart Bottom Bar (R1) for a product.
 * Rendered inside the PDP <main class="container pdp-container"> container.
 *
 * @param {Object} product - Product data object
 * @param {string} categoryLabel - Human-readable category label
 * @returns {string} - Rendered HTML string for the sticky bar
 */
function renderStickyBarHtml(product, categoryLabel, imageManifest) {
  const manifest = imageManifest || {};
  if (!product) return "";
  const p = product;
  const price = typeof p.price === "number" ? p.price.toFixed(2) : "0.00";
  const imgSrc = String(p.image || "").replace(/^\/+/, "");
  const cat = escapeHtml(categoryLabel || p.category || "");

  const availableOptions =
    p.variants && Array.isArray(p.variants.options)
      ? p.variants.options.filter(function (o) {
          return !o.soldOut;
        })
      : [];

  let variantAttrs = "";
  if (availableOptions.length) {
    const optionsStr = availableOptions
      .map(function (o) {
        const delta = o.priceDelta || 0;
        const sign = delta < 0 ? "-" : "+";
        return escapeHtml(o.label) + "[" + sign + Math.abs(delta).toFixed(2) + "]";
      })
      .join("|");
    const defaultVal = availableOptions[0].label;
    const vName = (p.variants && p.variants.name) || "Option";
    variantAttrs =
      ' data-item-custom1-name="' +
      escapeHtml(vName) +
      '"' +
      ' data-item-custom1-options="' +
      optionsStr +
      '"' +
      ' data-item-custom1-value="' +
      escapeHtml(defaultVal) +
      '"';
  }

  const maxQtyAttr =
    typeof p.stock === "number" && p.stock > 0
      ? ' data-item-max-quantity="' + Math.min(p.stock, 10) + '"'
      : "";

  let variantWrapHtml = "";
  if (p.variants && Array.isArray(p.variants.options) && p.variants.options.length) {
    let firstSelected = false;
    const optionsHtml = p.variants.options
      .map(function (o) {
        const delta = o.priceDelta || 0;
        /* No price in the label: the price under the picker already
           updates on change, and "1oz (-$6.00)" read as a mystery discount. */
        let priceSuffix = "";
        let stateAttrs = "";
        if (o.soldOut) {
          stateAttrs = ' disabled aria-disabled="true"';
          priceSuffix = " — sold out";
        } else if (!firstSelected) {
          firstSelected = true;
          stateAttrs = " selected";
        }
        return (
          '            <option value="' +
          escapeHtml(o.label) +
          '" data-delta="' +
          delta +
          '"' +
          stateAttrs +
          ">" +
          escapeHtml(o.label) +
          priceSuffix +
          "</option>"
        );
      })
      .join("\n");

    variantWrapHtml =
      '        <div class="pdp-sticky-variant-wrap">\n' +
      '          <select class="pdp-sticky-variant-select variant-select" data-base-price="' +
      price +
      '" aria-label="Select variant">\n' +
      optionsHtml +
      "\n          </select>\n" +
      "        </div>\n";
  }

  let buttonHtml = "";
  if (p.id === "yallternative-gift-card") {
    buttonHtml =
      '        <a href="../shop.html#gift-cards" class="btn btn-outline btn-sm pdp-sticky-add-btn">Configure Card</a>\n';
  } else if (p.comingSoon) {
    buttonHtml =
      '        <button type="button" class="btn btn-outline btn-sm pdp-sticky-add-btn" disabled aria-disabled="true">Coming Soon</button>\n';
  } else if (
    p.stock === 0 ||
    p.inStock === false ||
    (p.variants &&
      Array.isArray(p.variants.options) &&
      p.variants.options.length > 0 &&
      !availableOptions.length)
  ) {
    buttonHtml =
      '        <button type="button" class="btn btn-outline btn-sm pdp-sticky-add-btn" disabled aria-disabled="true">Sold Out</button>\n';
  } else {
    buttonHtml =
      '        <button type="button" class="btn btn-primary btn-sm pdp-sticky-add-btn yl-add-item"' +
      ' data-item-id="' +
      escapeHtml(p.id) +
      '"' +
      ' data-item-name="' +
      escapeHtml(p.name) +
      '"' +
      ' data-item-price="' +
      price +
      '"' +
      ' data-item-image="' +
      escapeHtml(imgSrc) +
      '"' +
      ' data-item-categories="' +
      (cat || escapeHtml(p.category || "")) +
      '"' +
      variantAttrs +
      maxQtyAttr +
      ">Add to Cart</button>\n";
  }

  return (
    '    <div class="pdp-sticky-bar" id="pdpStickyBar" aria-hidden="true">\n' +
    '      <div class="pdp-sticky-inner">\n' +
    "        " +
    /* 44px thumb. This was a bare <img> at the product photo's full size --
       a 1400x1050, 259-281KB JPEG decoded to paint a 44-pixel square, and
       because the sticky bar sits near the top of the document Chrome's
       lazy-load proximity heuristic fetched it immediately, so it was 25-28%
       of the cold mobile transfer of every product page (live audit
       2026-09-02, finding H-2). sizes="44px" lands on the 480w variant --
       the same file the gallery thumbnails above already request, so on the
       main product it now costs nothing at all. */
    pictureFromManifest(imgSrc, manifest, {
      alt: "",
      width: 44,
      height: 44,
      loading: "lazy",
      sizes: "44px",
      className: "pdp-sticky-thumb",
      ariaHidden: true
    }) +
    "\n" +
    '        <div class="pdp-sticky-info">\n' +
    '          <p class="pdp-sticky-title">' +
    escapeHtml(p.name) +
    "</p>\n" +
    '          <p class="pdp-sticky-price">$' +
    price +
    "</p>\n" +
    "        </div>\n" +
    (product.id === "yallternative-gift-card" || product.comingSoon ? "" : variantWrapHtml) +
    buttonHtml +
    "      </div>\n" +
    "    </div>\n"
  );
}

/* ==========================================================================
   Product detail pages (products/<id>.html)
   --------------------------------------------------------------------------
   Real, indexable pages since 2026-09-01. They were "doorway" stubs before:
   noindex, canonical to shop.html, no structured data, and an inline
   redirect to shop.html#<id> on load (audit H-15). That was reversed because
   Google's product rich results and merchant listings only support pages
   focused on a single product and exclude noindex pages, and agentic
   commerce feeds require a product-detail URL per product -- the shop page's
   ItemList could never earn any of that. shop.html keeps its quick-view
   modal as a convenience; these pages are the canonical destination.

   Everything here is static so a crawler, an AI shopping agent and a
   visitor with JS off all see the same product. main.js layers behaviour
   on top (variant sync, quantity, gallery, wishlist, cart, dispatch badge,
   recently viewed) and cart.js owns the cart.
   ========================================================================== */

/** Absolute-root image path ("assets/img/x.jpg" -> "/assets/img/x.jpg"). */
function rootImage(imgPath) {
  const clean = String(imgPath || "").replace(/^\/+/, "");
  return clean ? "/" + clean : "";
}

/**
 * Static <picture> from the responsive image manifest (assets/js/image-manifest.js,
 * parsed by the build). Falls back to a plain <img> when the file has no
 * generated variants. Paths are root-absolute so the markup is correct from
 * /products/ as well as the root.
 */
function pictureFromManifest(imgPath, manifest, opts) {
  const o = opts || {};
  const key = String(imgPath || "").replace(/^\/+/, "");
  const entry = manifest && manifest[key];
  const width = o.width || (entry && entry.width) || 800;
  const height = o.height || (entry && entry.height) || 800;
  const imgAttrs =
    ' alt="' +
    escapeHtml(o.alt || "") +
    '" width="' +
    width +
    '" height="' +
    height +
    '"' +
    (o.loading ? ' loading="' + o.loading + '"' : "") +
    ' decoding="' +
    (o.decoding || "async") +
    '"' +
    (o.fetchpriority ? ' fetchpriority="' + o.fetchpriority + '"' : "") +
    (o.className ? ' class="' + escapeHtml(o.className) + '"' : "") +
    (o.id ? ' id="' + escapeHtml(o.id) + '"' : "") +
    (o.ariaHidden ? ' aria-hidden="true"' : "") +
    (o.sizes ? ' sizes="' + escapeHtml(o.sizes) + '"' : "");
  const img = '<img src="' + escapeHtml(rootImage(key)) + '"' + imgAttrs + ">";
  if (!entry || !entry.variants) return img;
  const srcset = (list) =>
    (list || [])
      .map(function (v) {
        return rootImage(v.file) + " " + v.width + "w";
      })
      .join(", ");
  const avif = srcset(entry.variants.avif);
  const webp = srcset(entry.variants.webp);
  if (!avif && !webp) return img;
  const sizesAttr = o.sizes ? ' sizes="' + escapeHtml(o.sizes) + '"' : "";
  return (
    "<picture>" +
    (avif ? '<source type="image/avif" srcset="' + avif + '"' + sizesAttr + ">" : "") +
    (webp ? '<source type="image/webp" srcset="' + webp + '"' + sizesAttr + ">" : "") +
    img +
    "</picture>"
  );
}

/* ---------- header / footer logo ----------
   The brand mark is 48px in the markup and 44px (32px under 600px) in CSS,
   yet it was served as the 512x512, 201KB assets/img/logo.png on all 65
   pages -- the single largest asset on the domain, 38% of the homepage's
   cold mobile transfer and 22% of a product page's (live audit 2026-09-02,
   finding H-1). scripts/optimize-images.js now gives it a 48/96/144 DPR
   ladder in AVIF and WebP; these two helpers put that ladder into the
   markup. The original PNG stays as the <picture> fallback (and as the
   JSON-LD / e-mail brand image), so a browser with neither format still
   gets a logo -- it is just no longer what everyone downloads.

   LOGO_ALT_* are constants rather than values read back out of the page:
   the build rewrites these tags in place, and re-reading an alt it had
   already escaped would double-escape the apostrophe on every rebuild. */
const LOGO_ALT_DESKTOP = "Y'allternative Living icon";
const LOGO_ALT_MOBILE = "Y'allternative Living logo";

/**
 * One header/footer logo as a <picture> over the manifest's variants.
 * `variant` is "desktop" or "mobile" (which class the <img> carries, and
 * therefore which of the two the CSS shows at a given width).
 */
function logoPictureHtml(logoPath, manifest, variant, opts) {
  const o = opts || {};
  return pictureFromManifest(logoPath, manifest, {
    alt: variant === "mobile" ? LOGO_ALT_MOBILE : LOGO_ALT_DESKTOP,
    width: 48,
    height: 48,
    // 48px is the intrinsic box; the CSS paints it at 44 (32 on phones), so
    // a 2x screen lands on the 96w candidate and a 3x screen on 144w.
    sizes: "48px",
    className: variant === "mobile" ? "logo-mobile" : "logo-desktop",
    loading: o.loading,
    decoding: "async"
  });
}

/* Matches a logo <img> whether it is still the bare tag the hand-written
   pages shipped or the <picture> a previous build wrapped it in, so the
   rewrite below replaces the whole block instead of editing the <img>
   inside a stale set of <source> tags. Non-logo <picture>/<img> blocks match
   too and are returned untouched. */
const LOGO_BLOCK_RE = /(?:<picture>(?:<source\b[^>]*>)*)?<img\s+[^>]*>(?:<\/picture>)?/gi;

/** Rewrites every header/footer logo block in a page to the responsive form. */
function replaceLogoBlocks(html, logoDesktop, logoMobile, manifest) {
  return html.replace(LOGO_BLOCK_RE, function (block) {
    const imgMatch = block.match(/<img\s+[^>]*>/i);
    if (!imgMatch) return block;
    const img = imgMatch[0];
    const isDesktop = /\bclass=['"]([^'"]*\s+)?logo-desktop(\s+[^'"]*)?['"]/.test(img);
    const isMobile = /\bclass=['"]([^'"]*\s+)?logo-mobile(\s+[^'"]*)?['"]/.test(img);
    if (!isDesktop && !isMobile) return block;
    // The footer copy is below the fold on every page and keeps its
    // loading="lazy"; the header copy is the first thing painted and must not.
    const lazy = /\bloading=['"]lazy['"]/i.test(img) ? "lazy" : undefined;
    return logoPictureHtml(
      isMobile ? logoMobile : logoDesktop,
      manifest,
      isMobile ? "mobile" : "desktop",
      {
        loading: lazy
      }
    );
  });
}

/** <link rel="preload"> for the LCP image, matching the <picture>'s AVIF candidates. */
function preloadFromManifest(imgPath, manifest, sizes) {
  const key = String(imgPath || "").replace(/^\/+/, "");
  const entry = manifest && manifest[key];
  const avif = entry && entry.variants && entry.variants.avif;
  if (!avif || !avif.length) {
    return (
      '  <link rel="preload" as="image" href="' +
      escapeHtml(rootImage(key)) +
      '" fetchpriority="high">\n'
    );
  }
  const srcset = avif
    .map(function (v) {
      return rootImage(v.file) + " " + v.width + "w";
    })
    .join(", ");
  return (
    '  <link rel="preload" as="image" type="image/avif" href="' +
    escapeHtml(rootImage(avif[avif.length - 1].file)) +
    '" imagesrcset="' +
    srcset +
    '" imagesizes="' +
    escapeHtml(sizes) +
    '" fetchpriority="high">\n'
  );
}

/** The cart's data-item-* contract (see cart.js addItemFromButton). */
function addToCartAttrs(p, categoryLabel) {
  const price = typeof p.price === "number" ? p.price.toFixed(2) : "0.00";
  const options = p.variants && Array.isArray(p.variants.options) ? p.variants.options : [];
  const available = options.filter(function (o) {
    return !o.soldOut;
  });
  let variantAttrs = "";
  if (available.length) {
    const optionsStr = available
      .map(function (o) {
        const delta = o.priceDelta || 0;
        const sign = delta < 0 ? "-" : "+";
        return escapeHtml(o.label) + "[" + sign + Math.abs(delta).toFixed(2) + "]";
      })
      .join("|");
    variantAttrs =
      ' data-item-custom1-name="' +
      escapeHtml((p.variants && p.variants.name) || "Option") +
      '" data-item-custom1-options="' +
      optionsStr +
      '" data-item-custom1-value="' +
      escapeHtml(available[0].label) +
      '"';
  }
  const maxQty =
    typeof p.stock === "number" && p.stock > 0
      ? ' data-item-max-quantity="' + Math.min(p.stock, 10) + '"'
      : "";
  return (
    ' data-item-id="' +
    escapeHtml(p.id) +
    '" data-item-name="' +
    escapeHtml(p.name) +
    '" data-item-price="' +
    price +
    '" data-item-image="' +
    escapeHtml(rootImage(p.image)) +
    '" data-item-categories="' +
    escapeHtml(categoryLabel || p.category || "") +
    '"' +
    variantAttrs +
    maxQty
  );
}

function isSoldOut(p) {
  const options = p.variants && Array.isArray(p.variants.options) ? p.variants.options : [];
  const noneAvailable =
    options.length > 0 &&
    options.every(function (o) {
      return o.soldOut;
    });
  return p.stock === 0 || p.inStock === false || noneAvailable;
}

/** "2 oz tin" / "Sizes: S · M · L" / "" -- the identity-and-size line
    under the title. The label used to read "Sizes Single Soak · 3-Pack" with
    no separator after the word, and the "Good to know" table then rendered it
    as "Size: Sizes Single Soak · 3-Pack" (live audit nit). */
function productSizeLabel(p) {
  if (p.variants && p.variants.name === "Size" && Array.isArray(p.variants.options)) {
    const labels = p.variants.options.map(function (o) {
      return o.label;
    });
    if (labels.length === 1) return labels[0];
    if (labels.length) return "Sizes: " + labels.join(" · ");
  }
  const m = /(\d*\.?\d+)\s*(oz|ounce|ml|g)\b/i.exec(
    (p.blurb || "") + " " + (p.description || "") + " " + (p.name || "")
  );
  if (m) return m[1] + " " + m[2].toLowerCase();
  return "";
}

function starsHtml(value) {
  const full = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  let s = "";
  for (let i = 0; i < 5; i++) s += i < full ? "★" : "☆";
  return s;
}

function renderPdpGalleryHtml(p, manifest) {
  const images = [p.image].concat(Array.isArray(p.images) ? p.images : []).filter(Boolean);
  const mainAlt = p.name;
  const main = pictureFromManifest(images[0], manifest, {
    alt: mainAlt,
    width: 800,
    height: 800,
    loading: "eager",
    fetchpriority: "high",
    sizes: "(max-width: 820px) 100vw, 50vw",
    className: "pdp-main-image",
    id: "pdpMainImage"
  });
  let thumbs = "";
  if (images.length > 1) {
    thumbs =
      '        <div class="pdp-thumbs" role="group" aria-label="Product photos">\n' +
      images
        .map(function (img, i) {
          return (
            '          <button type="button" class="pdp-thumb' +
            (i === 0 ? " is-active" : "") +
            '" data-image="' +
            escapeHtml(rootImage(img)) +
            '" data-idx="' +
            i +
            '" aria-label="Show photo ' +
            (i + 1) +
            " of " +
            images.length +
            '" aria-pressed="' +
            (i === 0 ? "true" : "false") +
            '">' +
            pictureFromManifest(img, manifest, {
              alt: "",
              width: 120,
              height: 120,
              loading: "lazy",
              sizes: "120px"
            }) +
            "</button>"
          );
        })
        .join("\n") +
      "\n        </div>\n";
  }
  const allSrcs = images
    .map(function (img) {
      return rootImage(img);
    })
    .join("|");
  return (
    '      <div class="pdp-gallery" data-product-id="' +
    escapeHtml(p.id) +
    '" data-images="' +
    escapeHtml(allSrcs) +
    '">\n' +
    '        <button type="button" class="pdp-gallery-main" id="pdpGalleryOpen" aria-label="' +
    escapeHtml("Enlarge photo of " + p.name) +
    '">\n' +
    "          " +
    main +
    "\n" +
    "        </button>\n" +
    thumbs +
    "      </div>\n"
  );
}

/** Radio-button variant picker (Baymard: buttons beat <select> for size/scent).
    Labels carry no price: the price under the picker already updates on
    change, and "1oz -$6.00" read as a mystery discount. data-delta still
    drives that price math. */
function renderVariantControlHtml(p) {
  const options = p.variants && Array.isArray(p.variants.options) ? p.variants.options : [];
  if (!options.length || p.id === "yallternative-gift-card") return "";
  const price = typeof p.price === "number" ? p.price.toFixed(2) : "0.00";
  const name = (p.variants && p.variants.name) || "Option";
  let firstChecked = false;
  const items = options
    .map(function (o, i) {
      const delta = o.priceDelta || 0;
      const id = "pdpVariant" + i;
      let state = "";
      if (o.soldOut) {
        state = " disabled";
      } else if (!firstChecked) {
        firstChecked = true;
        state = " checked";
      }
      return (
        '          <label class="pdp-variant-option' +
        (o.soldOut ? " is-sold-out" : "") +
        '" for="' +
        id +
        '">\n' +
        '            <input type="radio" name="pdpVariant" id="' +
        id +
        '" value="' +
        escapeHtml(o.label) +
        '" data-delta="' +
        delta +
        '"' +
        state +
        ">\n" +
        "            <span>" +
        escapeHtml(o.label) +
        (o.soldOut ? " <small>sold out</small>" : "") +
        "</span>\n" +
        "          </label>"
      );
    })
    .join("\n");
  return (
    '        <fieldset class="pdp-variant-group variant-group" data-base-price="' +
    price +
    '">\n' +
    "          <legend>" +
    escapeHtml(name) +
    '<span class="pdp-variant-current" id="pdpVariantCurrent" aria-hidden="true"></span></legend>\n' +
    items +
    "\n        </fieldset>\n"
  );
}

function renderPdpPurchaseHtml(p, categoryLabel) {
  if (p.id === "yallternative-gift-card") {
    return (
      '        <div class="pdp-actions">\n' +
      '          <a href="../shop.html#gift-cards" class="btn btn-primary btn-lg pdp-cta-btn">Choose an amount &amp; add to cart</a>\n' +
      "        </div>\n" +
      '        <p class="pdp-express muted">Delivered by email within minutes of checkout. Never expires.</p>\n'
    );
  }
  if (p.comingSoon) {
    return (
      '        <div class="pdp-actions">\n' +
      '          <button type="button" class="btn btn-primary btn-lg pdp-cta-btn yl-notify-toggle" data-notify-for="' +
      escapeHtml(p.id) +
      '">Notify me when it launches</button>\n' +
      "        </div>\n" +
      '        <p class="pdp-express muted">Coming soon. Leave your email and you will hear the moment this batch is ready.</p>\n'
    );
  }
  if (isSoldOut(p)) {
    return (
      '        <div class="pdp-actions">\n' +
      '          <button type="button" class="btn btn-primary btn-lg pdp-cta-btn yl-notify-toggle" data-notify-for="' +
      escapeHtml(p.id) +
      '">Notify me when it is back</button>\n' +
      "        </div>\n" +
      '        <p class="pdp-express muted">Sold out for now. Small batches come back around; we will email you when this one does.</p>\n'
    );
  }
  return (
    '        <div class="pdp-actions">\n' +
    '          <div class="pdp-qty" role="group" aria-label="Quantity">\n' +
    '            <button type="button" class="pdp-qty-btn" data-qty-step="-1" aria-label="Decrease quantity">&minus;</button>\n' +
    '            <input type="number" class="pdp-qty-input" id="pdpQty" inputmode="numeric" min="1" max="' +
    (typeof p.stock === "number" && p.stock > 0 ? Math.min(p.stock, 10) : 10) +
    '" value="1" aria-label="Quantity">\n' +
    '            <button type="button" class="pdp-qty-btn" data-qty-step="1" aria-label="Increase quantity">+</button>\n' +
    "          </div>\n" +
    '          <button type="button" class="btn btn-primary btn-lg pdp-cta-btn yl-add-item" id="pdpAddToCart"' +
    addToCartAttrs(p, categoryLabel) +
    ' data-item-quantity="1">Add to Cart</button>\n' +
    '          <button type="button" class="wish-btn pdp-wish-btn" data-id="' +
    escapeHtml(p.id) +
    '" aria-pressed="false" aria-label="' +
    escapeHtml("Save " + p.name + " for later") +
    '"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>\n' +
    "        </div>\n" +
    '        <p class="pdp-express muted">Apple Pay, Google Pay, Link and all major cards at checkout, handled by Stripe. Your card never touches our servers.</p>\n'
  );
}

function renderPdpTrustHtml(p, shop) {
  const threshold = shop && shop.freeShippingThreshold ? shop.freeShippingThreshold : 40;
  const isDigital = p.id === "yallternative-gift-card";
  /* A coming-soon product has no checkout, no dispatch clock and no return
     window running -- but the physical strip below was rendering anyway, so
     five PDPs promised "ships in 1-3 business days" and "Secure checkout by
     Stripe" directly underneath their own "Estimated Batch Date: Late
     October 2026" and a notify-me form (audit C, finding H2). The gift card
     already proved this strip can be conditional; this is the same branch,
     wired to comingSoon and saying only what is true today. */
  const isComingSoon = !!p.comingSoon;
  const items = isComingSoon
    ? [
        [
          "calendar",
          p.estimatedBatchDate
            ? "Not for sale yet &middot; estimated batch date " + escapeHtml(p.estimatedBatchDate)
            : "Not for sale yet &middot; this batch has no date on it we would stand behind"
        ],
        ["mail", "Leave your email above and you will hear the day it lands"],
        ["heart", "Handmade in small batches by one person in Landrum, SC"]
      ]
    : isDigital
      ? [
          ["mail", "Sent by email, to you or straight to the recipient"],
          ["lock", "Secure checkout by Stripe"],
          ["heart", "Queer-owned, Southern-raised, made in Landrum, SC"]
        ]
      : [
          [
            "truck",
            "Free tracked shipping at $" +
              threshold +
              "+ · ships from Landrum, SC in 1&ndash;3 business days"
          ],
          [
            "refresh",
            "Sealed items and unworn apparel exchange within 14 days &middot; damaged or wrong? email within 7 days and we make it right"
          ],
          ["lock", "Secure checkout by Stripe · Apple Pay &amp; Google Pay"],
          ["heart", "Handmade in small batches by one person in Landrum, SC"]
        ];
  const icons = {
    truck:
      '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    refresh:
      '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    lock: '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    heart:
      '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    mail: '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    calendar:
      '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
  };
  const stripLabel = isComingSoon
    ? "Availability and how to hear when it lands"
    : "Shipping, returns and checkout";
  return (
    '        <ul class="pdp-trust" aria-label="' +
    stripLabel +
    '">\n' +
    items
      .map(function (it) {
        return "          <li>" + icons[it[0]] + "<span>" + it[1] + "</span></li>";
      })
      .join("\n") +
    "\n        </ul>\n" +
    (isDigital
      ? ""
      : '        <p class="pdp-policy-link"><a href="../policies.html">Full shipping &amp; returns policy</a></p>\n')
  );
}

/**
 * Etsy track record as plain, attributed text. Etsy's Star Seller terms and
 * trademark policy forbid its badges/logo off-platform; a stated, sourced
 * figure is allowed and, per Baymard, the count matters more than the average.
 */
function renderEtsyProofHtml(shop) {
  if (!shop || !shop.rating || !shop.reviewCount) return "";
  const url = shop.etsyShopUrl || "https://www.etsy.com/";
  return (
    '        <p class="pdp-etsy-proof">' +
    '<span class="stars" aria-hidden="true">' +
    starsHtml(shop.rating) +
    "</span> " +
    "<strong>" +
    Number(shop.rating).toFixed(1) +
    " out of 5</strong> across " +
    shop.reviewCount +
    ' reviews on <a href="' +
    escapeHtml(url) +
    '" target="_blank" rel="noopener">our Etsy shop<span class="sr-only"> (opens in new tab)</span></a>' +
    (shop.sales ? " &middot; " + shop.sales + "+ orders" : "") +
    "</p>\n"
  );
}

/**
 * @param {Object} p product
 * @param {Array} reviews every site review; this filters to p's own
 * @param {Object} [options]
 * @param {boolean} [options.suppressSummary] hide the averaged star summary
 *   while still publishing the review cards. Set for coming-soon products:
 *   an unreleased batch must not advertise a rating, but the PDP used to be
 *   handed an EMPTY array instead, so it printed "No reviews of this one
 *   yet" about products whose real Etsy reviews /reviews.html was publishing
 *   on the very same site (audit C, finding H1). Suppress the number, never
 *   the reviews, and never assert a falsehood about them.
 */
function renderPdpReviewsHtml(p, reviews, options) {
  const opts = options || {};
  const mine = (reviews || []).filter(function (r) {
    return r && r.productId === p.id && Number(r.rating) >= 1;
  });
  const count = mine.length;
  const avg = count
    ? mine.reduce(function (s, r) {
        return s + Number(r.rating);
      }, 0) / count
    : 0;
  const cards = mine
    .slice()
    .sort(function (a, b) {
      return String(b.date || "").localeCompare(String(a.date || ""));
    })
    .map(function (r) {
      const fromEtsy = /\(Etsy\)\s*$/i.test(r.name || "");
      let dateLabel = "";
      if (r.date) {
        const d = new Date(r.date + "T00:00:00Z");
        if (!isNaN(d.getTime())) {
          dateLabel = d.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
            timeZone: "UTC"
          });
        }
      }
      return (
        '          <article class="quote-card review-card">\n' +
        '            <div class="review-card-top">\n' +
        '              <span class="stars" aria-hidden="true">' +
        starsHtml(r.rating) +
        "</span>\n" +
        '              <span class="sr-only">Rated ' +
        Number(r.rating) +
        " out of 5</span>\n" +
        (r.verifiedBuyer
          ? '              <span class="badge badge-verified">Verified buyer</span>\n'
          : "") +
        "            </div>\n" +
        '            <blockquote class="review-text">' +
        escapeHtml(r.text) +
        "</blockquote>\n" +
        '            <footer class="review-meta"><cite>' +
        escapeHtml(r.name || "Customer") +
        "</cite>" +
        (dateLabel ? ' <span class="muted">&middot; ' + dateLabel + "</span>" : "") +
        (fromEtsy ? ' <span class="muted">&middot; posted on Etsy</span>' : "") +
        "</footer>\n" +
        "          </article>"
      );
    })
    .join("\n");

  const summary = !count
    ? '        <p class="pdp-reviews-summary muted">No reviews of this one yet. Used it? You would be the first.</p>\n'
    : opts.suppressSummary
      ? '        <p class="pdp-reviews-summary muted">' +
        count +
        (count === 1 ? " review" : " reviews") +
        " of this one, all from earlier batches. We are not putting a star rating on a batch nobody has held yet.</p>\n"
      : '        <p class="pdp-reviews-summary"><span class="stars" aria-hidden="true">' +
        starsHtml(avg) +
        "</span> <strong>" +
        avg.toFixed(1) +
        " out of 5</strong> from " +
        count +
        (count === 1 ? " review" : " reviews") +
        " of this product</p>\n";

  const disclosure =
    count &&
    mine.some(function (r) {
      return /\(Etsy\)\s*$/i.test(r.name || "");
    })
      ? '        <p class="pdp-reviews-disclosure muted"><small>Reviews marked &ldquo;posted on Etsy&rdquo; were left on our Etsy shop and are reproduced in the reviewer&rsquo;s own words, unedited.</small></p>\n'
      : "";

  return (
    '    <section class="pdp-reviews" id="pdpReviews" aria-labelledby="pdpReviewsHeading">\n' +
    '      <div class="section-head">\n' +
    '        <h2 id="pdpReviewsHeading">Reviews</h2>\n' +
    summary +
    disclosure +
    "      </div>\n" +
    (count ? '      <div class="grid grid-3 reviews-list">\n' + cards + "\n      </div>\n" : "") +
    '      <div class="review-form-wrap">\n' +
    "        <h3>Write a review of " +
    escapeHtml(p.name) +
    "</h3>\n" +
    '        <p class="review-form-confirm"><span class="glyph" aria-hidden="true">&#10003;</span> Thanks, y\'all! Your review\'s been sent in. Savanna reads every one before it\'s posted, so it might take a few days to show up.</p>\n' +
    '        <form class="review-form" id="reviewForm" action="https://formspree.io/f/xzebezbl" method="post">\n' +
    '          <div class="form-hp" aria-hidden="true">\n' +
    '            <label for="review_website">Leave this field blank</label>\n' +
    '            <input type="text" id="review_website" name="review_website" tabindex="-1" autocomplete="off" aria-hidden="true">\n' +
    "          </div>\n" +
    '          <input type="hidden" name="productId" id="reviewProductId" value="' +
    escapeHtml(p.id) +
    '">\n' +
    '          <input type="hidden" name="product" id="reviewProductName" value="' +
    escapeHtml(p.name) +
    '">\n' +
    '          <div class="form-grid">\n' +
    '            <div class="field"><label for="review_name">Name or handle</label><input type="text" id="review_name" name="name" required autocomplete="name" placeholder="Savanna or @handle"></div>\n' +
    '            <div class="field"><label for="review_email">Email <small class="muted">(never published)</small></label><input type="email" id="review_email" name="email" required autocomplete="email" placeholder="you@email.com"></div>\n' +
    "          </div>\n" +
    '          <div class="field"><label for="review_rating">Rating</label><select id="review_rating" name="rating" required><option value="">Select a rating</option><option value="5">★★★★★ (5: loved it)</option><option value="4">★★★★☆ (4: really good)</option><option value="3">★★★☆☆ (3: it\'s fine)</option><option value="2">★★☆☆☆ (2: not great)</option><option value="1">★☆☆☆☆ (1: disappointed)</option></select></div>\n' +
    '          <div class="field field-wide"><label for="review_text">Your review</label><textarea id="review_text" name="review" rows="4" required maxlength="1000" placeholder="How did it feel, smell, or hold up?"></textarea></div>\n' +
    '          <button class="btn btn-primary" type="submit">Submit review</button>\n' +
    "        </form>\n" +
    "      </div>\n" +
    "    </section>\n"
  );
}

function renderRelatedProductsHtml(p, products, categoryLabelMap, manifest) {
  const list = Array.isArray(products) ? products : [];
  const sameCat = list.filter(function (q) {
    return q && q.id !== p.id && q.category === p.category && q.id !== "yallternative-gift-card";
  });
  const others = list.filter(function (q) {
    return (
      q &&
      q.id !== p.id &&
      q.category !== p.category &&
      q.id !== "yallternative-gift-card" &&
      q.featured
    );
  });
  const picks = sameCat.concat(others).slice(0, 4);
  if (!picks.length) return "";
  const cards = picks
    .map(function (q) {
      const range = variantPriceRange(q);
      const priceText =
        range.low === range.high
          ? "$" + range.low.toFixed(2)
          : "$" + range.low.toFixed(2) + " &ndash; $" + range.high.toFixed(2);
      const catLabel = (categoryLabelMap && categoryLabelMap[q.category]) || q.category || "";
      const badge = q.comingSoon
        ? '<span class="stock-badge coming-soon">Coming Soon</span>'
        : isSoldOut(q)
          ? '<span class="stock-badge sold-out">Sold Out</span>'
          : "";
      return (
        '        <article class="card related-card" data-id="' +
        escapeHtml(q.id) +
        '">\n' +
        '          <a class="related-card-link" href="' +
        escapeHtml(q.id) +
        '.html">\n' +
        '            <div class="card-media">' +
        pictureFromManifest(q.image, manifest, {
          alt: q.name,
          width: 600,
          height: 510,
          loading: "lazy",
          sizes: "(max-width: 600px) 90vw, 25vw"
        }) +
        "</div>\n" +
        '            <div class="card-body">\n' +
        '              <span class="card-cat">' +
        escapeHtml(catLabel) +
        "</span>\n" +
        "              <h3>" +
        escapeHtml(q.name) +
        "</h3>\n" +
        '              <p class="price">' +
        priceText +
        "</p>\n" +
        (badge ? "              " + badge + "\n" : "") +
        "            </div>\n" +
        "          </a>\n" +
        "        </article>"
      );
    })
    .join("\n");
  return (
    '    <section class="pdp-related section-tight" aria-labelledby="pdpRelatedHeading">\n' +
    '      <div class="section-head">\n' +
    '        <h2 id="pdpRelatedHeading">You might also like</h2>\n' +
    "      </div>\n" +
    '      <div class="grid grid-4 related-grid">\n' +
    cards +
    "\n      </div>\n" +
    "    </section>\n"
  );
}

/**
 * Safety and sensitivities. Not a drug claim in sight: a patch-test reminder,
 * an essential-oil / nut caution where the ingredients call for one, external
 * use only, and a plain route to report a reaction -- MoCRA makes the maker
 * responsible for recording adverse events, and that only works if a shopper
 * can find where to tell her.
 */
const DEFAULT_SAFETY_NOTES = {
  externalUse:
    "For external use only. Keep away from eyes and broken skin, and keep out of reach of children.",
  patchTest:
    "New to it? Dab a little on your inner forearm and wait 24 hours before using it properly.",
  essentialOils:
    "Contains essential oils. If you are pregnant, nursing, or using it on a child, check with your doctor first.",
  nutAllergy:
    "Made with plant butters and oils that can include tree-nut-derived ingredients (see the full ingredient list above). Skip it if you have a nut allergy.",
  stopUse: "Stop using it if irritation or a rash develops.",
  reactionPrompt: "Had a reaction? Tell us and we will log it and make it right."
};

function resolveSafetyNotes(overrides) {
  const out = {};
  Object.keys(DEFAULT_SAFETY_NOTES).forEach(function (k) {
    const v = overrides && typeof overrides[k] === "string" ? overrides[k].trim() : "";
    out[k] = v || DEFAULT_SAFETY_NOTES[k];
  });
  return out;
}

function renderPdpSafetyHtml(p, safetyOverrides) {
  if (!p || p.id === "yallternative-gift-card") return "";
  const copy = resolveSafetyNotes(safetyOverrides);
  const ingredientsText =
    (Array.isArray(p.ingredients) ? p.ingredients.join(" ") : "") + " " + (p.ingredientsNote || "");
  const nameAndCat = p.name + " " + p.category;
  const isTopical =
    /salve|balm|butter|scrub|oil|soak|tea|spray|salt/i.test(nameAndCat) &&
    !/keychain|talisman|apparel|shirt|tank|gift/i.test(nameAndCat) &&
    p.ingredientsLabel !== "Materials";
  if (!isTopical) return "";
  // "No essential oils" must not trip the essential-oil caution: test the
  // ingredient list only, and let an explicit "free" statement win.
  const saysFree =
    /no (added )?essential oils|essential-oil-free|free (from|of) (added )?essential oils/i.test(
      ingredientsText +
        " " +
        (p.blurb || "") +
        " " +
        (Array.isArray(p.tags) ? p.tags.join(" ") : "")
    );
  const hasEssentialOils =
    !saysFree && /essential oil/i.test(Array.isArray(p.ingredients) ? p.ingredients.join(" ") : "");
  const hasNuts = /almond|nut|shea/i.test(ingredientsText);
  const notes = [];
  notes.push(escapeHtml(copy.externalUse));
  notes.push(escapeHtml(copy.patchTest));
  if (hasEssentialOils) notes.push(escapeHtml(copy.essentialOils));
  if (hasNuts) notes.push(escapeHtml(copy.nutAllergy));
  notes.push(escapeHtml(copy.stopUse));
  // Always visible (not an accordion): safety copy should never be a click away.
  return (
    '      <section class="pdp-safety" aria-labelledby="pdpSafetyHeading">\n' +
    '        <h3 id="pdpSafetyHeading" class="pdp-safety-title">Safety &amp; sensitivities</h3>\n' +
    '        <ul class="pdp-safety-list">\n' +
    notes
      .map(function (n) {
        return "          <li>" + n + "</li>";
      })
      .join("\n") +
    "\n        </ul>\n" +
    '        <p class="muted pdp-safety-foot"><small><a href="../safety.html">' +
    escapeHtml(copy.reactionPrompt) +
    "</a> Handmade self-care, not medicine: nothing here is meant to diagnose, treat, cure or prevent any condition.</small></p>\n" +
    "      </section>\n"
  );
}

function renderPdpGoodToKnowHtml(p, sizeLabel) {
  const rows = [];
  /* productSizeLabel() prefixes a multi-option list with "Sizes: " for the
     eyebrow line, where it stands on its own. In this table the term already
     names the row, so a plural list becomes "Sizes" and the prefix comes off
     -- the row used to read "Size: Sizes Single Soak · 3-Pack". */
  if (sizeLabel) {
    if (sizeLabel.indexOf("Sizes: ") === 0) {
      rows.push(["Sizes", sizeLabel.slice("Sizes: ".length)]);
    } else {
      rows.push(["Size", sizeLabel]);
    }
  }
  if (p.scent) rows.push(["Scent", p.scent]);
  if (Array.isArray(p.tags) && p.tags.length) {
    rows.push([
      "Good to know",
      p.tags
        .map(function (t) {
          return String(t)
            .replace(/-/g, " ")
            .replace(/^\w/, function (c) {
              return c.toUpperCase();
            });
        })
        .join(", ")
    ]);
  }
  if (p.category === "apparel") rows.push(["Designed in", "Landrum, South Carolina"]);
  else if (p.id !== "yallternative-gift-card" && p.category !== "gift-cards") {
    rows.push(["Made in", "Landrum, South Carolina, in small batches"]);
  }
  return (
    '      <dl class="pdp-facts">\n' +
    rows
      .map(function (r) {
        return (
          "        <div><dt>" + escapeHtml(r[0]) + "</dt><dd>" + escapeHtml(r[1]) + "</dd></div>"
        );
      })
      .join("\n") +
    "\n      </dl>\n"
  );
}

/* ---------- Tawk.to live chat, for the generated product pages ----------
   The deferred chat loader shipped on the 16 hand-written pages and on none
   of the 20 PDPs -- which are exactly the pages where a shopper has a
   question worth asking ("will this work on eczema", "is there almond oil in
   it", "what does the 4oz cost"). It also made the privacy policy's "live on
   nearly every page" claim untrue at 16 of 37 (audit C, findings L3 and M9).

   This is the same snippet those pages carry: same deferred first-interaction
   trigger, same CMS-owned id markers, so build-security-headers.js hashes it
   into the CSP exactly as it does theirs. Keep the two byte-identical -- two
   spellings of the same script mean two hashes to read and approve.

   Emitted with EMPTY ids if the build somehow has no site config, in which
   case the loader's own guard bails before it requests anything. */
function renderTawkChatHtml(site) {
  const s = site || {};
  return (
    "<!-- Live chat (Tawk.to) -- placeholder, inert until real IDs are set.\n" +
    "     Free live-chat widget: https://www.tawk.to -- see DEVELOPMENT.md section 19.\n" +
    "     Replace YOUR_TAWKTO_PROPERTY_ID/YOUR_TAWKTO_WIDGET_ID below with the\n" +
    "     real embed values from your own Tawk.to dashboard (Administration ->\n" +
    "     Chat Widget). Until then this script 404s quietly and no widget\n" +
    "     appears -- nothing is broken by leaving it as-is. -->\n" +
    '<script type="text/javascript">\n' +
    "var Tawk_API = Tawk_API || {}, Tawk_LoadStart = new Date();\n" +
    "(function () {\n" +
    "  /* Both IDs are injected from content.json by scripts/build-site-data.js.\n" +
    '     Until Savanna sets real ones, they\'re still the "YOUR_..." placeholders --\n' +
    "     in that state this used to build a live embed.tawk.to URL out of them and\n" +
    "     request it on every single page load, which 404s and buys nothing. Bail\n" +
    "     out instead, so the widget stays genuinely inert until it's configured. */\n" +
    "  var propertyId = /*YL:site.tawkToPropertyId*/ " +
    jsStringLiteral(s.tawkToPropertyId || "") +
    " /*/YL:site.tawkToPropertyId*/;\n" +
    "  var widgetId = /*YL:site.tawkToWidgetId*/ " +
    jsStringLiteral(s.tawkToWidgetId || "") +
    " /*/YL:site.tawkToWidgetId*/;\n" +
    "  if (!propertyId || !widgetId) return;\n" +
    '  if (propertyId.indexOf("YOUR_") === 0 || widgetId.indexOf("YOUR_") === 0) return;\n' +
    "  /* The widget SDK used to be requested on EVERY pageview -- 20 requests to\n" +
    "     embed.tawk.to plus a wss://*.tawk.to handshake, measured on a cold mobile\n" +
    "     load -- for the large majority of sessions that never open chat. Hold it\n" +
    "     until the visitor does something (scroll, tap, key). There is deliberately\n" +
    "     no idle-timeout fallback: the widget's iframe landing with no user input\n" +
    "     counted as a 0.047 layout shift on every page in the 2026-09-02\n" +
    "     measurement, and a shopper who wants chat will have scrolled first. */\n" +
    "  var loaded = false;\n" +
    '  var TRIGGERS = ["pointerdown", "keydown", "scroll", "touchstart"];\n' +
    "  var opts = { passive: true, capture: true };\n" +
    "  function load() {\n" +
    "    if (loaded) return;\n" +
    "    loaded = true;\n" +
    "    TRIGGERS.forEach(function (t) { window.removeEventListener(t, load, opts); });\n" +
    '    var s1 = document.createElement("script"), s0 = document.getElementsByTagName("script")[0];\n' +
    "    s1.async = true;\n" +
    '    s1.src = "https://embed.tawk.to/" + propertyId + "/" + widgetId;\n' +
    '    s1.charset = "UTF-8";\n' +
    "    s0.parentNode.insertBefore(s1, s0);\n" +
    "  }\n" +
    "  TRIGGERS.forEach(function (t) { window.addEventListener(t, load, opts); });\n" +
    "})();\n" +
    "</script>\n"
  );
}

function renderSiteHeaderHtml(manifest) {
  const m = manifest || {};
  return (
    '  <header class="site-header">\n' +
    '    <nav class="nav" aria-label="Main Navigation">\n' +
    /* The apostrophe is written as &#39; on purpose. Netlify's deploy-time
       HTML post-processing used to re-serialise every attribute with SINGLE
       quotes, and a raw apostrophe then closed the attribute early: the
       accessible name of the site's primary home link became the single
       letter "Y" on all 36 pages (audit C, finding C1). That processing is
       switched off now (netlify.toml [build.processing]), but the entity
       survives ANY serializer, so the source cannot be broken that way
       again. The decoded label is identical: "Y'allternative Living home".
       Keep the entity when editing, and use it for any future attribute
       that carries the brand name. */
    '      <a class="brand" href="/index.html" aria-label="Y&#39;allternative Living home">\n' +
    "        " +
    logoPictureHtml("assets/img/logo.png", m, "desktop") +
    "\n" +
    "        " +
    logoPictureHtml("assets/img/logo.png", m, "mobile") +
    "\n" +
    '        <span class="brand-word">Y\'allternative<small>Living</small></span>\n' +
    "      </a>\n" +
    '      <ul class="nav-links" id="navLinks">\n' +
    '        <li><a href="/index.html">Home</a></li>\n' +
    '        <li><a href="/shop.html" class="active">Shop</a></li>\n' +
    '        <li><a href="/events.html">Events</a></li>\n' +
    '        <li><a href="/about.html">Our Story</a></li>\n' +
    '        <li><a href="/contact.html">Contact</a></li>\n' +
    "      </ul>\n" +
    '      <div class="nav-cta">\n' +
    '        <button class="nav-search-btn" id="globalSearchTrigger" type="button" aria-label="Search catalog, articles &amp; FAQ" title="Search (Cmd+K)" aria-haspopup="dialog" aria-expanded="false" aria-controls="global-search-modal">\n' +
    '          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-search" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>\n' +
    "        </button>\n" +
    '        <button class="cart-toggle" type="button" aria-label="View your cart">\n' +
    '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-cart" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>\n' +
    '          <span class="badge cart-count" aria-live="polite"></span>\n' +
    "        </button>\n" +
    '        <button type="button" class="theme-toggle" id="themeToggle" role="switch" aria-checked="false" aria-label="Toggle dark and light mode">\n' +
    '          <span class="knob" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg></span>\n' +
    "        </button>\n" +
    '        <button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="navLinks">\n' +
    '          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-menu" aria-hidden="true"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>\n' +
    "        </button>\n" +
    "      </div>\n" +
    "    </nav>\n" +
    "  </header>\n"
  );
}

function renderRestockModalHtml() {
  return (
    '  <dialog id="restock-alert-modal" class="restock-alert-modal gift-modal" role="dialog" aria-modal="true" aria-labelledby="restockModalTitle">\n' +
    '    <button type="button" class="gift-modal-close" id="closeRestockModalBtn" data-action="close-restock-modal" aria-label="Close dialog">&times;</button>\n' +
    '    <div class="gift-modal-header">\n' +
    '      <h2 id="restockModalTitle">Restock &amp; Launch Alert</h2>\n' +
    '      <p class="muted" id="restockModalSubtitle">Get an email as soon as this item is back in stock or ready to ship.</p>\n' +
    "    </div>\n" +
    '    <div id="restockModalProductInfo" class="restock-product-preview">\n' +
    /* No src attribute at all until main.js fills one in. An empty src is
       invalid HTML and, per the URL spec, resolves to the document itself --
       which is why this image reported naturalWidth 0 with currentSrc equal to
       the page URL. Chrome issues no extra request for it, but Safari has
       historically re-fetched the document for this pattern (live audit
       2026-09-02, N-1). */
    '      <img id="restockProductImg" alt="" width="56" height="56" hidden>\n' +
    "      <div>\n" +
    '        <h3 id="restockProductName">Product Name</h3>\n' +
    '        <span id="restockProductBadge" class="stock-badge coming-soon">Coming Soon</span>\n' +
    "      </div>\n" +
    "    </div>\n" +
    '    <form id="restockAlertForm" class="restock-alert-form" novalidate>\n' +
    '      <div class="form-hp" aria-hidden="true">\n' +
    '        <label for="restock-hp-field">Leave this field blank</label>\n' +
    '        <input type="text" id="restock-hp-field" name="website_hp" tabindex="-1" autocomplete="off">\n' +
    "      </div>\n" +
    '      <input type="hidden" id="restockProductId" name="product_id" value="">\n' +
    '      <input type="hidden" id="restockProductNameInput" name="product_name" value="">\n' +
    '      <div class="field">\n' +
    '        <label for="restock-email-input">Email address <span class="req">*</span></label>\n' +
    '        <input type="email" id="restock-email-input" name="email" placeholder="you@example.com" autocomplete="email" required>\n' +
    '        <span class="field-error" id="restockEmailError" aria-live="assertive" hidden></span>\n' +
    "      </div>\n" +
    '      <button type="submit" id="restockSubmitBtn" class="btn btn-primary btn-block"><span>Notify me</span></button>\n' +
    "    </form>\n" +
    '    <div id="restockSuccessMessage" class="restock-success-state" aria-live="polite" hidden>\n' +
    "      <p><strong>You&rsquo;re on the list.</strong></p>\n" +
    '      <p class="muted">We\'ll drop an email in your inbox the second this batch lands.</p>\n' +
    '      <button type="button" class="btn btn-outline btn-sm" id="restockDoneBtn">Close</button>\n' +
    "    </div>\n" +
    "  </dialog>\n"
  );
}

function renderGlobalSearchModalHtml(searchConfig) {
  const search = searchConfig || getSearchConfig(null);
  return (
    '  <dialog id="global-search-modal" class="global-search-modal gift-modal" aria-labelledby="globalSearchModalTitle" aria-modal="true">\n' +
    '    <div class="global-search-container" role="document">\n' +
    '      <div class="global-search-header">\n' +
    '        <div class="global-search-input-wrapper">\n' +
    '          <svg class="global-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>\n' +
    '          <label for="globalSearchInput" id="globalSearchModalTitle" class="sr-only">Search catalog, articles &amp; FAQ</label>\n' +
    /* aria-haspopup="grid" (not the default listbox): each suggestion row
       carries a link and, for products, an "+ Add" button, and the APG's
       listbox pattern explicitly cannot host interactive content -- see the
       setResultsGridRole() comment in assets/js/main.js (audit C, H5). */
    '          <input type="search" id="globalSearchInput" class="global-search-input" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-haspopup="grid" aria-controls="globalSearchResultsList" aria-activedescendant="" placeholder="Search salves, soaks, events, FAQ… (Cmd+K)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">\n' +
    '          <button type="button" class="global-search-clear-btn" id="globalSearchClearBtn" aria-label="Clear search query" hidden>\n' +
    '            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>\n' +
    "          </button>\n" +
    "        </div>\n" +
    '        <button type="button" class="modal-close global-search-close-btn" id="globalSearchCloseBtn" aria-label="Close search dialog">&times;</button>\n' +
    "      </div>\n" +
    '      <div id="globalSearchResultCount" class="sr-only" aria-live="polite" aria-atomic="true"></div>\n' +
    '      <div class="global-search-chips-section" id="globalSearchChipsSection">\n' +
    '        <p class="global-search-chips-title" id="globalSearchChipsLabel">' +
    escapeHtml(search.chipsTitle) +
    "</p>\n" +
    '        <div class="global-search-chips-list" role="group" aria-labelledby="globalSearchChipsLabel">\n' +
    renderSearchChipsHtml(search.popularChips, "          ") +
    "\n        </div>\n" +
    "      </div>\n" +
    '      <div class="global-search-results-wrapper" id="globalSearchResultsWrapper">\n' +
    /* No role and no aria-label in the static markup on purpose: main.js
       adds role="grid" AND the label together, only while this actually
       holds result rows, and removes both for the empty and zero-result
       states. That way the container is never a grid (or a listbox) with
       structurally invalid children, and never a bare <div> carrying an
       aria-label ARIA 1.2 prohibits on the generic role (audit C, M7). */
    '        <div id="globalSearchResultsList" class="global-search-results-list" tabindex="-1"></div>\n' +
    "      </div>\n" +
    '      <div class="global-search-footer">\n' +
    '        <span class="search-key-hint"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>\n' +
    '        <span class="search-key-hint"><kbd>↵</kbd> Select</span>\n' +
    '        <span class="search-key-hint"><kbd>ESC</kbd> Close</span>\n' +
    "      </div>\n" +
    "    </div>\n" +
    "  </dialog>\n"
  );
}

/**
 * @param {Object} product
 * @param {string} domain
 * @param {string} categoryLabel
 * @param {Object} productsById
 * @param {Object} categoryLabelMap
 * @param {Object} [ritualDefaults] CMS fallback headline/subtitle for the ritual section
 * @param {Object} [ctx] build context: { manifest, footerInner, reviews, products, shop }
 *   Optional so the unit tests can call this with the original arguments.
 */
function renderProductPdpHtml(
  product,
  domain,
  categoryLabel,
  productsById,
  categoryLabelMap,
  ritualDefaults,
  ctx
) {
  const c = ctx || {};
  const manifest = c.manifest || {};
  const shop = c.shop || {};
  const pTitle = escapeHtml(pdpPageTitle(product.name));
  const rawDesc = product.description || product.blurb || "";
  const pDesc = escapeHtml(rawDesc);
  const pMetaDesc = escapeHtml(truncateForMeta(rawDesc, 155));
  const pUrl = domain + "/products/" + product.id + ".html";
  /* og:/twitter: images are raster-only -- see rasterImagePath(). For the 15
     products with real photos this is the photo, unchanged. */
  const pImage = escapeHtml(domain + "/" + rasterImagePath(product.image, "social"));
  const catLabel = escapeHtml(categoryLabel || product.category || "Apothecary");
  const range = variantPriceRange(product);
  // The headline used to show "$13.99 - $19.99" while the $19.99 size was
  // already selected. Show the pre-selected option's price (the first one not
  // sold out, which is what the radio group checks); the range lives in the
  // AggregateOffer JSON-LD, and the radios update this number on change.
  let selectedPrice = range.low;
  if (product.variants && Array.isArray(product.variants.options)) {
    const firstOpen = product.variants.options.find(function (o) {
      return o && !o.soldOut;
    });
    if (firstOpen) selectedPrice = product.price + (Number(firstOpen.priceDelta) || 0);
  }
  /* .pdp-price-value replaces the old itemprop="price" span: main.js's
     variant picker rewrites this number on every size change and needs a
     hook, but it must not be a second schema.org entity (finding L5). */
  const priceDisplayHtml = '$<span class="pdp-price-value">' + selectedPrice.toFixed(2) + "</span>";

  const pdpAvailability = schemaAvailability(product);
  const pdpOgAvailability =
    pdpAvailability === "https://schema.org/PreOrder"
      ? "preorder"
      : pdpAvailability === "https://schema.org/OutOfStock"
        ? "out of stock"
        : "in stock";

  const sizeLabel = productSizeLabel(product);
  const productReviews = (c.reviews || []).filter(function (r) {
    return r && r.productId === product.id;
  });
  const reviewCount = productReviews.length;
  const reviewAvg = reviewCount
    ? productReviews.reduce(function (s, r) {
        return s + Number(r.rating || 0);
      }, 0) / reviewCount
    : 0;

  const productJsonLd = generateProductJsonLd(product, domain, categoryLabel);
  const breadcrumbJsonLd = generateProductBreadcrumbJsonLd(product, domain, categoryLabel);
  const jsonLdBlock =
    '  <script type="application/ld+json">\n' +
    JSON.stringify(productJsonLd, null, 2).replace(/<\//g, "<\\/") +
    "\n  </script>\n" +
    '  <script type="application/ld+json">\n' +
    JSON.stringify(breadcrumbJsonLd, null, 2).replace(/<\//g, "<\\/") +
    "\n  </script>\n";

  const stockBadge = product.comingSoon
    ? '        <span class="stock-badge coming-soon">Coming Soon</span>\n'
    : isSoldOut(product)
      ? '        <span class="stock-badge sold-out">Sold Out</span>\n'
      : typeof product.stock === "number" && product.stock > 0 && product.stock <= 5
        ? '        <span class="stock-badge low-stock">Only ' +
          product.stock +
          " left in this batch</span>\n"
        : "";

  const ratingSummary =
    reviewCount && !product.comingSoon
      ? '        <a class="pdp-rating-summary" href="#pdpReviews"><span class="stars" aria-hidden="true">' +
        starsHtml(reviewAvg) +
        "</span> " +
        reviewAvg.toFixed(1) +
        " &middot; " +
        reviewCount +
        (reviewCount === 1 ? " review" : " reviews") +
        "</a>\n"
      : "";

  const freshnessBadgeHtml = renderFreshnessBadgeHtml(product);
  const scentProfileHtml = renderScentProfileHtml(product);
  const usageAccordionsHtml = renderUsageAccordionsHtml(product);
  const ritualSectionHtml = renderRitualSectionHtml(
    product,
    productsById,
    categoryLabelMap,
    ritualDefaults,
    manifest
  );
  const batchDateHtml =
    product.comingSoon && product.estimatedBatchDate
      ? '        <div class="pdp-batch-date"><svg class="yl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Estimated Batch Date: <strong>' +
        escapeHtml(product.estimatedBatchDate) +
        "</strong></div>\n"
      : "";
  const stickyBarHtml = renderStickyBarHtml(product, categoryLabel, manifest);

  let ingredientsHtml = "";
  if (Array.isArray(product.ingredients) && product.ingredients.length) {
    const ingLabel = escapeHtml(product.ingredientsLabel || "Ingredients");
    ingredientsHtml =
      '      <div class="pdp-ingredients-block">\n' +
      '        <h2 class="pdp-section-title">' +
      ingLabel +
      "</h2>\n" +
      (ingLabel === "Materials"
        ? ""
        : '        <p class="muted pdp-ingredients-lead"><small>Listed in descending order of predominance, the way they appear on the label.</small></p>\n') +
      '        <ul class="pdp-ingredients-list">\n' +
      product.ingredients
        .map(function (ing) {
          return "          <li>" + escapeHtml(ing) + "</li>";
        })
        .join("\n") +
      "\n        </ul>\n" +
      (product.ingredientsNote
        ? '        <p class="pdp-ingredients-note"><small>Note: ' +
          escapeHtml(product.ingredientsNote) +
          "</small></p>\n"
        : "") +
      "      </div>\n";
  }

  const footerHtml = c.footerInner
    ? '  <footer class="site-footer">\n' + c.footerInner + "\n  </footer>\n"
    : "";

  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <meta name="mobile-web-app-capable" content="yes">\n' +
    '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
    '  <meta name="apple-mobile-web-app-title" content="Y\'allternative">\n' +
    '  <meta name="color-scheme" content="dark light">\n' +
    '  <meta name="view-transition" content="same-origin">\n' +
    "  <title>" +
    pTitle +
    "</title>\n" +
    '  <meta name="description" content="' +
    pMetaDesc +
    '">\n' +
    '  <link rel="canonical" href="' +
    pUrl +
    '">\n' +
    (umamiPreconnectHtml(ctx && ctx.site)
      ? "  " + umamiPreconnectHtml(ctx && ctx.site) + "\n"
      : "") +
    /* The tracker tag belongs HERE, in <head>, and not at the end of <body>
       where it used to sit. Deferred scripts run in document order, so a tag
       after main.js meant window.umami did not exist yet when the PDP fired its
       "Product View" event -- the adapter swallowed it and every one of the 20
       product pages reported a bare pageview and nothing else (measured
       2026-09-02). Head placement matches the hand-written pages, so the two
       templates behave identically. main.js also buffers events now, so this
       is belt and braces rather than the only thing holding it up. */
    (umamiScriptHtml(ctx && ctx.site) ? "  " + umamiScriptHtml(ctx && ctx.site) + "\n" : "") +
    '  <link rel="icon" href="/assets/img/favicon-32.png" sizes="32x32" type="image/png">\n' +
    '  <link rel="icon" href="/assets/img/favicon-192.png" sizes="192x192" type="image/png">\n' +
    '  <link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">\n' +
    '  <link rel="manifest" href="/site.webmanifest">\n' +
    '  <meta name="theme-color" content="#c65a6d">\n' +
    "  <!-- OpenGraph -->\n" +
    '  <meta property="og:type" content="product">\n' +
    '  <meta property="og:title" content="' +
    pTitle +
    '">\n' +
    '  <meta property="og:description" content="' +
    pMetaDesc +
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
    pMetaDesc +
    '">\n' +
    '  <meta name="twitter:image" content="' +
    pImage +
    '">\n' +
    "  <!-- E-commerce OG -->\n" +
    '  <meta property="product:price:amount" content="' +
    range.low.toFixed(2) +
    '">\n' +
    '  <meta property="product:price:currency" content="USD">\n' +
    '  <meta property="product:availability" content="' +
    pdpOgAvailability +
    '">\n' +
    preloadFromManifest(product.image, manifest, "(max-width: 820px) 100vw, 50vw") +
    "  <!-- Gloock + DM Sans are self-hosted from /assets/fonts/ via the @font-face rules at the end of styles.css; no font <link> or preload here (see index.html). -->\n" +
    '  <link rel="stylesheet" href="/assets/css/styles.css?v=2.0">\n' +
    '  <link rel="stylesheet" href="/assets/css/cart.css">\n' +
    "  <script>\n" +
    "  // No-flash theme init: runs before paint, before main.js.\n" +
    "  (function(){\n" +
    "    var t = localStorage.getItem('yl-theme');\n" +
    "    if(!t){ t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }\n" +
    "    document.documentElement.setAttribute('data-theme', t);\n" +
    "  })();\n" +
    "</script>\n" +
    jsonLdBlock +
    "</head>\n" +
    '<body class="pdp-page">\n' +
    '  <a href="#main-content" class="skip-link">Skip to main content</a>\n' +
    renderSiteHeaderHtml(manifest) +
    '  <main id="main-content" class="container pdp-container">\n' +
    '    <nav class="breadcrumb-nav" aria-label="Breadcrumb">\n' +
    '      <p class="breadcrumb"><a href="../index.html">Home</a> / <a href="../shop.html">Shop</a> / <a href="../shop.html#' +
    escapeHtml(product.category || "apothecary") +
    '">' +
    catLabel +
    '</a> / <span aria-current="page">' +
    escapeHtml(product.name) +
    "</span></p>\n" +
    "    </nav>\n" +
    /* No itemscope/itemprop anywhere in this page any more. Every PDP used
       to carry TWO Product entities: the complete JSON-LD one in <head> and
       a thin microdata one here with only name, image, description and a
       flat price -- no availability, no url, no brand, no sku. Rich Results
       Test reported both, and on frankincense-salve the microdata asserted a
       single price while the JSON-LD (correctly) declared an AggregateOffer
       of $13.99-$19.99 (audit C, finding L5). One vocabulary, and JSON-LD is
       the better one. */
    '    <article class="pdp-layout">\n' +
    renderPdpGalleryHtml(product, manifest) +
    '      <div class="pdp-details">\n' +
    '        <p class="pdp-eyebrow"><span class="eyebrow">' +
    catLabel +
    "</span>" +
    (sizeLabel ? ' <span class="pdp-size-label">' + escapeHtml(sizeLabel) + "</span>" : "") +
    "</p>\n" +
    '        <h1 class="pdp-title">' +
    escapeHtml(product.name) +
    "</h1>\n" +
    ratingSummary +
    '        <div class="pdp-price-row">\n' +
    '          <span class="price pdp-price">\n' +
    "            " +
    priceDisplayHtml +
    "\n" +
    "          </span>\n" +
    (product.originalPrice
      ? '          <span class="original-price">$' + product.originalPrice.toFixed(2) + "</span>\n"
      : "") +
    "        </div>\n" +
    stockBadge +
    batchDateHtml +
    '        <div class="pdp-dispatch" id="pdpDispatch"></div>\n' +
    '        <p class="pdp-blurb">' +
    pDesc +
    "</p>\n" +
    (product.comingSoon ? "" : renderVariantControlHtml(product)) +
    renderPdpPurchaseHtml(product, categoryLabel) +
    renderPdpTrustHtml(product, shop) +
    renderEtsyProofHtml(shop) +
    "      </div>\n" +
    "    </article>\n" +
    '    <section class="pdp-info" aria-label="Product details">\n' +
    '      <div class="pdp-info-main">\n' +
    freshnessBadgeHtml +
    scentProfileHtml +
    ingredientsHtml +
    usageAccordionsHtml +
    renderPdpSafetyHtml(product, ctx && ctx.safetyNotes) +
    "      </div>\n" +
    /* A complementary landmark with no accessible name is just "complementary"
       in a screen reader's landmark list, on every one of the 20 PDPs (audit
       C, nit N7). The aside holds the product facts list, so name it that. */
    '      <aside class="pdp-info-side" aria-label="Product facts at a glance">\n' +
    renderPdpGoodToKnowHtml(product, sizeLabel) +
    "      </aside>\n" +
    "    </section>\n" +
    ritualSectionHtml +
    renderPdpReviewsHtml(product, c.reviews, { suppressSummary: !!product.comingSoon }) +
    renderRelatedProductsHtml(product, c.products, categoryLabelMap, manifest) +
    '    <section class="section-tight recently-viewed-section" id="pdpRecentlyViewedSection" aria-labelledby="pdpRecentlyViewedHeading" hidden>\n' +
    '      <div class="section-head">\n' +
    '        <h2 id="pdpRecentlyViewedHeading">Recently Viewed</h2>\n' +
    "      </div>\n" +
    '      <div class="recently-viewed-track" id="recentlyViewedTrack" role="region" aria-label="Recently viewed products" tabindex="0"></div>\n' +
    "    </section>\n" +
    stickyBarHtml +
    "  </main>\n" +
    renderGlobalSearchModalHtml(ctx && ctx.search) +
    renderRestockModalHtml() +
    footerHtml +
    '  <script src="/assets/js/content-data.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/products-data.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/events-data.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/search-data.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/image-manifest.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/site-reviews-data.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/main.js?v=2.0" defer></script>\n' +
    '  <script src="/assets/js/cart.js" defer></script>\n' +
    /* Live chat, same deferred loader the hand-written pages carry. It was
       missing from all 20 PDPs -- the pages where a shopper actually has a
       question (audit C, finding L3). */
    renderTawkChatHtml(ctx && ctx.site) +
    "</body>\n" +
    "</html>\n"
  );
}

/* XML 1.0 forbids most C0 control characters outright -- escapeHtml() lets
   them through untouched, and a single U+000B in a CMS-written excerpt made
   the whole feed unparseable (Low finding in the audit). Tab, LF and CR are
   the only legal ones. */
function stripXmlControlChars(text) {
  return String(text == null ? "" : text).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,
    ""
  );
}

function xmlText(value) {
  return stripXmlControlChars(escapeHtml(value));
}

/* options.includeItems -- false while the Journal is switched off in /admin,
   so unpublished posts are not syndicated from a page that is noindexed and
   unlinked. The channel itself keeps existing so subscribers do not 404. */
function generateRssFeed(journalData, domainUrl, options) {
  const DOMAIN_URL = domainUrl || "https://yallternativeliving.com";
  const opts = options || {};
  const allPosts = Array.isArray(journalData)
    ? journalData
    : (journalData && journalData.posts) || [];
  const journalPosts = opts.includeItems === false ? [] : allPosts;
  /* lastBuildDate used to be the wall clock, which made feed.xml differ on
   every single build and put the whole repository permanently out of sync
   with what the build produces (H-20). The newest post's own date is the
   only thing about this feed that actually changes when content changes. */
  let newestPostDate = null;
  allPosts.forEach(function (post) {
    if (!post || !post.date) return;
    const d = new Date(post.date);
    if (isNaN(d.getTime())) return;
    if (!newestPostDate || d > newestPostDate) newestPostDate = d;
  });
  const rssLastBuildDate = newestPostDate
    ? newestPostDate.toUTCString()
    : new Date(0).toUTCString();
  const rssItems = journalPosts
    .filter(Boolean)
    .map(function (post) {
      if (!post) return "";
      const postDate = post.date ? new Date(post.date).toUTCString() : new Date().toUTCString();
      const slug = post.id || post.slug || "";
      const postUrl = xmlText(DOMAIN_URL + "/journal.html#post-" + encodeURIComponent(slug));
      const title = xmlText(post.title || "Journal Entry");
      const excerpt = xmlText(post.excerpt || post.summary || "");
      const categoriesXml = Array.isArray(post.tags)
        ? post.tags
            .filter(Boolean)
            .map(function (t) {
              return "      <category>" + xmlText(t) + "</category>";
            })
            .join("\n")
        : "";

      return (
        "    <item>\n" +
        "      <title>" +
        title +
        "</title>\n" +
        "      <link>" +
        postUrl +
        "</link>\n" +
        '      <guid isPermaLink="true">' +
        postUrl +
        "</guid>\n" +
        "      <pubDate>" +
        postDate +
        "</pubDate>\n" +
        (categoriesXml ? categoriesXml + "\n" : "") +
        "      <description>" +
        excerpt +
        "</description>\n" +
        "    </item>"
      );
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "  <channel>\n" +
    "    <title>Apothecary Journal | Y'allternative Living</title>\n" +
    "    <link>" +
    DOMAIN_URL +
    "/journal.html</link>\n" +
    "    <description>Small-batch apothecary updates, herbal science, and market stories from Landrum, SC.</description>\n" +
    "    <language>en-us</language>\n" +
    "    <lastBuildDate>" +
    rssLastBuildDate +
    "</lastBuildDate>\n" +
    '    <atom:link href="' +
    DOMAIN_URL +
    '/feed.xml" rel="self" type="application/rss+xml"/>\n' +
    (rssItems ? rssItems + "\n" : "") +
    "  </channel>\n" +
    "</rss>\n"
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    loadJournal,
    listJournalFiles,
    SEARCH_CHIP_ICONS: SEARCH_CHIP_ICONS,
    DEFAULT_SEARCH_CHIPS: DEFAULT_SEARCH_CHIPS,
    getSearchConfig: getSearchConfig,
    renderSearchChipsHtml: renderSearchChipsHtml,
    buildSearchSynonyms: buildSearchSynonyms,
    resolveSafetyNotes: resolveSafetyNotes,
    readJson: readJson,
    readText: readText,
    writeFile: writeFile,
    escapeHtml: escapeHtml,
    escapeJsonForScript: escapeJsonForScript,
    jsStringLiteral: jsStringLiteral,
    jsonLdScriptBlock: jsonLdScriptBlock,
    clampRating: clampRating,
    truncateForMeta: truncateForMeta,
    schemaAvailability: schemaAvailability,
    stripXmlControlChars: stripXmlControlChars,
    validateSiteIds: validateSiteIds,
    renderFaqAnswerHtml: renderFaqAnswerHtml,
    safeLinkUrl: safeLinkUrl,
    safeUrl: safeUrl,
    slugify: slugify,
    generateUniqueId: generateUniqueId,
    bundlePricing: bundlePricing,
    variantPriceRange: variantPriceRange,
    stripMarkersInsideAttributes: stripMarkersInsideAttributes,
    formspreeAction: formspreeAction,
    newsletterAction: newsletterAction,
    setFormAction: setFormAction,
    generateRssFeed: generateRssFeed,
    generateProductJsonLd: generateProductJsonLd,
    generateProductBreadcrumbJsonLd: generateProductBreadcrumbJsonLd,
    renderFreshnessBadgeHtml: renderFreshnessBadgeHtml,
    renderScentProfileHtml: renderScentProfileHtml,
    renderUsageAccordionsHtml: renderUsageAccordionsHtml,
    validatePairsWith: validatePairsWith,
    validateQuizData: validateQuizData,
    renderSocialRowHtml: renderSocialRowHtml,
    getActiveSocialUrls: getActiveSocialUrls,
    renderRitualSectionHtml: renderRitualSectionHtml,
    renderStickyBarHtml: renderStickyBarHtml,
    renderProductPdpHtml: renderProductPdpHtml,
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    validateLocalesAndGlossary: validateLocalesAndGlossary,
    validateDictionaryCoverage: validateDictionaryCoverage,
    IDENTICAL_BY_DESIGN: IDENTICAL_BY_DESIGN,
    decodeHtmlEntities: decodeHtmlEntities,
    buildSiteData: buildSiteData
  };
}

if (require.main === module) {
  buildSiteData();
}
