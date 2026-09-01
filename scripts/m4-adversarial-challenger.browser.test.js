/**
 * @fileoverview Adversarial Empirical Stress Test Suite for Milestone 4 (Apothecary Journal & Content Hub)
 * Empirical Challenger Verification Suite covering:
 *
 * Dimension 1: Mini-Card 1-Click Add to Cart DOM & Responsive Reflow (Mobile 375x667, Tablet 768x1024, Desktop 1200x800)
 * Dimension 2: 1-Click Add to Cart Browser Integration, YLCart State Mutation, Loyalty Points, & Smooth Drawer Transition
 * Dimension 3: Edge Cases, Referential Alias Resolution, Fuzzing, & XSS Defenses
 * Dimension 4: Tag Filter Interactivity & URL Hash-based SPA Navigation (both enableJournal=true and enableJournal=false)
 * Dimension 5: Axe-Core WCAG 2.2 AA Audits on Rendered Journal List, Post Detail, & Active Cart Drawer
 * Dimension 6: Playwright Multi-Engine Cross-Browser Compatibility (Chromium, Firefox, WebKit)
 *
 * Run: node scripts/m4-adversarial-challenger.browser.test.js
 */

/* global window, document, getComputedStyle */

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");
// Required unguarded on purpose. This used to sit in a try/catch that set
// `playwright = null`, and Dimension 6 then logged "skipping" and passed --
// so the three-engine gate quietly reported green on any machine where the
// engines were not installed, which is every machine but the CI `browser`
// job (audit H-19). A missing engine is now a failure, not a skip.
const playwright = require("playwright");

const ROOT = path.resolve(__dirname, "..");

