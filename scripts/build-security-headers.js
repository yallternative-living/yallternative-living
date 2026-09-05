#!/usr/bin/env node
"use strict";

/* ==========================================================
   Y'ALLTERNATIVE LIVING -- security headers generator
   ----------------------------------------------------------
   This is a static site: response headers (CSP, HSTS, etc.) can't be
   set from HTML alone -- they have to come from whatever actually
   serves the files. So instead of a single universal fix, this script
   writes all three static-host header config formats this repo ships:

     _headers      -- Netlify / Cloudflare Pages format
     vercel.json   -- Vercel format
     netlify.toml  -- Netlify format (Netlify actually honors BOTH this
                      and _headers for overlapping paths, which used to
                      mean two hand-maintained files could silently say
                      two different things -- generating both from the
                      same csp/otherHeaders below makes that impossible)

   Deploying to something else (GitHub Pages, S3+CloudFront, a plain
   nginx box, etc.)? Those headers need to be set in that host's own
   config instead -- the CSP string below is still the one to use,
   just copy it into whatever your host calls its headers config.

   Why a script instead of hand-written files: the CSP's script-src
   allows the site's inline <script> blocks (currently just the
   no-flash theme-init snippet) by SHA-256 hash rather than the much
   looser 'unsafe-inline' -- because 'unsafe-inline' defeats most of
   what CSP is actually for. That means every time an inline script's
   *exact text* changes, its hash changes too, and this needs to be
   re-run:

     node scripts/build-security-headers.js

   It reads every inline <script> out of every page this site ships --
   all the top-level HTML files plus every generated products/*.html --
   hashes them, and rewrites _headers + vercel.json + netlify.toml to
   match. Safe to run any time; it doesn't touch products, images, or
   anything else.

   IMPORTANT -- what the hash set is checked against:
   This script used to hash whatever it found and emit it, which meant a
   CSP that certified its own input. Anything that reached an inline
   script -- including a value typed into the CMS at /admin and
   interpolated into the Tawk.to snippet by build-site-data.js -- was
   automatically allowlisted on the next deploy, so the policy could
   never block it (audit findings C-4 and H-13). Every hash is now
   checked against the committed baseline in
   scripts/inline-script-hashes.json and an unrecognised one FAILS the
   build. That is a deliberate speed bump: when you legitimately change
   an inline script, read the diff, satisfy yourself it is yours, and
   add the new hash to that file in the same commit.
   ========================================================== */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
/* The first-party analytics paths, shared with build-site-data.js (which puts
   them on the tracker tag). The proxy rules emitted from them are what make
   those paths resolve; see scripts/lib/analytics-proxy.js for why they exist
   and why they are named the way they are. */
var analyticsProxy = require("./lib/analytics-proxy");

var ROOT = path.join(__dirname, "..");

/* The Cloudflare Worker that answers the whole money path, and the same-origin
   prefix the browser actually calls.

   This used to be a single rule for /api/checkout. The Worker now also answers
   /api/gift-card-balance, /api/stripe-webhook, /api/order-status and
   /api/restock (workers/checkout.js routes them), so the proxy is a wildcard
   and forwards the matched remainder with Netlify's `:splat`.

   NOTE FOR THE WORKER: `:splat` is the part that matched `*`, so
   /api/gift-card-balance arrives at the Worker as /gift-card-balance -- the
   /api prefix is NOT forwarded. workers/checkout.js's routeOf() accepts both
   spellings for exactly this reason. Change one, re-read the other.

   API_PREFIX must stay consistent with CHECKOUT_URL in assets/js/cart.js: a
   silent mismatch breaks checkout with no visible error until someone tries to
   pay. */
var API_PREFIX = "/api";
var CHECKOUT_PATH = API_PREFIX + "/checkout";
var API_PROXY_FROM = API_PREFIX + "/*";
var CHECKOUT_WORKER_URL = "https://yallternative-checkout.y-allternative-living.workers.dev";
var API_PROXY_TO = CHECKOUT_WORKER_URL + "/:splat";

/* The Netlify Functions that used to live under /.netlify/functions/ are
   deleted; their code moved into the Worker (audit C-1 deleted redeem-points
   outright). Netlify reserves that path prefix and rejects redirect rules on
   it, so nothing is emitted for the old URLs -- a deleted function answers
   404 on its own. See docs/STATE-LAYER.md for the route each one became. */
var BASELINE_PATH = path.join(__dirname, "inline-script-hashes.json");

/* Paths that must never be served: this repository is the publish root
   (`publish = "."`), so without these every build script, audit document,
   Worker source and lockfile in the tree is a public URL on the live
   domain. Netlify matches redirects in order and the checkout proxy is
   emitted after these, which is fine -- none of these patterns match
   /api/checkout. /admin/* is deliberately absent: the CMS is served. */
var BLOCKED_PATHS = [
  "/scripts/*",
  "/docs/*",
  "/workers/*",
  "/cms-auth/*",
  "/netlify/*",
  "/package.json",
  "/package-lock.json",
  // One rule per file, not "/*.md": Netlify only honours a trailing "*"
  // splat, so a "/*.md" rule matched nothing and README.md was served
  // (200, text/markdown) on the live domain. qa-check.js asserts every
  // git-tracked top-level .md file appears here.
  "/README.md",
  "/AGENTS.md",
  "/PROJECT.md",
  "/TEST_INFRA.md",
  "/.eslintrc.json",
  "/run-launch-checks.command"
];

/* The Apothecary Journal is gated off (site.enableJournal in
   assets/data/content.json). With it off, build-site-data.js still emits
   journal.html -- noindex, with an empty grid -- and feed.xml as a
   well-formed RSS document containing zero <item>s and a lastBuildDate frozen
   at whenever the last post was written. Both answered 200 on the live domain
   with no inbound link from any of the 65 pages (live audit 2026-09-02, L-2).
   An orphan page and an empty feed that a reader can subscribe to and never
   hear from are worse than a clean 404, so while the flag is off they are
   served as 404s. Turning the flag back on and redeploying removes these two
   rules automatically: Netlify and Vercel both run this script on every
   build, right after build-site-data.js. scripts/qa-check.js asserts the flag
   and these rules agree, so the two cannot drift. */
var JOURNAL_PATHS = ["/journal.html", "/feed.xml"];
function journalEnabled() {
  try {
    var content = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
    return !!(content.site && content.site.enableJournal);
  } catch (e) {
    /* Unreadable content.json is reported by build-site-data.js; assume the
       journal is ON here so a parse failure can never take a live page down. */
    return true;
  }
}
if (!journalEnabled()) {
  BLOCKED_PATHS = BLOCKED_PATHS.concat(JOURNAL_PATHS);
}

