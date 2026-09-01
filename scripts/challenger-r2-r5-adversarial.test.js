/**
 * @fileoverview Empirical Adversarial Test Suite for R2 ("Complete the Ritual") and R5 (Google Merchant JSON-LD).
 *
 * Vector 1: R5 Google Merchant JSON-LD Schema Validation across all 19 PDPs
 * Vector 2: R2 "Complete the Ritual" Interactive DOM State, Checkbox Toggling, Recalculation & Badge Triggers
 * Vector 3: R2 "Add All" / "Add Selected" / "Add Item" Cart Engine Synchronization & Milestone Triggers
 * Vector 4: R2 Shop Modal / Quick-View Ritual Section Interactivity
 * Vector 5: R2 Concurrency & Stress Behavior
 */

const fs = require("fs");
const path = require("path");
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
  console.log("VECTOR 1: R5 Google Merchant JSON-LD Schema Validation Across All 19 PDPs");
  console.log("================================================================================");

  const productsDir = path.join(ROOT, "products");
  const htmlFiles = fs.readdirSync(productsDir).filter((f) => f.endsWith(".html"));
  assert(htmlFiles.length === 19, `Found exactly 19 PDP HTML files (found ${htmlFiles.length})`);

  const productsData = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
  ).products;
  const productMap = new Map(productsData.map((p) => [p.id, p]));

  const validUrlRegex = /^https:\/\/[a-zA-Z0-9-._~:/?#[\]@!$&'()*+,;=]+$/;
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  htmlFiles.forEach((file) => {
    const filePath = path.join(productsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const prodId = file.replace(".html", "");
    const rawProd = productMap.get(prodId);

    // Extract all JSON-LD blocks
    const jsonLdRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let match;
    const schemas = [];
    while ((match = jsonLdRegex.exec(content)) !== null) {
      try {
        schemas.push(JSON.parse(match[1]));
      } catch (err) {
        assert(false, `[${file}] Invalid JSON in ld+json script tag: ${err.message}`);
      }
    }

    assert(
      schemas.length >= 2,
      `[${file}] Contains at least 2 JSON-LD schemas (found ${schemas.length})`
    );

    const productSchema = schemas.find((s) => s["@type"] === "Product");
    const breadcrumbSchema = schemas.find((s) => s["@type"] === "BreadcrumbList");

    assert(Boolean(productSchema), `[${file}] Schema.org Product schema is present`);
    assert(Boolean(breadcrumbSchema), `[${file}] Schema.org BreadcrumbList schema is present`);

    if (productSchema) {
      // 1. Root Product properties
      assert(
        productSchema["@context"] === "https://schema.org",
        `[${file}] Product @context is https://schema.org`
      );
      assert(
        typeof productSchema.name === "string" && productSchema.name.trim().length > 0,
        `[${file}] Product name is valid non-empty string`
      );
      assert(
        typeof productSchema.description === "string" &&
          productSchema.description.trim().length > 0,
        `[${file}] Product description is valid non-empty string`
      );
      assert(
        validUrlRegex.test(productSchema.url),
        `[${file}] Product url '${productSchema.url}' is valid absolute HTTPS URL`
      );
      assert(
        typeof productSchema.sku === "string" && productSchema.sku.trim().length > 0,
        `[${file}] Product sku '${productSchema.sku}' is non-empty`
      );
      assert(
        typeof productSchema.mpn === "string" && productSchema.mpn.trim().length > 0,
        `[${file}] Product mpn '${productSchema.mpn}' is non-empty`
      );

      // Brand
      assert(
        productSchema.brand && productSchema.brand["@type"] === "Brand",
        `[${file}] Product brand is @type: Brand`
      );
      assert(
        productSchema.brand && productSchema.brand.name === "Y'allternative Living",
        `[${file}] Product brand name is "Y'allternative Living"`
      );

      // Images
      assert(
        Array.isArray(productSchema.image) && productSchema.image.length > 0,
        `[${file}] Product image array has at least 1 image`
      );
      productSchema.image.forEach((imgUrl) => {
        assert(
          validUrlRegex.test(imgUrl),
          `[${file}] Image URL '${imgUrl}' is valid absolute HTTPS URL`
        );
      });

      // Offers / AggregateOffer
      const offers = productSchema.offers;
      assert(Boolean(offers), `[${file}] Product offers object exists`);
      if (offers) {
        const isAggregate = offers["@type"] === "AggregateOffer";
        const isOffer = offers["@type"] === "Offer";
        assert(
          isAggregate || isOffer,
          `[${file}] Offers type is Offer or AggregateOffer (got ${offers["@type"]})`
        );

        if (isAggregate) {
          assert(
            !isNaN(parseFloat(offers.lowPrice)) && !isNaN(parseFloat(offers.highPrice)),
            `[${file}] AggregateOffer has numeric lowPrice (${offers.lowPrice}) and highPrice (${offers.highPrice})`
          );
          assert(
            parseFloat(offers.lowPrice) <= parseFloat(offers.highPrice),
            `[${file}] AggregateOffer lowPrice <= highPrice`
          );
          assert(
            Number.isInteger(offers.offerCount) && offers.offerCount > 1,
            `[${file}] AggregateOffer offerCount is integer > 1 (${offers.offerCount})`
          );
        } else {
          assert(
            !isNaN(parseFloat(offers.price)),
            `[${file}] Offer price is numeric (${offers.price})`
          );
        }

        assert(offers.priceCurrency === "USD", `[${file}] priceCurrency is "USD"`);
        assert(
          isoDateRegex.test(offers.priceValidUntil),
          `[${file}] priceValidUntil '${offers.priceValidUntil}' is ISO YYYY-MM-DD format`
        );
        assert(
          offers.itemCondition === "https://schema.org/NewCondition",
          `[${file}] itemCondition is NewCondition URI`
        );

        // Stock availability
        const validAvailabilities = [
          "https://schema.org/InStock",
          "https://schema.org/OutOfStock",
          "https://schema.org/PreOrder"
        ];
        assert(
          validAvailabilities.includes(offers.availability),
          `[${file}] availability '${offers.availability}' is valid Schema.org URI`
        );

        if (rawProd) {
          if (rawProd.inStock === false || rawProd.stock === 0) {
            assert(
              offers.availability === "https://schema.org/OutOfStock",
              `[${file}] Correctly marked OutOfStock`
            );
          } else if (
            rawProd.comingSoon === true ||
            (rawProd.image && rawProd.image.includes("placeholder"))
          ) {
            assert(
              offers.availability === "https://schema.org/PreOrder",
              `[${file}] Correctly marked PreOrder`
            );
          } else {
            assert(
              offers.availability === "https://schema.org/InStock",
              `[${file}] Correctly marked InStock`
            );
          }
        }

        // Return policy
        const returnPolicy = offers.hasMerchantReturnPolicy;
        assert(Boolean(returnPolicy), `[${file}] hasMerchantReturnPolicy is present in offer`);
        if (returnPolicy) {
          assert(
            returnPolicy["@type"] === "MerchantReturnPolicy",
            `[${file}] returnPolicy @type is MerchantReturnPolicy`
          );
          assert(
            returnPolicy.applicableCountry === "US",
            `[${file}] returnPolicy applicableCountry is US`
          );
          assert(
            returnPolicy.returnPolicyCategory ===
              "https://schema.org/MerchantReturnFiniteReturnWindow",
            `[${file}] returnPolicyCategory is MerchantReturnFiniteReturnWindow URI`
          );
          assert(returnPolicy.merchantReturnDays === 30, `[${file}] merchantReturnDays is 30`);
          assert(
            returnPolicy.returnMethod === "https://schema.org/ReturnByMail",
            `[${file}] returnMethod is ReturnByMail URI`
          );
          assert(
            returnPolicy.returnFees === "https://schema.org/FreeReturn",
            `[${file}] returnFees is FreeReturn URI`
          );
          assert(
            validUrlRegex.test(returnPolicy.returnLink),
            `[${file}] returnLink '${returnPolicy.returnLink}' is valid HTTPS URL`
          );
        }

        // Shipping Details
        const shipping = offers.shippingDetails;
        assert(
          Array.isArray(shipping) && shipping.length === 2,
          `[${file}] shippingDetails contains standard and free shipping tiers (length 2)`
        );
        if (Array.isArray(shipping) && shipping.length === 2) {
          const standardTier = shipping[0];
          const freeTier = shipping[1];

          assert(
            standardTier["@type"] === "OfferShippingDetails",
            `[${file}] Standard shipping @type is OfferShippingDetails`
          );
          assert(
            standardTier.shippingRate &&
              standardTier.shippingRate.value === "10.00" &&
              standardTier.shippingRate.currency === "USD",
            `[${file}] Standard shipping rate is $10.00 USD`
          );
          assert(
            standardTier.shippingDestination &&
              standardTier.shippingDestination.addressCountry === "US",
            `[${file}] Standard shipping destination is US`
          );
          assert(
            standardTier.deliveryTime &&
              standardTier.deliveryTime.handlingTime.minValue === 1 &&
              standardTier.deliveryTime.handlingTime.maxValue === 3,
            `[${file}] Handling time is 1-3 DAYS`
          );
          assert(
            standardTier.deliveryTime &&
              standardTier.deliveryTime.transitTime.minValue === 2 &&
              standardTier.deliveryTime.transitTime.maxValue === 5,
            `[${file}] Transit time is 2-5 DAYS`
          );

          assert(
            freeTier["@type"] === "OfferShippingDetails",
            `[${file}] Free shipping @type is OfferShippingDetails`
          );
          assert(
            freeTier.shippingRate &&
              freeTier.shippingRate.value === "0.00" &&
              freeTier.shippingRate.currency === "USD",
            `[${file}] Free shipping rate is $0.00 USD`
          );
          assert(
            freeTier.freeShippingThreshold &&
              freeTier.freeShippingThreshold.eligibleTransactionVolume.price === "40.00",
            `[${file}] Free shipping threshold is $40.00 USD`
          );
        }
      }

      // AggregateRating
      if (productSchema.aggregateRating) {
        assert(
          productSchema.aggregateRating["@type"] === "AggregateRating",
          `[${file}] aggregateRating @type is AggregateRating`
        );
        assert(
          !isNaN(parseFloat(productSchema.aggregateRating.ratingValue)),
          `[${file}] ratingValue is valid number`
        );
        assert(
          Number.isInteger(productSchema.aggregateRating.reviewCount),
          `[${file}] reviewCount is integer`
        );
        assert(productSchema.aggregateRating.bestRating === "5", `[${file}] bestRating is "5"`);
        assert(productSchema.aggregateRating.worstRating === "1", `[${file}] worstRating is "1"`);
      }
    }

    // BreadcrumbList validation
    if (breadcrumbSchema) {
      assert(
        breadcrumbSchema["@context"] === "https://schema.org",
        `[${file}] Breadcrumb @context is https://schema.org`
      );
      const items = breadcrumbSchema.itemListElement;
      assert(
        Array.isArray(items) && items.length === 4,
        `[${file}] BreadcrumbList has exactly 4 tiers (Home > Shop > Category > Product)`
      );
      if (Array.isArray(items) && items.length === 4) {
        assert(
          items[0].position === 1 &&
            items[0].name === "Home" &&
            items[0].item.endsWith("/index.html"),
          `[${file}] Tier 1 is Home`
        );
        assert(
          items[1].position === 2 &&
            items[1].name === "Shop" &&
            items[1].item.endsWith("/shop.html"),
          `[${file}] Tier 2 is Shop`
        );
        assert(
          items[2].position === 3 && items[2].item.includes("/shop.html#category-"),
          `[${file}] Tier 3 is Category link`
        );
        assert(
          items[3].position === 4 && items[3].item.endsWith(`/products/${prodId}.html`),
          `[${file}] Tier 4 is Product page link`
        );
      }
    }
  });
}

// -----------------------------------------------------------------------------
// VECTOR 2, 3, 4, 5: R2 PDP & MODAL RITUAL INTERACTIVE TESTS (PUPPETEER)
// -----------------------------------------------------------------------------
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

  await page.goto(`${BASE}/products/sugar-scrub.html`, { waitUntil: "networkidle0" });
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

  // sugar-scrub has 2 pairings (3 items total). 5 additions -> total quantity = 15, items array length = 3 (quantities incremented)
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
