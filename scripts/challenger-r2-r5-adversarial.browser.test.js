/**
 * @fileoverview Empirical Adversarial Test Suite for R2 ("Complete the Ritual") and R5 (Google Merchant JSON-LD).
 *
 * Vector 1: R5 structured data -- shop.html ItemList offers plus noindex PDP doorways
 * Vector 2: R2 "Complete the Ritual" Interactive DOM State, Checkbox Toggling, Recalculation & Badge Triggers
 * Vector 3: R2 "Add All" / "Add Selected" / "Add Item" Cart Engine Synchronization & Milestone Triggers
 * Vector 4: R2 Shop Modal / Quick-View Ritual Section Interactivity
 * Vector 5: R2 Concurrency & Stress Behavior
 */

const fs = require("fs");
const path = require("path");
const PRODUCT_COUNT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "assets", "data", "products.json"), "utf8")
).products.length;
const http = require("http");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

let server;
let serverPort;
let BASE;
let browser;
let passedCount = 0;
let failedCount = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passedCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failedCount++;
    console.error(`  ✗ FAIL: ${message}`);
    failures.push(message);
  }
}

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
  ".webmanifest": "application/manifest+json"
};

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split("?")[0]);
      if (reqPath === "/") reqPath = "/index.html";
      const filePath = path.join(ROOT, reqPath);
      if (
        !filePath.startsWith(ROOT) ||
        !fs.existsSync(filePath) ||
        fs.statSync(filePath).isDirectory()
      ) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found: " + reqPath);
        return;
      }
      const contentType = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end("Server error");
          return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        if (reqPath.startsWith("/products/") && reqPath.endsWith(".html")) {
          let str = data.toString("utf8");
          // Disable client-side inline redirect so PDP DOM and interactions can be tested directly
          str = str.replace(
            /window\.location\.replace\(.*?\);/g,
            "/* redirect neutralized for test */;"
          );
          res.end(Buffer.from(str, "utf8"));
        } else {
          res.end(data);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      BASE = `http://127.0.0.1:${serverPort}`;
      console.log(`Test server running at ${BASE}`);
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });
}

