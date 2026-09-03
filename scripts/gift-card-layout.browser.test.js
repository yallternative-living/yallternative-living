/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for the gift-card widget in shop.html
 * (#giftCardModal), covering the 2026-09-03 rendered-audit findings. Every
 * other gate missed these because none of them ever opens this dialog on a
 * phone-width viewport -- text-layout.browser.test.js measures every page at
 * 320-1440px but never clicks `#gift-cards`, so a defect that only exists
 * inside a <dialog> that has to be showModal()'d first sailed through clean.
 *
 * H1 (high): `.btn` is `white-space: nowrap` above 360px, and the block CTA
 * "Add $25 Gift Card to Cart" (and the longer "Add $500 Gift Card to Cart")
 * was wide enough to become the min-content of the `.gift-card-widget`
 * single-column grid track below 768px, forcing the preset row, both text
 * inputs, the CTA and the preview past the card's right edge from ~361px to
 * ~430px wide (21px past the border at 375px). Fixed with `min-width: 0` on
 * the grid column and `minmax(0, 1fr)` on its track, plus unconditional
 * `white-space: normal` on the (always full-width) CTA button.
 *
 * M1 (medium): the amount chip (`.card-amount-large`) was a fixed 29.6px
 * tall, inset a fixed 16px from the card's top-right corner. The artwork
 * (assets/img/gift-card.png, 1024x646 -- measured with sharp) has its
 * "Y'ALLTERNATIVE" wordmark arc starting at 26.5% of the card's height, so
 * a fixed-px chip that fit fine at the ~340px+ preview widths it was tuned
 * for started overlapping the wordmark once the preview -- which shrinks
 * independently of the viewport, since it's a grid column, not the page --
 * dropped under ~260px wide. Fixed by putting the chip's font-size and
 * padding in cqi (a container query on `.gift-card-preview`) and the
 * preview's own inset in %, both of which resolve against the preview's own
 * width; because the preview's aspect-ratio is fixed, that keeps the chip's
 * footprint the same ~15-19% of the card's height at every size, well clear
 * of the 26.5% line, instead of an absolute size that only matched one width.
 *
 * Both checks run at a stack of narrow widths (H1's own failure band was
 * ~361-430px) and with the widest preset amount selected, since a narrower
 * label would have hidden H1 even in the affected band.
 *
 * Run: node scripts/gift-card-layout.browser.test.js
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

// H1's own failure band, plus the boundaries the finding named explicitly.
const H1_WIDTHS = [361, 375, 390, 400, 410, 420, 430];

// M1's target preview widths span a stacked-mobile card up through a
// two-column layout's narrower one; the viewports below are chosen (and
// verified in the fix) to land the *rendered preview element* near each.
const M1_VIEWPORTS = [320, 806];

/** Dial the widget to its widest CTA label ("Add $500 Gift Card to Cart")
 * so a narrower amount can't hide an overflow that only shows up at $500. */
async function selectFiveHundred(page) {
  await page.evaluate(() => {
    const customBtn = document.getElementById("customPresetBtn");
    if (customBtn) customBtn.click();
    const input = document.getElementById("customGiftAmount");
    if (input) {
      input.value = "500";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** Navigating to the SAME document with only the hash changed is a
 * same-document navigation Chrome does not re-run scripts for, so the
 * modal's "open on load if the hash is #gift-cards" check
 * (assets/js/main.js) never fires on a second `page.goto` to the same
 * page. Each check below opens a fresh page and navigates to the
 * hash-bearing URL as its FIRST navigation -- this is the gap that let H1
 * ship: no other suite opens this dialog at all. */
async function openGiftModal(browser, base, width) {
  const page = await browser.newPage();
  // Puppeteer pages in the same browser share localStorage per origin, so a
  // later M4 (i18n) page in this run would otherwise leak its "yl-lang" into
  // every check that runs after it. Force English so H1/M1/L3 -- which are
  // about the default copy, not translation -- always see it regardless of
  // what ran before.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.removeItem("yl-lang");
    } catch {
      /* ignore */
    }
  });
  await page.setViewport({ width, height: 1200, deviceScaleFactor: 1 });
  await page.goto(base + "/shop.html#gift-cards", { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector("#giftCardModal[open]", { timeout: 5000 });
  return page;
}

async function run() {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // ---- H1: no horizontal overflow, at $25 and at the widest label ----
    for (const width of H1_WIDTHS) {
      for (const amount of ["25", "500"]) {
        const page = await openGiftModal(browser, base, width);
        if (amount === "500") await selectFiveHundred(page);

        const result = await page.evaluate(() => {
          const modal = document.getElementById("giftCardModal");
          const cs = getComputedStyle(modal);
          const modalRect = modal.getBoundingClientRect();
          const contentRight =
            modalRect.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);

          const controls = [
            ...modal.querySelectorAll(
              ".gift-card-widget button, .gift-card-widget input, .gift-card-widget textarea, .gift-card-widget .preset-btn, .gift-card-widget .custom-amount-input-wrap"
            )
          ];
          const overflowing = controls
            .map((el) => {
              const r = el.getBoundingClientRect();
              return {
                sel: el.id || el.className || el.tagName,
                right: Math.round(r.right),
                over: Math.round((r.right - contentRight) * 10) / 10
              };
            })
            .filter((c) => c.over > 0.5);

          return {
            scrollWidth: modal.scrollWidth,
            clientWidth: modal.clientWidth,
            overflowing,
            ctaText: (document.getElementById("addGiftCardBtnText") || {}).textContent
          };
        });

        await page.close();

        check(
          `H1: #giftCardModal has no horizontal overflow at ${width}px wide ($${amount} selected, CTA "${result.ctaText}")`,
          result.scrollWidth <= result.clientWidth,
          `scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}`
        );
        check(
          `H1: no control right edge passes the card's content box at ${width}px ($${amount})`,
          result.overflowing.length === 0,
          result.overflowing.length ? JSON.stringify(result.overflowing) : ""
        );
      }
    }

    // ---- M1: the amount chip never reaches the artwork's wordmark arc ----
    // Measured against assets/img/gift-card.png (1024x646) with sharp: the
    // "Y'ALLTERNATIVE" wordmark's topmost ink sits at 26.5% of the card's
    // height. Give real margin (not just "doesn't touch") since font
    // rendering and sub-pixel rounding vary by platform.
    const WORDMARK_TOP_FRACTION = 0.265;
    const REQUIRED_CLEARANCE = 0.05; // at least 5 points of headroom below the line

    for (const width of M1_VIEWPORTS) {
      const page = await openGiftModal(browser, base, width);
      const result = await page.evaluate(() => {
        const preview = document.getElementById("giftCardPreview");
        const chip = document.getElementById("giftCardAmountDisplay");
        const previewRect = preview.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        return {
          previewWidth: previewRect.width,
          chipBottomFraction: (chipRect.bottom - previewRect.top) / previewRect.height
        };
      });
      await page.close();

      check(
        `M1: amount chip clears the wordmark arc with margin at viewport ${width}px (preview ~${Math.round(result.previewWidth)}px wide)`,
        result.chipBottomFraction <= WORDMARK_TOP_FRACTION - REQUIRED_CLEARANCE,
        `chip bottom at ${(result.chipBottomFraction * 100).toFixed(1)}% of card height, ` +
          `wordmark starts at ${(WORDMARK_TOP_FRACTION * 100).toFixed(1)}%`
      );
    }

    // ---- M4: preset grid columns stay equal even with a long translated
    // label ("Personalizado" / "Personnalisé" / "カスタム"), and nothing clips.
    for (const lang of ["es", "fr", "ja"]) {
      for (const width of [320, 360, 390]) {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument((l) => {
          try {
            localStorage.setItem("yl-lang", l);
          } catch {
            /* ignore */
          }
        }, lang);
        await page.setViewport({ width, height: 1200, deviceScaleFactor: 1 });
        await page.goto(base + "/shop.html#gift-cards", {
          waitUntil: "networkidle2",
          timeout: 45000
        });
        await page.waitForSelector("#giftCardModal[open]", { timeout: 5000 });

        const result = await page.evaluate(() => {
          const grid = document.querySelector(".preset-grid");
          const btns = grid ? [...grid.querySelectorAll(".preset-btn")] : [];
          const widths = btns.map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10);
          const clipped = btns.filter((b) => b.scrollWidth > b.clientWidth + 1);
          return {
            widths,
            clippedCount: clipped.length,
            customText: (document.getElementById("customPresetBtn") || {}).textContent
          };
        });
        await page.close();

        const distinctWidths = new Set(result.widths);
        check(
          `M4 (${lang} @${width}px): preset-grid columns are equal ("${result.customText.trim()}", widths ${JSON.stringify(result.widths)})`,
          distinctWidths.size <= 1,
          `${distinctWidths.size} distinct widths`
        );
        check(
          `M4 (${lang} @${width}px): no preset button label clips`,
          result.clippedCount === 0,
          `${result.clippedCount} clipped`
        );
      }
    }

    // ---- L3: the tab pills stay on one line at 320/360 ----
    for (const width of [320, 360]) {
      const page = await openGiftModal(browser, base, width);
      const result = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll(".gift-modal-tabs .btn")];
        return tabs.map((t) => ({
          text: t.textContent.trim(),
          scrollWidth: t.scrollWidth,
          clientWidth: t.clientWidth
        }));
      });
      await page.close();

      result.forEach((t) => {
        check(
          `L3: "${t.text}" tab stays on one line at ${width}px`,
          t.scrollWidth <= t.clientWidth + 1,
          `scrollWidth ${t.scrollWidth} > clientWidth ${t.clientWidth}`
        );
      });
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================");
  console.log(`gift-card-layout.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN gift-card-layout.browser.test.js:", err);
  process.exit(1);
});
