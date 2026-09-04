/* eslint-env node, browser */
/**
 * @fileoverview The dictionaries are one file per language, fetched on demand.
 *
 * Until 2026-09-04 every dictionary shipped in one precached bundle:
 * assets/js/locales-data.js, 234KB at 515 keys x 6 locales, downloaded in
 * full by every visitor -- and most visitors read the shop in English and
 * need none of it. At 713 keys x 9 locales that file would have been near
 * half a megabyte on a first paint.
 *
 * What ships now is a small core (glossary + manifest) plus
 * assets/js/locales/<code>.js, fetched the first time somebody actually reads
 * the shop in that language. This suite pins the three things that split has
 * to be true for:
 *
 *   1. An English visitor requests NO dictionary at all. This is the whole
 *      point, and it is the assertion that fails if someone folds the phrase
 *      data back into the core or preloads every language "just in case".
 *   2. Switching to Spanish fetches exactly es and en -- en because the
 *      matcher looks a node's text up in the English index first -- and the
 *      page then really translates.
 *   3. When the dictionary cannot be fetched, the page STAYS ENGLISH and the
 *      badge stays EN. Fail closed. A page that says ES over English copy is
 *      the exact defect the 2026-09-02 audit found in the first translator,
 *      and on-demand loading reintroduces the opportunity for it: there is
 *      now a network request between "the shopper clicked Español" and "the
 *      shop can render Español".
 *
 * Run: node scripts/translator-lazy-locales.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const PORT = 0;
const SETTLE_TIMEOUT_MS = 12000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function createServer() {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!filePath.startsWith(ROOT)) filePath = path.join(ROOT, "404.html");
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
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

let passed = 0;
let failed = 0;
const errors = [];

function check(desc, ok, extra = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    const msg = `  ✗ FAIL: ${desc}${extra ? " — " + extra : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readNav(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#navLinks a")).map((a) => a.textContent.trim())
  );
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

/**
 * Every /assets/js/locales/<code>.js THE PAGE asked for, in request order.
 *
 * Filtered to script requests on purpose: the service worker precaches the
 * English index at install, and those fetches are the worker's, not the
 * page's. Counting them would make scenario 1 fail for a reason that has
 * nothing to do with what the page loaded.
 */
function trackLocaleRequests(page) {
  const seen = [];
  page.on("request", (req) => {
    if (req.resourceType() !== "script") return;
    const m = req.url().match(/\/assets\/js\/locales\/([a-z-]+)\.js/);
    if (m) seen.push(m[1]);
  });
  return seen;
}

