/**
 * @fileoverview Cross-browser regression gate (Chromium, Firefox, WebKit).
 *
 * Every other browser suite in this repo drives Puppeteer, which means
 * Chromium and only Chromium. That is a real blind spot for a static site
 * whose audience is mostly phones: the engine most likely to behave
 * differently -- WebKit, i.e. Safari and every browser on iOS -- was never
 * exercised at all.
 *
 * This gate runs the behaviour that actually broke on all three engines via
 * Playwright, plus mobile Safari and mobile Chrome device profiles:
 *
 *   - about.html renders its story with main.js blocked outright. `.reveal`
 *     used to carry `opacity:0` in CSS with only a 165KB deferred main.js able
 *     to undo it, so this page was a headline over a blank expanse until the
 *     script landed.
 *   - main.js arriving late never hides content already on screen. Opacity is
 *     sampled every frame, so a one-frame flash fails the run rather than
 *     hiding behind a settled end state.
 *   - the scroll animation still plays: below-fold elements are armed and fire
 *     as they scroll into view. "Fixing" hidden content by deleting the
 *     animation has to fail too.
 *   - the pride underline is a hover affordance, not a page-load badge: flat on
 *     every nav link at rest including the current page, drawn on the hovered
 *     one only.
 *   - the same, with the Paint Timing API removed, standing in for a browser
 *     too old to report paints. main.js feature-detects that and takes the
 *     protective branch; this proves it on each engine rather than on Chromium
 *     alone.
 *
 * Like scripts/reveal-check.js, every context forces navigator.webdriver to
 * false, because main.js skips the IntersectionObserver entirely when it is
 * true -- without that these checks would pass while testing nothing. Each
 * engine asserts the spoof held.
 *
 * Third-party subresources (fonts, analytics, chat, translate) are aborted:
 * they are not under test and a hung external request would stall the run.
 *
 * Requires the Playwright engines, which are NOT installed by `npm install`:
 *     npx playwright install --with-deps chromium firefox webkit
 * A missing engine fails the run rather than skipping quietly -- a gate that
 * silently covers one engine instead of three is worse than no gate.
 *
 * Manages its own static server on port 8086, so nothing external needs to be
 * running first.
 *
 * Run: node scripts/cross-browser-check.js
 */

/* global document, window, navigator, getComputedStyle, CSS */

const http = require("http");
const fs = require("fs");
const path = require("path");

let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  console.error("Cross-browser gate cannot run: the 'playwright' package is not installed.");
  console.error("  npm install");
  console.error("  npx playwright install --with-deps chromium firefox webkit");
  process.exit(1);
}

const PORT = 8086;
const ROOT = path.resolve(__dirname, "..");
const BASE = `http://127.0.0.1:${PORT}`;

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
  ".webmanifest": "application/manifest+json"
};

function createStaticServer() {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(ROOT, reqPath);
    if (
      !filePath.startsWith(ROOT) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Playwright normally ships its own Chromium and resolving it is its job, not
   ours -- in CI this returns {} and Playwright is simply right. Some
   environments (including the container this repo's web sessions run in)
   pre-install a Chromium at a different revision under
   PLAYWRIGHT_BROWSERS_PATH, which Playwright declines to use. Only then do we
   go looking, and only for a binary Playwright's own expected path did not
   provide: hard-coding a layout here would silently pin the wrong build the
   day Playwright changes it (it already moved chrome-linux -> chrome-linux64). */
function chromiumLaunchOptions() {
  try {
    if (fs.existsSync(playwright.chromium.executablePath())) return {};
  } catch (e) {
    /* no resolvable default -- fall through and look for one */
  }
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath || !fs.existsSync(browsersPath)) return {};
  const candidate = fs
    .readdirSync(browsersPath)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse()
    .flatMap((d) => [
      path.join(browsersPath, d, "chrome-linux64", "chrome"),
      path.join(browsersPath, d, "chrome-linux", "chrome")
    ])
    .find((p) => fs.existsSync(p));
  return candidate ? { executablePath: candidate } : {};
}

const ENGINES = [
  { name: "Chromium", type: () => playwright.chromium, options: chromiumLaunchOptions },
  { name: "Firefox", type: () => playwright.firefox, options: () => ({}) },
  { name: "WebKit", type: () => playwright.webkit, options: () => ({}) }
];

/* Sample opacity every frame: a fix that flashes hidden content for one frame
   is still a regression, and the settled end state would not show it. */
const FRAME_SAMPLER = () => {
  window.__minOpacity = 1;
  // Counted so the assertions can tell "never dropped below 1" apart from
  // "never looked at anything". An unsampled run reports a perfect score.
  window.__sampleCount = 0;
  const tick = () => {
    document.querySelectorAll(".reveal").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.height) return;
      const shown = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (shown / r.height > 0.25) {
        window.__sampleCount++;
        const o = parseFloat(getComputedStyle(el).opacity);
        if (o < window.__minOpacity) window.__minOpacity = o;
      }
    });
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
};

/* Stand in for a browser too old to report paints. An unimplemented entry type
   returns an empty array rather than throwing, so main.js asks
   supportedEntryTypes first -- both halves are stubbed here to match. */
const REMOVE_PAINT_TIMING = () => {
  try {
    const original = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = (t) => (t === "paint" ? [] : original(t));
    Object.defineProperty(PerformanceObserver, "supportedEntryTypes", {
      get: () => ["mark", "measure", "navigation", "resource"]
    });
  } catch (e) {
    /* engine would not let us stub it; the probe below reports what it saw */
  }
};

async function makeContext(browser, opts) {
  opts = opts || {};
  const context = await browser.newContext(
    Object.assign({ viewport: { width: 1280, height: 800 } }, opts.device || {})
  );
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    } catch (e) {
      /* reported by the spoof assertion below */
    }
  });
  if (opts.killPaintTiming) await context.addInitScript(REMOVE_PAINT_TIMING);
  if (opts.sampleFrames) await context.addInitScript(FRAME_SAMPLER);
  await context.route("**/*", (route) =>
    route.request().url().startsWith(BASE) ? route.continue() : route.abort()
  );
  return context;
}

const HIDDEN_BUT_VISIBLE = () =>
  [...document.querySelectorAll(".reveal")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.height) return false;
      const shown = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      return shown / r.height > 0.25 && getComputedStyle(el).opacity !== "1";
    })
    .map((el) => el.className);

const FLAT = (t) => t === "matrix(0, 0, 0, 1, 0, 0)" || t === "none";

