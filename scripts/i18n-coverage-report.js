/**
 * @fileoverview Measures how much of a page the translator actually changes.
 *
 * The 2026-09-01 audit reported 10-20% coverage using one specific method, and
 * any claim about improving that number is only comparable if it is measured
 * the same way. This is that method, committed so the number can be re-derived
 * instead of quoted: load a page in an isolated browser context, snapshot every
 * non-empty text node, call YL_TRANSLATOR.setLanguage(lang) directly (so the
 * script-order race cannot distort the reading), snapshot again, and report
 * changed nodes over non-empty nodes.
 *
 * Nodes inside a subtree translator.js skips are excluded from BOTH halves of
 * the fraction -- counting the language selector's own labels as "untranslated"
 * would understate coverage for a reason that has nothing to do with the
 * dictionary. Everything else is counted, including the strings that are
 * deliberately never translated (product names, prices, INCI botanicals,
 * verbatim customer reviews and the bodies of the four legal pages), because
 * hiding those from the denominator would turn a real ceiling into a flattering
 * number. --detail prints what stayed English so the ceiling can be inspected.
 *
 * Run:
 *   node scripts/i18n-coverage-report.js
 *   node scripts/i18n-coverage-report.js --lang es --detail
 *   node scripts/i18n-coverage-report.js --json before.json
 */

/* global document, window, NodeFilter, Node */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 8088;
const ROOT = path.resolve(__dirname, "..");

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
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

function createStaticServer(port) {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
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
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, "127.0.0.1", () => resolve(server));
      } else {
        reject(err);
      }
    });
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Snapshot every non-empty text node the translator is allowed to touch.
   Same skip rules as assets/js/translator.js, so the denominator is the set of
   nodes the engine could in principle change. `rootSelector` narrows it to one
   surface -- the cart drawer, the search modal, the quiz -- so a dynamic
   surface is not scored against the whole page it happens to sit on. */
function snapshotTextNodes(rootSelector) {
  const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEMPLATE"];
  const SKIP_CLASSES = [
    "notranslate",
    "skiptranslate",
    "brand",
    "brand-word",
    "lang-selector-wrap",
    "lang-dropdown",
    "lang-toggle"
  ];
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName ? el.tagName.toUpperCase() : "";
    if (SKIP_TAGS.indexOf(tag) !== -1) return true;
    if (el.id === "langSelectorWrap" || el.id === "tawk-chat-container") return true;
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    if (el.classList) {
      for (let i = 0; i < SKIP_CLASSES.length; i++) {
        if (el.classList.contains(SKIP_CLASSES[i])) return true;
      }
    }
    return false;
  }
  const out = [];
  if (!document.body) return out;
  let root = document.body;
  if (rootSelector) {
    const found = document.querySelector(rootSelector);
    if (!found) return out;
    root = found;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      let curr = n.parentNode;
      while (curr && curr !== document.documentElement) {
        if (curr.nodeType === 1 && shouldSkipElement(curr)) return NodeFilter.FILTER_REJECT;
        curr = curr.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const v = node.nodeValue == null ? "" : node.nodeValue.trim();
    if (!v) continue;
    out.push(v);
  }
  return out;
}

/* Surfaces measured in addition to whole pages. Each opens something that
   only exists after JavaScript has run, so the MutationObserver -- not the
   initial full-tree walk -- is what has to translate it. */
