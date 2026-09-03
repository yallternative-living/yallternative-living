/**
 * @fileoverview Empirical Adversarial Challenger Test Suite for Milestone 2.
 * Comprehensive stress testing for:
 * 1. Apothecary Quiz scoring engine (`initApothecaryQuiz`):
 *    - Specific vibe/need/intent matrix combinations
 *    - All 48 combinatorial permutations of (vibe x need x intent)
 *    - Out-of-Stock / Coming-Soon penalty (-20)
 *    - Fallback behavior when window.YL_CONTENT.quiz is null, undefined, or empty
 *    - Edge cases: custom questions, arbitrary weights, tie-breakers, bundle resolution, loyalty points
 * 2. Announcement bar (`announcementBar`):
 *    - announcement.enabled: false (no render)
 *    - announcement.text: "" fallback to freeShippingThreshold
 *    - announcement.text: "" and threshold missing/0 (no render)
 *    - announcement.link provided vs empty
 *    - Accent themes (whiskey, moss, lavender, rust, default)
 *    - Integration with #yl-countdown-ticker vs standalone #announcement-bar
 * 3. Cart drawer seasonal notice (`render` in cart.js):
 *    - enabled: true, showInCart: true (with and without link)
 *    - enabled: false or showInCart: false (hidden)
 *    - text empty / whitespace (hidden)
 *    - null / undefined seasonalNotice config (graceful fallback)
 *    - XSS / HTML sanitization on notice text and link
 * 4. Modal Ritual Defaults Fallback (`renderModalRitualHtml`)
 *
 * Run: node scripts/challenger-m2-frontend-stress.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const contentJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
);
// The quiz lives in its own file; the build merges it back as YL_CONTENT.quiz.
contentJson.quiz = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/quiz.json"), "utf8")
);
const productsJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
);

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label, details) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${label}`);
  } else {
    failed++;
    const msg = `  ✗ FAIL: ${label}${details ? ` -> ${details}` : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Mock DOM Infrastructure
// ---------------------------------------------------------------------------
const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  let _hidden = false;
  let elementId = "";
  let elementValue = "";
  let isChecked = false;

  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    get id() {
      return elementId || attrs.get("id") || "";
    },
    set id(val) {
      elementId = String(val);
      attrs.set("id", String(val));
    },
    get value() {
      return elementValue || attrs.get("value") || "";
    },
    set value(val) {
      elementValue = String(val);
      attrs.set("value", String(val));
    },
    get checked() {
      return isChecked || attrs.get("checked") === "true" || attrs.has("checked");
    },
    set checked(val) {
      isChecked = !!val;
      if (val) attrs.set("checked", "true");
      else attrs.delete("checked");
    },
    get hidden() {
      return _hidden || attrs.has("hidden");
    },
    set hidden(val) {
      _hidden = !!val;
      if (val) attrs.set("hidden", "");
      else attrs.delete("hidden");
    },
    setAttribute: (name, val) => {
      attrs.set(name, String(val));
      if (name === "id") elementId = String(val);
      if (name === "value") elementValue = String(val);
      if (name === "checked") isChecked = val === "true" || val === true || val === "";
      if (name === "hidden") _hidden = true;
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute: (name) => {
      attrs.delete(name);
      if (name === "id") elementId = "";
      if (name === "hidden") _hidden = false;
      if (name === "checked") isChecked = false;
    },
    hasAttribute: (name) => attrs.has(name),
    dataset: {},
    style: {},
    classList: {
      _list: new Set(),
      add: function (...names) {
        names.forEach((n) => this._list.add(n));
      },
      remove: function (...names) {
        names.forEach((n) => this._list.delete(n));
      },
      contains: function (name) {
        return this._list.has(name);
      },
      toggle: function (name) {
        if (this._list.has(name)) this._list.delete(name);
        else this._list.add(name);
      }
    },
    get className() {
      return Array.from(this.classList._list).join(" ");
    },
    set className(val) {
      this.classList._list = new Set(String(val).split(/\s+/).filter(Boolean));
    },
    get href() {
      return attrs.get("href") || "";
    },
    set href(val) {
      attrs.set("href", String(val));
    },
    _innerHTML: "",
    get innerHTML() {
      if (children.length > 0) {
        return children
          .map((c) => {
            if (c.tagName === "A") {
              const href = c.getAttribute("href") || c.href || "";
              const cls = c.className ? ` class="${c.className}"` : "";
              return `<a href="${href}"${cls}>${c.textContent || c.innerHTML}</a>`;
            }
            if (c.tagName === "SPAN" || c.tagName === "DIV") {
              const cls = c.className ? ` class="${c.className}"` : "";
              return `<${c.tagName.toLowerCase()}${cls}>${c.textContent || c.innerHTML}</${c.tagName.toLowerCase()}>`;
            }
            return c.innerHTML || c.textContent || "";
          })
          .join("");
      }
      return this._innerHTML;
    },
    set innerHTML(val) {
      this._innerHTML = val;
    },
    _textContent: "",
    get textContent() {
      if (children.length > 0) {
        return children.map((c) => c.textContent).join("");
      }
      return this._textContent;
    },
    set textContent(val) {
      this._textContent = String(val);
      this._innerHTML = String(val);
    },
    parentNode: null,
    children: children,
    appendChild: function (child) {
      child.parentNode = this;
      children.push(child);
      return child;
    },
    insertBefore: function (newChild, refChild) {
      newChild.parentNode = this;
      const idx = children.indexOf(refChild);
      if (idx !== -1) {
        children.splice(idx, 0, newChild);
      } else {
        children.unshift(newChild);
      }
      return newChild;
    },
    removeChild: function (child) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    remove: function () {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    },
    _listeners: {},
    addEventListener: function (type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter((f) => f !== fn);
    },
    dispatchEvent: function (evt) {
      const fns = this._listeners[evt.type] || [];
      fns.forEach((fn) => fn(evt));
      if (this.parentNode && evt.bubbles) {
        this.parentNode.dispatchEvent(evt);
      }
    },
    querySelector: function (sel) {
      const results = this.querySelectorAll(sel);
      if (results.length > 0) return results[0];
      if (this.tagName === "DIALOG" || this.tagName === "ASIDE" || this.id === "yl-cart-drawer") {
        const sub = createMockElement("div");
        if (sel.startsWith("#")) sub.id = sel.substring(1);
        if (sel.startsWith(".")) sub.classList.add(sel.substring(1));
        this.appendChild(sub);
        return sub;
      }
      return null;
    },
    querySelectorAll: function (sel) {
      const found = [];
      function match(node) {
        if (!node) return;
        let isMatch = false;

        if (sel.startsWith("#")) {
          const targetId = sel.substring(1);
          if (node.id === targetId) isMatch = true;
        } else if (sel.startsWith(".")) {
          const targetClass = sel.substring(1);
          if (node.classList && node.classList.contains(targetClass)) isMatch = true;
        } else if (sel.includes('[name="') && sel.includes('"]:checked')) {
          const matchName = sel.match(/\[name="([^"]+)"\]/);
          if (matchName) {
            const nameAttr = node.getAttribute("name");
            if (nameAttr === matchName[1] && node.checked) isMatch = true;
          }
        } else if (sel.includes('[name="')) {
          const matchName = sel.match(/\[name="([^"]+)"\]/);
          if (matchName) {
            const nameAttr = node.getAttribute("name");
            if (nameAttr === matchName[1]) isMatch = true;
          }
        } else if (sel === "button" && node.tagName === "BUTTON") {
          isMatch = true;
        } else if (sel === "a" && node.tagName === "A") {
          isMatch = true;
        }

        if (isMatch) found.push(node);

        if (node.children && node.children.length > 0) {
          for (let i = 0; i < node.children.length; i++) {
            match(node.children[i]);
          }
        }
      }

      for (let i = 0; i < this.children.length; i++) {
        match(this.children[i]);
      }
      return found;
    },
    closest: function (sel) {
      let curr = this;
      while (curr) {
        if (sel.startsWith("#") && curr.id === sel.substring(1)) return curr;
        if (sel.startsWith(".") && curr.classList && curr.classList.contains(sel.substring(1)))
          return curr;
        if (curr.tagName && curr.tagName.toLowerCase() === sel.toLowerCase()) return curr;
        curr = curr.parentNode;
      }
      return null;
    },
    focus: function () {}
  };
  return el;
}

const mockDocument = {
  documentElement: createMockElement("html"),
  body: createMockElement("body"),
  createElement: (tag) => {
    const el = createMockElement(tag);
    if (tag.toLowerCase() === "dialog") {
      el.showModal = () => el.setAttribute("open", "true");
      el.close = () => el.removeAttribute("open");
    }
    return el;
  },
  getElementById: function (id) {
    function findId(node) {
      if (!node) return null;
      if (node.id === id) return node;
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          const f = findId(node.children[i]);
          if (f) return f;
        }
      }
      return null;
    }
    return findId(mockDocument.body) || findId(mockDocument.documentElement);
  },
  querySelector: function (sel) {
    return mockDocument.body.querySelector(sel) || mockDocument.documentElement.querySelector(sel);
  },
  querySelectorAll: function (sel) {
    return mockDocument.body.querySelectorAll(sel);
  },
  addEventListener: () => {},
  readyState: "complete"
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  location: {
    href: "https://yallternative-living.com/shop.html",
    pathname: "/shop.html",
    search: ""
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  YL_CONTENT: JSON.parse(JSON.stringify(contentJson)),
  YL_PRODUCTS: JSON.parse(JSON.stringify(productsJson))
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const main = require("../assets/js/main.js");
require("../assets/js/cart.js");
const YLCart = mockWindow.YLCart;

console.log("================================================================================");
console.log("EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 2 CLIENT MERCHANDISING");
console.log("================================================================================\n");

/* ========================================================================== */
/* CATEGORY 1: APOTHECARY QUIZ SCORING ENGINE STRESS MATRIX                   */
/* ========================================================================== */
console.log("--- Category 1: Apothecary Quiz Scoring Engine ---");

