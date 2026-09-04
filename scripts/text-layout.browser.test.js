/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for text layout: headings, button labels and
 * other short strings, measured line box by line box across the viewport range.
 *
 * Two defects this catches, both found by the 2026-09-03 sweep and invisible to
 * every other gate (nothing overflows the page, so the viewport-stress suite is
 * green, and axe has no opinion about where a line breaks):
 *
 * 1. CLIPPED. `.btn` carries `white-space: nowrap` plus `overflow: hidden` (the
 *    latter clips the ::after sheen to the rounded corners), so a label too long
 *    for its button is cut at both ends with no ellipsis and no reflow. On a
 *    320px screen the gift-card CTA "Choose an amount & add to cart" wanted
 *    266px inside a 230px button and lost ~18px off each end. This is a hard
 *    failure: text the shopper cannot read is never acceptable.
 *
 * 2. ORPHANS. A wrapped string whose last line is a stub -- "Y'allternative
 *    Living Unisex T-Shirt" breaking to a 35px line under a 217px one. Fixed
 *    for product cards and FAQ questions with `text-wrap: pretty`; the rest are
 *    held to a budget so the count cannot creep back up.
 *
 * Measuring notes:
 *   - Line boxes come from Range.getClientRects() grouped by VERTICAL OVERLAP,
 *     not by rect.top. A nested <small> sits on the same visual line with a
 *     different top, and bucketing on top alone reports one line as two.
 *   - "Clipped" compares the text against the BORDER box, not the padding box.
 *     Text that spills into its own padding is tight, not cut off; scrollWidth
 *     reports the latter as overflow and is not usable here.
 *   - Anything rendered off-screen is skipped, so the honeypot label ("Leave
 *     this field blank", parked at left: -999px) is not mistaken for overflow.
 *
 * Run: node scripts/text-layout.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

/* Orphan budget: re-measured 2026-09-04 after `text-wrap: balance` landed on
   `.field label`, which cleared the two form labels that had pushed this to 5
   (reviews.html's "Email (private -- we never publish this)" and safety.html's
   "Date the reaction started (optional)"). Lowered 4 -> 3 to lock that in, as
   this gate's own output asks. Every survivor is a string with no better break
   available at that width (an eyebrow at 320px, a variant label naming a
   product whose name is itself longer than the column). Lower it whenever a
   fix removes some; a rise means new copy or a new rule introduced one. */
const ORPHAN_BUDGET = 3;

const PAGES = [
  "/index.html",
  "/shop.html",
  "/about.html",
  "/events.html",
  "/contact.html",
  "/faq.html",
  "/journal.html",
  "/reviews.html",
  "/policies.html",
  "/safety.html",
  "/terms.html",
  "/privacy.html",
  "/order-status.html",
  "/thank-you.html",
  "/welcome.html",
  "/404.html",
  "/products/bug-spray.html",
  "/products/whipped-body-butter.html",
  "/products/yallternative-gift-card.html",
  "/products/unisex-tshirt.html"
];

/* 320 and 375 are where labels run out of button; 1024 is where the product
   grid columns are at their narrowest relative to the type; 1440 is the widest
   the .container ever gets. */
const VIEWPORTS = [320, 375, 430, 768, 1024, 1440];

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
  // Ephemeral port: several suites run in parallel in the integration pool.
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

/** Runs in the page. Returns one entry per string that clips or orphans. */
const COLLECT = function () {
  function lineBoxes(el) {
    // Measure text nodes one at a time so visually-hidden text can be left
    // out: a screen-reader-only span is a 1x1 clipped box, but the text
    // INSIDE it still lays out at full width (the "(opens in new tab)" after
    // "TikTok" measures 125px), and a whole-element range reported a clip
    // that no one can see. A text node is skipped when any ancestor up to
    // the measured element is a clipped box 2px or smaller.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rects = [];
    let node;
    while ((node = walker.nextNode())) {
      let hidden = false;
      for (let a = node.parentElement; a && a !== el; a = a.parentElement) {
        const b = a.getBoundingClientRect();
        if (b.width <= 2 && b.height <= 2) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      Array.from(range.getClientRects()).forEach((r) => {
        if (r.width > 0.5 && r.height > 0.5) rects.push(r);
      });
    }
    rects.sort((a, b) => a.top - b.top);
    const lines = [];
    rects.forEach((rect) => {
      const mid = rect.top + rect.height / 2;
      const hit = lines.find((l) => mid >= l.top && mid <= l.bottom);
      if (hit) {
        hit.top = Math.min(hit.top, rect.top);
        hit.bottom = Math.max(hit.bottom, rect.bottom);
        hit.left = Math.min(hit.left, rect.left);
        hit.right = Math.max(hit.right, rect.right);
      } else {
        lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
      }
    });
    return lines.map((l) => Math.round(l.right - l.left));
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") {
      s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    return s;
  }

  const out = [];
  const PRODUCT_NAMES = new Set(
    ((window.YL_PRODUCTS || {}).products || []).map((p) => p && p.name).filter(Boolean)
  );
  const SELECTOR = "h1,h2,h3,h4,.btn,button,.eyebrow,.tag,figcaption,label,summary,th,dt";
  document.querySelectorAll(SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Hidden by design, in the three shapes this site uses: parked off-screen
    // (the honeypot label at left: -999px), collapsed to a 1px box, or clipped
    // away (.sr-only). None is laid out against a real column, so its line
    // boxes mean nothing -- and a 1px box "clips" all of its text by
    // definition, which would drown the clipping check in false positives.
    if (rect.right <= 0 || rect.left >= window.innerWidth) return;
    if (rect.width <= 2 || rect.height <= 2) return;

    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return;
    if (cs.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(\s*50%/.test(cs.clipPath)) return;

    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 3) return;

    // Text that lives in nested block children is measured on those children.
    // Not inside a flex/grid parent, though: those blockify their children,
    // so a <button class="btn"> (inline-flex) with an <svg> icon computed as
    // having a "block" child and was skipped -- which exempted every icon
    // button and every <summary> from the clipping gate (red-team M-2).
    const ownDisplay = cs.display;
    const blockifies = /flex|grid/.test(ownDisplay);
    const hasBlockChild =
      !blockifies &&
      Array.from(el.children).some((c) => {
        const d = getComputedStyle(c).display;
        return d === "block" || d === "flex" || d === "grid" || d === "list-item";
      });
    if (hasBlockChild) return;

    const lines = lineBoxes(el);
    if (!lines.length) return;
    const widest = Math.max.apply(null, lines);
    const last = lines[lines.length - 1];

    const flags = [];
    if (/hidden|clip/.test(cs.overflowX) && widest > rect.width + 1) flags.push("clipped");
    // Orphans are budgeted for SITE copy. A product name is catalogue data
    // the owner renames in /admin; counting those made a content commit able
    // to turn this gate red (red-team M-3), so a string that is a product
    // name -- alone or with a " -- Size/Scent/Blend" variant suffix -- is
    // measured for clipping but not for orphans.
    // "startsWith": variant labels append " -- Size", and the box-builder's
    // option labels run the name straight into its category and price.
    const isProductName = Array.from(PRODUCT_NAMES).some((n) => text.startsWith(n));
    // A <label> wrapping a control (checkbox rows, the ritual picker cards)
    // is a row, not a run of copy; its "lines" are its parts.
    const isControlRow = el.tagName === "LABEL" && el.querySelector("input,select,textarea");
    if (!isProductName && !isControlRow && lines.length >= 2 && last / widest < 0.3) {
      flags.push("orphan");
    }
    if (!flags.length) return;

    out.push({
      selector: describe(el),
      text: text.slice(0, 60),
      flags: flags,
      lines: lines,
      boxWidth: Math.round(rect.width)
    });
  });
  return out;
};

async function run() {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const clipped = [];
  const orphans = [];
  let browser;
  let renders = 0;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    for (const width of VIEWPORTS) {
      await page.setViewport({ width: width, height: 900, deviceScaleFactor: 1 });
      for (const url of PAGES) {
        await page.goto(base + url, { waitUntil: "networkidle2", timeout: 45000 });
        await page.evaluate(async () => {
          // The scroll reveal parks content at opacity 0 until main.js sees it;
          // un-arm it so every string is laid out, not just what is in view.
          document
            .querySelectorAll(".reveal-armed")
            .forEach((el) => el.classList.remove("reveal-armed"));
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          await new Promise((resolve) => setTimeout(resolve, 120));
        });
        const found = await page.evaluate(COLLECT);
        renders++;
        found.forEach((f) => {
          const entry = Object.assign({ page: url, viewport: width }, f);
          if (f.flags.indexOf("clipped") !== -1) clipped.push(entry);
          if (f.flags.indexOf("orphan") !== -1) orphans.push(entry);
        });
      }
      console.log(`  · ${width}px swept`);
    }
    await page.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n--- Clipped text (${PAGES.length} pages x ${VIEWPORTS.length} viewports) ---`);
  clipped.forEach((c) => {
    console.error(
      `  ${c.page} @${c.viewport}px  ${c.selector}  text ${Math.max.apply(null, c.lines)}px in a ` +
        `${c.boxWidth}px box :: "${c.text}"`
    );
  });
  check(
    `no text is clipped by its own box across ${renders} renders`,
    clipped.length === 0,
    clipped.length ? `${clipped.length} clipped string(s), listed above` : ""
  );

  console.log(`\n--- Orphaned last lines (budget ${ORPHAN_BUDGET}) ---`);
  orphans.forEach((o) => {
    console.log(
      `  ${o.page} @${o.viewport}px  ${o.selector}  ${JSON.stringify(o.lines)} :: "${o.text}"`
    );
  });
  check(
    `orphaned last lines stay within budget (${orphans.length}/${ORPHAN_BUDGET})`,
    orphans.length <= ORPHAN_BUDGET,
    orphans.length > ORPHAN_BUDGET
      ? `${orphans.length - ORPHAN_BUDGET} more than the budget -- fix the new one(s) rather than raising it`
      : ""
  );
  if (orphans.length < ORPHAN_BUDGET) {
    console.log(
      `  note: ${ORPHAN_BUDGET - orphans.length} under budget -- lower ORPHAN_BUDGET to ` +
        `${orphans.length} to lock the improvement in.`
    );
  }

  console.log("\n================================================================");
  console.log(`text-layout.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN text-layout.browser.test.js:", err);
  process.exit(1);
});
