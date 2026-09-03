/* eslint-env node, browser */
/**
 * @fileoverview Regression gate for the translator script-order race.
 *
 * WHAT BROKE. assets/js/main.js injects assets/js/locales-data.js (71KB of
 * dictionaries) and assets/js/translator.js (28KB of engine) with
 * document.createElement("script"). Such a script is async by default -- the
 * HTML spec sets its "force-async" flag -- so `defer` is ignored and the two
 * files execute in NETWORK-COMPLETION order. The small file wins. The
 * 2026-09-02 audit measured translator.js executing first on 10 cold loads out
 * of 10 at 150ms / 500kbps.
 *
 * When translator.js wins, init() builds its lookup index against an empty
 * window.YL_LOCALES, walks the whole tree translating nothing, and still sets
 * the header badge to the requested language. Nothing ever re-runs. A visitor
 * following a shared /?lang=es link got a 100% English page announcing itself
 * as Spanish, and only a SECOND visit -- served from the service-worker cache,
 * where both files are already local -- worked.
 *
 * THE FIX has two halves and this suite tests both:
 *   1. main.js sets `.async = false` on both injected scripts, which is the
 *      documented opt-in to ordered execution for dynamically inserted
 *      scripts. Scenario A below.
 *   2. translator.js's init() no longer calls setLanguage() when the
 *      dictionaries are absent; it arms waitForLocales() and re-runs init()
 *      idempotently when they land. Scenario B below.
 *
 * Scenario A asserts the SHIPPED page under an artificially delayed
 * locales-data.js. Its first assertion is a harness control: at a moment when
 * the dictionaries provably cannot have arrived, the nav must still be
 * English. Without it, a broken interception would make every later assertion
 * pass for the wrong reason.
 *
 * Run: node scripts/translator-script-order.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

/* Ephemeral: this suite runs inside run-integration-tests.js's worker pool
   alongside the suites that own fixed ports. */
const PORT = 0;

/* Long enough that "the dictionaries cannot possibly be here yet" is a fact
   rather than a hope on a loaded machine. */
const LOCALES_DELAY_MS = 1800;
/* Sampled while the delay is still running. */
const EARLY_SAMPLE_MS = 400;
/* Ceiling for the post-arrival poll. */
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

/** Nav link labels, in DOM order. The subject of every assertion below. */
function readNav(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#navLinks a")).map((a) => a.textContent.trim())
  );
}

/**
 * Poll until the nav shows the Spanish labels, or give up.
 * Returns the last sample either way so a failure can print what it saw.
 */
async function waitForSpanishNav(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    last = await readNav(page);
    if (last.includes("Tienda")) return last;
    if (Date.now() > deadline) return last;
    await sleep(100);
  }
}

/* The three nav labels that actually have Spanish entries in
   assets/data/locales/es.json. "Home" and "Our Story" deliberately are not
   asserted: they have no es entry, so demanding them would be asserting a
   coverage level the dictionaries do not claim. */
const EXPECTED_ES = { Shop: "Tienda", Events: "Eventos", Contact: "Contacto" };

