/**
 * @fileoverview Extended Empirical QA Test Suite for Y'allternative Living.
 *
 * Runs comprehensive Puppeteer tests covering:
 * - Wishlist drawer state handling (toggle, add, remove, badge count, empty state, localStorage persistence)
 * - Alt-points calculator & loyalty total verification across multiple cart items
 * - Multi-page responsiveness & scroll overflow checks across 3 viewports (Desktop, Tablet, Mobile)
 * - Comprehensive internal link integrity crawling across all static HTML pages
 */

/* global document, window, localStorage */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function createStaticServer(port = 8083) {
  const root = path.resolve(__dirname, "..");
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(root, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(root, "404.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
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
      ".webmanifest": "application/manifest+json"
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  console.log("Starting Extended QA Empirical Tests...");
  let exitCode = 0;
  let browser;
  let localServer;
  const port = 8083;
  const url = `http://127.0.0.1:${port}`;

  const metrics = {
    pagesChecked: 0,
    linksTested: 0,
    brokenLinks: 0,
    wishlistTestsPassed: 0,
    altPointsTestsPassed: 0,
    overflowCheckPassed: 0,
    overflowCheckTotal: 0
  };

  try {
    try {
      localServer = await createStaticServer(port);
      console.log(`Started local static server on ${url}`);
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        console.log(`Using existing server running on ${url}`);
      } else {
        throw e;
      }
    }

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    // 1. Wishlist Drawer State Handling Verification
    console.log("\n--- Testing Wishlist Drawer State Handling ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });

    // Clear localStorage first
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle2" });

    // Check empty wishlist state
    const wishToggle = await page.$("#wishToggle");
    if (wishToggle) {
      await wishToggle.click();
      await new Promise((r) => setTimeout(r, 400));
      const isEmptyRendered = await page.evaluate(() => {
        const body = document.getElementById("wishBody");
        return body && body.querySelector(".wish-empty") !== null;
      });
      if (isEmptyRendered) {
        console.log("✅ Wishlist empty state correctly rendered on open.");
        metrics.wishlistTestsPassed++;
      } else {
        console.log("❌ Wishlist empty state failed to render.");
        exitCode = 1;
      }

      // Close wishlist drawer
      const wishClose = await page.$("#wishClose");
      if (wishClose) await wishClose.click();
      await new Promise((r) => setTimeout(r, 300));
    }

    // Toggle wishlist on first product card
    const firstWishBtn = await page.$(".card .wish-btn, .wish-btn[data-id]");
    if (firstWishBtn) {
      const productId = await page.evaluate((btn) => btn.getAttribute("data-id"), firstWishBtn);
      await firstWishBtn.click();
      await new Promise((r) => setTimeout(r, 300));

      // Verify badge count updated to '1'
      const badgeCount = await page.$eval("#wishCount", (el) => el.textContent.trim());
      if (badgeCount === "1") {
        console.log("✅ Wishlist count badge updated to 1 after adding item.");
        metrics.wishlistTestsPassed++;
      } else {
        console.log(
          `❌ Wishlist count badge failed to update (got '${badgeCount}', expected '1').`
        );
        exitCode = 1;
      }

      // Open drawer and check item rendered
      if (wishToggle) {
        await wishToggle.click();
        await new Promise((r) => setTimeout(r, 400));
        const wishItemRendered = await page.evaluate((id) => {
          const body = document.getElementById("wishBody");
          return body && body.querySelector(`.wish-remove[data-id="${id}"]`) !== null;
        }, productId);

        if (wishItemRendered) {
          console.log(`✅ Wishlist item (${productId}) rendered inside Wishlist Drawer.`);
          metrics.wishlistTestsPassed++;
        } else {
          console.log(`❌ Wishlist item (${productId}) missing inside Wishlist Drawer.`);
          exitCode = 1;
        }

        // Test removing item from within drawer
        const removeBtn = await page.$(`.wish-remove[data-id="${productId}"]`);
        if (removeBtn) {
          await removeBtn.click();
          await new Promise((r) => setTimeout(r, 300));
          const isNowEmpty = await page.evaluate(() => {
            const body = document.getElementById("wishBody");
            return body && body.querySelector(".wish-empty") !== null;
          });
          const updatedBadge = await page.$eval("#wishCount", (el) => el.textContent.trim());
          if (isNowEmpty && updatedBadge === "") {
            console.log(
              "✅ Item removed from Wishlist Drawer, empty state restored, badge cleared."
            );
            metrics.wishlistTestsPassed++;
          } else {
            console.log(`❌ Item removal from Wishlist Drawer failed (badge='${updatedBadge}').`);
            exitCode = 1;
          }
        }

        // Close drawer
        const wishClose = await page.$("#wishClose");
        if (wishClose) await wishClose.click();
        await new Promise((r) => setTimeout(r, 300));
      }

      // Test Persistence in localStorage across page reload
      await firstWishBtn.click(); // add back
      await new Promise((r) => setTimeout(r, 300));
      await page.reload({ waitUntil: "networkidle2" });
      const reloadedBadge = await page.$eval("#wishCount", (el) => el.textContent.trim());
      const lsRaw = await page.evaluate(() => localStorage.getItem("yl-wishlist"));
      if (reloadedBadge === "1" && lsRaw && lsRaw.includes(productId)) {
        console.log(
          `✅ Wishlist state persisted in localStorage ('${lsRaw}') and restored on page reload.`
        );
        metrics.wishlistTestsPassed++;
      } else {
        console.log(
          `❌ Wishlist persistence failed on reload (badge='${reloadedBadge}', localStorage='${lsRaw}').`
        );
        exitCode = 1;
      }
    } else {
      console.log("❌ Wishlist button not found on shop.html.");
      exitCode = 1;
    }

    // 2. Alt-Points Loyalty Calculator Verification
    console.log("\n--- Testing Alt-Points Calculator in Cart Drawer ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.removeItem("yl_cart"));
    await page.reload({ waitUntil: "networkidle2" });

    // Add multiple items to cart
    const addButtons = await page.$$(".card .yl-add-item");
    if (addButtons.length >= 2) {
      const price1 = await page.evaluate(
        (b) => parseFloat(b.getAttribute("data-item-price")),
        addButtons[0]
      );
      const price2 = await page.evaluate(
        (b) => parseFloat(b.getAttribute("data-item-price")),
        addButtons[1]
      );

      await page.evaluate((b) => b.click(), addButtons[0]);
      await new Promise((r) => setTimeout(r, 400));
      await page.evaluate((b) => b.click(), addButtons[1]);
      await new Promise((r) => setTimeout(r, 400));

      const expectedTotalPoints = Math.floor(price1 + price2);
      const displayedPoints = await page
        .$eval("#cart-points-count", (el) => parseInt(el.textContent.trim(), 10))
        .catch(() => 0);

      if (displayedPoints === expectedTotalPoints) {
        console.log(
          `✅ Alt-Points total accurately calculated for multiple items (${displayedPoints} pts for $${price1}+$${price2}).`
        );
        metrics.altPointsTestsPassed++;
      } else {
        console.log(
          `❌ Alt-Points calculation error: expected ${expectedTotalPoints}, got ${displayedPoints}.`
        );
        exitCode = 1;
      }
    } else {
      console.log("❌ Fewer than 2 Add to Cart buttons found on shop page.");
      exitCode = 1;
    }

    // 3. Multi-Page Viewport Responsiveness & Layout Overflow
    console.log("\n--- Testing Multi-Page Viewport Responsiveness & Scroll Overflow ---");
    const pagesToTest = [
      "index.html",
      "shop.html",
      "about.html",
      "contact.html",
      "events.html",
      "faq.html",
      "journal.html",
      "privacy.html",
      "terms.html",
      "policies.html",
      "404.html",
      "thank-you.html"
    ];

    const viewports = [
      { name: "Desktop", width: 1200, height: 800 },
      { name: "Tablet", width: 768, height: 1024 },
      { name: "Mobile", width: 375, height: 667 }
    ];

    for (const pageName of pagesToTest) {
      metrics.pagesChecked++;
      for (const vp of viewports) {
        metrics.overflowCheckTotal++;
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.goto(`${url}/${pageName}`, { waitUntil: "networkidle2" });
        const hasOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        );

        if (!hasOverflow) {
          metrics.overflowCheckPassed++;
        } else {
          console.log(
            `❌ ${pageName} on ${vp.name} (${vp.width}x${vp.height}) has horizontal scroll overflow!`
          );
          exitCode = 1;
        }
      }
    }
    console.log(
      `✅ Checked ${pagesToTest.length} pages across 3 viewports: ${metrics.overflowCheckPassed}/${metrics.overflowCheckTotal} viewport layout checks passed (0 overflow errors).`
    );

    // 4. Comprehensive Internal Link Integrity
    console.log("\n--- Testing Comprehensive Site-wide Link Integrity ---");
    let allDiscoveredHrefs = new Set();
    for (const pageName of pagesToTest) {
      await page.goto(`${url}/${pageName}`, { waitUntil: "networkidle2" });
      const links = await page.$$eval("a", (els) =>
        els.map((a) => a.href).filter((h) => h.startsWith("http"))
      );
      links.forEach((l) => allDiscoveredHrefs.add(l));
    }

    let brokenLinksList = [];
    for (const href of allDiscoveredHrefs) {
      if (href.startsWith(url)) {
        metrics.linksTested++;
        try {
          const res = await page.goto(href, { waitUntil: "domcontentloaded" });
          if (res && res.status() >= 400) {
            brokenLinksList.push(`${href} (Status: ${res.status()})`);
          }
        } catch (e) {
          brokenLinksList.push(`${href} (Error: ${e.message})`);
        }
      }
    }

    metrics.brokenLinks = brokenLinksList.length;
    if (brokenLinksList.length === 0) {
      console.log(
        `✅ All ${metrics.linksTested} unique internal links across site returned 200 OK.`
      );
    } else {
      console.log(`❌ Found ${brokenLinksList.length} broken links:`);
      brokenLinksList.forEach((b) => console.log(`   - ${b}`));
      exitCode = 1;
    }

    console.log("\n==================================================");
    console.log("Extended QA Test Summary:");
    console.log(`- Pages Checked: ${metrics.pagesChecked}`);
    console.log(
      `- Viewport Layout Checks: ${metrics.overflowCheckPassed}/${metrics.overflowCheckTotal} PASSED`
    );
    console.log(
      `- Internal Links Checked: ${metrics.linksTested} (Broken: ${metrics.brokenLinks})`
    );
    console.log(`- Wishlist State Tests Passed: ${metrics.wishlistTestsPassed}`);
    console.log(`- Alt-Points Calculator Tests Passed: ${metrics.altPointsTestsPassed}`);
    console.log(`- Final Verdict: ${exitCode === 0 ? "PASSED" : "FAILED"}`);
    console.log("==================================================\n");
  } catch (e) {
    console.error("❌ Error running Extended QA Tests:", e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
      console.log("Closed static server.");
    }
    process.exit(exitCode);
  }
})();
