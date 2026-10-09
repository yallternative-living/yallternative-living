/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for the cart drawer's footer layout
 * (assets/js/cart.js render() + assets/css/cart.css): can a shopper actually
 * reach every control in the drawer, on every screen it ships to?
 *
 * Why this exists (red team, 2026-10-09): commit a7bdeca docked the subtotal,
 * shipping, estimated total, Checkout, Share Cart and the fine print -- ~289px
 * -- inside a footer capped at 62dvh. The scroll area left over for upsells,
 * the gift note, local pick-up and both code fields came out 12px tall on a
 * landscape phone (667x375, 844x390), 42px at 320x568 and 49px at 375x548
 * (an iPhone SE's visible area in Safari), and the dock itself ran off the
 * bottom of a 375px screen. Every existing suite still passed, because none
 * of them asked whether a control could be scrolled to.
 *
 * At each viewport, with a two-line cart:
 *   1. every subject exists (the lines, the scroll region, the dock, Checkout,
 *      pick-up, the gift note, the promo and gift card prompts) -- an absent
 *      control is a failure, never a skip;
 *   2. the dock fits on screen and holds only the estimated total and
 *      Checkout -- none of the controls above;
 *   3. the footer's scroll area (or, below 500px of height, the drawer-wide
 *      scroller) shows at least FLOOR_PX of content, and the item list shows
 *      at least one whole line;
 *   4. each line and each footer control, scrolled into view the way a
 *      browser does for keyboard focus, lands inside the viewport and is the
 *      element actually hit at its own centre -- not covered by the dock.
 *
 * Then the scroll position across a re-render (also 2026-10-09): ticking
 * pick-up or "this is a gift" re-renders the footer, which used to restart
 * its scroller at 0 and throw the control the shopper had just scrolled to
 * -- and the picker or gift note it revealed -- out of view.
 *
 * Run: node scripts/cart-drawer-layout.browser.test.js
 */

const path = require("path");
const puppeteer = require("puppeteer");
const { createStaticServer } = require("./serve.js");

const ROOT = path.resolve(__dirname, "..");

const VIEWPORTS = [
  [667, 375],
  [844, 390],
  [320, 568],
  [375, 548],
  [375, 667],
  [390, 844],
  [768, 1024],
  [1200, 800]
];

/* The least content height the footer's scroller may show. HEAD at
   2026-10-09 measured 12/12/42/49/123px at the first five viewports above. */
const FLOOR_PX = 150;

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