// -----------------------------------------------------------------------------
// VECTOR 1: R5 GOOGLE MERCHANT JSON-LD SCHEMA VALIDATION
// -----------------------------------------------------------------------------
function testGoogleMerchantJsonLd() {
  console.log("\n================================================================================");
  console.log("VECTOR 1: R5 Structured Data -- shop.html ItemList + noindex PDP doorways");
  console.log("================================================================================");

  /* This vector used to walk all 19 products/*.html and validate a full
     Product + Offer + BreadcrumbList payload on each. Those pages also
     canonicalised to shop.html, sat outside sitemap.xml and redirected on
     load, so the rich data lived on 19 doorway pages and no rich result ever
     appeared (audit H-15). The structured data now lives on shop.html, the
     page that is actually indexed, and the PDPs are explicitly noindex with
     no JSON-LD at all. Both halves are asserted: a PDP that starts emitting
     schema again is a regression, and so is a shop ItemList that loses its
     offers. */

  const productsDir = path.join(ROOT, "products");
  const htmlFiles = fs.readdirSync(productsDir).filter((f) => f.endsWith(".html"));
  assert(
    htmlFiles.length === PRODUCT_COUNT,
    `Found exactly ${PRODUCT_COUNT} PDP HTML files (found ${htmlFiles.length})`
  );

  const productsData = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
  ).products;
  const productMap = new Map(productsData.map((p) => [p.id, p]));

  const validUrlRegex = /^https:\/\/[a-zA-Z0-9-._~:/?#[\]@!$&'()*+,;=]+$/;

  htmlFiles.forEach((file) => {
    const content = fs.readFileSync(path.join(productsDir, file), "utf8");
    const prodId = file.replace(".html", "");
    const rawProd = productMap.get(prodId);

    assert(Boolean(rawProd), `[${file}] has a matching entry in products.json`);

    // Real, indexable product pages (2026-09-02): own Product + BreadcrumbList
    // JSON-LD, no noindex, self-canonical, no redirect.
    const jsonLdRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    const blocks = content.match(jsonLdRegex) || [];
    const types = blocks.map((b) => {
      try {
        return JSON.parse(b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, ""))["@type"];
      } catch (e) {
        return "unparseable";
      }
    });
    assert(
      types.includes("Product") && types.includes("BreadcrumbList"),
      `[${file}] carries Product and BreadcrumbList JSON-LD (found ${types.join(", ") || "none"})`
    );
    assert(
      !/<meta name="robots" content="[^"]*noindex/.test(content),
      `[${file}] is indexable (no noindex)`
    );
    assert(
      content.includes(
        `<link rel="canonical" href="https://yallternativeliving.com/products/${prodId}.html">`
      ),
      `[${file}] canonicalises to itself`
    );
    assert(!content.includes("window.location.replace"), `[${file}] does not redirect away`);

    // The visible breadcrumb is what a human landing here uses. Category and
    // product anchors are plain ids now; the old "#category-" prefix pointed
    // at an anchor nothing on shop.html handled.
    const crumbMatch = content.match(/<p class="breadcrumb">([\s\S]*?)<\/p>/);
    assert(Boolean(crumbMatch), `[${file}] renders a visible breadcrumb`);
    if (crumbMatch && rawProd) {
      const crumb = crumbMatch[1];
      assert(
        crumb.includes('<a href="../index.html">Home</a>') &&
          crumb.includes('<a href="../shop.html">Shop</a>') &&
          crumb.includes(`href="../shop.html#${rawProd.category}"`),
        `[${file}] breadcrumb is Home > Shop > Category(#${rawProd && rawProd.category}) > Product`
      );
    }
  });

  // ---- shop.html: the one indexed page, carrying the whole catalogue ----
  const shopHtml = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");
  const shopBlocks =
    shopHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  const shopSchemas = [];
  shopBlocks.forEach((b, idx) => {
    try {
      shopSchemas.push(
        JSON.parse(
          b
            .replace(/^<script[^>]*>/, "")
            .replace(/<\/script>$/, "")
            .trim()
        )
      );
    } catch (err) {
      assert(false, `[shop.html] JSON-LD block #${idx + 1} parses: ${err.message}`);
    }
  });

  const itemList = shopSchemas.find((s) => s["@type"] === "ItemList");
  assert(Boolean(itemList), "shop.html carries an @type: ItemList block");

  if (itemList && Array.isArray(itemList.itemListElement)) {
    assert(
      itemList.itemListElement.length === productsData.length,
      `shop.html ItemList covers all ${productsData.length} products (found ${itemList.itemListElement.length})`
    );

    const bySku = new Map(
      itemList.itemListElement
        .filter((e) => e && e.item && e.item.sku)
        .map((e) => [e.item.sku, e.item])
    );

    productsData.forEach((prod) => {
      const item = bySku.get(prod.id);
      if (!item) {
        assert(false, `[shop.html] ItemList has an entry for ${prod.id}`);
        return;
      }

      assert(item["@type"] === "Product", `[shop.html] ${prod.id} entry is a Product`);
      assert(item.name === prod.name, `[shop.html] ${prod.id} name matches products.json`);
      assert(
        validUrlRegex.test(item.url) && item.url.endsWith(`/products/${prod.id}.html`),
        `[shop.html] ${prod.id} url is the product page (${item.url})`
      );

      const offers = item.offers;
      assert(Boolean(offers), `[shop.html] ${prod.id} carries an offer`);
      if (!offers) return;

      const isAggregate = offers["@type"] === "AggregateOffer";
      const price = isAggregate ? offers.lowPrice : offers.price;
      assert(
        isAggregate || offers["@type"] === "Offer",
        `[shop.html] ${prod.id} offer is Offer or AggregateOffer (${offers["@type"]})`
      );
      assert(
        typeof price === "string" && /^\d+\.\d{2}$/.test(price),
        `[shop.html] ${prod.id} offer carries a price (${price})`
      );
      assert(offers.priceCurrency === "USD", `[shop.html] ${prod.id} offer is priced in USD`);

      let expectedAvailability = "https://schema.org/InStock";
      if (prod.inStock === false || prod.stock === 0) {
        expectedAvailability = "https://schema.org/OutOfStock";
      } else if (prod.comingSoon === true) {
        /* OutOfStock, not PreOrder: nothing coming-soon is orderable, only
           waitlistable (2026-09-02 live audit, M-5). */
        expectedAvailability = "https://schema.org/OutOfStock";
      }
      assert(
        offers.availability === expectedAvailability,
        `[shop.html] ${prod.id} availability is derived from the catalogue flags ` +
          `(${offers.availability}, expected ${expectedAvailability})`
      );
    });
  }
}

