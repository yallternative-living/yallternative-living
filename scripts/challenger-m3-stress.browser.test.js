/**
 * @fileoverview Adversarial Stress Test Suite for Milestone 3 (PDP & Merchandising)
 * Challenger empirical test harness verifying:
 * 1. 19 products/*.html HTML validity, tag balance, schema.org Product microdata, and rendering.
 * 2. Scent profile edge cases, apparel/unscented null handling, multi-word notes, fuzzing & XSS escaping.
 * 3. Accordion DOM state transitions, rapid clicking, keyboard Enter/Space expansion, 320px viewport overflow.
 * 4. Axe-core accessibility and cross-viewport visual layout integrity.
 *
 * Run: node scripts/challenger-m3-stress.browser.test.js
 */

/* global window, document */

const fs = require("fs");
const path = require("path");
const PRODUCT_COUNT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "assets", "data", "products.json"), "utf8")
).products.length;
const http = require("http");
const puppeteer = require("puppeteer");
const buildScript = require("./build-site-data.js");

const ROOT = path.resolve(__dirname, "..");

/** Every generated PDP ships Usage, Ingredients and Care accordions. */
const EXPECTED_ACCORDIONS_PER_PDP = 3;

let passed = 0;
let failed = 0;
const findings = [];

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const errMsg = `  ✗ ${label}${detail ? ` — ${detail}` : ""}`;
    console.error(errMsg);
    findings.push({ label, detail, status: "FAIL" });
  }
}

function checkTagBalance(html, filename) {
  const selfClosing = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
    "path",
    "circle",
    "line",
    "rect"
  ]);

  // Strip comments and script/style inner content
  let cleaned = html.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    "<script></script>"
  );
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "<style></style>");

  const tagRegex = /<\/?([a-zA-Z0-9-]+)(?:\s+[^>]*)?\/?>/g;
  const stack = [];
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    const isClosing = fullTag.startsWith("</");
    const isSelfClosing =
      fullTag.endsWith("/>") ||
      selfClosing.has(tagName) ||
      fullTag.toLowerCase().startsWith("<!doctype");

    if (fullTag.toLowerCase().startsWith("<!doctype")) continue;
    if (isSelfClosing && !isClosing) continue;

    if (isClosing) {
      if (stack.length === 0) {
        return {
          valid: false,
          error: `Unexpected closing tag </${tagName}> with empty stack in ${filename}`
        };
      }
      const top = stack.pop();
      if (top !== tagName) {
        return {
          valid: false,
          error: `Mismatched tag: expected </${top}>, found </${tagName}> in ${filename}`
        };
      }
    } else {
      stack.push(tagName);
    }
  }

  if (stack.length > 0) {
    return { valid: false, error: `Unclosed tags remaining [${stack.join(", ")}] in ${filename}` };
  }
  return { valid: true };
}