async function openCartPage(browser, base, width, height) {
  const page = await browser.newPage();
  await page.setViewport({
    width,
    height,
    deviceScaleFactor: 1,
    isMobile: width < 800,
    hasTouch: width < 800
  });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(base + "/api/")) {
      req
        .respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ stock: {} })
        })
        .catch(() => {});
      return;
    }
    const local = url.startsWith(base) || url.startsWith("data:");
    (local ? req.continue() : req.abort("blockedbyclient")).catch(() => {});
  });
  await page.goto(base + "/index.html", { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForFunction(() => window.YLCart && typeof window.YLCart.addItem === "function", {
    timeout: 10000
  });
  await page.evaluate(() => {
    /* The three footer features under test are CMS switches; pin them on so
       a content edit cannot quietly turn this suite into a no-op. */
    const site = (window.YL_CONTENT = window.YL_CONTENT || {});
    site.site = site.site || {};
    site.site.enableLocalPickup = true;
    site.site.enableGiftOrders = true;
    site.site.enablePromoCodes = true;
    window.YLCart.addItem({ id: "miracle-balm", name: "Miracle Balm", price: 14, qty: 1 });
    window.YLCart.addItem({ id: "sleep-salve", name: "Sleep Salve", price: 14, qty: 1 });
    window.YLCart.open();
  });
  await page.waitForSelector("#yl-cart-drawer .yl-cart-foot-dock .yl-cart-checkout", {
    visible: true,
    timeout: 10000
  });
  // Let the 0.32s slide-in finish before measuring anything.
  await new Promise((r) => setTimeout(r, 700));
  return page;
}

/* Everything step 1-4 asserts, measured in the page. */
async function measure(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const drawer = document.getElementById("yl-cart-drawer");
    const foot = document.getElementById("yl-cart-foot");
    const items = document.getElementById("yl-cart-items");
    const head = drawer && drawer.querySelector(".yl-cart-head");
    const region = foot && foot.querySelector(".yl-cart-foot-scroll");
    const dock = foot && foot.querySelector(".yl-cart-foot-dock");
    const lines = items ? Array.from(items.querySelectorAll(".yl-cart-line")) : [];
    const subjects = {
      drawer: !!drawer,
      head: !!head,
      region: !!region,
      dock: !!dock,
      checkout: !!(dock && dock.querySelector(".yl-cart-checkout")),
      estimatedTotal: !!(dock && dock.querySelector(".yl-cart-total-due")),
      lines: lines.length
    };
    const controls = {
      pickup: "#yl-cart-pickup-checkbox",
      gift: "#yl-cart-giftorder-checkbox",
      promo: ".yl-cart-promo-toggle",
      giftcard: ".yl-cart-giftcard-toggle",
      share: ".yl-cart-share-btn",
      subtotal: ".yl-cart-breakdown"
    };
    const out = { vh: innerHeight, subjects, controls: {}, inDock: [], reach: {} };
    if (!drawer || !region || !dock) return out;

    Object.keys(controls).forEach((k) => {
      const el = foot.querySelector(controls[k]);
      out.controls[k] = !!el;
      if (el && dock.contains(el)) out.inDock.push(k);
    });

    const d = dock.getBoundingClientRect();
    out.dock = { top: Math.round(d.top), bottom: Math.round(d.bottom), h: Math.round(d.height) };

    /* Which box scrolls the footer controls: the region itself on a tall
       screen, the whole drawer on a short one. Its visible content band is
       what it shows between the pinned header and the dock. */
    const regionScrolls = getComputedStyle(region).overflowY !== "visible";
    out.mode = regionScrolls ? "split" : "single";
    if (regionScrolls) {
      out.band = region.clientHeight;
      out.itemsVisible = items.clientHeight;
    } else {
      const hb = head.getBoundingClientRect().bottom;
      out.band = Math.round(d.top - hb);
      out.itemsVisible = out.band;
    }
    out.lineH = lines.length ? Math.round(lines[0].getBoundingClientRect().height) : null;

    const targets = lines.map((l, i) => ["line" + (i + 1), l]);
    Object.keys(controls).forEach((k) => {
      const el = foot.querySelector(controls[k]);
      if (el) targets.push([k, el.closest("label") || el]);
    });
    targets.push(["checkout", dock.querySelector(".yl-cart-checkout")]);
    for (const [k, box] of targets) {
      box.scrollIntoView({ block: "nearest" });
      await sleep(60);
      const b = box.getBoundingClientRect();
      const probeY = b.top + Math.min(b.height / 2, 12);
      const probeX = b.left + Math.min(b.width / 2, 40);
      const hit = document.elementFromPoint(probeX, probeY);
      const inViewport = b.top >= -0.5 && b.top + Math.min(b.height, 24) <= innerHeight + 0.5;
      const uncovered = !!hit && (box === hit || box.contains(hit));
      out.reach[k] =
        inViewport && uncovered
          ? "ok"
          : `top=${Math.round(b.top)} hit=${hit ? hit.className || hit.tagName : "none"}`;
    }
    return out;
  });
}

