/**
 * @fileoverview Unit test suite for client-side self-hosted localization engine (assets/js/translator.js).
 * Validates DOM initialization, ARIA attributes, keyboard navigation, dictionary integrity,
 * in-place translation, brand glossary protection, MutationObserver updates, event dispatch,
 * persistence, URL params, fallback handling, and zero network/cookie invariants.
 *
 * Run: node scripts/translator.test.js
 */
const assert = require("assert");

// ==========================================================
// Mock DOM Infrastructure
// ==========================================================

class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
  }
}

class MockTextNode extends MockNode {
  constructor(text) {
    super(3);
    this.nodeValue = text !== undefined ? String(text) : "";
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(val) {
    this.nodeValue = String(val);
  }
}

class MockElement extends MockNode {
  constructor(tagName) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this._attributes = new Map();
    this.style = {};
    this.childNodes = [];
    this._listeners = new Map();
    this.type = "button";
    this.placeholder = "";

    const self = this;
    this.classList = {
      add(...names) {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        names.forEach((n) => classes.add(n));
        self.className = Array.from(classes).join(" ");
      },
      remove(...names) {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        names.forEach((n) => classes.delete(n));
        self.className = Array.from(classes).join(" ");
      },
      contains(name) {
        const classes = self.className ? self.className.split(/\s+/).filter(Boolean) : [];
        return classes.includes(name);
      },
      toggle(name) {
        if (this.contains(name)) {
          this.remove(name);
          return false;
        }
        this.add(name);
        return true;
      }
    };
  }

  get _children() {
    return this.childNodes;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!newChild) return newChild;
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    newChild.parentNode = this;
    if (!refChild) {
      this.childNodes.push(newChild);
      return newChild;
    }
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) {
      this.childNodes.push(newChild);
    } else {
      this.childNodes.splice(idx, 0, newChild);
    }
    return newChild;
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
      return this.placeholder || this._attributes.get("placeholder") || null;
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  setAttribute(name, val) {
    const strVal = String(val);
    if (name === "id") this.id = strVal;
    else if (name === "class") this.className = strVal;
    else if (name === "placeholder") {
      this.placeholder = strVal;
      this._attributes.set(name, strVal);
    } else {
      this._attributes.set(name, strVal);
    }
  }

  removeAttribute(name) {
    if (name === "id") this.id = "";
    else if (name === "class") this.className = "";
    else if (name === "placeholder") {
      this.placeholder = "";
      this._attributes.delete(name);
    } else {
      this._attributes.delete(name);
    }
  }

  hasAttribute(name) {
    if (name === "id") return Boolean(this.id);
    if (name === "class") return Boolean(this.className);
    if (name === "placeholder")
      return Boolean(this.placeholder || this._attributes.has("placeholder"));
    return this._attributes.has(name);
  }

  contains(other) {
    if (!other) return false;
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  get textContent() {
    let text = "";
    for (const child of this.childNodes) {
      if (child.nodeType === 3) {
        text += child.nodeValue;
      } else if (child.nodeType === 1) {
        text += child.textContent;
      }
    }
    return text;
  }

  set textContent(val) {
    this.childNodes.forEach((c) => {
      c.parentNode = null;
    });
    this.childNodes = [];
    if (val !== null && val !== undefined) {
      const tn = new MockTextNode(String(val));
      tn.parentNode = this;
      this.childNodes.push(tn);
    }
  }

  get innerHTML() {
    let html = "";
    for (const child of this.childNodes) {
      if (child.nodeType === 3) {
        html += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        let attrs = "";
        if (child.id) attrs += ` id="${child.id}"`;
        if (child.className) attrs += ` class="${child.className}"`;
        child._attributes.forEach((v, k) => {
          attrs += ` ${k}="${v}"`;
        });
        html += `<${tag}${attrs}>${child.innerHTML}</${tag}>`;
      }
    }
    return html;
  }

  set innerHTML(htmlStr) {
    this.childNodes.forEach((c) => {
      c.parentNode = null;
    });
    this.childNodes = [];
    if (!htmlStr) return;

    if (htmlStr.includes('<span class="lang-current-code">')) {
      const m = htmlStr.match(/<span class="lang-current-code">([\s\S]*?)<\/span>/);
      const span = new MockElement("span");
      span.className = "lang-current-code";
      span.textContent = m ? m[1] : "";
      this.appendChild(span);
    } else if (!htmlStr.includes("<")) {
      this.textContent = htmlStr;
    } else {
      const tn = new MockTextNode(htmlStr);
      this.appendChild(tn);
    }
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    if (!this._listeners.has(type)) return;
    const list = this._listeners.get(type);
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(event) {
    const list = this._listeners.get(event.type) || [];
    event.target = this;
    for (const h of list) {
      h.call(this, event);
    }
    return !event.defaultPrevented;
  }

  focus() {
    if (global.document) {
      global.document.activeElement = this;
    }
  }

  querySelector(selector) {
    const results = this.querySelectorAll(selector);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Minimal closest(): supports the "[attr]" presence form, which is the only
   * shape translator.js uses ("[lang]"). Present so the language-marking
   * cleanup pass runs here instead of being silently skipped by its
   * `typeof el.closest !== "function"` guard -- an untested branch in a mock
   * that quietly lacks the method is exactly the "absent subject is a pass"
   * failure TEST_INFRA.md warns about.
   */
  closest(selector) {
    const m = /^\[([a-zA-Z-]+)\]$/.exec(selector);
    if (!m) throw new Error("MockElement.closest only implements [attr]: " + selector);
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (curr.hasAttribute(m[1])) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    function matchNode(node) {
      if (node.nodeType !== 1) return;

      if (selector.startsWith("#") && node.id === selector.slice(1)) {
        matches.push(node);
      } else if (
        selector.startsWith(".") &&
        node.classList &&
        node.classList.contains(selector.slice(1))
      ) {
        matches.push(node);
      } else if (selector.includes("[data-lang=")) {
        const m = selector.match(/\[data-lang="([^"]+)"\]/);
        if (m && node.getAttribute("data-lang") === m[1]) {
          matches.push(node);
        }
      } else if (selector === ".lang-option.active") {
        if (
          node.classList &&
          node.classList.contains("lang-option") &&
          node.classList.contains("active")
        ) {
          matches.push(node);
        }
      } else if (selector === ".lang-option") {
        if (node.classList && node.classList.contains("lang-option")) {
          matches.push(node);
        }
      } else if (selector.toUpperCase() === node.tagName) {
        matches.push(node);
      }

      for (const child of node.childNodes) {
        matchNode(child);
      }
    }

    for (const child of this.childNodes) {
      matchNode(child);
    }
    return matches;
  }
}

class MockLocalStorage {
  constructor() {
    this._store = {};
  }
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null;
  }
  setItem(k, v) {
    this._store[k] = String(v);
  }
  removeItem(k) {
    delete this._store[k];
  }
  clear() {
    this._store = {};
  }
}

let activeObservers = [];
class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.options = null;
    activeObservers.push(this);
  }
  observe(target, options) {
    this.target = target;
    this.options = options;
  }
  disconnect() {
    const idx = activeObservers.indexOf(this);
    if (idx !== -1) activeObservers.splice(idx, 1);
  }
  trigger(mutations) {
    this.callback(mutations, this);
  }
}

