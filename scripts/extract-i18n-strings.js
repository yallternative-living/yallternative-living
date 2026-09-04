/**
 * @fileoverview Extracts every user-visible English string the client-side
 * translator can actually reach, from the BUILT site rendered in a real
 * browser -- not from a mental model of the shop.
 *
 * Why this exists: the first cut of assets/data/locales/*.json was authored by
 * hand against an imagined page. 120 of its 206 English values (58%) matched
 * nothing on any page, because the lookup in assets/js/translator.js is exact
 * string equality on the trimmed text of a node. "Your cart is empty" never
 * fired because the DOM says "Your cart is empty."; "Patch Test" never fired
 * because the DOM says "Patch Test:". One character defeats the whole lookup.
 * The only way to author a dictionary against that mechanism is to read the
 * strings back out of the rendered DOM.
 *
 * This drives the same surfaces a shopper does -- including the ones that
 * exist only after JavaScript runs (cart drawer, search results and empty
 * states, quiz results, sticky bar, notices) -- and reports what it finds with
 * the counts and pages each string came from. Its output is the raw material
 * for assets/data/locales/en.json and for assets/data/i18n-runtime-strings.json,
 * the manifest of strings that live only at runtime and so can never be found
 * by grepping the built HTML.
 *
 * It is a hand-run authoring tool, not a gate, and it is INCREMENTAL by
 * design: --sync diffs the live site against the shipped dictionary and prints
 * exactly three lists -- strings the site shows that the dictionary lacks,
 * dictionary entries the site no longer shows, and keys whose English changed
 * since the five translations were authored. It never rewrites a locale file,
 * so a translation can never be silently dropped by running it.
 *
 * The gate that keeps the dictionary honest between runs lives in
 * scripts/build-site-data.js (validateDictionaryCoverage) and is re-asserted by
 * scripts/qa-check.js. That gate is static and browserless so it can run in
 * CI's `qa` job, which sets PUPPETEER_SKIP_DOWNLOAD.
 *
 * Run:
 *   node scripts/extract-i18n-strings.js                  # summary to stdout
 *   node scripts/extract-i18n-strings.js --json out.json  # full machine report
 *   node scripts/extract-i18n-strings.js --sync           # incremental diff
 *
 * Set YL_I18N_BASE_URL to render a copy of the built site somebody else is
 * already serving instead of starting a server here; scripts/i18n-new-strings.js
 * --base <url> sets it for you.
 */

/* global document, window, NodeFilter, Node */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const PORT = 8087;
const ROOT = path.resolve(__dirname, "..");
const LOCALE_CODES = ["en", "es", "de", "fr", "ja", "zh", "vi", "ko", "pt"];

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

/* The four pages whose BODY copy stays in English. MoCRA adverse-event
   wording, the EU cosmetic-claims position and the terms of sale are legal
   instruments; a dictionary-shaped approximation of them is a liability, not
   a feature. Only their chrome (header, nav, footer, announcement bar) is in
   scope, and each carries a line saying the English text governs. */
const LEGAL_PAGES = ["terms.html", "privacy.html", "policies.html", "safety.html"];

/* Subtrees that are out of scope for the dictionary. Reviews are verbatim
   customer text carried over from Etsy and are never translated; the language
   selector is skipped by translator.js itself. */
const EXCLUDED_SELECTORS = [
  ".reviews-list",
  ".review-card",
  ".pdp-review-card",
  ".pdp-reviews-list",
  ".ugc-strip",
  "#langSelectorWrap",
  ".lang-selector-wrap",
  ".lang-dropdown",
  "[data-review-body]"
];

function collectPages() {
  const top = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .sort();
  const productsDir = path.join(ROOT, "products");
  const products = fs.existsSync(productsDir)
    ? fs
        .readdirSync(productsDir)
        .filter((f) => f.endsWith(".html"))
        .sort()
        .map((f) => "products/" + f)
    : [];
  return top.concat(products);
}

/* ---------------------------------------------------------------
   In-page collector. Mirrors the traversal rules in
   assets/js/translator.js exactly: SHOW_ELEMENT|SHOW_TEXT rooted at
   document.body, the same skipped tags/classes/ids, plus document.title and
   the same three attributes (placeholder, aria-label, title). A string this
   collector does not return is a string the translator cannot reach, so it
   has no business being in the dictionary.
   --------------------------------------------------------------- */
