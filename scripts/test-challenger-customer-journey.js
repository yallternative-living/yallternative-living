/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger Customer Journey & Adversarial Verification Harness
 *
 * Exhaustively stress-tests:
 * 1. Search modal:
 *    - Rapid opening/closing (Cmd+K 10x, trigger click, Escape, backdrop, close button, focus restoration).
 *    - Empty & whitespace queries, clear button restoration.
 *    - Special characters & security stress (HTML/XSS injection resilience, regex chars, unicode/emoji).
 *    - In-modal variant selection (open picker, select variant, verify delta).
 *    - Direct cart addition from search results.
 * 2. Cart drawer:
 *    - Item quantity rapid increments (<50ms concurrency test).
 *    - Quantity decrements down to 0 / removal.
 *    - Line-item removal & Undo restoration (especially on empty cart with 0 items).
 *    - Shipping milestone meter calculations & boundary math ($40 free shipping / $60 free pocket salve).
 *    - Checkout in-flight double-click locking & request throttling.
 * 3. PDP interactions:
 *    - Two-way variant synchronization between main form radios and mobile sticky bar.
 *    - Mobile sticky bar scroll visibility transitions.
 *    - Quantity stepping and input clamping (min 1, max 10).
 *    - Ritual bundle section: 24px target compliance, live price calculation, add-on toggling, multi-item batch add.
 *
 * Runs against BOTH:
 * - Local static server (http://127.0.0.1:<port>)
 * - Live production website (https://yallternativeliving.com)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function createTestServer() {
  const root = path.resolve(__dirname, "..");
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
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
      resolve({ server, port });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;
const failures = [];

function check(assertion, message) {
  totalChecks++;
  if (assertion) {
    passedChecks++;
    console.log(`    ✓ ${message}`);
  } else {
    failedChecks++;
    failures.push(message);
    console.error(`    ✗ FAIL: ${message}`);
  }
}

async function runEnvironmentTests(envName, baseUrl, browser, isLiveProd) {
  console.log(`\n================================================================================`);
  console.log(`TESTING ENVIRONMENT: ${envName} (${baseUrl})`);
  console.log(`================================================================================`);

  const page = await browser.newPage();
  const consoleErrors = [];
  const uncaughtExceptions = [];

  page.on("pageerror", (err) => {
    uncaughtExceptions.push(err.message);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (
        !text.includes("tawk.to") &&
        !text.includes("ServiceWorker") &&
        !text.includes("favicon") &&
        !text.includes("Failed to load resource") &&
        !text.includes("gateway.umami.is")
      ) {
        consoleErrors.push(text);
      }
    }
  });

  // Track any unexpected alert/dialog (e.g. from XSS)
  let dialogFired = false;
  page.on("dialog", async (dialog) => {
    dialogFired = true;
    console.error(`    [ALERT TRIGGERED]: ${dialog.message()}`);
    await dialog.dismiss();
  });

  // ---------------------------------------------------------------------------
  // SECTION 1: Search Modal Adversarial Verification
  // ---------------------------------------------------------------------------
  console.log(`\n--- [1] Search Modal Adversarial Interactions ---`);
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });

  // 1.1 Rapid Opening & Closing Cycles
  console.log(`  [1.1] Rapid Opening / Closing Lifecycle`);
  // Click open via trigger
  await page.click("#globalSearchTrigger");
  await sleep(100);
  let isOpen = await page.evaluate(() => {
    const m = document.getElementById("global-search-modal");
    return m && (m.hasAttribute("open") || m.open === true);
  });
  check(isOpen, "Search modal opens when #globalSearchTrigger is clicked");

  let triggerAria = await page.evaluate(() => {
    const t = document.getElementById("globalSearchTrigger");
    return t ? t.getAttribute("aria-expanded") : null;
  });
  check(triggerAria === "true", "Search trigger has aria-expanded='true' when open");

  // Close via Escape
  await page.keyboard.press("Escape");
  await sleep(100);
  let isClosed = await page.evaluate(() => {
    const m = document.getElementById("global-search-modal");
    return m && !m.hasAttribute("open") && m.open !== true;
  });
  check(isClosed, "Search modal closes when Escape is pressed");

  // Re-open and close via close button
  await page.click("#globalSearchTrigger");
  await sleep(100);
  await page.click("#globalSearchCloseBtn");
  await sleep(100);
  isClosed = await page.evaluate(() => {
    const m = document.getElementById("global-search-modal");
    return m && !m.hasAttribute("open");
  });
  check(isClosed, "Search modal closes when #globalSearchCloseBtn is clicked");

  // Rapid Cmd+K / Ctrl+K toggling (10 rapid cycles)
  const isMac = process.platform === "darwin";
  const modKey = isMac ? "Meta" : "Control";
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down(modKey);
    await page.keyboard.press("KeyK");
    await page.keyboard.up(modKey);
    await sleep(40);
  }
  // Check modal didn't crash or lock up
  let modalExists = await page.evaluate(() => !!document.getElementById("global-search-modal"));
  check(modalExists, "Search modal remains stable after 10 rapid shortcut toggles");

  // Ensure modal is closed before next step
  await page.evaluate(() => {
    const m = document.getElementById("global-search-modal");
    if (m && typeof m.close === "function") m.close();
    else if (m) m.removeAttribute("open");
  });
  await sleep(100);

  // 1.2 Empty & Whitespace Queries
  console.log(`  [1.2] Empty & Whitespace Query Handling`);
  await page.click("#globalSearchTrigger");
  await sleep(100);

  let chipsVisible = await page.evaluate(() => {
    const c = document.getElementById("globalSearchChipsSection");
    return c && c.hidden === false;
  });
  check(chipsVisible, "Search chips section visible on empty input");

  let resultsCount = await page.evaluate(() => {
    const list = document.getElementById("globalSearchResultsList");
    return list ? list.children.length : -1;
  });
  check(resultsCount === 0, "No search results rendered on empty query");

  // Type whitespace only
  await page.focus("#globalSearchInput");
  await page.keyboard.type("     ");
  await sleep(200);

  let whitespaceChipsVisible = await page.evaluate(() => {
    const c = document.getElementById("globalSearchChipsSection");
    const list = document.getElementById("globalSearchResultsList");
    return c && c.hidden === false && (!list || list.children.length === 0);
  });
  check(
    whitespaceChipsVisible,
    "Whitespace-only query preserves chips and renders zero results without error"
  );

  // Clear query via clear button
  await page.keyboard.type("salve");
  await sleep(200);
  await page.click("#globalSearchClearBtn");
  await sleep(100);
  let inputCleared = await page.evaluate(() => {
    const inp = document.getElementById("globalSearchInput");
    const chips = document.getElementById("globalSearchChipsSection");
    return inp && inp.value === "" && chips && chips.hidden === false;
  });
  check(inputCleared, "Clear button resets search query and restores chip suggestions");

  // 1.3 Special Characters & Security Stress
  console.log(`  [1.3] Special Characters & Security Stress`);
  // XSS Payload
  await page.focus("#globalSearchInput");
  await page.keyboard.type("<script>alert('xss')</script>");
  await sleep(250);
  check(!dialogFired, "XSS payload did not trigger javascript alert/dialog");

  let emptyStateEscaped = await page.evaluate(() => {
    const list = document.getElementById("globalSearchResultsList");
    if (!list) return false;
    const title = list.querySelector(".search-empty-title");
    return title && title.textContent.includes("<script>alert('xss')</script>");
  });
  check(emptyStateEscaped, "XSS search query properly escaped in empty state title");

  // Regex special characters
  await page.click("#globalSearchClearBtn");
  await page.focus("#globalSearchInput");
  await page.keyboard.type(".*+?^${}()|[]\\");
  await sleep(250);
  let regexHandled = await page.evaluate(() => {
    const list = document.getElementById("globalSearchResultsList");
    return !!list && list.querySelector(".search-empty-state") !== null;
  });
  check(regexHandled, "Regex metacharacters query handled safely without throwing SyntaxError");

  // Unicode / Emoji query
  await page.click("#globalSearchClearBtn");
  await page.focus("#globalSearchInput");
  await page.keyboard.type("🌿 salve");
  await sleep(250);
  let unicodeHandled = await page.evaluate(() => {
    const list = document.getElementById("globalSearchResultsList");
    return !!list;
  });
  check(unicodeHandled, "Unicode / Emoji query handled gracefully");

  // 1.4 In-Modal Variant Selection
  console.log(`  [1.4] In-Modal Variant Selection & Direct Cart Addition`);
  await page.click("#globalSearchClearBtn");
  await page.focus("#globalSearchInput");
  await page.keyboard.type("salve");
  await sleep(300);

  let variantTriggerFound = await page.evaluate(() => {
    const triggers = document.querySelectorAll(
      "#globalSearchResultsList .search-variant-trigger[data-item-id='frankincense-salve']"
    );
    return triggers.length > 0;
  });
  check(
    variantTriggerFound,
    "Found variant trigger button for multi-variant product in search results"
  );

  if (variantTriggerFound) {
    await page.click(
      "#globalSearchResultsList .search-variant-trigger[data-item-id='frankincense-salve']"
    );
    await sleep(150);

    let pickerExpanded = await page.evaluate(() => {
      const actionWrap = document.querySelector(
        "#globalSearchResultsList .search-item-action[data-product-id='frankincense-salve']"
      );
      const picker = actionWrap ? actionWrap.querySelector(".search-variant-picker") : null;
      return actionWrap && actionWrap.classList.contains("is-expanded") && picker && !picker.hidden;
    });
    check(pickerExpanded, "Clicking variant trigger expands .search-variant-picker");

    // Click 1oz variant chip
    let chipClicked = await page.evaluate(() => {
      const chip = document.querySelector(
        "#globalSearchResultsList .search-variant-chip[data-variant-label='1oz']"
      );
      if (chip) {
        chip.click();
        return true;
      }
      return false;
    });
    check(chipClicked, "Clicked 1oz variant chip in search modal");
    await sleep(200);

    // Verify item was added to YLCart
    let cartHasVariant = await page.evaluate(() => {
      if (!window.YLCart || typeof window.YLCart.items !== "function") return false;
      const items = window.YLCart.items();
      return items.some(
        (i) =>
          i.id === "frankincense-salve" &&
          (i.variantLabel === "1oz" || i.variant === "1oz" || (i.name && i.name.includes("1oz")))
      );
    });
    check(cartHasVariant, "1oz variant item successfully added to cart from search modal");
  }

  // Close modal
  await page.evaluate(() => {
    const m = document.getElementById("global-search-modal");
    if (m && typeof m.close === "function") m.close();
  });
  await sleep(150);

  // ---------------------------------------------------------------------------
  // SECTION 2: Cart Drawer Adversarial Verification
  // ---------------------------------------------------------------------------
  console.log(`\n--- [2] Cart Drawer Adversarial Interactions ---`);

  // Clear cart to start clean
  await page.evaluate(() => {
    if (window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }
  });
  await sleep(100);

  // Add 1 base item: Frankincense Salve ($19.99)
  await page.evaluate(() => {
    window.YLCart.addItem({
      id: "frankincense-salve",
      name: "Y'all Heal Now Miracle Frankincense Salve",
      price: 19.99,
      image: "/assets/img/frankincense-salve.jpg",
      qty: 1
    });
  });
  await sleep(150);

  // Open cart drawer
  await page.evaluate(() => {
    if (window.YLCart && typeof window.YLCart.open === "function") {
      window.YLCart.open();
    }
  });
  await sleep(200);

  // 2.1 Rapid Increments (<50ms intervals)
  console.log(`  [2.1] Rapid Item Quantity Increments`);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const inc = document.querySelector(".yl-cart-drawer button[data-cart-action='inc']");
      if (inc) inc.click();
    });
    await sleep(40);
  }
  await sleep(200);

  let qtyAfterInc = await page.evaluate(() => {
    const items = window.YLCart.items();
    return items.length ? items[0].qty : -1;
  });
  check(
    qtyAfterInc === 6,
    `Rapid quantity increments reached exact quantity 6 (actual: ${qtyAfterInc})`
  );

  let subtotalAfterInc = await page.evaluate(() => {
    const subStrong = document.querySelector(".yl-cart-drawer .yl-cart-subtotal strong");
    return subStrong ? subStrong.textContent.trim() : "";
  });
  check(
    subtotalAfterInc === "$119.94",
    `Subtotal correctly recalculated to $119.94 (actual: ${subtotalAfterInc})`
  );

  // 2.2 Decrements down to 1
  console.log(`  [2.2] Quantity Decrements`);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const dec = document.querySelector(".yl-cart-drawer button[data-cart-action='dec']");
      if (dec) dec.click();
    });
    await sleep(40);
  }
  await sleep(200);

  let qtyAfterDec = await page.evaluate(() => {
    const items = window.YLCart.items();
    return items.length ? items[0].qty : -1;
  });
  check(qtyAfterDec === 2, `Quantity decremented cleanly to 2 (actual: ${qtyAfterDec})`);

  // 2.3 Line-item removal & Undo Restoration (Empty Cart Stress)
  console.log(`  [2.3] Line-item Removal & Undo Restoration on Empty Cart`);
  // Remove item by clicking button[data-cart-action="remove"]
  await page.evaluate(() => {
    const rem = document.querySelector(".yl-cart-drawer button[data-cart-action='remove']");
    if (rem) rem.click();
  });
  await sleep(200);

  let emptyCartCount = await page.evaluate(() => window.YLCart.items().length);
  check(emptyCartCount === 0, "Cart is now completely empty (0 items)");

  // Verify Undo banner is present in footer DESPITE empty cart
  let undoNoticePresent = await page.evaluate(() => {
    const notice = document.querySelector(".yl-cart-drawer .yl-cart-undo-notice");
    const undoBtn = document.querySelector(".yl-cart-drawer button[data-cart-action='undo']");
    return !!notice && !!undoBtn;
  });
  check(
    undoNoticePresent,
    "Undo banner (.yl-cart-undo-notice) is displayed in cart footer on empty cart"
  );

  // Click Undo on empty cart
  await page.evaluate(() => {
    const undoBtn = document.querySelector(".yl-cart-drawer button[data-cart-action='undo']");
    if (undoBtn) undoBtn.click();
  });
  await sleep(250);

  let restoredItemCount = await page.evaluate(() => window.YLCart.items().length);
  check(
    restoredItemCount === 1,
    `Undo on empty cart successfully restored line item (items: ${restoredItemCount})`
  );

  let restoredItemName = await page.evaluate(() => {
    const items = window.YLCart.items();
    return items.length ? items[0].name : "";
  });
  check(
    restoredItemName.includes("Frankincense"),
    `Restored item name is correct: "${restoredItemName}"`
  );

  // 2.4 Shipping Milestone Calculations & Boundaries
  console.log(`  [2.4] Shipping Milestone Calculations & Boundary Math`);
  const milestoneTests = [
    {
      subtotal: 0,
      expectedRemaining: 40,
      expectedMsgPart: "for Free Tracked Shipping",
      expectedPct: 0
    },
    {
      subtotal: 19.99,
      expectedRemaining: 20.01,
      expectedMsgPart: "Add $20.01 for Free Tracked Shipping!",
      expectedPct: 33
    },
    {
      subtotal: 39.99,
      expectedRemaining: 0.01,
      expectedMsgPart: "Add $0.01 for Free Tracked Shipping!",
      expectedPct: 67
    },
    {
      subtotal: 40.0,
      expectedRemaining: 20.0,
      expectedMsgPart: "Add $20.00 more to unlock a Free Handcrafted Pocket Salve!",
      expectedPct: 67
    },
    {
      subtotal: 40.01,
      expectedRemaining: 19.99,
      expectedMsgPart: "Add $19.99 more to unlock a Free Handcrafted Pocket Salve!",
      expectedPct: 67
    },
    {
      subtotal: 59.99,
      expectedRemaining: 0.01,
      expectedMsgPart: "Add $0.01 more to unlock a Free Handcrafted Pocket Salve!",
      expectedPct: 100
    },
    {
      subtotal: 60.0,
      expectedRemaining: 0,
      expectedMsgPart: "All perks unlocked",
      expectedPct: 100
    },
    {
      subtotal: 80.0,
      expectedRemaining: 0,
      expectedMsgPart: "All perks unlocked",
      expectedPct: 100
    }
  ];

  for (const tc of milestoneTests) {
    const result = await page.evaluate((sub) => {
      if (!window.YLCart || typeof window.YLCart.calculateMilestoneStatus !== "function") {
        return null;
      }
      return window.YLCart.calculateMilestoneStatus(sub);
    }, tc.subtotal);

    check(result !== null, `YLCart.calculateMilestoneStatus executed for subtotal $${tc.subtotal}`);
    if (result) {
      check(
        result.message.includes(tc.expectedMsgPart),
        `Subtotal $${tc.subtotal} -> Message contains "${tc.expectedMsgPart}" (actual: "${result.message}")`
      );
      check(
        result.progressPercent === tc.expectedPct,
        `Subtotal $${tc.subtotal} -> Progress percent is ${tc.expectedPct}% (actual: ${result.progressPercent}%)`
      );
    }
  }

  // Pickup mode milestone check
  let pickupResult = await page.evaluate(() => {
    return window.YLCart.calculateMilestoneStatus(20, null, true);
  });
  check(
    pickupResult && pickupResult.progressPercent === 100 && pickupResult.isAllUnlocked === true,
    "Pickup mode reports 100% progress and isAllUnlocked = true"
  );

  // 2.5 Checkout In-Flight Double-Click Locking
  console.log(`  [2.5] Checkout In-Flight Double-Click Locking`);
  // Clear cart and add 1 item
  await page.evaluate(() => {
    window.YLCart.clear();
    window.YLCart.addItem({
      id: "frankincense-salve",
      name: "Miracle Salve",
      price: 19.99,
      qty: 1
    });
    window.YLCart.open();
  });
  await sleep(150);

  // Intercept network requests to /api/checkout
  let checkoutRequestCount = 0;
  await page.setRequestInterception(true);
  const requestHandler = (req) => {
    if (req.url().includes("/api/checkout")) {
      checkoutRequestCount++;
      // Delay response by 1000ms to test locking while in-flight
      setTimeout(() => {
        try {
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ url: `${baseUrl}/test-checkout-redirect` })
          });
        } catch (e) {
          // Ignore if already handled
        }
      }, 1000);
    } else {
      req.continue();
    }
  };
  page.on("request", requestHandler);

  // Fire 3 rapid clicks on checkout button
  await page.evaluate(() => {
    const btn = document.querySelector(".yl-cart-drawer .yl-cart-checkout");
    if (btn) {
      btn.click();
      btn.click();
      btn.click();
    }
  });
  await sleep(200);

  let btnLocked = await page.evaluate(() => {
    const btn = document.querySelector(".yl-cart-drawer .yl-cart-checkout");
    return btn && btn.disabled === true && btn.textContent.includes("Redirecting");
  });
  check(btnLocked, "Checkout button gets disabled with 'Redirecting…' upon first click");

  await sleep(1200); // Wait for mocked response
  check(
    checkoutRequestCount === 1,
    `Only 1 checkout request was dispatched despite 3 rapid clicks (actual: ${checkoutRequestCount})`
  );

  // Clean up request interception
  page.off("request", requestHandler);
  await page.setRequestInterception(false);

  // ---------------------------------------------------------------------------
  // SECTION 3: PDP Interactions Adversarial Verification
  // ---------------------------------------------------------------------------
  console.log(`\n--- [3] PDP Interactions Adversarial Verification ---`);
  await page.setViewport({ width: 375, height: 667 }); // Mobile viewport for sticky bar
  await page.goto(`${baseUrl}/products/frankincense-salve.html`, { waitUntil: "networkidle0" });

  // 3.1 Variant switching between radios and mobile sticky bar
  console.log(`  [3.1] Two-Way Variant Sync & Mobile Sticky Bar Transitions`);
  let initialMainVariant = await page.evaluate(() => {
    const checked = document.querySelector(".pdp-details input[name='pdpVariant']:checked");
    return checked ? checked.value : "";
  });
  check(
    initialMainVariant === "2oz",
    `Initial main variant is "2oz" (actual: ${initialMainVariant})`
  );

  let initialStickyVariant = await page.evaluate(() => {
    const sel = document.querySelector(".pdp-sticky-variant-select");
    return sel ? sel.value : "";
  });
  check(
    initialStickyVariant === "2oz",
    `Initial sticky bar variant select is "2oz" (actual: ${initialStickyVariant})`
  );

  // Change main form radio to "1oz"
  await page.evaluate(() => {
    const radio1oz = document.querySelector(".pdp-details input[name='pdpVariant'][value='1oz']");
    if (radio1oz) {
      radio1oz.checked = true;
      radio1oz.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(150);

  let syncedStickySelect = await page.evaluate(() => {
    const sel = document.querySelector(".pdp-sticky-variant-select");
    const stickyPrice = document.querySelector(".pdp-sticky-price");
    const mainPrice = document.querySelector(".pdp-price-value");
    return {
      selectVal: sel ? sel.value : "",
      stickyPrice: stickyPrice ? stickyPrice.textContent.trim() : "",
      mainPrice: mainPrice ? mainPrice.textContent.trim() : ""
    };
  });
  check(
    syncedStickySelect.selectVal === "1oz",
    `Selecting 1oz radio synced sticky select to "1oz" (actual: ${syncedStickySelect.selectVal})`
  );
  check(
    syncedStickySelect.stickyPrice === "$13.99",
    `Sticky price updated to $13.99 (actual: ${syncedStickySelect.stickyPrice})`
  );
  check(
    syncedStickySelect.mainPrice === "13.99",
    `Main price updated to 13.99 (actual: ${syncedStickySelect.mainPrice})`
  );

  // Change sticky bar select back to "2oz"
  await page.evaluate(() => {
    const sel = document.querySelector(".pdp-sticky-variant-select");
    if (sel) {
      sel.value = "2oz";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(150);

  let syncedRadioFromSticky = await page.evaluate(() => {
    const checked = document.querySelector(".pdp-details input[name='pdpVariant']:checked");
    const stickyPrice = document.querySelector(".pdp-sticky-price");
    return {
      radioVal: checked ? checked.value : "",
      stickyPrice: stickyPrice ? stickyPrice.textContent.trim() : ""
    };
  });
  check(
    syncedRadioFromSticky.radioVal === "2oz",
    `Selecting 2oz in sticky bar synced main radio back to "2oz" (actual: ${syncedRadioFromSticky.radioVal})`
  );
  check(
    syncedRadioFromSticky.stickyPrice === "$19.99",
    `Sticky price restored to $19.99 (actual: ${syncedRadioFromSticky.stickyPrice})`
  );

  // Scroll down past CTA to verify sticky bar visibility
  const ctaBottom = await page.evaluate(() => {
    const cta = document.querySelector(".pdp-actions") || document.querySelector(".pdp-details");
    const rect = cta.getBoundingClientRect();
    return window.scrollY + rect.top + rect.height;
  });

  await page.evaluate((y) => {
    window.scrollTo(0, y + 600);
  }, ctaBottom);

  await page
    .waitForFunction(
      () => document.getElementById("pdpStickyBar").classList.contains("is-visible"),
      { timeout: 3000 }
    )
    .catch(() => {});

  let stickyVisibleOnScroll = await page.evaluate(() => {
    const bar = document.getElementById("pdpStickyBar");
    return (
      bar && bar.classList.contains("is-visible") && bar.getAttribute("aria-hidden") === "false"
    );
  });
  check(
    stickyVisibleOnScroll,
    "Sticky bar slides into view (.is-visible, aria-hidden='false') when scrolled past primary CTA"
  );

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .waitForFunction(
      () => !document.getElementById("pdpStickyBar").classList.contains("is-visible"),
      { timeout: 3000 }
    )
    .catch(() => {});

  let stickyHiddenOnTop = await page.evaluate(() => {
    const bar = document.getElementById("pdpStickyBar");
    return (
      bar && !bar.classList.contains("is-visible") && bar.getAttribute("aria-hidden") === "true"
    );
  });
  check(
    stickyHiddenOnTop,
    "Sticky bar hides (.is-visible removed, aria-hidden='true') when scrolled back to top"
  );

  // 3.2 Quantity Stepping & Boundary Clamping
  console.log(`  [3.2] PDP Quantity Stepping & Boundary Clamping`);
  let initialPdpQty = await page.evaluate(() => {
    const inp = document.getElementById("pdpQty");
    return inp ? inp.value : "";
  });
  check(initialPdpQty === "1", `Initial PDP quantity is 1 (actual: ${initialPdpQty})`);

  // Decrement at 1 should remain 1
  await page.click(".pdp-qty-btn[data-qty-step='-1']");
  await sleep(50);
  let clampedMinQty = await page.evaluate(() => document.getElementById("pdpQty").value);
  check(clampedMinQty === "1", "Quantity decrement below 1 is clamped to 1");

  // Increment 3 times -> 4
  await page.click(".pdp-qty-btn[data-qty-step='1']");
  await page.click(".pdp-qty-btn[data-qty-step='1']");
  await page.click(".pdp-qty-btn[data-qty-step='1']");
  await sleep(50);
  let incQty = await page.evaluate(() => {
    const inp = document.getElementById("pdpQty");
    const addBtn = document.getElementById("pdpAddToCart");
    return {
      val: inp ? inp.value : "",
      dataQty: addBtn ? addBtn.getAttribute("data-item-quantity") : ""
    };
  });
  check(incQty.val === "4", `Incrementing 3x sets quantity to 4 (actual: ${incQty.val})`);
  check(incQty.dataQty === "4", `Add-to-cart button reflects data-item-quantity="4"`);

  // Test manual typing out-of-bounds (e.g. 50 -> max 10)
  await page.evaluate(() => {
    const inp = document.getElementById("pdpQty");
    if (inp) {
      inp.value = "50";
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(50);
  let maxClamped = await page.evaluate(() => document.getElementById("pdpQty").value);
  check(maxClamped === "10", `Manual input 50 clamped to maximum 10 (actual: ${maxClamped})`);

  // 3.3 Ritual Bundle Section
  console.log(`  [3.3] Ritual Bundle Interactions & Touch Target Size`);
  let ritualExists = await page.evaluate(() => !!document.getElementById("pdpRitualSection"));
  check(ritualExists, "#pdpRitualSection exists on product detail page");

  if (ritualExists) {
    // Checkbox size check (WCAG 2.5.8 >= 24px)
    let checkboxDimensions = await page.evaluate(() => {
      const cb = document.querySelector(".pdp-ritual-checkbox");
      if (!cb) return null;
      const rect = cb.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    // Record empirical measurement:
    if (isLiveProd && checkboxDimensions && checkboxDimensions.width < 24) {
      check(
        false,
        `[LIVE PRODUCTION DEFECT DETECTED]: Ritual standalone checkbox is ${checkboxDimensions.width}x${checkboxDimensions.height}px (requires deploy of 24x24px CSS fix)`
      );
    } else {
      check(
        checkboxDimensions && checkboxDimensions.width >= 24 && checkboxDimensions.height >= 24,
        `Ritual standalone checkbox satisfies 24x24px minimum target (actual: ${checkboxDimensions ? `${checkboxDimensions.width}x${checkboxDimensions.height}px` : "null"})`
      );
    }

    // Base product is pinned (checked disabled)
    let baseProductPinned = await page.evaluate(() => {
      const firstCb = document.querySelector(".pdp-ritual-checkbox");
      return firstCb && firstCb.checked && firstCb.disabled;
    });
    check(
      baseProductPinned,
      "Base PDP product checkbox is pinned (checked and disabled as required base product)"
    );

    // Initial ritual price
    let initialRitualPrice = await page.evaluate(() => {
      const p = document.getElementById("pdpRitualTotalPrice");
      return p ? p.textContent.trim() : "";
    });
    check(
      initialRitualPrice.startsWith("$") && initialRitualPrice !== "$0.00",
      `Initial ritual total price is computed (actual: ${initialRitualPrice})`
    );

    // Uncheck 1 add-on -> verify price update and button copy
    await page.evaluate(() => {
      const addOns = document.querySelectorAll(".pdp-ritual-checkbox:not([disabled])");
      if (addOns.length > 0) {
        addOns[0].click();
      }
    });
    await sleep(100);

    let partialRitualState = await page.evaluate(() => {
      const btn = document.getElementById("pdpRitualAddBtn");
      return btn ? btn.textContent.trim() : "";
    });
    check(
      partialRitualState.includes("Add Selected (2) to Cart"),
      `Unchecking 1 add-on updates button copy to "Add Selected (2) to Cart" (actual: "${partialRitualState}")`
    );

    // Uncheck all add-ons -> only base product remains
    await page.evaluate(() => {
      const addOns = document.querySelectorAll(".pdp-ritual-checkbox:not([disabled])");
      addOns.forEach((cb) => {
        if (cb.checked) cb.click();
      });
    });
    await sleep(100);

    let onlyBaseState = await page.evaluate(() => {
      const btn = document.getElementById("pdpRitualAddBtn");
      const total = document.getElementById("pdpRitualTotalPrice");
      return {
        btnText: btn ? btn.textContent.trim() : "",
        btnDisabled: btn ? btn.disabled : true,
        totalText: total ? total.textContent.trim() : ""
      };
    });
    check(
      onlyBaseState.btnText.includes("Add Item to Cart") && onlyBaseState.btnDisabled === false,
      `When all add-ons are unchecked, button updates to "Add Item to Cart" for base product (actual: "${onlyBaseState.btnText}")`
    );
    check(
      onlyBaseState.totalText === "$19.99",
      `Total price updates to base product price $19.99 (actual: "${onlyBaseState.totalText}")`
    );

    // Recheck all add-on items
    await page.evaluate(() => {
      const addOns = document.querySelectorAll(".pdp-ritual-checkbox:not([disabled])");
      addOns.forEach((cb) => {
        if (!cb.checked) cb.click();
      });
    });
    await sleep(100);

    // Click Add Ritual Bundle to Cart
    let preRitualCartCount = await page.evaluate(() => {
      return window.YLCart && typeof window.YLCart.items === "function"
        ? window.YLCart.items().length
        : 0;
    });

    await page.click("#pdpRitualAddBtn");
    await sleep(350);

    let postRitualCartCount = await page.evaluate(() => {
      return window.YLCart && typeof window.YLCart.items === "function"
        ? window.YLCart.items().length
        : 0;
    });
    check(
      postRitualCartCount >= preRitualCartCount + 2,
      `Adding ritual bundle adds all selected bundle products to cart (pre: ${preRitualCartCount}, post: ${postRitualCartCount})`
    );

    let cartDrawerOpened = await page.evaluate(() => {
      const drawer = document.getElementById("yl-cart-drawer");
      return (
        drawer &&
        (drawer.classList.contains("is-open") ||
          drawer.hasAttribute("open") ||
          (typeof drawer.matches === "function" && drawer.matches(":popover-open")))
      );
    });
    check(cartDrawerOpened, "Cart drawer automatically opens after adding ritual bundle");
  }

  // Check for any unhandled errors
  check(
    consoleErrors.length === 0,
    `Zero severe console errors on ${envName} (errors: ${consoleErrors.length ? consoleErrors.join(" | ") : "none"})`
  );
  check(
    uncaughtExceptions.length === 0,
    `Zero uncaught page exceptions on ${envName} (exceptions: ${uncaughtExceptions.length ? uncaughtExceptions.join(" | ") : "none"})`
  );

  await page.close();
}

(async () => {
  console.log("================================================================================");
  console.log("EMPIRICAL CHALLENGER READINESS VERIFICATION HARNESS");
  console.log("================================================================================");

  let localServer;
  let browser;

  try {
    // 1. Launch Headless Browser
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    // 2. Test Local Build Environment
    const { server, port } = await createTestServer();
    localServer = server;
    const localUrl = `http://127.0.0.1:${port}`;
    await runEnvironmentTests("LOCAL BUILD", localUrl, browser, false);

    // 3. Test Live Production Website
    const liveProdUrl = "https://yallternativeliving.com";
    await runEnvironmentTests("LIVE PRODUCTION", liveProdUrl, browser, true);

    // Final Assessment
    console.log(
      "\n================================================================================"
    );
    console.log(`VERIFICATION SUMMARY:`);
    console.log(`  Total Checks Executed : ${totalChecks}`);
    console.log(`  Passed Checks         : ${passedChecks}`);
    console.log(`  Failed Checks         : ${failedChecks}`);
    console.log("================================================================================");

    if (failedChecks > 0) {
      console.error("\nFAILURES / DEPLOYMENT DISCREPANCIES DETECTED:");
      failures.forEach((f, idx) => console.error(`  [${idx + 1}] ${f}`));
      process.exitCode = 1;
    } else {
      console.log("\nALL EMPIRICAL CHALLENGER VERIFICATION GATES PASSED CLEANLY (100% GREEN).");
      process.exitCode = 0;
    }
  } catch (err) {
    console.error("FATAL ERROR during test execution:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (localServer) localServer.close();
  }
})();