function resetBody() {
  const drawer = mockDocument.getElementById("yl-cart-drawer");
  while (mockDocument.body.children.length > 0) {
    mockDocument.body.children.pop();
  }
  if (drawer) {
    mockDocument.body.appendChild(drawer);
  }
}

function setupQuizDOM(questions, selectedValues = {}) {
  resetBody();

  const section = createMockElement("section");
  section.id = "apothecary-quiz-section";

  const modal = createMockElement("dialog");
  modal.id = "apothecary-quiz-modal";
  modal.showModal = () => modal.setAttribute("open", "true");
  modal.close = () => modal.removeAttribute("open");

  const openBtn = createMockElement("button");
  openBtn.id = "open-apothecary-quiz-btn";

  const closeBtn = createMockElement("button");
  closeBtn.id = "close-apothecary-quiz-modal";

  const resetBtn = createMockElement("button");
  resetBtn.id = "start-apothecary-quiz-btn";

  const resultsContainer = createMockElement("div");
  resultsContainer.id = "quiz-results-container";

  const submitBtn = createMockElement("button");
  submitBtn.id = "quiz-submit-btn";

  section.appendChild(modal);
  section.appendChild(openBtn);
  section.appendChild(closeBtn);
  section.appendChild(resetBtn);
  section.appendChild(resultsContainer);
  section.appendChild(submitBtn);

  // Build question steps with radio inputs
  if (Array.isArray(questions)) {
    questions.forEach((q, stepIdx) => {
      const stepDiv = createMockElement("div");
      stepDiv.id = "quiz-step-" + (q.step || stepIdx + 1);
      stepDiv.classList.add("quiz-step");

      const param = q.name || "quiz-" + q.id;
      const selectedVal = selectedValues[param] || selectedValues[q.id];

      (q.options || []).forEach((opt) => {
        const radio = createMockElement("input");
        radio.setAttribute("type", "radio");
        radio.setAttribute("name", param);
        radio.value = opt.value;
        if (selectedVal && opt.value === selectedVal) {
          radio.checked = true;
        } else if (!selectedVal && opt === q.options[0]) {
          radio.checked = true;
        }
        stepDiv.appendChild(radio);
      });

      section.appendChild(stepDiv);
    });
  } else {
    // Fallback static radio names (quiz-vibe, quiz-need, quiz-intent)
    ["quiz-vibe", "quiz-need", "quiz-intent"].forEach((name, stepIdx) => {
      const stepDiv = createMockElement("div");
      stepDiv.id = "quiz-step-" + (stepIdx + 1);
      stepDiv.classList.add("quiz-step");

      const radio = createMockElement("input");
      radio.setAttribute("type", "radio");
      radio.setAttribute("name", name);
      radio.value = selectedValues[name] || "";
      radio.checked = true;
      stepDiv.appendChild(radio);

      section.appendChild(stepDiv);
    });
  }

  mockDocument.body.appendChild(section);
  return { section, resultsContainer, submitBtn, modal, openBtn, closeBtn, resetBtn };
}

