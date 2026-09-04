/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for the folded-in announcement bar (rendered
 * audit M3): the free-shipping segment main.js appends to #yl-countdown-ticker
 * hides itself below 1100px via a measured CSS floor (see .announcement-bar
 * in styles.css), but the countdown string it shares the bar with carries a
 * CMS-authored event name and location. "Spartanburg Punk Flea Market
 * (Spartanburg, SC)" wrapped the bar to two lines from 1101px up to 1327px --
 * no fixed breakpoint can guess every future event name, so main.js instead
 * measures the actual rendered bar (after every countdown update, and on
 * resize, debounced) and adds an `is-crowded` class that hides the same two
 * elements the ≤1100px rule does.
 *
 * This drives the real page (index.html, which ships the countdown ticker
 * statically) at four widths from just past the old 1100px floor up past
 * where a long name used to wrap, injects long event names, and asserts the
 * bar never grows past one line.
 *
 * Run: node scripts/announcement-bar-crowding.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

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
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml"
};

function createServer() {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (
      !filePath.startsWith(ROOT) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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
    const msg = `  ✗ ${desc}${extra ? " -- " + extra : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

/* Both names are FIXTURES, deliberately not read from events.json.
   
   The visibility half of this suite used to run against whatever event the
   CMS happened to ship next, which made it a test of Savanna's calendar
   rather than of the crowding logic: on 2026-09-04 she added "Boomtown Arts
   & Heritage FestAVL (Asheville, NC)" (46 chars), the bar legitimately ran
   out of room at 1101px, the segment was correctly hidden -- and this suite
   went red reporting a bug that did not exist. A gate that fails when the
   shop books a market with a long name is not measuring the code.
   
   So both halves inject their own name now. SHORT_NAME must leave the
   segment visible (that is what catches `is-crowded` sticking on, the
   regression this suite exists for -- a hidden segment can never wrap, so
   the one-line assertion alone would pass vacuously). LONG_NAME must not
   wrap the bar. Neither depends on the calendar. */
const SHORT_NAME = "Faire";
const SHORT_LOCATION = "Landrum, SC";
const LONG_NAME = "Spartanburg Punk Flea Market";
const LONG_LOCATION = "Spartanburg, SC";
const WIDTHS = [1101, 1200, 1327, 1440];

async function run() {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto(base + "/index.html", { waitUntil: "networkidle2", timeout: 45000 });

      const before = await page.evaluate(() => {
        const bar = document.getElementById("yl-countdown-ticker");
        if (!bar) return null;
        return {
          hasSegment: !!bar.querySelector(".announcement-segment"),
          height: bar.getBoundingClientRect().height
        };
      });
      if (!before) {
        check(`@${width}px: #yl-countdown-ticker exists`, false, "element missing from index.html");
        continue;
      }
      if (!before.hasSegment) {
        // The free-shipping segment did not fold in on this run (e.g. no
        // threshold configured) -- nothing for the crowding logic to guard,
        // so there is nothing to assert at this width.
        check(`@${width}px: skipped, no .announcement-segment folded in`, true);
        continue;
      }

      // The regression this suite missed on its first day: the crowding
      // check compared the bar's padded height with a bare 14px line box, so
      // `is-crowded` was stuck on and the free-shipping segment was hidden
      // at EVERY width on the home page -- and this suite passed, because a
      // hidden segment cannot wrap. With a name short enough to leave room,
      // the segment must be visible and the bar one line at every width the
      // ≤1100px CSS rule does not already cover.
      await page.evaluate(
        (name, location) => {
          const nameEl = document.getElementById("heroEventDetails");
          if (nameEl) nameEl.textContent = name + " (" + location + ")";
          window.dispatchEvent(new Event("resize"));
        },
        SHORT_NAME,
        SHORT_LOCATION
      );
      await new Promise((resolve) => setTimeout(resolve, 400));

      const normal = await page.evaluate(() => {
        const bar = document.getElementById("yl-countdown-ticker");
        const seg = bar.querySelector(".announcement-segment");
        return {
          isCrowded: bar.classList.contains("is-crowded"),
          height: bar.getBoundingClientRect().height,
          segmentVisible:
            !!seg &&
            seg.getBoundingClientRect().width > 0 &&
            getComputedStyle(seg).display !== "none"
        };
      });
      if (width > 1100) {
        check(
          `@${width}px: with a short event name the free-shipping segment is visible on one line`,
          normal.segmentVisible && normal.height < 60,
          `height=${normal.height}px, is-crowded=${normal.isCrowded}, segmentVisible=${normal.segmentVisible}`
        );
      }

      // Inject the long name/location a real CMS event could carry, the same
      // way initCountdownTicker()'s update() would (textContent, not
      // innerHTML), then force the same debounced resize path production
      // relies on -- rather than reaching into main.js's closure directly.
      await page.evaluate(
        (name, location) => {
          const nameEl = document.getElementById("heroEventDetails");
          if (nameEl) nameEl.textContent = name + " (" + location + ")";
          window.dispatchEvent(new Event("resize"));
        },
        LONG_NAME,
        LONG_LOCATION
      );
      // Debounce is 150ms; give it margin.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const after = await page.evaluate(() => {
        const bar = document.getElementById("yl-countdown-ticker");
        const seg = bar.querySelector(".announcement-segment");
        return {
          isCrowded: bar.classList.contains("is-crowded"),
          height: bar.getBoundingClientRect().height,
          segmentVisible:
            !!seg &&
            seg.getBoundingClientRect().width > 0 &&
            getComputedStyle(seg).display !== "none"
        };
      });

      // One line at 0.75rem/1.2 line-height plus the bar's own padding is
      // ~38px (see .announcement-bar min-height in styles.css); two lines
      // roughly doubles that. 60px is comfortably below "two lines" and
      // comfortably above rounding/sub-pixel noise on one.
      check(
        `@${width}px: bar stays one line with the long event name ("${LONG_NAME}")`,
        after.height < 60,
        `height=${after.height}px, is-crowded=${after.isCrowded}, segmentVisible=${after.segmentVisible}`
      );
      if (after.height >= 60) {
        check(`@${width}px: is-crowded was added`, after.isCrowded);
        check(`@${width}px: the free-shipping segment is hidden`, !after.segmentVisible);
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================");
  console.log(`announcement-bar-crowding.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN announcement-bar-crowding.browser.test.js:", err);
  process.exit(1);
});