function inPageCollect(opts) {
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

  const excluded = [];
  (opts.excludedSelectors || []).forEach(function (sel) {
    let nodes = [];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      nodes = [];
    }
    nodes.forEach(function (n) {
      excluded.push(n);
    });
  });
  if (opts.legalBody) {
    const main = document.getElementById("main-content");
    if (main) excluded.push(main);
  }

  function isExcluded(node) {
    let curr = node.nodeType === 1 ? node : node.parentNode;
    while (curr && curr !== document.documentElement) {
      if (excluded.indexOf(curr) !== -1) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  const found = [];
  function push(value, kind, el) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    let selector = "";
    const target = el && el.nodeType === 1 ? el : el && el.parentElement;
    if (target && target.tagName) {
      selector =
        target.tagName.toLowerCase() +
        (target.id ? "#" + target.id : "") +
        (target.className && typeof target.className === "string"
          ? "." + target.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "");
    }
    found.push({ text: trimmed, kind: kind, selector: selector });
  }

  if (document.title) push(document.title, "title", document.documentElement);
  if (!document.body || shouldSkipElement(document.body)) return found;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: function (n) {
        if (n.nodeType === 1 && shouldSkipElement(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    if (isExcluded(node)) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.nodeValue, "text", node.parentElement);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.hasAttribute("placeholder")) {
      push(node.getAttribute("placeholder"), "placeholder", node);
    }
    if (node.hasAttribute("aria-label")) {
      push(node.getAttribute("aria-label"), "aria-label", node);
    }
    if (node.hasAttribute("title")) {
      push(node.getAttribute("title"), "title", node);
    }
  }
  return found;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------
   Dynamic surfaces: what only exists after JavaScript has run, and so
   appears in no .html file on disk. Driving them in a real browser is the
   only way to capture the EXACT punctuation the DOM ends up with -- the
   trailing period on "Your cart is empty." is the entire reason the previous
   dictionary missed it.
   --------------------------------------------------------------- */
const SURFACES = [
  {
    name: "cart-drawer-empty",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        if (window.YLCart && window.YLCart.open) window.YLCart.open();
      });
      await pause(500);
    }
  },
  {
    name: "cart-drawer-filled",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const btn = document.querySelector(".yl-add-item, [data-yl-add]");
        if (btn) btn.click();
        else if (window.YLCart && window.YLCart.open) window.YLCart.open();
      });
      await pause(800);
      await page.evaluate(() => {
        if (window.YLCart && window.YLCart.open) window.YLCart.open();
      });
      await pause(400);
    }
  },
  {
    name: "search-modal-idle",
    page: "index.html",
    run: async (page) => {
      await page.evaluate(() => {
        const btn = document.getElementById("globalSearchTrigger");
        if (btn) btn.click();
      });
      await pause(500);
    }
  },
  {
    name: "search-modal-results",
    page: "index.html",
    run: async (page) => {
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
    }
  },
  {
    name: "search-modal-empty",
    page: "index.html",
    run: async (page) => {
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
          input.value = "zzzznope";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await pause(700);
    }
  },
  {
    name: "quiz-modal",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const btn = document.getElementById("open-apothecary-quiz-btn");
        if (btn) btn.click();
      });
      await pause(600);
    }
  },
  {
    name: "quiz-results",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const btn = document.getElementById("open-apothecary-quiz-btn");
        if (btn) btn.click();
      });
      await pause(500);
      await page.evaluate(() => {
        ["quiz-vibe", "quiz-need", "quiz-intent"].forEach((n) => {
          const inp = document.querySelector('input[name="' + n + '"]');
          if (inp) {
            inp.checked = true;
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        const submit = document.getElementById("quiz-submit-btn");
        if (submit) submit.click();
      });
      await pause(900);
    }
  },
  {
    name: "gift-card-modal",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const modal = document.getElementById("giftCardModal");
        if (modal && modal.showModal) {
          try {
            modal.showModal();
          } catch {
            modal.setAttribute("open", "");
          }
        }
      });
      await pause(500);
    }
  },
  {
    name: "restock-modal",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const modal = document.getElementById("restock-alert-modal");
        if (modal && modal.showModal) {
          try {
            modal.showModal();
          } catch {
            modal.setAttribute("open", "");
          }
        }
      });
      await pause(500);
    }
  },
  {
    name: "pdp-sticky-bar",
    page: "products/sleep-salve.html",
    run: async (page) => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.65));
      await pause(900);
    }
  },
  {
    name: "wishlist",
    page: "shop.html",
    run: async (page) => {
      await page.evaluate(() => {
        const btn = document.querySelector(
          "[data-wishlist-toggle], .wishlist-btn, .wishlist-toggle, [data-wishlist]"
        );
        if (btn) btn.click();
      });
      await pause(600);
    }
  }
];