// 1.1 Test Scenario 1: Gothic calm / hydration / treat myself
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const dom = setupQuizDOM(contentJson.quiz.questions, {
    "quiz-vibe": "gothic-calm",
    "quiz-need": "hydration",
    "quiz-intent": "treat-myself"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(dom.resultsContainer.style.display === "block", "Scenario 1: Results container displayed");
  assert(
    /* "Match", not "Prescription": the quiz used to hand the shopper a
       "prescription" on the same page whose footer says "not medicine", and
       the build already bans that word as a search synonym for exactly that
       reason (audit C, finding M1). */
    dom.resultsContainer.innerHTML.includes("Your Apothecary Match"),
    "Scenario 1: Renders quiz result header"
  );
  // Shimmer Body Oil scores 10 (treat-myself rec + matchFeatured + hydration category body)
  assert(
    dom.resultsContainer.innerHTML.includes("Shimmer Body Oil") ||
      dom.resultsContainer.innerHTML.includes("Sweet Dreams Sleep Salve"),
    "Scenario 1: Recommends top scored product (Shimmer Body Oil / Sleep Salve)"
  );
  assert(
    dom.resultsContainer.innerHTML.includes(
      "choice of gothic calm vibes, hydration focus, and treat myself intent"
    ),
    "Scenario 1: Generates contextual rationale with human-readable choices"
  );
  assert(
    dom.resultsContainer.innerHTML.includes("yl-add-item"),
    "Scenario 1: Renders add-to-cart button"
  );
})();

// 1.2 Test Scenario 2: Ritual rest / muscle soak / gift bestie
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const dom = setupQuizDOM(contentJson.quiz.questions, {
    "quiz-vibe": "ritual-rest",
    "quiz-need": "muscle-soak",
    "quiz-intent": "gift-bestie"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(dom.resultsContainer.style.display === "block", "Scenario 2: Results container displayed");
  assert(
    dom.resultsContainer.innerHTML.includes("Protection Potion Keychain") ||
      dom.resultsContainer.innerHTML.includes("Digital Gift Card") ||
      dom.resultsContainer.innerHTML.includes("Backwoods Burnout Recovery Kit") ||
      dom.resultsContainer.innerHTML.includes("Botanical Bath Tea"),
    "Scenario 2: Recommends gift/bundle product for Ritual rest + muscle soak + gift bestie"
  );
  assert(
    dom.resultsContainer.innerHTML.includes(
      "choice of ritual rest vibes, muscle soak focus, and gift bestie intent"
    ),
    "Scenario 2: Correct rationale formulation"
  );
})();

// 1.3 Test Scenario 3: Hexing energy / apparel / ritual bath
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const dom = setupQuizDOM(contentJson.quiz.questions, {
    "quiz-vibe": "hexing-energy",
    "quiz-need": "apparel-lifestyle",
    "quiz-intent": "ritual-bath"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(dom.resultsContainer.style.display === "block", "Scenario 3: Results container displayed");
  assert(
    dom.resultsContainer.innerHTML.includes("Protection Potion Keychain") ||
      dom.resultsContainer.innerHTML.includes("Shimmer Body Oil") ||
      dom.resultsContainer.innerHTML.includes("Lavender Epsom Salt Soak") ||
      dom.resultsContainer.innerHTML.includes("Porch Sweep Cleansing Spray"),
    "Scenario 3: Matches hexing energy + apparel-lifestyle + ritual bath options"
  );
  assert(
    dom.resultsContainer.innerHTML.includes(
      "choice of hexing energy vibes, apparel lifestyle focus, and ritual bath intent"
    ),
    "Scenario 3: Correct rationale formulation"
  );
})();

// 1.4 Test Scenario 4: Daily soothe / herbal salve / treat myself
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const dom = setupQuizDOM(contentJson.quiz.questions, {
    "quiz-vibe": "daily-soothe",
    "quiz-need": "herbal-salve",
    "quiz-intent": "treat-myself"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(dom.resultsContainer.style.display === "block", "Scenario 4: Results container displayed");
  assert(
    dom.resultsContainer.innerHTML.includes("Frankincense") ||
      dom.resultsContainer.innerHTML.includes("Miracle Balm") ||
      dom.resultsContainer.innerHTML.includes("Bug Off"),
    "Scenario 4: Recommends herbal salve for daily soothe + herbal salve + treat myself"
  );
  assert(
    dom.resultsContainer.innerHTML.includes(
      "choice of daily soothe vibes, herbal salve focus, and treat myself intent"
    ),
    "Scenario 4: Correct rationale formulation"
  );
})();