// Setup mock DOM environment before importing main.js
const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    setAttribute: (name, val) => attrs.set(name, String(val)),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    style: {},
    classList: {
      _list: new Set(),
      add: function (...names) {
        names.forEach((n) => this._list.add(n));
      },
      remove: function (...names) {
        names.forEach((n) => this._list.delete(n));
      },
      contains: function (name) {
        return this._list.has(name);
      }
    },
    innerHTML: "",
    textContent: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    insertBefore: (newNode) => {
      children.unshift(newNode);
      return newNode;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  location: {
    href: "https://yallternativeliving.com/journal.html",
    hash: "",
    search: "",
    pathname: "/journal.html",
    hostname: "yallternativeliving.com",
    origin: "https://yallternativeliving.com"
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const mainScript = require("../assets/js/main.js");

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
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml"
};

function createStaticServer(port) {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAdversarialStressSuite() {
  console.log("================================================================================");
  console.log("EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 4 (JOURNAL & CONTENT HUB)");
  console.log("================================================================================");

  let server;
  let browser;

  try {
    server = await createStaticServer(0);
    const PORT = server.address().port;
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 60000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // =========================================================================
    // DIMENSION 1: Mini-Card 1-Click Add to Cart DOM & Viewport Layout Reflow
    // =========================================================================
    console.log(
      "\n>>> DIMENSION 1: Mini-Card DOM & Responsive Viewport Layout (Mobile/Tablet/Desktop)"
    );

    const viewports = [
      { name: "Mobile (375x667)", width: 375, height: 667, isMobile: true },
      { name: "Tablet (768x1024)", width: 768, height: 1024, isMobile: false },
      { name: "Desktop (1200x800)", width: 1200, height: 800, isMobile: false }
    ];

    for (const vp of viewports) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.goto(`http://127.0.0.1:${PORT}/journal.html#post-magnesium-salve-benefits`, {
          waitUntil: "networkidle2"
        });
        await sleep(300);

        const cardMetrics = await page.evaluate(() => {
          const card = document.querySelector(".journal-featured-card");
          if (!card) return null;
          const rect = card.getBoundingClientRect();
          const btn = card.querySelector(".yl-add-item");
          const btnRect = btn ? btn.getBoundingClientRect() : null;
          const thumb = card.querySelector(".journal-featured-thumb");
          const thumbRect = thumb ? thumb.getBoundingClientRect() : null;
          const hasHScroll = document.documentElement.scrollWidth > window.innerWidth + 1;

          return {
            exists: true,
            cardWidth: rect.width,
            cardLeft: rect.left,
            cardRight: rect.right,
            windowWidth: window.innerWidth,
            hasHScroll,
            btnExists: !!btn,
            btnWidth: btnRect ? btnRect.width : 0,
            btnHeight: btnRect ? btnRect.height : 0,
            thumbExists: !!thumb,
            thumbWidth: thumbRect ? thumbRect.width : 0,
            thumbHeight: thumbRect ? thumbRect.height : 0
          };
        });

        assert(
          cardMetrics && cardMetrics.exists,
          `${vp.name}: .journal-featured-card renders in DOM`
        );
        assert(
          cardMetrics && !cardMetrics.hasHScroll,
          `${vp.name}: zero horizontal overflow (no horizontal scrollbar)`
        );
        assert(
          cardMetrics && cardMetrics.cardRight <= cardMetrics.windowWidth + 2,
          `${vp.name}: featured mini-card fits completely within viewport bounds`
        );
        assert(
          cardMetrics && cardMetrics.btnExists && cardMetrics.btnHeight >= 30,
          `${vp.name}: Add to Cart button meets accessible touch target size (height=${cardMetrics?.btnHeight}px >= 30px)`
        );
        assert(
          cardMetrics && cardMetrics.thumbExists && cardMetrics.thumbWidth > 0,
          `${vp.name}: Product thumbnail renders with positive dimension (${cardMetrics?.thumbWidth}x${cardMetrics?.thumbHeight}px)`
        );

        // Theme switching verification (Light Mode & Dark Mode)
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
        const lightBg = await page.evaluate(() => {
          const card = document.querySelector(".journal-featured-card");
          return card ? getComputedStyle(card).backgroundColor : "";
        });
        assert(
          lightBg && lightBg !== "rgba(0, 0, 0, 0)",
          `${vp.name}: renders distinct background in Light Mode (${lightBg})`
        );

        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        const darkBg = await page.evaluate(() => {
          const card = document.querySelector(".journal-featured-card");
          return card ? getComputedStyle(card).backgroundColor : "";
        });
        assert(
          darkBg && darkBg !== "rgba(0, 0, 0, 0)",
          `${vp.name}: renders distinct background in Dark Mode (${darkBg})`
        );
      } finally {
        await page.close();
      }
    }

    // =========================================================================
    // DIMENSION 2: 1-Click Add to Cart Integration, State, Points & Drawer
    // =========================================================================
    console.log(
      "\n>>> DIMENSION 2: 1-Click Add to Cart Integration, YLCart State, Loyalty Points & Drawer Reflow"
    );

    {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1200, height: 800 });
        await page.goto(`http://127.0.0.1:${PORT}/journal.html#post-magnesium-salve-benefits`, {
          waitUntil: "networkidle2"
        });
        await sleep(300);

        // Clear cart first to ensure sterile test state
        await page.evaluate(() => {
          if (window.YLCart && typeof window.YLCart.clear === "function") {
            window.YLCart.clear();
          }
        });

        const initialCartCount = await page.evaluate(() => window.YLCart.count());
        assert(initialCartCount === 0, "Initial cart count is 0 before adding item");

        // Scroll to the featured button and settle
        await page.evaluate(() => {
          const btn = document.querySelector(".journal-featured-card .yl-add-item");
          if (btn) btn.scrollIntoView({ block: "center", behavior: "instant" });
        });
        await sleep(200);

        // Record scroll position right before clicking Add to Cart
        const scrollBefore = await page.evaluate(() => window.scrollY);

        // Trigger Add to Cart via click() on the button element
        await page.evaluate(() => {
          const btn = document.querySelector(".journal-featured-card .yl-add-item");
          if (btn) btn.click();
        });
        await sleep(350);

        const afterClickState = await page.evaluate(() => {
          const items = window.YLCart.items();
          const count = window.YLCart.count();
          const drawer = document.getElementById("yl-cart-drawer");
          const isOpen = drawer
            ? drawer.hasAttribute("data-open") ||
              (typeof drawer.matches === "function" && drawer.matches(":popover-open"))
            : false;
          const pointsCountEl = document.getElementById("cart-points-count");
          const pointsEarned = pointsCountEl ? pointsCountEl.textContent.trim() : null;
          const scrollAfter = window.scrollY;

          return {
            count,
            items,
            isOpen,
            pointsEarned,
            scrollAfter
          };
        });

        assert(
          afterClickState.count === 1,
          `Clicking Add to Cart increments count to 1 (got: ${afterClickState.count})`
        );
        assert(
          afterClickState.items.length === 1 && afterClickState.items[0].id === "sleep-salve",
          `Item ID correctly resolved to 'sleep-salve' via alias 'magnesium-body-butter' (got: ${afterClickState.items[0]?.id})`
        );
        assert(
          afterClickState.items[0].price === 19.99,
          `Item price correctly parsed as 19.99 (got: ${afterClickState.items[0]?.price})`
        );
        assert(
          afterClickState.isOpen,
          "Cart drawer opened automatically after clicking Add to Cart"
        );
        assert(
          Math.abs(afterClickState.scrollAfter - scrollBefore) < 5,
          `Page scroll remained perfectly stable without jump (delta: ${Math.abs(afterClickState.scrollAfter - scrollBefore)}px)`
        );
        assert(
          afterClickState.pointsEarned === "19",
          `Alt-Points earned correctly computed for $19.99 salve (expected '19', got: '${afterClickState.pointsEarned}')`
        );

        // Close drawer and navigate to second post (#post-small-batch-difference)
        await page.evaluate(() => {
          if (window.YLCart && typeof window.YLCart.close === "function") {
            window.YLCart.close();
          }
          window.location.hash = "#post-small-batch-difference";
        });
        await sleep(350);

        // Scroll to featured card on second post
        await page.evaluate(() => {
          const btn = document.querySelector(".journal-featured-card .yl-add-item");
          if (btn) btn.scrollIntoView({ block: "center", behavior: "instant" });
        });
        await sleep(200);

        // Click Add to Cart for second featured product (pine-tar-salve -> frankincense-salve, $19.99)
        await page.evaluate(() => {
          const btn = document.querySelector(".journal-featured-card .yl-add-item");
          if (btn) btn.click();
        });
        await sleep(350);

        const multiItemState = await page.evaluate(() => {
          const items = window.YLCart.items();
          const count = window.YLCart.count();
          const pointsCountEl = document.getElementById("cart-points-count");
          const pointsEarned = pointsCountEl ? pointsCountEl.textContent.trim() : null;
          const subtotalText = document.querySelector(".yl-cart-subtotal-val")?.textContent?.trim();

          return {
            count,
            itemsCount: items.length,
            itemIds: items.map((i) => i.id),
            pointsEarned,
            subtotalText
          };
        });

        assert(multiItemState.count === 2, `Cart count is now 2 (got: ${multiItemState.count})`);
        assert(
          multiItemState.itemIds.includes("sleep-salve") &&
            multiItemState.itemIds.includes("frankincense-salve"),
          `Cart contains both resolved items ['sleep-salve', 'frankincense-salve'] (got: ${JSON.stringify(multiItemState.itemIds)})`
        );
        assert(
          multiItemState.pointsEarned === "39",
          `Total cart subtotal ($39.98) accurately earns 39 Alt-Points (got: '${multiItemState.pointsEarned}')`
        );

        // Rapid multi-click stress testing: click Add button 5 times rapidly
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => {
            const btn = document.querySelector(".journal-featured-card .yl-add-item");
            if (btn) btn.click();
          });
        }
        await sleep(300);

        const rapidClickCount = await page.evaluate(() => window.YLCart.count());
        assert(
          rapidClickCount === 7,
          `Rapid multi-clicking handled deterministically without loss (count: ${rapidClickCount} == 7)`
        );
      } finally {
        await page.close();
      }
    }

    // =========================================================================
    // DIMENSION 3: Edge Cases, Referential Resolution, Fuzzing & XSS Defenses
    // =========================================================================
    console.log("\n>>> DIMENSION 3: Referential Resolution, Fuzzing & XSS Defenses");

    // Unit level testing of exported helpers
    const {
      findFeaturedProduct,
      getReadingTime,
      renderJournalTagsHtml,
      renderFeaturedProductCardHtml
    } = mainScript;

    // 1. Referential product resolution
    assert(typeof findFeaturedProduct === "function", "findFeaturedProduct helper is exported");

    // Inject mock products catalog into window.YL_PRODUCTS
    global.window.YL_PRODUCTS = {
      products: [
        {
          id: "sleep-salve",
          name: "Sleep Salve (2oz)",
          price: 19.99,
          category: "salves",
          image: "assets/img/sleep.jpg"
        },
        {
          id: "frankincense-salve",
          name: "Frankincense Salve",
          price: 19.99,
          category: "salves",
          image: "assets/img/frank.jpg"
        },
        {
          id: "shea-butter",
          name: "Whipped Shea Butter",
          price: 16.0,
          category: "body",
          image: "assets/img/shea.jpg"
        }
      ]
    };

    // Direct resolution
    const directProd = findFeaturedProduct("sleep-salve");
    assert(
      directProd && directProd.id === "sleep-salve",
      "findFeaturedProduct resolves exact product ID"
    );

    // Alias resolution
    const alias1 = findFeaturedProduct("magnesium-body-butter");
    assert(
      alias1 && alias1.id === "sleep-salve",
      "findFeaturedProduct resolves alias 'magnesium-body-butter' -> 'sleep-salve'"
    );

    const alias2 = findFeaturedProduct("pine-tar-salve");
    assert(
      alias2 && alias2.id === "frankincense-salve",
      "findFeaturedProduct resolves alias 'pine-tar-salve' -> 'frankincense-salve'"
    );

    const alias3 = findFeaturedProduct("lavender-butter");
    assert(
      alias3 && alias3.id === "shea-butter",
      "findFeaturedProduct resolves alias 'lavender-butter' -> 'shea-butter'"
    );

    // Fuzz invalid / missing product IDs
    assert(findFeaturedProduct(null) === null, "findFeaturedProduct(null) returns null");
    assert(findFeaturedProduct(undefined) === null, "findFeaturedProduct(undefined) returns null");
    assert(findFeaturedProduct("") === null, "findFeaturedProduct('') returns null");
    assert(
      findFeaturedProduct("completely-non-existent-product-999") === null,
      "findFeaturedProduct(nonExistent) returns null"
    );

    // 2. Reading time calculation
    assert(typeof getReadingTime === "function", "getReadingTime helper is exported");
    assert(
      getReadingTime(null) === "1 min read",
      "getReadingTime(null) returns fallback '1 min read'"
    );
    assert(getReadingTime({}) === "1 min read", "getReadingTime({}) returns fallback '1 min read'");
    assert(
      getReadingTime({ readingTime: "7 min read" }) === "7 min read",
      "getReadingTime honors explicit readingTime property"
    );

    const postWithWords = {
      content: Array(600).fill("botanical").join(" "),
      excerpt: "Short excerpt"
    };
    assert(
      getReadingTime(postWithWords) === "4 min read",
      "getReadingTime calculates dynamic reading time from word count (600 words -> ~4 min)"
    );

    const postWithHtml = {
      content: "<div>" + Array(400).fill("<p>herbal</p>").join(" ") + "</div>"
    };
    assert(
      getReadingTime(postWithHtml) === "2 min read",
      "getReadingTime strips HTML tags before counting words (400 words -> 2 min)"
    );

    // 3. Topical tags rendering & XSS defense
    assert(typeof renderJournalTagsHtml === "function", "renderJournalTagsHtml helper is exported");
    assert(renderJournalTagsHtml(null) === "", "renderJournalTagsHtml(null) returns empty string");
    assert(renderJournalTagsHtml([]) === "", "renderJournalTagsHtml([]) returns empty string");

    const xssTags = [
      '<script>alert("xss")</script>',
      '"><img src=x onerror=alert(1)>',
      "Normal Tag"
    ];
    const tagsHtml = renderJournalTagsHtml(xssTags);
    assert(!tagsHtml.includes("<script>"), "renderJournalTagsHtml escapes <script> tag");
    assert(
      tagsHtml.includes("&quot;&gt;&lt;img"),
      "renderJournalTagsHtml encodes quotes and angle brackets preventing attribute breakout"
    );
    assert(
      tagsHtml.includes("&lt;script&gt;"),
      "renderJournalTagsHtml encodes HTML entities properly"
    );

    // 4. Featured product card rendering & non-existent safety
    assert(
      typeof renderFeaturedProductCardHtml === "function",
      "renderFeaturedProductCardHtml helper is exported"
    );
    assert(
      renderFeaturedProductCardHtml("non-existent-id") === "",
      "renderFeaturedProductCardHtml returns '' for unresolvable ID"
    );

    // =========================================================================
    // DIMENSION 4: Tag Filter Interactivity & URL Hash-based Navigation
    // =========================================================================
    console.log("\n>>> DIMENSION 4: Tag Filter Interactivity & SPA Hash Navigation");

    // Test 1: Default state (enableJournal=false -> Coming Soon)
    {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle2" });
        await sleep(300);

        const comingSoonRendered = await page.evaluate(() => {
          const h2 = document.querySelector("#journalApp h2");
          return h2 ? h2.textContent.includes("Journal Coming Soon") : false;
        });
        assert(
          comingSoonRendered,
          "When enableJournal is false, journalApp displays 'Journal Coming Soon' notice"
        );
      } finally {
        await page.close();
      }
    }

    // Test 2: Active Journal State (enableJournal=true intercept via Object.defineProperty)
    {
      const page = await browser.newPage();
      try {
        await page.evaluateOnNewDocument(() => {
          let _val = null;
          Object.defineProperty(window, "YL_CONTENT", {
            get: () => _val,
            set: (v) => {
              if (v && v.site) v.site.enableJournal = true;
              _val = v;
            },
            configurable: true
          });
        });

        await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle2" });
        await sleep(300);

        // Verify active list view rendered cards
        const activeCards = await page.evaluate(
          () => document.querySelectorAll("#journalApp article.card").length
        );
        assert(activeCards >= 2, `Active journal list view displays ${activeCards} post cards`);

        // Click first topical tag button on first card
        const tagText = await page.evaluate(() => {
          const firstTag = document.querySelector("#journalApp .journal-tag");
          if (!firstTag) return null;
          const t = firstTag.getAttribute("data-tag");
          firstTag.click();
          return t;
        });
        await sleep(250);

        const filterBanner = await page.evaluate(() => {
          const banner = document.querySelector(".journal-filter-banner");
          const clearBtn = document.getElementById("journalClearFilter");
          return {
            exists: !!banner,
            bannerText: banner ? banner.textContent : "",
            clearBtnExists: !!clearBtn
          };
        });

        assert(filterBanner.exists, `Clicking tag '${tagText}' activates .journal-filter-banner`);
        assert(filterBanner.clearBtnExists, "Filter banner provides 'Clear Filter ✕' button");

        // Clear filter
        await page.evaluate(() => {
          const btn = document.getElementById("journalClearFilter");
          if (btn) btn.click();
        });
        await sleep(200);

        const clearedBanner = await page.evaluate(() =>
          document.querySelector(".journal-filter-banner")
        );
        assert(clearedBanner === null, "Clicking 'Clear Filter' successfully clears tag filter");

        // Navigate to post via card title link
        await page.evaluate(() => {
          const link = document.querySelector(
            '#journalApp article.card h3 a[href="#post-magnesium-salve-benefits"]'
          );
          if (link) link.click();
        });
        await sleep(300);

        const isDetailView = await page.evaluate(() => {
          const detail = document.querySelector(".journal-detail");
          const backBtn = document.getElementById("journalBackBtn");
          return !!detail && !!backBtn;
        });
        assert(
          isDetailView,
          "Hash navigation to '#post-magnesium-salve-benefits' renders .journal-detail view"
        );

        // Click Back button
        await page.evaluate(() => {
          const back = document.getElementById("journalBackBtn");
          if (back) back.click();
        });
        await sleep(300);

        const backToList = await page.evaluate(
          () => document.querySelectorAll("#journalApp article.card").length > 0
        );
        assert(backToList, "Clicking '← Back to Journal' returns to full post listing");
      } finally {
        await page.close();
      }
    }

    // =========================================================================
    // DIMENSION 5: Axe-Core WCAG 2.2 AA Audit on Journal Views & Open Drawer
    // =========================================================================
    console.log(
      "\n>>> DIMENSION 5: Axe-Core WCAG 2.2 AA Audit on Journal List, Post Detail & Open Cart"
    );

    const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
    const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

    {
      const page = await browser.newPage();
      try {
        // 1. Audit List View (with enableJournal enabled)
        await page.evaluateOnNewDocument(() => {
          let _val = null;
          Object.defineProperty(window, "YL_CONTENT", {
            get: () => _val,
            set: (v) => {
              if (v && v.site) v.site.enableJournal = true;
              _val = v;
            },
            configurable: true
          });
        });
        await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle2" });
        await sleep(300);

        await page.evaluate(axeSource);
        const listAxeResult = await page.evaluate(async (tags) => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, { runOnly: { type: "tag", values: tags } });
        }, AXE_TAGS);

        assert(
          listAxeResult.violations.length === 0,
          `Axe-core WCAG 2.2 AA on journal.html (List View): 0 violations (found: ${listAxeResult.violations.length})`
        );
        if (listAxeResult.violations.length > 0) {
          listAxeResult.violations.forEach((v) =>
            console.error(`    [Axe Violation] ${v.id}: ${v.help}`)
          );
        }

        // 2. Audit Detail View with Featured Product Card & Open Cart Drawer
        await page.goto(`http://127.0.0.1:${PORT}/journal.html#post-magnesium-salve-benefits`, {
          waitUntil: "networkidle2"
        });
        await page.evaluate(() => {
          const btn = document.querySelector(".journal-featured-card .yl-add-item");
          if (btn) btn.click();
        });
        await sleep(400);

        await page.evaluate(axeSource);
        const detailAxeResult = await page.evaluate(async (tags) => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, { runOnly: { type: "tag", values: tags } });
        }, AXE_TAGS);

        assert(
          detailAxeResult.violations.length === 0,
          `Axe-core WCAG 2.2 AA on journal.html (Detail View + Open Drawer): 0 violations (found: ${detailAxeResult.violations.length})`
        );
        if (detailAxeResult.violations.length > 0) {
          detailAxeResult.violations.forEach((v) =>
            console.error(`    [Axe Violation] ${v.id}: ${v.help}`)
          );
        }
      } finally {
        await page.close();
      }
    }

    // =========================================================================
    // DIMENSION 6: Playwright Multi-Engine Cross-Browser Compatibility
    // =========================================================================
    console.log("\n>>> DIMENSION 6: Playwright Cross-Browser Testing (Chromium, Firefox, WebKit)");

    {
      const engines = [
        { name: "Chromium", type: playwright.chromium },
        { name: "Firefox", type: playwright.firefox },
        { name: "WebKit", type: playwright.webkit }
      ];

      for (const engine of engines) {
        let pwBrowser;
        try {
          pwBrowser = await engine.type.launch({ headless: true });
          const context = await pwBrowser.newContext({ viewport: { width: 1280, height: 800 } });
          const page = await context.newPage();

          await page.goto(`http://127.0.0.1:${PORT}/journal.html#post-magnesium-salve-benefits`, {
            waitUntil: "domcontentloaded"
          });
          await sleep(500);

          const cardRendered = await page.evaluate(() => {
            const card = document.querySelector(".journal-featured-card");
            const btn = document.querySelector(".journal-featured-card .yl-add-item");
            return !!card && !!btn;
          });

          assert(
            cardRendered,
            `${engine.name}: journal post and featured mini-card render cleanly`
          );

          // Click Add to Cart in Playwright
          await page.evaluate(() => {
            const btn = document.querySelector(".journal-featured-card .yl-add-item");
            if (btn) btn.click();
          });
          await sleep(500);

          const pwCartCount = await page.evaluate(() => window.YLCart.count());
          assert(
            pwCartCount >= 1,
            `${engine.name}: 1-click Add to Cart triggers YLCart state mutation`
          );

          await pwBrowser.close();
        } catch (err) {
          assert(false, `${engine.name}: cross-browser execution`, err.message);
          if (pwBrowser) await pwBrowser.close();
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================================");
  console.log(`MILESTONE 4 ADVERSARIAL STRESS RESULTS: ${passed} passed, ${failed} failed.`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAdversarialStressSuite().catch((err) => {
    console.error("Adversarial Stress Suite crashed:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialStressSuite };
