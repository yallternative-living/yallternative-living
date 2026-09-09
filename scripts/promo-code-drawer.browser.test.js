/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for the promo-code flow in the cart drawer
 * (assets/js/cart.js + workers/routes/promo-preview.js), driven end to end
 * against a mocked /api so the drawer under test is the shipped one and the
 * Worker's answers are the documented contract.
 *
 * Why a browser suite: scripts/cart.test.js proves the state machine over a
 * mock DOM, and scripts/worker-promo-preview.test.js proves the Worker; this
 * is the only place the two meet -- a real click on a real button, a real
 * localStorage, a real reload, and the request the drawer actually sends.
 *
 *   1. "Have a code?" sits beside the gift card prompt; an unknown code is
 *      refused with the curated sentence and nothing is stored
 *   2. a valid code shows the estimated discount line and the adjusted
 *      total, persists as yl_applied_promo, and survives a reload
 *   3. a gift card takes the session's one discount: the code goes idle,
 *      the notice explains, removing the card brings the code back
 *   4. a code under its minimum stays applied with no discount line and
 *      the "at least $X" terms; adding to the cart re-checks it (debounced)
 *      and the line appears
 *   5. checkout POSTs discount_code; a Worker refusal naming the code
 *      drops it and says why
 *   6. the CMS switch (site.enablePromoCodes) hides the box
 *   7. the drawer stays within the viewport at phone width with both
 *      panels open (nothing overflows the codes row)
 *
 * Run: node scripts/promo-code-drawer.browser.test.js
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

/* The Worker, as the drawer sees it. `state.promo` is what /api/promo-preview
   answers for a code; anything else is unknown. Every request the drawer
   makes to /api is recorded so the suite can assert on the bodies. */
function mockApi(state) {
  return async (req) => {
    const url = new URL(req.url());
    const record = { path: url.pathname, body: null };
    try {
      record.body = JSON.parse(req.postData() || "null");
    } catch {
      record.body = null;
    }
    state.requests.push(record);
    const reply = (status, body) =>
      req.respond({
        status,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: JSON.stringify(body)
      });
    if (url.pathname === "/api/promo-preview") {
      const code = record.body && record.body.code;
      const subtotalCents = state.subtotalFor(record.body && record.body.items);
      const promo = state.promos[code];
      if (!promo)
        return reply(200, { valid: false, reason: "unknown", error: "That code isn't valid." });
      if (promo.minimumAmountCents && subtotalCents < promo.minimumAmountCents) {
        return reply(200, {
          valid: false,
          reason: "minimum_not_met",
          minimumAmountCents: promo.minimumAmountCents,
          error: `This code needs a subtotal of at least $${promo.minimumAmountCents / 100}.`
        });
      }
      const estimated =
        promo.kind === "percent"
          ? Math.round((subtotalCents * promo.percentOff) / 100)
          : Math.min(subtotalCents, promo.amountOffCents);
      return reply(200, {
        valid: true,
        code,
        kind: promo.kind,
        percentOff: promo.kind === "percent" ? promo.percentOff : null,
        amountOffCents: promo.kind === "amount" ? promo.amountOffCents : null,
        minimumAmountCents: promo.minimumAmountCents || 0,
        restrictions: { firstTimeOnly: false },
        estimatedDiscountCents: estimated,
        subtotalCents
      });
    }
    if (url.pathname === "/api/gift-card-balance") {
      return reply(200, {
        valid: true,
        code: "YALL-TEST-TEST-TEST",
        balanceCents: 5000,
        balance: 50,
        formattedBalance: "$50",
        pendingCents: 0,
        currency: "usd",
        expires: null
      });
    }
    if (url.pathname === "/api/checkout") {
      if (state.checkoutAnswer)
        return reply(state.checkoutAnswer.status, state.checkoutAnswer.body);
      return reply(200, { url: `${state.base}/thank-you.html?mock=1` });
    }
    if (url.pathname === "/api/inventory") {
      return reply(200, { stock: {} });
    }
    return reply(404, { error: "no such route" });
  };
}

async function newPage(browser, base, state, width) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  /* Pages in one browser share localStorage per origin, so each section
     starts from an empty cart -- once per TAB (sessionStorage is per tab),
     so the reload in section 2 keeps what that section stored. */
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.removeItem("yl-lang");
      if (!sessionStorage.getItem("yl-promo-suite-init")) {
        localStorage.clear();
        sessionStorage.setItem("yl-promo-suite-init", "1");
      }
    } catch {
      /* ignore */
    }
  });
  await page.setRequestInterception(true);
  const api = mockApi(state);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(base + "/api/")) {
      api(req).catch(() => {});
      return;
    }
    const local = url.startsWith(base) || url.startsWith("data:");
    (local ? req.continue() : req.abort("blockedbyclient")).catch(() => {});
  });
  return page;
}

/* See challenger-m2-verification.browser.test.js: the drawer slides in over
   320ms and nothing inside it is clickable until it has settled. */
async function waitForDrawerOpen(page) {
  await page.waitForSelector(".yl-cart-drawer:popover-open, .yl-cart-drawer[data-open='true']", {
    timeout: 3000
  });
  await page.waitForFunction(
    () => {
      const d = document.getElementById("yl-cart-drawer");
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5;
    },
    { timeout: 3000, polling: "raf" }
  );
}

async function addFirstItem(page) {
  await page.waitForSelector(".yl-add-item", { timeout: 5000 });
  await page.click(".yl-add-item");
  await page.waitForSelector("#yl-cart-drawer .yl-cart-line", { visible: true, timeout: 10000 });
  await waitForDrawerOpen(page);
}

async function footText(page) {
  return page.$eval("#yl-cart-foot", (el) => el.textContent.replace(/\s+/g, " "));
}

async function footHas(page, selector) {
  return page.$eval("#yl-cart-foot", (el, sel) => !!el.querySelector(sel), selector);
}

async function applyCode(page, code) {
  await page.waitForSelector("#yl-cart-foot .yl-cart-promo-toggle", { visible: true });
  await page.click("#yl-cart-foot .yl-cart-promo-toggle");
  await page.waitForSelector("#yl-cart-foot .yl-cart-promo-input", { visible: true });
  await page.type("#yl-cart-foot .yl-cart-promo-input", code);
  await page.click("#yl-cart-foot .yl-cart-promo-btn");
}

async function storedPromo(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem("yl_applied_promo");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
}