// 1.5 Adversarial Test: Out-of-Stock / Coming Soon Penalty (-20)
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  const testProducts = JSON.parse(JSON.stringify(productsJson));

  // In Scenario 1, top products were shimmer-oil (10) and sleep-salve (9).
  // Set shimmer-oil and sleep-salve to stock: 0
  const shimmerOil = testProducts.products.find((p) => p.id === "shimmer-oil");
  const sleepSalve = testProducts.products.find((p) => p.id === "sleep-salve");
  if (shimmerOil) shimmerOil.stock = 0;
  if (sleepSalve) sleepSalve.stock = 0;

  mockWindow.YL_PRODUCTS = testProducts;

  const dom = setupQuizDOM(contentJson.quiz.questions, {
    "quiz-vibe": "gothic-calm",
    "quiz-need": "hydration",
    "quiz-intent": "treat-myself"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(
    !dom.resultsContainer.innerHTML.includes("Shimmer Body Oil") &&
      !dom.resultsContainer.innerHTML.includes("Sleep Salve"),
    "Penalty Test (OOS): OOS products with stock: 0 are penalized by -20 and bypassed"
  );
  assert(
    dom.resultsContainer.innerHTML.includes("Frankincense") ||
      dom.resultsContainer.innerHTML.includes("Beard Salve") ||
      dom.resultsContainer.innerHTML.includes("Lavender"),
    "Penalty Test (OOS): In-stock runner-up selected as top recommendation"
  );

  // Set comingSoon: true on the runner up
  const frankincense = testProducts.products.find((p) => p.id === "frankincense-salve");
  if (frankincense) {
    frankincense.comingSoon = true;
  }
  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(
    !dom.resultsContainer.innerHTML.includes("Frankincense"),
    "Penalty Test (comingSoon): Coming Soon product is penalized by -20 and bypassed"
  );
})();

// 1.6 Fallback Behavior: window.YL_CONTENT.quiz is null or undefined
(() => {
  mockWindow.YL_CONTENT = {
    site: {
      enableLoyaltyPoints: true,
      loyaltyBadgeEmoji: "✨",
      loyaltyPointsPerDollar: 1,
      loyaltyPointsName: "Alt-Points"
    }
  };
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  // Test with quiz: null
  let dom = setupQuizDOM(null, {
    "quiz-vibe": "gothic-calm",
    "quiz-need": "hydration",
    "quiz-intent": "treat-myself"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(
    dom.resultsContainer.style.display === "block",
    "Fallback (quiz: null): Results container displayed"
  );
  assert(
    dom.resultsContainer.innerHTML.includes("Sleep Salve") ||
      dom.resultsContainer.innerHTML.includes("Lavender") ||
      dom.resultsContainer.innerHTML.includes("Bath Tea"),
    "Fallback (quiz: null): Hardcoded rule fallback recommends gothic-calm item"
  );

  // Test with YL_CONTENT undefined entirely
  mockWindow.YL_CONTENT = null;
  dom = setupQuizDOM(null, {
    "quiz-vibe": "ritual-rest",
    "quiz-need": "muscle-soak",
    "quiz-intent": "gift-bestie"
  });

  main.initApothecaryQuiz();
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

  assert(
    dom.resultsContainer.style.display === "block",
    "Fallback (YL_CONTENT: null): Does not crash and computes recommendation"
  );
})();

// 1.7 Combinatorial Matrix Fuzz: All 48 Combinations of Vibe x Need x Intent
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const vibes = ["gothic-calm", "ritual-rest", "hexing-energy", "daily-soothe"];
  const needs = ["hydration", "muscle-soak", "herbal-salve", "apparel-lifestyle"];
  const intents = ["treat-myself", "gift-bestie", "ritual-bath"];

  let combinationsTested = 0;
  let allValid = true;

  vibes.forEach((vibe) => {
    needs.forEach((need) => {
      intents.forEach((intent) => {
        const dom = setupQuizDOM(contentJson.quiz.questions, {
          "quiz-vibe": vibe,
          "quiz-need": need,
          "quiz-intent": intent
        });

        main.initApothecaryQuiz();
        dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });

        const html = dom.resultsContainer.innerHTML;
        const hasCard = html.includes("quiz-recommended-card");
        const hasAddBtn = html.includes("yl-add-item");
        const hasPrice = html.includes("Add Recommendation to Cart ($");

        if (!hasCard || !hasAddBtn || !hasPrice) {
          allValid = false;
        }
        combinationsTested++;
      });
    });
  });

  assert(
    combinationsTested === 48 && allValid,
    `Combinatorial Matrix: Successfully scored and rendered all ${combinationsTested} combinations without error`
  );
})();

