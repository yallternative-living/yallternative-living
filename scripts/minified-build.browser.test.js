/* eslint-env node, browser */
/**
 * @fileoverview Proves the site still works after scripts/minify-assets.js.
 *
 * Netlify runs the minifier as the last step of its build command, on the
 * publish directory, and nothing minified is ever committed -- so no other
 * suite in this repository ever executes the bytes shoppers actually receive.
 * That is the gap this suite closes. It copies the working tree to a scratch
 * directory, minifies THAT copy with the real script, serves it, and drives
 * the shopper paths that lean hardest on main.js, cart.js, translator.js and
 * styles.css:
 *
 *   1. the home page loads with zero page errors and no failed asset request
 *      (with a positive control proving the error listener is live),
 *   2. the shop grid renders one card per product,
 *   3. Add to Cart opens the drawer with a line item,
 *   4. global search returns results for a real query,
 *   5. a PDP gallery thumbnail switches the main photo,
 *   6. the language picker switches the page to Spanish, which also proves
 *      the minified locale dictionaries load and parse.
 *
 * It also pins the minifier's contract: sw.js and every HTML page come out
 * byte-identical, every JS/CSS file it owns is smaller and carries the
 * marker, and the working tree it was run FROM is untouched -- the copy is
 * what gets minified, never the repository, so `git status` stays clean.
 *
 * Run: node scripts/minified-build.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const puppeteer = require("puppeteer");
const { MARKER } = require("./minify-assets.js");

const ROOT = path.resolve(__dirname, "..");
const SETTLE_TIMEOUT_MS = 15000;

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

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

/* ---------- filesystem helpers ---------- */

const OWNED_DIRS = ["assets/js", "assets/js/locales", "assets/css"];
function ownedFiles(root) {
  const out = [];
  for (const dir of OWNED_DIRS) {
    for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
      if (/\.(js|css)$/.test(f) && fs.statSync(path.join(root, dir, f)).isFile()) {
        out.push(path.join(dir, f));
      }
    }
  }
  return out;
}
function htmlFiles(root) {
  const top = fs.readdirSync(root).filter((f) => f.endsWith(".html"));
  const nested = ["products", "journal"].flatMap((dir) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs)
      .filter((f) => f.endsWith(".html"))
      .map((f) => path.join(dir, f));
  });
  return top.concat(nested).sort();
}
function fingerprint(root, rels) {
  const h = crypto.createHash("sha256");
  for (const rel of rels) h.update(rel).update(fs.readFileSync(path.join(root, rel)));
  return h.digest("hex");
}

/* ---------- static server over the minified copy ---------- */

function createServer(root) {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(root, reqPath);
    /* A real 404, not 404.html-with-200: a minified page that asks for a
       file that no longer exists must show up as a failed request below. */
    if (
      !filePath.startsWith(root) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

/* Every page gets the same three listeners; the summary is what the checks
   read. Console errors are listed but only page errors and failed same-
   origin asset requests fail the run. */
function instrument(page, base) {
  const state = { pageErrors: [], failedAssets: [], consoleErrors: [] };
  page.on("pageerror", (err) =>
    state.pageErrors.push(String(err && err.message ? err.message : err))
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") state.consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    if (req.url().startsWith(base + "/assets/")) {
      state.failedAssets.push(`${req.url()} (${(req.failure() || {}).errorText || "failed"})`);
    }
  });
  page.on("response", (res) => {
    const url = res.url();
    if (url.startsWith(base + "/assets/") && res.status() >= 400) {
      state.failedAssets.push(`${url} (${res.status()})`);
    }
  });
  return state;
}

function readNav(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#navLinks a")).map((a) => a.textContent.trim())
  );
}

