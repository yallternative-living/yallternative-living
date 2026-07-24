/**
 * @fileoverview Automated Headless Browser Integration Test Suite for Y'allternative Living.
 *
 * Automatically manages a local static HTTP server lifecycle on port 8082, then executes
 * multi-viewport integration tests across Desktop (1200x800), Tablet (768x1024), and
 * Mobile (375x667) viewports. Validates internal link integrity, responsive navigation
 * drawer toggling, newsletter form submission interception, and the on-site cart's
 * add-to-cart + drawer flow (assets/js/cart.js -- checkout itself hands off to Stripe's
 * hosted page, which this local static-server test harness can't exercise).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * Creates and starts a lightweight local static HTTP server for test execution.
 * @param {number} [port=8082] Port number to listen on.
 * @return {Promise<http.Server>} Resolves with the running HTTP server instance.
 */
function createStaticServer(port = 8082) {
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
  console.log("Starting Puppeteer tests...");
  let exitCode = 0;
  let browser;
  let localServer;
  const port = 8082;
  const url = `http://127.0.0.1:${port}`;

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

    // 1. Check for Broken Links (Internal)
    console.log("--- Testing Broken Links ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const hrefs = await page.$$eval("a", (links) =>
      links.map((a) => a.href).filter((h) => h.startsWith("http"))
    );
    let brokenLinks = [];
    for (let href of [...new Set(hrefs)]) {
      if (href.startsWith(url)) {
        try {
          const res = await page.goto(href, { waitUntil: "domcontentloaded" });
          if (res && res.status() >= 400) {
            brokenLinks.push(`${href} (Status: ${res.status()})`);
          }
        } catch (e) {
          brokenLinks.push(`${href} (Error: ${e.message})`);
        }
      }
    }
    if (brokenLinks.length > 0) {
      console.log(`❌ Found ${brokenLinks.length} broken links:`);
      brokenLinks.forEach((b) => console.log(b));
      exitCode = 1;
    } else {
      console.log("✅ No broken internal links found on homepage.");
    }

    // 2. Test Mobile Menu Interaction
    console.log("--- Testing Mobile Menu ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.setViewport({ width: 375, height: 667 });

    const menuToggle = await page.$(".nav-toggle");
    if (menuToggle) {
      await menuToggle.click();
      await new Promise((r) => setTimeout(r, 500)); // wait for transition
      const isActive = await page.$eval(
        ".nav-links",
        // eslint-disable-next-line no-undef
        (el) => el.classList.contains("active") || window.getComputedStyle(el).display !== "none"
      );

      if (isActive) {
        console.log("✅ Mobile menu toggle works.");
      } else {
        console.log("❌ Mobile menu did not become active/visible after clicking toggle.");
        exitCode = 1;
      }
    } else {
      console.log("❌ Mobile menu toggle button not found.");
      exitCode = 1;
    }
    // 2b. Test Tablet Viewport Responsiveness
    console.log("--- Testing Tablet Viewport (768x1024) ---");
    await page.setViewport({ width: 768, height: 1024 });
    await page.goto(url, { waitUntil: "networkidle2" });
    const tabletOverflow = await page.evaluate(
      // eslint-disable-next-line no-undef
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    if (!tabletOverflow) {
      console.log("✅ Tablet viewport (768x1024) layout renders without horizontal overflow.");
    } else {
      console.log("❌ Tablet viewport has horizontal scroll overflow.");
      exitCode = 1;
    }
    await page.setViewport({ width: 1200, height: 800 });

    // 3. Test Form Submissions
    console.log("--- Testing Newsletter Form ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const emailInput = await page.$("#footer_email");
    if (emailInput) {
      await emailInput.type("test@example.com");

      let intercepted = false;
      await page.setRequestInterception(true);
      const requestHandler = (req) => {
        if (req.isInterceptResolutionHandled()) return;
        if (req.method() === "POST" && req.url().includes("YOUR_KIT_FORM_ACTION_URL")) {
          intercepted = true;
          req.abort();
        } else {
          req.continue();
        }
      };
      page.on("request", requestHandler);

      await page.$eval(".footer-signup-form", (form) => form.submit()).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      if (intercepted) {
        console.log("✅ Form submission intercepted correctly.");
      } else {
        console.log("❌ Form did not submit to the expected URL.");
        exitCode = 1;
      }

      page.off("request", requestHandler);
      await page.setRequestInterception(false);
    } else {
      console.log("❌ Newsletter form not found.");
      exitCode = 1;
    }

    // 4. Test the on-site cart (cart.js) add-to-cart + drawer flow
    console.log("--- Testing Cart Flow ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".yl-add-item", { timeout: 5000 }).catch(() => {});
    const addBtn = await page.$(".yl-add-item");
    if (addBtn) {
      await addBtn.click();
      let cartLineVisible = false;
      try {
        // addItemFromButton() renders the line item then calls openDrawer()
        // (see assets/js/cart.js) -- waiting on the rendered line, not just
        // the popover opening, also proves the add itself actually worked.
        await page.waitForSelector("#yl-cart-drawer .yl-cart-line", {
          visible: true,
          timeout: 10000
        });
        cartLineVisible = true;
      } catch (e) {
        cartLineVisible = false;
      }

      let badgeUpdated = false;
      if (cartLineVisible) {
        badgeUpdated = await page
          .$eval(
            ".cart-count",
            (el) => el.textContent.trim() !== "" && el.textContent.trim() !== "0"
          )
          .catch(() => false);
      }

      if (cartLineVisible && badgeUpdated) {
        console.log("✅ Cart integration verified (item added, drawer opened, badge updated).");
      } else if (cartLineVisible) {
        console.log(
          "❌ Cart drawer opened with a line item, but the nav badge count didn't update."
        );
        exitCode = 1;
      } else {
        console.log("❌ Cart drawer/line item did not appear after Add to Cart.");
        exitCode = 1;
      }
    } else {
      console.log("❌ No 'Add to Cart' button found on shop.html.");
      exitCode = 1;
    }
  } catch (e) {
    console.error("❌ Unexpected error in Puppeteer tests:", e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
      console.log("Closed local static server.");
    }
    process.exit(exitCode);
  }
})();