// 1.8 Step Navigation and Reset Button Wiring
(() => {
  mockWindow.YL_CONTENT = JSON.parse(JSON.stringify(contentJson));
  mockWindow.YL_PRODUCTS = JSON.parse(JSON.stringify(productsJson));

  const dom = setupQuizDOM(contentJson.quiz.questions, { "quiz-vibe": "gothic-calm" });

  const nextBtn = createMockElement("button");
  nextBtn.className = "quiz-next-step";
  nextBtn.setAttribute("data-next", "2");
  dom.section.appendChild(nextBtn);

  const prevBtn = createMockElement("button");
  prevBtn.className = "quiz-prev-step";
  prevBtn.setAttribute("data-prev", "1");
  dom.section.appendChild(prevBtn);

  main.initApothecaryQuiz();

  // Test Next Step
  dom.section.dispatchEvent({ type: "click", target: nextBtn, bubbles: true });
  const step2 = mockDocument.getElementById("quiz-step-2");
  assert(
    step2 && step2.style.display === "block",
    "Quiz Step Nav: Next button transitions to Step 2"
  );

  // Test Prev Step
  dom.section.dispatchEvent({ type: "click", target: prevBtn, bubbles: true });
  const step1 = mockDocument.getElementById("quiz-step-1");
  assert(
    step1 && step1.style.display === "block",
    "Quiz Step Nav: Prev button transitions back to Step 1"
  );

  // Test Retake / Reset Button
  dom.section.dispatchEvent({ type: "click", target: dom.submitBtn, bubbles: true });
  assert(dom.resultsContainer.style.display === "block", "Quiz Results shown before reset");

  dom.resetBtn.dispatchEvent({ type: "click", target: dom.resetBtn, bubbles: true });
  assert(
    dom.resultsContainer.style.display === "none",
    "Quiz Reset: start-apothecary-quiz-btn resets quiz and hides results"
  );
})();

/* ========================================================================== */
/* CATEGORY 2: ANNOUNCEMENT BAR CONFIGURATIONS & THEMES                       */
/* ========================================================================== */
console.log("\n--- Category 2: Announcement Bar Configurations & Themes ---");

function setupAnnouncementDOM(hasCountdownTicker = false) {
  resetBody();
  if (hasCountdownTicker) {
    const ticker = createMockElement("div");
    ticker.id = "yl-countdown-ticker";
    mockDocument.body.appendChild(ticker);
  }
}

// 2.1 announcement.enabled: false
(() => {
  setupAnnouncementDOM(false);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: false,
        text: "Special Promo",
        link: "shop.html",
        accent: "whiskey"
      }
    }
  };
  mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 40 } };

  main.announcementBar();

  const bar = mockDocument.body.querySelector(".announcement-bar");
  assert(bar === null, "announcementBar: enabled: false renders nothing");
})();

// 2.2 announcement.text empty -> fallback to freeShippingThreshold
(() => {
  setupAnnouncementDOM(false);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: true,
        text: "",
        link: "",
        accent: "default"
      }
    }
  };
  mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 40 } };

  main.announcementBar();

  const bar = mockDocument.body.querySelector(".announcement-bar");
  assert(bar !== null, "announcementBar: renders fallback when text is empty");
  assert(
    /* "of $40 or more", not "over $40": the Worker waives shipping at
       >= the threshold, so an exactly-$40.00 cart ships free and the old
       wording left that case undefined in the prose (audit C, L11). */
    bar.textContent.includes("✦ Free shipping on orders of $40 or more ✦"),
    "announcementBar: renders free shipping message with threshold value"
  );
  assert(
    bar.getAttribute("role") === "region" || bar.getAttribute("role") === "status",
    "announcementBar: has role='region' or 'status'"
  );
})();

// 2.3 announcement.text empty and freeShippingThreshold missing or 0 -> renders nothing
(() => {
  setupAnnouncementDOM(false);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: true,
        text: "   ",
        link: ""
      }
    }
  };
  mockWindow.YL_PRODUCTS = { shop: { freeShippingThreshold: 0 } };

  main.announcementBar();

  const bar = mockDocument.body.querySelector(".announcement-bar");
  assert(bar === null, "announcementBar: whitespace text + 0 threshold renders nothing");
})();