async function run() {
  const server = createStaticServer(ROOT);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

    for (const [w, h] of VIEWPORTS) {
      const tag = `${w}x${h}`;
      const page = await openCartPage(browser, base, w, h);
      const m = await measure(page);
      const s = m.subjects;
      check(
        `${tag}: drawer, header, scroll region, dock, Checkout and estimated total all exist`,
        s.drawer && s.head && s.region && s.dock && s.checkout && s.estimatedTotal,
        JSON.stringify(s)
      );
      check(`${tag}: the cart renders both lines`, s.lines === 2, `lines=${s.lines}`);
      const missing = Object.keys(m.controls).filter((k) => !m.controls[k]);
      check(
        `${tag}: pick-up, gift note, promo, gift card, Share Cart and the breakdown are rendered`,
        Object.keys(m.controls).length === 6 && missing.length === 0,
        "missing: " + missing.join(", ")
      );
      if (!m.dock) {
        await page.close();
        continue;
      }
      check(
        `${tag}: the dock fits on screen (top ${m.dock.top}, bottom ${m.dock.bottom}, viewport ${m.vh})`,
        m.dock.top >= 0 && m.dock.bottom <= m.vh + 0.5
      );
      check(
        `${tag}: the dock is the estimated total and Checkout only (${m.dock.h}px, at most 35% of ${m.vh}px)`,
        m.inDock.length === 0 && m.dock.h <= m.vh * 0.35,
        "docked controls: " + m.inDock.join(", ")
      );
      check(
        `${tag}: the footer's scroller shows at least ${FLOOR_PX}px of content (${m.mode}: ${m.band}px)`,
        m.band >= FLOOR_PX
      );
      check(
        `${tag}: the item list shows at least one whole line (${m.itemsVisible}px >= ${m.lineH}px)`,
        typeof m.lineH === "number" && m.lineH > 0 && m.itemsVisible >= m.lineH
      );
      const reachKeys = Object.keys(m.reach);
      const unreachable = reachKeys.filter((k) => m.reach[k] !== "ok");
      check(
        `${tag}: all ${reachKeys.length} lines and controls scroll into view uncovered`,
        reachKeys.length >= 9 && unreachable.length === 0,
        unreachable.map((k) => `${k} (${m.reach[k]})`).join("; ")
      );
      await page.close();
    }

    /* Scroll position across a re-render. 375x667 exercises the split
       layout's own scroller, 667x375 the drawer-wide one. */
    for (const [w, h] of [
      [375, 667],
      [667, 375]
    ]) {
      for (const [name, sel, revealed] of [
        ["pick-up", "#yl-cart-pickup-checkbox", "#yl-cart-pickup-select"],
        ["gift order", "#yl-cart-giftorder-checkbox", "#yl-cart-giftmessage-input"]
      ]) {
        const tag = `${w}x${h} ${name}`;
        const page = await openCartPage(browser, base, w, h);
        const r = await page.evaluate(
          async (sel, revealed) => {
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
            const drawer = document.getElementById("yl-cart-drawer");
            const regionOf = () => document.querySelector("#yl-cart-foot .yl-cart-foot-scroll");
            const region = regionOf();
            const box = document.querySelector(sel);
            if (!region || !box) return { missing: true };
            const scroller = getComputedStyle(region).overflowY !== "visible" ? "region" : "drawer";
            const el = () => (scroller === "region" ? regionOf() : drawer);
            const label = box.closest("label") || box;
            // Bring the control to the middle of whatever scrolls it.
            const target =
              el().scrollTop +
              label.getBoundingClientRect().top -
              el().getBoundingClientRect().top -
              el().clientHeight / 3;
            el().scrollTop = Math.max(0, target);
            await sleep(150);
            const before = Math.round(el().scrollTop);
            label.click();
            await sleep(400);
            const after = Math.round(el().scrollTop);
            const now = document.querySelector(sel);
            const shown = document.querySelector(revealed);
            const dock = document.querySelector("#yl-cart-foot .yl-cart-foot-dock");
            const viewTop =
              scroller === "region"
                ? el().getBoundingClientRect().top
                : drawer.querySelector(".yl-cart-head").getBoundingClientRect().bottom;
            const viewBottom =
              scroller === "region"
                ? el().getBoundingClientRect().bottom
                : dock.getBoundingClientRect().top;
            const lr = (now.closest("label") || now).getBoundingClientRect();
            const sr = shown ? shown.getBoundingClientRect() : null;
            return {
              scroller,
              before,
              after,
              checked: now.checked,
              controlVisible: lr.top >= viewTop - 1 && lr.top + 12 <= viewBottom + 1,
              revealedVisible: !!sr && sr.height > 0 && sr.top < viewBottom && sr.bottom > viewTop
            };
          },
          sel,
          revealed
        );
        if (r.missing) {
          check(`${tag}: control and footer scroll region exist`, false);
        } else {
          check(
            `${tag}: the ${r.scroller} had actually been scrolled before the click (scrollTop ${r.before})`,
            r.before > 0
          );
          check(`${tag}: the click ticked the box`, r.checked === true);
          check(
            `${tag}: the re-render kept the ${r.scroller}'s scroll position (${r.before} -> ${r.after})`,
            Math.abs(r.after - r.before) <= 2
          );
          check(
            `${tag}: the ticked control and what it revealed are still on screen`,
            r.controlVisible && r.revealedVisible,
            JSON.stringify(r)
          );
        }
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================");
  console.log(`cart-drawer-layout.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (passed === 0) {
    console.error("No assertions ran -- refusing to report a pass.");
    process.exit(1);
  }
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN cart-drawer-layout.browser.test.js:", err);
  process.exit(1);
});
