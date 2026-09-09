/* eslint-env node, browser */
/**
 * @fileoverview Drives orders.html -- the passwordless order history -- in a
 * real browser with the Worker mocked at the network layer.
 *
 * The Worker is not in this test (scripts/worker-orders.test.js covers it);
 * every `/api/orders*` request is intercepted by Puppeteer and answered from
 * a scenario, so this suite is about what the PAGE does with each answer:
 *
 *   1. The form: JavaScript enables the button, a bad address is refused
 *      before any request, a good one is POSTed as `{email}` and the page
 *      then shows the CMS confirmation with the form gone.
 *   2. Neutrality: the DOM after "known address" and "unknown address" is
 *      byte-identical -- the page can't tell, so neither can anyone reading
 *      over a shoulder.
 *   3. `?token=`: the token is scrubbed from the address bar, the list is
 *      requested with it, and every field the Worker sends is painted --
 *      date, items with quantities and unit prices, total, status words,
 *      tracking link (http(s) only), points balance -- with no address
 *      anywhere on the page.
 *   4. Reorder puts the reorderable lines into the REAL cart (cart.js) with
 *      their quantity and option, skips the gift card, and opens the drawer.
 *   5. A used/expired token (403) explains itself and leaves the form up;
 *      the CMS switch off hides the form and shows the contact hand-off.
 *
 * Run: node scripts/orders-page.browser.test.js
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
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
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
    const msg = `  ✗ FAIL: ${desc}${extra ? " — " + extra : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

/* The real catalog decides what is reorderable: a variant-bearing product
   with an in-stock option, and a plain in-stock product. */
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));
const variantProduct = catalog.products.find(
  (p) =>
    p.inStock !== false &&
    p.variants &&
    Array.isArray(p.variants.options) &&
    p.variants.options.length
);
const liveOption = variantProduct && variantProduct.variants.options.find((o) => !o.soldOut);
const plainProduct = catalog.products.find(
  (p) =>
    p.inStock !== false &&
    p.id !== "gift-card" &&
    !(p.variants && Array.isArray(p.variants.options) && p.variants.options.length)
);

const ORDERS = {
  orders: [
    {
      sessionId: "cs_test_newest",
      placedAt: 1757400000,
      amountTotalCents: 6250,
      currency: "usd",
      status: "shipped",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400123",
      items: [
        {
          name: `${variantProduct.name} (${liveOption.label})`,
          quantity: 2,
          unitCents: Math.round(variantProduct.price * 100),
          productId: variantProduct.id,
          variant: liveOption.label,
          kind: "product",
          reorderable: true
        },
        {
          name: plainProduct.name,
          quantity: 1,
          unitCents: Math.round(plainProduct.price * 100),
          productId: plainProduct.id,
          variant: "",
          kind: "product",
          reorderable: true
        },
        {
          name: "Digital Gift Card ($25.00)",
          quantity: 1,
          unitCents: 2500,
          productId: "gift-card",
          variant: "Preset $25",
          kind: "gift-card",
          reorderable: false
        }
      ]
    },
    {
      sessionId: "cs_test_older",
      placedAt: 1751000000,
      amountTotalCents: 1800,
      currency: "usd",
      status: "processing",
      trackingUrl: "javascript:alert(1)",
      items: [
        {
          name: "Something Discontinued",
          quantity: 1,
          unitCents: 1800,
          productId: "no-such-product",
          variant: "",
          kind: "product",
          reorderable: true
        }
      ]
    }
  ],
  loyalty: { balance: 40, threshold: 100, rewardCents: 500, pointsToReward: 60 }
};

/**
 * A page whose /api/orders* calls are answered from `scenario` and whose
 * other off-origin requests are blocked (chat, analytics). `scenario.content`
 * rewrites content-data.js so the CMS switch can be flipped per scenario.
 */
async function pageWith(browser, base, scenario) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const seen = { link: [], list: [] };
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    // Scripts load as /assets/js/x.js?v=2.0 -- match on the path alone.
    const pathname = url.startsWith(base) ? url.slice(base.length).split("?")[0] : null;
    const respond = (status, body) =>
      req
        .respond({
          status,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(body)
        })
        .catch(() => {});
    if (pathname === "/api/orders/request-link") {
      seen.link.push({ method: req.method(), body: req.postData() || "" });
      const answer = scenario.link || { status: 200, body: { ok: true, message: "neutral" } };
      return respond(answer.status, answer.body);
    }
    if (pathname && pathname.startsWith("/api/orders")) {
      seen.list.push({ method: req.method(), url: url.slice(base.length) });
      const answer = scenario.list || { status: 200, body: ORDERS };
      return respond(answer.status, answer.body);
    }
    if (pathname === "/assets/js/content-data.js" && scenario.content) {
      const src = fs.readFileSync(path.join(ROOT, "assets/js/content-data.js"), "utf8");
      const patched = src.replace(
        /"enableOrderHistory":\s*(true|false)/,
        `"enableOrderHistory": ${scenario.content.enableOrderHistory}`
      );
      return req
        .respond({ status: 200, contentType: "text/javascript; charset=utf-8", body: patched })
        .catch(() => {});
    }
    const local = pathname !== null || url.startsWith("data:");
    (local ? req.continue() : req.abort("blockedbyclient")).catch(() => {});
  });
  return { page, context, seen, pageErrors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.evaluate(fn);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(60);
  }
}

async function formSnapshot(page) {
  return page.evaluate(() => {
    const card = document.getElementById("ordersRequestCard");
    const form = document.getElementById("ordersRequestForm");
    const confirm = document.getElementById("ordersRequestConfirm");
    const result = document.getElementById("ordersResultSection");
    return {
      cardHidden: !!(card && card.hidden),
      formHidden: !!(form && form.hidden),
      confirmHidden: !!(confirm && confirm.hidden),
      confirmText: confirm ? confirm.textContent.trim() : "",
      resultHidden: !!(result && result.hidden),
      mainHtml: document.getElementById("main-content").innerHTML
    };
  });
}

async function main() {
  check(
    "control: the catalog has a variant product with a live option",
    !!(variantProduct && liveOption)
  );
  check("control: the catalog has a plain in-stock product", !!plainProduct);
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n=== orders.html (${base}) ===\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    /* ------------------------------------------------------------ 1 + 2 */
    console.log("Scenario 1: the email form, and its one answer");
    const known = await pageWith(browser, base, {});
    await known.page.goto(`${base}/orders.html`, { waitUntil: "networkidle2" });
    const enabled = await waitFor(
      known.page,
      () => !document.getElementById("ordersRequestBtn").disabled
    );
    check("JavaScript enables the submit button (it ships disabled for the no-JS case)", !!enabled);
    const initial = await formSnapshot(known.page);
    check("the result panel starts hidden", initial.resultHidden && initial.confirmHidden);
    check(
      "the page is noindexed",
      await known.page.evaluate(() =>
        /noindex/.test((document.querySelector('meta[name="robots"]') || {}).content || "")
      )
    );

    await known.page.type("#ordersEmailInput", "not-an-address");
    await known.page.click("#ordersRequestBtn");
    await sleep(150);
    const badState = await known.page.evaluate(() => ({
      error: document.getElementById("ordersRequestError").hidden,
      text: document.getElementById("ordersRequestError").textContent
    }));
    check(
      "a bad address is refused on the page",
      badState.error === false && badState.text.length > 0
    );
    check("and NO request leaves the browser for it", known.seen.link.length === 0);

    await known.page.evaluate(() => {
      document.getElementById("ordersEmailInput").value = "Buyer@Example.com";
    });
    await known.page.click("#ordersRequestBtn");
    const confirmed = await waitFor(
      known.page,
      () => !document.getElementById("ordersRequestConfirm").hidden
    );
    check("a good address shows the confirmation", !!confirmed);
    check(
      "exactly one POST went to /api/orders/request-link",
      known.seen.link.length === 1 && known.seen.link[0].method === "POST"
    );
    let posted = null;
    try {
      posted = JSON.parse(known.seen.link[0].body);
    } catch {
      posted = null;
    }
    check(
      "with the address as JSON {email}",
      !!posted && posted.email === "Buyer@Example.com" && Object.keys(posted).length === 1,
      JSON.stringify(posted)
    );
    const afterKnown = await formSnapshot(known.page);
    check("the form is gone once the link is requested", afterKnown.formHidden);
    const content = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
    );
    check(
      "the confirmation is the CMS wording, not the Worker's",
      afterKnown.confirmText === content.orders.confirmation.replace(/\s+/g, " ").trim(),
      afterKnown.confirmText
    );
    check(
      "the error box is cleared",
      await known.page.evaluate(() => document.getElementById("ordersRequestError").hidden)
    );
    check("no page errors", known.pageErrors.length === 0, known.pageErrors.join(" | "));
    await known.context.close();

    // The same flow for an address the (mocked) Worker knows nothing about.
    const unknown = await pageWith(browser, base, {
      link: { status: 200, body: { ok: true, message: "neutral" } }
    });
    await unknown.page.goto(`${base}/orders.html`, { waitUntil: "networkidle2" });
    await waitFor(unknown.page, () => !document.getElementById("ordersRequestBtn").disabled);
    // Same keystrokes as the known flow (a refused address first), so the only
    // difference between the two runs is what the Worker knew.
    await unknown.page.type("#ordersEmailInput", "not-an-address");
    await unknown.page.click("#ordersRequestBtn");
    await sleep(150);
    await unknown.page.evaluate(() => {
      document.getElementById("ordersEmailInput").value = "stranger@example.com";
    });
    await unknown.page.click("#ordersRequestBtn");
    await waitFor(unknown.page, () => !document.getElementById("ordersRequestConfirm").hidden);
    const afterUnknown = await formSnapshot(unknown.page);
    const strip = (s) => s.mainHtml.replace(/value="[^"]*"/g, "");
    check(
      "NEUTRALITY: the page after an unknown address is byte-identical to the page after a known one",
      strip(afterUnknown) === strip(afterKnown)
    );
    await unknown.context.close();

    // A rate limit is the one thing the page does say.
    const limited = await pageWith(browser, base, {
      link: { status: 429, body: { error: "slow" } }
    });
    await limited.page.goto(`${base}/orders.html`, { waitUntil: "networkidle2" });
    await waitFor(limited.page, () => !document.getElementById("ordersRequestBtn").disabled);
    await limited.page.evaluate(() => {
      document.getElementById("ordersEmailInput").value = "buyer@example.com";
    });
    await limited.page.click("#ordersRequestBtn");
    const limitText = await waitFor(limited.page, () => {
      const e = document.getElementById("ordersRequestError");
      return !e.hidden && e.textContent;
    });
    check(
      "a 429 is explained and the form stays",
      /ten minutes/i.test(limitText || "") && !(await formSnapshot(limited.page)).formHidden
    );
    await limited.context.close();

    /* ------------------------------------------------------------ 3 + 4 */
    console.log("\nScenario 2: the emailed link opens the list");
    const list = await pageWith(browser, base, {});
    await list.page.goto(`${base}/orders.html?token=v1.payload.signature`, {
      waitUntil: "networkidle2"
    });
    const painted = await waitFor(
      list.page,
      () => document.querySelectorAll(".orders-card").length === 2
    );
    check("two order cards are painted", !!painted);
    check(
      "the list was requested ONCE, by GET, with the token",
      list.seen.list.length === 1 &&
        list.seen.list[0].method === "GET" &&
        list.seen.list[0].url === "/api/orders?token=v1.payload.signature",
      JSON.stringify(list.seen.list)
    );
    check(
      "THE TOKEN IS SCRUBBED FROM THE ADDRESS BAR",
      (await list.page.evaluate(() => window.location.search)) === ""
    );
    check("the email form is gone", (await formSnapshot(list.page)).cardHidden);

    const dom = await list.page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".orders-card"));
      return {
        heading: document.querySelector(".orders-list-heading").textContent.trim(),
        bodyText: document.body.innerText,
        cards: cards.map((c) => ({
          title: c.querySelector(".orders-card-title").textContent.trim(),
          status: c.querySelector(".orders-status").textContent.trim(),
          items: Array.from(c.querySelectorAll(".orders-item")).map((li) =>
            li.textContent.replace(/\s+/g, " ").trim()
          ),
          total: (c.querySelector(".orders-total") || {}).textContent || "",
          track: c.querySelector("a.btn")
            ? {
                href: c.querySelector("a.btn").getAttribute("href"),
                rel: c.querySelector("a.btn").getAttribute("rel"),
                target: c.querySelector("a.btn").getAttribute("target")
              }
            : null,
          statusLink: (c.querySelector(".orders-status-link") || {}).getAttribute
            ? c.querySelector(".orders-status-link").getAttribute("href")
            : null,
          reorder: !!c.querySelector(".orders-reorder-btn")
        })),
        loyalty: (document.querySelector(".orders-loyalty-balance") || {}).textContent || ""
      };
    });
    check("the heading counts the orders", /2 orders/.test(dom.heading), dom.heading);
    check(
      "newest first",
      /2025|2026/.test(dom.cards[0].title) && dom.cards[0].statusLink.includes("cs_test_newest"),
      dom.cards[0].title
    );
    check("the date is rendered", /Placed .*\d{4}/.test(dom.cards[0].title), dom.cards[0].title);
    check(
      "shipped reads Shipped; processing reads the packing line",
      dom.cards[0].status === "Shipped" && /packed/i.test(dom.cards[1].status)
    );
    check(
      "every item shows quantity and unit price",
      dom.cards[0].items.length === 3 &&
        dom.cards[0].items.every((t) => /× \d+ · \$[\d.]+ each/.test(t)),
      JSON.stringify(dom.cards[0].items)
    );
    check("the gift-card line is listed too", /Gift Card/.test(dom.cards[0].items[2]));
    check(
      "the total is shown as money",
      /Total: \$62\.50/.test(dom.cards[0].total),
      dom.cards[0].total
    );
    check(
      "the tracking link is a real, safe link",
      !!dom.cards[0].track &&
        dom.cards[0].track.href.startsWith("https://tools.usps.com/") &&
        /noopener/.test(dom.cards[0].track.rel) &&
        dom.cards[0].track.target === "_blank"
    );
    check("a javascript: tracking link is NOT rendered", dom.cards[1].track === null);
    check(
      "each card links to order-status with its reference",
      dom.cards[0].statusLink === "order-status.html?session_id=cs_test_newest"
    );
    check(
      "each card has a Reorder button",
      dom.cards.every((c) => c.reorder)
    );
    check("the points balance is shown", /40/.test(dom.loyalty), dom.loyalty);
    check(
      "NO ADDRESS ANYWHERE ON THE PAGE",
      !/@/.test(dom.bodyText.replace(/y\.allternative\.living@gmail\.com/g, ""))
    );
    check("no page errors", list.pageErrors.length === 0, list.pageErrors.join(" | "));

    // Reorder: into the real cart.
    await list.page.evaluate(() => {
      try {
        localStorage.removeItem("yl-cart-v1");
      } catch {
        /* ignore */
      }
      if (window.YLCart) window.YLCart.clear();
    });
    await list.page.click(".orders-card:first-child .orders-reorder-btn");
    const cartItems = await waitFor(list.page, () => {
      const items = window.YLCart && window.YLCart.items ? window.YLCart.items() : [];
      return items.length ? JSON.stringify(items) : null;
    });
    const parsed = cartItems ? JSON.parse(cartItems) : [];
    check(
      "Reorder puts the two product lines in the cart, not the gift card",
      parsed.length === 2,
      cartItems
    );
    const variantLine = parsed.find((i) => i.id === variantProduct.id);
    const plainLine = parsed.find((i) => i.id === plainProduct.id);
    check(
      "with the quantity and option that were bought",
      !!variantLine && variantLine.qty === 2 && variantLine.variantLabel === liveOption.label,
      JSON.stringify(variantLine)
    );
    check(
      "and the live catalog price, not a number from the server",
      !!plainLine && plainLine.qty === 1 && plainLine.price === plainProduct.price,
      JSON.stringify(plainLine)
    );
    const note = await list.page.evaluate(
      () => document.querySelector(".orders-card:first-child .orders-reorder-note").textContent
    );
    check(
      "the page says what went in and what was skipped",
      /Added|added/.test(note) && /1 could not/.test(note),
      note
    );
    const drawerOpen = await waitFor(
      list.page,
      () => {
        const d = document.getElementById("yl-cart-drawer");
        return (
          !!d &&
          (d.matches(":popover-open") ||
            d.getAttribute("data-open") === "true" ||
            d.classList.contains("open"))
        );
      },
      3000
    );
    check("the cart drawer opens", !!drawerOpen);

    // The second card's only line is not in the catalog any more.
    await list.page.evaluate(() => window.YLCart && window.YLCart.close && window.YLCart.close());
    await list.page.click(".orders-card:nth-child(2) .orders-reorder-btn");
    const note2 = await waitFor(list.page, () => {
      const n = document.querySelector(".orders-card:nth-child(2) .orders-reorder-note");
      return n && !n.hidden && n.textContent;
    });
    check(
      "a line that is no longer sold is explained, not added",
      /Nothing from this order/i.test(note2 || ""),
      note2
    );
    check(
      "and the cart is unchanged",
      (await list.page.evaluate(() => window.YLCart.items().length)) === 2
    );
    await list.context.close();

    /* ---------------------------------------------------------------- 5 */
    console.log("\nScenario 3: a used link, and the switch");
    const used = await pageWith(browser, base, {
      list: { status: 403, body: { error: "That link is not valid any more." } }
    });
    await used.page.goto(`${base}/orders.html?token=v1.old.old`, { waitUntil: "networkidle2" });
    const usedText = await waitFor(used.page, () => {
      const n = document.querySelector(".orders-notice");
      return n && n.textContent;
    });
    check(
      "a 403 says the link expired or was used",
      /expired|already used/i.test(usedText || ""),
      usedText
    );
    check("and the form is still there to ask again", !(await formSnapshot(used.page)).cardHidden);
    check(
      "the token was still scrubbed",
      (await used.page.evaluate(() => window.location.search)) === ""
    );
    await used.context.close();

    const off = await pageWith(browser, base, { content: { enableOrderHistory: false } });
    await off.page.goto(`${base}/orders.html`, { waitUntil: "networkidle2" });
    const offText = await waitFor(off.page, () => {
      const n = document.querySelector(".orders-notice");
      return n && n.textContent;
    });
    check(
      "with enableOrderHistory off the page shows the hand-off",
      /switched off/i.test(offText || ""),
      offText
    );
    const offState = await formSnapshot(off.page);
    check("and hides the form", offState.cardHidden);
    check(
      "with an email link to fall back on",
      await off.page.evaluate(() => !!document.querySelector('.orders-notice a[href^="mailto:"]'))
    );
    check("and requests nothing", off.seen.link.length === 0 && off.seen.list.length === 0);
    await off.context.close();

    const on = await pageWith(browser, base, {});
    await on.page.goto(`${base}/thank-you.html`, { waitUntil: "networkidle2" });
    check(
      "thank-you.html links to the page",
      await on.page.evaluate(
        () => !!document.querySelector('a.orders-history-link[href="orders.html"]')
      )
    );
    check(
      "and the footer does, on every page",
      await on.page.evaluate(
        () => !!document.querySelector('footer a.orders-history-link[href="/orders.html"]')
      )
    );
    await on.context.close();
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