// 2.4 announcement.link provided vs empty
(() => {
  // With Link
  setupAnnouncementDOM(false);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: true,
        text: "Limited Release Drop",
        link: "shop.html?category=salves",
        accent: "moss"
      }
    }
  };
  main.announcementBar();

  let bar = mockDocument.body.querySelector(".announcement-bar");
  assert(bar !== null, "announcementBar: standalone bar created");
  const linkEl = bar.querySelector("a");
  assert(linkEl !== null, "announcementBar (with link): text wrapped in <a> tag");
  assert(
    /* announcementBar() makes site-relative links root-absolute so the bar
       works from /products/ pages too */
    linkEl.getAttribute("href") === "/shop.html?category=salves",
    "announcementBar (with link): href matches config"
  );
  assert(
    linkEl.textContent === "Limited Release Drop",
    "announcementBar (with link): link text matches message"
  );

  // Without Link
  setupAnnouncementDOM(false);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: true,
        text: "In-Store Pop-Up Today",
        link: "",
        accent: "default"
      }
    }
  };
  main.announcementBar();

  bar = mockDocument.body.querySelector(".announcement-bar");
  assert(
    bar.querySelector("a") === null,
    "announcementBar (no link): renders plaintext without <a>"
  );
  assert(
    bar.textContent === "In-Store Pop-Up Today",
    "announcementBar (no link): text content matches message"
  );
})();

// 2.5 Accent themes (whiskey, moss, lavender, rust, default)
(() => {
  const accents = [
    { accent: "whiskey", expectedClass: "announcement-accent-whiskey" },
    { accent: "moss", expectedClass: "announcement-accent-moss" },
    { accent: "lavender", expectedClass: "announcement-accent-lavender" },
    { accent: "rust", expectedClass: "announcement-accent-rust" },
    { accent: "default", expectedClass: null }
  ];

  accents.forEach((tc) => {
    setupAnnouncementDOM(false);
    mockWindow.YL_CONTENT = {
      site: {
        announcement: {
          enabled: true,
          text: `Accent test ${tc.accent}`,
          link: "",
          accent: tc.accent
        }
      }
    };
    main.announcementBar();

    const bar = mockDocument.body.querySelector(".announcement-bar");
    if (tc.expectedClass) {
      assert(
        bar.classList.contains(tc.expectedClass),
        `announcementBar: accent '${tc.accent}' adds class .${tc.expectedClass}`
      );
    } else {
      assert(
        !bar.className.includes("announcement-accent-"),
        `announcementBar: accent 'default' does not add extra accent class`
      );
    }
  });
})();

// 2.6 Integration with #yl-countdown-ticker
(() => {
  setupAnnouncementDOM(true);
  mockWindow.YL_CONTENT = {
    site: {
      announcement: {
        enabled: true,
        text: "Special Flash Sale",
        link: "shop.html",
        accent: "lavender"
      }
    }
  };

  main.announcementBar();

  const ticker = mockDocument.getElementById("yl-countdown-ticker");
  assert(ticker !== null, "Countdown ticker DOM preserved");
  assert(
    ticker.classList.contains("announcement-accent-lavender"),
    "Countdown ticker adopts announcement accent class"
  );

  const seg = ticker.querySelector(".announcement-segment");
  assert(seg !== null, "Countdown ticker contains .announcement-segment child");
  const linkInSeg = seg.querySelector("a");
  assert(
    linkInSeg !== null && linkInSeg.href === "shop.html",
    "Segment contains linked announcement text"
  );
  assert(
    ticker.querySelector(".announcement-sep") !== null,
    "Countdown ticker includes visual separator span"
  );
})();

/* ========================================================================== */
/* CATEGORY 3: CART DRAWER SEASONAL NOTICE                                    */
/* ========================================================================== */
console.log("\n--- Category 3: Cart Drawer Seasonal Notice ---");

function setupCartDOM() {
  resetBody();
  YLCart.init();
}

// 3.1 Seasonal Notice Enabled with Link
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: true,
        showInCart: true,
        text: "🌿 Spring Hiatus: Orders ship soon.",
        link: "events.html"
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl !== null, "Seasonal notice element exists in cart drawer");
  assert(
    noticeEl.style.display === "block",
    "Seasonal notice is displayed when enabled and showInCart: true"
  );
  assert(
    noticeEl.innerHTML.includes("yl-cart-seasonal-link"),
    "Seasonal notice with link wraps text in .yl-cart-seasonal-link"
  );
  assert(
    noticeEl.innerHTML.includes('href="events.html"'),
    "Seasonal notice href points to events.html"
  );
  assert(
    noticeEl.innerHTML.includes("Spring Hiatus: Orders ship soon"),
    "Seasonal notice text rendered"
  );
})();