class MockCustomEvent {
  constructor(type, initDict = {}) {
    this.type = type;
    this.detail = initDict.detail || null;
    this.bubbles = Boolean(initDict.bubbles);
    this.cancelable = Boolean(initDict.cancelable);
    this.defaultPrevented = false;
    this.target = null;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

// Load dictionaries
const localesData = require("../assets/js/locales-data.js");
const LOCALES = localesData.LOCALES || localesData.YL_LOCALES;
const BRAND_GLOSSARY = localesData.BRAND_GLOSSARY || localesData.YL_BRAND_GLOSSARY;

// Setup full browser-like globals
let mockDocument;
let mockWindow;
let mockLocalStorage;

function setupEnvironment(initialUrlSearch = "") {
  activeObservers = [];
  mockLocalStorage = new MockLocalStorage();

  const docElement = new MockElement("html");
  docElement.setAttribute("lang", "en");
  docElement.setAttribute("dir", "ltr");

  const body = new MockElement("body");
  docElement.appendChild(body);

  const docListeners = new Map();

  mockDocument = {
    nodeType: 9,
    documentElement: docElement,
    body: body,
    activeElement: null,
    title: "Y'allternative Living | Handmade Self-Care",
    _cookie: "",
    get cookie() {
      return this._cookie;
    },
    set cookie(val) {
      this._cookie = val;
    },
    createElement: (tag) => new MockElement(tag),
    createTextNode: (text) => new MockTextNode(text),
    getElementById: (id) => {
      function findId(node) {
        if (!node) return null;
        if (node.nodeType === 1 && node.id === id) return node;
        if (node.childNodes) {
          for (const c of node.childNodes) {
            const found = findId(c);
            if (found) return found;
          }
        }
        return null;
      }
      return findId(docElement);
    },
    querySelector: (selector) => docElement.querySelector(selector),
    querySelectorAll: (selector) => docElement.querySelectorAll(selector),
    addEventListener: (type, handler) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      if (!docListeners.has(type)) return;
      const list = docListeners.get(type);
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent: (event) => {
      const list = docListeners.get(event.type) || [];
      event.target = mockDocument;
      for (const h of list) {
        h.call(mockDocument, event);
      }
      return !event.defaultPrevented;
    },
    createEvent: () => ({
      initCustomEvent: (type, bubbles, cancelable, detail) => {
        return new MockCustomEvent(type, { bubbles, cancelable, detail });
      }
    }),
    createTreeWalker: (rootEl, whatToShow, filter) => {
      const nodes = [];
      function collect(node) {
        if (!node) return;
        if (node !== rootEl) {
          if (filter && typeof filter.acceptNode === "function") {
            const decision = filter.acceptNode(node);
            if (decision === 2) return; // FILTER_REJECT
            if (decision === 1) nodes.push(node); // FILTER_ACCEPT
          } else {
            nodes.push(node);
          }
        }
        if (node.childNodes) {
          for (const child of node.childNodes) {
            collect(child);
          }
        }
      }
      collect(rootEl);
      let idx = -1;
      return {
        nextNode: () => {
          idx++;
          return idx < nodes.length ? nodes[idx] : null;
        }
      };
    }
  };

  mockWindow = {
    document: mockDocument,
    location: {
      hostname: "yallternativeliving.com",
      search: initialUrlSearch
    },
    localStorage: mockLocalStorage,
    CustomEvent: MockCustomEvent,
    MutationObserver: MockMutationObserver,
    YL_LOCALES: LOCALES,
    YL_BRAND_GLOSSARY: BRAND_GLOSSARY,
    plausibleEvents: [],
    plausible: function (eventName, options) {
      mockWindow.plausibleEvents.push({ eventName, options });
    }
  };

  global.document = mockDocument;
  global.window = mockWindow;
  global.localStorage = mockLocalStorage;
  global.MutationObserver = MockMutationObserver;
  global.CustomEvent = MockCustomEvent;
  global.YL_LOCALES = LOCALES;
  global.YL_BRAND_GLOSSARY = BRAND_GLOSSARY;
  global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  global.NodeFilter = {
    SHOW_ALL: 0xffffffff,
    SHOW_ELEMENT: 0x1,
    SHOW_TEXT: 0x4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3
  };
}

// Initialize environment
setupEnvironment();
const translator = require("../assets/js/translator.js");

// ==========================================================
// Test Runner
// ==========================================================

async function runAllSuites() {
  console.log("==================================================");
  console.log("Running translator.js Unit Test Suites (10/10)");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  async function suite(name, testFn) {
    setupEnvironment();
    translator._resetInternalState();
    try {
      await testFn();
      console.log(`  ✓ Suite: ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ Suite: ${name}`);
      console.error(`    Error: ${e.message}`);
      if (e.stack) {
        console.error(
          e.stack
            .split("\n")
            .slice(1, 4)
            .map((l) => "   " + l)
            .join("\n")
        );
      }
      failed++;
    }
  }

  // ----------------------------------------------------
  // Suite 1: init_and_ui
  // ----------------------------------------------------
  await suite("1. init_and_ui: DOM initialization, injection & ARIA contract", async () => {
    const navCta = new MockElement("div");
    navCta.className = "nav-cta";
    mockDocument.body.appendChild(navCta);

    const themeToggle = new MockElement("button");
    themeToggle.id = "themeToggle";
    navCta.appendChild(themeToggle);

    translator.initUI();

    const wrap = mockDocument.getElementById("langSelectorWrap");
    assert.ok(wrap, "#langSelectorWrap should be injected into the DOM");
    assert.strictEqual(
      wrap.className,
      "lang-selector-wrap notranslate",
      "Wrap must have notranslate class"
    );
    assert.strictEqual(wrap.parentNode, navCta, "Wrap must be a child of .nav-cta");

    const toggleBtn = wrap.querySelector(".lang-toggle");
    assert.ok(toggleBtn, ".lang-toggle button must exist");
    /* The accessible name carries the CURRENT language. A bare "Select
       language" overrode the visible "EN" badge, leaving a screen-reader user
       unable to tell which language was active. */
    assert.strictEqual(
      toggleBtn.getAttribute("aria-label"),
      "Select language, current language English"
    );
    assert.strictEqual(toggleBtn.getAttribute("aria-expanded"), "false");
    assert.strictEqual(toggleBtn.getAttribute("aria-haspopup"), "listbox");
    /* aria-haspopup says a popup exists; aria-controls says which one. */
    assert.strictEqual(toggleBtn.getAttribute("aria-controls"), "langDropdown");
    assert.strictEqual(toggleBtn.type, "button");

    const dropdown = wrap.querySelector(".lang-dropdown");
    assert.ok(dropdown, ".lang-dropdown must exist");
    assert.strictEqual(dropdown.id, "langDropdown");
    assert.strictEqual(dropdown.getAttribute("role"), "listbox");
    assert.strictEqual(dropdown.getAttribute("aria-label"), "Select language");

    const options = dropdown.querySelectorAll(".lang-option");
    assert.strictEqual(options.length, 6, "Must contain exactly 6 language option buttons");

    const expectedCodes = ["en", "es", "de", "fr", "ja", "zh"];
    options.forEach((opt, idx) => {
      const code = expectedCodes[idx];
      assert.strictEqual(opt.getAttribute("role"), "option");
      assert.strictEqual(opt.getAttribute("data-lang"), code);
      if (code === "en") {
        assert.strictEqual(opt.getAttribute("aria-selected"), "true");
        assert.ok(opt.classList.contains("active"), "English option should be active initially");
      } else {
        assert.strictEqual(opt.getAttribute("aria-selected"), "false");
      }
    });

    const indicator = toggleBtn.querySelector(".lang-current-code");
    assert.ok(indicator, ".lang-current-code indicator exists");
    assert.strictEqual(indicator.textContent, "EN");
  });

  // ----------------------------------------------------
  // Suite 2: keyboard_navigation
  // ----------------------------------------------------
  await suite("2. keyboard_navigation: ArrowDown, ArrowUp, Enter, Space, Escape, Tab", async () => {
    const navCta = new MockElement("div");
    navCta.className = "nav-cta";
    mockDocument.body.appendChild(navCta);
    translator.initUI();

    const wrap = mockDocument.getElementById("langSelectorWrap");
    const toggleBtn = wrap.querySelector(".lang-toggle");
    const dropdown = wrap.querySelector(".lang-dropdown");
    const options = dropdown.querySelectorAll(".lang-option");

    // Test ArrowDown opens dropdown and focuses active option
    const downEvt = { key: "ArrowDown", preventDefault: () => {}, defaultPrevented: false };
    toggleBtn.dispatchEvent({ type: "keydown", ...downEvt });
    assert.ok(dropdown.classList.contains("open"), "ArrowDown on toggle opens dropdown");
    assert.strictEqual(toggleBtn.getAttribute("aria-expanded"), "true");
    assert.strictEqual(
      mockDocument.activeElement,
      options[0],
      "First active option is focused on open"
    );

    // Test ArrowDown inside dropdown advances focus
    options[0].focus();
    dropdown.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault: () => {} });
    assert.strictEqual(
      mockDocument.activeElement,
      options[1],
      "ArrowDown moves focus to second option (es)"
    );

    // Test ArrowUp moves focus back
    dropdown.dispatchEvent({ type: "keydown", key: "ArrowUp", preventDefault: () => {} });
    assert.strictEqual(
      mockDocument.activeElement,
      options[0],
      "ArrowUp moves focus back to first option (en)"
    );

    // Test End key focuses last option
    dropdown.dispatchEvent({ type: "keydown", key: "End", preventDefault: () => {} });
    assert.strictEqual(
      mockDocument.activeElement,
      options[5],
      "End key moves focus to last option (zh)"
    );

    // Test Home key focuses first option
    dropdown.dispatchEvent({ type: "keydown", key: "Home", preventDefault: () => {} });
    assert.strictEqual(
      mockDocument.activeElement,
      options[0],
      "Home key moves focus to first option (en)"
    );

    // Test Escape closes dropdown and returns focus to toggle
    dropdown.dispatchEvent({ type: "keydown", key: "Escape", preventDefault: () => {} });
    assert.strictEqual(dropdown.classList.contains("open"), false, "Escape closes dropdown");
    assert.strictEqual(toggleBtn.getAttribute("aria-expanded"), "false");
    assert.strictEqual(
      mockDocument.activeElement,
      toggleBtn,
      "Escape returns focus to toggle button"
    );

    // Test Space key on toggle opens dropdown
    toggleBtn.dispatchEvent({ type: "keydown", key: " ", preventDefault: () => {} });
    assert.ok(dropdown.classList.contains("open"), "Space key opens dropdown");

    // Test Tab key closes dropdown
    dropdown.dispatchEvent({ type: "keydown", key: "Tab", preventDefault: () => {} });
    assert.strictEqual(dropdown.classList.contains("open"), false, "Tab key closes dropdown");
  });

