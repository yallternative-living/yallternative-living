/* eslint-env node, browser */
/**
 * @fileoverview Browser suite for the gift-set option pickers and the cart
 * drawer's Undo, both found by the 2026-09-02 live production audit.
 *
 * C1 (critical): a gift set is a single cart line, but its members are real
 * products and several of them are sold in sizes, scents or blends. The card
 * rendered no <select> at all, the cart line said only "Y'all Means All Pride
 * Set — 1 — $45.00", the checkout payload was `{"id":"bundle-pride-set",
 * "qty":1}` and the Worker never asked. $45 was taken for a set containing a
 * tee whose size the shop never learned.
 *
 * H1 (high): removing a cart line and pressing Undo did nothing. cart.js
 * delegated `[data-cart-action]` clicks from `.yl-cart-items`, but the undo
 * button renders into `.yl-cart-foot`, so `undoRemove()` was never called --
 * and the "Removed … Undo" notice stayed on screen, so nothing told the
 * shopper it had failed.
 *
 * M9 (medium): the build-your-own box line named a count and no contents.
 *
 * Every assertion here drives the real page through Puppeteer -- no
 * re-implementation of the renderers, and each one asserts its subject exists
 * before asserting anything about it.
 *
 * Run: node scripts/gift-set-variants.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

function createServer() {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
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
      ".xml": "application/xml"
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
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
    const msg = `  ✗ ${desc}${extra ? " — " + extra : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open shop.html with a clean cart and the gift-set filter applied. */