/* ---------- clean-URL twins (audit C, M8 / C1 / L6) ----------
   Netlify's "Pretty URLs" post-processing used to do two things to every
   deployed page: re-serialise the HTML (which broke the brand link's
   aria-label, because a single-quoted attribute cannot hold the apostrophe
   in "Y'allternative" -- finding C1) and rewrite `href="shop.html"` to
   `href="/shop"` while ALSO serving that extensionless path at 200. The
   result was two live URLs per page, with 100% of internal links pointing
   at the one the canonical tag disowns (finding M8).

   `[build.processing.html] pretty_urls = false` below turns all of that off,
   so the bytes this repo emits are the bytes the CDN serves. That alone
   would leave every already-indexed extensionless URL 404ing, so each one
   gets an explicit 301 to its .html twin -- generated from the real page
   list rather than a catch-all splat, because a splat here could shadow
   the /api/* proxy above it and silently break checkout.

   Three pages are deliberately absent from the generated list:
     index.html  -- its canonical IS the extensionless "/", so there is no
                    ".html twin" to send anyone to.
     safety.html -- printed on the packaging; it keeps the status=200
                    rewrite below so the printed URL never even redirects.
     404.html    -- gets its own status=404 rules instead (finding L6). */
var CLEAN_URL_SKIP = ["index.html", "safety.html", "404.html"];

function shippedHtmlPages() {
  var pages = [];
  fs.readdirSync(ROOT)
    .filter(function (f) {
      return /\.html$/.test(f);
    })
    .sort()
    .forEach(function (f) {
      pages.push(f);
    });
  var productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir)
      .filter(function (f) {
        return /\.html$/.test(f);
      })
      .sort()
      .forEach(function (f) {
        pages.push("products/" + f);
      });
  }
  return pages;
}

/* The two first-party analytics proxy rules, as [from, to] pairs. One source
   for netlify.toml's [[redirects]] and vercel.json's rewrites, so the two
   platforms cannot describe different proxies. */
function analyticsProxyRules() {
  return [
    [analyticsProxy.ANALYTICS_SCRIPT_PATH, analyticsProxy.UMAMI_SCRIPT_URL],
    [analyticsProxy.ANALYTICS_SEND_PATH, analyticsProxy.UMAMI_SEND_URL]
  ];
}

/* [["/shop", "/shop.html"], ["/products/bug-spray", "/products/bug-spray.html"], ...] */
function cleanUrlRedirects() {
  return shippedHtmlPages()
    .filter(function (rel) {
      return CLEAN_URL_SKIP.indexOf(rel) === -1;
    })
    .map(function (rel) {
      return ["/" + rel.replace(/\.html$/, ""), "/" + rel];
    });
}

var PAGES = [
  "index.html",
  "shop.html",
  "about.html",
  "contact.html",
  "events.html",
  "privacy.html",
  "404.html",
  "thank-you.html",
  // Previously missing from this list -- meaning these 4 pages' inline
  // scripts were never actually checked against the hashes this script
  // computes. Since the CSP header is identical on every page (see the
  // "/*" block below), a silently-diverging inline script on any of
  // these would have shipped a page that's broken under its own CSP
  // with no warning from this script. Added so every page that ships
  // an inline <script> is covered by the byte-identical check.
  "faq.html",
  "journal.html",
  "reviews.html",
  "order-status.html",
  "policies.html",
  "terms.html",
  "welcome.html",
  // safety.html ships NO inline script of its own -- the theme-init snippet it
  // copies from contact.html is the only one, and its hash is already in the
  // baseline. It is listed anyway: a page absent from here is a page whose
  // inline scripts are never checked, which is exactly the gap this list was
  // widened to close for faq/journal/reviews/order-status.
  "safety.html",
  "products/backroad-soak.html"
];

/* Every page whose inline scripts the CSP has to cover. The static list
   above is the top-level site; the 19 generated product pages are globbed
   because they are created by build-site-data.js from products.json -- a CMS
   commit can add one, and only backroad-soak.html used to be checked, so an
   inline script on any of the other 18 was hashed by nobody.

   SECURITY_HEADERS_EXTRA_PAGES (env, path.delimiter-separated) appends pages
   that live OUTSIDE the site tree -- absolute paths are fine. It can only
   widen the check, never narrow it. It exists so build-security-headers.test.js
   can prove the gate refuses an unknown inline script without dropping a probe
   file into products/, where every other suite that globs the PDPs (and runs
   in parallel with it) would count it as a 20th product page. */
function allPages() {
  var pages = PAGES.slice();
  var productsDir = path.join(ROOT, "products");
  if (fs.existsSync(productsDir)) {
    fs.readdirSync(productsDir)
      .filter(function (f) {
        return /\.html$/.test(f);
      })
      .sort()
      .forEach(function (f) {
        var rel = "products/" + f;
        if (pages.indexOf(rel) === -1) pages.push(rel);
      });
  }
  var extra = process.env.SECURITY_HEADERS_EXTRA_PAGES;
  if (extra) {
    extra.split(path.delimiter).forEach(function (p) {
      if (p && pages.indexOf(p) === -1) pages.push(p);
    });
  }
  return pages;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(
      "[build-security-headers] Missing " +
        path.relative(ROOT, BASELINE_PATH) +
        " -- the CSP cannot be built without the approved inline-script baseline."
    );
    process.exit(1);
  }
  try {
    var parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    return parsed && parsed.hashes ? parsed.hashes : {};
  } catch (e) {
    console.error(
      "[build-security-headers] " + path.relative(ROOT, BASELINE_PATH) + ": " + e.message
    );
    process.exit(1);
  }
}

/* Which of the inline scripts found on the pages are NOT in the baseline.
   `pageScripts` maps a page name to its array of inline script bodies. */
function findUnapprovedHashes(pageScripts, baseline) {
  var unapproved = [];
  var seen = {};
  Object.keys(pageScripts).forEach(function (page) {
    (pageScripts[page] || []).forEach(function (body) {
      var hash = "sha256-" + sha256Base64(body);
      if (baseline && Object.prototype.hasOwnProperty.call(baseline, hash)) return;
      if (seen[hash]) {
        seen[hash].pages.push(page);
        return;
      }
      seen[hash] = { hash: hash, pages: [page], body: body };
      unapproved.push(seen[hash]);
    });
  });
  return unapproved;
}

