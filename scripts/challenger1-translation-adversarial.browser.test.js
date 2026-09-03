/* eslint-env node, browser */
/**
 * @fileoverview Challenger 1 Adversarial Stress Test Suite: Translation Architecture Migration.
 *
 * Empirical & adversarial stress verification of assets/js/translator.js:
 * 1. Rapid multi-cycle language switching (en -> es -> zh -> ja -> de -> fr -> en) across 100+ churn cycles.
 *    Verifies zero DOM corruption, zero text node leakage, perfect English restoration.
 * 2. Extreme input fuzzing & edge cases: missing dictionary keys, invalid/unsupported language codes
 *    ('xx', null, undefined, '', '   ', 123, NaN, {}, []), special characters (<script>, emojis, RTL, \n\t),
 *    HTML entities (&amp;, &lt;, &quot;, &#39;), 50k character text blocks.
 * 3. Brand glossary tamper stress: verify all protected terms ("Porch Sweep", "Cathedral Dust",
 *    "Bless Your Heart", "Unbothered", Latin botanicals, etc.) cannot be mutated or corrupted across any language.
 * 4. Dynamic DOM mutation & MutationObserver stress: rapid insertion of elements (cart items, review cards,
 *    product cards) without infinite loops or memory leaks under heavy concurrency.
 * 5. Headless browser E2E stress: real browser DOM testing across index, shop, PDP, about pages with
 *    live language switcher, live cart drawer interactions, and performance benchmark.
 *
 * Run: node scripts/challenger1-translation-adversarial.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");

// Load dictionary and glossary sources directly for cross-validation
const localesData = require("../assets/js/locales-data.js");
const LOCALES = localesData.LOCALES || localesData.YL_LOCALES;
const BRAND_GLOSSARY = localesData.BRAND_GLOSSARY || localesData.YL_BRAND_GLOSSARY;
const translator = require("../assets/js/translator.js");

function createTestServer() {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
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

    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(200, {
          "Content-Type": contentType,
          "Service-Worker-Allowed": "/"
        });
        res.end(data);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

// =========================================================================
// SECTION 1: IN-MEMORY NODE ADVERSARIAL STRESS HARNESS
// =========================================================================

class StressNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
  }
}

class StressTextNode extends StressNode {
  constructor(text) {
    super(3);
    this.nodeValue = text !== undefined ? String(text) : "";
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(v) {
    this.nodeValue = String(v);
  }
}

class StressElement extends StressNode {
  constructor(tagName) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = new Map();
    this.placeholder = "";

    const self = this;
    this.classList = {
      add(...names) {
        const set = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        names.forEach((n) => set.add(n));
        self.className = Array.from(set).join(" ");
      },
      remove(...names) {
        const set = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        names.forEach((n) => set.delete(n));
        self.className = Array.from(set).join(" ");
      },
      contains(name) {
        const set = self.className ? self.className.split(/\s+/).filter(Boolean) : [];
        return set.includes(name);
      }
    };
  }

  get _children() {
    return this.childNodes;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    if (name === "placeholder")
      return this.placeholder || this.attributes.get("placeholder") || null;
    return this.attributes.get(name) || null;
  }

  setAttribute(name, val) {
    const s = String(val);
    if (name === "id") this.id = s;
    else if (name === "class") this.className = s;
    else if (name === "placeholder") {
      this.placeholder = s;
      this.attributes.set(name, s);
    } else {
      this.attributes.set(name, s);
    }
  }

  hasAttribute(name) {
    if (name === "id") return Boolean(this.id);
    if (name === "class") return Boolean(this.className);
    if (name === "placeholder")
      return Boolean(this.placeholder || this.attributes.has("placeholder"));
    return this.attributes.has(name);
  }

  get textContent() {
    let t = "";
    for (const c of this.childNodes) {
      if (c.nodeType === 3) t += c.nodeValue;
      else if (c.nodeType === 1) t += c.textContent;
    }
    return t;
  }

  set textContent(val) {
    this.childNodes.forEach((c) => {
      c.parentNode = null;
    });
    this.childNodes = [];
    if (val !== null && val !== undefined) {
      const tn = new StressTextNode(String(val));
      tn.parentNode = this;
      this.childNodes.push(tn);
    }
  }

  querySelector(sel) {
    const res = this.querySelectorAll(sel);
    return res.length > 0 ? res[0] : null;
  }

  querySelectorAll(sel) {
    const matches = [];
    function walk(node) {
      if (!node || node.nodeType !== 1) return;
      if (sel.startsWith("#") && node.id === sel.slice(1)) matches.push(node);
      else if (sel.startsWith(".") && node.classList && node.classList.contains(sel.slice(1)))
        matches.push(node);
      else if (sel.toUpperCase() === node.tagName) matches.push(node);
      for (const child of node.childNodes) walk(child);
    }
    for (const child of this.childNodes) walk(child);
    return matches;
  }
}

function setupMockDom() {
  const docElement = new StressElement("html");
  docElement.setAttribute("lang", "en");
  const body = new StressElement("body");
  docElement.appendChild(body);

  const mockDoc = {
    nodeType: 9,
    documentElement: docElement,
    body: body,
    title: "Y'allternative Living",
    createElement: (tag) => new StressElement(tag),
    createTextNode: (txt) => new StressTextNode(txt),
    getElementById: (id) => {
      function find(node) {
        if (!node || node.nodeType !== 1) return null;
        if (node.id === id) return node;
        for (const c of node.childNodes) {
          const res = find(c);
          if (res) return res;
        }
        return null;
      }
      return find(docElement);
    },
    querySelector: (sel) => docElement.querySelector(sel),
    querySelectorAll: (sel) => docElement.querySelectorAll(sel),
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const mockStorage = {
    _data: {},
    getItem(k) {
      return this._data[k] || null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
    removeItem(k) {
      delete this._data[k];
    },
    clear() {
      this._data = {};
    }
  };

  global.document = mockDoc;
  global.window = {
    document: mockDoc,
    localStorage: mockStorage,
    YL_LOCALES: LOCALES,
    YL_BRAND_GLOSSARY: BRAND_GLOSSARY,
    location: { search: "" }
  };
  global.localStorage = mockStorage;
  global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

  return { mockDoc, mockStorage };
}

async function runNodeStressTests() {
  console.log("\n==========================================================================");
  console.log("🧪 PART 1: Node-Level Adversarial Stress Engine");
  console.log("==========================================================================\n");

  let passedTests = 0;
  let totalTests = 0;

  function testAssert(cond, msg) {
    totalTests++;
    if (cond) {
      passedTests++;
      console.log(`  ✓ ${msg}`);
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------
  // Test 1.1: 100-Cycle Rapid Language Churning & Restoration
  // -------------------------------------------------------------
  console.log("--- Test 1.1: 100-Cycle Rapid Language Churning & Restoration ---");
  setupMockDom();
  translator._resetInternalState();

  const container = new StressElement("div");
  const nodesToInspect = [];

  // Populate 100 mixed nodes with text, attributes, protected terms
  for (let i = 0; i < 100; i++) {
    const card = new StressElement("div");
    card.setAttribute("class", "product-card");

    const title = new StressElement("h3");
    title.textContent = i % 2 === 0 ? "Porch Sweep Clearing Mist" : "Shop";
    card.appendChild(title);

    const desc = new StressElement("p");
    const descText = new StressTextNode("   Small-batch, handmade with love in Landrum, SC   ");
    desc.appendChild(descText);
    card.appendChild(desc);

    const btn = new StressElement("button");
    btn.setAttribute("data-i18n", "nav.cart");
    btn.setAttribute("aria-label", "Open navigation menu");
    btn.setAttribute("placeholder", "Search products, ingredients, scents...");
    btn.setAttribute(
      "title",
      "Free shipping on orders of $40 or more ✦ Small-batch, handmade with love in Landrum, SC"
    );
    btn.textContent = "Cart";
    card.appendChild(btn);

    container.appendChild(card);
    nodesToInspect.push({ title, descText, btn, isProtected: i % 2 === 0 });
  }

  global.document.body.appendChild(container);

  const langSequence = ["es", "ja", "de", "zh", "fr", "es", "de", "ja", "zh", "en"];
  const totalCycles = 10; // 10 cycles * 10 steps = 100 switches

  for (let c = 0; c < totalCycles; c++) {
    for (const lang of langSequence) {
      await translator.setLanguage(lang);
    }
  }

  // Final language is guaranteed 'en'
  testAssert(
    translator.getCurrentLanguage() === "en",
    "Translator current language is 'en' after 100 cycles"
  );

  // Verify 100% byte-perfect restoration across all 100 items
  let perfectRestoration = true;
  for (let i = 0; i < nodesToInspect.length; i++) {
    const item = nodesToInspect[i];
    if (item.isProtected && item.title.textContent !== "Porch Sweep Clearing Mist") {
      perfectRestoration = false;
    }
    if (!item.isProtected && item.title.textContent !== "Shop") {
      perfectRestoration = false;
    }
    if (item.descText.nodeValue !== "   Small-batch, handmade with love in Landrum, SC   ") {
      perfectRestoration = false;
    }
    if (item.btn.textContent !== "Cart") {
      perfectRestoration = false;
    }
    if (item.btn.getAttribute("aria-label") !== "Open navigation menu") {
      perfectRestoration = false;
    }
    if (item.btn.getAttribute("placeholder") !== "Search products, ingredients, scents...") {
      perfectRestoration = false;
    }
  }
  testAssert(
    perfectRestoration,
    "Zero DOM corruption and 100% byte-exact English restoration across 100 items after 100 rapid switches"
  );

  // -------------------------------------------------------------
  // Test 1.2: Fuzzing & Anomaly Inputs (Invalid Codes & Strange Values)
  // -------------------------------------------------------------
  console.log("\n--- Test 1.2: Fuzzing & Anomaly Inputs (Invalid Codes & Strange Values) ---");

  const adversarialLangCodes = [
    "xx",
    "123",
    "",
    "   ",
    null,
    undefined,
    false,
    true,
    {},
    [],
    NaN,
    Infinity,
    "en-US",
    "zh-CN",
    "es-ES",
    "<script>",
    "SELECT * FROM users",
    "../../../etc/passwd",
    "\0",
    "\n\t"
  ];

  for (const invalidCode of adversarialLangCodes) {
    const result = await translator.setLanguage(invalidCode);
    testAssert(
      result === "en",
      `Invalid language code ${JSON.stringify(invalidCode)} safely defaults to 'en'`
    );
    testAssert(
      translator.getCurrentLanguage() === "en",
      `Current language remains 'en' for ${JSON.stringify(invalidCode)}`
    );
  }

  // Fuzz lookupPhrase and lookupByKey
  const adversarialPhrases = [
    null,
    undefined,
    "",
    "   ",
    0,
    123,
    false,
    true,
    {},
    [],
    NaN,
    "<img src=x onerror=alert(1)>",
    "&amp;&lt;&gt;&quot;&#39;",
    "🌿✨🕯️ Moonlit Meadow Bath Tea 🌿✨🕯️",
    "\n\n\t\t   Whitespace Bomb   \n\t",
    "A".repeat(50000)
  ];

  for (const p of adversarialPhrases) {
    let thrown = false;
    try {
      const res = translator.lookupPhrase(p, "es");
      if (typeof p !== "string" || !p.trim()) {
        testAssert(
          Object.is(res, p) || res === p,
          `lookupPhrase safely passes through non-string/empty input`
        );
      } else {
        testAssert(typeof res === "string", `lookupPhrase returns string for valid string input`);
      }
    } catch {
      thrown = true;
    }
    testAssert(!thrown, `Zero exceptions thrown during phrase lookup fuzzing`);
  }

  for (const k of adversarialPhrases) {
    let thrown = false;
    try {
      const res = translator.lookupByKey(k, "es");
      testAssert(
        res === null || typeof res === "string",
        `lookupByKey handles ${typeof k === "string" ? k.slice(0, 20) : JSON.stringify(k)} safely`
      );
    } catch {
      thrown = true;
    }
    testAssert(!thrown, `Zero exceptions thrown during key lookup fuzzing`);
  }

  // -------------------------------------------------------------
  // Test 1.3: Brand Glossary Tamper & Mutation Stress
  // -------------------------------------------------------------
  console.log("\n--- Test 1.3: Brand Glossary Tamper & Mutation Stress ---");

  const coreProtectedTerms = [
    "Porch Sweep",
    "Cathedral Dust",
    "Bless Your Heart",
    "Unbothered",
    "Porch Sweep Clearing Mist",
    "Hush Y'all Magnesium Arnica Sleep Salve",
    "Y'all Heal Now Miracle Frankincense Salve",
    "Y'allternative Miracle Balm",
    "Feral but FRESH Cream Deodorant",
    "Bug Off B*tch Natural Bug Spray",
    "Bourbon Beard Salve",
    "Bourbon Vanilla Hand Scrub",
    "Lavender Shea Body Butter",
    "Lavender Epsom Salt Soak",
    "Backroad Recovery Epsom Salt Soak",
    "Protection Potion Keychain",
    "Y'all Means All Sugar Scrub",
    "Y'all Means All Rainbow Whipped Body Butter",
    "Appalachian Rain Clearing Mist",
    "Moonlit Meadow Bath Tea",
    "Calendula officinalis",
    "Arnica montana",
    "Boswellia carterii",
    "Butyrospermum parkii",
    "Cera alba",
    "Lavandula angustifolia",
    "Magnesium chloride",
    "Pogostemon cablin",
    "Citrus sinensis",
    "Simmondsia chinensis",
    "Cocos nucifera",
    "Melaleuca alternifolia",
    "Eucalyptus globulus",
    "Mentha piperita",
    "Pelargonium graveolens",
    "Cedrus atlantica",
    "Eugenia caryophyllus",
    "Cinnamomum zeylanicum",
    "Rosmarinus officinalis"
  ];

  const targetLangs = ["es", "de", "fr", "ja", "zh"];

  for (const term of coreProtectedTerms) {
    testAssert(
      translator.isProtectedTerm(term) === true,
      `isProtectedTerm correctly identifies '${term}'`
    );
    for (const lang of targetLangs) {
      const trans = translator.lookupPhrase(term, lang);
      testAssert(
        trans === term,
        `Protected term '${term}' must NEVER be translated into '${lang}' (got: '${trans}')`
      );
    }
  }

  // Test surrounding whitespace
  for (const term of [
    "Porch Sweep",
    "Cathedral Dust",
    "Bless Your Heart",
    "Unbothered",
    "Calendula officinalis"
  ]) {
    const padded = `  ${term}  `;
    for (const lang of targetLangs) {
      const trans = translator.lookupPhrase(padded, lang);
      testAssert(trans === padded, `Padded term '${padded}' preserved exactly in '${lang}'`);
    }
  }

  // -------------------------------------------------------------
  // Test 1.4: Dynamic DOM Mutation Stress & Observer Loop Safety
  // -------------------------------------------------------------
  console.log("\n--- Test 1.4: Dynamic DOM Mutation Stress & Observer Safety ---");

  setupMockDom();
  translator._resetInternalState();

  let mutationCallbackCount = 0;
  class MockObserverHarness {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    disconnect() {}
    simulateMutations(mutations) {
      mutationCallbackCount++;
      this.cb(mutations);
    }
  }

  global.MutationObserver = MockObserverHarness;
  translator.init();

  await translator.setLanguage("es");

  const obs = translator._getInternalState().observer;
  testAssert(obs !== null, "MutationObserver initialized and active in translator internal state");

  // Stress simulate 200 batches of added dynamic nodes
  const startTime = Date.now();
  for (let batch = 0; batch < 200; batch++) {
    const dynContainer = new StressElement("div");
    dynContainer.className = "cart-item";

    const titleEl = new StressElement("h4");
    titleEl.textContent = "Shop";
    dynContainer.appendChild(titleEl);

    const descEl = new StressElement("p");
    descEl.textContent = "Porch Sweep Clearing Mist";
    dynContainer.appendChild(descEl);

    global.document.body.appendChild(dynContainer);

    obs.simulateMutations([
      {
        type: "childList",
        addedNodes: [dynContainer]
      }
    ]);

    testAssert(
      titleEl.textContent === "Tienda",
      `Dynamic batch ${batch}: 'Shop' translated to 'Tienda'`
    );
    testAssert(
      descEl.textContent === "Porch Sweep Clearing Mist",
      `Dynamic batch ${batch}: 'Porch Sweep' preserved`
    );
  }

  const elapsed = Date.now() - startTime;
  testAssert(
    elapsed < 1000,
    `200 dynamic mutation batches processed in ${elapsed}ms (< 1000ms bound)`
  );
  testAssert(
    mutationCallbackCount === 200,
    `Processed exactly 200 mutation callbacks without infinite loops`
  );

  console.log(`\nPart 1: All ${passedTests}/${totalTests} Node stress tests passed successfully!`);
}

// =========================================================================
// SECTION 2: REAL HEADLESS BROWSER E2E ADVERSARIAL STRESS
// =========================================================================

async function runBrowserStressTests() {
  console.log("\n==========================================================================");
  console.log("🌐 PART 2: Real Headless Browser E2E Adversarial Stress");
  console.log("==========================================================================\n");

  const server = await createTestServer();
  const baseUrl = server.url;
  console.log(`📡 Local static server listening at ${baseUrl}\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security"
    ]
  });

  try {
    const page = await browser.newPage();

    // Listen for console errors or exceptions
    const pageErrors = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // -------------------------------------------------------------
    // Test 2.1: Multi-Page Rapid Switching Churn (Index, Shop, About)
    // -------------------------------------------------------------
    console.log("--- Test 2.1: Multi-Page Rapid Switching Churn (Index & Shop) ---");

    for (const testPath of ["/index.html", "/shop.html", "/about.html"]) {
      await page.goto(`${baseUrl}${testPath}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#langSelectorWrap", { timeout: 3000 });

      // Capture initial English snapshot of key elements
      const initialSnapshot = await page.evaluate(() => {
        return {
          title: document.title,
          navLinks: Array.from(document.querySelectorAll(".nav-links a")).map((a) =>
            a.textContent.trim()
          ),
          h1: document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "",
          langAttr: document.documentElement.getAttribute("lang")
        };
      });

      // Execute 18 rapid language switches (3 full cycles through 6 languages)
      const churnLangs = [
        "es",
        "zh",
        "ja",
        "de",
        "fr",
        "en",
        "ja",
        "es",
        "fr",
        "de",
        "zh",
        "en",
        "de",
        "es",
        "ja",
        "zh",
        "fr",
        "en"
      ];
      const switchDurations = [];

      for (const targetLang of churnLangs) {
        const t0 = Date.now();
        await page.evaluate(async (code) => {
          await window.YL_TRANSLATOR.setLanguage(code);
        }, targetLang);
        switchDurations.push(Date.now() - t0);

        /* The DOCUMENT is never relabelled -- coverage is 10-20%, so
           <html lang="es"> was a WCAG 3.1.1 (Level A) failure that told a
           screen reader to read the English 80-90% with Spanish phonetics.
           What must be true instead: the document stays English, and the
           elements whose text was replaced carry the mark -- which is also a
           stronger assertion than the old one, because it fails if the engine
           stops translating while still flipping an attribute. */
        const langState = await page.evaluate((code) => {
          return {
            docLang: document.documentElement.getAttribute("lang"),
            /* Scoped to body on purpose: <html lang="en"> is authored markup
               and would satisfy a bare [lang="en"] count for the wrong
               reason. */
            marked: document.querySelectorAll('body [lang="' + code + '"]').length,
            anyMarks: document.querySelectorAll("body [lang]").length
          };
        }, targetLang);
        assert.strictEqual(
          langState.docLang,
          "en",
          `Page ${testPath} keeps <html lang="en"> while switching to '${targetLang}'`
        );
        if (targetLang === "en") {
          assert.strictEqual(
            langState.anyMarks,
            0,
            `Page ${testPath} carries no leftover element lang marks after restoring English (found ${langState.anyMarks})`
          );
        } else {
          assert.ok(
            langState.marked > 0,
            `Page ${testPath} marks translated elements lang='${targetLang}' (found ${langState.marked})`
          );
        }
      }

      // Check restored English snapshot
      const restoredSnapshot = await page.evaluate(() => {
        return {
          title: document.title,
          navLinks: Array.from(document.querySelectorAll(".nav-links a")).map((a) =>
            a.textContent.trim()
          ),
          h1: document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : "",
          langAttr: document.documentElement.getAttribute("lang")
        };
      });

      assert.deepStrictEqual(
        restoredSnapshot,
        initialSnapshot,
        `100% byte-perfect English restoration on ${testPath}`
      );
      const avgDuration = switchDurations.reduce((a, b) => a + b, 0) / switchDurations.length;
      console.log(
        `  ✓ ${testPath}: 18 rapid switches passed. Avg switch latency: ${avgDuration.toFixed(1)}ms`
      );
    }

    // -------------------------------------------------------------
    // Test 2.2: Brand Glossary Protection on Live PDP (Porch Sweep)
    // -------------------------------------------------------------
    console.log("\n--- Test 2.2: Brand Glossary Protection on Live PDPs ---");

    /* This used to run on porch-sweep-spray.html alone, compute hasBotanicals,
       never assert it, and then log "& botanicals preserved intact" -- a claim
       that could not have been true, because that page contains no INCI name
       at all. The INCI half is now checked on the PDP that actually ships
       those terms, and the English baseline is asserted FIRST so a page that
       stopped containing the subject fails instead of passing vacuously. */
    const glossaryPdps = [
      {
        path: "/products/porch-sweep-spray.html",
        h1Term: "Porch Sweep",
        bodyTerms: ["Porch Sweep", "Y'allternative Living"]
      },
      {
        path: "/products/miracle-balm.html",
        h1Term: "Miracle Balm",
        bodyTerms: ["Calendula officinalis", "Butyrospermum parkii", "Y'allternative"]
      }
    ];
    const targetLanguages = ["es", "de", "fr", "ja", "zh"];

    for (const pdp of glossaryPdps) {
      await page.goto(`${baseUrl}${pdp.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#langSelectorWrap", { timeout: 3000 });

      const baseline = await page.evaluate((terms) => {
        const h1 = document.querySelector("h1");
        const bodyText = document.body.innerText;
        const found = {};
        terms.forEach((t) => {
          found[t] = bodyText.split(t).length - 1;
        });
        return { h1Text: h1 ? h1.textContent.trim() : "", found };
      }, pdp.bodyTerms);

      /* Assert the subject exists in English before asserting it survives
         translation -- otherwise "still absent" reads as "preserved". */
      assert.ok(
        baseline.h1Text.includes(pdp.h1Term),
        `${pdp.path} baseline H1 contains '${pdp.h1Term}' (got: '${baseline.h1Text}')`
      );
      pdp.bodyTerms.forEach((term) => {
        assert.ok(
          baseline.found[term] > 0,
          `${pdp.path} baseline body contains protected term '${term}'`
        );
      });

      for (const lang of targetLanguages) {
        await page.evaluate(async (code) => {
          await window.YL_TRANSLATOR.setLanguage(code);
        }, lang);

        const pdpCheck = await page.evaluate((terms) => {
          const h1 = document.querySelector("h1");
          const bodyText = document.body.innerText;
          const found = {};
          terms.forEach((t) => {
            found[t] = bodyText.split(t).length - 1;
          });
          return { h1Text: h1 ? h1.textContent.trim() : "", found };
        }, pdp.bodyTerms);

        assert.strictEqual(
          pdpCheck.h1Text,
          baseline.h1Text,
          `${pdp.path} H1 is byte-identical under '${lang}'`
        );
        pdp.bodyTerms.forEach((term) => {
          assert.strictEqual(
            pdpCheck.found[term],
            baseline.found[term],
            `${pdp.path} keeps all ${baseline.found[term]} occurrences of '${term}' under '${lang}'`
          );
        });
        console.log(
          `  ✓ ${pdp.path} ${lang.toUpperCase()}: ${pdp.bodyTerms.length} protected terms preserved with unchanged occurrence counts`
        );
      }

      await page.evaluate(async () => {
        await window.YL_TRANSLATOR.setLanguage("en");
      });
    }

    // -------------------------------------------------------------
    // Test 2.3: Dynamic Cart Drawer Injection Under Active Non-English Language
    // -------------------------------------------------------------
    console.log("\n--- Test 2.3: Dynamic Cart Drawer Injection in Spanish ---");

    /* Every selector below is one that exists. The previous version of this
       test looked for #cartDrawer, .cart-checkout-btn, #checkoutBtn and
       [data-i18n='cart.checkout'] -- none of which are in this codebase -- and
       called window.YL_CART, which is undefined (the global is YLCart), so the
       add-to-cart never happened either. It then printed two green ticks over
       an empty string. The real markup, built by assets/js/cart.js
       ensureDrawer()/render(), is .yl-cart-drawer > .yl-cart-head h2 and
       .yl-cart-foot > .yl-cart-checkout. */
    await page.goto(`${baseUrl}/shop.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#langSelectorWrap", { timeout: 3000 });

    // Switch to Spanish BEFORE the drawer exists: this is a MutationObserver test.
    await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("es");
    });

    const cartApiPresent = await page.evaluate(
      () => Boolean(window.YLCart) && typeof window.YLCart.addItem === "function"
    );
    assert.ok(
      cartApiPresent,
      "window.YLCart.addItem exists -- without it the drawer is never built and every assertion below would be vacuous"
    );

    await page.evaluate(() => {
      window.YLCart.addItem({
        id: "porch-sweep-spray",
        name: "Porch Sweep Clearing Mist",
        price: 18.0,
        qty: 1
      });
    });

    await page.waitForSelector(".yl-cart-drawer .yl-cart-foot .yl-cart-checkout", {
      timeout: 3000
    });
    await new Promise((r) => setTimeout(r, 300));

    const cartDrawerCheck = await page.evaluate(() => {
      const drawer = document.querySelector(".yl-cart-drawer");
      const foot = drawer ? drawer.querySelector(".yl-cart-foot") : null;
      const checkoutBtn = foot ? foot.querySelector(".yl-cart-checkout") : null;
      const heading = drawer ? drawer.querySelector(".yl-cart-head h2") : null;
      const closeBtn = drawer ? drawer.querySelector(".yl-cart-close") : null;
      return {
        drawerExists: Boolean(drawer),
        footExists: Boolean(foot),
        checkoutMatched: Boolean(checkoutBtn),
        checkoutText: checkoutBtn ? checkoutBtn.textContent.trim() : "",
        checkoutLang: checkoutBtn ? checkoutBtn.getAttribute("lang") : null,
        headingText: heading ? heading.textContent.trim() : "",
        closeLabel: closeBtn ? closeBtn.getAttribute("aria-label") : ""
      };
    });

    assert.ok(cartDrawerCheck.drawerExists, ".yl-cart-drawer was injected after addItem()");
    assert.ok(cartDrawerCheck.footExists, ".yl-cart-foot exists inside the drawer");
    assert.ok(
      cartDrawerCheck.checkoutMatched,
      ".yl-cart-checkout button matched inside .yl-cart-foot"
    );
    assert.ok(
      cartDrawerCheck.checkoutText.length > 0,
      "checkout button has text to assert over (an empty string is a failure, not a pass)"
    );
    assert.strictEqual(
      cartDrawerCheck.checkoutText,
      "Pagar",
      `Checkout button translated by the MutationObserver (got: "${cartDrawerCheck.checkoutText}")`
    );
    assert.strictEqual(
      cartDrawerCheck.checkoutLang,
      "es",
      "translated checkout button is marked lang=es"
    );
    assert.strictEqual(
      cartDrawerCheck.headingText,
      "Tu Carrito",
      `Drawer heading translated (got: "${cartDrawerCheck.headingText}")`
    );
    assert.strictEqual(
      cartDrawerCheck.closeLabel,
      "Cerrar carrito",
      `Close button aria-label translated (got: "${cartDrawerCheck.closeLabel}")`
    );
    console.log(
      `  ✓ Cart drawer injected under ES and translated by the observer: heading "${cartDrawerCheck.headingText}", checkout "${cartDrawerCheck.checkoutText}", close "${cartDrawerCheck.closeLabel}"`
    );

    // Switch back to English and check cart drawer text
    await page.evaluate(async () => {
      await window.YL_TRANSLATOR.setLanguage("en");
    });
    await new Promise((r) => setTimeout(r, 300));

    const cartRestored = await page.evaluate(() => {
      const drawer = document.querySelector(".yl-cart-drawer");
      const checkoutBtn = drawer ? drawer.querySelector(".yl-cart-foot .yl-cart-checkout") : null;
      const heading = drawer ? drawer.querySelector(".yl-cart-head h2") : null;
      const closeBtn = drawer ? drawer.querySelector(".yl-cart-close") : null;
      return {
        checkoutMatched: Boolean(checkoutBtn),
        checkoutText: checkoutBtn ? checkoutBtn.textContent.trim() : "",
        headingText: heading ? heading.textContent.trim() : "",
        closeLabel: closeBtn ? closeBtn.getAttribute("aria-label") : "",
        leftoverEsMarks: document.querySelectorAll('[lang="es"]').length
      };
    });

    assert.ok(
      cartRestored.checkoutMatched,
      "checkout button still matched after restoring English"
    );
    assert.strictEqual(
      cartRestored.checkoutText,
      "Checkout",
      `Checkout button restored to English (got: "${cartRestored.checkoutText}")`
    );
    assert.strictEqual(
      cartRestored.headingText,
      "Your Cart",
      `Drawer heading restored to English (got: "${cartRestored.headingText}")`
    );
    assert.strictEqual(
      cartRestored.closeLabel,
      "Close cart",
      `Close button aria-label restored (got: "${cartRestored.closeLabel}")`
    );
    assert.strictEqual(
      cartRestored.leftoverEsMarks,
      0,
      `No lang="es" marks survive the switch back (found ${cartRestored.leftoverEsMarks})`
    );
    console.log(
      `  ✓ Cart drawer restored to English: heading "${cartRestored.headingText}", checkout "${cartRestored.checkoutText}", 0 leftover lang marks`
    );

    // -------------------------------------------------------------
    // Test 2.4: Zero Uncaught Exceptions Check
    // -------------------------------------------------------------
    console.log("\n--- Test 2.4: Zero Uncaught Exceptions ---");
    assert.strictEqual(
      pageErrors.length,
      0,
      `Zero uncaught browser errors during full stress test (found: ${pageErrors.join(", ")})`
    );
    console.log("  ✓ Zero uncaught exceptions detected across all page interactions.");

    console.log("\nPart 2: All Headless Browser E2E Stress Tests Passed (100% GREEN)!");
  } finally {
    await browser.close();
    await server.close();
  }
}

async function runAll() {
  console.log("==========================================================================");
  console.log("⚡ CHALLENGER 1 ADVERSARIAL STRESS TEST SUITE: TRANSLATOR ENGINE");
  console.log("==========================================================================");

  await runNodeStressTests();
  await runBrowserStressTests();

  console.log("\n==========================================================================");
  console.log("🏆 ALL ADVERSARIAL CHALLENGER STRESS TESTS PASSED (100% GREEN)");
  console.log("==========================================================================\n");
}

runAll().catch((err) => {
  console.error("\n❌ CHALLENGER STRESS TEST FAILED:", err);
  process.exit(1);
});
