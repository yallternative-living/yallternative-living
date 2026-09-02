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

/**
 * The path of the synthetic page this harness serves to prove the CSP it is
 * testing under is actually being enforced. It is never written to disk.
 */
const CSP_CONTROL_PATH = "/__csp-positive-control.html";

/**
 * A page that must be blocked by the site CSP: an inline script whose hash is
 * not in the allowlist, plus a script from an origin the policy does not
 * permit. If loading this produces no violation, the browser is not enforcing
 * the policy and every "no XSS fired" result below is meaningless.
 */
const CSP_CONTROL_HTML = [
  "<!doctype html><html><head><title>CSP positive control</title></head><body>",
  "<script>window.__CSP_CONTROL_INLINE_RAN__ = true;</script>",
  '<script src="https://csp-control.invalid/blocked.js"></script>',
  "</body></html>"
].join("");

/**
 * Reads the live site CSP out of `_headers`. A missing file or a file with no
 * Content-Security-Policy line used to leave `cspHeader` empty, which meant the
 * harness served every page with no policy at all -- deleting the CSP made this
 * suite greener (audit H-19). It is now a hard failure.
 * @return {string}
 */
function readSiteCsp() {
  const root = path.resolve(__dirname, "..");
  const headersPath = path.join(root, "_headers");
  if (!fs.existsSync(headersPath)) {
    console.error("❌ _headers is missing -- there is no Content-Security-Policy to test against.");
    process.exit(1);
  }
  const lines = fs.readFileSync(headersPath, "utf8").split("\n");
  const cspLine = lines.find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (!cspLine) {
    console.error(
      "❌ _headers contains no Content-Security-Policy line -- refusing to run the CSP stress test\n" +
        "   against an unprotected server and report a pass."
    );
    process.exit(1);
  }
  const csp = cspLine.replace("Content-Security-Policy:", "").trim();
  if (!csp) {
    console.error("❌ _headers Content-Security-Policy line is empty.");
    process.exit(1);
  }
  return csp;
}

function createStaticServer(port = 8083) {
  const root = path.resolve(__dirname, "..");
  const cspHeader = readSiteCsp();

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";

    if (reqPath === CSP_CONTROL_PATH) {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": cspHeader
      });
      res.end(CSP_CONTROL_HTML);
      return;
    }

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
    // A pre-existing server would not serve the positive-control page below and
    // might serve no CSP at all, so an occupied port is fatal rather than
    // something to shrug at.
    server = await createStaticServer(port);
    console.log(`Started local static server on ${baseUrl}`);

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    let consoleErrors = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Register the violation collector through CDP so it is installed before
    // any document script runs and is not itself subject to the page CSP.
    await page.evaluateOnNewDocument(() => {
      window.__CSP_VIOLATIONS__ = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__CSP_VIOLATIONS__.push({
          directive: e.effectiveDirective || e.violatedDirective,
          blockedURI: e.blockedURI
        });
      });
    });

    // =======================================================================
    // 0. Positive control: prove the browser is enforcing the site CSP.
    //
    // Every check further down is of the form "the payload did not execute".
    // Those all pass just as happily against a page served with no policy at
    // all, so the suite first proves that a deliberate violation IS caught.
    // =======================================================================
    console.log("--- 0. CSP Positive Control (deliberate violation must be reported) ---");
    consoleErrors = [];
    await page.goto(`${baseUrl}${CSP_CONTROL_PATH}`, { waitUntil: "networkidle2" });

    const controlViolations = await page.evaluate(() => window.__CSP_VIOLATIONS__ || []);
    const controlInlineRan = await page.evaluate(() => window.__CSP_CONTROL_INLINE_RAN__ === true);
    const controlConsoleCsp = consoleErrors.filter((e) =>
      /Content Security Policy|Refused to (load|execute)/i.test(e)
    );

    if (controlViolations.length > 0 || controlConsoleCsp.length > 0) {
      console.log(
        `  ✓ CSP is enforced: ${controlViolations.length} securitypolicyviolation event(s), ` +
          `${controlConsoleCsp.length} console report(s)`
      );
    } else {
      console.error(
        "❌ Positive control produced no CSP violation -- the policy is not being enforced, " +
          "so every XSS result in this run is meaningless."
      );
      passed = false;
    }

    if (controlInlineRan) {
      console.error("❌ The control page's un-hashed inline script executed under the site CSP.");
      passed = false;
    } else {
      console.log("  ✓ Un-hashed inline script on the control page did not execute");
    }

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

    // 4. Product page under CSP: it is a real page now (no redirect), so it
    //    must stay on its own URL, render its purchase controls, and raise no
    //    CSP report while doing so.
    console.log("--- 4. Testing Product Page under CSP ---");
    consoleErrors = [];
    const productUrl = `${baseUrl}/products/backroad-soak.html`;
    await page.goto(productUrl, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 800));

    const finalUrl = page.url();
    const pdpRendered = await page.evaluate(
      () =>
        !!document.querySelector(".pdp-layout") &&
        !!document.querySelector("#pdpAddToCart, .pdp-cta-btn")
    );

    if (finalUrl.includes("/products/backroad-soak.html") && pdpRendered) {
      console.log(
        `  ✓ Product page stays on its own URL and renders its purchase controls under CSP`
      );
    } else {
      console.error(
        `❌ Product page did not render in place: url=${finalUrl} rendered=${pdpRendered}`
      );
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