  // ----------------------------------------------------
  // Suite 3: dictionary_loading_and_integrity
  // ----------------------------------------------------
  await suite(
    "3. dictionary_loading_and_integrity: 6 languages, phrase count & structure",
    async () => {
      const locales = LOCALES;
      assert.ok(locales, "LOCALES data must be loaded");

      const expectedLangs = ["en", "es", "de", "fr", "ja", "zh"];
      expectedLangs.forEach((code) => {
        assert.ok(locales[code], `Locale ${code} must exist in dictionaries`);
        assert.strictEqual(locales[code].meta.code, code, `Locale ${code} meta.code matches`);
        assert.ok(locales[code].meta.name, `Locale ${code} has a display name`);
        assert.strictEqual(locales[code].meta.dir, "ltr", `Locale ${code} has ltr direction`);
        assert.ok(
          locales[code].phrases && typeof locales[code].phrases === "object",
          `Locale ${code} has phrases object`
        );
        const phraseCount = Object.keys(locales[code].phrases).length;
        assert.ok(
          phraseCount >= 40,
          `Locale ${code} must have at least 40 translated phrases (found ${phraseCount})`
        );
      });

      /* These used to name keys from the first, hand-imagined dictionary --
         nav.about, nav.cart ("Cart"), nav.search ("Search"),
         home.exploreShop ("Explore the Shop"). None of those strings existed
         anywhere in the shipped markup, so the suite was pinning the dictionary
         to a site that did not exist. The dictionary is now generated from the
         rendered pages (scripts/extract-i18n-strings.js) and gated against them
         (validateDictionaryCoverage in scripts/build-site-data.js), so these
         name keys whose English really is on the site. */
      const requiredKeys = [
        "nav.shop",
        "nav.faq",
        "cart.title",
        "search.popularTitle",
        "announcement.shipping",
        "home.heroTitle",
        "footer.joinTheList"
      ];

      expectedLangs.forEach((code) => {
        requiredKeys.forEach((key) => {
          assert.ok(locales[code].phrases[key], `Locale ${code} missing required key '${key}'`);
        });
      });
    }
  );

