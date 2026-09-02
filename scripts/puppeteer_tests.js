/**
 * @fileoverview Automated Headless Browser Integration Test Suite for Y'allternative Living.
 *
 * Automatically manages a local static HTTP server lifecycle on port 8082, then executes
 * multi-viewport integration tests across Desktop (1200x800), Tablet (768x1024), and
 * Mobile (375x667) viewports. Validates internal link integrity, responsive navigation
 * drawer toggling, newsletter form submission interception, and the on-site cart's
 * add-to-cart + drawer flow (assets/js/cart.js -- checkout itself hands off to Stripe's
 * hosted page, which this local static-server test harness can't exercise).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * Creates and starts a lightweight local static HTTP server for test execution.
 * @param {number} [port=8082] Port number to listen on.
 * @return {Promise<http.Server>} Resolves with the running HTTP server instance.
 */
function createStaticServer(port = 8082) {
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
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  console.log("Starting Puppeteer tests...");
  let exitCode = 0;
  let browser;
  let localServer;
  const port = 8082;
  const url = `http://127.0.0.1:${port}`;

  try {
    try {
      localServer = await createStaticServer(port);
      console.log(`Started local static server on ${url}`);
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        console.log(`Using existing server running on ${url}`);
      } else {
        throw e;
      }
    }

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();

    // 1. Check for Broken Links (Internal)
    console.log("--- Testing Broken Links ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const hrefs = await page.$$eval("a", (links) =>
      links.map((a) => a.href).filter((h) => h.startsWith("http"))
    );
    let brokenLinks = [];
    let linksChecked = 0;
    for (let href of [...new Set(hrefs)]) {
      if (href.startsWith(url)) {
        linksChecked++;
        try {
          const res = await page.goto(href, { waitUntil: "domcontentloaded" });
          if (res && res.status() >= 400) {
            brokenLinks.push(`${href} (Status: ${res.status()})`);
          }
        } catch (e) {
          brokenLinks.push(`${href} (Error: ${e.message})`);
        }
      }
    }

    /* "0 broken links" out of 0 links is not a pass. The homepage header,
       footer and product grid carry well over twenty internal links, so an
       empty crawl means the anchors, the selector or the page failed to
       render -- exactly the regression this check exists to catch. */
    const MIN_INTERNAL_LINKS = 20;
    if (linksChecked < MIN_INTERNAL_LINKS) {
      console.log(
        `❌ Only ${linksChecked} internal links found on the homepage ` +
          `(expected at least ${MIN_INTERNAL_LINKS}) -- nothing to verify.`
      );
      exitCode = 1;
    }

    if (brokenLinks.length > 0) {
      console.log(`❌ Found ${brokenLinks.length} broken links:`);
      brokenLinks.forEach((b) => console.log(b));
      exitCode = 1;
    } else if (linksChecked >= MIN_INTERNAL_LINKS) {
      console.log(`✅ No broken internal links found on homepage (${linksChecked} checked).`);
    }

    // 2. Test Mobile Menu Interaction
    console.log("--- Testing Mobile Menu ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.setViewport({ width: 375, height: 667 });

    const menuToggle = await page.$(".nav-toggle");
    if (menuToggle) {
      await menuToggle.click();
      await new Promise((r) => setTimeout(r, 500)); // wait for transition
      const isActive = await page.$eval(
        ".nav-links",
        // eslint-disable-next-line no-undef
        (el) => el.classList.contains("active") || window.getComputedStyle(el).display !== "none"
      );

      if (isActive) {
        console.log("✅ Mobile menu toggle works.");
      } else {
        console.log("❌ Mobile menu did not become active/visible after clicking toggle.");
        exitCode = 1;
      }
    } else {
      console.log("❌ Mobile menu toggle button not found.");
      exitCode = 1;
    }
    // 2b. Test Viewport Responsiveness & Horizontal Scroll Overflow (Desktop, Tablet, Mobile)
    console.log(
      "--- Testing Viewports Responsiveness & Overflow (1200x800, 768x1024, 375x667) ---"
    );
    const testViewports = [
      { name: "Desktop", width: 1200, height: 800 },
      { name: "Tablet", width: 768, height: 1024 },
      { name: "Mobile", width: 375, height: 667 }
    ];
    const vpOverflowResults = await Promise.all(
      testViewports.map(async (vp) => {
        const vpPage = await browser.newPage();
        try {
          await vpPage.setViewport({ width: vp.width, height: vp.height });
          await vpPage.goto(url, { waitUntil: "networkidle2" });
          const hasOverflow = await vpPage.evaluate(
            // eslint-disable-next-line no-undef
            () => document.documentElement.scrollWidth > window.innerWidth
          );
          return { vp, hasOverflow };
        } finally {
          await vpPage.close();
        }
      })
    );
    for (const r of vpOverflowResults) {
      if (!r.hasOverflow) {
        console.log(
          `✅ ${r.vp.name} viewport (${r.vp.width}x${r.vp.height}) layout renders without horizontal overflow.`
        );
      } else {
        console.log(
          `❌ ${r.vp.name} viewport (${r.vp.width}x${r.vp.height}) has horizontal scroll overflow.`
        );
        exitCode = 1;
      }
    }

    // 3. Test Form Submissions
    console.log("--- Testing Newsletter Form ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const emailInput = await page.$("#footer_email");
    if (emailInput) {
      await emailInput.type("test@example.com");

      /* The expected endpoint is whatever site.kitFormAction is configured to,
         read from the same JSON the build renders the form from -- not a
         literal pasted here. This assertion used to hardcode the
         YOUR_KIT_FORM_ACTION_URL placeholder, which meant it only passed
         while the newsletter was unconfigured: connecting Kit for real, the
         thing we actually want, turned the check red. A test that goes green
         only on the broken state is worse than no test, because it argues
         against fixing the bug. */
      const kitAction = (
        JSON.parse(fs.readFileSync(path.join(__dirname, "..", "assets/data/content.json"), "utf8"))
          .site || {}
      ).kitFormAction;

      if (!kitAction) {
        console.log(
          "❌ site.kitFormAction missing from content.json -- nothing to assert against."
        );
        exitCode = 1;
      }

      let intercepted = false;
      let postedTo = null;
      await page.setRequestInterception(true);
      const requestHandler = (req) => {
        if (req.isInterceptResolutionHandled()) return;
        if (req.method() === "POST") {
          postedTo = req.url();
          if (kitAction && req.url().startsWith(kitAction)) intercepted = true;
          req.abort();
        } else {
          req.continue();
        }
      };
      page.on("request", requestHandler);

      await page.$eval(".footer-signup-form", (form) => form.submit()).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      if (intercepted) {
        console.log("✅ Newsletter form posts to the configured Kit endpoint (" + kitAction + ").");
      } else if (postedTo) {
        console.log(
          "❌ Newsletter form posted to " + postedTo + " but content.json says " + kitAction + "."
        );
        exitCode = 1;
      } else if (kitAction) {
        console.log("❌ Newsletter form issued no POST at all.");
        exitCode = 1;
      }

      page.off("request", requestHandler);
      await page.setRequestInterception(false);
    } else {
      console.log("❌ Newsletter form not found.");
      exitCode = 1;
    }

    // 4. Test the on-site cart (cart.js) add-to-cart + drawer flow
    console.log("--- Testing Cart Flow ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".yl-add-item", { timeout: 5000 }).catch(() => {});
    const addBtn = await page.$(".yl-add-item");
    if (addBtn) {
      await addBtn.click();
      let cartLineVisible = false;
      try {
        // addItemFromButton() renders the line item then calls openDrawer()
        // (see assets/js/cart.js) -- waiting on the rendered line, not just
        // the popover opening, also proves the add itself actually worked.
        await page.waitForSelector("#yl-cart-drawer .yl-cart-line", {
          visible: true,
          timeout: 10000
        });
        cartLineVisible = true;
      } catch (e) {
        cartLineVisible = false;
      }

      let badgeUpdated = false;
      if (cartLineVisible) {
        badgeUpdated = await page
          .$eval(
            ".cart-count",
            (el) => el.textContent.trim() !== "" && el.textContent.trim() !== "0"
          )
          .catch(() => false);
      }

      if (cartLineVisible && badgeUpdated) {
        console.log("✅ Cart integration verified (item added, drawer opened, badge updated).");
      } else if (cartLineVisible) {
        console.log(
          "❌ Cart drawer opened with a line item, but the nav badge count didn't update."
        );
        exitCode = 1;
      } else {
        console.log("❌ Cart drawer/line item did not appear after Add to Cart.");
        exitCode = 1;
      }
    } else {
      console.log("❌ No 'Add to Cart' button found on shop.html.");
      exitCode = 1;
    }

    // 5. Test Countdown Ticker (R1)
    console.log("--- Testing Countdown Ticker (R1) ---");
    for (const pageName of ["index.html", "events.html"]) {
      await page.goto(`${url}/${pageName}`, { waitUntil: "networkidle2" });
      if (pageName === "index.html") {
        const ticker = await page.$("#yl-countdown-ticker");
        if (ticker) {
          /* Three legitimate states, all driven by the real events.json:
             counting down to the next pop-up (the digit spans), a market
             that's open today, or no dates on the calendar at all. The
             "in progress" and "no dates" branches replace #heroCountdownTimer's
             children with plain text, so asserting on the digit spans alone
             turned this check into a calendar-dependent time bomb -- it would
             start failing the morning of a market day. Assert the ticker says
             something meaningful in whichever state it's in. */
          const timerText = await page
            .$eval("#heroCountdownTimer", (el) => el.textContent.replace(/\s+/g, " ").trim())
            .catch(() => null);
          const digits = await page.$("#yl-countdown-days");
          const counting = digits !== null && /\d/.test(timerText || "");
          const inProgress = /in progress today/i.test(timerText || "");
          const noDates = /stay tuned for new confirmed market dates/i.test(timerText || "");
          if (counting || inProgress || noDates) {
            console.log(`✅ Countdown ticker rendering on ${pageName} ("${timerText}").`);
          } else {
            console.log(
              `❌ Countdown ticker rendered no usable text on ${pageName} (got "${timerText}").`
            );
            exitCode = 1;
          }
        } else {
          console.log(`❌ #yl-countdown-ticker element missing on ${pageName}.`);
          exitCode = 1;
        }
      } else {
        const banner = await page.$("#eventsCountdownBanner");
        if (banner) {
          const bannerText = await page.evaluate((el) => el.textContent.trim(), banner);
          if (bannerText.length > 0) {
            console.log(`✅ Events countdown banner rendering on ${pageName}.`);
          } else {
            console.log(`❌ Events countdown banner empty on ${pageName}.`);
            exitCode = 1;
          }
        } else {
          console.log(`❌ #eventsCountdownBanner element missing on ${pageName}.`);
          exitCode = 1;
        }
      }
    }

    // 6. Test Order Status Modal & Timeline (R2)
    console.log("--- Testing Order Status Modal (R2) ---");
    for (const targetPage of ["thank-you.html", "shop.html"]) {
      await page.goto(`${url}/${targetPage}`, { waitUntil: "networkidle2" });
      await page
        .waitForSelector('[data-action="open-order-status"], #openOrderStatusBtn', {
          timeout: 5000
        })
        .catch(() => null);
      const openBtn = await page.$('[data-action="open-order-status"], #openOrderStatusBtn');
      if (openBtn) {
        await page.evaluate((btn) => btn.click(), openBtn);
        await page.waitForSelector("#order-status-modal", { visible: true, timeout: 5000 });

        const orderInput = await page.$("#order-id-input");
        if (orderInput) {
          await orderInput.type("cs_test_123456789");
          await page.click("#order-lookup-btn");
          await page.waitForSelector(
            "#order-timeline-container .timeline-step, #order-timeline-container .order-lookup-unavailable",
            {
              visible: true,
              timeout: 5000
            }
          );
          const hasResult = await page.evaluate(() => {
            /* eslint-disable no-undef */
            const steps = document.querySelectorAll(
              "#order-timeline-container .timeline-step"
            ).length;
            const unavailable = document.querySelector(
              "#order-timeline-container .order-lookup-unavailable"
            );
            return steps >= 3 || unavailable !== null;
            /* eslint-enable no-undef */
          });
          if (hasResult) {
            console.log(`✅ Order status lookup response rendered on ${targetPage}.`);
          } else {
            console.log(`❌ Order status lookup response missing on ${targetPage}.`);
            exitCode = 1;
          }
        } else {
          console.log(`❌ #order-id-input not found in the order status modal on ${targetPage}.`);
          exitCode = 1;
        }

        // Test Escape key close
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 400));
        const isClosed = await page.evaluate(() => {
          /* eslint-disable no-undef */
          const modal = document.querySelector("#order-status-modal");
          return !modal || !modal.hasAttribute("open");
          /* eslint-enable no-undef */
        });
        if (isClosed) {
          console.log(`✅ Order status modal closed via Escape key on ${targetPage}.`);
        } else {
          console.log(`❌ Order status modal failed to close via Escape key on ${targetPage}.`);
          exitCode = 1;
        }
      } else {
        console.log(`❌ Order status trigger button not found on ${targetPage}.`);
        exitCode = 1;
      }
    }

    // 7. Test Alt-Points Loyalty System (R3)
    console.log("--- Testing Alt-Points Loyalty System (R3) ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    /* The Cart Flow section above left an item in localStorage and nothing
       since empties it -- thank-you.html only clears the cart after a real
       Stripe redirect now (keyed on session_id, see assets/js/thank-you.js),
       so visiting that page no longer doubles as a reset. Start from a
       known-empty cart, or the expected point total below is the wrong one. */
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      if (window.YLCart && typeof window.YLCart.clear === "function") window.YLCart.clear();
      /* eslint-enable no-undef */
    });
    const badgeText = await page
      .$eval(".alt-points-badge", (el) => el.textContent.trim())
      .catch(() => null);
    if (badgeText && badgeText.includes("Earn")) {
      console.log(`✅ Product card displays Alt-Points badge ("${badgeText}").`);
    } else {
      console.log(`❌ Alt-Points badge missing or malformed on product card.`);
      exitCode = 1;
    }

    const shopAddBtn = await page.$(".card .yl-add-item");
    if (shopAddBtn) {
      const itemPrice = await page.evaluate(
        (btn) => parseFloat(btn.getAttribute("data-item-price")),
        shopAddBtn
      );
      await shopAddBtn.click();
      await page.waitForSelector("#yl-cart-drawer .yl-cart-line", { visible: true, timeout: 5000 });

      /* The drawer's Alt-Points total is gone: nothing credits the points and
         the endpoint that redeemed them minted real Stripe credit for anyone
         who asked (audit C-1). Assert the money it does quote instead, and
         that the withdrawn counter has not come back. */
      const pointsCounter = await page.$("#cart-points-count");
      if (pointsCounter) {
        console.log("❌ #cart-points-count is back in the cart drawer -- Alt-Points are not real.");
        exitCode = 1;
      } else {
        console.log("✅ Cart drawer shows no Alt-Points counter.");
      }

      const subtotalText = await page
        .$eval(".yl-cart-subtotal strong", (el) => el.textContent.trim())
        .catch(() => null);
      const subtotalValue = subtotalText ? parseFloat(subtotalText.replace(/[^0-9.]/g, "")) : NaN;
      if (Math.abs(subtotalValue - itemPrice) < 0.005) {
        console.log(`✅ Cart drawer subtotal matches the item price (${subtotalText}).`);
      } else {
        console.log(
          `❌ Cart drawer subtotal mismatch (expected $${itemPrice}, got ${subtotalText}).`
        );
        exitCode = 1;
      }
    } else {
      console.log("❌ No product card Add to Cart button (.card .yl-add-item) found on shop.html.");
      exitCode = 1;
    }

    // 8. Test Reviews & Social Proof Search, Filter & Verified Badges (R5)
    console.log("--- Testing Customer Reviews Search & Filter Page (R5) ---");
    await page.goto(`${url}/reviews.html`, { waitUntil: "networkidle2" });
    const reviewsGrid = await page.$("#reviewsGrid");
    if (reviewsGrid) {
      const initialCards = await page.$$(".review-card");
      if (initialCards.length >= 3) {
        console.log(`✅ reviews.html rendered ${initialCards.length} review cards.`);
      } else {
        console.log(`❌ reviews.html rendered fewer than 3 cards (got ${initialCards.length}).`);
        exitCode = 1;
      }

      const verifiedBadges = await page.$$(".badge-verified");
      if (verifiedBadges.length >= 2) {
        console.log(
          `✅ reviews.html successfully rendered ${verifiedBadges.length} verified buyer badges.`
        );
      } else {
        console.log(`❌ reviews.html failed to render verified buyer badges.`);
        exitCode = 1;
      }

      // Test Live Search
      await page.type("#reviewSearchInput", "knuckles");
      await new Promise((r) => setTimeout(r, 200));
      const filteredCards = await page.$$(".review-card");
      const bannerText = await page.$eval("#reviewsCountBanner", (el) => el.textContent);
      if (filteredCards.length === 1 && bannerText.includes("1 review")) {
        console.log(
          "✅ reviews.html keyword search dynamically filters cards and updates live counter."
        );
      } else {
        console.log(
          `❌ reviews.html keyword search failed (got ${filteredCards.length} cards, banner: "${bannerText}").`
        );
        exitCode = 1;
      }

      // Test Clear / Star Rating Filter
      await page.$eval("#reviewSearchInput", (el) => {
        el.value = "";
        el.dispatchEvent(new Event("input"));
      });
      await new Promise((r) => setTimeout(r, 150));
      const chip5 = await page.$('button[data-rating="5"]');
      if (chip5) {
        await chip5.click();
        await new Promise((r) => setTimeout(r, 200));
        const fiveStarCards = await page.$$(".review-card");
        if (fiveStarCards.length >= 2) {
          console.log(
            `✅ reviews.html star rating filter chip narrowed to 5-star reviews (${fiveStarCards.length} cards).`
          );
        } else {
          console.log("❌ reviews.html star rating filter failed.");
          exitCode = 1;
        }
      } else {
        console.log('❌ reviews.html star rating chip button[data-rating="5"] not found.');
        exitCode = 1;
      }

      // Reset
      const resetBtn = await page.$('button[data-rating="all"]');
      if (resetBtn) {
        await resetBtn.click();
        await new Promise((r) => setTimeout(r, 200));
        const restoredCards = await page.$$(".review-card");
        if (restoredCards.length === initialCards.length) {
          console.log("✅ reviews.html reset button restored all review cards.");
        } else {
          console.log(
            `❌ reviews.html reset button restored ${restoredCards.length} review cards, expected ${initialCards.length}.`
          );
          exitCode = 1;
        }
      } else {
        console.log('❌ reviews.html reset chip button[data-rating="all"] not found.');
        exitCode = 1;
      }
    } else {
      console.log("❌ #reviewsGrid element missing on reviews.html.");
      exitCode = 1;
    }

    console.log("--- Testing Apothecary Recommendation Quiz (R4) ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    const quizSection = await page.$("#apothecary-quiz-section");
    if (quizSection) {
      const openQuizBtn = await page.$("#open-apothecary-quiz-btn");
      if (openQuizBtn) {
        await page.evaluate((b) => b.click(), openQuizBtn);
        await new Promise((r) => setTimeout(r, 200));
      } else {
        console.log("❌ #open-apothecary-quiz-btn not found inside #apothecary-quiz-section.");
        exitCode = 1;
      }
      await page.click('#quiz-step-1 input[type="radio"]');
      await page.click("#quiz-next-btn-1");
      await new Promise((r) => setTimeout(r, 300));

      await page.click('#quiz-step-2 input[type="radio"]');
      await page.click("#quiz-next-btn");
      await new Promise((r) => setTimeout(r, 300));

      await page.click('#quiz-step-3 input[type="radio"]');
      await page.click("#quiz-submit-btn");
      await page.waitForSelector("#quiz-results-container .quiz-recommended-card", {
        visible: true,
        timeout: 5000
      });

      const recCard = await page.$(".quiz-recommended-card");
      if (recCard) {
        console.log(
          "✅ Apothecary Quiz completed 3-step flow and rendered prescription recommendation card."
        );
      } else {
        console.log("❌ Apothecary Quiz failed to render recommendation card.");
        exitCode = 1;
      }
    } else {
      console.log("❌ #apothecary-quiz-section element missing on shop.html.");
      exitCode = 1;
    }

    // Order status is an honest hand-off now (audit H-6): the page never
    // invents an order. A ?session_id= may prefill the reference, nothing is
    // auto-submitted, and a submitted lookup renders the contact route rather
    // than a fabricated timeline, item list, reorder button or packing slip.
    console.log("--- Testing Order Status honest hand-off (H-6) ---");
    await page.goto(`${url}/order-status.html?session_id=cs_test_sample12345`, {
      waitUntil: "networkidle2"
    });

    const fabricated = await page.evaluate(() => {
      /* eslint-disable no-undef */
      return {
        card: Boolean(document.querySelector(".order-status-card")),
        rows: document.querySelectorAll(".order-item-row").length,
        reorder: Boolean(document.getElementById("reorderPastOrderBtn")),
        slip: Boolean(document.getElementById("slipItemsTableBody")),
        verifyField: Boolean(document.getElementById("order-verify-input")),
        prefill: (document.getElementById("orderQueryInput") || {}).value || ""
      };
      /* eslint-enable no-undef */
    });
    if (!fabricated.card && fabricated.rows === 0 && !fabricated.reorder && !fabricated.slip) {
      console.log("✅ order-status.html renders no fabricated order for ?session_id=.");
    } else {
      console.log(
        "❌ order-status.html still renders fabricated order content: " + JSON.stringify(fabricated)
      );
      exitCode = 1;
    }
    if (!fabricated.verifyField) {
      console.log("✅ order-status.html no longer asks for an unverified email/zip.");
    } else {
      console.log("❌ order-status.html still carries the fake verification field.");
      exitCode = 1;
    }

    const lookupForm = await page.$("#orderStatusForm, form.order-status-form");
    if (lookupForm) {
      await page.evaluate(() => {
        /* eslint-disable no-undef */
        const input =
          document.getElementById("orderQueryInput") || document.getElementById("order-id-input");
        if (input) input.value = "YL-2026-0842";
        const form =
          document.getElementById("orderStatusForm") ||
          document.querySelector("form.order-status-form");
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        /* eslint-enable no-undef */
      });
      let handoff = null;
      try {
        handoff = await page.waitForSelector(".order-lookup-unavailable", {
          visible: true,
          timeout: 5000
        });
      } catch (e) {
        handoff = null;
      }
      const handoffHasContact = handoff
        ? await page.evaluate((el) => /mailto:|contact\.html/.test(el.innerHTML), handoff)
        : false;
      if (handoff && handoffHasContact) {
        console.log(
          "✅ Submitted lookup renders the contact hand-off with a way to reach the shop."
        );
      } else {
        console.log("❌ Submitted lookup did not render the contact hand-off.");
        exitCode = 1;
      }
    } else {
      console.log("❌ order-status.html lookup form not found.");
      exitCode = 1;
    }

    // 9. Test Global Search Suite (2026 SOTA Spotlight Modal, Multi-Domain, Chips, Shortcuts, 1-Click Cart, ARIA Traversal)
    console.log("--- Testing Global Search Suite (2026 SOTA) ---");

    // 9.1 Multi-Viewport Header Search Trigger & Dialog Lifecycle
    console.log("  -- 9.1 Header Search Trigger across Desktop, Tablet, and Mobile --");
    const vpSearchTriggerResults = await Promise.all(
      testViewports.map(async (vp) => {
        const vpPage = await browser.newPage();
        try {
          await vpPage.setViewport({ width: vp.width, height: vp.height });
          await vpPage.goto(`${url}/index.html`, { waitUntil: "networkidle2" });

          const searchBtn = await vpPage.$("#globalSearchTrigger");
          if (!searchBtn) {
            return {
              vp,
              error: `#globalSearchTrigger button missing on index.html (${vp.name} viewport).`
            };
          }

          await vpPage.click("#globalSearchTrigger");
          await vpPage.waitForSelector("#global-search-modal[open]", {
            visible: true,
            timeout: 5000
          });

          const modalState = await vpPage.evaluate(() => {
            /* eslint-disable no-undef */
            const modal = document.getElementById("global-search-modal");
            const input = document.getElementById("globalSearchInput");
            const trigger = document.getElementById("globalSearchTrigger");
            const chipsSection = document.getElementById("globalSearchChipsSection");
            return {
              isOpen: modal && modal.hasAttribute("open"),
              isInputFocused: document.activeElement === input,
              ariaExpanded: trigger && trigger.getAttribute("aria-expanded") === "true",
              chipsVisible: chipsSection && !chipsSection.hidden
            };
            /* eslint-enable no-undef */
          });

          if (
            !modalState.isOpen ||
            !modalState.isInputFocused ||
            !modalState.ariaExpanded ||
            !modalState.chipsVisible
          ) {
            return { vp, error: `modal open failure: ${JSON.stringify(modalState)}` };
          }

          // Close modal via close button
          await vpPage.click("#globalSearchCloseBtn");
          await vpPage.waitForFunction(
            // eslint-disable-next-line no-undef
            () => !document.getElementById("global-search-modal").hasAttribute("open"),
            { timeout: 5000 }
          );

          const closedAria = await vpPage.$eval("#globalSearchTrigger", (el) =>
            el.getAttribute("aria-expanded")
          );
          if (closedAria !== "false") {
            return { vp, error: "aria-expanded not reset after closing modal." };
          }

          return { vp, ok: true };
        } catch (err) {
          return { vp, error: err.message };
        } finally {
          await vpPage.close();
        }
      })
    );

    for (const r of vpSearchTriggerResults) {
      if (r.ok) {
        console.log(
          `✅ ${r.vp.name} viewport (${r.vp.width}x${r.vp.height}): Header trigger opens search modal, focuses input, sets aria-expanded, and displays chips.`
        );
        console.log(
          `✅ ${r.vp.name} viewport: Modal closed via close button and aria-expanded reset to false.`
        );
      } else {
        console.log(`❌ ${r.vp.name} viewport: ${r.error}`);
        exitCode = 1;
      }
    }

    // 9.2 Keyboard Shortcuts (Cmd+K / Ctrl+K)
    console.log("  -- 9.2 Keyboard Shortcuts (Cmd+K / Ctrl+K) --");
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      const isMac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true
        })
      );
      /* eslint-enable no-undef */
    });
    await page.waitForSelector("#global-search-modal[open]", { visible: true, timeout: 5000 });
    const cmdKOpened = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const modal = document.getElementById("global-search-modal");
      return modal && modal.hasAttribute("open");
      /* eslint-enable no-undef */
    });
    if (cmdKOpened) {
      console.log("✅ Cmd+K / Ctrl+K keyboard shortcut opens search modal.");
    } else {
      console.log("❌ Cmd+K / Ctrl+K shortcut failed to open search modal.");
      exitCode = 1;
    }

    // Toggle closed with Cmd+K / Ctrl+K
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      const isMac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true
        })
      );
      /* eslint-enable no-undef */
    });
    await page.waitForFunction(
      // eslint-disable-next-line no-undef
      () => !document.getElementById("global-search-modal").hasAttribute("open"),
      { timeout: 5000 }
    );
    console.log("✅ Cmd+K / Ctrl+K keyboard shortcut toggles search modal closed.");

    // 9.3 Guarded Slash (/) Shortcut
    console.log("  -- 9.3 Guarded Slash (/) Shortcut --");
    // When body is focused, pressing / opens modal
    // eslint-disable-next-line no-undef
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press("Slash");
    await page.waitForSelector("#global-search-modal[open]", { visible: true, timeout: 5000 });
    console.log("✅ Unfocused '/' keypress opens search modal.");

    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      // eslint-disable-next-line no-undef
      () => !document.getElementById("global-search-modal").hasAttribute("open"),
      { timeout: 5000 }
    );

    // Focus an input and verify '/' does NOT open modal and enters '/' in input
    const footerEmail = await page.$("#footer_email");
    if (footerEmail) {
      await page.click("#footer_email");
      await page.keyboard.type("test/");
      const slashInInputModalClosed = await page.evaluate(() => {
        /* eslint-disable no-undef */
        const modal = document.getElementById("global-search-modal");
        const email = document.getElementById("footer_email");
        return (!modal || !modal.hasAttribute("open")) && email && email.value.includes("/");
        /* eslint-enable no-undef */
      });
      if (slashInInputModalClosed) {
        console.log("✅ Guarded '/' does not intercept typing inside form inputs.");
      } else {
        console.log("❌ Guarded '/' improperly intercepted typing inside input field.");
        exitCode = 1;
      }
      await page.$eval("#footer_email", (el) => {
        el.value = "";
      });
    } else {
      console.log("❌ #footer_email input not found -- '/' guard could not be exercised.");
      exitCode = 1;
    }

    // 9.4 Escape Key Closes Modal & Restores Focus
    console.log("  -- 9.4 Escape Key Closes Modal & Restores Focus --");
    await page.click("#globalSearchTrigger");
    await page.waitForSelector("#global-search-modal[open]", { visible: true, timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      // eslint-disable-next-line no-undef
      () => !document.getElementById("global-search-modal").hasAttribute("open"),
      { timeout: 5000 }
    );

    const focusRestored = await page.evaluate(() => {
      /* eslint-disable no-undef */
      return document.activeElement && document.activeElement.id === "globalSearchTrigger";
      /* eslint-enable no-undef */
    });
    if (focusRestored) {
      console.log("✅ Escape key closes search modal and restores focus to search trigger.");
    } else {
      console.log("❌ Escape key failed to restore focus to search trigger button.");
      exitCode = 1;
    }

    // 9.5 Popular Search Quick Chips & Clear Button
    console.log("  -- 9.5 Popular Search Quick Chips & Clear Button --");
    await page.click("#globalSearchTrigger");
    await page.waitForSelector("#global-search-modal[open]", { visible: true, timeout: 5000 });

    const chipCount = await page.$$eval(".search-chip", (chips) => chips.length);
    if (chipCount >= 5) {
      console.log(`✅ Popular search chips rendered in zero-state (${chipCount} chips).`);
    } else {
      console.log(`❌ Expected at least 5 popular search chips, found ${chipCount}.`);
      exitCode = 1;
    }

    // Click 'Bedtime & Sleep' (data-search-query="sleep") chip
    const sleepChip = await page.$('.search-chip[data-search-query="sleep"]');
    if (sleepChip) {
      await sleepChip.click();
      await page.waitForSelector("#globalSearchResultsList .search-result-item", {
        visible: true,
        timeout: 5000
      });

      const chipExecutionState = await page.evaluate(() => {
        /* eslint-disable no-undef */
        const input = document.getElementById("globalSearchInput");
        const chipsSection = document.getElementById("globalSearchChipsSection");
        const clearBtn = document.getElementById("globalSearchClearBtn");
        const items = document.querySelectorAll("#globalSearchResultsList .search-result-item");
        return {
          inputValue: input ? input.value : "",
          chipsHidden: chipsSection ? chipsSection.hidden : false,
          clearBtnVisible: clearBtn ? !clearBtn.hidden : false,
          itemCount: items.length
        };
        /* eslint-enable no-undef */
      });

      if (
        chipExecutionState.inputValue === "sleep" &&
        chipExecutionState.chipsHidden &&
        chipExecutionState.clearBtnVisible &&
        chipExecutionState.itemCount > 0
      ) {
        console.log(
          `✅ Clicking popular chip executes search for "${chipExecutionState.inputValue}" and renders ${chipExecutionState.itemCount} items.`
        );
      } else {
        console.log("❌ Popular search chip execution failed:", chipExecutionState);
        exitCode = 1;
      }

      // Test Clear Button
      await page.click("#globalSearchClearBtn");
      await new Promise((r) => setTimeout(r, 100));

      const clearedState = await page.evaluate(() => {
        /* eslint-disable no-undef */
        const input = document.getElementById("globalSearchInput");
        const chipsSection = document.getElementById("globalSearchChipsSection");
        const results = document.getElementById("globalSearchResultsList");
        return {
          inputEmpty: input && input.value === "",
          chipsRestored: chipsSection && !chipsSection.hidden,
          resultsEmpty: results && results.innerHTML.trim() === ""
        };
        /* eslint-enable no-undef */
      });

      if (clearedState.inputEmpty && clearedState.chipsRestored && clearedState.resultsEmpty) {
        console.log(
          "✅ Clear button resets input, clears results list, and restores popular chips."
        );
      } else {
        console.log("❌ Clear button failed to reset search state:", clearedState);
        exitCode = 1;
      }
    } else {
      console.log(
        '❌ Popular search chip .search-chip[data-search-query="sleep"] not found in the search modal.'
      );
      exitCode = 1;
    }

    // 9.6 Universal Cross-Content Search & Live Segmented Results
    console.log("  -- 9.6 Universal Cross-Content Search & Segmented Results --");
    await page.type("#globalSearchInput", "sleep");
    await new Promise((r) => setTimeout(r, 300)); // debounce wait
    await page.waitForSelector("#globalSearchResultsList .search-results-section", {
      visible: true,
      timeout: 5000
    });

    const segmentedResults = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const prodSec = document.getElementById("search-section-products-title");
      const jrnlSec = document.getElementById("search-section-journal-title");
      const evtSec = document.getElementById("search-section-events-title");
      const faqSec = document.getElementById("search-section-faq-title");
      const thumbs = document.querySelectorAll(".search-item-thumb");
      const prices = document.querySelectorAll(".search-item-price");
      const stockBadges = document.querySelectorAll(".stock-badge");
      const liveCount = document.getElementById("globalSearchResultCount");

      return {
        hasProducts: !!prodSec,
        hasJournal: !!jrnlSec,
        hasEvents: !!evtSec,
        hasFaq: !!faqSec,
        thumbsValid:
          thumbs.length > 0 &&
          Array.from(thumbs).every((img) => img.getAttribute("src") && img.getAttribute("alt")),
        pricesValid:
          prices.length > 0 && Array.from(prices).every((p) => p.textContent.includes("$")),
        stockBadgesValid: stockBadges.length > 0,
        liveStatusText: liveCount ? liveCount.textContent : ""
      };
      /* eslint-enable no-undef */
    });

    if (
      segmentedResults.hasProducts &&
      segmentedResults.thumbsValid &&
      segmentedResults.pricesValid &&
      segmentedResults.stockBadgesValid
    ) {
      console.log(
        `✅ Cross-content search rendered segmented results with thumbnails, prices, stock badges, and live status: "${segmentedResults.liveStatusText}".`
      );
    } else {
      console.log("❌ Segmented search results validation failed:", segmentedResults);
      exitCode = 1;
    }

    // 9.7 Inline 1-Click [ + Add ] Button to Cart Flow
    console.log("  -- 9.7 Inline 1-Click [ + Add ] Button to Cart Flow --");
    const initialCartCount = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const badge = document.querySelector(".cart-count");
      return badge ? parseInt(badge.textContent.trim() || "0", 10) : 0;
      /* eslint-enable no-undef */
    });

    const searchAddBtn = await page.$("#globalSearchResultsList .search-add-btn");
    if (searchAddBtn) {
      await searchAddBtn.click();
      await new Promise((r) => setTimeout(r, 400));

      const cartAddState = await page.evaluate((initialCount) => {
        /* eslint-disable no-undef */
        const modal = document.getElementById("global-search-modal");
        const badge = document.querySelector(".cart-count");
        const currentCount = badge ? parseInt(badge.textContent.trim() || "0", 10) : 0;
        const addBtn = document.querySelector("#globalSearchResultsList .search-add-btn");
        return {
          modalStillOpen: modal && modal.hasAttribute("open"),
          badgeIncremented: currentCount > initialCount,
          buttonShowsAdded:
            addBtn &&
            (addBtn.classList.contains("is-added") || addBtn.textContent.includes("Added"))
        };
        /* eslint-enable no-undef */
      }, initialCartCount);

      if (cartAddState.modalStillOpen && cartAddState.badgeIncremented) {
        console.log(
          "✅ Inline 1-click '+ Add' button added product to cart, incremented header cart count, and kept search modal open."
        );
      } else {
        console.log("❌ Inline 1-click add to cart failed:", cartAddState);
        exitCode = 1;
      }
    } else {
      console.log("❌ Inline '+ Add' button not found in product search results.");
      exitCode = 1;
    }

    // 9.8 WAI-ARIA Combobox & Keyboard Arrow Navigation
    console.log("  -- 9.8 WAI-ARIA Combobox & Keyboard Arrow Navigation --");
    await page.$eval("#globalSearchInput", (el) => {
      el.value = "";
    });
    await page.type("#globalSearchInput", "salve");
    await new Promise((r) => setTimeout(r, 300));
    await page.waitForSelector("#globalSearchResultsList .search-result-item", {
      visible: true,
      timeout: 5000
    });

    // Press ArrowDown to select 1st item
    await page.keyboard.press("ArrowDown");
    const opt0State = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const input = document.getElementById("globalSearchInput");
      const opt0 = document.getElementById("search-opt-0");
      return {
        inputDescendant: input ? input.getAttribute("aria-activedescendant") : null,
        opt0Selected:
          opt0 &&
          opt0.classList.contains("is-selected") &&
          opt0.getAttribute("aria-selected") === "true"
      };
      /* eslint-enable no-undef */
    });

    if (opt0State.inputDescendant === "search-opt-0" && opt0State.opt0Selected) {
      console.log(
        "✅ ArrowDown key highlights first option (search-opt-0) and updates aria-activedescendant."
      );
    } else {
      console.log("❌ ArrowDown failed on search-opt-0:", opt0State);
      exitCode = 1;
    }

    // Press ArrowDown again to select 2nd item
    await page.keyboard.press("ArrowDown");
    const opt1State = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const input = document.getElementById("globalSearchInput");
      const opt1 = document.getElementById("search-opt-1");
      return {
        inputDescendant: input ? input.getAttribute("aria-activedescendant") : null,
        opt1Selected:
          opt1 &&
          opt1.classList.contains("is-selected") &&
          opt1.getAttribute("aria-selected") === "true"
      };
      /* eslint-enable no-undef */
    });

    if (opt1State.inputDescendant === "search-opt-1" && opt1State.opt1Selected) {
      console.log(
        "✅ ArrowDown key navigates to second option (search-opt-1) and updates aria-activedescendant."
      );
    } else {
      console.log("❌ ArrowDown failed on search-opt-1:", opt1State);
      exitCode = 1;
    }

    // Press ArrowUp to go back to 1st item
    await page.keyboard.press("ArrowUp");
    const optBackState = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const input = document.getElementById("globalSearchInput");
      const opt0 = document.getElementById("search-opt-0");
      return {
        inputDescendant: input ? input.getAttribute("aria-activedescendant") : null,
        opt0Selected: opt0 && opt0.classList.contains("is-selected")
      };
      /* eslint-enable no-undef */
    });

    if (optBackState.inputDescendant === "search-opt-0" && optBackState.opt0Selected) {
      console.log("✅ ArrowUp key returns to previous option (search-opt-0).");
    } else {
      console.log("❌ ArrowUp failed to return to previous option:", optBackState);
      exitCode = 1;
    }

    // Press Enter to navigate to selected option
    const expectedUrl = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const opt0 = document.getElementById("search-opt-0");
      return opt0 ? opt0.getAttribute("data-url") : null;
      /* eslint-enable no-undef */
    });

    if (expectedUrl) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }),
        page.keyboard.press("Enter")
      ]);
      const currentUrl = page.url();
      const targetSlug = expectedUrl.split("/").pop().replace(".html", "");
      if (
        currentUrl.includes(expectedUrl) ||
        (currentUrl.includes("shop.html") && currentUrl.includes(targetSlug))
      ) {
        console.log(`✅ Enter key executed selection and navigated to ${currentUrl}.`);
      } else {
        console.log(
          `❌ Enter key navigation mismatch (expected ${expectedUrl} or shop.html#${targetSlug}, got ${currentUrl}).`
        );
        exitCode = 1;
      }
    } else {
      console.log(
        "❌ #search-opt-0 carried no data-url -- there was no selected search result to activate."
      );
      exitCode = 1;
    }

    // 9.9 Strict 100% Monoline Vector SVGs Invariant (Zero Emojis)
    console.log("  -- 9.9 Monoline Vector SVGs Invariant --");
    await page.goto(`${url}/index.html`, { waitUntil: "networkidle2" });
    const emojiCheck = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const modal = document.getElementById("global-search-modal");
      if (!modal) return { found: false, count: 0 };
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      const html = modal.innerHTML;
      return {
        hasEmoji: emojiRegex.test(html),
        svgCount: modal.querySelectorAll("svg.yl-icon").length
      };
      /* eslint-enable no-undef */
    });

    if (!emojiCheck.hasEmoji && emojiCheck.svgCount >= 6) {
      console.log(
        `✅ Strict monoline SVG invariant verified: 0 emojis in modal, ${emojiCheck.svgCount} monoline SVGs rendered.`
      );
    } else {
      console.log("❌ Monoline SVG invariant violation in search modal:", emojiCheck);
      exitCode = 1;
    }
  } catch (e) {
    console.error("❌ Unexpected error in Puppeteer tests:", e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
      console.log("Closed local static server.");
    }
    process.exit(exitCode);
  }
})();