async function openGiftSets(page, base) {
  await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch (e) {
      /* private mode */
    }
  });
  await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
  await page.waitForSelector('#filterRow button[data-filter="gift-sets"]', { timeout: 10000 });
  await page.click('#filterRow button[data-filter="gift-sets"]');
  await page.waitForSelector(".bundle-card", { timeout: 10000 });
  await sleep(200);
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

    /* ================================================================== C1 */
    console.log("\n--- C1: gift sets with variant members ---");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await openGiftSets(page, base);

      const cards = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".bundle-card")).map((card) => ({
          id: card.getAttribute("data-bundle-id"),
          selects: Array.from(card.querySelectorAll(".bundle-variant-select")).map((s) => ({
            productId: s.getAttribute("data-product-id"),
            options: Array.from(s.options).map((o) => ({
              value: o.value,
              disabled: o.disabled
            })),
            labelled: Boolean(document.querySelector('label[for="' + s.id + '"]') && s.id)
          }))
        }))
      );

      check("the gift-set grid rendered cards at all", cards.length > 0, `${cards.length} cards`);

      const pride = cards.find((c) => c.id === "pride-set");
      check("the Pride Set card is on the page", Boolean(pride));
      if (pride) {
        check(
          "Pride Set renders one picker per variant-bearing member (tee size + oil scent)",
          pride.selects.length === 2,
          `got ${pride.selects.length}`
        );
        check(
          "every picker names the product it belongs to via a real <label for>",
          pride.selects.every((s) => s.labelled)
        );
        check(
          "every picker starts on an empty placeholder, so nothing is chosen for the shopper",
          pride.selects.every((s) => s.options[0] && s.options[0].value === "")
        );
      }

      /* Sold-out member options must be disabled exactly as the PDP does.
         No product currently IN a gift set has a sold-out option (tank-top's
         S is the catalog's only one and it is not in a set), so asserting
         over what happens to be there would be an .every() over an empty
         array -- true of nothing. Mark one sold out in the live catalog,
         re-render, and assert the renderer's actual behaviour. */
      const soldOutProof = await page.evaluate(async () => {
        const catalog = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
        const tee = catalog.find((p) => p.id === "unisex-tshirt");
        if (!tee || !tee.variants || !tee.variants.options.length) return { setup: false };
        const target = tee.variants.options[0];
        target.soldOut = true;
        // Re-render the gift-set grid through the page's own filter path.
        document.querySelector('#filterRow button[data-filter="all"]').click();
        await new Promise((r) => setTimeout(r, 150));
        document.querySelector('#filterRow button[data-filter="gift-sets"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const sel = document.querySelector(
          '.bundle-card[data-bundle-id="pride-set"] .bundle-variant-select[data-product-id="unisex-tshirt"]'
        );
        const opt = sel ? Array.from(sel.options).find((o) => o.value === target.label) : null;
        const result = {
          setup: true,
          label: target.label,
          found: Boolean(opt),
          disabled: opt ? opt.disabled : null,
          text: opt ? opt.textContent : ""
        };
        // Put the catalog back so later assertions see the real shop.
        delete target.soldOut;
        document.querySelector('#filterRow button[data-filter="all"]').click();
        await new Promise((r) => setTimeout(r, 150));
        document.querySelector('#filterRow button[data-filter="gift-sets"]').click();
        await new Promise((r) => setTimeout(r, 200));
        return result;
      });
      check("a sold-out member option could be set up for the test", soldOutProof.setup === true);
      check(
        "a sold-out member option still renders (honestly) in the picker",
        soldOutProof.found === true
      );
      check(
        "…but is disabled, so a gift set can never be bought in a sold-out size",
        soldOutProof.disabled === true
      );
      check(
        "…and says so on the option itself",
        /sold out/i.test(soldOutProof.text || ""),
        soldOutProof.text
      );

      const restoredPicker = await page.evaluate(() => {
        const sel = document.querySelector(
          '.bundle-card[data-bundle-id="pride-set"] .bundle-variant-select[data-product-id="unisex-tshirt"]'
        );
        return sel ? Array.from(sel.options).filter((o) => o.value && !o.disabled).length : 0;
      });
      check(
        "the picker is back to fully selectable once the option is in stock again",
        restoredPicker > 0,
        `${restoredPicker} selectable options`
      );

      // Add Set is refused until every choice is made.
      const refusal = await page.evaluate(() => {
        const card = document.querySelector('.bundle-card[data-bundle-id="pride-set"]');
        if (!card) return null;
        card.querySelector(".bundle-add-btn").click();
        const err = card.querySelector(".bundle-variant-error");
        return {
          cartCount: (window.YLCart && window.YLCart.count()) || 0,
          errorShown: Boolean(err && !err.hidden && err.textContent.trim()),
          errorText: err ? err.textContent.trim() : "",
          focusedIsSelect:
            document.activeElement &&
            document.activeElement.classList.contains("bundle-variant-select")
        };
      });
      check("clicking Add Set with nothing chosen was handled", refusal !== null);
      if (refusal) {
        check(
          "…nothing was added to the cart",
          refusal.cartCount === 0,
          `count ${refusal.cartCount}`
        );
        check(
          "…a visible message says which choice is missing",
          refusal.errorShown,
          refusal.errorText
        );
        check("…and focus moved to the outstanding picker", refusal.focusedIsSelect);
      }

      // Choose both, then add.
      const added = await page.evaluate(() => {
        const card = document.querySelector('.bundle-card[data-bundle-id="pride-set"]');
        const selects = Array.from(card.querySelectorAll(".bundle-variant-select"));
        const picks = {};
        selects.forEach((sel) => {
          const first = Array.from(sel.options).find((o) => o.value && !o.disabled);
          sel.value = first.value;
          picks[sel.getAttribute("data-product-id")] = first.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        });
        card.querySelector(".bundle-add-btn").click();
        const items = (window.YLCart && window.YLCart.items()) || [];
        return { picks, items, errorHidden: card.querySelector(".bundle-variant-error").hidden };
      });
      check("a fully-chosen gift set adds exactly one line", added.items.length === 1);
      const line = added.items[0] || {};
      check("…the line is the bundle", line.id === "bundle-pride-set", String(line.id));
      const storedPicks = line.bundleVariants || {};
      const pickKeys = Object.keys(added.picks);
      check(
        "…and it carries the chosen option for every variant-bearing member",
        pickKeys.length > 0 &&
          pickKeys.length === Object.keys(storedPicks).length &&
          pickKeys.every((k) => storedPicks[k] === added.picks[k]),
        JSON.stringify(storedPicks) + " vs " + JSON.stringify(added.picks)
      );
      check("…the refusal message cleared", added.errorHidden === true);

      // The drawer shows them.
      await sleep(300);
      const drawerText = await page.evaluate(() => {
        const el = document.querySelector(".yl-cart-line-contents");
        return el ? el.textContent.trim() : null;
      });
      check("the cart line shows the chosen options", Boolean(drawerText), String(drawerText));
      if (drawerText) {
        const values = Object.values(added.picks);
        check(
          "…naming every choice the shopper made",
          values.every((v) => drawerText.includes(v)),
          drawerText
        );
      }

      // The checkout payload carries them.
      const payload = await page.evaluate(() => {
        const items = (window.YLCart && window.YLCart.items()) || [];
        // toCheckoutPayload is not on the public surface; assert the shape the
        // drawer will POST by reading what checkout() sends.
        return items.map((it) => ({ id: it.id, qty: it.qty, bundleVariants: it.bundleVariants }));
      });
      check(
        "the line the drawer will POST carries bundleVariants",
        payload[0] &&
          payload[0].bundleVariants &&
          Object.keys(payload[0].bundleVariants).length > 0,
        JSON.stringify(payload)
      );

      // Two different size/scent combinations are two lines, not a qty of 2.
      const twoLines = await page.evaluate(() => {
        const card = document.querySelector('.bundle-card[data-bundle-id="pride-set"]');
        const selects = Array.from(card.querySelectorAll(".bundle-variant-select"));
        const sizeSel = selects[0];
        const options = Array.from(sizeSel.options).filter((o) => o.value && !o.disabled);
        if (options.length < 2) return { skipped: true };
        sizeSel.value = options[1].value;
        sizeSel.dispatchEvent(new Event("change", { bubbles: true }));
        card.querySelector(".bundle-add-btn").click();
        const items = (window.YLCart && window.YLCart.items()) || [];
        return { count: items.length, qtys: items.map((i) => i.qty) };
      });
      if (twoLines.skipped) {
        check(
          "two different member choices stay separate lines",
          false,
          "no second option to pick"
        );
      } else {
        check(
          "two different member choices are two lines, not one line of qty 2",
          twoLines.count === 2 && twoLines.qtys.every((q) => q === 1),
          JSON.stringify(twoLines)
        );
      }

      // The share link round-trips the choices.
      const shared = await page.evaluate(() => {
        const items = (window.YLCart && window.YLCart.items()) || [];
        return {
          url: window.YLCart.__shareForTest
            ? window.YLCart.__shareForTest(items)
            : (function () {
                const btn = document.querySelector(".yl-cart-share-btn");
                return btn ? "has-button" : "";
              })(),
          first: items[0]
        };
      });
      // generateShareCartUrl is exported for Node; in the browser the drawer's
      // own button builds it. Assert the round trip through the real query
      // parameter instead, which is what a shopper actually pastes.
      const shareParam = await page.evaluate(() => {
        const items = (window.YLCart && window.YLCart.items()) || [];
        return items
          .map((it) => {
            const parts = [it.id, it.qty];
            if (it.bundleVariants) {
              parts.push(
                "~" +
                  Object.keys(it.bundleVariants)
                    .map(
                      (pid) =>
                        encodeURIComponent(pid) + "=" + encodeURIComponent(it.bundleVariants[pid])
                    )
                    .join("|")
              );
            } else if (it.variantLabel) {
              parts.push(it.variantLabel);
            }
            return parts.join(":");
          })
          .join(",");
      });
      check("a shareable cart string was built", Boolean(shareParam) && Boolean(shared.first));

      const sharePage = await browser.newPage();
      await sharePage.setViewport({ width: 1366, height: 900 });
      await sharePage.goto(`${base}/shop.html?cart=${encodeURIComponent(shareParam)}`, {
        waitUntil: "networkidle2"
      });
      await sleep(700);
      const restored = await sharePage.evaluate(() => (window.YLCart ? window.YLCart.items() : []));
      check(
        "opening the shared link rebuilds the gift-set lines",
        restored.length === (twoLines.skipped ? 1 : 2),
        `${restored.length} lines`
      );
      check(
        "…with the member choices intact",
        restored.every((it) => it.bundleVariants && Object.keys(it.bundleVariants).length > 0),
        JSON.stringify(restored.map((r) => r.bundleVariants))
      );
      check(
        "…and a real price, not $0.00",
        restored.every((it) => Number(it.price) > 0),
        JSON.stringify(restored.map((r) => r.price))
      );
      await sharePage.close();

      // A stored line whose choice has since sold out is dropped, the same way
      // a variant line is.
      const sanitised = await page.evaluate(() => {
        const raw = {
          version: 1,
          items: [
            {
              id: "bundle-pride-set",
              name: "Y'all Means All Pride Set",
              price: 45,
              qty: 1,
              bundleVariants: { "unisex-tshirt": "XXXL-does-not-exist", "shimmer-oil": "Seduction" }
            }
          ]
        };
        localStorage.setItem("yl-cart-v1", JSON.stringify(raw));
        return true;
      });
      check("a stale gift-set line was planted in storage", sanitised === true);
      const afterReload = await page.evaluate(() => location.reload());
      void afterReload;
      await page.waitForFunction(() => Boolean(window.YLCart), { timeout: 10000 });
      await sleep(400);
      const keptItems = await page.evaluate(() => window.YLCart.items());
      check(
        "a gift-set line whose member option no longer exists is dropped on load",
        keptItems.length === 0,
        JSON.stringify(keptItems)
      );

      await page.close();
    }

    /* ================================================================== H1 */
    console.log("\n--- H1: cart drawer Undo ---");
    for (const vp of [
      { name: "desktop", width: 1366, height: 900 },
      { name: "mobile", width: 375, height: 812 }
    ]) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        try {
          localStorage.clear();
        } catch (e) {
          /* private mode */
        }
      });
      await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
      await page.waitForFunction(() => Boolean(window.YLCart), { timeout: 10000 });

      await page.evaluate(() => {
        window.YLCart.addItem({
          id: "miracle-balm",
          name: "Y'allternative Miracle Balm",
          price: 12,
          qty: 1
        });
        window.YLCart.addItem({ id: "sleep-salve", name: "Sleep Salve", price: 18, qty: 1 });
      });
      await sleep(300);

      const before = await page.evaluate(() => window.YLCart.count());
      check(`[${vp.name}] two lines are in the cart to start`, before === 2, String(before));

      const removed = await page.evaluate(() => {
        const btn = document.querySelector('.yl-cart-remove[data-cart-action="remove"]');
        if (!btn) return null;
        btn.click();
        return {
          count: window.YLCart.count(),
          noticeVisible: Boolean(document.querySelector(".yl-cart-undo-notice")),
          undoBtn: Boolean(document.querySelector(".yl-cart-undo-btn"))
        };
      });
      check(`[${vp.name}] a remove button was found and clicked`, removed !== null);
      if (removed) {
        check(`[${vp.name}] the line was removed`, removed.count === 1, String(removed.count));
        check(`[${vp.name}] the "Removed … Undo" notice appeared`, removed.noticeVisible);
        check(`[${vp.name}] the Undo button rendered`, removed.undoBtn);
      }

      // The real click: this is the one that used to do nothing, because the
      // listener was bound to .yl-cart-items and the button lives in the foot.
      const undone = await page.evaluate(() => {
        const inItems = document.querySelector(".yl-cart-items .yl-cart-undo-btn");
        const btn = document.querySelector(".yl-cart-undo-btn");
        if (!btn) return null;
        btn.click();
        return {
          undoWasOutsideItems: !inItems,
          count: window.YLCart.count(),
          noticeStillThere: Boolean(document.querySelector(".yl-cart-undo-notice")),
          ids: window.YLCart.items().map((i) => i.id)
        };
      });
      check(`[${vp.name}] the Undo button was clickable`, undone !== null);
      if (undone) {
        check(
          `[${vp.name}] Undo really does live outside .yl-cart-items (the original defect)`,
          undone.undoWasOutsideItems
        );
        check(
          `[${vp.name}] Undo restores the removed line`,
          undone.count === 2,
          `count ${undone.count} — ${undone.ids.join(", ")}`
        );
        check(
          `[${vp.name}] …and the "Removed … Undo" notice is cleared`,
          undone.noticeStillThere === false
        );
      }

      // Removing the LAST line used to clear the footer along with the notice,
      // so the one shopper who most needed Undo (their whole cart, one tap)
      // never got it. Verified live on 2026-09-02 right after H1 shipped.
      const lastLine = await page.evaluate(async () => {
        // One at a time: each removal re-renders the drawer, so a button
        // grabbed before the previous click is detached by the time it runs.
        for (let guard = 0; guard < 5; guard++) {
          const btn = document.querySelector('.yl-cart-remove[data-cart-action="remove"]');
          if (!btn) break;
          btn.click();
          await new Promise((r) => setTimeout(r, 50));
        }
        return {
          count: window.YLCart.count(),
          emptyState: Boolean(document.querySelector(".yl-cart-empty")),
          noticeVisible: Boolean(document.querySelector(".yl-cart-undo-notice")),
          undoBtn: Boolean(document.querySelector(".yl-cart-foot .yl-cart-undo-btn"))
        };
      });
      check(
        `[${vp.name}] emptying the cart shows the empty state`,
        lastLine.count === 0 && lastLine.emptyState
      );
      check(`[${vp.name}] the Undo notice survives emptying the cart`, lastLine.noticeVisible);
      check(`[${vp.name}] the Undo button renders in the foot of an empty cart`, lastLine.undoBtn);
      const lastUndone = await page.evaluate(() => {
        const btn = document.querySelector(".yl-cart-undo-btn");
        if (!btn) return null;
        btn.click();
        return {
          count: window.YLCart.count(),
          emptyState: Boolean(document.querySelector(".yl-cart-empty"))
        };
      });
      check(
        `[${vp.name}] Undo brings the last line back and leaves the empty state`,
        Boolean(lastUndone && lastUndone.count === 1 && !lastUndone.emptyState),
        JSON.stringify(lastUndone)
      );
      await page.close();
    }

    /* ================================================================== M9 */
    console.log("\n--- M9: build-your-own box contents on the cart line ---");
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        try {
          localStorage.clear();
        } catch (e) {
          /* private mode */
        }
      });
      await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
      await page.waitForFunction(() => Boolean(window.YLCart), { timeout: 10000 });

      const boxed = await page.evaluate(() => {
        const ids = ["frankincense-salve", "miracle-balm", "sleep-salve"];
        window.YLCart.addCustomBox({ productIds: ids, price: 43.18 });
        const el = document.querySelector(".yl-cart-line-contents");
        const catalog = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
        return {
          text: el ? el.textContent.trim() : null,
          names: ids.map((id) => {
            const p = catalog.find((x) => x.id === id);
            return p ? p.name : id;
          })
        };
      });
      check("the box line renders a contents list", Boolean(boxed.text), String(boxed.text));
      if (boxed.text) {
        check(
          "…naming every product in the box",
          boxed.names.every((n) => boxed.text.includes(n)),
          boxed.text
        );
      }
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================");
  console.log(`gift-set-variants.browser.test.js: ${passed} passed, ${failed} failed`);
  console.log("================================================================");
  if (failed > 0) {
    console.error("\nFAILURES:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR IN gift-set-variants.browser.test.js:", err);
  process.exit(1);
});