  // ----------------------------------------------------
  // Suite 4: in_place_dom_translation
  // ----------------------------------------------------
  await suite(
    "4. in_place_dom_translation: text nodes, data-i18n, placeholder, aria-label, title",
    async () => {
      // 1. Text node with leading/trailing whitespace
      const container = new MockElement("div");
      const p = new MockElement("p");
      const textNode = new MockTextNode("   Shop   ");
      p.appendChild(textNode);
      container.appendChild(p);

      // 2. data-i18n attribute
      const cartBtn = new MockElement("button");
      cartBtn.setAttribute("data-i18n", "cart.title");
      cartBtn.textContent = "Your Cart";
      container.appendChild(cartBtn);

      // 3. placeholder attribute
      const searchInput = new MockElement("input");
      searchInput.setAttribute("placeholder", "Search salves, soaks, events, FAQ… (Cmd+K)");
      searchInput.setAttribute("data-i18n-placeholder", "search.placeholder");
      container.appendChild(searchInput);

      // 4. aria-label attribute
      const menuBtn = new MockElement("button");
      menuBtn.setAttribute("aria-label", "Open menu");
      menuBtn.setAttribute("data-i18n-aria-label", "nav.openMenu");
      container.appendChild(menuBtn);

      // 5. title attribute
      const badgeSpan = new MockElement("span");
      badgeSpan.setAttribute(
        "title",
        "Free shipping on orders of $40 or more ✦ Small-batch, handmade with love in Landrum, SC"
      );
      badgeSpan.setAttribute("data-i18n-title", "announcement.shipping");
      container.appendChild(badgeSpan);

      /* 6. Language marking fixtures (see applyLangMarks in translator.js).
         a) fully translated element with an untranslated CHILD element -- the
            child would inherit the parent's lang without a counter-mark.
         b) one element holding both a translated and an untranslated text
            node -- no single lang attribute can describe that, so it must be
            left alone rather than described wrongly. */
      const leakHeading = new MockElement("h3");
      leakHeading.appendChild(new MockTextNode("Shop "));
      const leakChild = new MockElement("span");
      leakChild.appendChild(new MockTextNode("Zzznope untranslatable string"));
      leakHeading.appendChild(leakChild);
      container.appendChild(leakHeading);

      const mixedPara = new MockElement("p");
      mixedPara.appendChild(new MockTextNode("Contact"));
      mixedPara.appendChild(new MockTextNode("Zzznope untranslatable string"));
      container.appendChild(mixedPara);

      mockDocument.body.appendChild(container);
      mockDocument.title = "Self-Care For The Black Sheep & Bold Hearts";

      // Translate to Spanish (es)
      await translator.setLanguage("es");

      assert.strictEqual(
        textNode.nodeValue,
        "   Tienda   ",
        "Text node translated to Spanish with whitespace preserved"
      );
      assert.strictEqual(
        cartBtn.textContent,
        "Tu carrito",
        "data-i18n element translated to Spanish"
      );
      assert.strictEqual(
        searchInput.getAttribute("placeholder"),
        "Busca bálsamos, sales, eventos, preguntas… (Cmd+K)",
        "Placeholder translated to Spanish"
      );
      assert.strictEqual(
        menuBtn.getAttribute("aria-label"),
        "Abrir menú",
        "aria-label translated to Spanish"
      );
      assert.ok(
        badgeSpan.getAttribute("title").includes("Envío gratis"),
        "title attribute translated to Spanish"
      );
      assert.strictEqual(
        mockDocument.title,
        "Autocuidado para Black Sheep & Bold Hearts",
        "document.title translated to Spanish"
      );

      /* Language marking. The document element stays English (suite 8); the
         mark goes on the elements whose text was genuinely replaced, so a
         screen reader switches voice for those and only those. */
      assert.strictEqual(
        p.getAttribute("lang"),
        "es",
        "element whose text node was replaced is marked lang=es"
      );
      assert.strictEqual(
        cartBtn.getAttribute("lang"),
        "es",
        "data-i18n element whose text was replaced is marked lang=es"
      );
      assert.strictEqual(
        menuBtn.getAttribute("lang"),
        null,
        "element with only a translated aria-label is NOT marked (no text was replaced)"
      );
      assert.strictEqual(
        searchInput.getAttribute("lang"),
        null,
        "element with only a translated placeholder is NOT marked"
      );
      assert.strictEqual(
        container.getAttribute("lang"),
        null,
        "ancestor holding no text of its own is not marked"
      );
      assert.strictEqual(
        leakHeading.getAttribute("lang"),
        "es",
        "fully translated heading is marked lang=es"
      );
      assert.strictEqual(
        leakChild.getAttribute("lang"),
        "en",
        "untranslated child under a marked ancestor is counter-marked lang=en"
      );
      assert.strictEqual(
        mixedPara.getAttribute("lang"),
        null,
        "element with both translated and untranslated text of its own is left unmarked"
      );

      // Translate back to English (en) -> verify exact original restoration
      await translator.setLanguage("en");

      assert.strictEqual(textNode.nodeValue, "   Shop   ", "Text node cleanly restored to English");
      assert.strictEqual(
        cartBtn.textContent,
        "Your Cart",
        "data-i18n element cleanly restored to English"
      );
      assert.strictEqual(
        searchInput.getAttribute("placeholder"),
        "Search salves, soaks, events, FAQ… (Cmd+K)",
        "Placeholder restored to English"
      );
      assert.strictEqual(
        menuBtn.getAttribute("aria-label"),
        "Open menu",
        "aria-label restored to English"
      );
      assert.strictEqual(
        mockDocument.title,
        "Self-Care For The Black Sheep & Bold Hearts",
        "document.title restored to English"
      );

      /* Every mark this engine added comes off again -- including the
         counter-marks. A leftover lang attribute is a wrong announcement that
         outlives the translation that justified it. */
      assert.strictEqual(p.getAttribute("lang"), null, "lang mark removed on switch back");
      assert.strictEqual(
        cartBtn.getAttribute("lang"),
        null,
        "data-i18n lang mark removed on switch back"
      );
      assert.strictEqual(
        leakHeading.getAttribute("lang"),
        null,
        "heading lang mark removed on switch back"
      );
      assert.strictEqual(
        leakChild.getAttribute("lang"),
        null,
        "counter-mark removed on switch back"
      );
      assert.strictEqual(
        mockDocument.documentElement.getAttribute("lang"),
        "en",
        "document element was never touched in the first place"
      );
    }
  );

