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

var ROOT = path.join(__dirname, "..");

/* The Cloudflare Worker that answers the cart's checkout POST, and the
   same-origin path the browser actually calls. CHECKOUT_PATH must stay equal
   to CHECKOUT_URL in assets/js/cart.js -- qa-check.js asserts that, since a
   silent mismatch between them breaks checkout with no visible error until
   someone tries to pay. */
var CHECKOUT_PATH = "/api/checkout";
var CHECKOUT_WORKER_URL = "https://yallternative-checkout.y-allternative-living.workers.dev";
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
  "/*.md",
  "/.eslintrc.json",
  "/run-launch-checks.command",
  "/TEST_INFRA.md"
];
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
  "products/backroad-soak.html"
];

/* Every page whose inline scripts the CSP has to cover. The static list
   above is the top-level site; the 19 generated product pages are globbed
   because they are created by build-site-data.js from products.json -- a CMS
   commit can add one, and only backroad-soak.html used to be checked, so an
   inline script on any of the other 18 was hashed by nobody. */
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
  var filePath = path.join(ROOT, page);
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
    // cloud.umami.is: Umami analytics (cookieless page views + the shop's
    // conversion events -- replaced Plausible). See the analytics tag in every
    // page's head.
    // 'inline-speculation-rules': allows the inline speculation-rules block
    // that main.js injects for instant navigations (prerender/prefetch on
    // hover). This keyword ONLY permits speculation-rules scripts -- it does
    // not open up general inline JS execution.
    // Every hash here is computed from a real inline script on a real page
    // and approved in scripts/inline-script-hashes.json. There used to be one
    // more, hardcoded, matching no script on any page in the repository --
    // an allowlist entry for something nobody could point at.
    "script-src 'self' https://cloud.umami.is https://embed.tawk.to https://translate.google.com https://translate.googleapis.com 'inline-speculation-rules' " +
      hashes.join(" "),
    // fonts.googleapis.com: every page's <link> tags pull Cormorant Garamond
    // + Outfit from Google Fonts (see the top-of-file comment in styles.css)
    // -- that stylesheet request needs style-src, and the actual font files
    // it points at come from fonts.gstatic.com, which needs font-src below.
    "style-src 'self' https://fonts.googleapis.com https://translate.googleapis.com 'unsafe-inline'", // main.js/cart.js/gift-card.js/translator.js all set element.style.* directly (display toggles, carousel transforms, etc.); can't pre-hash those, so this directive stays looser on purpose
    "img-src 'self' data: https://*.tawk.to https://translate.google.com https://translate.googleapis.com https://www.google.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Checkout itself never needs an entry here: cart.js POSTs to the
    // same-origin /api/checkout Worker route (covered by 'self'), then
    // does a normal top-level `window.location = url` redirect to Stripe's
    // hosted Checkout page -- full-page navigations aren't governed by
    // connect-src/frame-src/form-action.
    "connect-src 'self' https://cloud.umami.is https://*.tawk.to wss://*.tawk.to https://translate.googleapis.com https://formspree.io https://app.convertkit.com https://app.kit.com",
    "frame-src https://*.tawk.to https://translate.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // 'self' covers the review-submission form once it posts to a same-site
    // endpoint; the two Kit/ConvertKit domains cover the footer newsletter
    // form's real action URL (Kit rebranded from ConvertKit and forms in
    // the wild still resolve to either domain depending on when they were
    // created); formspree.io covers the "Write a Review" form below.
    "form-action 'self' https://app.convertkit.com https://app.kit.com https://formspree.io",
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
      { source: "/admin/(.*)", headers: [{ key: "Content-Security-Policy", value: adminCsp }] }
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
    '  command = "node scripts/optimize-images.js && node scripts/build-site-data.js && node scripts/build-security-headers.js"\n\n' +
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
    "# The Node version for this build is pinned in .nvmrc (Netlify reads that\n" +
    "# ahead of every other source), not here -- one source of truth.\n" +
    "[build.environment]\n" +
    '  NPM_FLAGS = "--include=dev"\n\n' +
    // ---- checkout proxy ----
    // The cart POSTs to a same-origin /api/checkout (assets/js/cart.js's
    // CHECKOUT_URL). The code that answers it is a Cloudflare Worker
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
    // A Cloudflare Worker *Route* on the real domain would remove this hop,
    // but Routes require Cloudflare to run the domain's DNS, and DNS lives at
    // Netlify. Not worth migrating a working site for one endpoint.
    //
    // This block is here rather than hand-written into netlify.toml because
    // this script rewrites that whole file on every deploy -- an edit made
    // directly there would vanish on the next build.
    "[[redirects]]\n" +
    '  from = "' +
    CHECKOUT_PATH +
    '"\n' +
    '  to = "' +
    CHECKOUT_WORKER_URL +
    '"\n' +
    "  status = 200\n" +
    "  force = true\n\n" +
    // Netlify publishes this whole repository, so without these every build
    // script, audit document, Worker source, serverless function and lockfile
    // in the tree is a live URL on the real domain (audit: Medium, SEO/content
    // -- 1.5 MB of scripts/ alone). Netlify applies the first MATCHING rule,
    // and none of these patterns overlap /api/checkout, so they block just as
    // well after it as before it -- and keeping the checkout proxy as the
    // first [[redirects]] block is what qa-check.js's "Checkout proxy" section
    // reads to confirm cart.js and this file still agree on the path.
    // /admin/* is deliberately absent: the CMS has to keep being served.
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
    "# Long-lived caching for hashed/never-changing assets. Pages themselves\n" +
    "# (index.html, shop.html, etc.) intentionally aren't cached long here --\n" +
    "# Netlify already serves them with an ETag + must-revalidate by default,\n" +
    "# so browsers re-check on every visit and always get the latest deploy.\n" +
    "[[headers]]\n" +
    '  for = "/assets/img/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=31536000, immutable"\n\n' +
    "[[headers]]\n" +
    '  for = "/assets/css/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=604800"\n\n' +
    "[[headers]]\n" +
    '  for = "/assets/js/*"\n' +
    "  [headers.values]\n" +
    '    Cache-Control = "public, max-age=604800"\n\n' +
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
    "\n";
  fs.writeFileSync(path.join(ROOT, "netlify.toml"), netlifyToml);
  console.log("wrote netlify.toml");

  console.log("");
  console.log("CSP covers " + hashes.length + " inline script hash(es) + Umami (cloud.umami.is).");
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
    BLOCKED_PATHS: BLOCKED_PATHS
  };
}