// 3.2 Seasonal Notice Enabled without Link
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: true,
        showInCart: true,
        text: "Winter Holiday Market Break",
        link: ""
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl.style.display === "block", "Seasonal notice without link is displayed");
  assert(
    !noticeEl.innerHTML.includes("<a "),
    "Seasonal notice without link does not render <a> tag"
  );
  assert(
    noticeEl.innerHTML.includes("Winter Holiday Market Break"),
    "Seasonal notice plaintext rendered"
  );
})();

// 3.3 Seasonal Notice Disabled
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: false,
        showInCart: true,
        text: "Hidden notice",
        link: "events.html"
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl.style.display === "none", "Seasonal notice hidden when enabled: false");
  assert(noticeEl.innerHTML === "", "Seasonal notice content emptied when disabled");
})();

// 3.4 Seasonal Notice showInCart: false
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: true,
        showInCart: false,
        text: "Header only notice",
        link: "events.html"
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl.style.display === "none", "Seasonal notice hidden when showInCart: false");
})();

// 3.5 Seasonal Notice text empty or whitespace
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: true,
        showInCart: true,
        text: "",
        link: "events.html"
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl.style.display === "none", "Seasonal notice hidden when text is empty");
})();

// 3.6 Seasonal Notice Null / Undefined Config
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = { site: {} };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(noticeEl.style.display === "none", "Seasonal notice hidden when config is missing");
})();

// 3.7 Seasonal Notice XSS Sanitization
(() => {
  setupCartDOM();
  mockWindow.YL_CONTENT = {
    site: {
      seasonalNotice: {
        enabled: true,
        showInCart: true,
        text: '<script>alert("XSS")</script> & "Dangerous"',
        link: 'events.html?a="><script>alert(1)</script>'
      }
    }
  };

  YLCart.render();

  const noticeEl = mockDocument.getElementById("yl-cart-seasonal-notice");
  assert(
    !noticeEl.innerHTML.includes("<script>"),
    "Seasonal notice HTML escapes raw <script> tag in text"
  );
  assert(
    noticeEl.innerHTML.includes("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;") ||
      noticeEl.innerHTML.includes("&lt;script&gt;"),
    "Seasonal notice text properly encoded"
  );
})();

/* ========================================================================== */
/* CATEGORY 4: MODAL RITUAL DEFAULTS FALLBACK                                 */
/* ========================================================================== */
console.log("\n--- Category 4: Modal Ritual Defaults Fallback ---");

(() => {
  mockWindow.YL_CONTENT = {
    site: {
      ritualDefaults: {
        title: "Botanical Pairing",
        subtitle: "Pair this item with complementary botanicals crafted to work together."
      }
    }
  };

  const testProductWithoutRitualTitle = {
    id: "test-salve",
    name: "Test Healing Salve",
    price: 15,
    category: "salves",
    pairsWith: ["lavender-soak"]
  };

  const testMap = new Map([
    ["lavender-soak", { id: "lavender-soak", name: "Lavender Bath Soak", price: 16, stock: 5 }]
  ]);

  const html = main.renderModalRitualHtml(testProductWithoutRitualTitle, testMap);
  assert(
    html.includes("✦ Complete the Ritual: Botanical Pairing ✦"),
    "renderModalRitualHtml uses ritualDefaults.title when ritualTitle is omitted"
  );
  assert(
    html.includes("Pair this item with complementary botanicals crafted to work together."),
    "renderModalRitualHtml includes ritualDefaults.subtitle"
  );

  // Test when ritualDefaults is missing entirely
  mockWindow.YL_CONTENT = { site: {} };
  const fallbackHtml = main.renderModalRitualHtml(testProductWithoutRitualTitle, testMap);
  assert(
    fallbackHtml.includes("✦ Complete the Ritual: Botanical Pairing ✦"),
    "renderModalRitualHtml uses hardcoded default 'Botanical Pairing' when ritualDefaults is undefined"
  );
})();

console.log("\n================================================================================");
console.log(`Empirical Adversarial Challenger Suite: ${passed} passed, ${failed} failed.`);
console.log("================================================================================");

process.exit(failed ? 1 : 0);
