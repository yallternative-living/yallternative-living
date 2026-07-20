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
   allows exactly two inline <script> blocks (the no-flash theme-init
   snippet and the Snipcart settings block) by SHA-256 hash rather than
   the much looser 'unsafe-inline' -- because 'unsafe-inline' defeats
   most of what CSP is actually for. That means every time either
   inline script's *exact text* changes (including the day the real
   Snipcart API key replaces the placeholder), its hash changes too,
   and this needs to be re-run:

     node scripts/build-security-headers.js

   It reads the current inline scripts straight out of index.html
   (verifying they're byte-identical across every page first), hashes
   them, and rewrites _headers + vercel.json to match. Safe to run any
   time; it doesn't touch products, images, or anything else.
   ========================================================== */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.join(__dirname, "..");
var PAGES = [
  "index.html",
  "shop.html",
  "about.html",
  "contact.html",
  "events.html",
  "privacy.html",
  "404.html"
];

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
  if (canonicalScripts.length < 2) {
    throw new Error(
      "Expected at least 2 real inline <script> blocks in index.html (theme-init + Snipcart settings) -- found " +
        canonicalScripts.length +
        ". Aborting so the CSP doesn't get built from stale assumptions."
    );
  }

  // Verify every other page's real inline scripts are byte-identical to
  // index.html's -- if a future edit makes one page's inline script
  // diverge, this needs to be either fixed (keep them identical) or this
  // script needs to be taught about the new hash. Either way, silently
  // shipping a CSP that only covers SOME pages would be worse than
  // failing loudly here.
  var allTexts = {};
  canonicalScripts.forEach(function (s) {
    allTexts[sha256Base64(s)] = s;
  });

  PAGES.slice(1).forEach(function (page) {
    var html = readHtml(page);
    extractInlineScripts(html).forEach(function (s) {
      var h = sha256Base64(s);
      if (!allTexts[h]) {
        throw new Error(
          page +
            " has an inline <script> whose content doesn't match any hash computed from index.html. " +
            "Either make it identical to the corresponding block in index.html, or update this script to hash it too."
        );
      }
    });
  });

  var hashes = Object.keys(allTexts).map(function (h) {
    return "'sha256-" + h + "'";
  });

  var csp = [
    "default-src 'self'",
    // embed.tawk.to: the live-chat widget script (see the placeholder
    // snippet near </body> on every page, task/DEVELOPMENT.md section 19) --
    // it's inert until a real Tawk.to property/widget ID replaces the
    // placeholder, but the origin is allowlisted now so turning it on
    // later doesn't also require touching this file.
    "script-src 'self' https://cdn.snipcart.com https://plausible.io https://embed.tawk.to https://translate.google.com https://translate.googleapis.com " +
      hashes.join(" "),
    // fonts.googleapis.com: every page's <link> tags pull Cormorant Garamond
    // + Outfit from Google Fonts (see the top-of-file comment in styles.css)
    // -- that stylesheet request needs style-src, and the actual font files
    // it points at come from fonts.gstatic.com, which needs font-src below.
    "style-src 'self' https://cdn.snipcart.com https://fonts.googleapis.com https://translate.googleapis.com 'unsafe-inline'", // Snipcart's cart UI injects its own inline styles at runtime; can't pre-hash unknown/dynamic values, so this one directive stays looser on purpose
    "img-src 'self' data: https://cdn.snipcart.com https://*.tawk.to https://translate.google.com https://translate.googleapis.com https://www.google.com",
    "font-src 'self' https://cdn.snipcart.com https://fonts.gstatic.com",
    "connect-src 'self' https://*.snipcart.com https://plausible.io https://*.tawk.to wss://*.tawk.to https://translate.googleapis.com",
    "frame-src https://*.snipcart.com https://*.tawk.to https://translate.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // 'self' covers the review-submission form once it posts to a same-site
    // endpoint; the two Kit/ConvertKit domains cover the footer newsletter
    // form's real action URL (Kit rebranded from ConvertKit and forms in
    // the wild still resolve to either domain depending on when they were
    // created); formspree.io covers the "Write a Review" form below.
    "form-action 'self' https://*.snipcart.com https://app.convertkit.com https://app.kit.com https://formspree.io",
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
  // statically) -- so treat this the same as the Snipcart-payment-gateway
  // and Gift Up! caveats elsewhere in this project: once a real GitHub
  // repo + OAuth setup exists (see DEVELOPMENT.md section 20), open the browser
  // console while using /admin and watch for "Refused to connect/load..."
  // CSP errors, then add whatever origin they name here and re-run this
  // script.
  var adminCsp = [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.githubusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://unpkg.com https://api.github.com https://*.githubusercontent.com",
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
    [
      "Permissions-Policy",
      'geolocation=(), microphone=(), camera=(), usb=(), payment=(self "https://cdn.snipcart.com")'
    ],
    // HSTS is safe to ship now (only takes effect over real HTTPS, which
    // every realistic static host serves by default) but actually being
    // added to browsers' preload list is a separate, manual step at
    // https://hstspreload.org once the domain is live and stable.
    ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
    // same-origin-allow-popups (not the stricter same-origin) so it
    // doesn't sever window.opener for any Snipcart checkout step that
    // opens a payment step in a popup -- still isolates this page's
    // browsing context group from unrelated cross-origin openers.
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
    buildCommand: "node scripts/build-site-data.js && node scripts/build-security-headers.js",
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
    '  command = "node scripts/build-site-data.js && node scripts/build-security-headers.js"\n\n' +
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
  console.log(
    "CSP covers " +
      hashes.length +
      " inline script hash(es) + Snipcart (cdn.snipcart.com) + Plausible (plausible.io)."
  );
  console.log(
    "IMPORTANT -- this could not be verified against a live checkout in a real browser during"
  );
  console.log(
    "development (sandboxed dev environment had no way to run one). Before relying on this in"
  );
  console.log(
    "production: deploy, open the browser console during a real Snipcart checkout, and check for"
  );
  console.log(
    "any 'Refused to ...' CSP violation messages -- add whatever origin they name (most likely a"
  );
  console.log(
    "payment gateway iframe domain, once one is configured in the Snipcart dashboard) to frame-src"
  );
  console.log(
    "and/or connect-src above, then re-run this script... actually just hand-edit the two files,"
  );
  console.log("since a manually-added origin isn't something this script's own logic derives.");
}

run();
