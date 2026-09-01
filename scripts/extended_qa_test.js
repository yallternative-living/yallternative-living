/**
 * @fileoverview Extended Empirical QA Test Suite for Y'allternative Living.
 *
 * Runs comprehensive Puppeteer tests covering:
 * - Wishlist drawer state handling (toggle, add, remove, badge count, empty state, localStorage persistence)
 * - Cart drawer money math, and that the withdrawn Alt-Points counter stays withdrawn
 * - Multi-page responsiveness & scroll overflow checks across 3 viewports (Desktop, Tablet, Mobile)
 * - Comprehensive internal link integrity crawling across all static HTML pages
 */

/* global document, window, localStorage */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function createStaticServer(port = 8083) {
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
  console.log("Starting Extended QA Empirical Tests...");
  let exitCode = 0;
  let browser;
  let localServer;
  const port = 8083;
  const url = `http://127.0.0.1:${port}`;

  const metrics = {
    pagesChecked: 0,
    linksTested: 0,
    brokenLinks: 0,
    wishlistTestsPassed: 0,
    altPointsTestsPassed: 0,
    overflowCheckPassed: 0,
    overflowCheckTotal: 0,
    regressionTestsPassed: 0,
    regressionTestsTotal: 0
  };

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

    // 1. Wishlist Drawer State Handling Verification
    console.log("\n--- Testing Wishlist Drawer State Handling ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });

    // Clear localStorage first
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle2" });

    // Check empty wishlist state
    const wishToggle = await page.$("#wishToggle");
    if (wishToggle) {
      await wishToggle.click();
      await new Promise((r) => setTimeout(r, 400));
      const isEmptyRendered = await page.evaluate(() => {
        const body = document.getElementById("wishBody");
        return body && body.querySelector(".wish-empty") !== null;
      });
      if (isEmptyRendered) {
        console.log("✅ Wishlist empty state correctly rendered on open.");
        metrics.wishlistTestsPassed++;
      } else {
        console.log("❌ Wishlist empty state failed to render.");
        exitCode = 1;
      }

      // Close wishlist drawer
      const wishClose = await page.$("#wishClose");
      if (wishClose) await wishClose.click();
      await new Promise((r) => setTimeout(r, 300));
    }

    // Toggle wishlist on first product card
    const firstWishBtn = await page.$(".card .wish-btn, .wish-btn[data-id]");
    if (firstWishBtn) {
      const productId = await page.evaluate((btn) => btn.getAttribute("data-id"), firstWishBtn);
      await firstWishBtn.click();
      await new Promise((r) => setTimeout(r, 300));

      // Verify badge count updated to '1'
      const badgeCount = await page.$eval("#wishCount", (el) => el.textContent.trim());
      if (badgeCount === "1") {
        console.log("✅ Wishlist count badge updated to 1 after adding item.");
        metrics.wishlistTestsPassed++;
      } else {
        console.log(
          `❌ Wishlist count badge failed to update (got '${badgeCount}', expected '1').`
        );
        exitCode = 1;
      }

      // Open drawer and check item rendered
      if (wishToggle) {
        await wishToggle.click();
        await new Promise((r) => setTimeout(r, 400));
        const wishItemRendered = await page.evaluate((id) => {
          const body = document.getElementById("wishBody");
          return body && body.querySelector(`.wish-remove[data-id="${id}"]`) !== null;
        }, productId);

        if (wishItemRendered) {
          console.log(`✅ Wishlist item (${productId}) rendered inside Wishlist Drawer.`);
          metrics.wishlistTestsPassed++;
        } else {
          console.log(`❌ Wishlist item (${productId}) missing inside Wishlist Drawer.`);
          exitCode = 1;
        }

        // Test removing item from within drawer
        const removeBtn = await page.$(`.wish-remove[data-id="${productId}"]`);
        if (removeBtn) {
          await removeBtn.click();
          await new Promise((r) => setTimeout(r, 300));
          const isNowEmpty = await page.evaluate(() => {
            const body = document.getElementById("wishBody");
            return body && body.querySelector(".wish-empty") !== null;
          });
          const updatedBadge = await page.$eval("#wishCount", (el) => el.textContent.trim());
          if (isNowEmpty && updatedBadge === "") {
            console.log(
              "✅ Item removed from Wishlist Drawer, empty state restored, badge cleared."
            );
            metrics.wishlistTestsPassed++;
          } else {
            console.log(`❌ Item removal from Wishlist Drawer failed (badge='${updatedBadge}').`);
            exitCode = 1;
          }
        }

        // Close drawer
        const wishClose = await page.$("#wishClose");
        if (wishClose) await wishClose.click();
        await new Promise((r) => setTimeout(r, 300));
      }

      // Test Persistence in localStorage across page reload
      await firstWishBtn.click(); // add back
      await new Promise((r) => setTimeout(r, 300));
      await page.reload({ waitUntil: "networkidle2" });
      const reloadedBadge = await page.$eval("#wishCount", (el) => el.textContent.trim());
      const lsRaw = await page.evaluate(() => localStorage.getItem("yl-wishlist"));
      if (reloadedBadge === "1" && lsRaw && lsRaw.includes(productId)) {
        console.log(
          `✅ Wishlist state persisted in localStorage ('${lsRaw}') and restored on page reload.`
        );
        metrics.wishlistTestsPassed++;
      } else {
        console.log(
          `❌ Wishlist persistence failed on reload (badge='${reloadedBadge}', localStorage='${lsRaw}').`
        );
        exitCode = 1;
      }
    } else {
      console.log("❌ Wishlist button not found on shop.html.");
      exitCode = 1;
    }

    // 2. Alt-Points Loyalty Calculator Verification
    console.log("\n--- Testing Alt-Points Calculator in Cart Drawer ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.removeItem("yl_cart"));
    await page.reload({ waitUntil: "networkidle2" });

    // Add multiple items to cart
    const addButtons = await page.$$(".card .yl-add-item");
    if (addButtons.length >= 2) {
      const price1 = await page.evaluate(
        (b) => parseFloat(b.getAttribute("data-item-price")),
        addButtons[0]
      );
      const price2 = await page.evaluate(
        (b) => parseFloat(b.getAttribute("data-item-price")),
        addButtons[1]
      );

      await page.evaluate((b) => b.click(), addButtons[0]);
      await new Promise((r) => setTimeout(r, 400));
      await page.evaluate((b) => b.click(), addButtons[1]);
      await new Promise((r) => setTimeout(r, 400));

      /* The drawer used to show an Alt-Points total, and this checked its
         arithmetic. Nothing ever credited those points and the redeem endpoint
         that spent them minted real Stripe credit for anyone who asked (audit
         C-1), so the counter is gone until a server-side ledger exists. The
         section now asserts what replaced it: the counter really is absent,
         and the money the drawer DOES quote is right. */
      const pointsCounterPresent = await page.$("#cart-points-count");
      if (pointsCounterPresent) {
        console.log(
          "❌ #cart-points-count is back in the cart drawer -- nothing credits Alt-Points."
        );
        exitCode = 1;
      } else {
        console.log("✅ Cart drawer shows no Alt-Points counter (feature is off end to end).");
        metrics.altPointsTestsPassed++;
      }

      const expectedSubtotal = Math.round((price1 + price2) * 100) / 100;
      const subtotalText = await page
        .$eval(".yl-cart-subtotal strong", (el) => el.textContent.trim())
        .catch(() => null);
      const subtotalValue = subtotalText ? parseFloat(subtotalText.replace(/[^0-9.]/g, "")) : NaN;
      if (Math.abs(subtotalValue - expectedSubtotal) < 0.005) {
        console.log(
          `✅ Cart drawer subtotal is correct for multiple items (${subtotalText} for $${price1}+$${price2}).`
        );
        metrics.altPointsTestsPassed++;
      } else {
        console.log(
          `❌ Cart drawer subtotal wrong: expected $${expectedSubtotal.toFixed(2)}, got ${subtotalText}.`
        );
        exitCode = 1;
      }
    } else {
      console.log("❌ Fewer than 2 Add to Cart buttons found on shop page.");
      exitCode = 1;
    }

    // 3. Multi-Page Viewport Responsiveness & Layout Overflow
    console.log("\n--- Testing Multi-Page Viewport Responsiveness & Scroll Overflow ---");
    const pagesToTest = [
      "index.html",
      "shop.html",
      "about.html",
      "contact.html",
      "events.html",
      "faq.html",
      "journal.html",
      "privacy.html",
      "terms.html",
      "policies.html",
      "404.html",
      "thank-you.html",
      "welcome.html"
    ];

    const viewports = [
      { name: "Desktop", width: 1200, height: 800 },
      { name: "Tablet", width: 768, height: 1024 },
      { name: "Mobile", width: 375, height: 667 }
    ];

    const pageTasks = pagesToTest.map(async (pageName) => {
      const pageInstance = await browser.newPage();
      try {
        const vpResults = [];
        for (const vp of viewports) {
          await pageInstance.setViewport({ width: vp.width, height: vp.height });
          await pageInstance.goto(`${url}/${pageName}`, { waitUntil: "networkidle2" });
          const hasOverflow = await pageInstance.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
          );
          vpResults.push({ vp, hasOverflow });
        }
        return { pageName, vpResults };
      } finally {
        await pageInstance.close();
      }
    });

    const allPageResults = await Promise.all(pageTasks);
    for (const res of allPageResults) {
      metrics.pagesChecked++;
      for (const r of res.vpResults) {
        metrics.overflowCheckTotal++;
        if (!r.hasOverflow) {
          metrics.overflowCheckPassed++;
        } else {
          console.log(
            `❌ ${res.pageName} on ${r.vp.name} (${r.vp.width}x${r.vp.height}) has horizontal scroll overflow!`
          );
          exitCode = 1;
        }
      }
    }
    console.log(
      `✅ Checked ${pagesToTest.length} pages across 3 viewports: ${metrics.overflowCheckPassed}/${metrics.overflowCheckTotal} viewport layout checks passed (0 overflow errors).`
    );

    // 4. Comprehensive Internal Link Integrity
    console.log("\n--- Testing Comprehensive Site-wide Link Integrity ---");
    let allDiscoveredHrefs = new Set();
    for (const pageName of pagesToTest) {
      await page.goto(`${url}/${pageName}`, { waitUntil: "networkidle2" });
      const links = await page.$$eval("a", (els) =>
        els.map((a) => a.href).filter((h) => h.startsWith("http"))
      );
      links.forEach((l) => allDiscoveredHrefs.add(l));
    }

    const internalHrefs = [...allDiscoveredHrefs].filter((h) => h.startsWith(url));

    /* A "0 broken links" pass is only meaningful if links were actually
       crawled. This loop used to report success on an empty set, so a page
       that rendered no navigation at all -- or a selector change that made
       $$eval return nothing -- read as a clean bill of health. The site
       header and footer alone carry well over twenty internal links. */
    const MIN_INTERNAL_LINKS = 20;
    if (internalHrefs.length < MIN_INTERNAL_LINKS) {
      console.log(
        `❌ Only ${internalHrefs.length} unique internal links discovered across ` +
          `${pagesToTest.length} pages (expected at least ${MIN_INTERNAL_LINKS}). ` +
          "The link-integrity check has nothing to verify."
      );
      exitCode = 1;
    }

    const linkCheckConcurrency = 5;
    const linkQueue = [...internalHrefs];
    const brokenLinksList = [];
    let linksTestedCount = 0;

    async function linkWorker() {
      const linkPage = await browser.newPage();
      try {
        while (linkQueue.length > 0) {
          const href = linkQueue.shift();
          linksTestedCount++;
          try {
            const res = await linkPage.goto(href, { waitUntil: "domcontentloaded" });
            if (res && res.status() >= 400) {
              brokenLinksList.push(`${href} (Status: ${res.status()})`);
            }
          } catch (e) {
            brokenLinksList.push(`${href} (Error: ${e.message})`);
          }
        }
      } finally {
        await linkPage.close();
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(linkCheckConcurrency, Math.max(1, internalHrefs.length)) },
        () => linkWorker()
      )
    );

    metrics.linksTested = linksTestedCount;
    metrics.brokenLinks = brokenLinksList.length;
    if (linksTestedCount !== internalHrefs.length) {
      console.log(
        `❌ Link workers visited ${linksTestedCount} of ${internalHrefs.length} discovered internal links.`
      );
      exitCode = 1;
    }
    if (brokenLinksList.length === 0) {
      console.log(
        `✅ All ${metrics.linksTested} unique internal links across site returned 200 OK.`
      );
    } else {
      console.log(`❌ Found ${brokenLinksList.length} broken links:`);
      brokenLinksList.forEach((b) => console.log(`   - ${b}`));
      exitCode = 1;
    }

    /* ==========================================================
       5-7. Regression tests for shipped shop.html bug fixes.
       ----------------------------------------------------------
       These three behaviors live inside delegated DOM event handlers in
       assets/js/main.js that are not exported to Node, so a real browser is
       the only place they can be exercised end to end.

       `check` fails LOUDLY: a missing element is a failure, not a skip. The
       older sections above guard interactions with `if (el)`, which quietly
       passes the whole block if the selector ever stops matching -- these
       sections deliberately do not.
       ========================================================== */
    function check(condition, label, detail) {
      if (condition) {
        console.log(`✅ ${label}`);
        metrics.regressionTestsPassed++;
      } else {
        console.log(`❌ ${label}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
        exitCode = 1;
      }
      metrics.regressionTestsTotal++;
    }

    // Snapshot of the shop grid's filter/search state, read fresh each time.
    const readShopState = () => ({
      cards: document.querySelectorAll("#shopGrid .card").length,
      noResults: !!document.querySelector(".yl-no-results"),
      activePill: (document.querySelector(".filter-pill.active") || {}).getAttribute
        ? document.querySelector(".filter-pill.active").getAttribute("data-filter")
        : null,
      search: (document.getElementById("shopSearch") || {}).value
    });

    /* ---------- 5. "Reset Filters & Search" restores the full grid ----------
       The zero-result panel's reset button looked for the All pill as
       `.cat-pill[data-category="all"]`, but the shop renders filter pills as
       `.filter-pill[data-filter="all"]` (see buildFilters). querySelector
       returned null, the `if (allPill)` guard swallowed it, and the button
       cleared the search box while leaving the category filter stuck -- so
       "Reset Filters & Search" reset the search only. */
    console.log("\n--- Testing Shop Reset Filters & Search ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle2" });

    const baselineShop = await page.evaluate(readShopState);
    check(baselineShop.cards > 0, "Shop grid renders product cards on load", baselineShop);
    check(baselineShop.activePill === "all", "Shop grid starts on the All filter", baselineShop);

    // Narrow to a category, then search something guaranteed to match nothing.
    const categoryApplied = await page.evaluate(() => {
      const pill = document.querySelector('.filter-pill[data-filter="salves"]');
      if (!pill) return false;
      pill.click();
      return true;
    });
    check(categoryApplied, "Shop exposes a 'salves' category pill to filter by");
    await new Promise((r) => setTimeout(r, 400));

    const filteredShop = await page.evaluate(readShopState);
    check(
      filteredShop.activePill === "salves" &&
        filteredShop.cards > 0 &&
        filteredShop.cards < baselineShop.cards,
      "Category filter narrows the grid to a strict subset",
      filteredShop
    );

    await page.evaluate(() => {
      const s = document.getElementById("shopSearch");
      s.value = "zzzzqqq-no-such-product";
      s.dispatchEvent(new Event("input"));
    });
    await new Promise((r) => setTimeout(r, 500));

    const emptyShop = await page.evaluate(readShopState);
    check(
      emptyShop.cards === 0 && emptyShop.noResults,
      "A no-match search shows the zero-result panel",
      emptyShop
    );

    const resetClicked = await page.evaluate(() => {
      const btn = document.getElementById("resetFiltersBtn");
      if (!btn) return false;
      btn.click();
      return true;
    });
    check(resetClicked, "Zero-result panel renders the Reset Filters & Search button");
    await new Promise((r) => setTimeout(r, 500));

    const resetShop = await page.evaluate(readShopState);
    // The load-bearing assertion: the CATEGORY has to come back to All. The
    // old selector cleared the search box but left the pill on "salves".
    check(
      resetShop.activePill === "all",
      "Reset Filters & Search reactivates the All pill",
      resetShop
    );
    check(resetShop.search === "", "Reset Filters & Search clears the search box", resetShop);
    check(
      resetShop.cards === baselineShop.cards && !resetShop.noResults,
      `Reset Filters & Search restores the full grid (${baselineShop.cards} cards)`,
      resetShop
    );

    /* ---------- 6. Lightbox opens on the full photo list ----------
       products.json splits photos into `image` (the primary) and `images`
       (the ALT shots only) -- the primary is NOT a member of `images`. Both
       lightbox entry points passed `images` alone, so the primary photo was
       missing from the lightbox entirely: the dot strip was one short, and
       clicking the default slide "enlarged" the first alt photo instead of
       the photo the shopper was actually looking at. Both paths now pass
       [p.image].concat(p.images). */
    console.log("\n--- Testing Lightbox Photo List (primary + alts) ---");

    // Fresh load: section 5 leaves the grid filtered, and if its reset ever
    // regresses the target card would simply not be in the DOM -- which would
    // report as a lightbox failure rather than a reset failure. Reload so this
    // section stands on its own.
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });

    // Pick a real multi-photo product straight out of the catalog the page
    // loaded, so this cannot drift out of sync with products.json.
    const photoFixture = await page.evaluate(() => {
      const products = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
      const p = products.find(
        (x) =>
          x.image && Array.isArray(x.images) && x.images.length > 1 && !x.images.includes(x.image)
      );
      return p ? { id: p.id, image: p.image, altCount: p.images.length } : null;
    });
    check(
      photoFixture !== null,
      "Catalog contains a product with a primary photo plus multiple alts",
      photoFixture
    );

    if (photoFixture) {
      const expectedDots = photoFixture.altCount + 1;
      const readLightbox = () => ({
        open: !!document.querySelector(".lightbox-modal[open]"),
        dots: document.querySelectorAll("#lightboxDots .lightbox-dot").length,
        src: (document.getElementById("lightboxImage") || {}).getAttribute
          ? document.getElementById("lightboxImage").getAttribute("src")
          : null
      });

      // 6a. Card-click path.
      const slideClicked = await page.evaluate((id) => {
        const slide = document.querySelector(`.card[data-id="${id}"] .card-gallery-slide`);
        if (!slide) return false;
        slide.click();
        return true;
      }, photoFixture.id);
      check(slideClicked, `Product card ${photoFixture.id} renders a clickable gallery slide`);
      await new Promise((r) => setTimeout(r, 500));

      const cardLightbox = await page.evaluate(readLightbox);
      check(cardLightbox.open, "Card click opens the lightbox", cardLightbox);
      check(
        cardLightbox.dots === expectedDots,
        `Card-click lightbox shows 1 primary + ${photoFixture.altCount} alt dots (${expectedDots})`,
        cardLightbox
      );
      check(
        cardLightbox.src === photoFixture.image,
        "Card-click lightbox displays the PRIMARY photo, not the first alt",
        { got: cardLightbox.src, expected: photoFixture.image }
      );

      /* 6b. Deep-link path (#<product-id> on load) -- a separate call site in
         main.js with the same bug, so it needs its own assertion.

         The about:blank hop is load-bearing. Puppeteer treats a goto that
         differs from the current URL only by its fragment as a same-document
         navigation: the page does NOT reload and main.js's deep-link block
         (which runs once at script evaluation) never re-executes. Without the
         hop this check just re-observed the lightbox 6a had left open and
         passed no matter what the deep-link path did -- verified by asserting
         a marker set on the old document survives a hash-only goto. */
      await page.goto("about:blank");
      await page.goto(`${url}/shop.html#${photoFixture.id}`, { waitUntil: "networkidle2" });
      // main.js defers the deep-link open by 400ms; wait past that.
      await new Promise((r) => setTimeout(r, 1000));

      const deepLightbox = await page.evaluate(readLightbox);
      check(deepLightbox.open, "Deep link opens the lightbox on load", deepLightbox);
      check(
        deepLightbox.dots === expectedDots,
        `Deep-linked lightbox shows all ${expectedDots} photos`,
        deepLightbox
      );
      check(
        deepLightbox.src === photoFixture.image,
        "Deep-linked lightbox displays the PRIMARY photo",
        { got: deepLightbox.src, expected: photoFixture.image }
      );
    }

    /* ---------- 7. Quiz Alt-Points badge honours loyalty config ----------
       The quiz result card hard-coded '✨ Earn N Alt-Points' with N =
       floor(price), ignoring getLoyaltyConfig() -- which every other badge on
       the site respects. Turning loyalty off left the quiz still advertising
       points, and a non-1 points-per-dollar rate (or a renamed programme) was
       silently wrong only on this one card. */
    console.log("\n--- Testing Quiz Alt-Points Badge Loyalty Config ---");

    // Drive the quiz to its result card. Overrides are applied to the live
    // window.YL_CONTENT before submitting, because getLoyaltyConfig() reads it
    // at render time; each run starts from a fresh page load so no override
    // leaks into the next case.
    async function runQuiz(configure) {
      await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
      if (configure) await page.evaluate(configure);
      await page.evaluate(() => document.getElementById("open-apothecary-quiz-btn").click());
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate(() => document.querySelectorAll(".quiz-next-step")[0].click());
      await new Promise((r) => setTimeout(r, 250));
      await page.evaluate(() => document.querySelectorAll(".quiz-next-step")[1].click());
      await new Promise((r) => setTimeout(r, 250));
      await page.evaluate(() => document.getElementById("quiz-submit-btn").click());
      await new Promise((r) => setTimeout(r, 700));
      return page.evaluate(() => {
        const c = document.getElementById("quiz-results-container");
        const badge = c ? c.querySelector(".alt-points-badge") : null;
        const priceMatch = c ? c.innerHTML.match(/\$([\d.]+)/) : null;
        return {
          hasCard: !!(c && c.querySelector(".quiz-recommended-card")),
          badgeText: badge ? badge.textContent.replace(/\s+/g, " ").trim() : null,
          points: c && c.querySelector(".pts-val") ? c.querySelector(".pts-val").textContent : null,
          price: priceMatch ? Number(priceMatch[1]) : null
        };
      });
    }

    const quizDefault = await runQuiz(null);
    check(quizDefault.hasCard, "Quiz renders a recommendation card", quizDefault);
    check(
      quizDefault.badgeText !== null && quizDefault.price !== null,
      "Quiz card shows an Alt-Points badge and a price by default",
      quizDefault
    );
    check(
      Number(quizDefault.points) === Math.floor(quizDefault.price),
      "Quiz badge uses the default 1 point per dollar",
      quizDefault
    );

    // Loyalty switched OFF: the badge must disappear entirely.
    const quizDisabled = await runQuiz(() => {
      window.YL_CONTENT.site.enableLoyaltyPoints = false;
    });
    check(
      quizDisabled.hasCard,
      "Quiz still renders its recommendation with loyalty disabled",
      quizDisabled
    );
    check(
      quizDisabled.badgeText === null,
      "Quiz omits the points badge when loyalty is disabled",
      quizDisabled
    );

    // Custom rate + renamed programme: the badge must follow the config.
    const quizCustom = await runQuiz(() => {
      window.YL_CONTENT.site.loyaltyPointsPerDollar = 5;
      window.YL_CONTENT.site.loyaltyPointsName = "Hex Points";
      window.YL_CONTENT.site.loyaltyBadgeEmoji = "🌙";
    });
    check(
      Number(quizCustom.points) === Math.floor(quizCustom.price * 5),
      "Quiz badge multiplies by the configured points-per-dollar rate",
      quizCustom
    );
    check(
      quizCustom.badgeText !== null && quizCustom.badgeText.includes("Hex Points"),
      "Quiz badge uses the configured programme name",
      quizCustom
    );
    check(
      quizCustom.badgeText !== null && quizCustom.badgeText.includes("🌙"),
      "Quiz badge uses the configured badge emoji",
      quizCustom
    );
    check(
      quizCustom.badgeText !== null && !quizCustom.badgeText.includes("Alt-Points"),
      "Quiz badge no longer hard-codes the Alt-Points name",
      quizCustom
    );

    /* Every counter printed in the summary below is also an assertion: a
       zero means the section it belongs to never ran, and a summary of zeroes
       used to print a PASSED verdict. */
    const zeroCounters = Object.entries(metrics).filter(
      ([name, value]) => name !== "brokenLinks" && value === 0
    );
    if (zeroCounters.length) {
      zeroCounters.forEach(([name]) =>
        console.log(`❌ Counter "${name}" is 0 -- that section of the suite did not run.`)
      );
      exitCode = 1;
    }

    console.log("\n==================================================");
    console.log("Extended QA Test Summary:");
    console.log(`- Pages Checked: ${metrics.pagesChecked}`);
    console.log(
      `- Viewport Layout Checks: ${metrics.overflowCheckPassed}/${metrics.overflowCheckTotal} PASSED`
    );
    console.log(
      `- Internal Links Checked: ${metrics.linksTested} (Broken: ${metrics.brokenLinks})`
    );
    console.log(`- Wishlist State Tests Passed: ${metrics.wishlistTestsPassed}`);
    console.log(`- Alt-Points Calculator Tests Passed: ${metrics.altPointsTestsPassed}`);
    console.log(
      `- Bug-Fix Regression Checks: ${metrics.regressionTestsPassed}/${metrics.regressionTestsTotal} PASSED` +
        " (reset-filters, lightbox photo list, quiz loyalty badge)"
    );
    console.log(`- Final Verdict: ${exitCode === 0 ? "PASSED" : "FAILED"}`);
    console.log("==================================================\n");
  } catch (e) {
    console.error("❌ Error running Extended QA Tests:", e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
      console.log("Closed static server.");
    }
    process.exit(exitCode);
  }
})();
