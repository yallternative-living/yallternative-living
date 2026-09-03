/* global document, window, navigator */
/**
 * @fileoverview Adversarial Multi-Viewport, Overflow & Target Size Verification
 * Tests responsive layout across Desktop (1200x800), Tablet (768x1024), and Mobile (375x667)
 * on both local build and the live production website (https://yallternativeliving.com).
 *
 * Checks:
 * 1. Horizontal overflow: document.documentElement.scrollWidth and body.scrollWidth <= innerWidth
 * 2. Touch target size: WCAG 2.2 AA SC 2.5.8 (>= 24x24px, plus checking 44x44px touch ergonomics)
 * 3. Scroll-reveal opacity: verify .reveal elements never remain trapped at opacity: 0
 *
 * Run: node scripts/challenger-viewport-stress.js [--local-only | --live-only]
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");

const PORT = 8092;
const ROOT = path.resolve(__dirname, "..");
const LOCAL_BASE = `http://127.0.0.1:${PORT}`;
const LIVE_BASE = "https://yallternativeliving.com";

const VIEWPORTS = [
  { name: "desktop", width: 1200, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 667 }
];

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
  ".webmanifest": "application/manifest+json"
};

function createStaticServer(port = PORT) {
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
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1", () => resolve(server));
      } else {
        reject(err);
      }
    });
  });
}

function collectPages() {
  const topPages = [
    "index.html",
    "shop.html",
    "about.html",
    "events.html",
    "contact.html",
    "faq.html",
    "reviews.html",
    "thank-you.html",
    "404.html",
    "offline.html",
    "policies.html",
    "privacy.html",
    "terms.html",
    "order-status.html",
    "safety.html",
    "welcome.html"
  ];
  const productsDir = path.join(ROOT, "products");
  const productPages = fs.existsSync(productsDir)
    ? fs
        .readdirSync(productsDir)
        .filter((f) => f.endsWith(".html"))
        .sort()
        .map((f) => `products/${f}`)
    : [];
  return { topPages, productPages, allPages: [...topPages, ...productPages] };
}

async function auditPage(page, url, vp) {
  await page.setViewport({ width: vp.width, height: vp.height });
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 });
  } catch {
    // Retry with domcontentloaded on timeout
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e2) {
      return {
        error: `Navigation failed: ${e2.message}`,
        overflow: null,
        reveal: null,
        targetSizes: null
      };
    }
  }

  // 1. HORIZONTAL OVERFLOW CHECK
  const overflowData = await page.evaluate((expectedWidth) => {
    const docEl = document.documentElement;
    const body = document.body;
    const docScrollWidth = docEl.scrollWidth;
    const bodyScrollWidth = body ? body.scrollWidth : 0;
    const innerWidth = window.innerWidth;
    const maxScrollWidth = Math.max(docScrollWidth, bodyScrollWidth);
    const hasOverflow = maxScrollWidth > expectedWidth + 1; // 1px rounding margin

    let offendingElements = [];
    if (hasOverflow) {
      const all = document.querySelectorAll("*");
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          if (r.right > expectedWidth + 1.5 || r.left < -1.5) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className && typeof el.className === "string" ? el.className.trim() : "";
            const id = el.id ? `#${el.id}` : "";
            offendingElements.push({
              selector: `${tag}${id}${cls ? "." + cls.split(/\s+/).slice(0, 3).join(".") : ""}`,
              rect: {
                left: Math.round(r.left),
                right: Math.round(r.right),
                width: Math.round(r.width)
              }
            });
            if (offendingElements.length >= 5) break;
          }
        }
      }
    }

    return {
      docScrollWidth,
      bodyScrollWidth,
      innerWidth,
      expectedWidth,
      hasOverflow,
      overflowPx: hasOverflow ? maxScrollWidth - expectedWidth : 0,
      offendingElements
    };
  }, vp.width);

  // 2. SCROLL-REVEAL OPACITY CHECK
  const scrollHeight = await page.evaluate(
    () => document.body.scrollHeight || document.documentElement.scrollHeight
  );
  for (let y = 0; y <= scrollHeight; y += 350) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 900));

  const revealData = await page.evaluate(() => {
    const reveals = Array.from(document.querySelectorAll(".reveal"));
    if (!reveals.length) {
      return { total: 0, trappedCount: 0, trapped: [] };
    }

    const trapped = [];
    reveals.forEach((el, idx) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0 || el.offsetParent === null) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const opacity = parseFloat(style.opacity);
      if (opacity < 0.95 || el.classList.contains("reveal-armed")) {
        const tag = el.tagName.toLowerCase();
        const cls = el.className && typeof el.className === "string" ? el.className.trim() : "";
        const id = el.id ? `#${el.id}` : "";
        trapped.push({
          index: idx,
          selector: `${tag}${id}${cls ? "." + cls.split(/\s+/).slice(0, 3).join(".") : ""}`,
          computedOpacity: style.opacity,
          text: (el.innerText || "").slice(0, 40).trim()
        });
      }
    });

    return {
      total: reveals.length,
      trappedCount: trapped.length,
      trapped: trapped.slice(0, 5)
    };
  });

  // 3. TARGET SIZES CHECK (WCAG 2.2 AA SC 2.5.8 >= 24x24)
  const targetSizesData = await page.evaluate(() => {
    // Select interactive elements
    const interactiveSelectors = [
      ".pdp-ritual-checkbox",
      "input[type='checkbox']",
      "input[type='radio']",
      ".variant-option",
      ".pdp-variant-chip",
      ".pdp-chip",
      ".variant-chip",
      ".size-option",
      ".gallery-dot",
      ".pdp-gallery-dot",
      ".gallery-dots button",
      ".pdp-gallery-thumb",
      "button[data-concern]",
      ".filter-btn",
      ".filter-chip",
      ".collection-pill",
      "#mobileMenuToggle",
      ".menu-toggle",
      ".nav-toggle",
      "#globalSearchTrigger",
      ".search-toggle",
      "#themeToggle",
      "#cartBtn",
      ".cart-btn",
      ".lang-toggle",
      ".lang-option",
      ".yl-cart-qty-btn",
      ".yl-cart-remove",
      ".yl-cart-checkout",
      ".pdp-add-to-cart",
      ".add-to-cart-btn",
      ".pdp-sticky-bar .pdp-sticky-btn",
      ".bundle-add-btn",
      ".faq-question",
      "summary"
    ];

    const targets = [];
    const elements = document.querySelectorAll(interactiveSelectors.join(", "));

    elements.forEach((el) => {
      // Must be visible in the DOM
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        el.offsetParent === null
      ) {
        // Element is currently hidden (e.g. inside a closed drawer or modal)
        return;
      }

      // If an input is enclosed by a clickable <label>, evaluate the target as the label per WCAG 2.2 SC 2.5.8
      let targetEl = el;
      if (el.tagName.toLowerCase() === "input" && el.closest("label")) {
        targetEl = el.closest("label");
      }

      const rect = targetEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const tag = targetEl.tagName.toLowerCase();
      const cls =
        targetEl.className && typeof targetEl.className === "string"
          ? targetEl.className.trim()
          : "";
      const id = targetEl.id ? `#${targetEl.id}` : "";
      const role = targetEl.getAttribute("role") || el.getAttribute("role") || "";
      const ariaLabel = targetEl.getAttribute("aria-label") || el.getAttribute("aria-label") || "";
      const text = (targetEl.innerText || el.value || ariaLabel || "").slice(0, 30).trim();

      const width = Math.round(rect.width * 10) / 10;
      const height = Math.round(rect.height * 10) / 10;
      const minDim = Math.min(width, height);

      targets.push({
        selector: `${tag}${id}${cls ? "." + cls.split(/\s+/).slice(0, 3).join(".") : ""}`,
        role,
        text,
        width,
        height,
        minDim,
        below24: minDim < 24,
        below44: minDim < 44
      });
    });

    // Group specific required items
    const ritualCheckboxes = targets.filter((t) => t.selector.includes("ritual-checkbox"));
    const variantChips = targets.filter(
      (t) =>
        t.selector.includes("variant") || t.selector.includes("chip") || t.selector.includes("size")
    );
    const galleryDots = targets.filter(
      (t) => t.selector.includes("gallery") || t.selector.includes("dot")
    );
    const navButtons = targets.filter(
      (t) =>
        t.selector.includes("toggle") ||
        t.selector.includes("nav") ||
        t.selector.includes("search") ||
        t.selector.includes("cart") ||
        t.selector.includes("lang")
    );

    const cartButtons = targets.filter(
      (t) =>
        t.selector.includes("cart") ||
        t.selector.includes("add-to-cart") ||
        t.selector.includes("sticky-btn")
    );
    const filterButtons = targets.filter(
      (t) =>
        t.selector.includes("filter") ||
        t.selector.includes("concern") ||
        t.selector.includes("pill")
    );

    const violations24 = targets.filter((t) => t.below24);

    return {
      totalMeasured: targets.length,
      violations24Count: violations24.length,
      violations24: violations24.slice(0, 10),
      ritualCheckboxes,
      variantChips: variantChips.slice(0, 6),
      galleryDots: galleryDots.slice(0, 6),
      navButtons: navButtons.slice(0, 10),
      cartButtons: cartButtons.slice(0, 10),
      filterButtons: filterButtons.slice(0, 10)
    };
  });

  return {
    overflow: overflowData,
    reveal: revealData,
    targetSizes: targetSizesData
  };
}

async function main() {
  const args = process.argv.slice(2);
  const liveOnly = args.includes("--live-only");
  const localOnly = args.includes("--local-only");

  console.log("===============================================================================");
  console.log("ADVERSARIAL MULTI-VIEWPORT, OVERFLOW & TARGET SIZE VERIFICATION SUITE");
  console.log("===============================================================================\n");

  const { allPages, topPages, productPages } = collectPages();
  console.log(
    `Discovered ${allPages.length} pages (${topPages.length} top-level, ${productPages.length} PDPs).`
  );

  let localServer = null;
  if (!liveOnly) {
    console.log(`Starting local static server on port ${PORT}...`);
    localServer = await createStaticServer(PORT);
    const addr = localServer.address();
    const activePort = typeof addr === "object" ? addr.port : PORT;
    console.log(`Local server listening at http://127.0.0.1:${activePort}`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const targetsToRun = [];
  if (!liveOnly) targetsToRun.push({ name: "LOCAL BUILD", baseUrl: LOCAL_BASE });
  if (!localOnly)
    targetsToRun.push({ name: "LIVE PRODUCTION (yallternativeliving.com)", baseUrl: LIVE_BASE });

  const fullReport = {
    timestamp: new Date().toISOString(),
    environments: {}
  };

  try {
    for (const env of targetsToRun) {
      console.log(
        `\n###############################################################################`
      );
      console.log(`TESTING ENVIRONMENT: ${env.name}`);
      console.log(`Base URL: ${env.baseUrl}`);
      console.log(
        `###############################################################################\n`
      );

      const envResults = {
        name: env.name,
        baseUrl: env.baseUrl,
        pagesTested: 0,
        overflowViolations: [],
        revealTrappedViolations: [],
        targetSizeViolations: [],
        specificChecks: {
          ritualCheckboxes: [],
          galleryDots: [],
          variantChips: [],
          navButtons: [],
          cartButtons: [],
          filterButtons: []
        }
      };

      for (const pageName of allPages) {
        const url = `${env.baseUrl}/${pageName}`;
        console.log(`\n--- Auditing: ${pageName} ---`);

        for (const vp of VIEWPORTS) {
          const page = await browser.newPage();
          // Spoof navigator.webdriver so real scroll-reveal observer runs
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
          });

          const res = await auditPage(page, url, vp);
          await page.close();

          if (res.error) {
            console.warn(`  [${vp.name}] ERROR: ${res.error}`);
            continue;
          }

          // Check 1: Overflow
          if (res.overflow && res.overflow.hasOverflow) {
            console.error(
              `  ❌ [${vp.name}] HORIZONTAL OVERFLOW: scrollWidth=${res.overflow.docScrollWidth}px vs viewport=${vp.width}px (+${res.overflow.overflowPx}px)`
            );
            if (res.overflow.offendingElements.length) {
              console.error(
                `     Offending: ${res.overflow.offendingElements.map((e) => `${e.selector} (right:${e.rect.right})`).join(", ")}`
              );
            }
            envResults.overflowViolations.push({
              page: pageName,
              viewport: vp.name,
              expectedWidth: vp.width,
              scrollWidth: res.overflow.docScrollWidth,
              overflowPx: res.overflow.overflowPx,
              offending: res.overflow.offendingElements
            });
          } else {
            console.log(
              `  ✓ [${vp.name}] Zero overflow (scrollWidth=${res.overflow.docScrollWidth}px <= ${vp.width}px)`
            );
          }

          // Check 2: Scroll-Reveal
          if (res.reveal && res.reveal.trappedCount > 0) {
            console.error(
              `  ❌ [${vp.name}] SCROLL-REVEAL TRAPPED: ${res.reveal.trappedCount} element(s) stuck at opacity < 0.9`
            );
            res.reveal.trapped.forEach((t) => {
              console.error(`     Trapped: ${t.selector} (opacity: ${t.computedOpacity})`);
            });
            envResults.revealTrappedViolations.push({
              page: pageName,
              viewport: vp.name,
              trappedCount: res.reveal.trappedCount,
              trapped: res.reveal.trapped
            });
          } else if (res.reveal && res.reveal.total > 0) {
            console.log(
              `  ✓ [${vp.name}] Scroll-reveal OK (${res.reveal.total} elements, all opacity: 1)`
            );
          }

          // Check 3: Target Sizes
          if (res.targetSizes) {
            if (res.targetSizes.violations24Count > 0) {
              console.error(
                `  ❌ [${vp.name}] TOUCH TARGET VIOLATIONS (< 24px): ${res.targetSizes.violations24Count} element(s)`
              );
              res.targetSizes.violations24.forEach((v) => {
                console.error(
                  `     Undersized: ${v.selector} [${v.width}x${v.height}px] text:"${v.text}"`
                );
              });
              envResults.targetSizeViolations.push({
                page: pageName,
                viewport: vp.name,
                violations: res.targetSizes.violations24
              });
            } else {
              console.log(
                `  ✓ [${vp.name}] All visible targets >= 24x24px (${res.targetSizes.totalMeasured} checked)`
              );
            }

            // Capture specific components
            if (res.targetSizes.ritualCheckboxes.length) {
              envResults.specificChecks.ritualCheckboxes.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.ritualCheckboxes
              });
            }
            if (res.targetSizes.galleryDots.length) {
              envResults.specificChecks.galleryDots.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.galleryDots
              });
            }
            if (res.targetSizes.variantChips.length) {
              envResults.specificChecks.variantChips.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.variantChips
              });
            }
            if (res.targetSizes.navButtons.length) {
              envResults.specificChecks.navButtons.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.navButtons
              });
            }
            if (res.targetSizes.cartButtons && res.targetSizes.cartButtons.length) {
              envResults.specificChecks.cartButtons.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.cartButtons
              });
            }
            if (res.targetSizes.filterButtons && res.targetSizes.filterButtons.length) {
              envResults.specificChecks.filterButtons.push({
                page: pageName,
                viewport: vp.name,
                items: res.targetSizes.filterButtons
              });
            }
          }
        }
        envResults.pagesTested++;
      }

      fullReport.environments[env.name] = envResults;
    }

    // Save JSON results to temporary or agent report dir
    const outputPath = path.join(
      ROOT,
      ".agents",
      "challenger_readiness_2",
      "viewport-audit-data.json"
    );
    fs.writeFileSync(outputPath, JSON.stringify(fullReport, null, 2), "utf8");
    console.log(`\nWrote audit data to: ${outputPath}`);

    // Print summary
    console.log(
      "\n==============================================================================="
    );
    console.log("EXECUTIVE AUDIT SUMMARY");
    console.log("===============================================================================");
    for (const [envName, res] of Object.entries(fullReport.environments)) {
      console.log(`\nEnvironment: ${envName}`);
      console.log(`  Pages tested: ${res.pagesTested}`);
      console.log(`  Horizontal overflow violations: ${res.overflowViolations.length}`);
      console.log(`  Scroll-reveal trapped violations: ${res.revealTrappedViolations.length}`);
      console.log(`  Touch target (<24px) violations: ${res.targetSizeViolations.length}`);
    }
  } finally {
    await browser.close();
    if (localServer) {
      localServer.close();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error running audit:", err);
  process.exit(1);
});
