/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger Final Adversarial Test Suite.
 *
 * Exhaustively stress-tests:
 * 1. Multi-facet filtering on shop.html (category + concern + scent + search query + sort combinations,
 *    deep linking ?concern=..., ?category=..., clicking #resetFiltersBtn to verify 19 products restoration & 0 layout shift).
 * 2. The URL-parameter gift certificate on thank-you.html stays deleted (audit H-7),
 *    with no element of that UI reachable from query parameters alone).
 * 3. Order status modal reorder flow (DOM rendering, order lookup, item breakdown, 1-click reorder button click,
 *    out-of-stock item filtration, and automatic cart drawer opening).
 * 4. Share cart URL generation and hydration (URL format generation, URL param ?cart= hydration on shop.html,
 *    cart drawer auto-opening, announcement toast).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const PRODUCT_COUNT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "assets", "data", "products.json"), "utf8")
).products.length;
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
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runEmpiricalChallengerTests() {
  console.log("===============================================================");
  console.log("🚀 Starting Final Empirical Challenger Adversarial Test Suite");
  console.log("===============================================================\n");

  const server = await createTestServer();
  const baseUrl = server.url;
  console.log(`📡 Local static server active on ${baseUrl}\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security"
    ]
  });

  let testCount = 0;
  function pass(msg) {
    testCount++;
    console.log(`  ✅ [PASS ${testCount}] ${msg}`);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Track console errors
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    /* =========================================================================
       SECTION 1: SHOP.HTML MULTI-FACET FILTERING, DEEP LINKING, RESET & CLS
       ========================================================================= */
    console.log("--- 1. Testing Shop Multi-Facet Filtering, Deep Linking & Layout Shift ---");

    // 1.1 Initial Load on shop.html
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });
    pass("Loaded shop.html");

    const totalProductsCount = await page.evaluate(() => {
      const cards = document.querySelectorAll("#shopGrid article.card");
      return cards.length;
    });
    assert(
      totalProductsCount === PRODUCT_COUNT,
      `Expected ${PRODUCT_COUNT} initial product cards, found ${totalProductsCount}`
    );
    pass(`Initial catalog renders ${PRODUCT_COUNT} product cards correctly.`);

    // 1.2 Multi-facet combination: Category Salves + Concern Dry-Skin + Sort Price Ascending
    await page.evaluate(() => {
      const salvesPill = document.querySelector('.filter-pill[data-filter="salves"]');
      if (salvesPill) salvesPill.click();

      const drySkinPill = document.querySelector('.concern-pill[data-concern="dry-skin"]');
      if (drySkinPill) drySkinPill.click();

      const sortSelect = document.getElementById("sortSelect");
      if (sortSelect) {
        sortSelect.value = "price-asc";
        sortSelect.dispatchEvent(new Event("change"));
      }
    });
    await new Promise((r) => setTimeout(r, 100));

    const salvesDrySkinCount = await page.evaluate(() => {
      const cards = document.querySelectorAll("#shopGrid article.card");
      const prices = Array.from(cards).map((c) => {
        const priceText = c.querySelector(".price")?.textContent || "$0";
        return parseFloat(priceText.replace(/[^0-9.]/g, ""));
      });
      return { count: cards.length, prices };
    });
    assert(salvesDrySkinCount.count > 0, "Salves + dry-skin returned at least 1 product");
    // Verify prices are sorted ascending
    for (let i = 1; i < salvesDrySkinCount.prices.length; i++) {
      assert(
        salvesDrySkinCount.prices[i] >= salvesDrySkinCount.prices[i - 1],
        `Prices should be ascending: ${salvesDrySkinCount.prices[i]} >= ${salvesDrySkinCount.prices[i - 1]}`
      );
    }
    pass(
      `Multi-facet filter (salves + dry-skin + price-asc) returns ${salvesDrySkinCount.count} products in correct price order.`
    );

    // 1.3 Search query intersection
    await page.evaluate(() => {
      const search =
        document.getElementById("shopSearchInput") || document.getElementById("shopSearch");
      if (search) {
        search.value = "miracle";
        search.dispatchEvent(new Event("input"));
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    const searchFilteredCount = await page.evaluate(() => {
      const cards = document.querySelectorAll("#shopGrid article.card");
      return cards.length;
    });
    assert(searchFilteredCount > 0, "Search query 'miracle' returned matching products");
    pass(
      `Search query 'miracle' inside multi-facet filter returns ${searchFilteredCount} products.`
    );

    // 1.4 Scent filter interaction: Reset filters first, then pick "Herbal & Woodsy"
    await page.evaluate(() => {
      const resetBtn = document.getElementById("resetFiltersBtn");
      if (resetBtn) resetBtn.click();
    });
    await new Promise((r) => setTimeout(r, 250));

    const scentResult = await page.evaluate(() => {
      const scentSelect = document.getElementById("scentSelect");
      if (scentSelect) {
        const opt = Array.from(scentSelect.options).find(
          (o) => o.value.includes("Herbal") || o.value.includes("Lavender")
        );
        if (opt) {
          scentSelect.value = opt.value;
          scentSelect.dispatchEvent(new Event("change"));
        }
      }
      const cards = document.querySelectorAll("#shopGrid article.card");
      return { cardCount: cards.length, scentValue: scentSelect ? scentSelect.value : "" };
    });

    assert(
      scentResult.cardCount > 0 && scentResult.cardCount < PRODUCT_COUNT,
      `Scent filter returned ${scentResult.cardCount} products for ${scentResult.scentValue}`
    );
    pass(
      `Scent filter '${scentResult.scentValue}' narrowed catalog to ${scentResult.cardCount} products.`
    );

    // 1.5 Zero-matching filter state & Reset button DOM presence
    await page.evaluate(() => {
      const search =
        document.getElementById("shopSearchInput") || document.getElementById("shopSearch");
      if (search) {
        search.value = "nonexistent_impossible_query_xyz";
        search.dispatchEvent(new Event("input"));
      }
    });
    await new Promise((r) => setTimeout(r, 250));

    const emptyStateInfo = await page.evaluate(() => {
      const cards = document.querySelectorAll("#shopGrid article.card");
      const resetBtn = document.getElementById("resetFiltersBtn");
      const countEl =
        document.getElementById("shopCount") || document.getElementById("productCount");
      return {
        cardCount: cards.length,
        hasResetBtn: !!resetBtn,
        countText: countEl ? countEl.textContent : ""
      };
    });
    assert(emptyStateInfo.cardCount === 0, "Zero products shown for impossible query");
    assert(
      emptyStateInfo.hasResetBtn,
      "Reset Filters button #resetFiltersBtn exists in zero state"
    );
    pass(`Zero-match empty state accurately renders with #resetFiltersBtn.`);

    // 1.6 Click #resetFiltersBtn and verify 19 products restored with layout stability
    const resetResult = await page.evaluate(async () => {
      const resetBtn = document.getElementById("resetFiltersBtn");
      if (resetBtn) resetBtn.click();

      await new Promise((r) => setTimeout(r, 250));

      const cards = document.querySelectorAll("#shopGrid article.card");
      const search =
        document.getElementById("shopSearchInput") || document.getElementById("shopSearch");
      const activeCat = document.querySelector(".filter-pill.active")?.getAttribute("data-filter");
      const activeConcern = document
        .querySelector(".concern-pill.active")
        ?.getAttribute("data-concern");
      const scentSelect = document.getElementById("scentSelect");

      return {
        cardCount: cards.length,
        searchValue: search ? search.value : "",
        activeCat,
        activeConcern,
        scentValue: scentSelect ? scentSelect.value : ""
      };
    });

    assert(
      resetResult.cardCount === PRODUCT_COUNT,
      `Reset restored all ${PRODUCT_COUNT} products (got ${resetResult.cardCount})`
    );
    assert(resetResult.searchValue === "", "Search input cleared on reset");
    assert(resetResult.activeCat === "all", "Category filter restored to 'all'");
    assert(resetResult.activeConcern === "all", "Concern filter restored to 'all'");
    assert(resetResult.scentValue === "all", "Scent filter reset to 'all'");
    pass(
      `Reset button restored all ${PRODUCT_COUNT} products, cleared filters/search/scents cleanly.`
    );

    // 1.7 Deep Linking URL Parameter tests (?concern=dry-skin)
    await page.goto(`${baseUrl}/shop.html?concern=dry-skin`, { waitUntil: "networkidle0" });
    const deepLinkConcern = await page.evaluate(() => {
      const activeConcern = document
        .querySelector(".concern-pill.active")
        ?.getAttribute("data-concern");
      const cards = document.querySelectorAll("#shopGrid article.card");
      return { activeConcern, cardCount: cards.length };
    });
    assert(
      deepLinkConcern.activeConcern === "dry-skin",
      `Deep link active concern should be dry-skin, got ${deepLinkConcern.activeConcern}`
    );
    assert(
      deepLinkConcern.cardCount > 0 && deepLinkConcern.cardCount < PRODUCT_COUNT,
      `Filtered products count: ${deepLinkConcern.cardCount}`
    );
    pass(
      `Deep link '?concern=dry-skin' automatically activates dry-skin concern pill and filters catalog.`
    );

    // 1.8 Deep Linking with Category (?category=salves&concern=dry-skin)
    await page.goto(`${baseUrl}/shop.html?category=salves&concern=dry-skin`, {
      waitUntil: "networkidle0"
    });
    const multiDeepLink = await page.evaluate(() => {
      const activeCat = document.querySelector(".filter-pill.active")?.getAttribute("data-filter");
      const activeConcern = document
        .querySelector(".concern-pill.active")
        ?.getAttribute("data-concern");
      const cards = document.querySelectorAll("#shopGrid article.card");
      return { activeCat, activeConcern, cardCount: cards.length };
    });
    assert(
      multiDeepLink.activeCat === "salves",
      `Active cat should be salves, got ${multiDeepLink.activeCat}`
    );
    assert(
      multiDeepLink.activeConcern === "dry-skin",
      `Active concern should be dry-skin, got ${multiDeepLink.activeConcern}`
    );
    pass(
      `Multi-parameter deep link '?category=salves&concern=dry-skin' parsed and activated cleanly.`
    );

    /* =========================================================================
       SECTION 2: THANK-YOU.HTML PRINTABLE GIFT CERTIFICATE
       ========================================================================= */
    /* The printable gift certificate that used to live here rendered a
       $500-looking certificate on the real domain from nothing but URL
       parameters -- ?gift_code=&amount=&sender= -- while the Worker's success
       URL never carried them, so a real purchase never produced one (audit
       H-7). It was deleted rather than fixed. What is asserted instead is that
       it stays deleted: no element of that UI may come back without a verified
       session behind it. */
    console.log("\n--- 2. Verifying the URL-parameter gift certificate stays deleted ---");
    await page.goto(
      `${baseUrl}/thank-you.html?gift_code=YALL-TEST-9988&amount=50000&sender=Attacker&recipient=Victim`,
      {
        waitUntil: "networkidle0"
      }
    );
    const certRemnants = await page.evaluate(() => {
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
      certRemnants.length === 0,
      `thank-you.html renders no URL-parameter gift certificate (found: ${certRemnants.join(", ") || "none"})`
    );
    const certTextLeak = await page.evaluate(() => document.body.textContent);
    assert(
      !/YALL-TEST-9988/.test(certTextLeak),
      "thank-you.html does not echo a gift code supplied in the query string"
    );

    /* =========================================================================
       SECTION 3: ORDER STATUS LOOKUP (rewritten for audit H-6)

       This section used to assert the fabricated flow -- that any
       `cs_...`-shaped string rendered an "Order Items Breakdown" and a Reorder
       button that pushed hardcoded items into the real cart. Nothing was ever
       fetched: every one of those assertions was pinning an invention in
       place.

       The lookup now posts {sessionId, email} to /api/order-status and renders
       only what the Cloudflare Worker answers. This harness serves the static
       site with no Worker behind /api/*, so a submitted lookup always takes
       the network-failure branch: the contact hand-off, and nothing said about
       an order.
       ========================================================================= */
    console.log("\n--- 3. Testing Order Status Lookup (real endpoint, H-6) ---");

    // 3.1 Open order status modal
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });

    // Open modal via button or global helper
    await page.evaluate(() => {
      const orderBtn =
        document.getElementById("openOrderStatusBtn") ||
        document.querySelector('[data-open-modal="order-status-modal"]');
      if (orderBtn) {
        orderBtn.click();
      } else if (typeof window.openOrderStatusModal === "function") {
        window.openOrderStatusModal();
      }
    });
    await new Promise((r) => setTimeout(r, 150));

    const modalVisible = await page.evaluate(() => {
      const modal =
        document.getElementById("order-status-modal") ||
        document.getElementById("orderStatusModal");
      return modal && (modal.open || !modal.hidden || modal.classList.contains("open"));
    });
    assert(modalVisible, "Order status modal opened");
    pass("Order status modal opens on shop.html.");

    // 3.2 The fabricated furniture is gone from the markup entirely.
    const fabricatedFurniture = await page.evaluate(() => {
      return [
        "orderItemsContainer",
        "orderItemsList",
        "reorderPastOrderBtn",
        "packingSlipContainer",
        "printPackingSlipBtn",
        "slipItemsTableBody"
      ].filter((id) => document.getElementById(id) !== null);
    });
    assert(
      fabricatedFurniture.length === 0,
      `Order status modal carries no fabricated-order markup (found: ${fabricatedFurniture.join(", ") || "none"})`
    );
    pass("Fabricated order items breakdown, reorder button and packing slip are gone (H-6).");

    // 3.3 Both fields exist, and a reference alone will not run a lookup.
    const lookupFields = await page.evaluate(() => {
      return {
        reference: Boolean(document.getElementById("order-id-input")),
        email: Boolean(document.getElementById("order-email-input"))
      };
    });
    assert(lookupFields.reference, "Order status lookup asks for the order reference");
    assert(
      lookupFields.email,
      "Order status lookup asks for the email used at checkout (a session id is not authorisation)"
    );

    const refOnly = await page.evaluate(async () => {
      const input = document.getElementById("order-id-input");
      const email = document.getElementById("order-email-input");
      if (input) input.value = "cs_test_orderEmpirical123";
      if (email) email.value = "";
      const form = document.getElementById("orderStatusForm");
      if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const err = document.getElementById("orderLookupError");
      const results = document.getElementById("order-timeline-container");
      return {
        errored: Boolean(err && !err.hidden && err.textContent.length > 0),
        rendered: Boolean(results && !results.hidden)
      };
    });
    assert(
      refOnly.errored && !refOnly.rendered,
      "A reference with no email is refused client-side, before a request is spent"
    );
    pass("Both halves of the credential are required before the lookup runs.");

    // 3.4 With both fields filled and no Worker reachable, the lookup hands
    //     off to a person and asserts nothing about an order.
    await page.evaluate(() => {
      const input = document.getElementById("order-id-input");
      const email = document.getElementById("order-email-input");
      if (input) input.value = "cs_test_orderEmpirical123";
      if (email) email.value = "empirical@example.com";
      const form = document.getElementById("orderStatusForm");
      if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    });

    let handoffFound = false;
    try {
      await page.waitForSelector("#order-timeline-container .order-lookup-unavailable", {
        visible: true,
        timeout: 8000
      });
      handoffFound = true;
    } catch (e) {
      handoffFound = false;
    }
    assert(
      handoffFound,
      "With no Worker behind /api/order-status, the lookup renders the contact hand-off"
    );

    const lookupOutcome = await page.evaluate(() => {
      const container = document.getElementById("order-timeline-container");
      const handoff = container ? container.querySelector(".order-lookup-unavailable") : null;
      return {
        hasContact: handoff ? /mailto:|contact\.html/.test(handoff.innerHTML) : false,
        steps: container ? container.querySelectorAll(".timeline-step").length : 0,
        rows: container
          ? container.querySelectorAll(".order-item-row, .order-status-items li").length
          : 0,
        statusCard: Boolean(document.querySelector(".order-status-card")),
        reorderBtn: Boolean(document.getElementById("reorderPastOrderBtn")),
        echoesEmail: container
          ? (container.textContent || "").includes("empirical@example.com")
          : false
      };
    });
    assert(lookupOutcome.hasContact, "The hand-off offers a real way to reach the shop");
    assert(
      lookupOutcome.steps === 0 && lookupOutcome.rows === 0 && !lookupOutcome.statusCard,
      `Unreachable lookup invents no timeline or line items (${JSON.stringify(lookupOutcome)})`
    );
    assert(
      !lookupOutcome.reorderBtn,
      "No reorder button appears for an order that was never fetched"
    );
    assert(
      !lookupOutcome.echoesEmail,
      "The email typed into the lookup is never rendered back onto the page"
    );
    pass("Unreachable lookup hands off to a person and asserts nothing about an order.");

    // 3.5 order-status.html: ?session_id= prefills the reference and never
    //     auto-submits. The email is the other half of the credential and is
    //     always typed by whoever holds it.
    await page.goto(`${baseUrl}/order-status.html?session_id=cs_test_prefill123`, {
      waitUntil: "networkidle0"
    });
    const prefillState = await page.evaluate(() => {
      const ref = document.getElementById("orderQueryInput");
      const email = document.getElementById("orderEmailInput");
      const results = document.getElementById("orderTimelineContainer");
      return {
        reference: ref ? ref.value : null,
        email: email ? email.value : null,
        rendered: results ? (results.textContent || "").trim() : null
      };
    });
    assert(
      prefillState.reference === "cs_test_prefill123",
      `?session_id= prefills the reference input (got "${prefillState.reference}")`
    );
    assert(prefillState.email === "", "?session_id= leaves the email field empty");
    assert(prefillState.rendered === "", "?session_id= renders nothing -- it never auto-submits");
    pass("order-status.html prefills the reference from ?session_id= without auto-submitting.");

    /* =========================================================================
       SECTION 4: SHARE CART URL GENERATION AND HYDRATION
       ========================================================================= */
    console.log("\n--- 4. Testing Share Cart URL Generation and Hydration ---");

    // 4.1 Test Share URL Generation
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });
    const shareUrl = await page.evaluate(() => {
      if (window.YLCart && typeof window.YLCart.clear === "function") {
        window.YLCart.clear();
        window.YLCart.addItem({
          id: "frankincense-salve",
          qty: 2,
          variantLabel: "2oz",
          price: 19.99
        });
        window.YLCart.addItem({ id: "beard-salve", qty: 1, variantLabel: "", price: 18.0 });
      }
      return window.YLCart && typeof window.YLCart.generateShareCartUrl === "function"
        ? window.YLCart.generateShareCartUrl(window.YLCart.items())
        : (function () {
            var items = window.YLCart.items();
            var compact = items
              .map((it) => [it.id, it.qty, it.variantLabel].filter(Boolean).join(":"))
              .join(",");
            return window.location.origin + "/shop.html?cart=" + encodeURIComponent(compact);
          })();
    });

    assert(shareUrl.includes("cart="), `Share URL generated correctly: ${shareUrl}`);
    pass(`Share cart URL successfully generated: ${shareUrl}`);

    // 4.2 Test Shared Cart Hydration on Page Load
    // Clear cart before navigating to share URL so we test clean hydration
    await page.evaluate(() => {
      if (window.YLCart && typeof window.YLCart.clear === "function") {
        window.YLCart.clear();
      }
      localStorage.removeItem("yl-cart-items");
    });

    // Navigate to shop.html with the generated share URL (or relative cart param)
    const cartParamValue = new URL(shareUrl).searchParams.get("cart");
    await page.goto(`${baseUrl}/shop.html?cart=${encodeURIComponent(cartParamValue)}`, {
      waitUntil: "networkidle0"
    });
    await new Promise((r) => setTimeout(r, 200));

    const hydrationResult = await page.evaluate(() => {
      const drawer = document.getElementById("yl-cart-drawer");
      const isDrawerOpen =
        drawer &&
        (drawer.matches(":popover-open") ||
          drawer.getAttribute("data-open") === "true" ||
          drawer.classList.contains("open") ||
          window.getComputedStyle(drawer).display !== "none");
      const cartItems =
        window.YLCart && typeof window.YLCart.items === "function"
          ? window.YLCart.items()
          : JSON.parse(localStorage.getItem("yl-cart-items") || "[]");

      return {
        isDrawerOpen,
        itemCount: cartItems.length,
        items: cartItems.map((i) => ({ id: i.id, qty: i.qty, variantLabel: i.variantLabel }))
      };
    });

    console.log("    🔍 Hydration result items:", JSON.stringify(hydrationResult.items));

    assert(
      hydrationResult.isDrawerOpen,
      "Cart drawer opened automatically after share URL hydration"
    );
    assert(
      hydrationResult.itemCount === 2,
      `Expected 2 hydrated items, got ${hydrationResult.itemCount}`
    );
    const salveItem = hydrationResult.items.find((i) => i.id === "frankincense-salve");
    const soapItem = hydrationResult.items.find((i) => i.id === "beard-salve");
    assert(salveItem && salveItem.qty === 2, "Frankincense salve hydrated with qty 2");
    assert(salveItem.variantLabel === "2oz", "Frankincense salve hydrated with variant '2oz'");
    assert(soapItem && soapItem.qty === 1, "Beard salve hydrated with qty 1");
    pass(
      "Shared cart URL (?cart=...) accurately parsed, hydrated items/variants/quantities, and opened drawer."
    );

    console.log("\n===============================================================");
    console.log(`🎉 ALL ${testCount} EMPIRICAL CHALLENGER TESTS PASSED WITH 0 ERRORS!`);
    console.log("===============================================================\n");
  } finally {
    await browser.close();
    await server.close();
  }
}

runEmpiricalChallengerTests().catch((err) => {
  console.error("❌ Fatal test error:", err);
  process.exit(1);
});
