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
    for (let href of [...new Set(hrefs)]) {
      if (href.startsWith(url)) {
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
    if (brokenLinks.length > 0) {
      console.log(`❌ Found ${brokenLinks.length} broken links:`);
      brokenLinks.forEach((b) => console.log(b));
      exitCode = 1;
    } else {
      console.log("✅ No broken internal links found on homepage.");
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
    for (const vp of testViewports) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: "networkidle2" });
      const hasOverflow = await page.evaluate(
        // eslint-disable-next-line no-undef
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      if (!hasOverflow) {
        console.log(
          `✅ ${vp.name} viewport (${vp.width}x${vp.height}) layout renders without horizontal overflow.`
        );
      } else {
        console.log(
          `❌ ${vp.name} viewport (${vp.width}x${vp.height}) has horizontal scroll overflow.`
        );
        exitCode = 1;
      }
    }
    await page.setViewport({ width: 1200, height: 800 });

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
      const pointsText = await page
        .$eval("#cart-points-count", (el) => el.textContent.trim())
        .catch(() => null);
      const expectedPoints = Math.floor(itemPrice);
      if (pointsText && parseInt(pointsText, 10) === expectedPoints) {
        console.log(
          `✅ Cart drawer displays correct Alt-Points total (${pointsText} points for $${itemPrice}).`
        );
      } else {
        console.log(
          `❌ Cart drawer Alt-Points mismatch (expected ${expectedPoints}, got ${pointsText}).`
        );
        exitCode = 1;
      }
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
      }

      // Reset
      const resetBtn = await page.$('button[data-rating="all"]');
      if (resetBtn) {
        await resetBtn.click();
        await new Promise((r) => setTimeout(r, 200));
        const restoredCards = await page.$$(".review-card");
        if (restoredCards.length === initialCards.length) {
          console.log("✅ reviews.html reset button restored all review cards.");
        }
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

    console.log("--- Testing Self-Service Order Status & Packing Slip (R6) ---");
    await page.goto(`${url}/order-status.html?session_id=cs_test_sample12345`, {
      waitUntil: "networkidle2"
    });

    const statusCard = await page.waitForSelector(".order-status-card", {
      visible: true,
      timeout: 5000
    });
    if (statusCard) {
      console.log(
        "✅ order-status.html auto-rendered progression timeline from ?session_id= query."
      );
    } else {
      console.log("❌ order-status.html failed to render progression timeline.");
      exitCode = 1;
    }

    const orderRows = await page.$$(".order-item-row");
    if (orderRows.length >= 2) {
      console.log(`✅ order-status.html rendered itemized breakdown (${orderRows.length} items).`);
    } else {
      console.log("❌ order-status.html failed to render past order items.");
      exitCode = 1;
    }

    // Verify Reorder Past Order button opens cart
    const reorderPastBtn = await page.$("#reorderPastOrderBtn");
    if (reorderPastBtn) {
      await page.evaluate((b) => b.click(), reorderPastBtn);
      let cartOpened = false;
      try {
        await page.waitForSelector("#yl-cart-drawer .yl-cart-line", {
          visible: true,
          timeout: 5000
        });
        cartOpened = true;
      } catch (e) {
        cartOpened = false;
      }
      if (cartOpened) {
        console.log("✅ Reorder Past Order button populated cart and opened drawer.");
      } else {
        console.log("❌ Reorder Past Order button failed to open cart drawer.");
        exitCode = 1;
      }
    }

    // Assert STRICT INVARIANT: Packing slip table contains ZERO dollar prices
    const slipTableText = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const tb = document.getElementById("slipItemsTableBody");
      return tb ? tb.textContent : "";
      /* eslint-enable no-undef */
    });
    if (!slipTableText.includes("$") && !/\$\d+\.\d{2}/.test(slipTableText)) {
      console.log(
        "✅ Printable Fulfillment Packing Slip table verified: STRICTLY ZERO dollar prices."
      );
    } else {
      console.log(
        "❌ Printable Packing Slip contains dollar prices, violating gift recipient privacy invariant!"
      );
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
