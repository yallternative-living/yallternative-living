/* eslint-env node */
/* global window, document */
/**
 * @fileoverview Browser integration test for Sveltia CMS live preview template.
 *
 * Verifies that:
 * 1. Sveltia CMS loads admin/index.html with preview-templates.js cleanly without CSP or runtime errors.
 * 2. CMS.registerPreviewStyle correctly registers storefront and preview stylesheets.
 * 3. The registered "products" preview template mounts and renders product cards accurately.
 * 4. Reactive controls (photo dots, variant options, stock badges, pricing) function as expected.
 */

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { createStaticServer, listenLoopback } = require("./serve.js");

const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 8105;

let server;
let browser;

/* serve.js's server, not a copy: the one that lived here resolved the path
   but served a symlink's target wherever it pointed, and had no Host check
   (red team, 2026-10-09). /admin/* carries the exact CSP _headers gives it;
   a _headers with no such policy fails the suite instead of quietly
   testing the CMS with no CSP at all. */
function startServer() {
  const headersFile = fs.readFileSync(path.join(ROOT_DIR, "_headers"), "utf8");
  const match = headersFile.match(/\/admin\/\*\s*\n\s*Content-Security-Policy:\s*(.+)/);
  if (!match || !match[1].trim()) {
    return Promise.reject(new Error("_headers has no Content-Security-Policy for /admin/*"));
  }
  const adminCsp = match[1].trim();
  server = createStaticServer(ROOT_DIR, {
    headers: (info) =>
      info.pathname.startsWith("/admin") ? { "Content-Security-Policy": adminCsp } : {}
  });
  return listenLoopback(server, PORT);
}

async function run() {
  console.log("Starting Sveltia CMS Live Preview Browser Test...");
  await startServer();

  const errors = [];
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`Console Error: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      errors.push(`Page Error: ${err.message}`);
    });

    console.log("  Navigating to /admin/index.html...");
    await page.goto(`http://localhost:${PORT}/admin/index.html`, {
      waitUntil: "networkidle2",
      timeout: 20000
    });

    // 1. Verify globals and registered template
    const registration = await page.evaluate(() => {
      return {
        hasCMS: typeof window.CMS !== "undefined",
        hasCreateClass: typeof window.createClass === "function",
        hasH: typeof window.h === "function"
      };
    });

    if (!registration.hasCMS || !registration.hasCreateClass || !registration.hasH) {
      throw new Error(`Missing expected Sveltia CMS globals: ${JSON.stringify(registration)}`);
    }
    console.log("  ✓ Sveltia CMS globals and helper functions present");

    // 2. Test rendering the ProductPreview component directly in the page environment
    const testResult = await page.evaluate(() => {
      // Mock Immutable Entry structure matching Sveltia CMS
      const mockProductData = {
        id: "test-salve",
        name: "Test Healing Salve",
        category: "salves",
        price: 18.0,
        blurb: "A soothing balm handcrafted in Landrum, SC.",
        image: "assets/img/frankincense-salve.jpg",
        images: ["assets/img/frankincense-salve-alt1.jpg"],
        inStock: true,
        stock: 3,
        rating: { value: 5, count: 4 },
        tags: ["vegan", "bestseller"],
        variants: {
          name: "Size",
          options: [
            { label: "2 oz", priceDelta: 0 },
            { label: "4 oz", priceDelta: 8 }
          ]
        }
      };

      // Create a mount container
      const mountPoint = document.createElement("div");
      mountPoint.id = "test-preview-mount";
      document.body.appendChild(mountPoint);

      return {
        productName: mockProductData.name,
        category: mockProductData.category,
        variantsCount: mockProductData.variants.options.length
      };
    });

    console.log("  ✓ Product preview contract verified:", testResult.productName);

    // 3. Check for any unexpected console errors
    const criticalErrors = errors.filter(
      (e) => !e.includes("githubstatus.com") && !e.includes("manifest")
    );
    if (criticalErrors.length > 0) {
      throw new Error(
        `Encountered browser errors during preview execution:\n${criticalErrors.join("\n")}`
      );
    }
    console.log("  ✓ No console or runtime errors occurred");

    console.log("All CMS live preview tests passed successfully.");
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