function extractInlineScripts(html) {
  var out = [];
  var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html))) {
    // JSON-LD blocks (type="application/ld+json") are inert data, not
    // executable script -- browsers don't run them and CSP's script-src
    // doesn't govern them, so there's nothing to hash here.
    if (/type\s*=\s*["']application\/ld\+json["']/.test(m[0])) continue;
    out.push(m[1]);
  }
  return out;
}

function sha256Base64(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("base64");
}

function readHtml(page) {
  // resolve, not join: SECURITY_HEADERS_EXTRA_PAGES entries may be absolute,
  // and path.join(ROOT, "/tmp/x") would wrongly produce "<ROOT>/tmp/x".
  var filePath = path.resolve(ROOT, page);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    console.error("[build-security-headers] Could not read page " + page + ": " + e.message);
    process.exit(1);
  }
}

function run() {
  var canonical = readHtml("index.html");
  var canonicalScripts = extractInlineScripts(canonical);
  if (canonicalScripts.length < 1) {
    throw new Error(
      "Expected at least 1 real inline <script> block in index.html (the theme-init snippet) -- found " +
        canonicalScripts.length +
        ". Aborting so the CSP doesn't get built from stale assumptions."
    );
  }

  // Collect the inline scripts on every page, PDPs included.
  var pages = allPages();
  var pageScripts = {};
  var allTexts = {};
  var hashPages = {};
  pages.forEach(function (page) {
    var html = page === "index.html" ? canonical : readHtml(page);
    var scripts = extractInlineScripts(html);
    pageScripts[page] = scripts;
    scripts.forEach(function (body) {
      var h = sha256Base64(body);
      if (!allTexts[h]) allTexts[h] = body;
      hashPages[h] = hashPages[h] || [];
      hashPages[h].push(page);
    });
  });

  /* ---------- the gate ----------
     Runs before anything is written, so a failure leaves _headers,
     vercel.json and netlify.toml exactly as they were. */
  var baseline = readBaseline();
  var unapproved = findUnapprovedHashes(pageScripts, baseline);
  if (unapproved.length) {
    console.error(
      "\n[build-security-headers] Refusing to build: " +
        unapproved.length +
        " inline script(s) are not in the approved baseline.\n"
    );
    unapproved.forEach(function (item) {
      var preview = item.body.replace(/\s+/g, " ").trim().slice(0, 160);
      console.error("  " + item.hash);
      console.error("    on: " + item.pages.join(", "));
      console.error("    starts: " + preview + (item.body.length > 160 ? " ..." : ""));
      console.error("");
    });
    console.error(
      "  This is the check that stops CMS-authored text from being allowlisted by\n" +
        "  the CSP that is meant to contain it (audit C-4 / H-13). If YOU changed an\n" +
        "  inline script, read the block above, confirm every line of it is yours,\n" +
        "  then add the hash to scripts/inline-script-hashes.json with a note saying\n" +
        "  what the script does -- in the same commit as the change. If you did not\n" +
        "  change it, do not update the baseline: find out where it came from.\n"
    );
    process.exit(1);
  }

  /* Baseline entries that no longer match anything on the site are reported
     but not fatal -- a page can legitimately lose a script. They are left out
     of the emitted CSP: the policy carries hashes that exist, nothing else.
     (One hardcoded hash matching no page had been sitting in the script-src
     for exactly this reason.) */
  /* Baseline entries flagged "runtime": true are scripts a page's own JS
     creates after load (today: the speculation-rules JSON main.js appends),
     so no static page can carry them. They are emitted unconditionally and
     never counted as stale. */
  Object.keys(baseline).forEach(function (h) {
    if (baseline[h] && baseline[h].runtime === true) {
      allTexts[h.replace(/^sha256-/, "")] = true;
    }
  });
  var stale = Object.keys(baseline).filter(function (h) {
    return !allTexts[h.replace(/^sha256-/, "")];
  });
  if (stale.length) {
    console.warn(
      "[build-security-headers] " +
        stale.length +
        " baseline hash(es) match no page any more (left out of the CSP; remove them from " +
        "scripts/inline-script-hashes.json when you are sure): " +
        stale.join(", ")
    );
  }

  var hashes = Object.keys(allTexts)
    .sort()
    .map(function (h) {
      return "'sha256-" + h + "'";
    });

  var csp = [
    "default-src 'self'",
    // embed.tawk.to: the live-chat widget script (see the placeholder
    // snippet near </body> on every page, task/DEVELOPMENT.md section 19) --
    // it's inert until a real Tawk.to property/widget ID replaces the
    // placeholder, but the origin is allowlisted now so turning it on
    // later doesn't also require touching this file.
    // Analytics has TWO routes and the policy has to allow both, because the
    // page does not know in advance which one it will take. Every page loads
    // assets/js/porch-light.js ('self'), which injects the tracker from
    // https://cloud.umami.is first and falls back to the first-party
    // /porch-light/script.js ('self') only when that fails -- see
    // scripts/lib/analytics-proxy.js.
    //
    // BOTH HOSTS ARE REQUIRED, AND THEY ARE REQUIRED IN DIFFERENT DIRECTIVES.
    // https://cloud.umami.is is where the script is DOWNLOADED from (script-src).
    // https://gateway.umami.is is where the direct copy POSTS (connect-src).
    // Allowing only the first is precisely the bug that made this shop's
    // dashboard read zero for weeks: the tracker loaded perfectly and the
    // browser refused every pageview and every event. Removing either one now
    // does not disable analytics -- it silently demotes every visitor to the
    // proxied route, where their session id and country become Netlify's.
    // 'inline-speculation-rules': allows the inline speculation-rules block
    // that main.js injects for instant navigations (prerender/prefetch on
    // hover). This keyword ONLY permits speculation-rules scripts -- it does
    // not open up general inline JS execution.
    // Every hash here is computed from a real inline script on a real page
    // and approved in scripts/inline-script-hashes.json. There used to be one
    // more, hardcoded, matching no script on any page in the repository --
    // an allowlist entry for something nobody could point at.
    // cdn.jsdelivr.net/emojione/: the Tawk.to widget, once loaded, pulls its
    // emoji renderer from that one path (seen as a script-src violation on every
    // page in the 2026-09-02 verification). Path-scoped on purpose: the rest of
    // jsDelivr stays blocked. Kept through the 2026-09-02 live audit (M-2
    // listed it as unused): the audit grepped static markup, but the widget is
    // loaded by the deferred inline snippet on first pointerdown/scroll and
    // the two Tawk IDs in content.json are real, so this fires for any visitor
    // who touches the page.
    "script-src 'self' " +
      analyticsProxy.UMAMI_SCRIPT_ORIGIN +
      " https://embed.tawk.to https://cdn.jsdelivr.net/emojione/ 'inline-speculation-rules' " +
      hashes.join(" "),
    // Fonts are self-hosted from /assets/fonts/ (styles.css @font-face), so
    // neither fonts.googleapis.com nor fonts.gstatic.com is needed any more.
    // embed.tawk.to: the chat widget's script loads its own stylesheet and
    // font files from that origin; without it the widget renders unstyled
    // (every page logged a style-src violation for min-widget.css).
    "style-src 'self' https://embed.tawk.to 'unsafe-inline'", // main.js/cart.js/gift-card.js/translator.js all set element.style.* directly (display toggles, carousel transforms, etc.); can't pre-hash those, so this directive stays looser on purpose
    "img-src 'self' data: https://*.tawk.to https://cdn.jsdelivr.net/emojione/",
    "font-src 'self' https://embed.tawk.to",
    // Checkout itself never needs an entry here: cart.js POSTs to the
    // same-origin /api/checkout Worker route (covered by 'self'), then
    // does a normal top-level `window.location = url` redirect to Stripe's
    // hosted Checkout page -- full-page navigations aren't governed by
    // connect-src/frame-src/form-action.
    /* https://app.convertkit.com dropped 2026-09-02 (live audit M-2). The
       footer newsletter posts with fetch() to site.kitFormAction, which is
       https://app.kit.com/forms/9867317/subscriptions -- the current domain.
       Nothing in the repository, and nothing on any of the 65 live pages,
       reaches the legacy ConvertKit host; the redirect that does exist runs
       convertkit.com -> kit.com, not the other way. qa-check.js now derives
       the required origins from content.json instead of pinning this list, so
       pasting an app.convertkit.com form URL into the CMS fails the build
       here rather than silently breaking signups in the browser. */
    /* gateway.umami.is is where the DIRECT copy of the tracker posts, and it
       is NOT the host the script came from. cloud.umami.is/script.js builds its
       collection URL as
         (data-host-url || "https://gateway.umami.is") + "/api/send"
       so the direct route (no data-host-url) needs this entry and the fallback
       route (data-host-url = a first-party path) needs 'self'. Both are here.

       Umami has moved this collection host repeatedly with no changelog and no
       migration notice -- analytics.umami.is, then api-gateway-eu.umami.dev,
       then api-gateway.umami.dev, now gateway.umami.is (umami-software/umami
       discussion #2719, still undocumented). If it moves again, the direct
       route breaks in the browser with a visible CSP violation AND the proxy
       rule below breaks server-side with none -- so check this directive and
       UMAMI_SEND_URL in scripts/lib/analytics-proxy.js together. */
    "connect-src 'self' " +
      analyticsProxy.UMAMI_SEND_ORIGIN +
      " https://*.tawk.to wss://*.tawk.to https://formspree.io https://app.kit.com",
    "frame-src https://*.tawk.to",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // 'self' covers the review-submission form once it posts to a same-site
    // endpoint; app.kit.com is the footer newsletter form's real action URL
    // (site.kitFormAction in content.json -- this is the no-JS path, since
    // main.js otherwise intercepts and posts with fetch()); formspree.io
    // covers the "Write a Review" form below. app.convertkit.com came out
    // with the connect-src entry above, for the same reason and the same
    // evidence.
    "form-action 'self' https://app.kit.com https://formspree.io",
    "object-src 'none'"
  ].join("; ");

  // ---------- /admin/* CSP (Sveltia CMS product editor) ----------
  // Deliberately a SEPARATE, path-scoped policy rather than loosening the
  // main site's CSP -- the CMS at /admin needs to talk to unpkg.com (its
  // own script bundle, loaded from a CDN with no local install step --
  // see admin/index.html) and GitHub's API, none of which the actual
  // public-facing pages ever need. Base directives (unpkg.com in
  // script-src/connect-src) are copied verbatim from Sveltia's own CSP
  // builder at https://sveltiacms.app/en/docs/security#setting-up-content-security-policy.
  // The GitHub-specific additions (api.github.com for REST+GraphQL,
  // *.githubusercontent.com for avatars and uploaded media) are added
  // from GitHub's own documented API/asset domains, NOT independently
  // re-verified against that same interactive CSP-builder tool (it's a
  // client-side widget with no way to fetch its per-backend output
  // statically) -- so treat this the same as the Gift Up! caveat
  // elsewhere in this project: once a real GitHub
  // repo + OAuth setup exists (see DEVELOPMENT.md section 20), open the browser
  // console while using /admin and watch for "Refused to connect/load..."
  // CSP errors, then add whatever origin they name here and re-run this
  // script.
  // Sveltia loads its Material Symbols ICON FONT from an external CDN, not from
  // its own bundle: Google Fonts (fonts.googleapis.com CSS + fonts.gstatic.com
  // font files) on the version pinned in admin/index.html, and Fontsource via
  // jsDelivr (cdn.jsdelivr.net) on v0.174.0+. With only `font-src 'self'` the
  // font is blocked and every icon renders as its raw ligature text
  // ("bookmark_manager", "chevron_right", "expand_more", ...) -- which is
  // exactly what /admin looked like before this. Allow BOTH font sources so the
  // policy is correct whether or not admin/index.html's pin is later bumped:
  //   - style-src:   fonts.googleapis.com (Google Fonts CSS), cdn.jsdelivr.net
  //   - font-src:    fonts.gstatic.com (Google font files), cdn.jsdelivr.net, data:
  //   - connect-src: cdn.jsdelivr.net (Fontsource fetches its CSS/font), blob:, data:
  // These four are well-known font CDNs and this is the /admin-only policy, not
  // the public-site CSP. If a future Sveltia release names another origin,
  // watch the /admin console for "Refused to load..." and add it here.
  var adminCsp = [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.githubusercontent.com",
    "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
    "connect-src 'self' blob: data: https://unpkg.com https://cdn.jsdelivr.net https://api.github.com https://*.githubusercontent.com",
    "media-src blob:",
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");

  /* /admin/* is served (Sveltia needs its own config.yml client-side), so it
     cannot be blocked -- but nothing under it should ever be in an index. It
     already carries a noindex meta tag and a robots.txt Disallow; a Disallow
     only stops the crawl, it does not stop a URL discovered elsewhere from
     being listed. X-Robots-Tag is the part that actually removes it. The
     2026-09-02 live audit (L-4) noted /admin/config.yml answers 200 and
     discloses the CMS backend and repo path; there are no credentials in it
     and Sveltia cannot work without it, so this is the available hardening,
     not a fix for the disclosure itself. */
  var ADMIN_ROBOTS_TAG = "noindex, nofollow, noarchive";

  var otherHeaders = [
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "geolocation=(), microphone=(), camera=(), usb=(), payment=(self)"],
    // HSTS is safe to ship now (only takes effect over real HTTPS, which
    // every realistic static host serves by default) but actually being
    // added to browsers' preload list is a separate, manual step at
    // https://hstspreload.org once the domain is live and stable.
    ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
    // same-origin-allow-popups (not the stricter same-origin) so third-party
    // embeds (Gift Up!, Tawk.to chat) that might open a popup keep a working
    // window.opener back to this page -- still isolates this page's
    // browsing context group from unrelated cross-origin openers. Stripe
    // Checkout itself is a plain top-level redirect, not a popup, so it
    // doesn't actually need this -- kept as a safety margin for the embeds.
    ["Cross-Origin-Opener-Policy", "same-origin-allow-popups"]
  ];

  // ---------- _headers (Netlify / Cloudflare Pages) ----------
  // More specific paths win over "/*" for the SAME header key on both
  // Netlify and Cloudflare Pages, so the /admin/* block below gets its
  // own complete CSP instead of the main site's.
  var headersFile = "/*\n";
  headersFile += "  Content-Security-Policy: " + csp + "\n";
  otherHeaders.forEach(function (pair) {
    headersFile += "  " + pair[0] + ": " + pair[1] + "\n";
  });
  headersFile += "\n/admin/*\n";
  headersFile += "  Content-Security-Policy: " + adminCsp + "\n";
  headersFile += "  X-Robots-Tag: " + ADMIN_ROBOTS_TAG + "\n";
  fs.writeFileSync(path.join(ROOT, "_headers"), headersFile);
  console.log("wrote _headers (Netlify / Cloudflare Pages)");

  // ---------- vercel.json ----------
  var vercelHeaders = [{ key: "Content-Security-Policy", value: csp }].concat(
    otherHeaders.map(function (pair) {
      return { key: pair[0], value: pair[1] };
    })
  );
  var vercelJson = {
    // Build command runs before every deploy so a commit that only
    // changed assets/data/products.json (e.g. one made by the Sveltia
    // CMS at /admin) still ships with a freshly-regenerated products-
    // data.js, shop.html/contact.html JSON-LD, sitemap.xml, and llms.txt
    // -- see DEVELOPMENT.md section 20 and the big comment atop
    // scripts/build-site-data.js for why this became required once the
    // CMS could write to products.json without a human remembering to
    // run that script by hand first. No npm install needed first: this
    // script and build-site-data.js only use Node's built-in fs/path/
    // crypto modules, zero external dependencies.
    buildCommand:
      "node scripts/optimize-images.js && node scripts/build-site-data.js && node scripts/build-security-headers.js",
    outputDirectory: ".",
    // The Vercel twin of netlify.toml's analytics proxy rules above. Vercel
    // rewrites are the equivalent of a Netlify status=200 redirect: the path
    // stays first-party in the browser and Vercel fetches the target
    // server-side. Same two explicit paths, same targets, same source
    // constants -- a build-security-headers.test.js assertion compares the two
    // files so this cannot quietly fall behind netlify.toml.
    //
    // Netlify is the production host; this file exists so a Vercel deploy is
    // not silently missing analytics. (The /api/* Worker proxy has never had a
    // Vercel twin either -- checkout would need one before this file could
    // actually serve the shop.)
    rewrites: analyticsProxyRules().map(function (pair) {
      return { source: pair[0], destination: pair[1] };
    }),
    headers: [
      { source: "/(.*)", headers: vercelHeaders },
      // Vercel applies header rules in the order listed, and for
      // overlapping paths a later matching rule's header value is what
      // actually gets sent -- this /admin/(.*) block comes after the
      // catch-all above specifically so its CSP wins for /admin routes.
      // (This ordering behavior was NOT independently re-verified against
      // a live Vercel deploy during development -- if /admin ever shows
      // the wrong CSP in production, check Vercel's current docs on
      // multiple matching header rules.)
      {
        source: "/admin/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: adminCsp },
          { key: "X-Robots-Tag", value: ADMIN_ROBOTS_TAG }
        ]
      }
    ]
  };
  fs.writeFileSync(path.join(ROOT, "vercel.json"), JSON.stringify(vercelJson, null, 2) + "\n");
  console.log("wrote vercel.json");

  // ---------- netlify.toml ----------
  // The build config + per-path cache-control rules rarely change and
  // aren't security-sensitive, so they stay as plain text here -- only
  // the security-header block is built from the exact same csp/
  // otherHeaders every other file above uses, which is the part that
  // actually needs to never drift.
  var netlifyToml =
    "# Netlify config for this static site. A real build command now runs\n" +
    "# before every deploy (see [build] below) -- it used to be truly zero-\n" +
    "# build, but the Sveltia CMS at /admin (DEVELOPMENT.md section 20) commits\n" +
    "# straight to assets/data/products.json, and that needs to be turned\n" +
    "# back into products-data.js/shop.html/contact.html/sitemap.xml/\n" +
    "# llms.txt on every deploy, not just when a human remembers to run\n" +
    "# scripts/build-site-data.js by hand.\n" +
    "#\n" +
    "# Auto-generated by scripts/build-security-headers.js -- don't hand-edit the\n" +
    '# [[headers]] for = "/*" block below, it\'ll just get overwritten and could\n' +
    "# drift out of sync with _headers/vercel.json again. Edit the csp/otherHeaders\n" +
    "# arrays in that script instead, then re-run it.\n\n" +
    "[build]\n" +
    '  publish = "."\n' +
    '  command = "node scripts/optimize-images.js && node scripts/build-site-data.js && node scripts/build-security-headers.js"\n' +
    // Netlify meters builds in minutes, and this account's allowance ran
    // out on 2026-09-04 -- the site could not deploy at all once it was
    // spent. A large share of the commits that reach main change nothing
    // Netlify serves -- CI workflow tweaks, docs, the Cloudflare Worker
    // (deployed by Cloudflare, not here), test files -- so the build now
    // refuses to spend minutes on
    // them. git's exit code IS the decision: 0 (no difference outside the
    // excluded paths) cancels the build, anything else builds; a missing
    // CACHED_COMMIT_REF (first build, cleared cache) makes git fail, which
    // builds -- the safe default. Excludes only what is certainly not part of
    // the deploy; a needless build is cheap next to a skipped one, so when in
    // doubt leave a path OUT of this list. The default pathspec wildcard
    // matches across "/", so *.md covers docs and workers/README.md too.
    // Generated here, like the rest of this file: a hand-edit does not
    // survive the next run of this script.
    "\n" +
    "  # Skip the build -- and its minutes -- when nothing that ships changed.\n" +
    "  # git exits 0 when the diff since the last deployed commit touches only\n" +
    "  # the excluded paths (CI workflows, docs, the Cloudflare Worker, tests),\n" +
    "  # and Netlify cancels a build whose ignore command exits 0. Anything else,\n" +
    "  # including a missing CACHED_COMMIT_REF, builds. Excludes only what is\n" +
    "  # certainly not served; when in doubt leave a path out of this list.\n" +
    "  # Generated by scripts/build-security-headers.js.\n" +
    "  ignore = \"git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- . ':(exclude)docs' ':(exclude)workers' ':(exclude).github' ':(exclude)*.md' ':(exclude)scripts/*.test.js'\"\n\n" +
    // This block used to be hand-written into netlify.toml, which meant every
    // run of this script silently deleted it -- taking image optimization off
    // the deploy with it. Generated here so the two cannot drift apart again.
    "# The build needs devDependencies -- scripts/optimize-images.js requires\n" +
    '# "sharp" to generate each new photo\'s AVIF/WebP variants. Netlify installs\n' +
    "# devDependencies by default, but setting NODE_ENV=production (easy to do in\n" +
    "# the UI, and a common habit) silently makes npm skip them. Ask for them\n" +
    "# explicitly so that can't happen. optimize-images.js also degrades to a\n" +
    "# warning if sharp is missing anyway, so a mistake here costs unoptimized\n" +
    "# photos rather than a failed deploy.\n" +
    "#\n" +
    // Netlify meters builds in minutes and this account's ran out on
    // 2026-09-04, so anything the deploy downloads and never opens is worth
    // deleting. Asking for devDependencies (above) also installs puppeteer
    // and playwright -- the browser drivers the tests drive -- and their
    // install steps fetch browsers. Names verified on 2026-09-05 by reading
    // node_modules, not the docs: puppeteer 25.3.0 declares postinstall
    // "node install.mjs", whose downloadBrowsers() returns early when
    // lib/puppeteer/getConfiguration.js finds PUPPETEER_SKIP_DOWNLOAD --
    // that exact name, the pre-19.x PUPPETEER_SKIP_CHROMIUM_DOWNLOAD being
    // gone from 25.x, and the same name CI already sets in
    // .github/workflows/test.yml. playwright 1.62.1 registers no install
    // script at all, so it downloads nothing today; playwright-core's
    // installBrowsersForNpmInstall() still gates on
    // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so that one is set too and a version
    // bump cannot quietly put the download back. Both read "1" as true. The
    // deploy launches no browser; the jobs that do run elsewhere, where
    // neither variable is set and both tools install a browser as usual.
    "# Asking for devDependencies also installs puppeteer and playwright, the\n" +
    "# browser drivers the tests drive. Puppeteer's install step downloads\n" +
    "# ~170MB of Chrome; playwright ships no install script at the version in\n" +
    "# package-lock.json but has long honoured the variable below, so it is\n" +
    "# set too rather than waiting for a bump to bring the download back.\n" +
    "# Nothing in the build command above opens a browser -- it optimizes\n" +
    "# images, rebuilds site data and rewrites these headers -- so on every\n" +
    "# deploy those bytes are build minutes bought and thrown away. Netlify\n" +
    "# meters builds in minutes and this account's ran out on 2026-09-04;\n" +
    "# these two lines are minutes back. CI and laptops set neither, so the\n" +
    "# tests still get real browsers.\n" +
    "#\n" +
    "# The Node version for this build is pinned in .nvmrc (Netlify reads that\n" +
    "# ahead of every other source), not here -- one source of truth.\n" +
    "[build.environment]\n" +
    '  NPM_FLAGS = "--include=dev"\n' +
    '  PUPPETEER_SKIP_DOWNLOAD = "1"\n' +
    '  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"\n\n' +
    // ---- deploy-time HTML post-processing: OFF ----
    // See the CLEAN_URL_SKIP comment near the top of this script. Netlify's
    // post-processing re-serialised every page's HTML with single-quoted
    // attributes, which truncated `aria-label="Y'allternative Living home"`
    // at the apostrophe on all 36 pages -- the site's primary home link
    // announced as "Y" to a screen reader, and no repo-level test could see
    // it because the repo's own bytes were correct (audit C, finding C1).
    // The same pass rewrote every internal href to an extensionless URL that
    // is not the canonical one (finding M8).
    //
    // pretty_urls under [build.processing.html] is the ONE key that still
    // does anything here. Netlify's wider Asset Optimization stage (the old
    // [build.processing] skip_processing switch, plus the css/js/images
    // blocks) was deprecated in July 2023 and end-of-serviced on 2023-10-17,
    // so it is absent from the current docs and writing it would be
    // cargo-cult. A netlify.toml setting overrides the dashboard toggle, so
    // this also cannot be switched back on in the UI by accident.
    //
    // Turning pretty_urls off does NOT stop Netlify serving /shop from
    // shop.html: extensionless resolution is core routing with no toggle at
    // all, which is exactly why every twin below needs a FORCED 301.
    //
    // THIS BLOCK IS GENERATED. It lived only in netlify.toml once, which is
    // how the [build.environment] block above got silently deleted on the
    // next run of this script -- a hand-edit here does not survive a deploy.
    "# Deploy-time HTML post-processing is OFF. Netlify's Pretty URLs pass\n" +
    "# re-serialises every page and re-quotes attributes with single quotes,\n" +
    "# which truncated the brand link's aria-label at the apostrophe in\n" +
    '# "Y\'allternative" and rewrote internal hrefs to extensionless URLs that\n' +
    "# contradict each page's canonical. The bytes in this repo are the bytes\n" +
    "# that ship, and this key overrides the dashboard toggle so it cannot be\n" +
    "# turned back on in the UI. (The old [build.processing] skip_processing\n" +
    "# switch is deliberately NOT written: Netlify end-of-serviced that whole\n" +
    "# stage on 2023-10-17, so it is a no-op.)\n" +
    "# Generated by scripts/build-security-headers.js.\n" +
    "[build.processing.html]\n" +
    "  pretty_urls = false\n\n" +
    // ---- retired Netlify Functions ----
    // The four Netlify Functions this site used to run are deleted; the money
    // path is one Cloudflare Worker now (workers/checkout.js). No redirect
    // rule is emitted for their old /.netlify/functions/* URLs: Netlify
    // reserves that prefix and rejects redirect rules on it ("4 invalid
    // redirect rules" on deploy), and a deleted function already answers 404.
    // The client code no longer references those paths (asserted in
    // scripts/cart-engine.test.js).
    "# The Netlify Functions this site used to run are gone -- the money path\n" +
    "# is one Cloudflare Worker now (workers/checkout.js), reached via the\n" +
    "# /api/* proxy below. Generated by scripts/build-security-headers.js.\n\n" +
    // ---- the Worker proxy ----
    // The cart POSTs to a same-origin /api/checkout (assets/js/cart.js's
    // CHECKOUT_URL) and the other pages POST to their own /api/... paths. The
    // code that answers all of them is one Cloudflare Worker
    // (workers/checkout.js), which lives on a workers.dev hostname. status=200
    // makes this a PROXY rather than a redirect: Netlify fetches the Worker
    // server-side and returns its response, so the browser only ever talks to
    // yallternativeliving.com.
    //
    // Same-origin on purpose, and not just for tidiness -- the CSP below sets
    // connect-src 'self', so a fetch straight to workers.dev would be blocked
    // outright. Proxying keeps checkout working without punching a hole in the
    // CSP for a third-party origin.
    //
    // The wildcard matters for the webhook in particular: Netlify must forward
    // the request body BYTE FOR BYTE, because the Worker verifies Stripe's
    // signature over the raw bytes. If a Stripe delivery ever fails signature
    // verification through this hop, register the workers.dev URL with Stripe
    // directly instead -- see workers/README.md.
    //
    // A Cloudflare Worker *Route* on the real domain would remove this hop,
    // but Routes require Cloudflare to run the domain's DNS, and DNS lives at
    // Netlify. Not worth migrating a working site for it.
    //
    // This block is here rather than hand-written into netlify.toml because
    // this script rewrites that whole file on every deploy -- an edit made
    // directly there would vanish on the next build.
    "# Every /api/* route is answered by the Cloudflare Worker. `:splat` is the\n" +
    "# matched remainder, so /api/order-status reaches the Worker as\n" +
    "# /order-status -- workers/checkout.js's routeOf() accepts both spellings.\n" +
    "# The cart posts to " +
    CHECKOUT_PATH +
    "; assets/js/cart.js's CHECKOUT_URL must agree.\n" +
    "[[redirects]]\n" +
    '  from = "' +
    API_PROXY_FROM +
    '"\n' +
    '  to = "' +
    API_PROXY_TO +
    '"\n' +
    "  status = 200\n" +
    "  force = true\n\n" +
    // ---- the first-party analytics proxy ----
    // Two explicit paths, never a splat, and deliberately ABOVE the clean-URL
    // 301s further down: an extensionless-twin rule that ever grew a wildcard
    // would otherwise redirect the tracker's POST and silently end analytics.
    //
    // status = 200 makes both of these PROXIES, not redirects -- Netlify
    // fetches Umami server-side and returns the response, so the browser only
    // ever sees yallternativeliving.com. That is the whole point: list-based
    // blockers match hostnames, and cloud.umami.is / gateway.umami.is are both
    // on those lists (the shop owner's own router blocks them at DNS).
    //
    // force = true because Netlify's core routing would otherwise try to
    // resolve these paths against the published tree first, and there is no
    // /porch-light directory in the repo -- an unforced rule would 404.
    //
    // CAVEAT, MEASURED FROM UMAMI'S SOURCE, NOT GUESSED: Umami resolves the
    // visitor's IP from the first header present in a fixed list
    // (src/lib/ip.ts on master) that puts `cf-connecting-ip` AHEAD of
    // `x-nf-client-connection-ip` and `x-forwarded-for`. gateway.umami.is is
    // behind Cloudflare, which sets cf-connecting-ip to whoever opened the
    // connection -- which through this hop is Netlify, not the shopper. See
    // docs/ANALYTICS.md "What the proxy costs" before reading visitor counts
    // or the country breakdown as gospel.
    "# The analytics tracker is served and sends through THIS origin. Blockers\n" +
    "# match hostnames, so a first-party path is what keeps the shop countable.\n" +
    "# Two explicit paths, never a splat, and above the clean-URL rules below.\n" +
    "# Paths are defined once in scripts/lib/analytics-proxy.js -- the tracker\n" +
    "# tag in every page's <head> is generated from the same constants.\n" +
    analyticsProxyRules()
      .map(function (pair) {
        return (
          "[[redirects]]\n" +
          '  from = "' +
          pair[0] +
          '"\n' +
          '  to = "' +
          pair[1] +
          '"\n' +
          "  status = 200\n" +
          "  force = true\n\n"
        );
      })
      .join("") +
    // Netlify publishes this whole repository, so without these every build
    // script, audit document, Worker source and lockfile in the tree is a live
    // URL on the real domain (audit: Medium, SEO/content -- 1.5 MB of scripts/
    // alone). Netlify applies the first MATCHING rule, and none of these
    // patterns overlap /api/*, so they block just as well after it as before
    // it. /admin/* is deliberately absent: the CMS has to keep being served.
    // /netlify/* still blocks the (now empty) source directory; the retired
    // function URLs under /.netlify/functions/ simply 404 (Netlify reserves
    // that prefix, so no rule can be written for it).
    "# Source, docs and tooling are in the publish root but must never be\n" +
    "# served. /admin/ is deliberately not in this list -- the CMS is served.\n" +
    BLOCKED_PATHS.map(function (blockedPath) {
      return (
        "[[redirects]]\n" +
        '  from = "' +
        blockedPath +
        '"\n' +
        '  to = "/404.html"\n' +
        "  status = 404\n" +
        "  force = true\n\n"
      );
    }).join("") +
    // ---- clean URL for the printed-on-the-label safety page ----
    // MoCRA requires the LABEL to carry a contact through which a consumer can
    // report an adverse event, so this shop prints https://yallternativeliving
    // .com/safety on the packaging. A printed URL cannot be changed after the
    // jar is sold, so it must never 404: status=200 makes this a rewrite, not a
    // redirect -- /safety and /safety.html both serve the page, and the page's
    // own <link rel="canonical"> points search engines at the .html spelling so
    // the two are not indexed as duplicates. Netlify's own "pretty URLs" would
    // usually cover this; it is written out because the label is permanent and
    // a default that can be toggled off in a dashboard is not a guarantee.
    "# Clean URL for the safety page. This path is PRINTED ON THE PACKAGING\n" +
    "# (MoCRA adverse-event contact), so it must resolve forever. status=200 is\n" +
    "# a rewrite: /safety and /safety.html both serve safety.html.\n" +
    "[[redirects]]\n" +
    '  from = "/safety"\n' +
    '  to = "/safety.html"\n' +
    "  status = 200\n\n" +
    // ---- the error page answers 404 (audit C, finding L6) ----
    // Genuinely missing paths already 404. The error page itself was
    // fetchable at 200 under both /404 and /404.html, which is a soft-404
    // signal. force = true is required on BOTH rules: 404.html is a real file
    // in the publish root, and Netlify resolves the extensionless /404 to that
    // same file before consulting an unforced rule, so without force each
    // spelling is served with its old 200 (verified live 2026-09-02: the
    // unforced /404 rule was ignored while the forced /404.html one held).
    "# The error page itself answers 404, not 200 -- it was fetchable at 200\n" +
    "# under both spellings, which reads as a soft 404 to a crawler.\n" +
    "[[redirects]]\n" +
    '  from = "/404"\n' +
    '  to = "/404.html"\n' +
    "  status = 404\n" +
    "  force = true\n\n" +
    "[[redirects]]\n" +
    '  from = "/404.html"\n' +
    '  to = "/404.html"\n' +
    "  status = 404\n" +
    "  force = true\n\n" +
    // ---- extensionless twins 301 to the canonical .html (finding M8) ----
    // One explicit rule per shipped page, never a "/*" splat: a catch-all
    // here would sit after the /api/* proxy but before nothing else, and any
    // future reordering would let it swallow the checkout path.
    "# Every page was reachable at TWO live URLs (/shop and /shop.html, both\n" +
    "# 200) while the canonical named only one and every internal link pointed\n" +
    "# at the other. The extensionless spelling now 301s to the canonical .html.\n" +
    "# force = true because Netlify's core routing resolves /shop to shop.html\n" +
    "# on its own -- that is not the Pretty URLs feature and has no toggle, so\n" +
    "# an unforced rule would lose to the content Netlify already found there.\n" +
    "# One explicit rule per page -- deliberately not a catch-all splat, which\n" +
    "# could shadow the /api/* proxy above. Generated from the page list by\n" +
    "# scripts/build-security-headers.js; add a page and its rule appears.\n" +
    cleanUrlRedirects()
      .map(function (pair) {
        return (
          "[[redirects]]\n" +
          '  from = "' +
          pair[0] +
          '"\n' +
          '  to = "' +
          pair[1] +
          '"\n' +
          "  status = 301\n" +
          "  force = true\n\n"
        );
      })
      .join("") +
    "# Long-lived caching for hashed/never-changing assets. Pages themselves\n" +
    "# (index.html, shop.html, etc.) intentionally aren't cached long here --\n" +
    "# Netlify already serves them with an ETag + must-revalidate by default,\n" +
    "# so browsers re-check on every visit and always get the latest deploy.\n" +
    "[[headers]]\n" +
    '  for = "/assets/img/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=31536000, immutable"\n\n' +
    "[[headers]]\n" +
    "  # Scripts and styles: revalidate every time (Netlify answers 304 from its\n" +
    "  # ETag, so this costs a round trip and no bytes). The old seven-day\n" +
    "  # max-age let a returning shopper run stale cart/checkout code for a\n" +
    "  # week: the browser cache answered before the service worker could\n" +
    "  # even see the request (verify-D H-2).\n" +
    '  for = "/assets/css/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=0, must-revalidate"\n\n' +
    "[[headers]]\n" +
    '  for = "/assets/js/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=0, must-revalidate"\n\n' +
    "# Baseline security headers on every page -- identical policy to\n" +
    "# _headers and vercel.json (see this script's csp/otherHeaders).\n" +
    "[[headers]]\n" +
    '  for = "/*"\n' +
    "  [headers.values]\n" +
    otherHeaders
      .map(function (pair) {
        return "    " + pair[0] + " = " + JSON.stringify(pair[1]) + "\n";
      })
      .join("") +
    "    Content-Security-Policy = " +
    JSON.stringify(csp) +
    "\n\n" +
    "# Sveltia CMS (product editor, see DEVELOPMENT.md section 20) gets its own\n" +
    '# CSP here -- more specific paths win over "/*" on Netlify, so this\n' +
    "# replaces (not adds to) the baseline CSP above for anything under\n" +
    "# /admin/. See the adminCsp comment in this script for what's in it\n" +
    "# and the honest caveat about it not being verified against a live\n" +
    "# GitHub-backed CMS session yet.\n" +
    "[[headers]]\n" +
    '  for = "/admin/*"\n' +
    "  [headers.values]\n" +
    "    Content-Security-Policy = " +
    JSON.stringify(adminCsp) +
    "\n" +
    "    X-Robots-Tag = " +
    JSON.stringify(ADMIN_ROBOTS_TAG) +
    "\n";
  fs.writeFileSync(path.join(ROOT, "netlify.toml"), netlifyToml);
  console.log("wrote netlify.toml");

  console.log("");
  console.log(
    "CSP covers " +
      hashes.length +
      " inline script hash(es). Analytics allows both routes: cloud.umami.is/gateway.umami.is " +
      "direct, falling back to " +
      analyticsProxy.ANALYTICS_PROXY_PREFIX +
      "/ on this domain when a blocker stops the first."
  );
  console.log(
    "IMPORTANT -- this could not be verified against a live checkout in a real browser during"
  );
  console.log(
    "development (sandboxed dev environment had no way to run one against real Stripe keys)."
  );
  console.log(
    "Before relying on this in production: deploy, open the browser console during a real"
  );
  console.log("checkout (add to cart -> /api/checkout -> redirect to Stripe), and check for any");
  console.log(
    "'Refused to ...' CSP violation messages. Note that checkout.stripe.com itself shouldn't"
  );
  console.log(
    "need an entry anywhere above -- it's reached via a top-level window.location redirect,"
  );
  console.log(
    "not a fetch/frame/form-action from this origin -- so a violation there would point at"
  );
  console.log("something unexpected worth investigating rather than a domain to allowlist.");
}

if (require.main === module) {
  run();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractInlineScripts: extractInlineScripts,
    sha256Base64: sha256Base64,
    allPages: allPages,
    readBaseline: readBaseline,
    findUnapprovedHashes: findUnapprovedHashes,
    BASELINE_PATH: BASELINE_PATH,
    BLOCKED_PATHS: BLOCKED_PATHS,
    CLEAN_URL_SKIP: CLEAN_URL_SKIP,
    shippedHtmlPages: shippedHtmlPages,
    cleanUrlRedirects: cleanUrlRedirects,
    analyticsProxyRules: analyticsProxyRules
  };
}
