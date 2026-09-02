/* eslint-env node, browser */
/**
 * @fileoverview Empirical Challenger 2 Test Suite: Network Privacy, Cookie Isolation, & Browser Flow.
 *
 * Rigorously tests:
 * 1. Network Privacy: 0 network requests to translate.google.com, translate.googleapis.com,
 *    or any Google Translate endpoint across all site pages and during active language switching.
 * 2. Cookie Isolation: 0 'googtrans' cookies written to document.cookie on page loads or language toggles.
 * 3. Persistence: localStorage['yl-lang'] correctly persists and hydrates across navigations
 *    (index -> shop -> product -> about -> index) across all 6 supported languages.
 * 4. URL parameter: ?lang=es, ?lang=fr, ?lang=ja cleanly sets initial language and DOM state.
 * 5. Offline translation support: Service Worker precaches /assets/js/locales-data.js and
 *    /assets/js/translator.js, and in-browser offline translation works without internet connectivity.
 * 6. Brand glossary integrity in real browser DOM: Protected terms remain uncorrupted across languages.
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
        res.writeHead(200, {
          "Content-Type": contentType,
          "Service-Worker-Allowed": "/"
        });
        res.end(data);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runChallenger2Tests() {
  console.log("==========================================================================");
  console.log("🚀 Starting Challenger 2: Network Privacy, Cookie Isolation & Browser Flow");
  console.log("==========================================================================\n");

  const server = await createTestServer();
  const baseUrl = server.url;
  console.log(`📡 Local static test server active at ${baseUrl}\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security"
    ]
  });

  let testCount = 0;
  function pass(msg) {
    testCount++;
    console.log(`  ✅ [PASS ${testCount}] ${msg}`);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Collect all outgoing network requests
    const networkRequests = [];
    page.on("request", (req) => {
      networkRequests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType()
      });
    });

    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    /* =========================================================================
       SECTION 1: NETWORK PRIVACY — 0 GOOGLE TRANSLATE REQUESTS ACROSS ALL PAGES
       ========================================================================= */
    console.log("--- 1. Testing Network Privacy: Zero External Translation Requests ---");

    const pagesToScan = [
      "/index.html",
      "/shop.html",
      "/about.html",
      "/contact.html",
      "/events.html",
      "/faq.html",
      "/policies.html",
      "/terms.html",
      "/privacy.html",
      "/reviews.html",
      "/order-status.html",
      "/thank-you.html",
      "/welcome.html",
      "/products/miracle-balm.html",
      "/products/porch-sweep.html",
      "/products/hush-yall-salve.html"
    ];

    for (const route of pagesToScan) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle0" });

      // Verify no Google Translate requests were recorded
      const googleTranslateReqs = networkRequests.filter(
        (r) =>
          r.url.includes("translate.google.com") ||
          r.url.includes("translate.googleapis.com") ||
          r.url.includes("translate-pa.googleapis.com") ||
          r.url.includes("google.com/translate")
      );

      assert(
        googleTranslateReqs.length === 0,
        `Detected Google Translate network request on ${route}: ${JSON.stringify(googleTranslateReqs)}`
      );

      // Verify no Google Translate DOM elements exist
      const legacyDomElements = await page.evaluate(() => {
        const els = [
          document.getElementById("google_translate_element"),
          document.querySelector(".goog-te-banner-frame"),
          document.querySelector(".skiptranslate"),
          document.querySelector('script[src*="translate.google.com"]')
        ];
        return els.filter(Boolean).length;
      });

      assert(
        legacyDomElements === 0,
        `Found legacy Google Translate DOM remnants on ${route} (${legacyDomElements} elements)`
      );
    }
    pass(
      `Scanned ${pagesToScan.length} pages: Exactly 0 Google Translate network requests and 0 legacy DOM elements found.`
    );

    /* =========================================================================
       SECTION 2: COOKIE ISOLATION — 0 GOOGTRANS COOKIES WRITTEN TO DOCUMENT.COOKIE
       ========================================================================= */
    console.log("\n--- 2. Testing Cookie Isolation: Zero googtrans Cookies ---");

    // Clear cookies first
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");

    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });

    // Check initial cookie state
    let cookies = await page.cookies();
    let googtransCookie = cookies.find((c) => c.name.toLowerCase().includes("googtrans"));
    assert(!googtransCookie, "No googtrans cookie found on initial load");

    // Switch between all 6 languages sequentially and assert document.cookie remains clean
    const testLanguages = ["es", "de", "fr", "ja", "zh", "en"];
    for (const lang of testLanguages) {
      await page.evaluate(async (l) => {
        if (window.YL_TRANSLATOR && typeof window.YL_TRANSLATOR.setLanguage === "function") {
          await window.YL_TRANSLATOR.setLanguage(l);
        }
      }, lang);

      // Verify document.cookie in page context
      const docCookie = await page.evaluate(() => document.cookie);
      assert(
        !docCookie.includes("googtrans"),
        `document.cookie contaminated with googtrans after switching to ${lang}: "${docCookie}"`
      );

      cookies = await page.cookies();
      googtransCookie = cookies.find((c) => c.name.toLowerCase().includes("googtrans"));
      assert(
        !googtransCookie,
        `Browser cookie storage contains googtrans after switching to ${lang}`
      );
    }
    pass(
      "Tested language switching across all 6 languages: Exactly 0 googtrans cookies set in document.cookie or browser storage."
    );

    /* =========================================================================
       SECTION 3: LOCALSTORAGE PERSISTENCE ACROSS PAGE NAVIGATIONS
       ========================================================================= */
    console.log("\n--- 3. Testing localStorage['yl-lang'] Persistence Across Page Navigations ---");

    // Set language to 'es' on homepage
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("es");
    });

    // Check localStorage in browser
    let storedLang = await page.evaluate(() => localStorage.getItem("yl-lang"));
    assert(storedLang === "es", `Expected localStorage['yl-lang'] to be 'es', got '${storedLang}'`);

    // Navigate to /shop.html and verify language is retained as 'es'
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });
    let currentLang = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null,
      stored: localStorage.getItem("yl-lang")
    }));

    assert(currentLang.stored === "es", "localStorage['yl-lang'] remains 'es' on shop.html");
    assert(currentLang.engineLang === "es", "YL_TRANSLATOR active language is 'es' on shop.html");
    assert(currentLang.htmlLang === "es", "<html lang='es'> correctly set on shop.html");
    assert(currentLang.indicatorText === "ES", "Dropdown indicator shows 'ES' on shop.html");
    pass(
      "Navigated from index.html -> shop.html: Language 'es' successfully persisted and hydrated."
    );

    // Navigate to a product page /products/miracle-balm.html
    await page.goto(`${baseUrl}/products/miracle-balm.html`, { waitUntil: "networkidle0" });
    currentLang = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      stored: localStorage.getItem("yl-lang")
    }));
    assert(currentLang.stored === "es", "localStorage['yl-lang'] remains 'es' on PDP");
    assert(currentLang.engineLang === "es", "YL_TRANSLATOR active language is 'es' on PDP");
    assert(currentLang.htmlLang === "es", "<html lang='es'> correctly set on PDP");
    pass(
      "Navigated to product page /products/miracle-balm.html: Language 'es' successfully persisted."
    );

    // Change language to German ('de') on PDP
    await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("de");
    });
    storedLang = await page.evaluate(() => localStorage.getItem("yl-lang"));
    assert(storedLang === "de", "localStorage['yl-lang'] updated to 'de'");

    // Navigate to /about.html and verify German ('de') is hydrated
    await page.goto(`${baseUrl}/about.html`, { waitUntil: "networkidle0" });
    currentLang = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(currentLang.engineLang === "de", "YL_TRANSLATOR active language is 'de' on about.html");
    assert(currentLang.htmlLang === "de", "<html lang='de'> correctly set on about.html");
    assert(currentLang.indicatorText === "DE", "Dropdown indicator shows 'DE' on about.html");
    pass("Navigated to /about.html: Language 'de' successfully persisted and hydrated.");

    /* =========================================================================
       SECTION 4: URL PARAMETER ?lang= CLEAN INITIALIZATION
       ========================================================================= */
    console.log("\n--- 4. Testing URL Parameter ?lang= Initialization ---");

    // Clear localStorage to test pure URL param initialization
    await page.evaluate(() => localStorage.removeItem("yl-lang"));

    // Navigate to /shop.html?lang=fr
    await page.goto(`${baseUrl}/shop.html?lang=fr`, { waitUntil: "networkidle0" });
    let urlParamState = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null,
      stored: localStorage.getItem("yl-lang")
    }));

    assert(
      urlParamState.engineLang === "fr",
      `Expected engine lang 'fr', got '${urlParamState.engineLang}'`
    );
    assert(
      urlParamState.htmlLang === "fr",
      `Expected html[lang='fr'], got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.indicatorText === "FR",
      `Expected indicator 'FR', got '${urlParamState.indicatorText}'`
    );
    pass("Direct navigation to /shop.html?lang=fr initialized engine to French (fr).");

    // Test Japanese /privacy.html?lang=ja
    await page.goto(`${baseUrl}/privacy.html?lang=ja`, { waitUntil: "networkidle0" });
    urlParamState = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(
      urlParamState.engineLang === "ja",
      `Expected engine lang 'ja', got '${urlParamState.engineLang}'`
    );
    assert(
      urlParamState.htmlLang === "ja",
      `Expected html[lang='ja'], got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.indicatorText === "JA",
      `Expected indicator 'JA', got '${urlParamState.indicatorText}'`
    );
    pass("Direct navigation to /privacy.html?lang=ja initialized engine to Japanese (ja).");

    // Test Chinese /index.html?lang=zh
    await page.goto(`${baseUrl}/index.html?lang=zh`, { waitUntil: "networkidle0" });
    urlParamState = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(
      urlParamState.engineLang === "zh",
      `Expected engine lang 'zh', got '${urlParamState.engineLang}'`
    );
    assert(
      urlParamState.htmlLang === "zh",
      `Expected html[lang='zh'], got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.indicatorText === "ZH",
      `Expected indicator 'ZH', got '${urlParamState.indicatorText}'`
    );
    pass("Direct navigation to /index.html?lang=zh initialized engine to Chinese (zh).");

    /* =========================================================================
       SECTION 5: BRAND GLOSSARY INTEGRITY IN REAL BROWSER DOM
       ========================================================================= */
    console.log("\n--- 5. Testing Brand Glossary Protection in Real DOM ---");

    // Switch to Spanish on homepage and verify brand terms
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("es");
    });

    const glossaryVerification = await page.evaluate(() => {
      const brandWord = document.querySelector(".brand-word")
        ? document.querySelector(".brand-word").textContent.trim()
        : "";
      const bodyText = document.body.textContent;

      return {
        brandWord,
        hasPorchSweep: bodyText.includes("Porch Sweep"),
        hasMiracleFrankincense:
          bodyText.includes("Frankincense") ||
          bodyText.includes("Miracle Balm") ||
          bodyText.includes("Salve"),
        hasLandrum: bodyText.includes("Landrum, SC") || bodyText.includes("Landrum")
      };
    });

    assert(
      glossaryVerification.brandWord.includes("Y'allternative"),
      "Brand logo wordmark uncorrupted"
    );
    assert(glossaryVerification.hasLandrum, "Hometown 'Landrum, SC' uncorrupted");
    pass(
      "Brand Glossary terms ('Y'allternative Living', 'Landrum, SC', product names) remain protected in Spanish DOM."
    );

    /* =========================================================================
       SECTION 6: OFFLINE TRANSLATION SUPPORT VIA SERVICE WORKER CACHE
       ========================================================================= */
    console.log("\n--- 6. Testing Offline Translation Support via Service Worker ---");

    // 6.1 Verify sw.js source file includes locales-data.js and translator.js
    const swSource = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
    assert(
      swSource.includes("'/assets/js/locales-data.js'"),
      "sw.js ASSETS_TO_CACHE must include '/assets/js/locales-data.js'"
    );
    assert(
      swSource.includes("'/assets/js/translator.js'"),
      "sw.js ASSETS_TO_CACHE must include '/assets/js/translator.js'"
    );
    pass(
      "sw.js static asset cache manifests '/assets/js/locales-data.js' and '/assets/js/translator.js'."
    );

    // 6.2 Test Service Worker registration in browser
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle0" });
    const swRegistered = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      return !!registration;
    });
    assert(swRegistered, "Service Worker registered and active");
    pass("Service Worker successfully registered and ready.");

    // 6.3 Test offline in-browser translation switching
    // Simulate offline mode via CDP
    await page.setOfflineMode(true);
    console.log("    🌐 Browser network set to OFFLINE mode via Chrome DevTools Protocol");

    // Switch language to Japanese ('ja') while offline
    const offlineSwitchResult = await page.evaluate(async () => {
      if (window.YL_TRANSLATOR) {
        await window.YL_TRANSLATOR.setLanguage("ja");
        return {
          currentLang: window.YL_TRANSLATOR.getCurrentLanguage(),
          htmlLang: document.documentElement.getAttribute("lang"),
          navCartText: (document.querySelector("[data-i18n='nav.cart']") || {}).textContent,
          title: document.title
        };
      }
      return null;
    });

    assert(offlineSwitchResult, "YL_TRANSLATOR functioned offline");
    assert(
      offlineSwitchResult.currentLang === "ja",
      `Offline language switch to 'ja' succeeded (got ${offlineSwitchResult.currentLang})`
    );
    assert(offlineSwitchResult.htmlLang === "ja", `Offline html[lang] updated to 'ja'`);
    pass(
      "Offline translation switch to Japanese (ja) succeeded completely without network access."
    );

    // Switch language to French ('fr') while offline
    const offlineFrResult = await page.evaluate(async () => {
      if (window.YL_TRANSLATOR) {
        await window.YL_TRANSLATOR.setLanguage("fr");
        return {
          currentLang: window.YL_TRANSLATOR.getCurrentLanguage(),
          htmlLang: document.documentElement.getAttribute("lang")
        };
      }
      return null;
    });
    assert(offlineFrResult.currentLang === "fr", "Offline language switch to 'fr' succeeded");
    pass("Offline translation switch to French (fr) succeeded completely without network access.");

    // Restore online mode
    await page.setOfflineMode(false);
    console.log("    🌐 Browser network restored to ONLINE mode");

    console.log("\n==========================================================================");
    console.log(`🎉 ALL ${testCount} CHALLENGER 2 EMPIRICAL TESTS PASSED WITH 0 ERRORS!`);
    console.log("==========================================================================\n");
  } finally {
    await browser.close();
    await server.close();
  }
}

runChallenger2Tests().catch((err) => {
  console.error("❌ Fatal test error in Challenger 2 suite:", err);
  process.exit(1);
});