const keyOf = (entry) => entry.kind + "|" + entry.text;
const digest = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 10);

/* ---------------------------------------------------------------
   Template recognition for --sync's "reachable but not in the dictionary"
   list. A "tpl.*" dictionary phrase like "Add {amount} Gift Card to Cart"
   never appears literally anywhere -- translator.js fills the {placeholder}s
   in at runtime (see its file header) -- so without this, every finished
   string it produces ("Add $25 Gift Card to Cart", "Add $50 Gift Card to
   Cart", one per amount a shopper could type) would show up here forever,
   looking like an ever-growing pile of untranslated copy. Turning each
   template into a regex (escape the literal parts, turn each {name} into a
   capture group) and matching the live site's strings against it is what
   lets --sync recognize "this IS covered, just not by an exact-value key"
   instead of the alternative of hand-maintaining a list of literal example
   strings to ignore, which would silently go stale the moment a product
   name or a CMS-authored reward changed.
   --------------------------------------------------------------- */
function buildTemplateMatchers(enPhrases) {
  const matchers = [];
  Object.keys(enPhrases || {}).forEach((key) => {
    if (key.indexOf("tpl.") !== 0) return;
    const template = enPhrases[key];
    if (typeof template !== "string" || template.indexOf("{") === -1) return;
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\\\{(\w+)\\\}/g, "(.+?)");
    try {
      matchers.push({ key: key, regex: new RegExp("^" + pattern + "$", "u") });
    } catch {
      // An unbuildable pattern just means this key can't be recognized here;
      // it still fails loud in validateDictionaryCoverage if truly dead.
    }
  });
  return matchers;
}

function matchingTemplateKey(matchers, text) {
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].regex.test(text)) return matchers[i].key;
  }
  return null;
}

async function collectFrom(browser, origin, pageName, surface) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(origin + "/" + pageName, {
      waitUntil: "networkidle2",
      timeout: 45000
    });
    const isLegal = LEGAL_PAGES.indexOf(pageName) !== -1;
    const opts = { excludedSelectors: EXCLUDED_SELECTORS, legalBody: isLegal };
    const before = await page.evaluate(inPageCollect, opts);
    if (!surface) return { before, after: [] };
    await surface.run(page);
    const after = await page.evaluate(inPageCollect, opts);
    return { before, after };
  } finally {
    await page.close().catch(() => {});
  }
}

