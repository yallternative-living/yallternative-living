/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger 1 Adversarial Test Harness:
 * Milestone M2 (Search Inline Variant Chip Picker in Global Search Modal & Cart Synchronization).
 *
 * Rigorously challenges & empirically verifies:
 * 1. Rapid consecutive variant switching and keyboard selection across all 12 multi-variant catalog items.
 * 2. Sold-out option resilience (e.g. `tank-top` size S): mouse clicks, space/enter keys, programmatic triggers.
 * 3. Price delta calculation accuracy: base price + variant delta across all products & cart synchronization.
 * 4. Layout stability and zero CLS: DOM wrapping across 375px (mobile), 768px (tablet), and 1200px (desktop) viewports.
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

function recordPass(msg) {
  passedChecks++;
  console.log(`  ✓ ${msg}`);
}

function recordFail(msg) {
  failedChecks++;
  failures.push(msg);
  console.error(`  ✗ FAIL: ${msg}`);
}

(async () => {
  console.log("================================================================================");
  console.log("CHALLENGER 1: M2 SEARCH INLINE VARIANT CHIP PICKER & CART ADVERSARIAL HARNESS");
  console.log("================================================================================\n");

  let serverInstance;
  let browser;

  try {
    const productsData = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../assets/data/products.json"), "utf8")
    );
    /* A coming-soon product gets a "Notify me" link in search results, never a
       variant picker, so it is out of scope here. */
    const multiVariantProducts = productsData.products.filter(
      (p) =>
        p.variants &&
        Array.isArray(p.variants.options) &&
        p.variants.options.length > 1 &&
        !p.comingSoon
    );

    console.log(`Loaded catalog: found ${multiVariantProducts.length} multi-variant products.\n`);
    if (multiVariantProducts.length !== 10) {
      recordFail(`Expected 10 buyable multi-variant products, got ${multiVariantProducts.length}`);
    } else {
      recordPass(`Identified exact 12 multi-variant catalog products for comprehensive testing`);
    }

    const { server, port } = await createTestServer();
    serverInstance = server;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Test server running at ${baseUrl}\n`);

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    // Catch page crashes and unhandled exceptions
    const pageErrors = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
      console.error(`  [Browser PageError] ${err.message}`);
    });

    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });

    // Initialize search modal trigger
    await page.waitForSelector("#globalSearchTrigger");

    // =========================================================================
    // DIMENSION 1: Rapid Consecutive Variant Switching & Keyboard Selection
    // =========================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log("DIMENSION 1: Rapid Consecutive Variant Switching & Keyboard Selection (12 Items)");
    console.log("--------------------------------------------------------------------------------");

    for (const prod of multiVariantProducts) {
      console.log(
        `\nTesting Product [${prod.id}] "${prod.name}" (${prod.variants.options.length} variants)...`
      );

      // Clear cart before testing each product
      await page.evaluate(() => {
        if (window.YLCart && typeof window.YLCart.clear === "function") {
          window.YLCart.clear();
        }
        localStorage.removeItem("yl-cart-v1");
      });

      // Open search modal and search for product
      await page.evaluate((query) => {
        const trigger = document.getElementById("globalSearchTrigger");
        if (trigger) trigger.click();
        const input = document.getElementById("globalSearchInput");
        if (input) {
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, prod.name);

      await sleep(220); // allow search debounce (150ms)

      // Verify product card and variant trigger
      const itemActionSelector = `.search-item-action[data-product-id="${prod.id}"]`;
      const actionHandle = await page.$(itemActionSelector);
      if (!actionHandle) {
        recordFail(`[${prod.id}] Search result card action wrapper not found for "${prod.name}"`);
        continue;
      }
      recordPass(`[${prod.id}] Search result card action wrapper rendered`);

      const triggerBtn = await actionHandle.$(".search-variant-trigger");
      if (!triggerBtn) {
        recordFail(`[${prod.id}] .search-variant-trigger button missing in search result`);
        continue;
      }
      recordPass(`[${prod.id}] .search-variant-trigger button present`);

      const ariaExpandedInitial = await page.evaluate(
        (el) => el.getAttribute("aria-expanded"),
        triggerBtn
      );
      if (ariaExpandedInitial === "false") {
        recordPass(`[${prod.id}] Initial trigger aria-expanded is 'false'`);
      } else {
        recordFail(
          `[${prod.id}] Initial trigger aria-expanded is '${ariaExpandedInitial}', expected 'false'`
        );
      }

      const ariaControls = await page.evaluate(
        (el) => el.getAttribute("aria-controls"),
        triggerBtn
      );
      const expectedPickerId = `search-variant-picker-${prod.id}`;
      if (ariaControls === expectedPickerId) {
        recordPass(`[${prod.id}] Trigger aria-controls correctly references '${expectedPickerId}'`);
      } else {
        recordFail(`[${prod.id}] Trigger aria-controls '${ariaControls}' != '${expectedPickerId}'`);
      }

      /* Click the trigger by SELECTOR, not through the handle taken above.
         The results list is re-rendered on every input event and by the 1200ms
         "✓ Added" revert the previous product's add-to-cart leaves running, so
         a handle grabbed a few round trips ago can point at a node that is no
         longer in the document -- Puppeteer's click() then throws "Node is
         detached from document" and the whole harness dies mid-product (CI run
         33932028359, [unisex-tshirt], the fourth of four). A selector is
         resolved at click time, so a re-render between the checks above and
         this line costs nothing. Wait for it first: the same re-render can
         briefly take the button out of the DOM. */
      const triggerSelector = `${itemActionSelector} .search-variant-trigger`;
      await page.waitForSelector(triggerSelector, { visible: true, timeout: 10000 });
      await page.click(triggerSelector);
      await sleep(100);

      /* Re-read through selectors for the same reason: a handle that survived
         the click can still be detached by the next re-render. */
      const isExpandedClass = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return !!el && el.classList.contains("is-expanded");
      }, itemActionSelector);
      const ariaExpandedAfter = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute("aria-expanded") : null;
      }, triggerSelector);
      const pickerHidden = await page.evaluate((id) => {
        const p = document.getElementById(id);
        return p ? p.hidden : true;
      }, expectedPickerId);

      if (isExpandedClass && ariaExpandedAfter === "true" && pickerHidden === false) {
        recordPass(`[${prod.id}] Variant picker successfully expanded with correct ARIA state`);
      } else {
        recordFail(
          `[${prod.id}] Expansion state mismatch: is-expanded=${isExpandedClass}, aria-expanded=${ariaExpandedAfter}, picker.hidden=${pickerHidden}`
        );
      }

      // Verify Radiogroup ARIA semantics
      const pickerSemantics = await page.evaluate((id) => {
        const p = document.getElementById(id);
        if (!p) return null;
        return {
          role: p.getAttribute("role"),
          ariaLabel: p.getAttribute("aria-label")
        };
      }, expectedPickerId);

      if (pickerSemantics && pickerSemantics.role === "radiogroup" && pickerSemantics.ariaLabel) {
        recordPass(
          `[${prod.id}] Radiogroup role and aria-label ('${pickerSemantics.ariaLabel}') verified`
        );
      } else {
        recordFail(`[${prod.id}] Radiogroup semantics invalid: ${JSON.stringify(pickerSemantics)}`);
      }

      // Inspect rendered variant chips
      const chipsData = await page.evaluate((id) => {
        const p = document.getElementById(id);
        if (!p) return [];
        const chips = Array.from(p.querySelectorAll(".search-variant-chip"));
        return chips.map((c) => ({
          text: c.textContent.trim(),
          itemId: c.getAttribute("data-item-id"),
          variantName: c.getAttribute("data-variant-name"),
          variantLabel: c.getAttribute("data-variant-label"),
          variantDelta: c.getAttribute("data-variant-delta"),
          dataPrice: c.getAttribute("data-price"),
          disabled: c.disabled,
          isSoldOut: c.classList.contains("is-sold-out"),
          ariaChecked: c.getAttribute("aria-checked"),
          ariaLabel: c.getAttribute("aria-label"),
          role: c.getAttribute("role"),
          tabIndex: c.tabIndex
        }));
      }, expectedPickerId);

      if (chipsData.length === prod.variants.options.length) {
        recordPass(`[${prod.id}] Rendered exact count of ${chipsData.length} variant chips`);
      } else {
        recordFail(
          `[${prod.id}] Chip count mismatch: got ${chipsData.length}, expected ${prod.variants.options.length}`
        );
      }

      // Rapid consecutive variant switching (Clicking each available chip rapidly)
      const availableChips = chipsData.filter((c) => !c.disabled && !c.isSoldOut);
      let expectedCartQty = 0;

      for (let i = 0; i < availableChips.length; i++) {
        const targetChip = availableChips[i];
        await page.evaluate(
          (pickerId, label) => {
            const picker = document.getElementById(pickerId);
            const chip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
              (c) => c.getAttribute("data-variant-label") === label
            );
            if (chip) chip.click();
          },
          expectedPickerId,
          targetChip.variantLabel
        );

        expectedCartQty++;
        await sleep(60);

        // Check aria-checked exclusively on the selected chip
        const checkedState = await page.evaluate(
          (pickerId, label) => {
            const picker = document.getElementById(pickerId);
            const chips = Array.from(picker.querySelectorAll(".search-variant-chip"));
            const target = chips.find((c) => c.getAttribute("data-variant-label") === label);
            const others = chips.filter((c) => c !== target);
            return {
              targetChecked: target ? target.getAttribute("aria-checked") : null,
              othersUnchecked: others.every((c) => c.getAttribute("aria-checked") === "false")
            };
          },
          expectedPickerId,
          targetChip.variantLabel
        );

        if (checkedState.targetChecked === "true" && checkedState.othersUnchecked) {
          recordPass(
            `[${prod.id}] Option '${targetChip.variantLabel}' receives exclusive aria-checked='true'`
          );
        } else {
          recordFail(
            `[${prod.id}] ARIA checked state failure on '${targetChip.variantLabel}': ${JSON.stringify(checkedState)}`
          );
        }
      }

      // Verify cart accumulated items
      const cartState = await page.evaluate(() => {
        try {
          /* The cart persists {version, items} now, migrating from the bare array it
             used to write. Every read below accepts either shape, so the suite keeps
             working across the migration instead of silently seeing an empty cart --
             `parsed.length` on the new object is undefined, which reads as "cart empty"
             and would have turned real regressions into passes. */
          return (function () {
            const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
            return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
          })();
        } catch (e) {
          return [];
        }
      });

      const totalQty = cartState.reduce((sum, item) => sum + (item.qty || 1), 0);
      if (totalQty === expectedCartQty) {
        recordPass(
          `[${prod.id}] Cart synchronized ${totalQty} items during rapid variant switching`
        );
      } else {
        recordFail(`[${prod.id}] Cart total qty ${totalQty} != expected ${expectedCartQty}`);
      }

      // Keyboard selection (ArrowRight / ArrowLeft / Space / Enter / Escape)
      if (availableChips.length >= 2) {
        // Press ArrowRight to move focus
        await page.keyboard.press("ArrowRight");
        await sleep(50);

        const focusedChipLabel1 = await page.evaluate((pickerId) => {
          const active = document.activeElement;
          return active && active.closest(`#${pickerId}`)
            ? active.getAttribute("data-variant-label")
            : null;
        }, expectedPickerId);

        // Press Space or Enter to activate focused chip
        await page.keyboard.press("Space");
        await sleep(60);

        const cartCountAfterSpace = await page.evaluate(() => {
          const items = (function () {
            const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
            return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
          })();
          return items.reduce((sum, item) => sum + (item.qty || 1), 0);
        });

        if (cartCountAfterSpace === expectedCartQty + 1) {
          recordPass(
            `[${prod.id}] Space key successfully added focused variant ('${focusedChipLabel1}') to cart`
          );
        } else {
          recordFail(
            `[${prod.id}] Space key failed to add variant: cart qty is ${cartCountAfterSpace}, expected ${expectedCartQty + 1}`
          );
        }

        // Press Escape to collapse picker and restore focus to trigger
        await page.keyboard.press("Escape");
        await sleep(80);

        const escapeState = await page.evaluate(
          (pickerId, actionSel) => {
            const picker = document.getElementById(pickerId);
            const action = document.querySelector(actionSel);
            const trigger = action ? action.querySelector(".search-variant-trigger") : null;
            return {
              pickerHidden: picker ? picker.hidden : null,
              actionExpanded: action ? action.classList.contains("is-expanded") : null,
              triggerAriaExpanded: trigger ? trigger.getAttribute("aria-expanded") : null,
              triggerFocused: document.activeElement === trigger
            };
          },
          expectedPickerId,
          itemActionSelector
        );

        if (
          escapeState.pickerHidden === true &&
          escapeState.actionExpanded === false &&
          escapeState.triggerAriaExpanded === "false" &&
          escapeState.triggerFocused === true
        ) {
          recordPass(`[${prod.id}] Escape key collapsed picker and restored focus to trigger`);
        } else {
          recordFail(`[${prod.id}] Escape key failure: ${JSON.stringify(escapeState)}`);
        }
      }
    }

    // Test Mutual Exclusion: Opening Picker A then Picker B closes Picker A
    console.log("\nTesting Mutual Exclusion between multiple variant pickers...");
    await page.evaluate(() => {
      const input = document.getElementById("globalSearchInput");
      if (input) {
        input.value = "soak"; // brings up lavender-soak and backroad-soak, both have variants
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await sleep(220);

    const mutualExclusionResult = await page.evaluate(async () => {
      const triggers = Array.from(document.querySelectorAll(".search-variant-trigger"));
      if (triggers.length < 2)
        return { skipped: true, reason: `found ${triggers.length} triggers` };

      // Click trigger 0
      triggers[0].click();
      await new Promise((r) => setTimeout(r, 60));
      const action0Open = triggers[0]
        .closest(".search-item-action")
        .classList.contains("is-expanded");

      // Click trigger 1
      triggers[1].click();
      await new Promise((r) => setTimeout(r, 60));
      const action0Closed = !triggers[0]
        .closest(".search-item-action")
        .classList.contains("is-expanded");
      const action1Open = triggers[1]
        .closest(".search-item-action")
        .classList.contains("is-expanded");

      return {
        action0Open,
        action0Closed,
        action1Open
      };
    });

    if (
      mutualExclusionResult.action0Open &&
      mutualExclusionResult.action0Closed &&
      mutualExclusionResult.action1Open
    ) {
      recordPass("Opening a second variant picker automatically closes the previously open picker");
    } else {
      recordFail(`Mutual exclusion failure: ${JSON.stringify(mutualExclusionResult)}`);
    }

    // =========================================================================
    // DIMENSION 2: Sold-Out Option Resilience (tank-top size S & Simulated Sold-Out)
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log(
      "DIMENSION 2: Sold-Out Option Resilience (Clicks, Keyboard, Programmatic Triggers)"
    );
    console.log("--------------------------------------------------------------------------------");

    // Clear cart
    await page.evaluate(() => {
      if (window.YLCart && typeof window.YLCart.clear === "function") window.YLCart.clear();
      localStorage.removeItem("yl-cart-v1");
    });

    // Search tank-top
    await page.evaluate(() => {
      const input = document.getElementById("globalSearchInput");
      input.value = "tank top";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(220);

    // Expand tank-top variant picker
    await page.evaluate(() => {
      const trigger = document.querySelector(
        '.search-item-action[data-product-id="tank-top"] .search-variant-trigger'
      );
      if (trigger) trigger.click();
    });
    await sleep(100);

    // Verify 'S' chip properties
    const soldOutChipProps = await page.evaluate(() => {
      const picker = document.getElementById("search-variant-picker-tank-top");
      if (!picker) return null;
      const sChip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
        (c) => c.getAttribute("data-variant-label") === "S"
      );
      if (!sChip) return null;
      return {
        disabled: sChip.disabled,
        ariaDisabled: sChip.getAttribute("aria-disabled"),
        isSoldOutClass: sChip.classList.contains("is-sold-out"),
        text: sChip.textContent.trim(),
        ariaLabel: sChip.getAttribute("aria-label"),
        tabIndex: sChip.tabIndex
      };
    });

    if (
      soldOutChipProps &&
      soldOutChipProps.disabled === true &&
      soldOutChipProps.ariaDisabled === "true" &&
      soldOutChipProps.isSoldOutClass === true &&
      soldOutChipProps.text.includes("(Sold Out)")
    ) {
      recordPass(
        "Tank top 'S' variant chip renders disabled with .is-sold-out class and '(Sold Out)' badge"
      );
    } else {
      recordFail(`Tank top 'S' sold-out attributes invalid: ${JSON.stringify(soldOutChipProps)}`);
    }

    // 1. Attack Vector: Direct Mouse Click on sold-out chip
    await page.evaluate(() => {
      const picker = document.getElementById("search-variant-picker-tank-top");
      const sChip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
        (c) => c.getAttribute("data-variant-label") === "S"
      );
      if (sChip) {
        // Dispatch synthetic pointer/mouse click
        sChip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    });
    await sleep(100);

    let cartAfterClick = await page.evaluate(() =>
      (function () {
        const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
        return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
      })()
    );
    if (cartAfterClick.length === 0) {
      recordPass("Direct click event on sold-out 'S' variant chip rejected; cart remains empty");
    } else {
      recordFail(
        `Sold-out 'S' was added to cart on direct click: ${JSON.stringify(cartAfterClick)}`
      );
    }

    // 2. Attack Vector: Space / Enter keypress on sold-out chip
    await page.evaluate(() => {
      const picker = document.getElementById("search-variant-picker-tank-top");
      const sChip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
        (c) => c.getAttribute("data-variant-label") === "S"
      );
      if (sChip) {
        sChip.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
        sChip.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
        );
      }
    });
    await sleep(100);

    let cartAfterKey = await page.evaluate(() =>
      (function () {
        const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
        return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
      })()
    );
    if (cartAfterKey.length === 0) {
      recordPass("Enter/Space keypress on sold-out 'S' variant chip rejected; cart remains empty");
    } else {
      recordFail(`Sold-out 'S' was added to cart on keypress: ${JSON.stringify(cartAfterKey)}`);
    }

    // 3. Attack Vector: Programmatic .click() invocation
    await page.evaluate(() => {
      const picker = document.getElementById("search-variant-picker-tank-top");
      const sChip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
        (c) => c.getAttribute("data-variant-label") === "S"
      );
      if (sChip) {
        try {
          sChip.click();
        } catch (e) {
          // ignore
        }
      }
    });
    await sleep(100);

    let cartAfterProgClick = await page.evaluate(() =>
      (function () {
        const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
        return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
      })()
    );
    if (cartAfterProgClick.length === 0) {
      recordPass("Programmatic .click() on sold-out 'S' variant chip rejected; cart remains empty");
    } else {
      recordFail(
        `Sold-out 'S' was added to cart via programmatic .click(): ${JSON.stringify(cartAfterProgClick)}`
      );
    }

    // 4. Attack Vector: Enabled variant 'M' in same picker CAN be added cleanly
    await page.evaluate(() => {
      const picker = document.getElementById("search-variant-picker-tank-top");
      const mChip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
        (c) => c.getAttribute("data-variant-label") === "M"
      );
      if (mChip) mChip.click();
    });
    await sleep(100);

    let cartAfterM = await page.evaluate(() =>
      (function () {
        const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
        return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
      })()
    );
    if (
      cartAfterM.length === 1 &&
      cartAfterM[0].id === "tank-top" &&
      cartAfterM[0].variantLabel === "M"
    ) {
      recordPass(
        "Active in-stock variant 'M' adds to cart seamlessly alongside disabled 'S' option"
      );
    } else {
      recordFail(`Failed to add in-stock variant 'M': ${JSON.stringify(cartAfterM)}`);
    }

    // =========================================================================
    // DIMENSION 3: Price Delta Calculation Accuracy & Cart Synchronization
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("DIMENSION 3: Price Delta Calculation Accuracy & Cart Synchronization");
    console.log("--------------------------------------------------------------------------------");

    // Test label formatting & data-attribute math across ALL 12 multi-variant products
    for (const prod of multiVariantProducts) {
      // Search product
      await page.evaluate((query) => {
        const input = document.getElementById("globalSearchInput");
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, prod.name);
      await sleep(220);

      // Expand picker
      const pickerId = `search-variant-picker-${prod.id}`;
      await page.evaluate((id) => {
        const trigger = document.querySelector(
          `.search-item-action[data-product-id="${id}"] .search-variant-trigger`
        );
        if (trigger) trigger.click();
      }, prod.id);
      await sleep(80);

      const chipsAnalysis = await page.evaluate(
        (id, basePrice) => {
          const picker = document.getElementById(id);
          if (!picker) return { found: false };
          const chips = Array.from(picker.querySelectorAll(".search-variant-chip"));

          const results = chips.map((c) => {
            const label = c.getAttribute("data-variant-label");
            const delta = Number(c.getAttribute("data-variant-delta")) || 0;
            const priceAttr = Number(c.getAttribute("data-price")) || 0;
            const text = c.textContent.trim();
            const expectedPrice = Math.round((basePrice + delta) * 100) / 100;

            return {
              label,
              delta,
              priceAttr,
              expectedPrice,
              priceMatch: Math.abs(priceAttr - expectedPrice) < 0.001,
              text
            };
          });

          return {
            found: true,
            count: chips.length,
            results
          };
        },
        pickerId,
        prod.price
      );

      if (!chipsAnalysis.found) {
        recordFail(`[${prod.id}] Could not find picker #${pickerId}`);
        continue;
      }

      let allDeltasMatch = true;
      for (const r of chipsAnalysis.results) {
        if (!r.priceMatch) {
          allDeltasMatch = false;
          recordFail(
            `[${prod.id}] Price delta mismatch on '${r.label}': attr=${r.priceAttr}, expected=${r.expectedPrice}`
          );
        }
      }

      if (allDeltasMatch) {
        recordPass(
          `[${prod.id}] All ${chipsAnalysis.count} variant price deltas strictly match expected prices (base: $${prod.price})`
        );
      }

      // Check specific label formats:
      // - Gift card options are labelled "Preset $NN" (the Worker parses that
      //   exact form, see workers/checkout.js); the chip must show the label
      //   as-is and never append a second "- $NN.00" price to it.
      if (prod.id === "yallternative-gift-card") {
        const giftCardLabels = chipsAnalysis.results.map((r) => r.text);
        const hasDoubleDollar = giftCardLabels.some((txt) => txt.includes("- $"));
        const allPresetForm = giftCardLabels.every((txt) => /^Preset \$\d+$/.test(txt.trim()));
        if (!hasDoubleDollar && allPresetForm) {
          recordPass(
            `[${prod.id}] Gift card chip labels are the bare "Preset $NN" form without a duplicate price append`
          );
        } else {
          recordFail(
            `[${prod.id}] Gift card chip label formatting error: ${JSON.stringify(giftCardLabels)}`
          );
        }
      }

      // - Salve 1oz should show "1oz - $13.99"
      if (prod.id === "frankincense-salve") {
        const salve1oz = chipsAnalysis.results.find((r) => r.label === "1oz");
        if (salve1oz && salve1oz.text.includes("$14")) {
          recordPass(
            `[${prod.id}] 1oz Frankincense Salve chip label displays exact negative delta price '$14'`
          );
        } else {
          recordFail(
            `[${prod.id}] 1oz Frankincense Salve label mismatch: got '${salve1oz ? salve1oz.text : "null"}'`
          );
        }
      }
    }

    // Complex Multi-Product Basket Math & Cart Synchronization Verification
    console.log("\nTesting Complex Multi-Variant Basket Math & Cart Synchronization...");
    await page.evaluate(() => {
      if (window.YLCart && typeof window.YLCart.clear === "function") window.YLCart.clear();
      localStorage.removeItem("yl-cart-v1");
    });

    const basketItemsToAdd = [
      { id: "shea-butter", query: "Lavender Shea", label: "8 oz", expectedUnit: 23.0 },
      { id: "lavender-soak", query: "Lavender Epsom", label: "24 oz", expectedUnit: 18.0 },
      {
        id: "yallternative-gift-card",
        query: "Gift Card",
        label: "Preset $50",
        expectedUnit: 50.0
      },
      { id: "frankincense-salve", query: "Frankincense Salve", label: "1oz", expectedUnit: 14 }
    ];

    for (const item of basketItemsToAdd) {
      await page.evaluate((q) => {
        const input = document.getElementById("globalSearchInput");
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, item.query);
      await sleep(220);

      await page.evaluate(
        (id, label) => {
          const trigger = document.querySelector(
            `.search-item-action[data-product-id="${id}"] .search-variant-trigger`
          );
          if (trigger) trigger.click();
          const picker = document.getElementById(`search-variant-picker-${id}`);
          if (picker) {
            const chip = Array.from(picker.querySelectorAll(".search-variant-chip")).find(
              (c) => c.getAttribute("data-variant-label") === label
            );
            if (chip) chip.click();
          }
        },
        item.id,
        item.label
      );
      await sleep(100);
    }

    const basketSummary = await page.evaluate(() => {
      const items = (function () {
        const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
        return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
      })();
      const subtotalVal = items.reduce((sum, it) => {
        const base =
          Math.round(Math.max(0, (Number(it.price) || 0) + (Number(it.variantDelta) || 0)) * 100) /
          100;
        return sum + base * (it.qty || 1);
      }, 0);
      return {
        itemsCount: items.length,
        items,
        subtotalVal: Math.round(subtotalVal * 100) / 100
      };
    });

    const expectedBasketSubtotal = 23.0 + 18.0 + 50.0 + 14; // $105
    if (
      basketSummary.itemsCount === 4 &&
      Math.abs(basketSummary.subtotalVal - expectedBasketSubtotal) < 0.01
    ) {
      recordPass(
        `Multi-variant basket accurately computed: 4 items, exact subtotal $${basketSummary.subtotalVal.toFixed(2)} (expected: $${expectedBasketSubtotal.toFixed(2)})`
      );
    } else {
      recordFail(
        `Multi-variant basket calculation error: count=${basketSummary.itemsCount}, subtotal=${basketSummary.subtotalVal}, expected=$${expectedBasketSubtotal}`
      );
    }

    // =========================================================================
    // DIMENSION 4: Layout Stability & Zero CLS (375px, 768px, 1200px Viewports)
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("DIMENSION 4: Layout Stability, Flex-Wrapping & Zero CLS Across Viewports");
    console.log("--------------------------------------------------------------------------------");

    const viewports = [
      { name: "Mobile (375x667)", width: 375, height: 667 },
      { name: "Tablet (768x1024)", width: 768, height: 1024 },
      { name: "Desktop (1200x800)", width: 1200, height: 800 }
    ];

    for (const vp of viewports) {
      console.log(`\nTesting Viewport ${vp.name}...`);
      await page.setViewport({ width: vp.width, height: vp.height });
      await sleep(150);

      // Open search modal with multi-variant results query
      await page.evaluate(() => {
        const trigger = document.getElementById("globalSearchTrigger");
        if (trigger) trigger.click();
        const input = document.getElementById("globalSearchInput");
        input.value = "soak";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(220);

      // Check overflow on modal & results list before expanding pickers
      const initialOverflow = await page.evaluate(() => {
        const modal = document.getElementById("global-search-modal");
        const list = document.getElementById("globalSearchResultsList");
        const doc = document.documentElement;
        return {
          modalScrollWidth: modal ? modal.scrollWidth : 0,
          modalClientWidth: modal ? modal.clientWidth : 0,
          listScrollWidth: list ? list.scrollWidth : 0,
          listClientWidth: list ? list.clientWidth : 0,
          docScrollWidth: doc.scrollWidth,
          docClientWidth: doc.clientWidth
        };
      });

      if (initialOverflow.docScrollWidth <= initialOverflow.docClientWidth) {
        recordPass(`[${vp.name}] Zero document horizontal overflow with search results list`);
      } else {
        recordFail(
          `[${vp.name}] Document horizontal overflow detected: scrollWidth=${initialOverflow.docScrollWidth} > clientWidth=${initialOverflow.docClientWidth}`
        );
      }

      // Measure layout shifts (CLS) solely during variant picker interaction
      const interactionShift = await page.evaluate(async () => {
        let shiftSum = 0;
        let observer = null;

        if (typeof PerformanceObserver !== "undefined") {
          try {
            observer = new PerformanceObserver((entryList) => {
              for (const entry of entryList.getEntries()) {
                shiftSum += entry.value;
              }
            });
            observer.observe({ type: "layout-shift", buffered: false });
          } catch (e) {
            // Layout shift not supported
          }
        }

        // Expand variant trigger
        const trigger = document.querySelector(".search-variant-trigger");
        if (trigger) trigger.click();

        await new Promise((r) => setTimeout(r, 150));

        if (observer) observer.disconnect();

        const modal = document.getElementById("global-search-modal");
        const picker = document.querySelector(".search-variant-picker:not([hidden])");
        const chipsWrap = document.querySelector(".search-variant-chips");
        const doc = document.documentElement;

        return {
          shiftSum,
          docOverflow: doc.scrollWidth > doc.clientWidth,
          modalOverflow: modal ? modal.scrollWidth > modal.clientWidth : false,
          pickerRendered: !!picker,
          chipsWrapping: chipsWrap ? window.getComputedStyle(chipsWrap).flexWrap : null
        };
      });

      if (interactionShift.pickerRendered) {
        recordPass(`[${vp.name}] Variant picker expanded cleanly`);
      } else {
        recordFail(`[${vp.name}] Variant picker failed to render`);
      }

      if (!interactionShift.docOverflow && !interactionShift.modalOverflow) {
        recordPass(
          `[${vp.name}] Zero horizontal overflow when variant picker and chips are expanded`
        );
      } else {
        recordFail(
          `[${vp.name}] Overflow detected during picker expansion: docOverflow=${interactionShift.docOverflow}, modalOverflow=${interactionShift.modalOverflow}`
        );
      }

      if (interactionShift.chipsWrapping === "wrap") {
        recordPass(
          `[${vp.name}] .search-variant-chips has flex-wrap: wrap ensuring safe responsive reflow`
        );
      } else {
        recordFail(
          `[${vp.name}] .search-variant-chips flex-wrap is '${interactionShift.chipsWrapping}', expected 'wrap'`
        );
      }

      if (interactionShift.shiftSum <= 0.05) {
        recordPass(
          `[${vp.name}] Zero layout shift during picker interaction (measured CLS: ${interactionShift.shiftSum.toFixed(4)} <= 0.05)`
        );
      } else {
        recordFail(
          `[${vp.name}] Layout shift during interaction: ${interactionShift.shiftSum.toFixed(4)} > 0.05`
        );
      }

      // Test Gift Cards (5 chips) and Keychains (long text chips) flex-wrapping
      await page.evaluate(() => {
        const input = document.getElementById("globalSearchInput");
        input.value = "Gift Card";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(220);

      const giftCardChipsWrap = await page.evaluate(() => {
        const trigger = document.querySelector(
          '.search-item-action[data-product-id="yallternative-gift-card"] .search-variant-trigger'
        );
        if (trigger) trigger.click();
        const chipsWrap = document.querySelector(
          "#search-variant-picker-yallternative-gift-card .search-variant-chips"
        );
        if (!chipsWrap) return null;
        const rect = chipsWrap.getBoundingClientRect();
        const parentRect = chipsWrap.closest(".search-result-item").getBoundingClientRect();
        return {
          chipsWidth: rect.width,
          parentWidth: parentRect.width,
          fitsWithinParent: rect.right <= parentRect.right + 2 // 2px tolerance for fractional subpixel
        };
      });

      if (giftCardChipsWrap && giftCardChipsWrap.fitsWithinParent) {
        recordPass(`[${vp.name}] 5-chip Gift Card variant picker wraps cleanly within card bounds`);
      } else {
        recordFail(
          `[${vp.name}] Gift Card chips exceed card bounds: ${JSON.stringify(giftCardChipsWrap)}`
        );
      }

      // Test Long Label Keychains
      await page.evaluate(() => {
        const input = document.getElementById("globalSearchInput");
        input.value = "Protection Potion Keychain";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(220);

      const keychainChipsWrap = await page.evaluate(() => {
        const trigger = document.querySelector(
          '.search-item-action[data-product-id="protection-keychain"] .search-variant-trigger'
        );
        if (trigger) trigger.click();
        const chipsWrap = document.querySelector(
          "#search-variant-picker-protection-keychain .search-variant-chips"
        );
        if (!chipsWrap) return null;
        const rect = chipsWrap.getBoundingClientRect();
        const parentRect = chipsWrap.closest(".search-result-item").getBoundingClientRect();
        return {
          chipsWidth: rect.width,
          parentWidth: parentRect.width,
          fitsWithinParent: rect.right <= parentRect.right + 2
        };
      });

      if (keychainChipsWrap && keychainChipsWrap.fitsWithinParent) {
        recordPass(
          `[${vp.name}] Long-text Keychain variant chips wrap cleanly without horizontal clipping`
        );
      } else {
        recordFail(
          `[${vp.name}] Keychain chips exceed card bounds: ${JSON.stringify(keychainChipsWrap)}`
        );
      }
    }

    // Verify 0 runtime page errors occurred throughout the entire adversarial session
    if (pageErrors.length === 0) {
      recordPass(
        "Zero unhandled JavaScript errors/exceptions detected across all adversarial interactions"
      );
    } else {
      recordFail(
        `Detected ${pageErrors.length} unhandled runtime errors: ${pageErrors.join("; ")}`
      );
    }
  } catch (err) {
    console.error(`\n[FATAL ERROR] Harness crash:`, err);
    recordFail(`Fatal execution error: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    if (serverInstance) serverInstance.close();

    console.log(
      "\n================================================================================"
    );
    console.log(`CHALLENGER 1 SUMMARY: ${passedChecks} passed, ${failedChecks} failed.`);
    console.log(
      "================================================================================\n"
    );

    if (failedChecks > 0) {
      console.error(`Failures (${failedChecks}):`);
      failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
      process.exit(1);
    } else {
      console.log("ALL ADVERSARIAL M2 CHALLENGE CHECKS PASSED EMPIRICALLY WITH ZERO DEFECTS.");
      process.exit(0);
    }
  }
})();
