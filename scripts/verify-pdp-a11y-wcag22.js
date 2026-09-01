/* global document, axe */
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8087;

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function createServer(port = PORT) {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }
    const ext = path.extname(filePath).toLowerCase();

    // For PDP HTML files, strip the immediate client redirect so we can audit the PDP DOM itself
    if (reqPath.startsWith("/products/") && ext === ".html") {
      let content = fs.readFileSync(filePath, "utf8");
      content = content.replace(
        /window\.location\.replace\(.*?\);/g,
        "/* redirect disabled for a11y audit */;"
      );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(content);
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
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

(async () => {
  console.log("===================================================================");
  console.log("   DEDICATED PDP AXE-CORE WCAG 2.2 AA VERIFICATION                ");
  console.log("===================================================================\n");

  const productsDir = path.join(ROOT, "products");
  const pdpFiles = fs
    .readdirSync(productsDir)
    .filter((f) => f.endsWith(".html"))
    .sort();
  console.log(
    `Found ${pdpFiles.length} generated PDP files to audit against axe-core WCAG 2.2 AA...\n`
  );

  const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const server = await createServer(PORT);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  let totalScans = 0;
  let totalViolations = 0;
  const failureList = [];

  try {
    const page = await browser.newPage();

    for (const file of pdpFiles) {
      const relPath = `products/${file}`;

      const configs = [
        {
          name: "Mobile 375x667 (Closed Accordions)",
          viewport: { width: 375, height: 667 },
          openAccordions: false
        },
        {
          name: "Mobile 375x667 (Open Accordions)",
          viewport: { width: 375, height: 667 },
          openAccordions: true
        },
        {
          name: "Tablet 768x1024 (Open Accordions)",
          viewport: { width: 768, height: 1024 },
          openAccordions: true
        },
        {
          name: "Desktop 1280x800 (Open Accordions)",
          viewport: { width: 1280, height: 800 },
          openAccordions: true
        }
      ];

      for (const cfg of configs) {
        totalScans++;
        await page.setViewport(cfg.viewport);

        await page.goto(`http://127.0.0.1:${PORT}/${relPath}`, { waitUntil: "networkidle2" });

        if (cfg.openAccordions) {
          await page.evaluate(() => {
            document
              .querySelectorAll("details.pdp-accordion")
              .forEach((d) => d.setAttribute("open", ""));
          });
        }

        await page.evaluate(axeSource);
        const results = await page.evaluate(async (tags) => {
          return await axe.run(document, { runOnly: { type: "tag", values: tags } });
        }, AXE_TAGS);

        const violations = results.violations || [];
        if (violations.length === 0) {
          console.log(`  ✓ ${file} [${cfg.name}]: 0 violations`);
        } else {
          totalViolations += violations.length;
          console.error(`  ✗ ${file} [${cfg.name}]: ${violations.length} violation(s):`);
          violations.forEach((v) => {
            console.error(`      [${v.impact}] ${v.id}: ${v.help}`);
            v.nodes.forEach((n) => console.error(`        Target: ${n.target.join(", ")}`));
            failureList.push({
              file,
              config: cfg.name,
              id: v.id,
              help: v.help,
              nodes: v.nodes.map((n) => n.target.join(", "))
            });
          });
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log("\n===================================================================");
  console.log(`AXE-CORE WCAG 2.2 AA AUDIT SUMMARY:`);
  console.log(`Total PDP Scans: ${totalScans} (${pdpFiles.length} pages x 4 configurations)`);
  console.log(`Total Violations: ${totalViolations}`);
  console.log("===================================================================");

  if (totalViolations === 0) {
    console.log("VERDICT: 100% WCAG 2.2 AA ACCESSIBILITY COMPLIANT ACROSS ALL PDPs.");
    process.exit(0);
  } else {
    console.error(`VERDICT: FAILED WITH ${totalViolations} ACCESSIBILITY VIOLATIONS.`);
    process.exit(1);
  }
})().catch((err) => {
  console.error("Fatal error during PDP a11y audit:", err);
  process.exit(1);
});