async function main() {
  const server = await createServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n=== Lazy per-locale dictionaries (${base}) ===\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    /* --------------------------------------------------------------
       1. The English visitor pays nothing.
       -------------------------------------------------------------- */
    console.log("Scenario 1: an English visit fetches ENGLISH and nothing else");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const localeRequests = trackLocaleRequests(page);
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });

      /* Control first: the engine and its core must actually be present, or
         "no dictionary was fetched" would pass on a page that loaded nothing
         at all. */
      const ready = await page.evaluate(
        () => !!(window.YL_TRANSLATOR && window.YL_BRAND_GLOSSARY && window.YL_LOCALE_MANIFEST)
      );
      check("control: engine, glossary and manifest are present", ready === true);

      /* English IS fetched, and must be: en.js carries the tpl.* templates
         that cart.js and main.js render on an English page. Shipping without
         it put the literal string "tpl.milestoneFirst" in the cart drawer.
         What must NOT be fetched is any of the other eight. */
      check(
        "exactly one dictionary was requested, and it is en",
        localeRequests.length === 1 && localeRequests[0] === "en",
        JSON.stringify(localeRequests)
      );

      const registry = await page.evaluate(() => Object.keys(window.YL_LOCALES || {}));
      check(
        "the registry holds English alone",
        registry.length === 1 && registry[0] === "en",
        JSON.stringify(registry)
      );

      /* The thing the regression actually broke, asserted directly. */
      const rendered = await page.evaluate(() =>
        window.YL_TRANSLATOR.t("tpl.milestoneFirst", { amount: "$10.00", reward: "free shipping" })
      );
      check(
        "a tpl.* template renders English copy, not its own key",
        typeof rendered === "string" &&
          rendered.indexOf("tpl.") === -1 &&
          rendered.indexOf("$10.00") !== -1,
        JSON.stringify(rendered)
      );

      const manifestCodes = await page.evaluate(() =>
        (window.YL_LOCALE_MANIFEST || []).map((e) => e.code)
      );
      /* Compared against the picker's own list rather than a number: ">= 6"
         could not notice vi, ko and pt falling out of the manifest. */
      const pickerCodes = await page.evaluate(() =>
        (window.YL_TRANSLATOR.LANGUAGES || []).map((l) => l.code)
      );
      check(
        "the picker offers nine languages",
        pickerCodes.length === 9,
        JSON.stringify(pickerCodes)
      );
      check(
        "and the manifest names exactly those nine",
        manifestCodes.length === pickerCodes.length &&
          pickerCodes.every((c) => manifestCodes.includes(c)),
        JSON.stringify({ manifestCodes, pickerCodes })
      );

      await context.close();
    }

    /* --------------------------------------------------------------
       2. Switching fetches exactly what it needs, and translates.
       -------------------------------------------------------------- */
    console.log("\nScenario 2: switching to Spanish fetches es + en and translates");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const localeRequests = trackLocaleRequests(page);
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });

      const before = await readNav(page);
      check(
        "control: nav is English to begin with",
        before.includes("Shop"),
        JSON.stringify(before)
      );

      await page.evaluate(() => window.YL_TRANSLATOR.setLanguage("es"));
      const nav = await waitFor(async () => {
        const labels = await readNav(page);
        return labels.includes("Tienda") ? labels : null;
      }, SETTLE_TIMEOUT_MS);
      check(
        "the nav is Spanish after the switch",
        nav !== null,
        JSON.stringify(await readNav(page))
      );

      const sorted = localeRequests.slice().sort();
      check(
        "exactly es and en were fetched -- en by the page, es by the switch",
        sorted.length === 2 && sorted[0] === "en" && sorted[1] === "es",
        JSON.stringify(localeRequests)
      );

      /* Switching back and forth must not re-fetch: one file per language,
         once per page. */
      await page.evaluate(() => window.YL_TRANSLATOR.setLanguage("en"));
      await page.evaluate(() => window.YL_TRANSLATOR.setLanguage("es"));
      await sleep(300);
      check(
        "a second switch to the same language re-fetches nothing",
        localeRequests.length === 2,
        JSON.stringify(localeRequests)
      );

      await context.close();
    }

    /* --------------------------------------------------------------
       3. A dictionary that cannot be fetched leaves the page English.
       -------------------------------------------------------------- */
    console.log("\nScenario 3: a failed dictionary fetch fails closed");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      /* The site registers a service worker, and a request the worker
         satisfies never reaches page-level interception -- the first run of
         this scenario blocked 0 requests and translated happily, which is
         exactly what its control assertion is for. Bypassing the worker makes
         the page fetch for itself, which is the state this scenario is about:
         a shopper whose dictionary request does not come back. */
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      let blocked = 0;
      page.on("request", (req) => {
        if (/\/assets\/js\/locales\/[a-z-]+\.js/.test(req.url())) {
          blocked++;
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });

      const applied = await page.evaluate(() => window.YL_TRANSLATOR.setLanguage("es"));
      check("the request was actually blocked", blocked > 0, `blocked=${blocked}`);
      check("setLanguage reports en, not es", applied === "en", String(applied));

      const nav = await readNav(page);
      check("the nav is still English", nav.includes("Shop"), JSON.stringify(nav));

      const state = await page.evaluate(() => ({
        current: window.YL_TRANSLATOR.getCurrentLanguage(),
        badge: (document.querySelector(".lang-current-code") || {}).textContent || "",
        stored: window.localStorage.getItem("yl-lang")
      }));
      check("the engine still reports en", state.current === "en", state.current);
      check(
        "the header badge does not claim Spanish",
        state.badge.trim().toUpperCase() !== "ES",
        JSON.stringify(state.badge)
      );
      check(
        "and nothing was written to storage",
        state.stored === null || state.stored === "en",
        JSON.stringify(state.stored)
      );

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${passed} checks passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
  if (passed === 0) {
    console.error("No checks ran.");
    process.exit(1);
  }
  console.log("All good.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