async function main() {
  const server = await createServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n=== Translator script-order race regression (${base}) ===\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    /* ------------------------------------------------------------------
       Scenario A — the shipped page, with locales-data.js held back.
       ------------------------------------------------------------------ */
    console.log("Scenario A: /?lang=es with locales-data.js delayed 1800ms");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();

      let localesRequests = 0;
      let localesReleasedAt = 0;
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (req.url().includes("/assets/js/locales-data.js")) {
          localesRequests++;
          setTimeout(() => {
            localesReleasedAt = Date.now();
            req.continue().catch(() => {});
          }, LOCALES_DELAY_MS);
          return;
        }
        req.continue().catch(() => {});
      });

      const startedAt = Date.now();
      await page.goto(`${base}/?lang=es`, { waitUntil: "domcontentloaded" });

      /* Harness control. If this ever passes trivially -- because the
         interception silently stopped matching, or the page stopped requesting
         the dictionaries at all -- every assertion after it would be
         meaningless. So assert the subject first. */
      await sleep(EARLY_SAMPLE_MS);
      const earlyNav = await readNav(page);
      check(
        "control: the page requested locales-data.js (interception is live)",
        localesRequests > 0,
        `saw ${localesRequests} requests`
      );
      check(
        "control: nav has links to assert over",
        earlyNav.length >= 5,
        `found ${earlyNav.length}`
      );
      check(
        "control: locales-data.js is still in flight at the early sample",
        localesReleasedAt === 0,
        `released ${localesReleasedAt - startedAt}ms in`
      );
      check(
        "control: nav is still English while the dictionaries are in flight",
        earlyNav.includes("Shop") && !earlyNav.includes("Tienda"),
        JSON.stringify(earlyNav)
      );

      /* The actual regression. Before the fix this stayed English forever:
         translator.js had already run against an empty dictionary. */
      const settledNav = await waitForSpanishNav(page, SETTLE_TIMEOUT_MS);
      check(
        "nav is Spanish once the delayed dictionaries land",
        settledNav.includes("Tienda"),
        JSON.stringify(settledNav)
      );
      Object.keys(EXPECTED_ES).forEach((en) => {
        check(
          `nav "${en}" became "${EXPECTED_ES[en]}"`,
          settledNav.includes(EXPECTED_ES[en]) && !settledNav.includes(en),
          JSON.stringify(settledNav)
        );
      });

      const state = await page.evaluate(() => ({
        current: window.YL_TRANSLATOR ? window.YL_TRANSLATOR.getCurrentLanguage() : null,
        localesLoaded: !!window.YL_LOCALES,
        htmlLang: document.documentElement.getAttribute("lang"),
        badge: (document.querySelector(".lang-current-code") || {}).textContent || null,
        shopLinkLang: (() => {
          const a = Array.from(document.querySelectorAll("#navLinks a")).find(
            (x) => x.textContent.trim() === "Tienda"
          );
          return a ? a.getAttribute("lang") : null;
        })()
      }));
      check("engine reports es", state.current === "es", JSON.stringify(state));
      check("dictionaries did arrive", state.localesLoaded === true, JSON.stringify(state));
      check("header badge reads ES", state.badge === "ES", JSON.stringify(state));
      /* Coverage is partial, so the DOCUMENT stays English (WCAG 3.1.1) and
         only the replaced elements are marked. See translator.test.js. */
      check(
        'document lang stays "en" while coverage is partial',
        state.htmlLang === "en",
        JSON.stringify(state)
      );
      check(
        'the translated nav link is marked lang="es"',
        state.shopLinkLang === "es",
        JSON.stringify(state)
      );

      /* Ordered execution is the primary fix; prove the scripts are actually
         tagged for it rather than inferring it from the outcome. */
      const asyncFlags = await page.evaluate(() =>
        Array.from(document.querySelectorAll("script"))
          .filter(
            (s) =>
              (s.src || "").includes("/assets/js/locales-data.js") ||
              (s.src || "").includes("/assets/js/translator.js")
          )
          .map((s) => ({ src: s.src.split("/").pop(), async: s.async }))
      );
      check(
        "both injected scripts exist in the DOM",
        asyncFlags.length === 2,
        JSON.stringify(asyncFlags)
      );
      check(
        "both injected scripts carry async=false (ordered execution)",
        asyncFlags.length === 2 && asyncFlags.every((s) => s.async === false),
        JSON.stringify(asyncFlags)
      );

      await context.close();
    }

    /* ------------------------------------------------------------------
       Scenario B — the recovery path, exercised directly.
       Scenario A can no longer produce the bad ordering (that is the point of
       async=false), so the second half of the fix -- init() arming
       waitForLocales() instead of translating against nothing -- is driven
       here against the shipped engine.
       ------------------------------------------------------------------ */
    console.log("\nScenario B: YL_LOCALES arrives after init() has already run");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });

      const ready = await page.evaluate(
        () => !!(window.YL_TRANSLATOR && window.YL_LOCALES && document.querySelector("#navLinks a"))
      );
      check("control: engine, dictionaries and nav are present to work with", ready === true);

      /* Take the dictionaries away, ask for Spanish, and re-run init() -- the
         exact state a losing script race used to leave the page in. */
      const afterInit = await page.evaluate(() => {
        window.__ylStash = window.YL_LOCALES;
        delete window.YL_LOCALES;
        window.YL_TRANSLATOR._resetInternalState();
        try {
          localStorage.setItem("yl-lang", "es");
        } catch {
          /* ignore */
        }
        window.YL_TRANSLATOR.init();
        return {
          nav: Array.from(document.querySelectorAll("#navLinks a")).map((a) =>
            a.textContent.trim()
          ),
          htmlLang: document.documentElement.getAttribute("lang")
        };
      });
      check(
        "init() with no dictionaries leaves the nav English",
        afterInit.nav.includes("Shop") && !afterInit.nav.includes("Tienda"),
        JSON.stringify(afterInit.nav)
      );
      check(
        'init() with no dictionaries does not claim lang="es"',
        afterInit.htmlLang === "en",
        JSON.stringify(afterInit)
      );

      /* Now the dictionaries turn up. */
      await page.evaluate(() => {
        window.YL_LOCALES = window.__ylStash;
      });
      const recoveredNav = await waitForSpanishNav(page, SETTLE_TIMEOUT_MS);
      check(
        "late dictionaries re-run init() and translate the nav",
        recoveredNav.includes("Tienda"),
        JSON.stringify(recoveredNav)
      );
      const recoveredLang = await page.evaluate(() => window.YL_TRANSLATOR.getCurrentLanguage());
      check("engine reports es after recovery", recoveredLang === "es", recoveredLang);

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
  /* An empty run is a failure, not a pass: if the scenarios above ever stop
     executing, this is what says so. */
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