async function runEngine(engine, check, log) {
  const browser = await engine.type().launch(engine.options());
  log(`\n### ${engine.name}`);

  try {
    // -- capability probe, printed so a future failure has context
    {
      const context = await makeContext(browser);
      const page = await context.newPage();
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
      const features = await page.evaluate(() => ({
        ua: navigator.userAgent.slice(0, 52),
        paintTiming: (() => {
          try {
            return (PerformanceObserver.supportedEntryTypes || []).includes("paint");
          } catch (e) {
            return "err";
          }
        })(),
        cssNesting: (() => {
          try {
            return CSS.supports("selector(&)");
          } catch (e) {
            return "unknown";
          }
        })(),
        focusVisible: (() => {
          try {
            return CSS.supports("selector(:focus-visible)");
          } catch (e) {
            return "unknown";
          }
        })(),
        io: "IntersectionObserver" in window
      }));
      log(`   features: ${JSON.stringify(features)}`);
      check(`${engine.name}: IntersectionObserver available`, features.io === true, "missing");
      const spoofed = await page.evaluate(() => navigator.webdriver === false);
      check(
        `${engine.name}: reveal logic actually ran (webdriver spoof holding)`,
        spoofed,
        "navigator.webdriver is true, main.js skipped the observer"
      );
      await context.close();
    }

    // -- 1. the original bug: main.js never arrives
    {
      const context = await makeContext(browser);
      const page = await context.newPage();
      await page.route("**/main.js*", (r) => r.abort());
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
      await sleep(1200);
      const story = await page.evaluate(() => {
        const section = document.querySelector(".about-founder");
        const el = document.querySelector(".about-founder .reveal");
        return {
          opacity: el ? getComputedStyle(el).opacity : null,
          words: section ? (section.innerText || "").trim().split(/\s+/).filter(Boolean).length : 0
        };
      });
      check(
        `${engine.name}: about.html renders with main.js blocked`,
        story.opacity === "1" && story.words > 50,
        `opacity=${story.opacity} words=${story.words}`
      );
      await context.close();
    }

    // -- 2. slow main.js, with and without paint timing
    for (const variant of [
      { label: "slow main.js", killPaintTiming: false },
      { label: "slow main.js, no Paint Timing API", killPaintTiming: true }
    ]) {
      const context = await makeContext(browser, {
        sampleFrames: true,
        killPaintTiming: variant.killPaintTiming
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
      await page.route("**/main.js*", async (r) => {
        await sleep(1500);
        r.continue();
      });
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
      await sleep(2600);
      const result = await page.evaluate(() => {
        const el = document.querySelector(".about-founder .reveal");
        return {
          min: window.__minOpacity,
          samples: window.__sampleCount,
          story: el ? getComputedStyle(el).opacity : null,
          armed: document.querySelectorAll(".reveal-armed:not(.in)").length
        };
      });
      const hidden = await page.evaluate(HIDDEN_BUT_VISIBLE);
      check(
        `${engine.name}: ${variant.label} -- opacity was actually sampled`,
        result.samples > 0,
        "the frame sampler saw no on-screen .reveal content, so the check below proves nothing"
      );
      check(
        `${engine.name}: ${variant.label} -- on-screen content never blinked out`,
        result.min > 0.9,
        `min opacity ${result.min}`
      );
      check(
        `${engine.name}: ${variant.label} -- story visible, nothing on screen hidden`,
        result.story === "1" && hidden.length === 0,
        `story=${result.story} hidden=[${hidden.join(", ")}]`
      );
      check(
        `${engine.name}: ${variant.label} -- scroll animation still armed below the fold`,
        result.armed > 0,
        `${result.armed} armed`
      );
      check(
        `${engine.name}: ${variant.label} -- no page errors`,
        errors.length === 0,
        errors.join("; ")
      );
      await context.close();
    }

    // -- 3. below-fold reveals fire on scroll, nothing strands
    {
      const context = await makeContext(browser);
      const page = await context.newPage();
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
      await sleep(1200);
      const armed = await page.evaluate(
        () => document.querySelectorAll(".reveal-armed:not(.in)").length
      );
      check(`${engine.name}: below-fold content armed to animate`, armed > 0, `${armed} armed`);
      const height = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y <= height; y += 400) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await sleep(120);
      }
      await sleep(900);
      const stuck = await page.evaluate(
        () =>
          [...document.querySelectorAll(".reveal")].filter(
            (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).opacity !== "1"
          ).length
      );
      check(`${engine.name}: every reveal fires once scrolled past`, stuck === 0, `${stuck} stuck`);
      await context.close();
    }

    // -- 4. pride underline is a hover affordance, not a page-load badge
    {
      const context = await makeContext(browser);
      const page = await context.newPage();
      // about.html is where "Our Story" is the current page, so this also
      // proves the active link no longer carries a permanent underline.
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
      await sleep(1000);
      const atRest = await page.evaluate(() =>
        [...document.querySelectorAll(".nav-links a")].map(
          (a) => getComputedStyle(a, "::after").transform
        )
      );
      /* every() is true of an empty array, so if `.nav-links a` ever stopped
         matching -- a renamed class, a restructured header -- "flat on every
         link" would pass having examined no links at all. Assert there are
         links before asserting anything about them. */
      check(
        `${engine.name}: nav links found to test`,
        atRest.length >= 3,
        `${atRest.length} matched .nav-links a -- the selector is stale, so the check below proves nothing`
      );
      check(
        `${engine.name}: underline flat at rest on every link incl. current page`,
        atRest.length >= 3 && atRest.every(FLAT),
        JSON.stringify(atRest)
      );
      await page.hover('.nav-links a[href="shop.html"]');
      await sleep(600);
      const hovered = await page.evaluate(() => {
        const links = [...document.querySelectorAll(".nav-links a")];
        const shop = links.find((a) => a.textContent.trim() === "Shop");
        return {
          shop: getComputedStyle(shop, "::after").transform,
          others: links
            .filter((a) => a !== shop)
            .map((a) => getComputedStyle(a, "::after").transform)
        };
      });
      check(
        `${engine.name}: hovered link draws the underline`,
        hovered.shop === "matrix(1, 0, 0, 1, 0, 0)",
        hovered.shop
      );
      check(
        `${engine.name}: other links stay flat while hovering`,
        hovered.others.length > 0 && hovered.others.every(FLAT),
        `${hovered.others.length} other links: ${JSON.stringify(hovered.others)}`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/* The real-world worst case for the original bug: a phone on a slow
   connection. Mobile Safari is the engine no other suite here covers. */
const MOBILE_PROFILES = [
  {
    name: "Mobile Safari",
    type: () => playwright.webkit,
    options: () => ({}),
    device: "iPhone 14"
  },
  {
    name: "Mobile Chrome",
    type: () => playwright.chromium,
    options: chromiumLaunchOptions,
    device: "Pixel 7"
  }
];

async function runMobileProfile(profile, check, log) {
  const descriptor = playwright.devices[profile.device];
  if (!descriptor) {
    check(`${profile.name}: device profile available`, false, `${profile.device} unknown`);
    return;
  }
  const device = Object.assign({}, descriptor);
  delete device.defaultBrowserType;
  const browser = await profile.type().launch(profile.options());
  try {
    const context = await makeContext(browser, { device, sampleFrames: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
    await page.route("**/main.js*", async (r) => {
      await sleep(1500);
      r.continue();
    });
    await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded" });
    await sleep(2600);
    const result = await page.evaluate(() => ({
      min: window.__minOpacity,
      story: getComputedStyle(document.querySelector(".about-founder .reveal")).opacity,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      width: window.innerWidth
    }));
    log(`   ${profile.name} (${result.width}px): min opacity ${result.min.toFixed(2)}`);
    check(
      `${profile.name}: content never hidden on a slow load`,
      result.min > 0.9 && result.story === "1",
      `min ${result.min} story ${result.story}`
    );
    check(`${profile.name}: no horizontal overflow`, !result.hScroll, "page scrolls sideways");
    check(`${profile.name}: no page errors`, errors.length === 0, errors.join("; "));
    await context.close();
  } finally {
    await browser.close();
  }
}

async function executeEngine(engine) {
  const lines = [];
  const failuresList = [];
  let passedCount = 0;

  function localCheck(name, ok, detail) {
    if (ok) {
      passedCount++;
      lines.push(`   ✓ ${name}`);
    } else {
      failuresList.push(`${name}${detail ? " -- " + detail : ""}`);
      lines.push(`   ✗ ${name}${detail ? " -- " + detail : ""}`);
    }
  }

  function localLog(msg) {
    lines.push(msg);
  }

  try {
    await runEngine(engine, localCheck, localLog);
  } catch (e) {
    lines.push(`\n### ${engine.name}`);
    localCheck(
      `${engine.name}: engine available and usable`,
      false,
      `${e.message.split("\n")[0]} -- run: npx playwright install --with-deps chromium firefox webkit`
    );
  }

  return { name: engine.name, lines, passed: passedCount, failures: failuresList };
}

async function executeMobileProfile(profile) {
  const lines = [];
  const failuresList = [];
  let passedCount = 0;

  function localCheck(name, ok, detail) {
    if (ok) {
      passedCount++;
      lines.push(`   ✓ ${name}`);
    } else {
      failuresList.push(`${name}${detail ? " -- " + detail : ""}`);
      lines.push(`   ✗ ${name}${detail ? " -- " + detail : ""}`);
    }
  }

  function localLog(msg) {
    lines.push(msg);
  }

  lines.push(`\n### ${profile.name} (device profile)`);
  try {
    await runMobileProfile(profile, localCheck, localLog);
  } catch (e) {
    localCheck(
      `${profile.name}: device profile available and usable`,
      false,
      `${e.message.split("\n")[0]}`
    );
  }

  return { name: profile.name, lines, passed: passedCount, failures: failuresList };
}

(async () => {
  console.log(
    "Starting parallel cross-browser gate (Chromium, Firefox, WebKit, Mobile Safari, Mobile Chrome)..."
  );
  const server = await createStaticServer();
  try {
    const tasks = [
      ...ENGINES.map((engine) => executeEngine(engine)),
      ...MOBILE_PROFILES.map((profile) => executeMobileProfile(profile))
    ];

    const results = await Promise.all(tasks);

    let totalPassed = 0;
    const allFailures = [];

    results.forEach((res) => {
      console.log(res.lines.join("\n"));
      totalPassed += res.passed;
      allFailures.push(...res.failures);
    });

    console.log("\n" + "=".repeat(50));
    if (allFailures.length) {
      console.log(
        `Cross-browser gate FAILED: ${allFailures.length} check(s) failed, ${totalPassed} passed.`
      );
      allFailures.forEach((f) => console.log(`  - ${f}`));
      console.log("=".repeat(50));
      process.exit(1);
    }
    console.log(
      `Cross-browser gate PASSED: ${totalPassed} checks across 3 engines + 2 device profiles.`
    );
    console.log("=".repeat(50));
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error("Cross-browser gate crashed:", err);
  process.exit(1);
});
