/**
 * @fileoverview Scroll-reveal regression gate.
 *
 * about.html once rendered as a header, a headline and a blank white expanse
 * for as long as it took a 165KB deferred main.js to arrive. `.reveal` carried
 * `opacity:0` in CSS unconditionally and only main.js could undo it, so every
 * revealed section was invisible until the script landed -- and about.html is
 * the page where that shows worst, because everything below its hero is
 * `.reveal` and nothing else is. On a slow connection it read as a broken page.
 *
 * The rule this gate exists to hold: content the browser has already painted is
 * never hidden afterwards, and content is never left waiting on a script to
 * become visible. The scroll animation itself is a bonus on top of that, so it
 * is asserted too -- a "fix" that deletes the animation is also a regression.
 *
 * IMPORTANT -- why this file spoofs navigator.webdriver:
 * main.js skips the IntersectionObserver entirely when navigator.webdriver is
 * true, marking every element visible at once. Every other Puppeteer suite in
 * this repo therefore exercises none of the reveal logic, which is why the
 * original bug shipped with a full green board. Each page here is opened with
 * navigator.webdriver forced to false, and assertReal() below fails the run if
 * that spoof ever stops working -- otherwise these checks would pass vacuously
 * while testing nothing, which is worse than not having them.
 *
 * Manages its own static server on port 8085, so nothing external needs to be
 * running first.
 *
 * Run: node scripts/reveal-check.js
 */

/* global document, window, navigator, getComputedStyle, scrollY */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 8085;
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

/* Pages whose above-the-fold content is server-rendered .reveal markup.
   about.html is the original offender and the reason this file exists. */
const PAGES = ["about.html", "index.html", "shop.html", "events.html", "contact.html"];

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? " -- " + detail : ""}`);
    console.log(`  ✗ ${name}${detail ? " -- " + detail : ""}`);
  }
}

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

async function newPage(browser, viewport) {
  const page = await browser.newPage();
  // See the file header: without this, main.js short-circuits and this whole
  // suite tests nothing.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setViewport(viewport || { width: 1280, height: 800 });
  return page;
}

/* Elements a reader can actually see: at least a quarter of the box inside the
   viewport. A card peeking a few pixels over the fold is legitimately still
   waiting to animate in, and must not be counted as broken. */
const HIDDEN_BUT_VISIBLE = `[...document.querySelectorAll('.reveal')].filter(function (el) {
    var r = el.getBoundingClientRect();
    if (!r.height) return false;
    var shown = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return shown / r.height > 0.25 && getComputedStyle(el).opacity !== '1';
  }).map(function (el) { return el.className; })
