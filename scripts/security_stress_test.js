/**
 * @fileoverview Empirical Security & CSP Stress-Test Harness for Y'allternative Living.
 *
 * Tests XSS injection vectors, HTML escaping, deep-link redirection, and CSP violation logging.
 */
/* global window, document, localStorage */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function createStaticServer(port = 8083) {
  const root = path.resolve(__dirname, "..");
  const headersPath = path.join(root, "_headers");
  let cspHeader = "";
  if (fs.existsSync(headersPath)) {
    const lines = fs.readFileSync(headersPath, "utf8").split("\n");
    const cspLine = lines.find((l) => l.trim().startsWith("Content-Security-Policy:"));
    if (cspLine) {
      cspHeader = cspLine.replace("Content-Security-Policy:", "").trim();
    }
  }

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
      ".avif": "image/avif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml"
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    const resHeaders = { "Content-Type": contentType };
    if (cspHeader && ext === ".html") {
      resHeaders["Content-Security-Policy"] = cspHeader;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(200, resHeaders);
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
  console.log("Starting Security & CSP Stress Test Harness...");
  let server;
  let browser;
  const port = 8086;
  const baseUrl = `http://127.0.0.1:${port}`;
  let passed = true;

  const payloads = [
    "<script>window.__XSS_TRIGGERED__=true;</script>",
    '" onerror="window.__XSS_TRIGGERED__=true;"',
    "' onload='window.__XSS_TRIGGERED__=true;'",
    "`${window.__XSS_TRIGGERED__=true}`",
    '"><img src=x onerror=alert(1)>'
  ];

  try {
    try {
      server = await createStaticServer(port);
      console.log(`Started local static server on ${baseUrl}`);
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        console.log(`Using existing server running on ${baseUrl}`);
      } else {
        throw e;
      }
    }
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    let consoleErrors = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Stress-test Order Lookup Input on shop.html
    console.log("--- 1. Testing Order Lookup XSS Escalation ---");
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle2" });

    // Open order status modal if needed or interact with input
    for (let payload of payloads) {
      await page.evaluate(() => {
        window.__XSS_TRIGGERED__ = false;
        var modal = document.getElementById("order-status-modal");
        if (modal) modal.setAttribute("open", "true");
      });

      await page.type("#order-id-input", payload);
      await page.click("#orderStatusForm button[type='submit']");

      const triggered = await page.evaluate(() => window.__XSS_TRIGGERED__);
      const containerHTML = await page.evaluate(() => {
        const c = document.getElementById("order-timeline-container");
        return c ? c.innerHTML : "";
      });

      if (triggered || containerHTML.includes("<script>")) {
        console.error(`❌ Order Lookup XSS vulnerability detected with payload: ${payload}`);
        passed = false;
      } else {
        console.log(`  ✓ Payload safely escaped in Order Lookup: ${payload}`);
      }

      // Clear input
      await page.evaluate(() => {
        const input = document.getElementById("order-id-input");
        if (input) input.value = "";
      });
    }

    // 2. Stress-test Wishlist & LocalStorage Tampering
    console.log("--- 2. Testing Wishlist XSS & LocalStorage Injection ---");
    for (let payload of payloads) {
      await page.evaluate((payload) => {
        window.__XSS_TRIGGERED__ = false;
        localStorage.setItem("yl-wishlist", JSON.stringify([payload]));
      }, payload);

      await page.reload({ waitUntil: "networkidle2" });
      await page.evaluate(() => {
        var wishToggle = document.getElementById("wishToggle");
        if (wishToggle) wishToggle.click();
      });

      const triggered = await page.evaluate(() => window.__XSS_TRIGGERED__);
      const wishBodyHTML = await page.evaluate(() => {
        const b = document.getElementById("wishBody");
        return b ? b.innerHTML : "";
      });

      if (triggered || wishBodyHTML.includes("<script>")) {
        console.error(`❌ Wishlist XSS vulnerability detected with payload: ${payload}`);
        passed = false;
      } else {
        console.log(`  ✓ Payload safely ignored/escaped in Wishlist: ${payload}`);
      }
    }

    // 3. Stress-test Cart Dynamic Notes & LocalStorage Injection
    console.log("--- 3. Testing Cart Dynamic Fields & State Injection ---");
    for (let payload of payloads) {
      await page.evaluate((payload) => {
        window.__XSS_TRIGGERED__ = false;
        const state = {
          items: [{ id: payload, name: payload, price: 10, qty: 1 }],
          giftMsg: payload,
          pickupDate: payload
        };
        localStorage.setItem("yl-cart-state", JSON.stringify(state));
      }, payload);

      await page.reload({ waitUntil: "networkidle2" });
      await page.evaluate(() => {
        var cartToggle = document.getElementById("cartToggle");
        if (cartToggle) cartToggle.click();
      });

      const triggered = await page.evaluate(() => window.__XSS_TRIGGERED__);
      const cartItemsHTML = await page.evaluate(() => {
        const c = document.getElementById("yl-cart-items");
        return c ? c.innerHTML : "";
      });

      if (triggered || cartItemsHTML.includes("<script>")) {
        console.error(`❌ Cart XSS vulnerability detected with payload: ${payload}`);
        passed = false;
      } else {
        console.log(`  ✓ Payload safely escaped in Cart items: ${payload}`);
      }
    }

    // 4. Test Product Page Deep-Link Redirection under CSP
    console.log("--- 4. Testing Product Page Deep-Link Redirection under CSP ---");
    consoleErrors = [];
    const productUrl = `${baseUrl}/products/backroad-soak.html`;
    await page.goto(productUrl, { waitUntil: "networkidle2" });
    try {
      await page.waitForFunction(
        () =>
          window.location.href.includes("/shop.html") && window.location.hash === "#backroad-soak",
        { timeout: 4000 }
      );
    } catch (_e) {
      // Fall through to assertion
    }

    const finalUrl = page.url();
    const hash = new URL(finalUrl).hash;

    if (finalUrl.includes("/shop.html") && hash === "#backroad-soak") {
      console.log(`  ✓ Deep-link redirected cleanly to shop.html#backroad-soak under CSP`);
    } else {
      console.error(`❌ Deep-link redirection failed or misdirected: ${finalUrl}`);
      passed = false;
    }

    const cspErrors = consoleErrors.filter(
      (e) => e.includes("Content Security Policy") || e.includes("CSP")
    );
    if (cspErrors.length > 0) {
      console.error(`❌ CSP console errors detected during deep-link navigation:`, cspErrors);
      passed = false;
    } else {
      console.log(`  ✓ Zero CSP console errors during deep-link navigation`);
    }
  } catch (err) {
    console.error("Harness error:", err);
    passed = false;
  } finally {
    if (browser) await browser.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  if (passed) {
    console.log("\n==================================================");
    console.log("ALL EMPIRICAL SECURITY & CSP STRESS TESTS PASSED!");
    console.log("==================================================");
    process.exit(0);
  } else {
    console.error("\n==================================================");
    console.error("EMPIRICAL SECURITY & CSP STRESS TESTS FAILED!");
    console.error("==================================================");
    process.exit(1);
  }
})();