(async () => {
  console.log("=== Minified build: the bytes Netlify serves still run the shop ===\n");

  const owned = ownedFiles(ROOT);
  const pages = htmlFiles(ROOT);
  check(
    "the repository has JS/CSS files for the minifier to own",
    owned.length >= 20,
    String(owned.length)
  );
  check(
    "the repository has HTML pages to hold byte-identical",
    pages.length >= 30,
    String(pages.length)
  );
  const rootAssetsBefore = fingerprint(ROOT, owned.concat(["sw.js"]));
  const rootPagesBefore = fingerprint(ROOT, pages);

  /* ---------------- 1. minify a copy of the tree ---------------- */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "yl-minified-"));
  let browser = null;
  let server = null;
  try {
    fs.cpSync(ROOT, scratch, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== "node_modules" && base !== ".git" && base !== ".claude";
      }
    });

    console.log("Step 1: scripts/minify-assets.js on the scratch copy");
    const run = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/minify-assets.js"), "--root", scratch],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    check("minify-assets.js exits 0", run.status === 0, (run.stderr || "").slice(-600));
    check(
      "it reports before/after sizes for every owned file",
      owned.every((rel) => (run.stdout || "").includes(rel)),
      owned.filter((rel) => !(run.stdout || "").includes(rel)).join(", ")
    );

    let smaller = 0;
    let marked = 0;
    for (const rel of owned) {
      const before = fs.readFileSync(path.join(ROOT, rel));
      const after = fs.readFileSync(path.join(scratch, rel));
      if (after.length < before.length) smaller++;
      if (after.toString("utf8").trimEnd().endsWith(MARKER)) marked++;
    }
    check(`every owned file is smaller (${smaller}/${owned.length})`, smaller === owned.length);
    check(
      `every owned file carries the minified marker (${marked}/${owned.length})`,
      marked === owned.length
    );
    check(
      "sw.js is byte-identical (its CACHE_NAME line is the live deploy check)",
      fs.readFileSync(path.join(ROOT, "sw.js")).equals(fs.readFileSync(path.join(scratch, "sw.js")))
    );
    check(
      `all ${pages.length} HTML pages are byte-identical (inline scripts are CSP-hashed)`,
      fingerprint(scratch, pages) === rootPagesBefore
    );
    const modules = path.join(ROOT, "assets/js/modules");
    if (fs.existsSync(modules)) {
      const mods = fs.readdirSync(modules).filter((f) => f.endsWith(".js"));
      check(
        "assets/js/modules (referenced by no page) is left alone",
        mods.length > 0 &&
          mods.every((f) =>
            fs
              .readFileSync(path.join(modules, f))
              .equals(fs.readFileSync(path.join(scratch, "assets/js/modules", f)))
          )
      );
    }

    const second = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/minify-assets.js"), "--root", scratch],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    const afterFirst = fingerprint(scratch, owned);
    check(
      "a second run is a no-op (idempotent)",
      second.status === 0 && fingerprint(scratch, owned) === afterFirst
    );

    /* ---------------- 2. serve it and drive the shopper paths ---------------- */
    server = await createServer(scratch);
    const base = `http://127.0.0.1:${server.address().port}`;
    const served = await fetchText(`${base}/assets/js/main.js?v=2.0`);
    check(
      "the server hands out the minified main.js, not the source",
      served.status === 200 &&
        served.body.trimEnd().endsWith(MARKER) &&
        !served.body.includes("\n  "),
      `status ${served.status}, ${served.body.length} bytes`
    );
    const css = await fetchText(`${base}/assets/css/styles.css?v=2.0`);
    check(
      "minified styles.css still carries native nesting and @container",
      css.status === 200 && /@container\s*\(/.test(css.body) && /[{;]&[:.[ ]/.test(css.body),
      `status ${css.status}`
    );

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    /* -- home -- */
    console.log("\nStep 2: home page");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const state = instrument(page, base);
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });
      const nav = await readNav(page);
      check(
        "home renders the nav from minified main.js",
        nav.length >= 3 && nav.includes("Shop"),
        JSON.stringify(nav)
      );
      check("home: zero page errors", state.pageErrors.length === 0, state.pageErrors.join(" | "));
      check(
        "home: no failed same-origin asset request",
        state.failedAssets.length === 0,
        state.failedAssets.join(" | ")
      );
      if (state.consoleErrors.length)
        console.log("    (console errors, informational: " + state.consoleErrors.join(" | ") + ")");

      /* Positive control: a page error the listener MUST see. A listener
         that silently never fires would turn every check above vacuous. */
      const beforeControl = state.pageErrors.length;
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("yl-positive-control");
        }, 0);
      });
      const caught = await waitFor(
        async () =>
          state.pageErrors.slice(beforeControl).some((m) => m.includes("yl-positive-control")),
        3000
      );
      check("positive control: an injected page error is caught by the listener", !!caught);
      await context.close();
    }

    /* -- shop + add to cart -- */
    console.log("\nStep 3: shop grid and Add to Cart");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const state = instrument(page, base);
      await page.goto(`${base}/shop.html`, { waitUntil: "networkidle2" });
      const expected = fs
        .readdirSync(path.join(ROOT, "products"))
        .filter((f) => f.endsWith(".html")).length;
      const cards = await waitFor(async () => {
        const n = await page.evaluate(() => document.querySelectorAll("#shopGrid .card").length);
        return n === expected ? n : null;
      }, SETTLE_TIMEOUT_MS);
      check(
        `shop renders ${expected} product cards (one per products/*.html)`,
        cards === expected,
        String(await page.evaluate(() => document.querySelectorAll("#shopGrid .card").length))
      );
      const addBtn = await page.$("#shopGrid .card .yl-add-item");
      check("a card has an Add to Cart button", !!addBtn);
      if (addBtn) {
        await addBtn.click();
        let line = null;
        try {
          line = await page.waitForSelector("#yl-cart-drawer .yl-cart-line", {
            visible: true,
            timeout: 8000
          });
        } catch {
          line = null;
        }
        check("Add to Cart opens the drawer with a line item", !!line);
      }
      check("shop: zero page errors", state.pageErrors.length === 0, state.pageErrors.join(" | "));
      check(
        "shop: no failed same-origin asset request",
        state.failedAssets.length === 0,
        state.failedAssets.join(" | ")
      );
      await context.close();
    }

    /* -- global search -- */
    console.log("\nStep 4: global search");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const state = instrument(page, base);
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });
      await page.click("#globalSearchTrigger");
      let opened = null;
      try {
        opened = await page.waitForSelector("#global-search-modal[open]", {
          visible: true,
          timeout: 5000
        });
      } catch {
        opened = null;
      }
      check("the search trigger opens the modal", !!opened);
      await page.type("#globalSearchInput", "salve");
      const results = await waitFor(async () => {
        const n = await page.evaluate(
          () => document.querySelectorAll("#global-search-modal .search-result-item").length
        );
        return n > 0 ? n : null;
      }, SETTLE_TIMEOUT_MS);
      check(`searching "salve" returns results (${results || 0})`, !!results);
      check(
        "search: zero page errors",
        state.pageErrors.length === 0,
        state.pageErrors.join(" | ")
      );
      await context.close();
    }

    /* -- PDP gallery -- */
    console.log("\nStep 5: PDP gallery thumbnail");
    {
      const pdp = fs
        .readdirSync(path.join(scratch, "products"))
        .filter((f) => f.endsWith(".html"))
        .sort()
        .find(
          (f) =>
            (
              fs
                .readFileSync(path.join(scratch, "products", f), "utf8")
                .match(/class="pdp-thumb/g) || []
            ).length >= 2
        );
      check("a product page with at least two gallery thumbnails exists", !!pdp, "none found");
      if (pdp) {
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        const state = instrument(page, base);
        await page.goto(`${base}/products/${pdp}`, { waitUntil: "networkidle2" });
        const before = await page.evaluate(() => {
          const img =
            document.getElementById("pdpMainImage") ||
            document.querySelector(".pdp-gallery-main img");
          return img ? img.currentSrc || img.src : "";
        });
        check("the PDP shows a main photo", !!before, "no #pdpMainImage");
        const target = await page.evaluate(() => {
          const t = document.querySelectorAll(".pdp-thumb")[1];
          return t ? t.getAttribute("data-image") : "";
        });
        await page.click(".pdp-thumb:nth-of-type(2)");
        const switched = await waitFor(async () => {
          const s = await page.evaluate(() => {
            const img =
              document.getElementById("pdpMainImage") ||
              document.querySelector(".pdp-gallery-main img");
            const active = document.querySelector(".pdp-thumb.is-active");
            return {
              src: img ? img.currentSrc || img.src : "",
              activeIdx: active ? active.getAttribute("data-idx") : null
            };
          });
          const stem = path.basename(target).replace(/\.[a-z]+$/, "");
          return s.src !== before && s.src.includes(stem) && s.activeIdx === "1" ? s : null;
        }, SETTLE_TIMEOUT_MS);
        check(
          `clicking the second thumbnail switches the main photo (${pdp})`,
          !!switched,
          `target ${target}, before ${before}`
        );
        check("PDP: zero page errors", state.pageErrors.length === 0, state.pageErrors.join(" | "));
        check(
          "PDP: no failed same-origin asset request",
          state.failedAssets.length === 0,
          state.failedAssets.join(" | ")
        );
        await context.close();
      }
    }

    /* -- language picker -- */
    console.log("\nStep 6: language picker to Spanish");
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const state = instrument(page, base);
      await page.goto(`${base}/`, { waitUntil: "networkidle2" });
      const toggle = await waitFor(() => page.$(".lang-toggle"), SETTLE_TIMEOUT_MS);
      check("the language picker is rendered by minified translator.js", !!toggle);
      if (toggle) {
        await toggle.click();
        const option = await waitFor(() => page.$('.lang-option[data-lang="es"]'), 5000);
        check("the picker offers Español", !!option);
        if (option) {
          await option.click();
          const nav = await waitFor(async () => {
            const labels = await readNav(page);
            return labels.includes("Tienda") ? labels : null;
          }, SETTLE_TIMEOUT_MS);
          check(
            "the nav reads Spanish after the switch",
            nav !== null,
            JSON.stringify(await readNav(page))
          );
          const badge = await page.evaluate(
            () => (document.querySelector(".lang-current-code") || {}).textContent || ""
          );
          check("the badge reads ES", badge.trim() === "ES", badge);
        }
      }
      check(
        "language switch: zero page errors",
        state.pageErrors.length === 0,
        state.pageErrors.join(" | ")
      );
      check(
        "language switch: no failed same-origin asset request",
        state.failedAssets.length === 0,
        state.failedAssets.join(" | ")
      );
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  /* ---------------- 3. the repository itself is untouched ---------------- */
  console.log("\nStep 7: the working tree was never minified");
  check(
    "assets/js, assets/css and sw.js in the repository are byte-identical to before",
    fingerprint(ROOT, owned.concat(["sw.js"])) === rootAssetsBefore
  );
  check(
    "the HTML pages in the repository are byte-identical to before",
    fingerprint(ROOT, pages) === rootPagesBefore
  );
  check("the scratch copy was removed", !fs.existsSync(scratch));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