async function run() {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;

  const state = {
    base,
    requests: [],
    checkoutAnswer: null,
    promos: {
      WELCOME10: { kind: "percent", percentOff: 10 },
      FIVEOFF: { kind: "amount", amountOffCents: 500 },
      BIG25: { kind: "percent", percentOff: 25, minimumAmountCents: 100000 }
    },
    /* The mock prices the cart from the same catalog the page renders --
       the drawer's own unit prices are what the totals assert against, so
       the estimate here only needs to agree with them. */
    subtotalFor(items) {
      const catalog = JSON.parse(
        fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
      );
      let cents = 0;
      for (const it of items || []) {
        const p = (catalog.products || []).find((x) => x.id === it.id);
        if (!p) continue;
        let price = Number(p.price) || 0;
        if (p.variants && Array.isArray(p.variants.options) && it.variant) {
          const opt = p.variants.options.find((o) => o.label === it.variant);
          if (opt) price += Number(opt.priceDelta) || 0;
        }
        cents += Math.round(price * 100) * (Number(it.qty) || 1);
      }
      return cents;
    }
  };

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // ---- 1. the prompt, and an unknown code ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      check(
        "1: 'Have a code?' is offered in the codes row beside the gift card prompt",
        (await footHas(page, ".yl-cart-codes .yl-cart-promo-toggle")) &&
          (await footHas(page, ".yl-cart-codes .yl-cart-giftcard-toggle"))
      );
      const sideBySide = await page.$eval("#yl-cart-foot .yl-cart-codes", (row) => {
        const [a, b] = row.children;
        if (!a || !b) return false;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return Math.abs(ra.top - rb.top) < 2 && rb.left >= ra.right - 1;
      });
      check("1: at desktop width the two prompts sit side by side", sideBySide);
      state.requests.length = 0;
      await applyCode(page, "nope");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-msg", { visible: true });
      const msg = await page.$eval("#yl-cart-foot .yl-cart-promo-msg", (el) => el.textContent);
      check(
        "1: an unknown code is refused with the curated sentence",
        /isn't valid/.test(msg),
        msg
      );
      const preview = state.requests.find((r) => r.path === "/api/promo-preview");
      check(
        "1: the drawer asked /api/promo-preview with the normalized code",
        preview && preview.body.code === "NOPE"
      );
      check(
        "1: ...and the cart's lines in checkout's shape",
        preview &&
          Array.isArray(preview.body.items) &&
          preview.body.items.length === 1 &&
          "id" in preview.body.items[0]
      );
      check("1: nothing is stored for a refused code", (await storedPromo(page)) === null);
      check(
        "1: no discount line for a refused code",
        !(await footHas(page, ".yl-cart-promo-line"))
      );
      await page.close();
    }

    // ---- 2. a valid code, the totals, persistence ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      const before = await page.$eval(
        "#yl-cart-foot .yl-cart-total-due strong",
        (el) => el.textContent
      );
      await applyCode(page, "welcome10");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      const line = await page.$eval("#yl-cart-foot .yl-cart-promo-line", (el) =>
        el.textContent.replace(/\s+/g, " ")
      );
      check(
        "2: a valid code shows the estimated discount line",
        /Promo code \(WELCOME10\)/.test(line) && /-\$/.test(line),
        line
      );
      const after = await page.$eval(
        "#yl-cart-foot .yl-cart-total-due strong",
        (el) => el.textContent
      );
      const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, ""));
      const off = toNum(line.split("-$")[1]);
      check(
        "2: the estimated total drops by exactly the discount",
        Math.abs(toNum(before) - off - toNum(after)) < 0.006,
        `${before} - ${off} -> ${after}`
      );
      const subtotal = await page.$eval(
        "#yl-cart-foot .yl-cart-subtotal strong",
        (el) => el.textContent
      );
      check(
        "2: the discount is 10% of the goods subtotal",
        Math.abs(toNum(subtotal) * 0.1 - off) < 0.006,
        `${subtotal} vs ${off}`
      );
      const stored = await storedPromo(page);
      check(
        "2: the code persists as yl_applied_promo",
        stored && stored.code === "WELCOME10" && stored.kind === "percent"
      );
      check(
        "2: ...holding no Stripe ids",
        !JSON.stringify(stored).includes("promo_") && !JSON.stringify(stored).includes("coupon")
      );
      const terms = await page.$eval("#yl-cart-foot .yl-cart-promo-terms", (el) => el.textContent);
      check("2: the applied panel shows the code's terms", /10% off/.test(terms), terms);
      await page.reload({ waitUntil: "networkidle2" });
      await page.evaluate(() => window.YLCart.open());
      await waitForDrawerOpen(page);
      check(
        "2: a reload keeps the applied code and its line",
        await footHas(page, ".yl-cart-promo-line")
      );
      check("2: the totals note is unchanged", /at checkout/.test(await footText(page)));
      await page.close();
    }

    // ---- 3. one discount per session ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      await applyCode(page, "welcome10");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      await page.click("#yl-cart-foot .yl-cart-giftcard-toggle");
      await page.waitForSelector("#yl-cart-foot .yl-cart-giftcard-input", { visible: true });
      await page.type("#yl-cart-foot .yl-cart-giftcard-input", "YALL-TEST-TEST-TEST");
      await page.click("#yl-cart-foot .yl-cart-giftcard-btn");
      await page.waitForSelector("#yl-cart-foot .yl-cart-giftcard-applied-bal", { visible: true });
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-idle", { visible: true });
      check(
        "3: with a gift card applied the promo line is gone",
        !(await footHas(page, ".yl-cart-promo-line"))
      );
      const notice = await page.$eval(
        "#yl-cart-foot .yl-cart-promo-notice",
        (el) => el.textContent
      );
      check(
        "3: ...and the one-or-the-other rule is explained beside the idle code",
        /combined/.test(notice),
        notice
      );
      check(
        "3: ...while the code stays stored",
        ((await storedPromo(page)) || {}).code === "WELCOME10"
      );
      check(
        "3: the gift card discount line is shown",
        /Gift Card Discount/.test(await footText(page))
      );
      await page.click("#yl-cart-foot .yl-cart-giftcard-applied .yl-cart-giftcard-remove");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      check("3: removing the gift card brings the code back", true);
      await page.close();
    }

    // ---- 4. a minimum, and the debounced re-check ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      await applyCode(page, "big25");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-msg", { visible: true });
      const msg = await page.$eval("#yl-cart-foot .yl-cart-promo-msg", (el) => el.textContent);
      check(
        "4: a code under its minimum says how much is needed",
        /at least \$1,?000/.test(msg),
        msg
      );
      check("4: ...and is not applied", (await storedPromo(page)) === null);

      // Lower the bar so the code applies, then raise the cart past it.
      state.promos.BIG25.minimumAmountCents = 1;
      await page.click("#yl-cart-foot .yl-cart-promo-btn");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      state.promos.BIG25.minimumAmountCents = 100000;
      state.requests.length = 0;
      // Two quick quantity bumps: one re-check, after the cart settles.
      await page.click(
        "#yl-cart-drawer .yl-cart-line [data-cart-action='inc'], #yl-cart-drawer .yl-cart-line .yl-cart-qty-inc, #yl-cart-drawer .yl-cart-line button[aria-label='Increase quantity']"
      );
      await page.click(
        "#yl-cart-drawer .yl-cart-line [data-cart-action='inc'], #yl-cart-drawer .yl-cart-line .yl-cart-qty-inc, #yl-cart-drawer .yl-cart-line button[aria-label='Increase quantity']"
      );
      await new Promise((r) => setTimeout(r, 300));
      check(
        "4: a cart change does not re-check the code at once",
        state.requests.filter((r) => r.path === "/api/promo-preview").length === 0
      );
      await page.waitForFunction(
        () => !document.querySelector("#yl-cart-foot .yl-cart-promo-line"),
        { timeout: 5000 }
      );
      const rechecks = state.requests.filter((r) => r.path === "/api/promo-preview");
      check("4: one debounced re-check followed", rechecks.length === 1, String(rechecks.length));
      check(
        "4: ...for the applied code against the cart as it is now",
        rechecks[0] && rechecks[0].body.code === "BIG25" && rechecks[0].body.items[0].qty === 3
      );
      const terms = await page.$eval("#yl-cart-foot .yl-cart-promo-terms", (el) => el.textContent);
      check(
        "4: past the minimum the code stays applied, with no line and the terms naming the minimum",
        /at least/.test(terms),
        terms
      );
      await page.close();
    }

    // ---- 5. checkout carries the code; a refusal drops it ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      await applyCode(page, "fiveoff");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      state.requests.length = 0;
      state.checkoutAnswer = {
        status: 400,
        body: {
          error: "That code has expired or has already been used.",
          promo: { code: "FIVEOFF", applied: false, reason: "expired" }
        }
      };
      await page.click("#yl-cart-foot .yl-cart-checkout");
      await page.waitForSelector("#yl-cart-foot .yl-cart-error", { visible: true, timeout: 5000 });
      const checkout = state.requests.find((r) => r.path === "/api/checkout");
      check(
        "5: checkout POSTs the applied code as discount_code",
        checkout && checkout.body.discount_code === "FIVEOFF"
      );
      check("5: ...and no gift card", checkout && !checkout.body.gift_card_code);
      const err = await page.$eval("#yl-cart-foot .yl-cart-error", (el) => el.textContent);
      check("5: a Worker refusal naming the code is shown", /expired/.test(err), err);
      await page.waitForFunction(() => !localStorage.getItem("yl_applied_promo"), {
        timeout: 3000
      });
      check("5: ...and the code is dropped from storage", (await storedPromo(page)) === null);
      check(
        "5: ...and the code box is reopened with the reason",
        await footHas(page, ".yl-cart-promo-form .yl-cart-promo-msg")
      );
      state.checkoutAnswer = null;
      await page.close();
    }

    // ---- 6. the CMS switch ----
    {
      const page = await newPage(browser, base, state, 1200);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      await applyCode(page, "welcome10");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-line", { visible: true });
      await page.evaluate(() => {
        window.YL_CONTENT.site.enablePromoCodes = false;
        window.YLCart.render();
      });
      check(
        "6: site.enablePromoCodes false hides the promo box",
        !(await footHas(page, ".yl-cart-promo-wrap"))
      );
      check("6: ...and applies no discount", !(await footHas(page, ".yl-cart-promo-line")));
      check(
        "6: ...while the gift card prompt stays",
        await footHas(page, ".yl-cart-giftcard-toggle")
      );
      state.requests.length = 0;
      await page.click("#yl-cart-foot .yl-cart-checkout");
      await page
        .waitForFunction(() => location.pathname.endsWith("/thank-you.html"), { timeout: 10000 })
        .catch(() => {});
      const checkout = state.requests.find((r) => r.path === "/api/checkout");
      check(
        "6: ...and checkout sends no discount_code",
        checkout && !("discount_code" in checkout.body)
      );
      await page.close();
    }

    // ---- 7. phone width: nothing overflows ----
    for (const width of [320, 375]) {
      const page = await newPage(browser, base, state, width);
      await page.goto(base + "/shop.html", { waitUntil: "networkidle2", timeout: 45000 });
      await addFirstItem(page);
      await page.click("#yl-cart-foot .yl-cart-promo-toggle");
      await page.waitForSelector("#yl-cart-foot .yl-cart-promo-input", { visible: true });
      await page.click("#yl-cart-foot .yl-cart-giftcard-toggle");
      await page.waitForSelector("#yl-cart-foot .yl-cart-giftcard-form .yl-cart-giftcard-input", {
        visible: true
      });
      const overflow = await page.evaluate(() => {
        const drawer = document.getElementById("yl-cart-drawer");
        const right = drawer.getBoundingClientRect().right;
        const bad = [];
        drawer.querySelectorAll(".yl-cart-codes *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > right + 0.5) bad.push(el.className || el.tagName);
        });
        return { bad, scroll: drawer.scrollWidth, client: drawer.clientWidth };
      });
      check(
        `7: at ${width}px both code boxes open without horizontal overflow`,
        overflow.bad.length === 0 && overflow.scroll <= overflow.client,
        JSON.stringify(overflow)
      );
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================");
  console.log(`promo-code-drawer.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN promo-code-drawer.browser.test.js:", err);
  process.exit(1);
});
