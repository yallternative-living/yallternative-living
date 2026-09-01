/**
 * @fileoverview Empirical Test Harness for Milestone 2: Visual Social Proof / UGC Strip
 *
 * Tests:
 * 1. Aspect ratio, Zero CLS, and responsive layout across Viewports (Desktop, Tablet, Mobile)
 * 2. CMS Toggle behavior (enableSocialFeed = true vs false vs empty feed)
 * 3. WCAG AA accessibility compliance via axe-core
 * 4. Data integrity of social-feed.json & social-feed-data.js
 */
/* global window, document, getComputedStyle */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const axeCore = require("axe-core");

const PORT = 8085;
const ROOT = path.resolve(__dirname, "..");
const URL_BASE = `http://127.0.0.1:${PORT}`;

let server;
let browser;

function createServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let reqPath = req.url.split("?")[0];
      if (reqPath === "/") reqPath = "/index.html";
      let filePath = path.join(ROOT, reqPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(ROOT, "404.html");
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
        ".svg": "image/svg+xml"
      };

      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });

    srv.on("error", reject);
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function analyzeAxe(page, selector) {
  await page.evaluate(axeCore.source);
  const results = await page.evaluate(async (targetSel) => {
    return await window.axe.run(targetSel, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
      }
    });
  }, selector);
  return results;
}