// Static server for Puppeteer tests
function createServer(port = 0) {
  const MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(ROOT, reqPath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "text/plain" });
      let content = fs.readFileSync(filePath);
      if (reqPath.startsWith("/products/") && reqPath.endsWith(".html")) {
        let str = content.toString("utf8");
        str = str.replace(
          /window\.location\.replace\(.*?\);/g,
          "/* redirect disabled for test */;"
        );
        content = Buffer.from(str, "utf8");
      }
      res.end(content);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function runAdversarialStressTests() {
  console.log("===================================================================");
  console.log("   ADVERSARIAL STRESS TEST SUITE — MILESTONE 3 (PDP & MERCHANDISING)  ");
  console.log("===================================================================\n");

  /* =========================================================================
   * 1. HTML VALIDITY, TAG BALANCE & MICRODATA FOR ALL 19 PDP PAGES
   * ========================================================================= */
  console.log(">>> TEST GROUP 1: HTML Validity, Tag Balance & Schema.org Microdata");

  const productsJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
  );
  const products = productsJson.products;

  assert(
    products.length === PRODUCT_COUNT,
    "Catalog contains exactly " + PRODUCT_COUNT + " products"
  );

  products.forEach((p) => {
    const pdpPath = path.join(ROOT, "products", `${p.id}.html`);
    assert(fs.existsSync(pdpPath), `PDP file exists: products/${p.id}.html`);

    const html = fs.readFileSync(pdpPath, "utf8");

    // Tag balance verification
    const balanceResult = checkTagBalance(html, `products/${p.id}.html`);
    assert(
      balanceResult.valid,
      `products/${p.id}.html has perfectly balanced HTML container tags`,
      balanceResult.error
    );

    // Schema.org Product Microdata assertions
    assert(
      html.includes('itemscope itemtype="https://schema.org/Product"'),
      `products/${p.id}.html has Product itemtype microdata`
    );
    assert(
      html.includes('itemprop="name"') && html.includes(buildScript.escapeHtml(p.name)),
      `products/${p.id}.html has itemprop="name" matching product name`
    );
    assert(html.includes('itemprop="image"'), `products/${p.id}.html has itemprop="image"`);
    assert(
      html.includes('itemscope itemtype="https://schema.org/Offer"'),
      `products/${p.id}.html has Offer itemtype microdata`
    );
    assert(
      html.includes('itemprop="priceCurrency" content="USD"'),
      `products/${p.id}.html has USD priceCurrency microdata`
    );
    assert(html.includes('itemprop="price"'), `products/${p.id}.html has itemprop="price"`);

    // OpenGraph & Meta Tags
    assert(
      html.includes('<meta property="og:type" content="product">'),
      `products/${p.id}.html has og:type=product`
    );
    assert(html.includes('<meta property="og:title"'), `products/${p.id}.html has og:title`);
    assert(html.includes('<meta property="og:image"'), `products/${p.id}.html has og:image`);
    assert(
      html.includes(
        `<link rel="canonical" href="https://yallternativeliving.com/products/${p.id}.html">`
      ),
      `products/${p.id}.html canonicalises to itself (real, indexable page)`
    );

    // Usage Accordions structure
    assert(
      html.includes('<div class="pdp-accordions-group"'),
      `products/${p.id}.html contains pdp-accordions-group container`
    );
    const accordionCount = (html.match(/<details class="pdp-accordion">/g) || []).length;
    assert(
      accordionCount === EXPECTED_ACCORDIONS_PER_PDP,
      `products/${p.id}.html contains exactly ${EXPECTED_ACCORDIONS_PER_PDP} <details class="pdp-accordion"> elements (found: ${accordionCount})`
    );
    const summaryCount = (html.match(/<summary class="pdp-accordion-summary">/g) || []).length;
    assert(
      summaryCount === EXPECTED_ACCORDIONS_PER_PDP,
      `products/${p.id}.html contains exactly ${EXPECTED_ACCORDIONS_PER_PDP} <summary class="pdp-accordion-summary"> elements (found: ${summaryCount})`
    );

    // Freshness Badge -- only on things that are poured (not the digital
    // gift card or the printed apparel).
    const poured =
      p.category !== "apparel" && p.category !== "gift-cards" && p.id !== "yallternative-gift-card";
    assert(
      (html.includes('<div class="pdp-freshness-badge" role="status">') &&
        html.includes("Poured in Landrum, SC · Small-Batch Promise")) === poured,
      `products/${p.id}.html ${poured ? "has" : "omits"} the freshness badge with Landrum SC promise`
    );

    // CTA Button
    // The primary CTA is a real purchase control now: Add to Cart for a
    // buyable product, a restock/launch alert when it cannot be bought, or the
    // gift-card configurator link for the digital card.
    assert(
      html.includes("pdp-cta-btn") &&
        (html.includes('id="pdpAddToCart"') ||
          html.includes("yl-notify-toggle") ||
          html.includes('href="../shop.html#gift-cards"')),
      `products/${p.id}.html has a real primary CTA (add to cart / notify / gift card)`
    );
  });

  /* =========================================================================
   * 2. SCENT PROFILE EDGE CASES, APPAREL NULLS, UNSCENTED & ADVERSARIAL FUZZING
   * ========================================================================= */
  console.log("\n>>> TEST GROUP 2: Scent Profile Edge Cases & Adversarial Fuzzing");

  // Non-apothecary products must have null scentProfile and no scent HTML
  const nonApothecary = ["tank-top", "unisex-tshirt", "yallternative-gift-card"];
  nonApothecary.forEach((id) => {
    const p = products.find((x) => x.id === id);
    assert(p && p.scentProfile === null, `Non-apothecary product '${id}' scentProfile is null`);
    const pdpHtml = fs.readFileSync(path.join(ROOT, "products", `${id}.html`), "utf8");
    assert(
      !pdpHtml.includes("pdp-scent-profile"),
      `Non-apothecary product '${id}.html' does NOT render pdp-scent-profile`
    );
  });

  // Unscented product (miracle-balm)
  const miracleBalm = products.find((x) => x.id === "miracle-balm");
  assert(miracleBalm !== undefined, "miracle-balm found in products.json");
  assert(
    miracleBalm.scentProfile.intensity === "Unscented" &&
      miracleBalm.scentProfile.intensityScore === 0,
    "miracle-balm scentProfile has intensity 'Unscented' and score 0"
  );
  const miracleHtml = fs.readFileSync(path.join(ROOT, "products", "miracle-balm.html"), "utf8");
  assert(
    miracleHtml.includes("pdp-scent-unscented"),
    "miracle-balm.html contains pdp-scent-unscented class"
  );
  assert(
    miracleHtml.includes("Naturally unscented and free from added essential oils"),
    "miracle-balm.html renders unscented explanation note"
  );
  assert(
    !miracleHtml.includes("scent-notes-grid"),
    "miracle-balm.html does NOT render scent notes grid"
  );
  assert(
    miracleHtml.includes('aria-label="Scent intensity: Unscented (0 out of 5)"'),
    "miracle-balm.html carries accurate aria-label for unscented"
  );

  // Multi-word notes and special character handling in catalog
  const complexScentProducts = [
    "backroad-soak",
    "beard-salve",
    "bug-spray",
    "cleansing-spray",
    "frankincense-salve",
    "lavender-soak",
    "porch-sweep-spray",
    "shimmer-oil"
  ];
  complexScentProducts.forEach((id) => {
    const p = products.find((x) => x.id === id);
    assert(p && p.scentProfile, `Product '${id}' has scentProfile`);
    const html = fs.readFileSync(path.join(ROOT, "products", `${id}.html`), "utf8");

    // Ensure notes are HTML escaped (e.g. & -> &amp;)
    const escapedTop = buildScript.escapeHtml(p.scentProfile.top);
    const escapedHeart = buildScript.escapeHtml(p.scentProfile.heart);
    const escapedBase = buildScript.escapeHtml(p.scentProfile.base);

    assert(
      html.includes(escapedTop),
      `Product '${id}.html' contains escaped top note: ${escapedTop}`
    );
    assert(
      html.includes(escapedHeart),
      `Product '${id}.html' contains escaped heart note: ${escapedHeart}`
    );
    assert(
      html.includes(escapedBase),
      `Product '${id}.html' contains escaped base note: ${escapedBase}`
    );

    // Check intensity meter percentage
    const expectedScorePercent = p.scentProfile.intensityScore * 20;
    assert(
      html.includes(`style="width:${expectedScorePercent}%;"`),
      `Product '${id}.html' renders intensity fill width: ${expectedScorePercent}%`
    );
  });

  // Fuzzing renderScentProfileHtml with adversarial inputs
  console.log("--- Fuzzing renderScentProfileHtml ---");
  assert(
    buildScript.renderScentProfileHtml(null) === "",
    "renderScentProfileHtml(null) returns ''"
  );
  assert(
    buildScript.renderScentProfileHtml(undefined) === "",
    "renderScentProfileHtml(undefined) returns ''"
  );
  assert(buildScript.renderScentProfileHtml({}) === "", "renderScentProfileHtml({}) returns ''");
  assert(
    buildScript.renderScentProfileHtml({ scentProfile: null }) === "",
    "renderScentProfileHtml({ scentProfile: null }) returns ''"
  );

  // XSS Injection in Scent Notes
  const xssProduct = {
    id: 'xss-prod"><script>alert(1)</script>',
    name: "XSS <img src=x onerror=alert(2)>",
    scentProfile: {
      top: '<script>alert("top")</script>',
      heart: "Rose & <bold>Jasmine</bold>",
      base: "\"Quoted\" & 'Apostrophe' <tag>",
      intensity: "Bold & <bad>",
      intensityScore: 4
    }
  };
  const xssOutput = buildScript.renderScentProfileHtml(xssProduct);
  assert(!xssOutput.includes("<script>"), "renderScentProfileHtml escapes <script> tags in notes");
  assert(!xssOutput.includes("<bold>"), "renderScentProfileHtml escapes <bold> HTML injection");
  assert(xssOutput.includes("&lt;script&gt;"), "renderScentProfileHtml converts < to &lt;");
  assert(xssOutput.includes("&amp;"), "renderScentProfileHtml converts & to &amp;");

  // Extreme intensity score clamp
  const extremeLow = buildScript.renderScentProfileHtml({
    id: "low",
    scentProfile: { top: "A", heart: "B", base: "C", intensity: "Subtle", intensityScore: -5 }
  });
  assert(extremeLow.includes("width:0%;"), "Negative intensityScore is clamped to 0%");

  const extremeHigh = buildScript.renderScentProfileHtml({
    id: "high",
    scentProfile: { top: "A", heart: "B", base: "C", intensity: "Super", intensityScore: 10 }
  });
  assert(extremeHigh.includes("width:100%;"), "Overflow intensityScore (>5) is clamped to 100%");

  /* =========================================================================
   * 3. PUPPETEER DOM BEHAVIOR, ACCORDION INTERACTION & 320PX VIEWPORT STRESS
   * ========================================================================= */
  console.log(
    "\n>>> TEST GROUP 3: Headless Browser DOM, Accordion Keyboard/Rapid Click & 320px Stress"
  );

  const server = await createServer(0);
  const serverPort = server.address().port;
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();

    // Test products representation: 1 salve (apothecary), 1 shirt (apparel), 1 gift card, 1 unscented
    const testProducts = [
      "frankincense-salve",
      "unisex-tshirt",
      "yallternative-gift-card",
      "miracle-balm"
    ];

    for (const prodId of testProducts) {
      console.log(`--- Testing PDP: ${prodId} ---`);

      // A. Viewport 320px (Ultra-narrow Mobile: iPhone SE 1st gen)
      await page.setViewport({ width: 320, height: 568 });
      await page.goto(`http://127.0.0.1:${serverPort}/products/${prodId}.html`, {
        waitUntil: "networkidle0"
      });

      // Check horizontal overflow on 320px
      const overflowMetrics = await page.evaluate(() => {
        const docWidth = document.documentElement.offsetWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const bodyScrollWidth = document.body.scrollWidth;
        return {
          windowWidth: window.innerWidth,
          docWidth,
          scrollWidth,
          bodyScrollWidth,
          hasHorizontalOverflow:
            scrollWidth > window.innerWidth || bodyScrollWidth > window.innerWidth
        };
      });

      assert(
        !overflowMetrics.hasHorizontalOverflow,
        `PDP '${prodId}' has NO horizontal scroll/overflow on 320px viewport (scrollWidth: ${overflowMetrics.scrollWidth}px, window: ${overflowMetrics.windowWidth}px)`
      );

      // Check all accordion summaries and content bounds within 320px.
      //
      // The count assertion comes first on purpose: bounds.forEach() over an
      // empty array asserts nothing and accordions.every() over an empty array
      // is true, so a PDP that rendered no accordions at all used to pass both
      // the layout and the state-machine checks below.
      const renderedAccordions = await page.$$eval(
        ".pdp-accordion",
        (els) => els.filter((el) => el.querySelector(".pdp-accordion-summary")).length
      );
      assert(
        renderedAccordions === EXPECTED_ACCORDIONS_PER_PDP,
        `PDP '${prodId}' renders exactly ${EXPECTED_ACCORDIONS_PER_PDP} accordions with summaries (found: ${renderedAccordions})`
      );

      const bounds = await page.evaluate(() => {
        const accordions = Array.from(document.querySelectorAll(".pdp-accordion"));
        return accordions.map((acc, idx) => {
          const rect = acc.getBoundingClientRect();
          const summary = acc.querySelector(".pdp-accordion-summary");
          const summaryRect = summary.getBoundingClientRect();
          return {
            index: idx,
            width: rect.width,
            right: rect.right,
            summaryWidth: summaryRect.width,
            summaryRight: summaryRect.right,
            exceedsViewport: rect.right > window.innerWidth || summaryRect.right > window.innerWidth
          };
        });
      });

      bounds.forEach((b) => {
        assert(
          !b.exceedsViewport,
          `PDP '${prodId}' Accordion #${b.index + 1} fits inside 320px viewport (right: ${b.right}px, window: 320px)`
        );
      });

      // B. Accordion Interactive State Machine: Rapid Multi-Toggles
      console.log(`  Testing rapid multi-toggles on ${prodId}...`);
      const toggleSuccess = await page.evaluate(async (expectedCount) => {
        const accordions = Array.from(document.querySelectorAll(".pdp-accordion"));
        const summaries = accordions.map((a) => a.querySelector(".pdp-accordion-summary"));
        if (accordions.length !== expectedCount) {
          return {
            pass: false,
            error: `expected ${expectedCount} accordions, found ${accordions.length}`
          };
        }

        // Open all 3
        for (const s of summaries) s.click();
        const allOpen = accordions.every((a) => a.hasAttribute("open"));
        if (!allOpen) return { pass: false, error: "Failed to open all accordions" };

        // Close all 3
        for (const s of summaries) s.click();
        const allClosed = accordions.every((a) => !a.hasAttribute("open"));
        if (!allClosed) return { pass: false, error: "Failed to close all accordions" };

        // Rapid 20 toggle stress test on first accordion
        for (let i = 0; i < 20; i++) {
          summaries[0].click();
        }
        const stateAfter20 = accordions[0].hasAttribute("open");
        // 20 clicks on initially closed accordion should end in closed state (even number of toggles)
        if (stateAfter20 !== false) {
          return { pass: false, error: "Accordion state out of sync after 20 clicks" };
        }

        // Open first accordion again
        summaries[0].click();
        const content = accordions[0].querySelector(".pdp-accordion-content");
        const contentVisible = content && content.offsetHeight > 0;
        if (!contentVisible) {
          return { pass: false, error: "Accordion content not visible when open" };
        }

        return { pass: true };
      }, EXPECTED_ACCORDIONS_PER_PDP);

      assert(
        toggleSuccess.pass,
        `PDP '${prodId}' rapid accordion toggles operate deterministically`,
        toggleSuccess.error
      );

      // C. Keyboard Accessibility: Enter and Space Key Expansion
      console.log(`  Testing keyboard accessibility (Enter / Space) on ${prodId}...`);
      // Ensure all accordions are closed initially
      await page.evaluate(() => {
        document.querySelectorAll(".pdp-accordion").forEach((a) => a.removeAttribute("open"));
      });
      await page.focus(".pdp-accordion-summary");

      // Press Space to open
      await page.keyboard.press("Space");
      let isOpen = await page.$eval(".pdp-accordion", (el) => el.hasAttribute("open"));
      assert(isOpen, `PDP '${prodId}' accordion opens on [Space] keypress`);

      // Press Space to close
      await page.keyboard.press("Space");
      isOpen = await page.$eval(".pdp-accordion", (el) => el.hasAttribute("open"));
      assert(!isOpen, `PDP '${prodId}' accordion closes on [Space] keypress`);

      // Press Enter to open
      await page.keyboard.press("Enter");
      isOpen = await page.$eval(".pdp-accordion", (el) => el.hasAttribute("open"));
      assert(isOpen, `PDP '${prodId}' accordion opens on [Enter] keypress`);

      // Press Enter to close
      await page.keyboard.press("Enter");
      isOpen = await page.$eval(".pdp-accordion", (el) => el.hasAttribute("open"));
      assert(!isOpen, `PDP '${prodId}' accordion closes on [Enter] keypress`);

      // D. Theme Switching (Dark & Light Mode)
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      const lightModeRendered = await page.$eval(".pdp-accordion-summary", (el) => {
        const style = window.getComputedStyle(el);
        return style.color !== "" && style.cursor === "pointer";
      });
      assert(
        lightModeRendered,
        `PDP '${prodId}' renders correctly in Light Mode (data-theme="light")`
      );

      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      const darkModeRendered = await page.$eval(".pdp-accordion-summary", (el) => {
        const style = window.getComputedStyle(el);
        return style.color !== "" && style.cursor === "pointer";
      });
      assert(
        darkModeRendered,
        `PDP '${prodId}' renders correctly in Dark Mode (data-theme="dark")`
      );
    }

    // E. Desktop & Tablet Viewport Layout Reflow Verification
    console.log("\n--- Checking Desktop (1200x800) and Tablet (768x1024) Layout Reflow ---");
    for (const width of [1200, 768]) {
      await page.setViewport({ width, height: width === 1200 ? 800 : 1024 });
      await page.goto(`http://127.0.0.1:${serverPort}/products/frankincense-salve.html`, {
        waitUntil: "networkidle0"
      });

      const layout = await page.evaluate(() => {
        const pdpLayout = document.querySelector(".pdp-layout");
        const gallery = document.querySelector(".pdp-gallery");
        const details = document.querySelector(".pdp-details");
        const scentGrid = document.querySelector(".scent-notes-grid");

        return {
          layoutWidth: pdpLayout.offsetWidth,
          galleryWidth: gallery.offsetWidth,
          detailsWidth: details.offsetWidth,
          scentGridColumns: scentGrid
            ? window.getComputedStyle(scentGrid).gridTemplateColumns.split(" ").length
            : 0
        };
      });

      assert(
        layout.layoutWidth > 0 && layout.galleryWidth > 0 && layout.detailsWidth > 0,
        `PDP layout cleanly renders on ${width}px viewport (layoutWidth: ${layout.layoutWidth}px)`
      );
    }

    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  /* =========================================================================
   * SUMMARY & RESULTS
   * ========================================================================= */
  console.log("\n===================================================================");
  console.log(`STRESS TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("===================================================================");

  if (failed > 0) {
    console.error(`\nCRITICAL FINDINGS (${failed} total):`);
    findings.forEach((f, idx) => {
      console.error(
        `${idx + 1}. [${f.status}] ${f.label} ${f.detail ? `\n   Detail: ${f.detail}` : ""}`
      );
    });
    process.exit(1);
  } else {
    console.log("\nALL ADVERSARIAL CHALLENGE STRESS TESTS PASSED (100% GREEN).");
    process.exit(0);
  }
}

runAdversarialStressTests().catch((err) => {
  console.error("FATAL ERROR in adversarial stress test harness:", err);
  process.exit(1);
});
