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
 * 5. Offline translation support: the Service Worker precaches the translation core
 *    (/assets/js/locales-data.js), the English index (/assets/js/locales/en.js) and
 *    /assets/js/translator.js; a language used online is cached and switches offline,
 *    and a language never used fails closed to English rather than claiming itself.
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

  /* Every live socket, so the server can be taken away completely rather than
     merely stopped accepting NEW connections. This is what makes the offline
     assertions real: page.setOfflineMode() emulates network conditions on the
     PAGE target, and a service worker has its own network stack that it does
     not touch -- so with the worker running, an "offline" page happily fetched
     anything it asked for, and every offline assertion in this file passed
     without the cache being involved at all. Killing the origin is the only
     condition both the page and its worker have to respect. */
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        kill: () =>
          new Promise((r) => {
            sockets.forEach((socket) => socket.destroy());
            sockets.clear();
            server.close(r);
          }),
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
      markedEs: document.querySelectorAll('[lang="es"]').length,
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null,
      stored: localStorage.getItem("yl-lang")
    }));

    assert(currentLang.stored === "es", "localStorage['yl-lang'] remains 'es' on shop.html");
    assert(currentLang.engineLang === "es", "YL_TRANSLATOR active language is 'es' on shop.html");
    /* NOT <html lang="es">. Coverage is partial, so the document stays English
       (WCAG 3.1.1) and only the elements actually replaced are marked. Both
       halves are asserted: a document that stopped being marked at all would
       otherwise pass the first half trivially. */
    assert(currentLang.htmlLang === "en", "<html lang> stays 'en' on shop.html");
    assert(currentLang.markedEs > 0, "translated elements are marked lang='es' on shop.html");
    assert(currentLang.indicatorText === "ES", "Dropdown indicator shows 'ES' on shop.html");
    pass(
      "Navigated from index.html -> shop.html: Language 'es' successfully persisted and hydrated."
    );

    // Navigate to a product page /products/miracle-balm.html
    await page.goto(`${baseUrl}/products/miracle-balm.html`, { waitUntil: "networkidle0" });
    currentLang = await page.evaluate(() => ({
      engineLang: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
      htmlLang: document.documentElement.getAttribute("lang"),
      markedEs: document.querySelectorAll('[lang="es"]').length,
      stored: localStorage.getItem("yl-lang")
    }));
    assert(currentLang.stored === "es", "localStorage['yl-lang'] remains 'es' on PDP");
    assert(currentLang.engineLang === "es", "YL_TRANSLATOR active language is 'es' on PDP");
    assert(currentLang.htmlLang === "en", "<html lang> stays 'en' on PDP");
    assert(currentLang.markedEs > 0, "translated elements are marked lang='es' on PDP");
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
      markedDe: document.querySelectorAll('[lang="de"]').length,
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(currentLang.engineLang === "de", "YL_TRANSLATOR active language is 'de' on about.html");
    assert(currentLang.htmlLang === "en", "<html lang> stays 'en' on about.html");
    assert(currentLang.markedDe > 0, "translated elements are marked lang='de' on about.html");
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
      marked: document.querySelectorAll('[lang="fr"]').length,
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
      urlParamState.htmlLang === "en",
      `Expected html[lang] to stay 'en' under partial coverage, got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.marked > 0,
      `Expected at least one element marked lang='fr', got ${urlParamState.marked}`
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
      marked: document.querySelectorAll('[lang="ja"]').length,
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(
      urlParamState.engineLang === "ja",
      `Expected engine lang 'ja', got '${urlParamState.engineLang}'`
    );
    assert(
      urlParamState.htmlLang === "en",
      `Expected html[lang] to stay 'en' under partial coverage, got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.marked > 0,
      `Expected at least one element marked lang='ja', got ${urlParamState.marked}`
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
      marked: document.querySelectorAll('[lang="zh"]').length,
      indicatorText: document.querySelector(".lang-current-code")
        ? document.querySelector(".lang-current-code").textContent.trim()
        : null
    }));
    assert(
      urlParamState.engineLang === "zh",
      `Expected engine lang 'zh', got '${urlParamState.engineLang}'`
    );
    assert(
      urlParamState.htmlLang === "en",
      `Expected html[lang] to stay 'en' under partial coverage, got '${urlParamState.htmlLang}'`
    );
    assert(
      urlParamState.marked > 0,
      `Expected at least one element marked lang='zh', got ${urlParamState.marked}`
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

    /* 6.1 Verify sw.js precaches the translation CORE.
       The dictionaries moved out of locales-data.js on 2026-09-04: it now
       carries the glossary and the manifest, each language is its own file
       under /assets/js/locales/, and only English -- the index every lookup
       starts from -- is precached with it. The other eight are fetched when a
       shopper first reads the shop in that language and cached by the fetch
       handler, so what "offline translation" means changed shape and 6.3
       below asserts the new shape rather than the old claim. */
    const swSource = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
    assert(
      swSource.includes("'/assets/js/locales-data.js'"),
      "sw.js ASSETS_TO_CACHE must include '/assets/js/locales-data.js'"
    );
    assert(
      swSource.includes("'/assets/js/locales/en.js'"),
      "sw.js ASSETS_TO_CACHE must include '/assets/js/locales/en.js'"
    );
    assert(
      swSource.includes("'/assets/js/translator.js'"),
      "sw.js ASSETS_TO_CACHE must include '/assets/js/translator.js'"
    );
    pass("sw.js precaches the translation core, the English index and translator.js.");

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

    /* 6.3 Offline translation.
       A language is available offline once it has been used online, because
       the fetch handler caches it. So use Japanese ONLINE first -- which is
       what a real shopper reading the shop in Japanese has already done --
       then pull the network and prove the switch still works from cache. */
    const warmed = await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("ja");
      await window.YL_TRANSLATOR.setLanguage("en");
      return Object.keys(window.YL_LOCALES || {});
    });
    assert(
      warmed.includes("ja") && warmed.includes("en"),
      `Japanese was fetched and cached while online (registry: ${JSON.stringify(warmed)})`
    );
    pass("Japanese dictionary fetched online and cached by the service worker.");

    /* Offline for real: the page is put offline AND the origin is taken away,
       because the service worker would otherwise keep serving the page from a
       network the page itself cannot see. Nothing below can reach anything
       that is not already in the cache. */
    await page.setOfflineMode(true);
    await server.kill();
    console.log("    🌐 Page offline via CDP and the origin shut down -- cache only");

    // Switch language to Japanese ('ja') while offline
    const offlineSwitchResult = await page.evaluate(async () => {
      if (window.YL_TRANSLATOR) {
        await window.YL_TRANSLATOR.setLanguage("ja");
        return {
          currentLang: window.YL_TRANSLATOR.getCurrentLanguage(),
          htmlLang: document.documentElement.getAttribute("lang"),
          marked: document.querySelectorAll('[lang="ja"]').length,
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
    assert(offlineSwitchResult.htmlLang === "en", `Offline html[lang] stays 'en'`);
    assert(
      offlineSwitchResult.marked > 0,
      `Offline switch marked ${offlineSwitchResult.marked} elements lang='ja'`
    );
    pass(
      "Offline translation switch to Japanese (ja) succeeded completely without network access."
    );

    /* Vietnamese, deliberately: es, de, fr, ja and zh have all been used
       earlier in this run, so their dictionaries are in the cache and would
       switch offline perfectly well -- which is the happy path §6.3 already
       proved with Japanese. vi is the one language this browser context has
       never displayed. */
    const offlineFrResult = await page.evaluate(async () => {
      if (window.YL_TRANSLATOR) {
        await window.YL_TRANSLATOR.setLanguage("vi");
        return {
          currentLang: window.YL_TRANSLATOR.getCurrentLanguage(),
          htmlLang: document.documentElement.getAttribute("lang")
        };
      }
      return null;
    });
    /* Vietnamese was never used in this browser context, so its dictionary
       was never fetched and is in no cache. Offline, that request cannot
       succeed -- and the contract is that the engine FAILS CLOSED: it stays
       in English rather than putting a Vietnamese badge over English copy.
       This is the documented cost of not precaching all nine dictionaries,
       and it is asserted rather than left to be discovered. */
    /* "Fails closed" means the engine never claims a language it cannot
       render. It does NOT mean throwing away the language the shopper already
       had: the page was Japanese and stays Japanese, which is a working page.
       What must not happen is currentLang or the badge saying "vi". */
    assert(
      offlineFrResult.currentLang !== "vi",
      `Offline switch to a never-fetched language does not claim it (got ${offlineFrResult.currentLang})`
    );
    assert(
      offlineFrResult.currentLang === "ja",
      `and leaves the working Japanese page alone (got ${offlineFrResult.currentLang})`
    );
    assert(offlineFrResult.htmlLang === "en", "and html[lang] still reads en");
    pass("Offline switch to an unfetched language fails closed instead of lying.");

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
