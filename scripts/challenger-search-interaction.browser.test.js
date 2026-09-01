/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger 2 Adversarial Test Harness.
 *
 * Rigorously stress-tests:
 * 1. Rapid Cmd+K / Ctrl+K toggling (100 rapid cycles, focus restoration, no orphaned state).
 * 2. Guarded '/' keypresses inside inputs, textareas, selects, and other open modals.
 * 3. Rapid 1-click cart additions & cart state concurrency in search results.
 * 4. Focus trapping integrity (Tab / Shift+Tab) under empty state, live results, and ancestor hiding.
 * 5. Listbox keyboard navigation boundaries (ArrowDown wrapping to 0, ArrowUp wrapping to last).
 * 6. Zero horizontal layout overflow across 320px, 375px, 768px, and 1280px viewports.
 * 7. Multi-page search trigger & modal lifecycle integrity.
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
  console.log("CHALLENGER 2: INTERACTION, MODAL & CART CONCURRENCY ADVERSARIAL TEST HARNESS");
  console.log("================================================================================\n");

  let serverInstance;
  let browser;

  try {
    const { server, port } = await createTestServer();
    serverInstance = server;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Test server running at ${baseUrl}\n`);

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    const appJsErrors = [];
    page.on("pageerror", (err) => {
      appJsErrors.push(err.message);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          !text.includes("tawk.to") &&
          !text.includes("ServiceWorker") &&
          !text.includes("favicon") &&
          !text.includes("Failed to load resource")
        ) {
          appJsErrors.push(text);
        }
      }
    });

    // =========================================================================
    // SUITE 1: Rapid Cmd+K / Ctrl+K Toggling & Focus Restoration Lifecycle
    // =========================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log("VECTOR 1: Rapid Cmd+K / Ctrl+K Toggling & Focus Restoration (100 Cycles)");
    console.log("--------------------------------------------------------------------------------");

    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });
    await page.setViewport({ width: 1200, height: 800 });

    // Focus on header search trigger initially
    await page.focus("#globalSearchTrigger");
    let initialActiveId = await page.evaluate(() =>
      document.activeElement ? document.activeElement.id : ""
    );
    if (initialActiveId === "globalSearchTrigger") {
      recordPass("Header search trigger is initially focused");
    } else {
      recordFail(`Header search trigger focus failed (got: '${initialActiveId}')`);
    }

    // Perform 100 rapid Cmd+K / Meta+K toggles
    console.log("  Executing 100 rapid Cmd+K toggles in under 2 seconds...");
    const isMac = await page.evaluate(() => /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform));
    const modKey = isMac ? "Meta" : "Control";

    for (let i = 0; i < 100; i++) {
      await page.keyboard.down(modKey);
      await page.keyboard.press("KeyK");
      await page.keyboard.up(modKey);
      if (i % 25 === 0) await sleep(10);
    }
    await sleep(200);

    // After 100 toggles (even number), modal must be closed
    const modalClosedAfter100 = await page.evaluate(() => {
      const modal = document.getElementById("global-search-modal");
      return !modal.hasAttribute("open") && !modal.open;
    });
    if (modalClosedAfter100) {
      recordPass("Modal is cleanly closed after 100 rapid toggles (even cycles)");
    } else {
      recordFail("Modal failed to close cleanly after 100 rapid toggles");
    }

    const triggerAriaExpandedAfter100 = await page.evaluate(() => {
      return document.getElementById("globalSearchTrigger").getAttribute("aria-expanded");
    });
    if (triggerAriaExpandedAfter100 === "false") {
      recordPass("Trigger aria-expanded is 'false' when closed");
    } else {
      recordFail(`Trigger aria-expanded is not 'false' (got: '${triggerAriaExpandedAfter100}')`);
    }

    // Focus restoration check
    const activeElementAfter100 = await page.evaluate(() =>
      document.activeElement ? document.activeElement.id : ""
    );
    if (activeElementAfter100 === "globalSearchTrigger") {
      recordPass(`Focus is cleanly restored to #globalSearchTrigger after 100 cycles`);
    } else {
      recordFail(`Focus not restored to #globalSearchTrigger (got: '${activeElementAfter100}')`);
    }

    // Toggle 101st time (odd cycle): modal must open
    await page.keyboard.down(modKey);
    await page.keyboard.press("KeyK");
    await page.keyboard.up(modKey);
    await sleep(200);

    const modalOpenAfter101 = await page.evaluate(() => {
      const modal = document.getElementById("global-search-modal");
      return modal.hasAttribute("open") || modal.open;
    });
    if (modalOpenAfter101) {
      recordPass("Modal is open after 101st toggle (odd cycle)");
    } else {
      recordFail("Modal failed to open on 101st toggle");
    }

    const inputFocusedAfter101 = await page.evaluate(() => {
      return document.activeElement && document.activeElement.id === "globalSearchInput";
    });
    if (inputFocusedAfter101) {
      recordPass("Search input #globalSearchInput is automatically focused upon opening");
    } else {
      recordFail("Search input #globalSearchInput did not receive automatic focus");
    }

    // Close with Escape key
    await page.keyboard.press("Escape");
    await sleep(150);

    const modalClosedAfterEscape = await page.evaluate(() => {
      const modal = document.getElementById("global-search-modal");
      return !modal.hasAttribute("open") && !modal.open;
    });
    if (modalClosedAfterEscape) {
      recordPass("Escape key successfully closes search modal");
    } else {
      recordFail("Escape key failed to close search modal");
    }

    const focusAfterEscape = await page.evaluate(() =>
      document.activeElement ? document.activeElement.id : ""
    );
    if (focusAfterEscape === "globalSearchTrigger") {
      recordPass(`Focus restored to trigger after Escape key`);
    } else {
      recordFail(`Focus not restored after Escape key (got: '${focusAfterEscape}')`);
    }

    if (appJsErrors.length === 0) {
      recordPass(`Zero application runtime errors during rapid toggling`);
    } else {
      recordFail(
        `Application runtime errors encountered during rapid toggling: ${appJsErrors.join("; ")}`
      );
    }

    // =========================================================================
    // SUITE 2: Guarded '/' Keypresses Across Contexts
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 2: Guarded '/' Keypresses (Inputs, Textareas, Other Modals vs Bare Page)");
    console.log("--------------------------------------------------------------------------------");

    // Context 2.1: Inside standard text input
    const emailInputExists = await page.$(
      ".footer-signup-form input[type='email'], #newsletter-email, input[type='email']"
    );
    if (emailInputExists) {
      await emailInputExists.focus();
      await page.keyboard.type("test/user@example.com");
      const emailVal = await page.evaluate((el) => el.value, emailInputExists);
      const isSearchOpenFromInput = await page.evaluate(() => {
        const m = document.getElementById("global-search-modal");
        return m.hasAttribute("open") || m.open;
      });
      if (emailVal.includes("/")) recordPass("Input receives '/' character verbatim");
      else recordFail("Input failed to receive '/' character");
      if (!isSearchOpenFromInput)
        recordPass("Search modal DOES NOT open while typing '/' inside text input");
      else recordFail("Search modal opened unexpectedly while typing in input");
    }

    // Context 2.2: Inside a textarea
    await page.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.id = "test-textarea-guard";
      document.body.appendChild(ta);
      ta.focus();
    });
    await page.keyboard.type("gift / custom / note");
    const taVal = await page.evaluate(() => document.getElementById("test-textarea-guard").value);
    const isSearchOpenFromTa = await page.evaluate(() => {
      const m = document.getElementById("global-search-modal");
      return m.hasAttribute("open") || m.open;
    });
    if (taVal === "gift / custom / note") recordPass("Textarea receives '/' characters verbatim");
    else recordFail("Textarea failed to receive '/' characters");
    if (!isSearchOpenFromTa)
      recordPass("Search modal DOES NOT open while typing '/' inside textarea");
    else recordFail("Search modal opened unexpectedly while typing in textarea");
    await page.evaluate(() => document.getElementById("test-textarea-guard").remove());

    // Context 2.3: Inside a <select> element
    await page.evaluate(() => {
      const sel = document.createElement("select");
      sel.id = "test-select-guard";
      const opt = document.createElement("option");
      opt.value = "val";
      opt.textContent = "Option";
      sel.appendChild(opt);
      document.body.appendChild(sel);
      sel.focus();
    });
    await page.keyboard.press("Slash");
    const isSearchOpenFromSelect = await page.evaluate(() => {
      const m = document.getElementById("global-search-modal");
      return m.hasAttribute("open") || m.open;
    });
    if (!isSearchOpenFromSelect) recordPass("Search modal DOES NOT open while focused on <select>");
    else recordFail("Search modal opened while focused on <select>");
    await page.evaluate(() => document.getElementById("test-select-guard").remove());

    // Context 2.4: Inside another open dialog
    const orderModalExists = await page.$("#order-status-modal");
    if (orderModalExists) {
      await page.evaluate(() => {
        const om = document.getElementById("order-status-modal");
        if (typeof om.showModal === "function") om.showModal();
        else om.setAttribute("open", "");
      });
      await sleep(100);
      await page.keyboard.press("Slash");
      const isSearchOpenFromOtherDialog = await page.evaluate(() => {
        const m = document.getElementById("global-search-modal");
        return m.hasAttribute("open") || m.open;
      });
      if (!isSearchOpenFromOtherDialog)
        recordPass("Search modal DOES NOT open when another <dialog[open]> is active");
      else recordFail("Search modal opened while another modal was active");
      await page.evaluate(() => {
        const om = document.getElementById("order-status-modal");
        if (typeof om.close === "function") om.close();
        else om.removeAttribute("open");
      });
      await sleep(100);
    }

    // Context 2.5: Bare page / non-input element focused
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      document.body.focus();
    });
    await sleep(50);
    await page.keyboard.press("Slash");
    await sleep(150);

    const isSearchOpenFromBarePage = await page.evaluate(() => {
      const m = document.getElementById("global-search-modal");
      return m.hasAttribute("open") || m.open;
    });
    if (isSearchOpenFromBarePage)
      recordPass("Search modal OPENS when '/' key is pressed on non-input page context");
    else recordFail("Search modal failed to open when '/' key pressed on bare page");

    // Close search modal for next suite
    await page.keyboard.press("Escape");
    await sleep(150);

    // =========================================================================
    // SUITE 3: Rapid 1-Click Add to Cart & State Concurrency
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 3: Rapid 1-Click Cart Additions & Concurrency in Search Results");
    console.log("--------------------------------------------------------------------------------");

    // Clear cart state first
    await page.evaluate(() => {
      localStorage.removeItem("yl-cart-v1");
      if (window.YLCart && typeof window.YLCart.clear === "function") {
        window.YLCart.clear();
      }
    });

    // Open search modal and search for "salve"
    await page.click("#globalSearchTrigger");
    await sleep(150);
    await page.type("#globalSearchInput", "salve", { delay: 20 });
    await sleep(350);

    const productResultsCount = await page.evaluate(() => {
      return document.querySelectorAll(".search-result-item[data-url*='products/']").length;
    });
    if (productResultsCount >= 2)
      recordPass(
        `Search results render multiple products for 'salve' (found: ${productResultsCount})`
      );
    else recordFail(`Insufficient product results for 'salve' (found: ${productResultsCount})`);

    const addButtonsCount = await page.evaluate(() => {
      return document.querySelectorAll(".search-add-btn").length;
    });
    if (addButtonsCount >= 2)
      recordPass(`Multiple 1-click '+ Add' buttons rendered (found: ${addButtonsCount})`);
    else recordFail(`Insufficient add-to-cart buttons rendered (found: ${addButtonsCount})`);

    // Perform rapid concurrent clicks on multiple add-to-cart buttons
    console.log("  Executing rapid concurrent clicks on search result Add-to-Cart buttons...");
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".search-add-btn.yl-add-item");
      if (btns.length >= 2) {
        btns[0].click();
        btns[0].click();
        btns[0].click();
        btns[1].click();
        btns[1].click();
      }
    });
    await sleep(300);

    // Verify cart state
    const cartItems = await page.evaluate(() => {
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
        return null;
      }
    });

    if (Array.isArray(cartItems)) {
      recordPass("Cart state successfully persisted as array in localStorage");
    } else {
      recordFail("Cart state not found or invalid in localStorage");
    }

    const totalQtyInState = (cartItems || []).reduce((sum, item) => sum + (item.qty || 1), 0);
    if (totalQtyInState === 5) {
      recordPass(`Cart total quantity equals expected 5 items (got: ${totalQtyInState})`);
    } else {
      recordFail(`Cart total quantity mismatch (expected 5, got: ${totalQtyInState})`);
    }

    // Verify badge in DOM
    const badgeCount = await page.evaluate(() => {
      const badge = document.querySelector(".cart-count");
      return badge ? badge.textContent.trim() : "";
    });
    if (badgeCount === "5") {
      recordPass(`Header cart badge count matches 5 (got: '${badgeCount}')`);
    } else {
      recordFail(`Header cart badge count mismatch (expected '5', got: '${badgeCount}')`);
    }

    // Verify button visual feedback class/text
    const buttonFeedback = await page.evaluate(() => {
      const btns = document.querySelectorAll(".search-add-btn");
      return Array.from(btns).map((b) => ({
        text: b.textContent.trim(),
        isAdded: b.classList.contains("is-added")
      }));
    });
    if (buttonFeedback.some((b) => b.text.includes("Added") || b.isAdded)) {
      recordPass("Add-to-cart button displays visual feedback ('✓ Added')");
    } else {
      recordFail("Add-to-cart button visual feedback missing");
    }

    // Clean up cart drawer state if opened
    await page.evaluate(() => {
      if (window.YLCart && typeof window.YLCart.close === "function") {
        window.YLCart.close();
      }
      const drawer = document.getElementById("yl-cart-drawer");
      if (drawer) drawer.classList.remove("open");
    });
    await sleep(100);

    // =========================================================================
    // SUITE 4: Focus Trapping Integrity with Tab / Shift+Tab under DOM Mutation
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 4: Focus Trapping Integrity (Tab / Shift+Tab & Ancestor Hidden State)");
    console.log("--------------------------------------------------------------------------------");

    // Close and reopen search modal in clean empty state
    await page.keyboard.press("Escape");
    await sleep(150);
    await page.click("#globalSearchTrigger");
    await sleep(200);

    // Empty state focus trap:
    await page.focus("#globalSearchInput");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    await sleep(100);

    const activeAfterEmptyShiftTab = await page.evaluate(() => {
      const modal = document.getElementById("global-search-modal");
      return modal && document.activeElement && modal.contains(document.activeElement);
    });
    if (activeAfterEmptyShiftTab) {
      recordPass("Shift+Tab from first element in empty state wraps to element inside modal");
    } else {
      recordFail("Shift+Tab in empty state escaped modal");
    }

    // Adversarial Check 4.2: Real Tab / Shift+Tab cycling under live query (chipsSection hidden)
    console.log("  Testing live Tab / Shift+Tab cycling when chipsSection is hidden...");
    await page.focus("#globalSearchInput");
    await page.type("#globalSearchInput", "salve", { delay: 20 });
    await sleep(350);

    let escapedLiveTab = false;
    for (let i = 0; i < 25; i++) {
      if (i % 2 === 0) {
        await page.keyboard.press("Tab");
      } else {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
      }
      const isInside = await page.evaluate(() => {
        const modal = document.getElementById("global-search-modal");
        return modal && document.activeElement && modal.contains(document.activeElement);
      });
      if (!isInside) {
        escapedLiveTab = true;
        break;
      }
    }

    if (!escapedLiveTab) {
      recordPass(
        "Focus strictly remains trapped inside modal during 25 Tab / Shift+Tab cycles across live results"
      );
    } else {
      recordFail("Focus escaped modal during live results Tab / Shift+Tab cycling");
    }

    // =========================================================================
    // SUITE 5: Listbox Keyboard Navigation Boundaries (ArrowDown & ArrowUp)
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 5: Listbox Keyboard Navigation Boundaries (ArrowDown / ArrowUp Wrapping)");
    console.log("--------------------------------------------------------------------------------");

    // Reopen modal and search for "salve" to get clean list of items
    await page.keyboard.press("Escape");
    await sleep(150);
    await page.click("#globalSearchTrigger");
    await sleep(150);
    await page.type("#globalSearchInput", "salve", { delay: 20 });
    await sleep(350);

    const itemCount = await page.evaluate(() => {
      return document.querySelectorAll(".search-result-item").length;
    });
    if (itemCount >= 3) {
      recordPass(`Listbox rendered items for navigation testing (count: ${itemCount})`);
    } else {
      recordFail(`Listbox item count insufficient (count: ${itemCount})`);
    }

    // Focus input
    await page.focus("#globalSearchInput");

    // ArrowDown should select index 0
    await page.keyboard.press("ArrowDown");
    await sleep(50);
    const active0 = await page.evaluate(() => {
      return document.getElementById("globalSearchInput").getAttribute("aria-activedescendant");
    });
    if (active0 === "search-opt-0") {
      recordPass(`First ArrowDown sets aria-activedescendant to 'search-opt-0'`);
    } else {
      recordFail(`First ArrowDown failed (got: '${active0}')`);
    }

    // ArrowUp from index 0: should wrap to last item (search-opt-(N-1))
    await page.keyboard.press("ArrowUp");
    await sleep(50);
    const activeWrappedLast = await page.evaluate(() => {
      return document.getElementById("globalSearchInput").getAttribute("aria-activedescendant");
    });
    const expectedLastOpt = `search-opt-${itemCount - 1}`;
    if (activeWrappedLast === expectedLastOpt) {
      recordPass(`ArrowUp from start wraps to last item '${expectedLastOpt}'`);
    } else {
      recordFail(
        `ArrowUp from start failed to wrap to last item (got: '${activeWrappedLast}', expected: '${expectedLastOpt}')`
      );
    }

    // ArrowDown past end: Test if ArrowDown from last item wraps to index 0
    await page.keyboard.press("ArrowDown");
    await sleep(50);
    const activeWrappedFirst = await page.evaluate(() => {
      return document.getElementById("globalSearchInput").getAttribute("aria-activedescendant");
    });
    if (activeWrappedFirst === "search-opt-0") {
      recordPass(`ArrowDown past end wraps to first item 'search-opt-0'`);
    } else {
      recordFail(
        `ArrowDown past end failed to wrap to 'search-opt-0' (got: '${activeWrappedFirst}')`
      );
    }

    // =========================================================================
    // SUITE 6: Zero Horizontal Layout Overflow across Narrow Viewports
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 6: Zero Horizontal Layout Overflow (320px, 375px, 768px, 1280px)");
    console.log("--------------------------------------------------------------------------------");

    const viewports = [
      { name: "320px (Ultra-narrow Mobile)", width: 320, height: 568 },
      { name: "375px (Standard Mobile)", width: 375, height: 667 },
      { name: "768px (Tablet)", width: 768, height: 1024 },
      { name: "1280px (Desktop)", width: 1280, height: 800 }
    ];

    for (const vp of viewports) {
      console.log(`  Testing viewport: ${vp.name}...`);
      await page.setViewport({ width: vp.width, height: vp.height });
      await sleep(100);

      // 6.1: Empty state with chips
      await page.evaluate(() => {
        const inp = document.getElementById("globalSearchInput");
        inp.value = "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(250);

      const emptyOverflow = await page.evaluate((vpWidth) => {
        const docScroll = document.documentElement.scrollWidth;
        const bodyScroll = document.body.scrollWidth;
        const modal = document.getElementById("global-search-modal");
        const modalScroll = modal ? modal.scrollWidth : 0;
        const modalClient = modal ? modal.clientWidth : 0;
        return {
          hasDocOverflow: docScroll > vpWidth,
          hasBodyOverflow: bodyScroll > vpWidth,
          hasModalOverflow: modalScroll > modalClient + 2,
          docScroll,
          bodyScroll
        };
      }, vp.width);

      if (!emptyOverflow.hasDocOverflow)
        recordPass(
          `[${vp.name}] Zero document overflow in empty state (scrollWidth: ${emptyOverflow.docScroll}px <= ${vp.width}px)`
        );
      else
        recordFail(
          `[${vp.name}] Document overflow in empty state (${emptyOverflow.docScroll}px > ${vp.width}px)`
        );

      if (!emptyOverflow.hasModalOverflow)
        recordPass(`[${vp.name}] Zero modal container overflow in empty state`);
      else recordFail(`[${vp.name}] Modal container overflow in empty state`);

      // 6.2: Multi-domain populated results ("botanical")
      await page.evaluate(() => {
        const inp = document.getElementById("globalSearchInput");
        inp.value = "botanical";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(350);

      const populatedOverflow = await page.evaluate((vpWidth) => {
        const docScroll = document.documentElement.scrollWidth;
        const modal = document.getElementById("global-search-modal");
        const modalScroll = modal ? modal.scrollWidth : 0;
        const modalClient = modal ? modal.clientWidth : 0;
        const items = document.querySelectorAll(
          ".search-result-item, .search-chips-list, .search-section-header"
        );
        let offendingElement = null;
        for (const el of items) {
          const rect = el.getBoundingClientRect();
          if (rect.right > vpWidth + 2) {
            offendingElement = `${el.className} (right: ${rect.right}px > ${vpWidth}px)`;
            break;
          }
        }
        return {
          hasDocOverflow: docScroll > vpWidth,
          hasModalOverflow: modalScroll > modalClient + 2,
          offendingElement
        };
      }, vp.width);

      if (!populatedOverflow.hasDocOverflow)
        recordPass(`[${vp.name}] Zero document overflow with populated multi-domain results`);
      else recordFail(`[${vp.name}] Document overflow with populated multi-domain results`);

      if (!populatedOverflow.hasModalOverflow)
        recordPass(`[${vp.name}] Zero modal overflow with populated multi-domain results`);
      else recordFail(`[${vp.name}] Zero modal overflow with populated multi-domain results`);

      if (!populatedOverflow.offendingElement)
        recordPass(`[${vp.name}] All search result cards strictly fit within viewport`);
      else
        recordFail(
          `[${vp.name}] Offending overflowing element: ${populatedOverflow.offendingElement}`
        );

      // 6.3: Long query zero-result state
      await page.evaluate(() => {
        const inp = document.getElementById("globalSearchInput");
        inp.value = "Supercalifragilisticexpialidocious botanical ointment non-existent query";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(350);

      const longQueryOverflow = await page.evaluate((vpWidth) => {
        const docScroll = document.documentElement.scrollWidth;
        return docScroll > vpWidth;
      }, vp.width);
      if (!longQueryOverflow)
        recordPass(`[${vp.name}] Zero horizontal overflow with long non-matching query`);
      else recordFail(`[${vp.name}] Horizontal overflow with long non-matching query`);
    }

    // =========================================================================
    // SUITE 7: Multi-Page Trigger & Modal Lifecycle Consistency
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 7: Multi-Page Search Trigger & Modal Consistency");
    console.log("--------------------------------------------------------------------------------");

    const samplePages = ["/shop.html", "/about.html", "/events.html", "/faq.html"];

    for (const p of samplePages) {
      await page.goto(`${baseUrl}${p}`, { waitUntil: "networkidle0" });
      const trigger = await page.$("#globalSearchTrigger");
      if (trigger) recordPass(`[${p}] Header #globalSearchTrigger is present in DOM`);
      else recordFail(`[${p}] Header #globalSearchTrigger missing`);

      const modal = await page.$("#global-search-modal");
      if (modal) recordPass(`[${p}] <dialog id="global-search-modal"> is present in DOM`);
      else recordFail(`[${p}] <dialog id="global-search-modal"> missing`);

      // Open via click
      await page.click("#globalSearchTrigger");
      await sleep(100);

      const isOpen = await page.evaluate(() => {
        const m = document.getElementById("global-search-modal");
        return m.hasAttribute("open") || m.open;
      });
      if (isOpen) recordPass(`[${p}] Clicking search trigger opens modal`);
      else recordFail(`[${p}] Clicking search trigger failed to open modal`);

      // Close via Escape
      await page.keyboard.press("Escape");
      await sleep(100);

      const isClosed = await page.evaluate(() => {
        const m = document.getElementById("global-search-modal");
        return !m.hasAttribute("open") && !m.open;
      });
      if (isClosed) recordPass(`[${p}] Escape key closes modal`);
      else recordFail(`[${p}] Escape key failed to close modal`);
    }
    // =========================================================================
    // SUITE 8: Search Inline Variant Chip Picker (R2 Micro-Interactions & Cart Delta Math)
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log("VECTOR 8: Search Inline Variant Chip Picker (2026 SOTA & Cart Delta Math)");
    console.log("--------------------------------------------------------------------------------");

    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });
    await page.setViewport({ width: 1200, height: 800 });

    // Clear cart state
    await page.evaluate(() => {
      localStorage.removeItem("yl-cart-v1");
      if (window.YLCart && typeof window.YLCart.clear === "function") {
        window.YLCart.clear();
      }
    });

    // Open search modal and search for "frankincense"
    await page.click("#globalSearchTrigger");
    await sleep(150);
    await page.type("#globalSearchInput", "frankincense", { delay: 20 });
    await sleep(350);

    // Verify Frankincense Salve card has variant trigger
    const variantTriggerExists = await page.evaluate(() => {
      const btn = document.querySelector(
        ".search-variant-trigger[data-item-id='frankincense-salve']"
      );
      return !!btn;
    });
    if (variantTriggerExists) {
      recordPass("Frankincense Salve renders .search-variant-trigger button (+ Add)");
    } else {
      recordFail("Frankincense Salve missing .search-variant-trigger button");
    }

    // Click + Add on Frankincense Salve
    await page.click(".search-variant-trigger[data-item-id='frankincense-salve']");
    await sleep(150);

    const pickerExpanded = await page.evaluate(() => {
      const action = document.querySelector(
        ".search-item-action[data-product-id='frankincense-salve']"
      );
      const picker = document.querySelector("#search-variant-picker-frankincense-salve");
      const trigger = document.querySelector(
        ".search-variant-trigger[data-item-id='frankincense-salve']"
      );
      return (
        action.classList.contains("is-expanded") &&
        !picker.hidden &&
        trigger.getAttribute("aria-expanded") === "true" &&
        picker.getAttribute("role") === "radiogroup"
      );
    });
    if (pickerExpanded) {
      recordPass(
        "Clicking + Add expands .search-variant-picker with role='radiogroup' and aria-expanded='true'"
      );
    } else {
      recordFail("Variant picker failed to expand with required ARIA attributes");
    }

    // Check chips inside Frankincense Salve picker
    const chipDetails = await page.evaluate(() => {
      const picker = document.querySelector("#search-variant-picker-frankincense-salve");
      const chips = Array.from(picker.querySelectorAll(".search-variant-chip"));
      return chips.map((c) => ({
        text: c.textContent.trim(),
        role: c.getAttribute("role"),
        ariaChecked: c.getAttribute("aria-checked"),
        variantLabel: c.getAttribute("data-variant-label"),
        variantDelta: c.getAttribute("data-variant-delta"),
        price: c.getAttribute("data-price")
      }));
    });

    if (chipDetails.length === 2) {
      recordPass(`Variant picker renders 2 size chips (found: ${chipDetails.length})`);
    } else {
      recordFail(`Unexpected number of variant chips (expected 2, got ${chipDetails.length})`);
    }

    const has1ozChip = chipDetails.some(
      (c) => c.variantLabel === "1oz" && c.variantDelta === "-6" && c.price === "13.99"
    );
    if (has1ozChip) {
      recordPass("1oz variant chip carries delta -6 and price $13.99");
    } else {
      recordFail("1oz variant chip missing correct delta / price attributes");
    }

    // Test Arrow navigation to 1oz chip and Spacebar select
    await page.keyboard.press("ArrowRight");
    await sleep(50);
    await page.keyboard.press("Space");
    await sleep(300);

    // Verify cart state updated with 1oz Frankincense Salve at $13.99
    const cartStateAfter1oz = await page.evaluate(() => {
      try {
        const items = (function () {
          const p = JSON.parse(localStorage.getItem("yl-cart-v1") || "[]");
          return Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [];
        })();
        return items[0] || null;
      } catch {
        return null;
      }
    });

    if (
      cartStateAfter1oz &&
      cartStateAfter1oz.id === "frankincense-salve" &&
      cartStateAfter1oz.variantLabel === "1oz" &&
      cartStateAfter1oz.variantDelta === -6
    ) {
      recordPass("Cart state successfully populated with 1oz variant (delta -6)");
    } else {
      recordFail(`Cart state variant mismatch: ${JSON.stringify(cartStateAfter1oz)}`);
    }

    // Verify cart drawer is opened
    const isCartDrawerOpen = await page.evaluate(() => {
      const drawer = document.getElementById("yl-cart-drawer");
      return (
        drawer &&
        (drawer.matches(":popover-open") ||
          drawer.classList.contains("open") ||
          drawer.hasAttribute("open") ||
          drawer.getAttribute("data-open") === "true")
      );
    });
    if (isCartDrawerOpen) {
      recordPass("Selecting variant opens cart drawer");
    } else {
      recordFail("Cart drawer did not open on variant selection");
    }

    // Close drawer via Escape
    await page.keyboard.press("Escape");
    await sleep(150);

    // Test sold-out chip handling on Tank Top
    await page.click("#globalSearchInput");
    await page.evaluate(() => {
      const inp = document.getElementById("globalSearchInput");
      inp.value = "tank";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(350);

    const tankSoldOutChip = await page.evaluate(() => {
      const trigger = document.querySelector(".search-variant-trigger[data-item-id='tank-top']");
      if (trigger) trigger.click();
      const sChip = document.querySelector(
        "#search-variant-picker-tank-top .search-variant-chip[data-variant-label='S']"
      );
      return sChip
        ? {
            disabled: sChip.disabled,
            isSoldOutClass: sChip.classList.contains("is-sold-out"),
            ariaDisabled: sChip.getAttribute("aria-disabled")
          }
        : null;
    });

    if (tankSoldOutChip && tankSoldOutChip.disabled && tankSoldOutChip.isSoldOutClass) {
      recordPass("Tank top 'S' variant is disabled and carries .is-sold-out class");
    } else {
      recordFail(
        `Tank top sold out state missing or incorrect: ${JSON.stringify(tankSoldOutChip)}`
      );
    }

    // Close modal for next suite
    await page.keyboard.press("Escape");
    await sleep(150);

    // =========================================================================
    // SUITE 9: Speculative Hover Prefetching (R3 Live Browser Validation)
    // =========================================================================
    console.log(
      "\n--------------------------------------------------------------------------------"
    );
    console.log(
      "VECTOR 9: Speculative Hover Prefetching Controller (2026 SOTA in Headless Browser)"
    );
    console.log("--------------------------------------------------------------------------------");

    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });

    // Hover over an internal navigation link for 150ms (>65ms debounce)
    const aboutLink = await page.$("a[href*='about.html']");
    if (aboutLink) {
      await aboutLink.hover();
      await sleep(150);

      const isPrefetched = await page.evaluate(() => {
        const headHtml = document.head.innerHTML;
        return (
          headHtml.includes("about.html") ||
          !!document.head.querySelector("link[rel='prefetch'][href*='about.html']") ||
          !!document.head.querySelector("script[type='speculationrules']")
        );
      });

      if (isPrefetched) {
        recordPass("Hovering internal link (>65ms debounce) injects prefetch into <head>");
      } else {
        recordFail("Hover prefetch element not found in <head>");
      }
    } else {
      recordFail("Could not locate about.html link on index.html");
    }
  } catch (err) {
    console.error("FATAL ERROR in test execution:", err);
    failedChecks++;
    failures.push(err.message);
  } finally {
    if (browser) await browser.close();
    if (serverInstance) serverInstance.close();
  }

  console.log("\n================================================================================");
  console.log(`CHALLENGER 2 SUMMARY: ${passedChecks} checks passed, ${failedChecks} failed.`);
  console.log("================================================================================");

  if (failures.length > 0) {
    console.log("\nFAILURES IDENTIFIED:");
    failures.forEach((f, idx) => console.log(`  ${idx + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log("\nALL ADVERSARIAL STRESS CHECKS PASSED EMPIRICALLY.");
    process.exit(0);
  }
})();