`;

async function hiddenButVisible(page) {
  return page.evaluate(`(function(){ return ${HIDDEN_BUT_VISIBLE}; })()`);
}

/* Fails the run if the webdriver spoof stopped working, rather than letting
   every later assertion pass for the wrong reason. */
async function assertReal(page, label) {
  const real = await page.evaluate(() => navigator.webdriver === false);
  check(
    `${label}: reveal logic actually ran (webdriver spoof holding)`,
    real,
    "navigator.webdriver is true, main.js skipped the observer"
  );
  return real;
}

(async () => {
  console.log("Starting scroll-reveal regression gate...\n");
  const server = await createStaticServer();
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  try {
    /* ---- 1. The original bug: main.js never arrives at all ----
       The strongest form of the regression. Under the old CSS this page was
       guaranteed blank below the hero; content must not depend on the script. */
    {
      console.log("main.js blocked entirely (the original about.html failure):");
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on("request", (r) => (r.url().includes("/main.js") ? r.abort() : r.continue()));
      await page.goto(`${BASE}/about.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);
      const story = await page.evaluate(() => {
        // The first .reveal here is the photo frame; the copy lives in the
        // second column, so measure the section as a whole.
        const section = document.querySelector(".about-founder");
        const el = document.querySelector(".about-founder .reveal");
        return {
          opacity: el ? getComputedStyle(el).opacity : null,
          words: section ? (section.innerText || "").trim().split(/\s+/).filter(Boolean).length : 0
        };
      });
      check(
        "about.html story is visible with no main.js",
        story.opacity === "1",
        `opacity=${story.opacity}`
      );
      check("about.html story actually has its copy", story.words > 50, `${story.words} words`);
      await page.close();
    }

    /* ---- 2. Slow load: script lands well after first paint ----
       main.js must not hide content the reader is already looking at. */
    {
      console.log("\nmain.js delayed until after first paint:");
      for (const pageName of PAGES) {
        const page = await newPage(browser);
        await page.setRequestInterception(true);
        page.on("request", async (r) => {
          if (r.url().includes("/main.js")) await sleep(1500);
          r.continue();
        });
        // Sample every frame so a flash of hidden content is caught, not just
        // the settled end state.
        await page.evaluateOnNewDocument(() => {
          window.__minOpacity = 1;
          const tick = () => {
            document.querySelectorAll(".reveal").forEach((el) => {
              const r = el.getBoundingClientRect();
              if (!r.height) return;
              const shown = Math.max(
                0,
                Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
              );
              if (shown / r.height > 0.25) {
                const o = parseFloat(getComputedStyle(el).opacity);
                if (o < window.__minOpacity) window.__minOpacity = o;
              }
            });
            window.requestAnimationFrame(tick);
          };
          window.requestAnimationFrame(tick);
        });
        await page.goto(`${BASE}/${pageName}`, { waitUntil: "networkidle2", timeout: 90000 });
        await sleep(1200);
        if (await assertReal(page, pageName)) {
          const stillHidden = await hiddenButVisible(page);
          check(
            `${pageName}: nothing on screen left hidden`,
            stillHidden.length === 0,
            stillHidden.join(", ")
          );
          const min = await page.evaluate(() => window.__minOpacity);
          check(
            `${pageName}: on-screen content never blinked out (min opacity ${min.toFixed(2)})`,
            min > 0.9,
            `dropped to ${min}`
          );
        }
        await page.close();
      }
    }

    /* ---- 3. Fast load: the entrance animation still plays ----
       Guarding only against hidden content would be satisfied by deleting the
       animation, so assert it survives: nothing painted yet at wire-up time
       means every element is armed first and transitions in. */
    {
      console.log("\nNormal load (entrance animation preserved):");
      const page = await newPage(browser);
      await page.evaluateOnNewDocument(() => {
        window.__atDCL = null;
        document.addEventListener("DOMContentLoaded", () => {
          const el = document.querySelector(".reveal");
          window.__atDCL = {
            paintEntries: performance.getEntriesByType("paint").length,
            armed: el ? el.className.indexOf("reveal-armed") !== -1 : null
          };
        });
      });
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(1200);
      if (await assertReal(page, "index.html")) {
        const dcl = await page.evaluate(() => window.__atDCL);
        check(
          "index.html: main.js wires reveals before first paint",
          dcl && dcl.paintEntries === 0,
          `paint entries = ${dcl && dcl.paintEntries}`
        );
        check(
          "index.html: above-fold elements are armed, so they animate in",
          dcl && dcl.armed === true,
          "first .reveal was not armed"
        );
        const settled = await hiddenButVisible(page);
        check(
          "index.html: animation completes, nothing left hidden",
          settled.length === 0,
          settled.join(", ")
        );
      }
      await page.close();
    }

    /* ---- 4. Below the fold still animates on scroll, and nothing strands ---- */
    {
      console.log("\nScrolling the page (below-fold reveals):");
      for (const pageName of ["about.html", "index.html"]) {
        const page = await newPage(browser);
        await page.goto(`${BASE}/${pageName}`, { waitUntil: "networkidle2", timeout: 90000 });
        await sleep(900);
        if (!(await assertReal(page, pageName))) {
          await page.close();
          continue;
        }
        const armed = await page.evaluate(
          () => document.querySelectorAll(".reveal-armed:not(.in)").length
        );
        check(`${pageName}: below-fold content is armed to animate`, armed > 0, `${armed} armed`);
        const height = await page.evaluate(() => document.body.scrollHeight);
        for (let y = 0; y <= height; y += 400) {
          await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
          await sleep(110);
        }
        await sleep(900);
        const stranded = await page.evaluate(() =>
          [...document.querySelectorAll(".reveal")]
            .filter(
              (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).opacity !== "1"
            )
            .map((el) => el.className + " @" + Math.round(el.getBoundingClientRect().top + scrollY))
        );
        check(
          `${pageName}: every reveal fires once scrolled past`,
          stranded.length === 0,
          stranded.join(", ")
        );
        await page.close();
      }
    }

    /* ---- 5. Mobile: the viewport most exposed to a slow main.js ---- */
    {
      console.log("\nMobile 375x667, main.js delayed:");
      const page = await newPage(browser, {
        width: 375,
        height: 667,
        isMobile: true,
        hasTouch: true
      });
      await page.setRequestInterception(true);
      page.on("request", async (r) => {
        if (r.url().includes("/main.js")) await sleep(1500);
        r.continue();
      });
      await page.goto(`${BASE}/about.html`, { waitUntil: "networkidle2", timeout: 90000 });
      await sleep(1200);
      if (await assertReal(page, "about.html mobile")) {
        const stillHidden = await hiddenButVisible(page);
        check(
          "about.html mobile: nothing on screen left hidden",
          stillHidden.length === 0,
          stillHidden.join(", ")
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log("\n==================================================");
  if (failures.length) {
    console.log(`Scroll-reveal gate FAILED: ${failures.length} check(s) failed, ${passed} passed.`);
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log("==================================================");
    process.exit(1);
  }
  console.log(`Scroll-reveal gate PASSED: ${passed} checks.`);
  console.log("==================================================");
})().catch((err) => {
  console.error("Scroll-reveal gate crashed:", err);
  process.exit(1);
});