  // ----------------------------------------------------
  // Suite 5: brand_glossary_protection
  // ----------------------------------------------------
  await suite(
    "5. brand_glossary_protection: isProtectedTerm & skip classes for brand/botanical terms",
    async () => {
      assert.strictEqual(translator.isProtectedTerm("Y'allternative Living"), true);
      assert.strictEqual(translator.isProtectedTerm("Porch Sweep"), true);
      assert.strictEqual(translator.isProtectedTerm("Cathedral Dust"), true);
      assert.strictEqual(translator.isProtectedTerm("Bless Your Heart"), true);
      assert.strictEqual(translator.isProtectedTerm("Unbothered"), true);
      assert.strictEqual(translator.isProtectedTerm("Calendula officinalis"), true);
      assert.strictEqual(translator.isProtectedTerm("Arnica montana"), true);
      assert.strictEqual(translator.isProtectedTerm("Boswellia carterii"), true);
      assert.strictEqual(translator.isProtectedTerm("Lavandula angustifolia"), true);
      assert.strictEqual(translator.isProtectedTerm("Magnesium chloride"), true);
      assert.strictEqual(translator.isProtectedTerm("Shop"), false);
      assert.strictEqual(translator.isProtectedTerm("Contact"), false);

      const container = new MockElement("div");

      const brandHeader = new MockElement("h1");
      brandHeader.textContent = "Y'allternative Living";
      container.appendChild(brandHeader);

      const productTitle = new MockElement("h2");
      productTitle.textContent = "Porch Sweep Clearing Mist";
      container.appendChild(productTitle);

      const inciParagraph = new MockElement("p");
      inciParagraph.textContent = "Calendula officinalis";
      container.appendChild(inciParagraph);

      const normalParagraph = new MockElement("p");
      normalParagraph.textContent = "Shop";
      container.appendChild(normalParagraph);

      const brandSpan = new MockElement("span");
      brandSpan.className = "brand";
      brandSpan.textContent = "Shop";
      container.appendChild(brandSpan);

      mockDocument.body.appendChild(container);

      await translator.setLanguage("es");

      assert.strictEqual(
        brandHeader.textContent,
        "Y'allternative Living",
        "Brand name must never be translated"
      );
      assert.strictEqual(
        productTitle.textContent,
        "Porch Sweep Clearing Mist",
        "Product proprietary name must never be translated"
      );
      assert.strictEqual(
        inciParagraph.textContent,
        "Calendula officinalis",
        "INCI botanical name must never be translated"
      );
      assert.strictEqual(normalParagraph.textContent, "Tienda", "Normal phrase translated");
      assert.strictEqual(brandSpan.textContent, "Shop", ".brand class element skipped");
    }
  );