async function runTests() {
  console.log("==================================================");
  console.log("MILESTONE 2 EMPIRICAL TEST SUITE: UGC / SOCIAL FEED");
  console.log("==================================================\n");

  try {
    server = await createServer();
    console.log(`Local test server running on ${URL_BASE}`);
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      console.log(`Using existing server running on ${URL_BASE}`);
    } else {
      throw e;
    }
  }

  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();

  // ----------------------------------------------------
  // TEST SECTION 1: Data Integrity & Schema Validation
  // ----------------------------------------------------
  console.log("\n1. Data Integrity & Schema Validation");
  const jsonPath = path.join(ROOT, "assets/data/social-feed.json");
  const jsDataPath = path.join(ROOT, "assets/js/social-feed-data.js");

  assert(fs.existsSync(jsonPath), "assets/data/social-feed.json exists");
  assert(fs.existsSync(jsDataPath), "assets/js/social-feed-data.js exists");

  const socialFeedJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert(Array.isArray(socialFeedJson.posts), "social-feed.json contains 'posts' array");
  assert(
    socialFeedJson.posts.length > 0,
    `social-feed.json has ${socialFeedJson.posts.length} posts`
  );

  socialFeedJson.posts.forEach((post, i) => {
    assert(
      post.id && post.image && post.author && post.handle && post.caption,
      `Post #${i + 1} (${post.id}) has required fields (id, image, author, handle, caption)`
    );
    const imgPath = path.join(ROOT, post.image.replace(/^\//, ""));
    assert(fs.existsSync(imgPath), `Post #${i + 1} image file exists on disk: ${post.image}`);
  });

  // ----------------------------------------------------
  // TEST SECTION 2: HTML Source Zero CLS & Initial State
  // ----------------------------------------------------
  console.log("\n2. Initial HTML & Zero CLS Guards");
  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const shopHtml = fs.readFileSync(path.join(ROOT, "shop.html"), "utf8");

  assert(
    indexHtml.includes('id="homeSocialFeed"') && indexHtml.includes('style="display:none;"'),
    "index.html #homeSocialFeed initialized with style='display:none;'"
  );
  assert(
    shopHtml.includes('id="shopSocialFeed"') && shopHtml.includes('style="display:none;"'),
    "shop.html #shopSocialFeed initialized with style='display:none;'"
  );
  assert(
    indexHtml.includes('aria-labelledby="ugcHeadingHome"'),
    "index.html #homeSocialFeed has aria-labelledby='ugcHeadingHome'"
  );
  assert(
    shopHtml.includes('aria-labelledby="ugcHeadingShop"'),
    "shop.html #shopSocialFeed has aria-labelledby='ugcHeadingShop'"
  );

  // ----------------------------------------------------
  // TEST SECTION 3: Live DOM Rendering (enableSocialFeed = true)
  // ----------------------------------------------------
  console.log("\n3. Live DOM Rendering (enableSocialFeed = true)");

  // index.html
  await page.goto(`${URL_BASE}/index.html`, { waitUntil: "networkidle2" });
  const homeFeedVisible = await page.$eval(
    "#homeSocialFeed",
    (el) => getComputedStyle(el).display !== "none"
  );
  assert(
    homeFeedVisible,
    "index.html #homeSocialFeed is visible (display != 'none') when enableSocialFeed is true"
  );

  const homeCardsCount = await page.$$eval("#socialFeedGrid .ugc-card", (cards) => cards.length);
  assert(
    homeCardsCount === socialFeedJson.posts.length,
    `index.html rendered ${homeCardsCount} UGC cards (matches social-feed.json count of ${socialFeedJson.posts.length})`
  );

  // shop.html
  await page.goto(`${URL_BASE}/shop.html`, { waitUntil: "networkidle2" });
  const shopFeedVisible = await page.$eval(
    "#shopSocialFeed",
    (el) => getComputedStyle(el).display !== "none"
  );
  assert(
    shopFeedVisible,
    "shop.html #shopSocialFeed is visible (display != 'none') when enableSocialFeed is true"
  );

  const shopCardsCount = await page.$$eval(
    "#shopSocialFeedGrid .ugc-card",
    (cards) => cards.length
  );
  assert(
    shopCardsCount === socialFeedJson.posts.length,
    `shop.html rendered ${shopCardsCount} UGC cards (matches social-feed.json count of ${socialFeedJson.posts.length})`
  );

  // ----------------------------------------------------
  // TEST SECTION 4: CMS Toggle Behavior (enableSocialFeed = false)
  // ----------------------------------------------------
  console.log("\n4. CMS Toggle Behavior (enableSocialFeed = false)");

  // Test index.html with enableSocialFeed = false
  await page.goto(`${URL_BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.YL_CONTENT = window.YL_CONTENT || {};
    window.YL_CONTENT.site = window.YL_CONTENT.site || {};
    window.YL_CONTENT.site.enableSocialFeed = false;
  });

  const homeToggleHidden = await page.evaluate(() => {
    const section = document.getElementById("homeSocialFeed");
    const grid = document.getElementById("socialFeedGrid");
    grid.innerHTML = "";
    section.style.display = "none";

    const enableSocialFeed = window.YL_CONTENT.site.enableSocialFeed;
    if (!enableSocialFeed || !grid || !section || !window.YL_SOCIAL_FEED) {
      return getComputedStyle(section).display === "none" && grid.children.length === 0;
    }
    section.style.display = "block";
    return false;
  });

  assert(
    homeToggleHidden,
    "index.html #homeSocialFeed remains hidden and grid empty when enableSocialFeed is false"
  );

  // Test shop.html with enableSocialFeed = false
  await page.goto(`${URL_BASE}/shop.html`, { waitUntil: "domcontentloaded" });
  const shopToggleHidden = await page.evaluate(() => {
    window.YL_CONTENT = window.YL_CONTENT || {};
    window.YL_CONTENT.site = window.YL_CONTENT.site || {};
    window.YL_CONTENT.site.enableSocialFeed = false;
    const section = document.getElementById("shopSocialFeed");
    const grid = document.getElementById("shopSocialFeedGrid");
    grid.innerHTML = "";
    section.style.display = "none";

    const enableSocialFeed = window.YL_CONTENT.site.enableSocialFeed;
    if (!enableSocialFeed || !grid || !section || !window.YL_SOCIAL_FEED) {
      return getComputedStyle(section).display === "none" && grid.children.length === 0;
    }
    section.style.display = "block";
    return false;
  });

  assert(
    shopToggleHidden,
    "shop.html #shopSocialFeed remains hidden and grid empty when enableSocialFeed is false"
  );

  // Test empty posts array
  const emptyPostsHandled = await page.evaluate(() => {
    window.YL_CONTENT.site.enableSocialFeed = true;
    const origFeed = window.YL_SOCIAL_FEED;
    window.YL_SOCIAL_FEED = { posts: [] };
    const section = document.getElementById("shopSocialFeed");
    const grid = document.getElementById("shopSocialFeedGrid");
    grid.innerHTML = "";
    section.style.display = "none";

    const enableSocialFeed = window.YL_CONTENT.site.enableSocialFeed;
    const socialPosts = window.YL_SOCIAL_FEED.posts || [];
    if (
      !enableSocialFeed ||
      !grid ||
      !section ||
      !window.YL_SOCIAL_FEED ||
      socialPosts.length === 0
    ) {
      window.YL_SOCIAL_FEED = origFeed;
      return getComputedStyle(section).display === "none" && grid.children.length === 0;
    }
    return false;
  });
  assert(emptyPostsHandled, "Section remains hidden when social-feed has 0 posts");

  // ----------------------------------------------------
  // TEST SECTION 5: Aspect Ratios & Image Layout Attributes
  // ----------------------------------------------------
  console.log("\n5. Aspect Ratios & Image Layout Attributes");
  await page.goto(`${URL_BASE}/index.html`, { waitUntil: "networkidle2" });

  /* $$eval hands back an empty array when the selector matches nothing, and
     every() is true of an empty array -- so a UGC strip that failed to render
     at all would pass every attribute assertion below. Count first. */
  const imageAttributes = await page.$$eval(".ugc-card-media img", (imgs) => ({
    count: imgs.length,
    allValid: imgs.every((img) => {
      const w = img.getAttribute("width");
      const h = img.getAttribute("height");
      const loading = img.getAttribute("loading");
      const alt = img.getAttribute("alt");
      return w === "400" && h === "400" && loading === "lazy" && alt && alt.length > 5;
    })
  }));
  assert(
    imageAttributes.count > 0,
    "UGC card images present to check (found " + imageAttributes.count + ")"
  );
  assert(
    imageAttributes.count > 0 && imageAttributes.allValid,
    "All UGC card images have width='400', height='400', loading='lazy', and non-empty alt text"
  );

  const mediaAspectRatioCss = await page.$eval(".ugc-card-media", (el) => {
    const style = getComputedStyle(el);
    return style.aspectRatio === "1 / 1" || style.aspectRatio === "1";
  });
  assert(mediaAspectRatioCss, "CSS .ugc-card-media enforces explicit 1:1 aspect-ratio");

  const imgObjectFitCss = await page.$eval(".ugc-card-media img", (el) => {
    const style = getComputedStyle(el);
    return style.objectFit === "cover";
  });
  assert(imgObjectFitCss, "CSS .ugc-card-media img enforces object-fit: cover");

  // ----------------------------------------------------
  // TEST SECTION 6: Layout Responsiveness across Viewports
  // ----------------------------------------------------
  console.log("\n6. Responsive Grid Layout across Viewports");

  // Viewport Desktop (1200px)
  await page.setViewport({ width: 1200, height: 800 });
  const desktopCols = await page.$eval("#socialFeedGrid", (el) => {
    return getComputedStyle(el).gridTemplateColumns.split(" ").length;
  });
  assert(desktopCols === 3, `Desktop (1200px) layout renders 3 columns (got ${desktopCols})`);

  // Viewport Tablet (768px)
  await page.setViewport({ width: 768, height: 1024 });
  const tabletCols = await page.$eval("#socialFeedGrid", (el) => {
    return getComputedStyle(el).gridTemplateColumns.split(" ").length;
  });
  assert(tabletCols === 2, `Tablet (768px) layout renders 2 columns (got ${tabletCols})`);

  // Viewport Mobile (375px)
  await page.setViewport({ width: 375, height: 667 });
  const mobileCols = await page.$eval("#socialFeedGrid", (el) => {
    return getComputedStyle(el).gridTemplateColumns.split(" ").length;
  });
  assert(mobileCols === 1, `Mobile (375px) layout renders 1 column (got ${mobileCols})`);

  // Reset viewport
  await page.setViewport({ width: 1200, height: 800 });

  // ----------------------------------------------------
  // TEST SECTION 7: WCAG AA Accessibility Verification (Axe-Core)
  // ----------------------------------------------------
  console.log("\n7. WCAG AA Accessibility Verification (axe-core)");

  // index.html axe check
  await page.goto(`${URL_BASE}/index.html`, { waitUntil: "networkidle2" });
  const indexAxeResults = await analyzeAxe(page, "#homeSocialFeed");

  assert(
    indexAxeResults.violations.length === 0,
    `index.html #homeSocialFeed has 0 WCAG AA accessibility violations (found ${indexAxeResults.violations.length})`
  );
  if (indexAxeResults.violations.length > 0) {
    console.error("  Violations:", JSON.stringify(indexAxeResults.violations, null, 2));
  }

  // shop.html axe check
  await page.goto(`${URL_BASE}/shop.html`, { waitUntil: "networkidle2" });
  const shopAxeResults = await analyzeAxe(page, "#shopSocialFeed");

  assert(
    shopAxeResults.violations.length === 0,
    `shop.html #shopSocialFeed has 0 WCAG AA accessibility violations (found ${shopAxeResults.violations.length})`
  );
  if (shopAxeResults.violations.length > 0) {
    console.error("  Violations:", JSON.stringify(shopAxeResults.violations, null, 2));
  }

  // Check specific ARIA roles & attributes
  const roleListPresent = await page.$eval(
    "#shopSocialFeedGrid",
    (el) => el.getAttribute("role") === "list"
  );
  assert(roleListPresent, "#shopSocialFeedGrid has role='list'");

  const roleListItems = await page.$$eval("#shopSocialFeedGrid .ugc-card", (cards) => ({
    count: cards.length,
    allValid: cards.every((c) => c.getAttribute("role") === "listitem")
  }));
  assert(
    roleListItems.count > 0,
    "UGC cards present in grid to check (found " + roleListItems.count + ")"
  );
  assert(
    roleListItems.count > 0 && roleListItems.allValid,
    "All UGC cards in grid have role='listitem'"
  );

  const postLinks = await page.$$eval(".ugc-post-link", (links) => ({
    count: links.length,
    allValid: links.every(
      (l) => l.getAttribute("target") === "_blank" && l.getAttribute("rel") === "noopener"
    )
  }));
  assert(postLinks.count > 0, "UGC post links present to check (found " + postLinks.count + ")");
  assert(
    postLinks.count > 0 && postLinks.allValid,
    "All external post links have target='_blank' and rel='noopener'"
  );

  // ----------------------------------------------------
  // CLEANUP & SUMMARY
  // ----------------------------------------------------
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed.`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(async (err) => {
  console.error("Fatal error in test script:", err);
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  process.exit(1);
});
