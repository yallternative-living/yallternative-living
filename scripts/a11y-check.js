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
 * themes are asserted here, so 34 pages means 68 scans.
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

function collectPages() {
  const top = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  const productsDir = path.join(ROOT, "products");
  const products = fs.existsSync(productsDir)
    ? fs
        .readdirSync(productsDir)
        .filter((f) => f.endsWith(".html"))
        .map((f) => `products/${f}`)
    : [];
  return top.sort().concat(products.sort());
}

/* Per-scan budget for axe results that axe itself could not decide. Measured,
   not guessed: every entry below was read off a full run. The default applies
   to any page not named. Raising a number here is a claim that a new piece of
   the UI cannot be machine-checked -- make it deliberately, with a reason. */
const INCOMPLETE_BASELINE_DEFAULT = 0;
const INCOMPLETE_BASELINE = {
  "404.html [dark]": 10,
  "404.html [light]": 10,
  "about.html [dark]": 13,
  "about.html [light]": 13,
  "contact.html [dark]": 16,
  "contact.html [light]": 16,
  "events.html [dark]": 21,
  "events.html [light]": 21,
  "faq.html [dark]": 10,
  "faq.html [light]": 10,
  "index.html [dark]": 38,
  "index.html [light]": 38,
  "journal.html [dark]": 10,
  "journal.html [light]": 10,
  "offline.html [dark]": 2,
  "offline.html [light]": 2,
  "order-status.html [dark]": 6,
  "order-status.html [light]": 6,
  "policies.html [dark]": 18,
  "policies.html [light]": 18,
  "privacy.html [dark]": 18,
  "privacy.html [light]": 18,
  "products/backroad-soak.html [dark]": 17,
  "products/backroad-soak.html [light]": 17,
  "products/bath-tea.html [dark]": 8,
  "products/bath-tea.html [light]": 8,
  "products/beard-salve.html [dark]": 14,
  "products/beard-salve.html [light]": 14,
  "products/bug-spray.html [dark]": 20,
  "products/bug-spray.html [light]": 20,
  "products/cleansing-spray.html [dark]": 12,
  "products/cleansing-spray.html [light]": 12,
  "products/cream-deodorant.html [dark]": 17,
  "products/cream-deodorant.html [light]": 17,
  "products/frankincense-salve.html [dark]": 25,
  "products/frankincense-salve.html [light]": 25,
  "products/hand-scrub.html [dark]": 23,
  "products/hand-scrub.html [light]": 23,
  "products/lavender-soak.html [dark]": 18,
  "products/lavender-soak.html [light]": 18,
  "products/miracle-balm.html [dark]": 18,
  "products/miracle-balm.html [light]": 18,
  "products/porch-sweep-spray.html [dark]": 15,
  "products/porch-sweep-spray.html [light]": 15,
  "products/protection-keychain.html [dark]": 21,
  "products/protection-keychain.html [light]": 21,
  "products/shea-butter.html [dark]": 21,
  "products/shea-butter.html [light]": 21,
  "products/shimmer-oil.html [dark]": 16,
  "products/shimmer-oil.html [light]": 16,
  "products/sleep-salve.html [dark]": 21,
  "products/sleep-salve.html [light]": 21,
  "products/sugar-scrub.html [dark]": 18,
  "products/sugar-scrub.html [light]": 18,
  "products/tank-top.html [dark]": 16,
  "products/tank-top.html [light]": 16,
  "products/unisex-tshirt.html [dark]": 16,
  "products/unisex-tshirt.html [light]": 16,
  "products/whipped-body-butter.html [dark]": 17,
  "products/whipped-body-butter.html [light]": 17,
  "products/yallternative-gift-card.html [dark]": 15,
  "products/yallternative-gift-card.html [light]": 15,
  "reviews.html [dark]": 39,
  "reviews.html [light]": 39,
  "safety.html [dark]": 12,
  "safety.html [light]": 12,
  "shop.html [dark]": 104,
  "shop.html [light]": 104,
  "terms.html [dark]": 18,
  "terms.html [light]": 18,
  "thank-you.html [dark]": 14,
  "thank-you.html [light]": 14,
  "welcome.html [dark]": 13,
  "welcome.html [light]": 13
};

(async () => {
  const pages = collectPages();
  if (!pages.length) {
    console.error("No HTML pages found to scan -- aborting rather than reporting a false pass.");
    process.exit(1);
  }

  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const server = await createStaticServer(PORT);
  const boundPort = server.address().port;
  console.log(
    `Starting Accessibility Gate (axe-core, WCAG 2.2 AA) on ${pages.length} pages ` +
      `x ${THEMES.length} themes (${pages.length * THEMES.length} scans)...`
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
            await page.evaluate(axeSource);
            const result = await page.evaluate(async (tags) => {
              // eslint-disable-next-line no-undef
              return await axe.run(document, { runOnly: { type: "tag", values: tags } });
            }, AXE_TAGS);

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
               one a deliberate act rather than an accident. */
            const incomplete = result.incomplete || [];
            const incompleteNodes = incomplete.reduce((n, v) => n + v.nodes.length, 0);
            incompleteByPage[label] = {
              rules: incomplete.map((v) => v.id).sort(),
              nodes: incompleteNodes
            };
            if (incomplete.length) {
              console.log(
                `  ~ ${label} -- ${incompleteNodes} node(s) axe could not decide, ` +
                  `across ${incomplete.length} rule(s): ${incomplete
                    .map((v) => v.id)
                    .sort()
                    .join(", ")}`
              );
            }

            if (!result.violations.length) {
              console.log(`  ✓ ${label}`);
            } else {
              violationCount += result.violations.length;
              console.log(`  ✗ ${label} -- ${result.violations.length} violation(s):`);
              result.violations.forEach((v) => {
                console.log(`      [${v.impact}] ${v.id}: ${v.help}`);
                console.log(`        ${v.helpUrl}`);
                v.nodes
                  .slice(0, 5)
                  .forEach((n) => console.log(`        -> ${n.target.join(", ")}`));
                if (v.nodes.length > 5) {
                  console.log(`        -> ...and ${v.nodes.length - 5} more node(s)`);
                }
              });
            }
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
      const budget = Object.prototype.hasOwnProperty.call(INCOMPLETE_BASELINE, label)
        ? INCOMPLETE_BASELINE[label]
        : INCOMPLETE_BASELINE_DEFAULT;
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

  if (violationCount) {
    console.log(
      `Accessibility gate FAILED: ${violationCount} violation(s) across ${pages.length} pages ` +
        `x ${THEMES.length} themes.`
    );
    console.log("==================================================");
    process.exit(1);
  }
  console.log(
    `Accessibility gate PASSED: 0 violations across ${pages.length} pages x ${THEMES.length} themes.`
  );
  console.log("==================================================");
  process.exit(0);
})().catch((err) => {
  console.error("Accessibility gate crashed:", err);
  process.exit(1);
});