  // ----------------------------------------------------
  // Suite 6: dynamic_mutation_observation
  // ----------------------------------------------------
  await suite(
    "6. dynamic_mutation_observation: MutationObserver handles added DOM subtrees",
    async () => {
      mockDocument.body.childNodes = [];
      translator.init();

      await translator.setLanguage("es");

      assert.ok(activeObservers.length >= 1, "MutationObserver must be active");
      const observer = activeObservers[0];

      // Simulate adding dynamic cart drawer item to the DOM
      const dynamicCard = new MockElement("div");
      dynamicCard.className = "cart-drawer-item";
      const titleP = new MockElement("p");
      const textNode = new MockTextNode("Add to Cart");
      titleP.appendChild(textNode);
      dynamicCard.appendChild(titleP);

      mockDocument.body.appendChild(dynamicCard);

      // Trigger observer callback
      observer.trigger([
        {
          type: "childList",
          addedNodes: [dynamicCard]
        }
      ]);

      assert.strictEqual(
        textNode.nodeValue,
        "Añadir al carrito",
        "Dynamic added DOM subtree automatically translated in-place by MutationObserver"
      );
    }
  );

  // ----------------------------------------------------
  // Suite 7: custom_event_dispatch
  // ----------------------------------------------------
  await suite(
    "7. custom_event_dispatch: yl-language-changed event payload & Plausible call",
    async () => {
      const receivedEvents = [];
      mockDocument.addEventListener("yl-language-changed", (e) => {
        receivedEvents.push(e.detail);
      });

      await translator.setLanguage("fr");

      assert.strictEqual(receivedEvents.length, 1, "Dispatched yl-language-changed event");
      assert.deepStrictEqual(
        receivedEvents[0],
        { lang: "fr", prevLang: "en" },
        "Event payload carries target lang and prevLang"
      );

      await translator.setLanguage("de");
      assert.strictEqual(receivedEvents.length, 2);
      assert.deepStrictEqual(
        receivedEvents[1],
        { lang: "de", prevLang: "fr" },
        "Second switch carries correct prevLang"
      );

      // Verify analytics call
      assert.ok(mockWindow.plausibleEvents.length >= 2, "Plausible tracking function called");
      assert.strictEqual(mockWindow.plausibleEvents[0].eventName, "Language Changed");
      assert.strictEqual(mockWindow.plausibleEvents[0].options.props.language, "fr");
    }
  );

