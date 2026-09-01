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
 * Manages its own static server on port 8084, so nothing external needs to be
 * running first.
 *
 * Run: node scripts/a11y-check.js
 */

/* global document */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 8084;
const ROOT = path.resolve(__dirname, "..");

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

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
    server.on("error", reject);
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

(async () => {
  const pages = collectPages();
  if (!pages.length) {
    console.error("No HTML pages found to scan -- aborting rather than reporting a false pass.");
    process.exit(1);
  }

  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const server = await createStaticServer(PORT);
  console.log(`Starting Accessibility Gate (axe-core, WCAG 2.2 AA) on ${pages.length} pages...`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  let violationCount = 0;

  try {
    for (const pageName of pages) {
      const page = await browser.newPage();
      try {
        /* networkidle2, like the rest of the integration suite: the pages
           preconnect to Google Fonts and the analytics origin, and waiting for
           networkidle0 means eating a full navigation timeout per page
           whenever those hang -- minutes of wall clock for a gate that has to
           run on every push. The rendered DOM axe needs (product grid, UGC
           feed, cart chrome) is in place either way. */
        await page.goto(`http://127.0.0.1:${PORT}/${pageName}`, {
          waitUntil: "networkidle2",
          timeout: 30000
        });
        await page.evaluate(axeSource);
        const result = await page.evaluate(async (tags) => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, { runOnly: { type: "tag", values: tags } });
        }, AXE_TAGS);

        if (!result.violations.length) {
          console.log(`  ✓ ${pageName}`);
          continue;
        }

        violationCount += result.violations.length;
        console.log(`  ✗ ${pageName} -- ${result.violations.length} violation(s):`);
        result.violations.forEach((v) => {
          console.log(`      [${v.impact}] ${v.id}: ${v.help}`);
          console.log(`        ${v.helpUrl}`);
          v.nodes.slice(0, 5).forEach((n) => console.log(`        -> ${n.target.join(", ")}`));
          if (v.nodes.length > 5) {
            console.log(`        -> ...and ${v.nodes.length - 5} more node(s)`);
          }
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(r));
  }

  console.log("\n==================================================");
  if (violationCount) {
    console.log(
      `Accessibility gate FAILED: ${violationCount} violation(s) across ${pages.length} pages.`
    );
    console.log("==================================================");
    process.exit(1);
  }
  console.log(`Accessibility gate PASSED: 0 violations across ${pages.length} pages.`);
  console.log("==================================================");
})().catch((err) => {
  console.error("Accessibility gate crashed:", err);
  process.exit(1);
});
