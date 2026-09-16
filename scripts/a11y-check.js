/**
 * @fileoverview Accessibility regression gate (axe-core, WCAG 2.2 AA).
 *
 * Every page on the site currently scans clean, so this asserts exactly that:
 * zero violations, on every top-level page and every generated product page.
 * It runs as part of `npm run test:integration`, which is the difference
 * between "we audited it once" and "it stays that way" -- scripts/run_audit.js
 * produces a much richer report, but it's a hand-run tool wired into no npm
 * script, so a regression could sit on the live site indefinitely.
 *
 * The tag list deliberately includes the wcag21 and wcag22aa tags. Scanning
 * wcag2a/wcag2aa alone
 * silently skipped everything added after WCAG 2.0 -- which is how 10px photo
 * gallery dots (2.5.8 target-size, serious) went unnoticed on all 19 product
 * pages.
 *
 * Every page is scanned once per THEME. styles.css defines a dark and a light
 * palette and the site ships an inline blocking script that stamps
 * data-theme on <html>, so a single scan only ever exercised whichever theme
 * headless Chromium happened to resolve (light, since prefers-color-scheme
 * defaults to light in a headless profile). Half the palette was therefore
 * ungated: a colour-contrast regression in dark mode could ship green. Both
 * themes are asserted here, so 37 pages means 74 scans.
 *
 * A second phase then scans INTERACTIVE STATES at 390x844 (see
 * INTERACTIVE_STATES). Everything above only ever looked at a page at rest at
 * the default viewport, and three real failures shipped straight through that
 * blind spot in one audit: the cart drawer's dead keyboard path, a background
 * that was never inert behind an aria-modal dialog, and a 3.59:1 "More"
 * heading that only exists once main.js has appended it and is only displayed
 * below 1024px with the nav drawer open. A gate that cannot open a menu
 * cannot see any of that.
 *
 * Each interactive state names the element it opens and ASSERTS that element
 * is present before it scans: an absent opener fails the run by name. That is
 * deliberate and non-negotiable (AGENTS.md "Checks that stop checking") --
 * a state scan that quietly finds nothing to open would report the greenest
 * possible result for a page whose menu had been deleted.
 *
 * Manages its own static server on port 8084, so nothing external needs to be
 * running first.
 *
 * Run: node scripts/a11y-check.js
 */

/* global document, window */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 8084;
const ROOT = path.resolve(__dirname, "..");

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/* The two palettes styles.css defines. Scanned by stamping data-theme on
   <html> -- the same attribute the site's own inline theme script sets -- so
   axe resolves the real computed colours for each. */
const THEMES = ["dark", "light"];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

function createStaticServer(port) {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, "127.0.0.1", () => resolve(server));
      } else {
        reject(err);
      }
    });
  });
}

/* The budget for one "<page> [<theme>]" label: its own entry, else the
   generated-directory entry ("journal/*.html [dark]") for a page under that
   directory, else the default. */
function baselineFor(label) {
  if (Object.prototype.hasOwnProperty.call(INCOMPLETE_BASELINE, label)) {
    return INCOMPLETE_BASELINE[label];
  }
  const m = /^([^/]+)\/[^ ]+\.html (\[\w+\])$/.exec(label);
  const wildcard = m ? `${m[1]}/*.html ${m[2]}` : null;
  if (wildcard && Object.prototype.hasOwnProperty.call(INCOMPLETE_BASELINE, wildcard)) {
    return INCOMPLETE_BASELINE[wildcard];
  }
  return INCOMPLETE_BASELINE_DEFAULT;
}

function collectPages() {
  const top = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  // Generated pages: one per product and one per journal post.
  const generated = ["products", "journal"].flatMap((sub) => {
    const dir = path.join(ROOT, sub);
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".html"))
          .map((f) => `${sub}/${f}`)
      : [];
  });
  return top.sort().concat(generated.sort());
}

/* Per-scan budget for axe results that axe itself could not decide. Measured,
   not guessed: every entry below was read off a full run. The default applies
   to any page not named. Raising a number here is a claim that a new piece of
   the UI cannot be machine-checked -- make it deliberately, with a reason. */