  // ----------------------------------------------------
  // Suite 8: persistence_and_url_params
  // ----------------------------------------------------
  await suite(
    "8. persistence_and_url_params: localStorage, URL query params, HTML lang/dir",
    async () => {
      // 1. Test localStorage persistence
      await translator.setLanguage("ja");
      assert.strictEqual(
        mockLocalStorage.getItem("yl-lang"),
        "ja",
        "Language saved to localStorage['yl-lang']"
      );
      /* NOT "ja". Dictionary coverage is 10-20% of a page, so declaring the
         whole document Japanese made a screen reader apply Japanese phonetics
         to the English 80-90% -- WCAG 2.1 SC 3.1.1 (Level A). The document
         stays English and only the elements whose text was actually replaced
         are marked; see suite 4. Raise coverage to ~100% and this pin is the
         thing to revisit. */
      assert.strictEqual(
        mockDocument.documentElement.getAttribute("lang"),
        "en",
        "html[lang] stays en while page coverage is partial"
      );
      assert.strictEqual(
        mockDocument.documentElement.getAttribute("dir"),
        "ltr",
        "html[dir] set to ltr"
      );

      // 2. Test getInitialLanguage reads localStorage
      assert.strictEqual(
        translator.getInitialLanguage(),
        "ja",
        "getInitialLanguage detects stored preference"
      );

      // 3. Test URL query param takes precedence
      mockWindow.location.search = "?lang=zh";
      assert.strictEqual(
        translator.getInitialLanguage(),
        "zh",
        "URL ?lang=zh takes precedence over localStorage"
      );
    }
  );

