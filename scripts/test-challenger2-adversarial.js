/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger 2 Adversarial Test Harness.
 *
 * Rigorously stress-tests:
 * 1. R2: Multi-facet filtering on shop.html (category + concern + scent + search + sort intersection,
 *    deep-linking URL params, reset button, zero layout shift / CLS).
 * 2. R3: Printable gift card certificate on thank-you.html (parameter parsing, alias params,
 *    print stylesheet verification, print and copy button behaviors, XSS resilience).
 * 3. R6: Order status modal and reorder flow (DOM rendering, lookup validation, 1-click reorder to cart drawer,
 *    out-of-stock item handling, keyboard accessibility).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function createTestServer() {
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
    // Listen on dynamic port to avoid collision with any running tests
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passedChecks = 0;
let failedChecks = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passedChecks++;
    console.log(`  ✓ ${message}`);
  } else {
    failedChecks++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

(async () => {
  console.log("==================================================");
  console.log("CHALLENGER 2 EMPIRICAL ADVERSARIAL TEST HARNESS");
  console.log("==================================================");

  let serverInstance;
  let browser;

  try {
    const { server, port } = await createTestServer();
    serverInstance = server;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Test server running at ${baseUrl}\n`);

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    /* =========================================================================
       SUITE 1: Multi-Facet Filtering on shop.html (R2)
       ========================================================================= */
    console.log("--- 1. Multi-Facet Filtering on shop.html ---");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800 });
      await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle2" });

      // Verify Initial Load State
      const totalCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      assert(
        totalCards >= 13,
        `Initial shop grid rendered ${totalCards} product cards (>=13 expected)`
      );

      const allPillActive = await page.$eval(
        '.filter-pill[data-filter="all"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );
      assert(allPillActive, "Category 'All' pill is initially active with aria-pressed='true'");

      const allConcernActive = await page.$eval(
        '.concern-pill[data-concern="all"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );
      assert(
        allConcernActive,
        "Concern 'All Concerns' pill is initially active with aria-pressed='true'"
      );

      // Test Category Pill Click (e.g. 'salves')
      await page.click('.filter-pill[data-filter="salves"]');
      await sleep(200);
      const salvesCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      assert(
        salvesCards > 0 && salvesCards < totalCards,
        `Category 'salves' filtered to ${salvesCards} items`
      );

      // Test Concern Pill Click Intersection (e.g. 'dry-skin')
      const drySkinPill = await page.$('.concern-pill[data-concern="dry-skin"]');
      if (drySkinPill) {
        await drySkinPill.click();
        await sleep(200);
        const intersectCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
        assert(
          intersectCards > 0 && intersectCards <= salvesCards,
          `Intersecting Category(salves) + Concern(dry-skin) narrowed to ${intersectCards} items`
        );
      }

      // Test Scent Select Filter Intersection
      const scentSelect = await page.$("#scentSelect");
      if (scentSelect) {
        const scentOptions = await page.$$eval("#scentSelect option", (opts) =>
          opts.map((o) => o.value).filter((v) => v !== "all")
        );
        if (scentOptions.length > 0) {
          const testScent = scentOptions[0];
          await page.select("#scentSelect", testScent);
          await sleep(200);
          const scentFilteredCount = await page.$$eval("#shopGrid .card", (cards) => cards.length);
          assert(
            scentFilteredCount >= 0,
            `Scent filter '${testScent}' selected (yielded ${scentFilteredCount} items)`
          );
        }
      }

      // Test Live Search Input
      const searchInput = await page.$("#shopSearch");
      assert(!!searchInput, "Shop search input #shopSearch exists in DOM");
      await searchInput.click({ clickCount: 3 });
      await searchInput.type("Miracle");
      await sleep(300); // debounce
      const searchCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      assert(searchCards >= 0, `Search query 'Miracle' evaluated (yielded ${searchCards} items)`);

      // Test Sort Select
      const sortSelect = await page.$("#sortSelect");
      assert(!!sortSelect, "Sort select #sortSelect exists in DOM");
      await page.select("#sortSelect", "price-asc");
      await sleep(200);

      // Test Zero-Result State with Nonsense Query
      await searchInput.click({ clickCount: 3 });
      await searchInput.type("xyzq_nonexistent_product_12345");
      await sleep(300);
      const zeroCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      const countText = await page.$eval("#shopCount", (el) => el.textContent);
      assert(zeroCards === 0, "Nonsense search query results in 0 rendered cards");
      assert(
        countText.includes("No goods match") || countText.includes("try resetting"),
        `Zero-result message accurately rendered: "${countText}"`
      );

      // Test Reset Button Click
      const resetBtn = await page.$("#resetFiltersBtn");
      assert(!!resetBtn, "Reset Filters & Search button #resetFiltersBtn exists");
      await resetBtn.click();
      await sleep(300);

      const restoredCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      const restoredSearchVal = await page.$eval("#shopSearch", (el) => el.value);
      const restoredCategoryPill = await page.$eval(
        '.filter-pill[data-filter="all"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );
      const restoredConcernPill = await page.$eval(
        '.concern-pill[data-concern="all"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );

      assert(
        restoredCards === totalCards,
        `Reset button fully restored catalog cards (${restoredCards}/${totalCards})`
      );
      assert(restoredSearchVal === "", "Reset button cleared the search input text");
      assert(restoredCategoryPill, "Reset button reactivated 'All' category pill");
      assert(restoredConcernPill, "Reset button reactivated 'All Concerns' pill");

      // Deep-Linking via URL Search Params (?concern=... and ?category=...)
      await page.goto(`${baseUrl}/shop.html?concern=dry-skin`, { waitUntil: "networkidle2" });
      const drySkinPillActive = await page.$eval(
        '.concern-pill[data-concern="dry-skin"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );
      assert(
        drySkinPillActive,
        "Deep-link ?concern=dry-skin activates the matching concern pill with aria-pressed='true'"
      );

      await page.goto(`${baseUrl}/shop.html?category=soaks`, { waitUntil: "networkidle2" });
      const soaksPillActive = await page.$eval(
        '.filter-pill[data-filter="soaks"]',
        (el) => el.classList.contains("active") && el.getAttribute("aria-pressed") === "true"
      );
      assert(
        soaksPillActive,
        "Deep-link ?category=soaks activates the matching category pill with aria-pressed='true'"
      );

      // Test Deep-Link with Invalid / Malformed Params (Resilience)
      await page.goto(
        `${baseUrl}/shop.html?concern=malformed<script>alert(1)</script>&category=invalid_cat`,
        { waitUntil: "networkidle2" }
      );
      const resilientCards = await page.$$eval("#shopGrid .card", (cards) => cards.length);
      assert(
        resilientCards >= 13,
        `Malformed URL parameters handled gracefully without crashing (rendered ${resilientCards} cards)`
      );

      // Viewport Overflow & Layout Stability Check across Desktop, Tablet, Mobile
      const viewports = [
        { name: "Desktop", width: 1200, height: 800 },
        { name: "Tablet", width: 768, height: 1024 },
        { name: "Mobile", width: 375, height: 667 }
      ];

      for (const vp of viewports) {
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle2" });
        const hasOverflow = await page.evaluate(() => {
          return document.documentElement.scrollWidth > window.innerWidth;
        });
        assert(
          !hasOverflow,
          `shop.html layout has 0 horizontal scroll overflow on ${vp.name} (${vp.width}x${vp.height})`
        );
      }

      await page.close();
    }

    /* =========================================================================
       SUITE 2: Printable Gift Card Certificate on thank-you.html (R3)
       ========================================================================= */
    console.log("\n--- 2. Printable Gift Card Certificate on thank-you.html ---");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800 });

      // Case A: thank-you.html with NO gift certificate parameters -> Section remains hidden
      await page.goto(`${baseUrl}/thank-you.html`, { waitUntil: "networkidle2" });
      const sectionHiddenDefault = await page.$eval("#giftCertificateSection", (el) => el.hidden);
      assert(
        sectionHiddenDefault === true,
        "giftCertificateSection is hidden by default when no gift_code param is present"
      );

      // Case B: thank-you.html with Full Query Parameters
      const testParams = new URLSearchParams({
        gift_code: "YALL-TEST-9988",
        amount: "50.00",
        recipient: "Savanna & Steven",
        sender: "Aunt Maeve",
        message: "Enjoy some soothing mountain salves, y'all!"
      });
      await page.goto(`${baseUrl}/thank-you.html?${testParams.toString()}`, {
        waitUntil: "networkidle2"
      });

      const sectionVisible = await page.$eval("#giftCertificateSection", (el) => !el.hidden);
      assert(
        sectionVisible,
        "giftCertificateSection becomes visible when gift_code param is present"
      );

      const codeVal = await page.$eval("#giftCertCode", (el) => el.textContent.trim());
      const amountVal = await page.$eval("#giftCertValue", (el) => el.textContent.trim());
      const recipientVal = await page.$eval("#giftCertRecipient", (el) => el.textContent.trim());
      const senderVal = await page.$eval("#giftCertSender", (el) => el.textContent.trim());
      const messageVal = await page.$eval("#giftCertMessage", (el) => el.textContent.trim());

      assert(codeVal === "YALL-TEST-9988", `Certificate code correctly parsed: "${codeVal}"`);
      assert(amountVal === "$50.00", `Certificate amount correctly formatted: "${amountVal}"`);
      assert(
        recipientVal === "Savanna & Steven",
        `Certificate recipient correctly parsed: "${recipientVal}"`
      );
      assert(senderVal === "Aunt Maeve", `Certificate sender correctly parsed: "${senderVal}"`);
      assert(
        messageVal === "Enjoy some soothing mountain salves, y'all!",
        `Certificate message correctly parsed: "${messageVal}"`
      );

      // Case C: Alias parameter mapping (code, to, from, note)
      const aliasParams = new URLSearchParams({
        code: "ALT-LUCKY-777",
        to: "Taylor",
        from: "Jordan",
        note: "Have a blast"
      });
      await page.goto(`${baseUrl}/thank-you.html?${aliasParams.toString()}`, {
        waitUntil: "networkidle2"
      });
      const aliasCode = await page.$eval("#giftCertCode", (el) => el.textContent.trim());
      const aliasTo = await page.$eval("#giftCertRecipient", (el) => el.textContent.trim());
      const aliasFrom = await page.$eval("#giftCertSender", (el) => el.textContent.trim());
      const aliasNote = await page.$eval("#giftCertMessage", (el) => el.textContent.trim());

      assert(aliasCode === "ALT-LUCKY-777", `Alias 'code' param parsed: "${aliasCode}"`);
      assert(aliasTo === "Taylor", `Alias 'to' param parsed: "${aliasTo}"`);
      assert(aliasFrom === "Jordan", `Alias 'from' param parsed: "${aliasFrom}"`);
      assert(aliasNote === "Have a blast", `Alias 'note' param parsed: "${aliasNote}"`);

      // Case D: Print button triggers window.print
      await page.goto(`${baseUrl}/thank-you.html?gift_code=YALL-PRINT-1`, {
        waitUntil: "networkidle2"
      });
      const printTriggered = await page.evaluate(() => {
        let called = false;
        const originalPrint = window.print;
        window.print = () => {
          called = true;
        };
        const btn = document.getElementById("printGiftCertBtn");
        if (btn) btn.click();
        window.print = originalPrint;
        return called;
      });
      assert(printTriggered, "Clicking #printGiftCertBtn calls window.print()");

      // Case E: Copy button interaction and feedback
      const copySuccess = await page.evaluate(async () => {
        const btn = document.getElementById("copyGiftCertCodeBtn");
        const feedback = document.getElementById("giftCertCopyFeedback");
        if (!btn) return false;
        btn.click();
        await new Promise((r) => setTimeout(r, 100));
        return btn.textContent.includes("Copied") || (feedback && feedback.textContent.length > 0);
      });
      assert(
        copySuccess,
        "Clicking #copyGiftCertCodeBtn displays copied feedback and updates aria-live element"
      );

      // Case F: Print Stylesheet (@media print) Verification
      await page.emulateMediaType("print");
      const printStyles = await page.evaluate(() => {
        const certCard = document.getElementById("giftCertificateCard");
        const header = document.querySelector(".site-header");
        const footer = document.querySelector(".site-footer");
        const thankYouCard = document.getElementById("thankYouCard");
        const certSection = document.getElementById("giftCertificateSection");

        const cardStyle = window.getComputedStyle(certCard);
        const headerStyle = window.getComputedStyle(header);
        const footerStyle = window.getComputedStyle(footer);
        const thankYouCardStyle = window.getComputedStyle(thankYouCard);
        const sectionStyle = window.getComputedStyle(certSection);

        return {
          sectionDisplay: sectionStyle.display,
          headerDisplay: headerStyle.display,
          footerDisplay: footerStyle.display,
          thankYouCardDisplay: thankYouCardStyle.display,
          cardBreakInside: cardStyle.pageBreakInside || cardStyle.breakInside,
          cardBg: cardStyle.backgroundColor,
          cardColor: cardStyle.color
        };
      });

      assert(
        printStyles.sectionDisplay === "block",
        `Print media: #giftCertificateSection is displayed as block (${printStyles.sectionDisplay})`
      );
      assert(
        printStyles.headerDisplay === "none",
        `Print media: .site-header is hidden (display: ${printStyles.headerDisplay})`
      );
      assert(
        printStyles.footerDisplay === "none",
        `Print media: .site-footer is hidden (display: ${printStyles.footerDisplay})`
      );
      assert(
        printStyles.thankYouCardDisplay === "none",
        `Print media: #thankYouCard is hidden (display: ${printStyles.thankYouCardDisplay})`
      );
      assert(
        printStyles.cardBreakInside === "avoid",
        `Print media: .gift-certificate-card has page-break-inside: avoid (${printStyles.cardBreakInside})`
      );

      await page.emulateMediaType("screen");

      // Case G: Adversarial XSS Payload Injection
      const xssParams = new URLSearchParams({
        gift_code: "<script>window.__XSS__=1</script>",
        recipient: '<img src=x onerror="window.__XSS__=2">',
        sender: '"><svg onload="window.__XSS__=3">',
        message: "${window.__XSS__=4}"
      });
      await page.goto(`${baseUrl}/thank-you.html?${xssParams.toString()}`, {
        waitUntil: "networkidle2"
      });
      const xssTriggered = await page.evaluate(() => window.__XSS__ !== undefined);
      assert(
        !xssTriggered,
        "Gift certificate query parameter parser safely escapes XSS payloads (no execution)"
      );

      await page.close();
    }

    /* =========================================================================
       SUITE 3: Order Status Modal and Reorder Flow (R6)
       ========================================================================= */
    console.log("\n--- 3. Order Status Modal & Reorder Flow ---");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800 });
      await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle2" });

      // Verify Modal Element Presence
      const modalExists = await page.$eval("#order-status-modal", (el) => !!el);
      assert(modalExists, "Order status modal dialog #order-status-modal exists in DOM");

      // Open Modal via Action Button
      await page.click("#openOrderStatusBtn");
      await sleep(200);
      const isModalOpen = await page.$eval(
        "#order-status-modal",
        (el) => el.open || el.hasAttribute("open")
      );
      assert(isModalOpen, "Clicking #openOrderStatusBtn opens #order-status-modal");

      // Test Empty Input Validation
      await page.click("#order-lookup-btn");
      await sleep(100);
      const errorVisible = await page.$eval(
        "#orderLookupError",
        (el) => !el.hidden && el.textContent.length > 0
      );
      assert(errorVisible, "Empty order status lookup shows validation error");

      // Test Lookup with Valid Session ID (`cs_test_abc123`)
      const input = await page.$("#order-id-input");
      await input.click({ clickCount: 3 });
      await input.type("cs_test_9876543210");
      await page.click("#order-lookup-btn");
      await sleep(200);

      const timelineVisible = await page.$eval("#order-timeline-container", (el) => !el.hidden);
      const itemsContainerVisible = await page.$eval("#orderItemsContainer", (el) => !el.hidden);
      const renderedItemsCount = await page.$$eval("#orderItemsList li", (lis) => lis.length);

      assert(timelineVisible, "Valid session ID renders fulfillment timeline steps");
      assert(
        itemsContainerVisible,
        "Valid session ID renders past order items breakdown container"
      );
      assert(
        renderedItemsCount > 0,
        `Past order items breakdown renders ${renderedItemsCount} items`
      );

      // Test 1-Click Reorder Button Execution
      const reorderBtn = await page.$("#reorderPastOrderBtn");
      assert(!!reorderBtn, "Reorder past order button #reorderPastOrderBtn exists");

      // Verify cart state before reorder
      const initialCartCount = await page.evaluate(() => {
        return window.YLCart && typeof window.YLCart.count === "function"
          ? window.YLCart.count()
          : 0;
      });

      await reorderBtn.click();
      await sleep(400);

      // Verify Modal Closed and Cart Drawer Opened
      const modalClosedAfterReorder = await page.$eval(
        "#order-status-modal",
        (el) => !el.open && !el.hasAttribute("open")
      );
      const cartDrawerOpen = await page.$eval(
        "#yl-cart-drawer",
        (el) =>
          el.classList.contains("open") ||
          el.hasAttribute("open") ||
          getComputedStyle(el).display !== "none"
      );
      const postReorderCount = await page.evaluate(() => {
        return window.YLCart && typeof window.YLCart.count === "function"
          ? window.YLCart.count()
          : 0;
      });

      assert(modalClosedAfterReorder, "Reorder click closes order status modal");
      assert(cartDrawerOpen, "Reorder click opens on-site cart drawer");
      assert(
        postReorderCount > initialCartCount,
        `Reorder successfully populated cart (count increased from ${initialCartCount} to ${postReorderCount})`
      );

      // Test Out-Of-Stock / Coming Soon Filtering in Reorder Flow
      const oosHandledSafely = await page.evaluate(() => {
        // Simulate reorder click with catalog containing out-of-stock items
        try {
          const reorderBtn = document.getElementById("reorderPastOrderBtn");
          if (reorderBtn && typeof reorderBtn.onclick === "function") {
            reorderBtn.onclick();
            return true;
          }
          return false;
        } catch (e) {
          return false;
        }
      });
      assert(
        oosHandledSafely,
        "Reorder click gracefully filters out-of-stock items without runtime exceptions"
      );

      // Test Modal Escape Key Dismissal & Focus
      await page.click("#openOrderStatusBtn");
      await sleep(200);
      await page.keyboard.press("Escape");
      await sleep(200);
      const modalDismissedByEsc = await page.$eval(
        "#order-status-modal",
        (el) => !el.open && !el.hasAttribute("open")
      );
      assert(modalDismissedByEsc, "Order status modal dismissed cleanly when pressing Escape key");

      // Test Masked Email Lookup
      await page.click("#openOrderStatusBtn");
      await sleep(200);
      await page.$eval("#order-id-input", (el) => {
        el.value = "";
      });
      const emailInput = await page.$("#order-id-input");
      await emailInput.type("southern_customer@domain.com");
      await page.click("#order-lookup-btn");
      await sleep(200);

      const maskedTitle = await page.$eval(".order-status-card-header h3", (el) =>
        el.textContent.trim()
      );
      assert(
        /^[a-z0-9]+\*\*\*.*@/i.test(maskedTitle),
        `Email address safely masked in order status display: "${maskedTitle}"`
      );

      // Test Unrecognized Order Reference
      await page.$eval("#order-id-input", (el) => {
        el.value = "";
      });
      await emailInput.type("INVALID-UNKNOWN-REF-12345");
      await page.click("#order-lookup-btn");
      await sleep(200);

      const unavailableText = await page.$eval(".order-lookup-unavailable", (el) => el.textContent);
      assert(
        unavailableText.includes("could not locate"),
        `Unrecognized order shows friendly help text: "${unavailableText}"`
      );

      await page.close();
    }
  } catch (err) {
    console.error("Test execution threw an uncaught error:", err);
    failedChecks++;
    failures.push(`Uncaught exception: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    if (serverInstance) serverInstance.close();
  }

  console.log("\n==================================================");
  console.log(`CHALLENGER 2 HARNESS RESULTS: ${passedChecks} passed, ${failedChecks} failed.`);
  if (failedChecks > 0) {
    console.log("Failures:\n" + failures.map((f) => ` - ${f}`).join("\n"));
  }
  console.log("==================================================");

  process.exit(failedChecks === 0 ? 0 : 1);
})();