const SURFACES = {
  "cart-drawer": {
    page: "shop.html",
    /* A specific line, added through the public API rather than by clicking
       whichever card happens to be first: the two loads have to put the SAME
       thing in the drawer or the comparison is measuring the catalogue, not the
       dictionary. The dispatch countdown is switched off for the same reason --
       it renders "ships in N hours", which differs between two page loads
       seconds apart and would read as a translated string. */
    open: async (page) => {
      await page.evaluate(() => {
        window.YL_CONTENT = window.YL_CONTENT || {};
        window.YL_CONTENT.site = window.YL_CONTENT.site || {};
        window.YL_CONTENT.site.enableDispatchCountdown = false;
        if (!window.YLCart) return;
        window.YLCart.clear();
        window.YLCart.addItem({
          id: "lavender-soak",
          name: "Lavender Epsom Salt Soak",
          price: 18,
          qty: 1
        });
        window.YLCart.open();
      });
      await pause(700);
    },
    root: "#yl-cart-drawer"
  },
  "search-modal": {
    page: "index.html",
    open: async (page) => {
      await page.evaluate(() => {
        const btn = document.getElementById("globalSearchTrigger");
        if (btn) btn.click();
      });
      await pause(400);
      await page.evaluate(() => {
        const input = document.querySelector(
          "#global-search-modal input[type='search'], #globalSearchInput"
        );
        if (input) {
          input.value = "salve";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await pause(700);
    },
    root: "#global-search-modal"
  },
  quiz: {
    page: "shop.html",
    open: async (page) => {
      await page.evaluate(() => {
        const btn = document.getElementById("open-apothecary-quiz-btn");
        if (btn) btn.click();
      });
      await pause(600);
    },
    root: "#apothecary-quiz-modal, #apothecary-quiz-section"
  }
};

const PAGES = ["index.html", "shop.html", "products/sleep-salve.html", "faq.html"];

async function load(browser, boundPort, pageName) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  /* Every page in one browser shares an origin's localStorage, and
     setLanguage() persists the choice under `yl-lang`. Measuring one page in
     Spanish therefore left the NEXT page loading already translated, so its
     "before" snapshot was Spanish and the run reported 0% changed for a page
     that was fully translated. Cleared before any page script runs. */
  await page.evaluateOnNewDocument(() => {
    try {
      window.localStorage.removeItem("yl-lang");
    } catch {
      /* storage unavailable -- nothing to clear */
    }
  });
  await page.goto("http://127.0.0.1:" + boundPort + "/" + pageName, {
    waitUntil: "networkidle2",
    timeout: 45000
  });
  await page.waitForFunction("window.YL_TRANSLATOR && window.YL_LOCALES", { timeout: 20000 });
  /* Re-initialise once both scripts are in. main.js injects translator.js and
     locales-data.js as dynamic scripts, which run in network-completion order,
     so translator.js can build its lookup indices against an empty
     window.YL_LOCALES and then translate nothing at all -- the audit's finding
     #1. That race is a separate bug with a separate fix; letting it into these
     numbers would mean reporting "0% coverage" for a page whose dictionary is
     fine. Resetting and re-initialising here measures the dictionary, which is
     what this script is for. */
  await page.evaluate(async () => {
    window.YL_TRANSLATOR._resetInternalState();
    await window.YL_TRANSLATOR.init();
  });
  await pause(150);
  return page;
}

async function measure(browser, boundPort, target, lang, detail) {
  const surface = SURFACES[target];
  const pageName = surface ? surface.page : target;

  /* A whole page is measured by translating it in place. A dynamic surface is
     measured across TWO loads instead, with the language set BEFORE the surface
     renders in the second one: that is the only way to exercise the
     MutationObserver, which is the code path that has to translate markup the
     initial full-tree walk never saw. Translating the surface after opening it
     would score the walk again and prove nothing about the observer. */
  if (surface) {
    const enPage = await load(browser, boundPort, pageName);
    let before;
    try {
      await surface.open(enPage);
      before = await enPage.evaluate(snapshotTextNodes, surface.root);
    } finally {
      await enPage.close().catch(() => {});
    }

    const langPage = await load(browser, boundPort, pageName);
    let after;
    try {
      await langPage.evaluate(async (l) => {
        await window.YL_TRANSLATOR.setLanguage(l);
      }, lang);
      await pause(200);
      await surface.open(langPage);
      await pause(400);
      after = await langPage.evaluate(snapshotTextNodes, surface.root);
    } finally {
      await langPage.close().catch(() => {});
    }

    if (!before.length) {
      throw new Error(
        "surface '" +
          target +
          "' produced no text nodes for " +
          surface.root +
          " -- refusing to report 0/0 as a result"
      );
    }
    /* Compared as a multiset, not position by position. The two snapshots come
       from two separate page loads, so a node that merely moved would read as
       "translated" under a positional diff -- which is exactly how an earlier
       version of this script reported 85% for a cart drawer that had barely
       changed. A string still present in the English snapshot did not get
       translated, wherever it now sits. */
    const remaining = new Map();
    before.forEach((t) => remaining.set(t, (remaining.get(t) || 0) + 1));
    const untouchedRows = [];
    after.forEach((t) => {
      const n = remaining.get(t);
      if (n) {
        remaining.set(t, n - 1);
        untouchedRows.push(t);
      }
    });
    const ch = before.length - untouchedRows.length;
    const res = {
      target: target,
      nodes: before.length,
      changed: ch,
      pct: Math.round((ch / before.length) * 1000) / 10,
      drift: before.length !== after.length ? after.length - before.length : 0
    };
    if (detail) {
      const f = new Map();
      untouchedRows.forEach((t) => f.set(t, (f.get(t) || 0) + 1));
      res.untouched = Array.from(f.entries())
        .sort((a, b) => b[1] - a[1])
        .map((e) => ({ text: e[0], count: e[1] }));
    }
    return res;
  }

  const page = await load(browser, boundPort, pageName);
  try {
    const before = await page.evaluate(snapshotTextNodes, null);
    await page.evaluate(async (l) => {
      await window.YL_TRANSLATOR.setLanguage(l);
    }, lang);
    await pause(300);
    const after = await page.evaluate(snapshotTextNodes, null);

    const n = Math.min(before.length, after.length);
    let changed = 0;
    const untouched = [];
    for (let i = 0; i < n; i++) {
      if (before[i] !== after[i]) changed++;
      else untouched.push(before[i]);
    }
    const pct = before.length ? (changed / before.length) * 100 : 0;
    const result = {
      target: target,
      nodes: before.length,
      changed: changed,
      pct: Math.round(pct * 10) / 10,
      drift: before.length !== after.length ? after.length - before.length : 0
    };
    if (detail) {
      const freq = new Map();
      untouched.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
      result.untouched = Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .map((e) => ({ text: e[0], count: e[1] }));
    }
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const args = process.argv.slice(2);
  const langIdx = args.indexOf("--lang");
  const lang = langIdx !== -1 ? args[langIdx + 1] : "es";
  const detail = args.indexOf("--detail") !== -1;
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx !== -1 ? args[jsonIdx + 1] : null;

  const targets = PAGES.concat(Object.keys(SURFACES));
  const server = await createStaticServer(PORT);
  const boundPort = server.address().port;
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const rows = [];
  try {
    for (const target of targets) {
      rows.push(await measure(browser, boundPort, target, lang, detail));
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  console.log("\nTranslation coverage [" + lang + "] -- changed text nodes / non-empty text nodes");
  console.log("-".repeat(64));
  rows.forEach((r) => {
    console.log(
      "  " +
        r.target.padEnd(30) +
        String(r.nodes).padStart(6) +
        String(r.changed).padStart(8) +
        (r.pct.toFixed(1) + "%").padStart(9) +
        (r.drift ? "   (node count drift " + r.drift + ")" : "")
    );
  });

  if (detail) {
    rows.forEach((r) => {
      console.log("\n### still English on " + r.target + " (top 40)");
      (r.untouched || []).slice(0, 40).forEach((u) => {
        console.log("  x" + u.count + "  " + JSON.stringify(u.text).slice(0, 130));
      });
    });
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ lang: lang, rows: rows }, null, 2) + "\n");
    console.log("\nWrote " + jsonOut);
  }
})().catch((err) => {
  console.error("i18n-coverage-report crashed:", err);
  process.exit(1);
});