function readJsonIfPresent(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

(async () => {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx !== -1 ? args[jsonIdx + 1] : null;
  const sync = args.indexOf("--sync") !== -1;

  /* --record-basis stamps the digest of each English value into
     assets/data/i18n-translation-basis.json. Run it only after actually
     translating the affected keys into all five locales: the digest is the
     claim "these five translations were authored against THIS English", and
     the build gate fails when the English drifts away from it. It needs no
     browser, so it stays runnable in a browserless environment. */
  if (args.indexOf("--record-basis") !== -1) {
    const enDoc = readJsonIfPresent("assets/data/locales/en.json");
    if (!enDoc || !enDoc.phrases) {
      console.error("assets/data/locales/en.json is missing or has no phrases.");
      process.exit(1);
    }
    const out = { basis: {} };
    Object.keys(enDoc.phrases)
      .sort()
      .forEach((k) => {
        out.basis[k] = digest(enDoc.phrases[k]);
      });
    out.note =
      "sha1-10 of each English value at the moment all five translations were " +
      "authored against it. scripts/build-site-data.js fails the build when an " +
      "English value drifts away from its recorded digest, so a copy edit can " +
      "never leave five stale translations behind reporting green. Regenerate " +
      "with: node scripts/extract-i18n-strings.js --record-basis";
    fs.writeFileSync(
      path.join(ROOT, "assets/data/i18n-translation-basis.json"),
      JSON.stringify({ note: out.note, basis: out.basis }, null, 2) + "\n"
    );
    console.log("Recorded translation basis for " + Object.keys(out.basis).length + " key(s).");
    return;
  }

  const pages = collectPages();
  if (!pages.length) {
    console.error("No built HTML pages found -- run `npm run build-data` first.");
    process.exit(1);
  }

  /* Normally this serves the working tree itself on 8087 (falling back to an
     ephemeral port when that one is busy, which it is whenever reveal-check.js
     is running). YL_I18N_BASE_URL -- set by `scripts/i18n-new-strings.js
     --base <url>` -- points the browser at a copy someone else is already
     serving instead, which is what an unattended run wants when it has no
     port to spare. The page list still comes from the local tree, so the
     served copy has to be the same build. */
  const baseUrl = (process.env.YL_I18N_BASE_URL || "").trim().replace(/\/+$/, "");
  const server = baseUrl ? null : await createStaticServer(PORT);
  const origin = baseUrl || "http://127.0.0.1:" + server.address().port;
  if (baseUrl) console.log("Rendering the site served at " + origin);
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const registry = new Map();
  function record(entry, page, surfaceName) {
    const k = keyOf(entry);
    let rec = registry.get(k);
    if (!rec) {
      rec = {
        text: entry.text,
        kind: entry.kind,
        count: 0,
        pages: new Set(),
        surfaces: new Set(),
        selectors: new Set()
      };
      registry.set(k, rec);
    }
    rec.count++;
    rec.pages.add(page);
    if (surfaceName) rec.surfaces.add(surfaceName);
    if (entry.selector) rec.selectors.add(entry.selector);
  }

  const runtimeOnly = new Map();

  try {
    console.log("Extracting static strings from " + pages.length + " built pages...");
    for (const pageName of pages) {
      const { before } = await collectFrom(browser, origin, pageName, null);
      before.forEach((e) => record(e, pageName, null));
    }

    console.log("Extracting runtime strings from " + SURFACES.length + " dynamic surfaces...");
    for (const surface of SURFACES) {
      if (pages.indexOf(surface.page) === -1) {
        console.log("  ! " + surface.name + ": page " + surface.page + " not built -- skipped");
        continue;
      }
      const { before, after } = await collectFrom(browser, origin, surface.page, surface);
      const baseline = new Set(before.map(keyOf));
      let newCount = 0;
      after.forEach((e) => {
        record(e, surface.page, surface.name);
        const k = keyOf(e);
        if (baseline.has(k)) return;
        newCount++;
        let rec = runtimeOnly.get(k);
        if (!rec) {
          rec = { text: e.text, kind: e.kind, surfaces: new Set() };
          runtimeOnly.set(k, rec);
        }
        rec.surfaces.add(surface.name);
      });
      console.log(
        "  " + surface.name + " (" + surface.page + "): " + newCount + " runtime-only string(s)"
      );
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  }

  const all = Array.from(registry.values()).sort((a, b) => b.count - a.count);
  const runtime = Array.from(runtimeOnly.values()).sort((a, b) => a.text.localeCompare(b.text));
  const reachable = new Set(all.map((r) => r.text));

  console.log("\nDistinct reachable strings: " + all.length);
  console.log("Runtime-only strings (present in no .html file): " + runtime.length);

  if (jsonOut) {
    const payload = {
      generatedFrom: pages.length + " built pages, " + SURFACES.length + " dynamic surfaces",
      strings: all.map((r) => ({
        text: r.text,
        kind: r.kind,
        count: r.count,
        pages: Array.from(r.pages).sort(),
        surfaces: Array.from(r.surfaces).sort(),
        selectors: Array.from(r.selectors).sort().slice(0, 4)
      })),
      runtimeOnly: runtime.map((r) => ({
        text: r.text,
        kind: r.kind,
        surfaces: Array.from(r.surfaces).sort()
      }))
    };
    fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + "\n");
    console.log("Wrote " + jsonOut);
  }

  if (!sync) return;

  /* ------------------------------------------------------------------
     Incremental diff against the shipped dictionary. Three lists, no
     writes: this must be safe to run at any time, and a translation must
     never disappear because a tool ran. Deciding what to do about each
     list is a human call.
     ------------------------------------------------------------------ */
  const en = readJsonIfPresent("assets/data/locales/en.json");
  if (!en || !en.phrases) {
    console.error("\n--sync: assets/data/locales/en.json is missing or has no phrases.");
    process.exit(1);
  }
  const basis = readJsonIfPresent("assets/data/i18n-translation-basis.json") || { basis: {} };
  const manifest = readJsonIfPresent("assets/data/i18n-runtime-strings.json") || { strings: [] };
  const manifestTexts = new Set(manifest.strings.map((s) => s.text));

  const enValues = new Set(Object.values(en.phrases));
  const locales = {};
  LOCALE_CODES.slice(1).forEach((code) => {
    const loc = readJsonIfPresent("assets/data/locales/" + code + ".json");
    locales[code] = loc && loc.phrases ? loc.phrases : {};
  });

  const dead = [];
  Object.keys(en.phrases).forEach((key) => {
    const value = en.phrases[key];
    if (!reachable.has(value) && !manifestTexts.has(value))
      dead.push(key + " = " + JSON.stringify(value));
  });

  const stale = [];
  Object.keys(en.phrases).forEach((key) => {
    const recorded = basis.basis ? basis.basis[key] : undefined;
    if (recorded === undefined) {
      stale.push(key + " (never recorded -- translations unverified)");
    } else if (recorded !== digest(en.phrases[key])) {
      stale.push(
        key + " (English changed since translation: " + JSON.stringify(en.phrases[key]) + ")"
      );
    }
  });

  const missing = [];
  LOCALE_CODES.slice(1).forEach((code) => {
    Object.keys(en.phrases).forEach((key) => {
      const v = locales[code][key];
      if (typeof v !== "string" || !v.trim()) missing.push(code + "." + key);
    });
  });

  const templateMatchers = buildTemplateMatchers(en.phrases);
  const uncoveredAll = all.filter((r) => !enValues.has(r.text));
  const templateCovered = [];
  const uncovered = uncoveredAll.filter((r) => {
    const key = matchingTemplateKey(templateMatchers, r.text);
    if (key) {
      templateCovered.push({ text: r.text, key: key });
      return false;
    }
    return true;
  });

  console.log("\n================ --sync ================");
  console.log("Dictionary keys: " + Object.keys(en.phrases).length);
  console.log("\n[1] Reachable strings NOT in the dictionary: " + uncovered.length);
  uncovered.slice(0, 120).forEach((r) => {
    console.log("    (" + r.kind + " x" + r.count + ") " + JSON.stringify(r.text).slice(0, 160));
  });
  if (uncovered.length > 120) console.log("    ...and " + (uncovered.length - 120) + " more");
  if (templateCovered.length) {
    console.log(
      "\n    (" +
        templateCovered.length +
        " more matched a tpl.* template and are already covered -- not listed above; " +
        "e.g. " +
        templateCovered
          .slice(0, 3)
          .map((r) => JSON.stringify(r.text).slice(0, 60) + " -> " + r.key)
          .join(", ") +
        ")"
    );
  }

  console.log("\n[2] Dictionary entries the site no longer shows: " + dead.length);
  dead.forEach((d) => console.log("    " + d));

  console.log("\n[3] Keys whose English changed since translation: " + stale.length);
  stale.forEach((d) => console.log("    " + d));

  console.log("\n[4] Missing/empty locale entries: " + missing.length);
  missing.slice(0, 60).forEach((d) => console.log("    " + d));
  if (missing.length > 60) console.log("    ...and " + (missing.length - 60) + " more");

  console.log(
    "\nNothing was written. Translate list [1] and [3], prune list [2], then\n" +
      "re-record the basis with: node scripts/extract-i18n-strings.js --record-basis"
  );
})().catch((err) => {
  console.error("extract-i18n-strings crashed:", err);
  process.exit(1);
});