const INCOMPLETE_BASELINE_DEFAULT = 0;
/* 2026-09-02: every scan carrying the language picker rose by exactly one
   node: the toggle gained aria-controls="langDropdown" (audit fix 14), and
   axe reports "unable to determine if aria-controls referenced ID exists
   while using aria-haspopup" as needs-review, the same verdict it already
   gives #globalSearchTrigger. The dropdown is in the DOM at init, so the
   reference is valid; the numbers below were re-read off a full run. */
const INCOMPLETE_BASELINE = {
  "404.html [dark]": 11,
  "404.html [light]": 11,
  "about.html [dark]": 14,
  "about.html [light]": 14,
  "contact.html [dark]": 17,
  "contact.html [light]": 17,
  /* events.html scales with the CMS data: every event card renders a row of
     action buttons whose contrast axe cannot decide over the card gradient
     (one undecidable node per button, measured 2026-09-04: 19 buttons, 38
     nodes, 19 of them page chrome). A flat number here turned CI red the
     day four September pop-ups were added -- exactly the edit the owner
     makes without a developer -- so the pin is a base for the page chrome
     plus one node per rendered button. Adding an event never moves it;
     a new undecidable element on the page still does. */
  "events.html [dark]": {
    base: 19,
    perElement: [{ selector: ".event-actions-row .btn", allowance: 1 }]
  },
  "events.html [light]": {
    base: 19,
    perElement: [{ selector: ".event-actions-row .btn", allowance: 1 }]
  },
  "faq.html [dark]": 11,
  "faq.html [light]": 11,
  /* index.html: scales with UGC social feed cards (each .ugc-card renders a
     media badge over the image whose contrast axe cannot decide, exactly
     as for event/journal cards: 40 base chrome + 1 per rendered card). */
  "index.html [dark]": {
    base: 40,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "index.html [light]": {
    base: 40,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  /* journal.html scales with the posts, the same way events.html scales with
     its cards: each post card renders a "Read Post" outline button whose
     contrast axe cannot decide over its pseudo-element (measured 2026-09-09
     when the Journal was switched on: 11 chrome nodes + 1 per post). */
  "journal.html [dark]": {
    base: 11,
    perElement: [{ selector: "#journalApp .btn", allowance: 1 }]
  },
  "journal.html [light]": {
    base: 11,
    perElement: [{ selector: "#journalApp .btn", allowance: 1 }]
  },
  /* The journal post pages (journal/<slug>.html) are one entry per THEME,
     not per post: a post is written in the CMS, and a gate that needed a
     hand-added line for every new article would fail every publish. All
     four current scans measure the same 8 nodes -- the search trigger's
     aria-controls (as on every page) and the header/language-picker
     contrast axe cannot resolve -- with no post-specific node, so the
     budget is the page chrome. Measured 2026-09-09. */
  "journal/*.html [dark]": 8,
  "journal/*.html [light]": 8,
  "offline.html [dark]": 2,
  "offline.html [light]": 2,
  "order-status.html [dark]": 7,
  "order-status.html [light]": 7,
  /* orders.html: the passwordless order history. Same chrome as
     order-status.html and the same seven undecidable nodes (the header
     controls and the form button over the card gradient); measured 2026-09-09. */
  "orders.html [dark]": 7,
  "orders.html [light]": 7,
  "policies.html [dark]": 19,
  "policies.html [light]": 19,
  "privacy.html [dark]": 19,
  "privacy.html [light]": 19,
  "products/backroad-soak.html [dark]": 18,
  "products/backroad-soak.html [light]": 18,
  "products/bath-tea.html [dark]": 9,
  "products/bath-tea.html [light]": 9,
  "products/beard-salve.html [dark]": 15,
  "products/beard-salve.html [light]": 15,
  "products/bug-spray.html [dark]": 21,
  "products/bug-spray.html [light]": 21,
  "products/cleansing-spray.html [dark]": 13,
  "products/cleansing-spray.html [light]": 13,
  "products/cream-deodorant.html [dark]": 18,
  "products/cream-deodorant.html [light]": 18,
  "products/frankincense-salve.html [dark]": 26,
  "products/frankincense-salve.html [light]": 26,
  "products/hand-scrub.html [dark]": 24,
  "products/hand-scrub.html [light]": 24,
  "products/lavender-soak.html [dark]": 19,
  "products/lavender-soak.html [light]": 19,
  "products/miracle-balm.html [dark]": 19,
  "products/miracle-balm.html [light]": 19,
  "products/porch-sweep-spray.html [dark]": 16,
  "products/porch-sweep-spray.html [light]": 16,
  "products/protection-keychain.html [dark]": 22,
  "products/protection-keychain.html [light]": 22,
  "products/shea-butter.html [dark]": 22,
  "products/shea-butter.html [light]": 22,
  "products/shimmer-oil.html [dark]": 17,
  "products/shimmer-oil.html [light]": 17,
  "products/sleep-salve.html [dark]": 22,
  "products/sleep-salve.html [light]": 22,
  "products/sugar-scrub.html [dark]": 19,
  "products/sugar-scrub.html [light]": 19,
  "products/tank-top.html [dark]": 17,
  "products/tank-top.html [light]": 17,
  "products/unisex-tshirt.html [dark]": 17,
  "products/unisex-tshirt.html [light]": 17,
  "products/whipped-body-butter.html [dark]": 18,
  "products/whipped-body-butter.html [light]": 18,
  "products/yallternative-gift-card.html [dark]": 16,
  "products/yallternative-gift-card.html [light]": 16,
  "reviews.html [dark]": 40,
  "reviews.html [light]": 40,
  "safety.html [dark]": 13,
  "safety.html [light]": 13,
  /* shop.html: scales with UGC cards: 107 base chrome + 1 per rendered card */
  "shop.html [dark]": {
    base: 107,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "shop.html [light]": {
    base: 107,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "terms.html [dark]": 19,
  "terms.html [light]": 19,
  /* +1 on 2026-09-09: the "All Your Orders" outline button beside "Keep
     Shopping", whose contrast axe cannot decide over the gradient exactly as
     it cannot for the button next to it. */
  "thank-you.html [dark]": 16,
  "thank-you.html [light]": 16,
  "welcome.html [dark]": 14,
  "welcome.html [light]": 14
};

/* ---------------------------------------------------------------------------
   Phase 2: interactive states.

   Phase 1 loads a page and scans it exactly as it arrives. Most of this site's
   accessibility surface is not on screen at that moment -- the nav drawer, the
   cart drawer -- and the 2026-09-16 audit found three real failures living in
   precisely that gap. So: a second, much smaller pass at a phone viewport that
   OPENS things first.

   The viewport matters on its own. `.nav-secondary` is `display: none` above
   1024px, so the "More" heading whose contrast failed at 3.59:1 does not exist
   in a layout sense at the default size -- axe would have found nothing to
   measure however many times phase 1 ran.

   Each entry's `open` runs in the page and must THROW if the thing it is
   supposed to open is not there. That throw fails the whole gate, by name.
   The temptation with a state scan is to write `const t = document.querySelector(
   ".nav-toggle"); if (t) t.click();` -- which turns into a green scan of a
   closed page the day the selector changes, i.e. a check that has stopped
   checking (AGENTS.md). `assertPresent` below is the only way to reach an
   element here. */
const INTERACTIVE_VIEWPORT = { width: 390, height: 844 };

const OPEN_HELPERS = `
  function assertPresent(selector, what) {
    var el = document.querySelector(selector);
    if (!el) throw new Error("expected " + what + " (" + selector + ") -- not on the page");
    return el;
  }
  function assertAll(selector, min, what) {
    var els = document.querySelectorAll(selector);
    if (els.length < min) {
      throw new Error(
        "expected at least " + min + " " + what + " (" + selector + "), found " + els.length
      );
    }
    return els;
  }
`;

const INTERACTIVE_STATES = [
  {
    /* The mobile layout at rest. Cheap, and it is the control the two states
       below are read against: a violation that shows up here is a layout
       problem, not something the opening did. */
    name: "mobile @390",
    pages: ["index.html", "shop.html"],
    settle: 300,
    open: `
      ${OPEN_HELPERS}
      assertPresent(".nav-toggle", "the mobile nav toggle");
      assertPresent(".cart-toggle", "the cart button");
      return "at rest";
    `
  },
  {
    name: "nav open @390",
    pages: ["index.html", "shop.html"],
    settle: 400,
    open: `
      ${OPEN_HELPERS}
      var toggle = assertPresent(".nav-toggle", "the mobile nav toggle");
      if (!document.querySelector(".nav-links.open")) toggle.click();
      assertPresent(".nav-links.open", "the nav panel, open");
      /* main.js appends these three and their "More" heading at init. The
         heading is the element whose light-theme contrast failed; asserting it
         is what stops this scan going green over a drawer that no longer has
         it. */
      assertPresent(".nav-secondary-heading", "the nav drawer's More heading");
      assertAll(".nav-secondary a", 3, "secondary nav links");
      return "nav open";
    `
  },
  {
    name: "cart drawer open @390",
    pages: ["shop.html", "products/miracle-balm.html"],
    settle: 700,
    open: `
      ${OPEN_HELPERS}
      /* An item, then the drawer -- an EMPTY drawer renders a sentence and one
         button and would scan clean while the 18 controls that matter (the
         quantity steppers, Remove, the gift-card and promo forms, Checkout)
         were never built. */
      var add = assertPresent(".yl-add-item, [data-yl-add]", "an Add to Cart button");
      add.click();
      var drawer = assertPresent("#yl-cart-drawer", "the cart drawer");
      if (!drawer.matches(":popover-open") && drawer.getAttribute("data-open") !== "true") {
        throw new Error("the cart drawer did not open after Add to Cart");
      }
      assertAll("#yl-cart-drawer .yl-cart-line", 1, "cart lines in the open drawer");
      assertPresent("#yl-cart-drawer .yl-cart-checkout", "the drawer's Checkout button");
      return "drawer open, " + document.querySelectorAll(
        "#yl-cart-drawer button, #yl-cart-drawer a[href], #yl-cart-drawer input," +
        " #yl-cart-drawer select, #yl-cart-drawer textarea"
      ).length + " controls";
    `
  }
];

/* Budgets for the phase-2 labels, same contract as INCOMPLETE_BASELINE: read
   off a real run, never guessed, and a rise is a new blind spot to look at
   rather than a number to bump. */
const INTERACTIVE_INCOMPLETE_BASELINE = {
  /* The mobile-at-rest scans carry the same page chrome as the phase-1 pass
     and scale with the UGC feed the same way (6 cards on both pages, each
     with one media badge axe cannot resolve), so they take the same object
     form. The bases differ from phase 1's because a 390px layout composites
     a different set of overlays: index 37 (vs 40 at the default viewport),
     shop 112 (vs 107). Measured 2026-09-16. */
  "index.html [dark] {mobile @390}": {
    base: 37,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "index.html [light] {mobile @390}": {
    base: 37,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "shop.html [dark] {mobile @390}": {
    base: 112,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  "shop.html [light] {mobile @390}": {
    base: 112,
    perElement: [{ selector: ".ugc-card", allowance: 1 }]
  },
  /* With a drawer open the counts COLLAPSE, and that is expected rather than
     suspicious: the panel covers the page and axe stops trying to resolve the
     contrast of content it can see is obscured. What is left is the drawer's
     own chrome. If one of these ever climbs back towards the at-rest number,
     the drawer has stopped covering the page -- which is itself worth
     looking at. Measured 2026-09-16. */
  "index.html [dark] {nav open @390}": 3,
  "index.html [light] {nav open @390}": 3,
  "shop.html [dark] {nav open @390}": 4,
  "shop.html [light] {nav open @390}": 4,
  "shop.html [dark] {cart drawer open @390}": 6,
  "shop.html [light] {cart drawer open @390}": 6,
  "products/miracle-balm.html [dark] {cart drawer open @390}": 5,
  "products/miracle-balm.html [light] {cart drawer open @390}": 5
};
const INTERACTIVE_INCOMPLETE_DEFAULT = 0;

function interactiveBaselineFor(label) {
  if (Object.prototype.hasOwnProperty.call(INTERACTIVE_INCOMPLETE_BASELINE, label)) {
    return INTERACTIVE_INCOMPLETE_BASELINE[label];
  }
  return INTERACTIVE_INCOMPLETE_DEFAULT;
}

/* Phase-2 labels carry a "{state}" suffix; phase-1 labels do not. The final
   budget sweep walks one map of every label, so it has to ask the right
   table -- feeding an interactive label to baselineFor() would silently pin
   it at the phase-1 default. */
function budgetFor(label) {
  return /\{[^}]+\}$/.test(label) ? interactiveBaselineFor(label) : baselineFor(label);
}

/* Runs axe on whatever is currently on `page` and records the result under
   `label`. Shared by both phases so they cannot drift apart. Returns the
   number of violations found. */
async function scanAndRecord(page, label, axeSource, incompleteByPage, pin) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, { runOnly: { type: "tag", values: tags } });
  }, AXE_TAGS);

  const incomplete = result.incomplete || [];
  const incompleteNodes = incomplete.reduce((n, v) => n + v.nodes.length, 0);
  incompleteByPage[label] = {
    rules: incomplete.map((v) => v.id).sort(),
    nodes: incompleteNodes,
    extra: 0
  };
  if (pin && typeof pin === "object") {
    const counts = await page.evaluate(
      (selectors) => selectors.map((sel) => document.querySelectorAll(sel).length),
      pin.perElement.map((e) => e.selector)
    );
    incompleteByPage[label].extra = counts.reduce(
      (n, c, i) => n + c * pin.perElement[i].allowance,
      0
    );
  }
  if (incomplete.length) {
    console.log(
      `  ~ ${label} -- ${incompleteNodes} node(s) axe could not decide, ` +
        `across ${incomplete.length} rule(s): ${incomplete
          .map((v) => v.id)
          .sort()
          .join(", ")}`
    );
  }

  if (!result.violations.length) return 0;
  console.log(`  ✗ ${label} -- ${result.violations.length} violation(s):`);
  result.violations.forEach((v) => {
    console.log(`      [${v.impact}] ${v.id}: ${v.help}`);
    console.log(`        ${v.helpUrl}`);
    v.nodes.slice(0, 5).forEach((n) => console.log(`        -> ${n.target.join(", ")}`));
    if (v.nodes.length > 5) {
      console.log(`        -> ...and ${v.nodes.length - 5} more node(s)`);
    }
  });
  return result.violations.length;
}

(async () => {
  const pages = collectPages();
  if (!pages.length) {
    console.error("No HTML pages found to scan -- aborting rather than reporting a false pass.");
    process.exit(1);
  }

  /* An empty or page-less state list would make phase 2 a no-op that still
     printed a pass, which is the exact failure mode AGENTS.md catalogues. */
  const interactiveScanCount = INTERACTIVE_STATES.reduce((n, st) => n + st.pages.length, 0);
  if (!INTERACTIVE_STATES.length || !interactiveScanCount) {
    console.error("No interactive states to scan -- aborting rather than reporting a false pass.");
    process.exit(1);
  }

  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const server = await createStaticServer(PORT);
  const boundPort = server.address().port;
  console.log(
    `Starting Accessibility Gate (axe-core, WCAG 2.2 AA) on ${pages.length} pages ` +
      `x ${THEMES.length} themes (${pages.length * THEMES.length} scans), plus ` +
      `${interactiveScanCount * THEMES.length} interactive-state scans...`
  );

  let browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  let violationCount = 0;
  /* label -> { rules: [...], nodes: n }, filled in the scan loop and checked
     against INCOMPLETE_BASELINE once every page has been scanned. */
  const incompleteByPage = {};

  try {
    for (const pageName of pages) {
      for (const theme of THEMES) {
        if (!browser.connected) {
          browser = await puppeteer.launch({
            headless: true,
            protocolTimeout: 120000,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-gpu"
            ]
          });
        }
        /* A fresh page per theme, with the theme seeded before the document
           loads. Flipping data-theme on an already-scanned page and re-running
           axe does NOT work: axe-core caches resolved ancestor background
           colours across runs in the same document, so the second run pairs the
           new theme's foreground with the previous theme's background and
           reports ~65 bogus colour-contrast failures per page. Seeding the same
           localStorage key the site's own no-flash bootstrap reads also means
           the theme is in place before first paint, exactly as in a real visit. */
        let scanned = false;
        let attempts = 0;
        while (!scanned && attempts < 3) {
          attempts++;
          if (!browser.connected) {
            browser = await puppeteer.launch({
              headless: true,
              protocolTimeout: 120000,
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu"
              ]
            });
          }
          const page = await browser.newPage();
          try {
            await page.evaluateOnNewDocument((t) => {
              try {
                window.localStorage.setItem("yl-theme", t);
              } catch {
                /* storage unavailable -- the attribute set after load still applies */
              }
            }, theme);

            await page.goto(`http://127.0.0.1:${boundPort}/${pageName}`, {
              waitUntil: "networkidle2",
              timeout: 30000
            });
            await page.evaluate((t) => {
              document.documentElement.setAttribute("data-theme", t);
            }, theme);
            const label = `${pageName} [${theme}]`;

            /* axe "incomplete" results are checks axe could not finish, not
               checks that passed. This gate only ever failed on `violations`,
               so they were invisible -- and the language selector put 7 nodes
               permanently into that bucket: its .lang-dropdown composites a
               backdrop-filter over an rgba() background, and axe reports
               "background colour could not be determined because it is
               overlapped by another element" rather than a contrast number.
               Seven nodes of the picker's own contrast were therefore outside
               the gate entirely, in both themes.

               Incompletes are reported, never failed on: axe cannot decide
               them, so neither can this script, and failing on an undecidable
               result would be a gate that lies in the other direction. What IS
               enforced is that the count does not grow -- a new incomplete is
               a new blind spot, and the baseline below is what makes adding
               one a deliberate act rather than an accident.

               A pin may be an object: a base for the page chrome plus an
               allowance per element matching a selector, for pages whose node
               count follows CMS data (see the events.html entry). */
            const found = await scanAndRecord(
              page,
              label,
              axeSource,
              incompleteByPage,
              baselineFor(label)
            );
            if (found) violationCount += found;
            else console.log(`  ✓ ${label}`);
            scanned = true;
          } catch (err) {
            if (attempts >= 3) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, 200));
          } finally {
            await page.close().catch(() => {});
          }
        }
      }
    }

    /* ---- Phase 2: interactive states (see INTERACTIVE_STATES above) ---- */
    console.log(
      `\nScanning ${interactiveScanCount} interactive-state view(s) at ` +
        `${INTERACTIVE_VIEWPORT.width}x${INTERACTIVE_VIEWPORT.height} ` +
        `(${INTERACTIVE_STATES.length} state(s) x ${THEMES.length} themes)...`
    );
    for (const state of INTERACTIVE_STATES) {
      for (const pageName of state.pages) {
        if (!fs.existsSync(path.join(ROOT, pageName))) {
          throw new Error(
            `Interactive state "${state.name}" names ${pageName}, which does not exist. ` +
              "Point it at a page that does rather than letting the state go unscanned."
          );
        }
        for (const theme of THEMES) {
          if (!browser.connected) {
            browser = await puppeteer.launch({
              headless: true,
              protocolTimeout: 120000,
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu"
              ]
            });
          }
          const label = `${pageName} [${theme}] {${state.name}}`;
          const page = await browser.newPage();
          try {
            await page.setViewport(INTERACTIVE_VIEWPORT);
            await page.evaluateOnNewDocument((t) => {
              try {
                window.localStorage.setItem("yl-theme", t);
              } catch {
                /* storage unavailable -- the attribute set after load still applies */
              }
            }, theme);
            await page.goto(`http://127.0.0.1:${boundPort}/${pageName}`, {
              waitUntil: "networkidle2",
              timeout: 30000
            });
            await page.evaluate((t) => {
              document.documentElement.setAttribute("data-theme", t);
            }, theme);

            /* If this throws -- because the toggle, the panel, the Add to Cart
               button or the drawer's own contents are not there -- the whole
               gate fails with the message, by name. It is never caught and
               downgraded to a skip. */
            let note;
            try {
              note = await page.evaluate(`(function () {${state.open}})()`);
            } catch (err) {
              throw new Error(
                `Interactive state "${state.name}" could not be reached on ${label}: ` +
                  `${err.message}`
              );
            }
            await new Promise((r) => setTimeout(r, state.settle || 300));

            const found = await scanAndRecord(
              page,
              label,
              axeSource,
              incompleteByPage,
              interactiveBaselineFor(label)
            );
            if (found) violationCount += found;
            else console.log(`  ✓ ${label} -- ${note}`);
          } finally {
            await page.close().catch(() => {});
          }
        }
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  }

  /* Incomplete budget. Reported above per page, enforced here in aggregate:
     any page whose undecidable-node count exceeds its pin fails the run, so a
     new blind spot has to be looked at and re-pinned rather than absorbed. */
  const overBudget = [];
  Object.keys(incompleteByPage)
    .sort()
    .forEach((label) => {
      const seen = incompleteByPage[label].nodes;
      const pin = budgetFor(label);
      const budget =
        pin && typeof pin === "object" ? pin.base + incompleteByPage[label].extra : pin;
      if (seen > budget) {
        overBudget.push(
          `${label}: ${seen} node(s) axe could not decide, baseline ${budget} ` +
            `(rules: ${incompleteByPage[label].rules.join(", ") || "none"})`
        );
      }
    });
  const totalIncomplete = Object.keys(incompleteByPage).reduce(
    (n, k) => n + incompleteByPage[k].nodes,
    0
  );
  const scansWithIncomplete = Object.keys(incompleteByPage).filter(
    (k) => incompleteByPage[k].nodes > 0
  ).length;

  console.log("\n==================================================");
  console.log(
    `Incomplete (axe could not decide): ${totalIncomplete} node(s) across ` +
      `${scansWithIncomplete} of ${Object.keys(incompleteByPage).length} scans. ` +
      "These are not failures; the budget below is what keeps them from growing."
  );
  if (overBudget.length) {
    console.log("\nIncomplete budget EXCEEDED:");
    overBudget.forEach((line) => console.log(`  - ${line}`));
    console.log(
      "\nLook at what axe stopped being able to measure, fix it if it is real, " +
        "and only then raise INCOMPLETE_BASELINE in scripts/a11y-check.js."
    );
    console.log("==================================================");
    process.exit(1);
  }

  const scanTotal = Object.keys(incompleteByPage).length;
  if (violationCount) {
    console.log(
      `Accessibility gate FAILED: ${violationCount} violation(s) across ${scanTotal} scans ` +
        `(${pages.length} pages x ${THEMES.length} themes, plus ` +
        `${interactiveScanCount * THEMES.length} interactive-state scans).`
    );
    console.log("==================================================");
    process.exit(1);
  }
  console.log(
    `Accessibility gate PASSED: 0 violations across ${scanTotal} scans ` +
      `(${pages.length} pages x ${THEMES.length} themes, plus ` +
      `${interactiveScanCount * THEMES.length} interactive-state scans).`
  );
  console.log("==================================================");
  process.exit(0);
})().catch((err) => {
  console.error("Accessibility gate crashed:", err);
  process.exit(1);
});