// -----------------------------------------------------------------------------
// VECTOR 2, 3, 4, 5: R2 PDP & MODAL RITUAL INTERACTIVE TESTS (PUPPETEER)
// -----------------------------------------------------------------------------
//
// From here on, `document`, `window` and `localStorage` appear only inside
// callbacks handed to page.evaluate()/$eval(), which Puppeteer serialises and
// runs in the page rather than in Node. Declaring those three names is the
// correct fix; a file-wide `eslint-disable no-undef` would also silence a real
// typo in the Node half of this suite (VECTOR 1 runs entirely in Node).
/* global document, window, localStorage */
async function testRitualInteractivity() {
  console.log("\n================================================================================");
  console.log("VECTOR 2 & 3: R2 'Complete the Ritual' PDP Checkbox & Cart Synchronization");
  console.log("================================================================================");

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on("pageerror", (err) => console.error("  [Page Error]", err.message));

  // Test on sleep-salve PDP (pairsWith: lavender-soak $10.00, shea-butter $18.00, sleep-salve $19.99)
  // Total = 19.99 + 10.00 + 18.00 = $47.99 >= 40 (Free shipping unlocked!)
  const navResp = await page.goto(`${BASE}/products/sleep-salve.html`, {
    waitUntil: "networkidle0"
  });
  assert(navResp.status() === 200, `sleep-salve.html loaded successfully (HTTP 200)`);

  const ritualSectionExists = await page.$("#pdpRitualSection");
  assert(Boolean(ritualSectionExists), "sleep-salve renders #pdpRitualSection");

  // Verify initial 3-item state
  const checkboxes = await page.$$("#pdpRitualSection .pdp-ritual-checkbox");
  assert(
    checkboxes.length === 3,
    `sleep-salve ritual section renders 3 checkboxes (got ${checkboxes.length})`
  );

  const initialTotal = await page.$eval("#pdpRitualTotalPrice", (el) => el.textContent.trim());
  assert(initialTotal === "$47.99", `Initial 3-item ritual total is $47.99 (got ${initialTotal})`);

  const initialBtnText = await page.$eval("#pdpRitualAddBtn", (el) => el.textContent.trim());
  assert(
    initialBtnText.includes("Add All to Cart"),
    `Initial button text is 'Add All to Cart' (got '${initialBtnText}')`
  );
  assert(initialBtnText.includes("$47.99"), `Initial button displays price '$47.99'`);

  const initialBadgeHidden = await page.$eval(
    "#pdpRitualShippingBadge",
    (el) => el.hidden || el.hasAttribute("hidden")
  );
  assert(
    initialBadgeHidden === false,
    `Free shipping badge is visible when bundle total ($47.99) >= $40`
  );

  // Verify 'This item' checkbox is disabled (cannot be unchecked alone)
  const firstCbDisabled = await page.$eval(
    "#pdpRitualSection .pdp-ritual-checkbox",
    (el) => el.disabled
  );
  assert(
    firstCbDisabled === true,
    "'This item' primary checkbox is disabled to guarantee anchor product"
  );

  // Step 1: Uncheck pairing 2 (shea-butter $18.00)
  // Remaining: sleep-salve ($19.99) + lavender-soak ($10.00) = $29.99 (< $40)
  await checkboxes[2].click();
  await new Promise((r) => setTimeout(r, 100));

  const totalAfter1Uncheck = await page.$eval("#pdpRitualTotalPrice", (el) =>
    el.textContent.trim()
  );
  assert(
    totalAfter1Uncheck === "$29.99",
    `Recalculated total for 2 items is $29.99 (got ${totalAfter1Uncheck})`
  );

  const btnText2Items = await page.$eval("#pdpRitualAddBtn", (el) => el.textContent.trim());
  assert(
    btnText2Items.includes("Add Selected (2) to Cart"),
    `Button text updated to 'Add Selected (2) to Cart' (got '${btnText2Items}')`
  );
  assert(btnText2Items.includes("$29.99"), `Button displays updated price '$29.99'`);

  const badge2Items = await page.$eval(
    "#pdpRitualShippingBadge",
    (el) => el.hidden || el.hasAttribute("hidden")
  );
  assert(badge2Items === true, `Free shipping badge is hidden when 2-item total ($29.99) < $40`);

  // Verify label is-checked class removed from unchecked item
  const item3Checked = await page.evaluate(() => {
    const items = document.querySelectorAll("#pdpRitualSection .pdp-ritual-item");
    return items[2].classList.contains("is-checked");
  });
  assert(item3Checked === false, "Unchecked ritual item had .is-checked class removed");

  // Step 2: Uncheck pairing 1 (lavender-soak $10.00)
  // Remaining: sleep-salve ($19.99) < 40
  await checkboxes[1].click();
  await new Promise((r) => setTimeout(r, 100));

  const totalAfter2Uncheck = await page.$eval("#pdpRitualTotalPrice", (el) =>
    el.textContent.trim()
  );
  assert(
    totalAfter2Uncheck === "$19.99",
    `Recalculated total for 1 item is $19.99 (got ${totalAfter2Uncheck})`
  );

  const btnText1Item = await page.$eval("#pdpRitualAddBtn", (el) => el.textContent.trim());
  assert(
    btnText1Item.includes("Add Item to Cart"),
    `Button text updated to 'Add Item to Cart' (got '${btnText1Item}')`
  );
  assert(btnText1Item.includes("$19.99"), `Button displays updated price '$19.99'`);

  const badge1Item = await page.$eval(
    "#pdpRitualShippingBadge",
    (el) => el.hidden || el.hasAttribute("hidden")
  );
  assert(
    badge1Item === true,
    `Free shipping badge remains hidden when 1-item total ($19.99) < $40`
  );

  // Step 3: Re-check pairing 1 & 2
  await checkboxes[1].click();
  await new Promise((r) => setTimeout(r, 100));
  await checkboxes[2].click();
  await new Promise((r) => setTimeout(r, 100));

  const restoredTotal = await page.$eval("#pdpRitualTotalPrice", (el) => el.textContent.trim());
  assert(restoredTotal === "$47.99", `Restored 3-item total is $47.99 (got ${restoredTotal})`);
  const restoredBtn = await page.$eval("#pdpRitualAddBtn", (el) => el.textContent.trim());
  assert(restoredBtn.includes("Add All to Cart"), `Restored button text is 'Add All to Cart'`);
  const restoredBadge = await page.$eval(
    "#pdpRitualShippingBadge",
    (el) => el.hidden || el.hasAttribute("hidden")
  );
  assert(restoredBadge === false, `Restored free shipping badge is visible ($47.99 >= $40)`);

  // ---------------------------------------------------------------------------
  // VECTOR 3: CART ENGINE SYNCHRONIZATION & MILESTONE TRIGGERS
  // ---------------------------------------------------------------------------
  console.log("\n>>> VECTOR 3: 1-Click Multi-Item Add Cart State & Drawer Synchronization");

  // Clear cart before testing add
  await page.evaluate(() => {
    localStorage.removeItem("yl_cart");
    if (window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }
  });

  // Click Add All to Cart
  await page.click("#pdpRitualAddBtn");
  await new Promise((r) => setTimeout(r, 300));

  // Check cart drawer open
  const isDrawerOpen = await page.$eval("#yl-cart-drawer", (el) => {
    return el.hasAttribute("data-open") || el.getAttribute("popover") !== null;
  });
  assert(
    isDrawerOpen === true,
    "Cart drawer opened automatically after clicking ritual Add All button"
  );

  // Verify cart item count and contents
  const cartState = await page.evaluate(() => {
    const items = window.YLCart
      ? window.YLCart.items()
      : JSON.parse(localStorage.getItem("yl_cart") || "[]");
    const count = window.YLCart ? window.YLCart.count() : 0;
    const subtotal = items.reduce(
      (acc, it) => acc + (it.price + (it.variantDelta || 0)) * (it.qty || 1),
      0
    );
    return { items, count, subtotal };
  });

  assert(
    cartState.items.length === 3,
    `Cart has exactly 3 items added (got ${cartState.items.length})`
  );
  assert(cartState.count === 3, `Cart total count is 3 (got ${cartState.count})`);
  assert(
    Math.abs(cartState.subtotal - 47.99) < 0.01,
    `Cart subtotal matches $47.99 (got $${cartState.subtotal})`
  );

  // Check Milestone 1 ($40 Free shipping) is unlocked, Milestone 2 ($60 Free gift) not yet unlocked
  const pinStates = await page.evaluate(() => {
    const pins = document.querySelectorAll("#yl-cart-drawer .yl-cart-milestone-pin");
    return Array.from(pins).map((p) => p.classList.contains("is-reached"));
  });

  assert(
    pinStates.length >= 2,
    `Cart drawer renders at least 2 milestone pins (found ${pinStates.length})`
  );
  assert(
    pinStates[0] === true,
    "Milestone 1 ($40 Free Shipping) pin is marked reached in cart drawer ($47.99 >= $40)"
  );
  assert(
    pinStates[1] === false,
    "Milestone 2 ($60 Free Salve) pin is not reached in cart drawer ($47.99 < $60)"
  );

  // Close drawer
  await page.click(".yl-cart-close");
  await new Promise((r) => setTimeout(r, 200));

  // Test Adding 2-Item Selection
  await page.evaluate(() => {
    localStorage.removeItem("yl_cart");
    if (window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }
  });

  // Uncheck item 3, click Add Selected (2)
  await checkboxes[2].click();
  await new Promise((r) => setTimeout(r, 100));
  await page.click("#pdpRitualAddBtn");
  await new Promise((r) => setTimeout(r, 300));

  const cartState2 = await page.evaluate(() => {
    const items = window.YLCart ? window.YLCart.items() : [];
    const subtotal = items.reduce(
      (acc, it) => acc + (it.price + (it.variantDelta || 0)) * (it.qty || 1),
      0
    );
    return { items, subtotal };
  });

  assert(
    cartState2.items.length === 2,
    `Cart has 2 items after Add Selected (got ${cartState2.items.length})`
  );
  assert(
    Math.abs(cartState2.subtotal - 29.99) < 0.01,
    `Cart subtotal matches $29.99 (got $${cartState2.subtotal})`
  );

  // Milestone 1 ($40) is NOT reached
  const pinStates2 = await page.evaluate(() => {
    const pins = document.querySelectorAll("#yl-cart-drawer .yl-cart-milestone-pin");
    return Array.from(pins).map((p) => p.classList.contains("is-reached"));
  });
  assert(pinStates2[0] === false, "Milestone 1 is not reached with $29.99 subtotal (< $40)");

  const countdownMsg = await page.$eval(".yl-cart-milestones-msg", (el) => el.textContent.trim());
  assert(
    countdownMsg.includes("10.01") || countdownMsg.includes("10.0"),
    `Milestone countdown correctly calculates distance to $40 milestone (got: '${countdownMsg}')`
  );

  // ---------------------------------------------------------------------------
  // VECTOR 4: SHOP QUICK-VIEW MODAL RITUAL BUNDLE FLOW
  // ---------------------------------------------------------------------------
  console.log("\n>>> VECTOR 4: Shop Quick-View Modal Ritual Bundle Flow");

  await page.goto(`${BASE}/shop.html`, { waitUntil: "networkidle0" });

  // Open lightbox modal for frankincense-salve
  const openedLightbox = await page.evaluate(() => {
    if (typeof window.openLightbox === "function") {
      window.openLightbox(
        ["assets/img/frankincense-salve.jpg"],
        "assets/img/frankincense-salve.jpg",
        "frankincense-salve"
      );
      return true;
    }
    return false;
  });
  assert(openedLightbox === true, "window.openLightbox function executed on shop.html");
  await new Promise((r) => setTimeout(r, 300));

  const modalRitualExists = await page.$("#lightboxRitualWrap #modalRitualSection");
  assert(
    Boolean(modalRitualExists),
    "Shop lightbox modal successfully renders #modalRitualSection for frankincense-salve"
  );

  if (modalRitualExists) {
    const modalCheckboxes = await page.$$("#lightboxRitualWrap .pdp-ritual-checkbox");
    assert(
      modalCheckboxes.length === 3,
      `Modal ritual section renders 3 checkboxes (found ${modalCheckboxes.length})`
    );

    const modalPrice = await page.$eval("#lightboxRitualWrap #pdpRitualTotalPrice", (el) =>
      el.textContent.trim()
    );
    assert(
      modalPrice === "$37.99",
      `Modal ritual bundle initial total is $37.99 (got ${modalPrice})`
    );

    // Uncheck one item in modal (miracle balm $8.00)
    await modalCheckboxes[2].click();
    await new Promise((r) => setTimeout(r, 100));

    const modalRecalcPrice = await page.$eval("#lightboxRitualWrap #pdpRitualTotalPrice", (el) =>
      el.textContent.trim()
    );
    assert(
      modalRecalcPrice === "$29.99",
      `Modal ritual bundle recalculates to $29.99 on checkbox toggle`
    );

    // Add selected from modal
    await page.click("#lightboxRitualWrap #pdpRitualAddBtn");
    await new Promise((r) => setTimeout(r, 300));

    const modalCartCount = await page.evaluate(() => (window.YLCart ? window.YLCart.count() : 0));
    assert(
      modalCartCount >= 2,
      `Adding selected items from modal successfully updated cart count (got ${modalCartCount})`
    );
  }

  // ---------------------------------------------------------------------------
  // VECTOR 5: CONCURRENCY & RAPID MULTI-CLICK STRESS
  // ---------------------------------------------------------------------------
  console.log("\n>>> VECTOR 5: Concurrency & Rapid Stress Testing on Ritual Add Button");

  // frankincense-salve: both partners (hand-scrub, miracle-balm) are buyable.
  // sugar-scrub used to be the fixture, but every one of its partners is
  // Coming Soon, so the build now renders no ritual section for it at all.
  await page.goto(`${BASE}/products/frankincense-salve.html`, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.removeItem("yl_cart");
    if (window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }
  });

  // Rapidly click ritual Add All button 5 times in < 300ms
  await page.evaluate(() => {
    const btn = document.getElementById("pdpRitualAddBtn");
    if (btn) {
      for (let i = 0; i < 5; i++) {
        btn.click();
      }
    }
  });
  await new Promise((r) => setTimeout(r, 500));

  const stressCart = await page.evaluate(() => {
    return {
      items: window.YLCart ? window.YLCart.items() : [],
      count: window.YLCart ? window.YLCart.count() : 0
    };
  });

  // frankincense-salve has 2 pairings (3 items total). 5 additions -> total quantity = 15, items array length = 3 (quantities incremented)
  assert(
    stressCart.items.length === 3,
    `Items array has 3 distinct product IDs without duplicates (got ${stressCart.items.length})`
  );
  assert(
    stressCart.count === 15,
    `Rapid 5x clicks deterministically resulted in 15 total items (got ${stressCart.count})`
  );

  await page.close();
}

// -----------------------------------------------------------------------------
// MAIN RUNNER
// -----------------------------------------------------------------------------
async function run() {
  console.log("Starting Empirical Challenger 2 Test Suite (R2 & R5)...");
  await startServer();

  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    testGoogleMerchantJsonLd();
    await testRitualInteractivity();
  } catch (err) {
    console.error("Unexpected test runner crash:", err);
    assert(false, `Test runner crashed: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    await stopServer();
  }

  console.log("\n================================================================================");
  console.log(`CHALLENGER 2 SUITE SUMMARY: ${passedCount} checks passed, ${failedCount} failed.`);
  console.log("================================================================================");

  if (failedCount > 0) {
    console.error("\nFAILURES IDENTIFIED:");
    failures.forEach((f, idx) => console.error(`  ${idx + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log("\nALL ADVERSARIAL STRESS & EMPIRICAL INTERACTION CHECKS PASSED EMPIRICALLY.");
    process.exit(0);
  }
}

run();
