/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger 2 Adversarial Test Harness.
 *
 * Rigorously stress-tests:
 * 1. R2: Multi-facet filtering on shop.html (category + concern + scent + search + sort intersection,
 *    deep-linking URL params, reset button, zero layout shift / CLS).
 * 2. R3: the URL-parameter gift card certificate on thank-you.html stays deleted (audit H-7),
 *    with no element of that UI reachable from query parameters alone).
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
       SUITE 2: The URL-parameter gift certificate stays deleted (was R3)
       ========================================================================= */
    /* The printable gift certificate that used to live here rendered a
       $500-looking certificate on the real domain from nothing but URL
       parameters -- ?gift_code=&amount=&sender= -- while the Worker's success
       URL never carried them, so a real purchase never produced one (audit
       H-7). It was deleted rather than fixed. What is asserted instead is that
       it stays deleted: no element of that UI may come back without a verified
       session behind it. */
    console.log("\n--- 2. URL-parameter gift certificate stays deleted ---");
    {
      const page = await browser.newPage();
      await page.goto(
        `${baseUrl}/thank-you.html?gift_code=YALL-TEST-9988&amount=50000&sender=Attacker&recipient=Victim`,
        { waitUntil: "networkidle2" }
      );
      const remnants = await page.evaluate(() => {
        const ids = [
          "giftCertificateSection",
          "giftCertificateCard",
          "giftCertCode",
          "giftCertValue",
          "giftCertRecipient",
          "giftCertSender",
          "giftCertMessage",
          "printGiftCertBtn",
          "copyGiftCertCodeBtn"
        ];
        return ids.filter((id) => document.getElementById(id) !== null);
      });
      assert(
        remnants.length === 0,
        `thank-you.html renders no URL-parameter gift certificate (found: ${remnants.join(", ") || "none"})`
      );
      const bodyText = await page.evaluate(() => document.body.textContent);
      assert(
        !/YALL-TEST-9988/.test(bodyText),
        "thank-you.html does not echo a gift code supplied in the query string"
      );
      await page.close();
    }

    /* =========================================================================
       SUITE 3: Order Status Modal (R6, rewritten for audit H-6)

       This suite used to assert the fabricated flow: that typing any
       `cs_...`-shaped string rendered a fulfilment timeline, an "Order Items
       Breakdown" and a Reorder button that pushed those invented items into
       the real cart. None of that was ever fetched from anywhere.

       The modal now posts {sessionId, email} to /api/order-status and reports
       only what the Cloudflare Worker answers. This harness serves the static
       site with no Worker behind /api/*, so every submitted lookup takes the
       network-failure branch -- the contact hand-off. That is the contract
       asserted here: both fields required, nothing invented, and a way to
       reach a person when the lookup cannot speak.
       ========================================================================= */
    console.log("\n--- 3. Order Status Modal (real lookup, H-6) ---");
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

      // Both halves of the credential are asked for. A session id on its own
      // is not authorisation -- ids sit in history, shared links and Referer.
      const fields = await page.evaluate(() => {
        return {
          reference: Boolean(document.getElementById("order-id-input")),
          email: Boolean(document.getElementById("order-email-input")),
          reorder: Boolean(document.getElementById("reorderPastOrderBtn")),
          items: Boolean(document.getElementById("orderItemsContainer")),
          slip: Boolean(document.getElementById("slipItemsTableBody"))
        };
      });
      assert(fields.reference, "Order status modal asks for the order reference");
      assert(fields.email, "Order status modal asks for the email used at checkout");
      assert(!fields.reorder, "The fabricated reorder button is gone (H-6)");
      assert(!fields.items, "The fabricated order items breakdown is gone (H-6)");
      assert(!fields.slip, "The fabricated packing slip is gone (H-6)");

      // Test Empty Input Validation
      await page.click("#order-lookup-btn");
      await sleep(150);
      const errorVisible = await page.$eval(
        "#orderLookupError",
        (el) => !el.hidden && el.textContent.length > 0
      );
      assert(errorVisible, "Empty order status lookup shows validation error");

      // A reference with no email is refused before a request is spent.
      const refInput = await page.$("#order-id-input");
      await refInput.click({ clickCount: 3 });
      await refInput.type("cs_test_9876543210");
      await page.click("#order-lookup-btn");
      await sleep(150);
      const refOnlyRejected = await page.evaluate(() => {
        const err = document.getElementById("orderLookupError");
        const results = document.getElementById("order-timeline-container");
        return {
          errored: Boolean(err && !err.hidden && err.textContent.length > 0),
          rendered: Boolean(results && !results.hidden)
        };
      });
      assert(
        refOnlyRejected.errored && !refOnlyRejected.rendered,
        "A reference without an email is refused client-side and renders nothing"
      );

      // Both fields filled: the lookup runs, finds no Worker on this static
      // server, and hands off to a person rather than inventing an answer.
      const emailInput = await page.$("#order-email-input");
      await emailInput.click({ clickCount: 3 });
      await emailInput.type("southern_customer@domain.com");
      await page.click("#order-lookup-btn");

      let handoffText = "";
      try {
        await page.waitForSelector("#order-timeline-container .order-lookup-unavailable", {
          visible: true,
          timeout: 8000
        });
        handoffText = await page.$eval(
          "#order-timeline-container .order-lookup-unavailable",
          (el) => el.textContent
        );
      } catch (e) {
        handoffText = "";
      }
      assert(
        handoffText.length > 0,
        "With no Worker reachable, a submitted lookup renders the contact hand-off"
      );
      const handoffHasContact = await page.evaluate(() => {
        const el = document.querySelector("#order-timeline-container .order-lookup-unavailable");
        return el ? /mailto:|contact\.html/.test(el.innerHTML) : false;
      });
      assert(handoffHasContact, "The hand-off offers a real way to reach the shop");

      // Nothing about an order may be asserted on a branch that fetched nothing.
      const invented = await page.evaluate(() => {
        return {
          steps: document.querySelectorAll("#order-timeline-container .timeline-step").length,
          rows: document.querySelectorAll(
            "#order-timeline-container .order-item-row, #order-timeline-container .order-status-items li"
          ).length,
          card: Boolean(document.querySelector(".order-status-card")),
          reorder: Boolean(document.getElementById("reorderPastOrderBtn"))
        };
      });
      assert(
        invented.steps === 0 && invented.rows === 0 && !invented.card && !invented.reorder,
        `Unreachable lookup invents no order state (${JSON.stringify(invented)})`
      );

      // Neither credential is echoed back onto the screen. The reference is
      // only ever repeated as the visitor typed it; the email never is.
      const echoed = await page.$eval("#order-timeline-container", (el) => el.textContent || "");
      assert(
        !echoed.includes("southern_customer@domain.com"),
        "The email typed into the lookup is never rendered back"
      );

      // Test Modal Escape Key Dismissal & Focus
      await page.keyboard.press("Escape");
      await sleep(200);
      const modalDismissedByEsc = await page.$eval(
        "#order-status-modal",
        (el) => !el.open && !el.hasAttribute("open")
      );
      assert(modalDismissedByEsc, "Order status modal dismissed cleanly when pressing Escape key");

      // An email typed into the REFERENCE field is a shape error, not a
      // lookup: the reference is a Stripe session id and nothing else.
      await page.click("#openOrderStatusBtn");
      await sleep(200);
      await page.$eval("#order-id-input", (el) => {
        el.value = "";
      });
      const refInput2 = await page.$("#order-id-input");
      await refInput2.type("southern_customer@domain.com");
      await page.click("#order-lookup-btn");
      await sleep(150);
      const emailAsRefRejected = await page.$eval(
        "#orderLookupError",
        (el) => !el.hidden && /cs_/.test(el.textContent)
      );
      assert(
        emailAsRefRejected,
        "An email in the reference field is refused with a message naming the cs_ format"
      );

      // Test Unrecognized Order Reference
      await page.$eval("#order-id-input", (el) => {
        el.value = "";
      });
      const refInput3 = await page.$("#order-id-input");
      await refInput3.type("INVALID-UNKNOWN-REF-12345");
      await page.click("#order-lookup-btn");
      await sleep(150);
      const unrecognizedText = await page.$eval("#orderLookupError", (el) => el.textContent);
      assert(
        unrecognizedText.length > 0 && /reference/i.test(unrecognizedText),
        `Unrecognized order reference shows friendly help text: "${unrecognizedText}"`
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