  // ----------------------------------------------------
  // Suite 9: fallback_handling
  // ----------------------------------------------------
  await suite(
    "9. fallback_handling: invalid language codes & missing dictionary keys",
    async () => {
      // Passing invalid code falls back to English
      const res = await translator.setLanguage("invalid_code_xyz");
      assert.strictEqual(res, "en", "Invalid language code returns 'en'");
      assert.strictEqual(translator.getCurrentLanguage(), "en", "currentLang set to 'en'");
      assert.strictEqual(mockDocument.documentElement.getAttribute("lang"), "en");

      // Missing key lookup fallback
      const fallbackText = translator.lookupPhrase("NonExistentPhrase12345", "es");
      assert.strictEqual(
        fallbackText,
        "NonExistentPhrase12345",
        "Missing phrase safely falls back to original string"
      );

      const fallbackKey = translator.lookupByKey("non.existent.key", "es");
      assert.strictEqual(fallbackKey, null, "lookupByKey for nonexistent key returns null");
    }
  );

  // ----------------------------------------------------
  // Suite 10: zero_network_and_zero_cookies
  // ----------------------------------------------------
  await suite(
    "10. zero_network_and_zero_cookies: 0 external requests & 0 googtrans cookies",
    async () => {
      // Assert cookie is 100% empty (no googtrans=/en/es, etc.)
      assert.strictEqual(mockDocument.cookie, "", "document.cookie must remain completely empty");

      // Assert no external script tags are ever injected into the DOM
      const scripts = mockDocument.body.querySelectorAll("script");
      const externalGoogleScript = scripts.find((s) =>
        (s.getAttribute("src") || "").includes("translate.google.com")
      );
      assert.strictEqual(
        externalGoogleScript,
        undefined,
        "Zero Google Translate script elements injected"
      );

      // Assert internal state has zero legacy Google properties
      const state = translator._getInternalState();
      assert.strictEqual(state.googleInitPromise, undefined, "No googleInitPromise in state");
      assert.strictEqual(state.isGoogleLoaded, undefined, "No isGoogleLoaded in state");
    }
  );

  console.log("==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllSuites();
