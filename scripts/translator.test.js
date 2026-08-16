/**
 * @fileoverview Unit tests for translator.js
 * Run: node scripts/translator.test.js
 */
/* global window */
const assert = require("assert");

// Setup mock DOM environment
function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  const classListSet = new Set();

  const el = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    attributes: attrs,
    setAttribute: (name, val) => attrs.set(name, String(val)),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    style: {},
    classList: {
      add: function (...names) {
        names.forEach((n) => classListSet.add(n));
      },
      remove: function (...names) {
        names.forEach((n) => classListSet.delete(n));
      },
      contains: function (name) {
        return classListSet.has(name);
      },
      toggle: function (name) {
        if (classListSet.has(name)) classListSet.delete(name);
        else classListSet.add(name);
      }
    },
    innerHTML: "",
    textContent: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    querySelector: (selector) => {
      if (selector === ".goog-te-combo") {
        return mockBody._children.find((c) => c.className === "goog-te-combo") || null;
      }
      return null;
    },
    querySelectorAll: () => []
  };

  // Some element specific properties
  Object.defineProperty(el, "src", {
    get: () => attrs.get("src") || "",
    set: (v) => {
      attrs.set("src", String(v));
    }
  });

  return el;
}

const mockBody = createMockElement("body");

const mockDocument = {
  getElementById: (id) => {
    return mockBody._children?.find((c) => c.id === id) || null;
  },
  querySelector: (selector) => {
    if (selector === ".goog-te-combo") {
      return mockBody._children.find((c) => c.className === "goog-te-combo") || null;
    }
    return null;
  },
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),

  documentElement: createMockElement("html"),
  createEvent: () => ({
    initEvent: () => {}
  }),
  body: mockBody,
  addEventListener: () => {},
  get cookie() {
    return this._cookie || "";
  },
  set cookie(v) {
    this._cookie = v;
  }
};

// Fix up mockBody to store children
mockBody._children = [];
mockBody.appendChild = (child) => {
  mockBody._children.push(child);
  return child;
};

// Setup timeout mocking
let pendingTimeouts = [];
global.setTimeout = (cb, ms) => {
  pendingTimeouts.push({ cb, ms });
  return pendingTimeouts.length;
};
global.clearTimeouts = () => {
  pendingTimeouts = [];
};
global.runPendingTimeouts = () => {
  const toRun = [...pendingTimeouts];
  pendingTimeouts = [];
  toRun.forEach((t) => t.cb());
};

global.Event = class Event {
  constructor(type, options) {
    this.type = type;
    this.options = options;
  }
};

// Expose globals
global.document = mockDocument;
global.window = {
  document: mockDocument,
  location: {
    hostname: "yallternativeliving.com",
    reloadCalls: 0,
    reload: function () {
      this.reloadCalls++;
    }
  }
};
global.self = {};

// Now load the module
const translator = require("../assets/js/translator.js");

async function runTests() {
  console.log("Running translator.js tests...");

  // Reset state before tests
  translator._resetInternalState();
  mockBody._children = [];

  let testsPassed = 0;
  let testsFailed = 0;

  async function runTest(name, testFn) {
    try {
      await testFn();
      console.log(`✅ ${name}`);
      testsPassed++;
    } catch (e) {
      console.error(`❌ ${name}`);
      console.error(e);
      testsFailed++;
    }
  }

  // --- Tests for loadGoogleScript ---

  await runTest("loadGoogleScript creates div and script elements on first call", async () => {
    translator._resetInternalState();
    mockBody._children = [];
    delete window.googleTranslateElementInit;

    const promise = translator.loadGoogleScript();

    // Verify google_translate_element div is created and hidden
    const div = mockDocument.getElementById("google_translate_element");
    assert.ok(div, "google_translate_element div should exist");
    assert.strictEqual(div.style.display, "none", "div should be hidden");

    // Verify script is appended
    const script = mockBody._children.find((el) => el.id === "google_translate_script");
    assert.ok(script, "google_translate_script should be appended to body");
    assert.strictEqual(script.tagName, "SCRIPT", "script should be a script element");
    assert.strictEqual(
      script.src,
      "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit",
      "script should have correct src"
    );
    assert.strictEqual(script.async, true, "script should be async");

    // Verify window callback exists
    assert.strictEqual(
      typeof window.googleTranslateElementInit,
      "function",
      "callback should be defined on window"
    );

    const internalState = translator._getInternalState();
    assert.ok(internalState.googleInitPromise, "promise should be stored in internal state");

    // suppress unused variable warning
    assert.ok(promise, "promise returned from function");
  });

  await runTest(
    "loadGoogleScript returns same promise on subsequent calls without duplicating elements",
    async () => {
      translator._resetInternalState();
      mockBody._children = [];

      const promise1 = translator.loadGoogleScript();
      const childrenCountAfterFirstCall = mockBody._children.length;

      const promise2 = translator.loadGoogleScript();

      assert.strictEqual(promise1, promise2, "Should return the exact same promise instance");
      assert.strictEqual(
        mockBody._children.length,
        childrenCountAfterFirstCall,
        "Should not add new elements to body"
      );
    }
  );

  await runTest(
    "googleTranslateElementInit callback sets isGoogleLoaded and resolves promise",
    async () => {
      translator._resetInternalState();
      mockBody._children = [];

      // Mock the Google Translate constructor
      window.google = {
        translate: {
          TranslateElement: function (options, elId) {
            this.options = options;
            this.elId = elId;
          }
        }
      };

      const promise = translator.loadGoogleScript();

      // Check initial state
      assert.strictEqual(
        translator._getInternalState().isGoogleLoaded,
        false,
        "Should not be loaded initially"
      );

      // Simulate callback invocation from loaded script
      window.googleTranslateElementInit();

      // Wait for promise to resolve
      await promise;

      // Check state after resolution
      assert.strictEqual(
        translator._getInternalState().isGoogleLoaded,
        true,
        "isGoogleLoaded should be true after init"
      );
    }
  );

  // --- Tests for triggerGoogleTranslate ---

  await runTest("triggerGoogleTranslate reloads if retries > 50", async () => {
    translator._resetInternalState();
    mockDocument.cookie = "";
    window.location.reloadCalls = 0;

    translator.triggerGoogleTranslate("fr", 51);

    assert.strictEqual(window.location.reloadCalls, 1, "Should have called reload");
  });

  await runTest("triggerGoogleTranslate schedules retry if goog-te-combo missing", async () => {
    translator._resetInternalState();
    mockDocument.cookie = "";
    global.clearTimeouts();
    mockBody._children = []; // Ensure no goog-te-combo exists

    translator.triggerGoogleTranslate("fr", 0);

    // Verify cookie was set
    assert.ok(mockDocument.cookie.includes("googtrans=/en/fr"), "Should set googtrans cookie");

    // Verify timeout was scheduled
    assert.strictEqual(pendingTimeouts.length, 1, "Should schedule a timeout");
    assert.strictEqual(pendingTimeouts[0].ms, 100, "Timeout should be 100ms");

    // Execute the timeout callback
    const cb = pendingTimeouts[0].cb;
    global.clearTimeouts();
    cb();

    // Verify it scheduled another retry
    assert.strictEqual(pendingTimeouts.length, 1, "Should schedule another retry timeout");
  });

  await runTest(
    "triggerGoogleTranslate updates combo and dispatches event if combo exists",
    async () => {
      translator._resetInternalState();
      mockDocument.cookie = "";
      global.clearTimeouts();

      // Add mock combo element
      const combo = createMockElement("select");
      combo.className = "goog-te-combo";
      Object.defineProperty(combo, "value", {
        get: function () {
          return this._value || "";
        },
        set: function (v) {
          this._value = v;
        }
      });
      combo.value = "";
      let eventDispatched = false;
      combo.dispatchEvent = (e) => {
        eventDispatched = true;
        assert.strictEqual(e.type, "change", "Event should be change");
      };
      mockBody.appendChild(combo);

      translator.triggerGoogleTranslate("es", 0);
      assert.strictEqual(combo.value, "es", "Combo value should be updated");
      assert.strictEqual(eventDispatched, true, "Should dispatch change event");
      assert.ok(mockDocument.cookie.includes("googtrans=/en/es"), "Should set googtrans cookie");

      // Check timeout for translation verification was set
      assert.strictEqual(pendingTimeouts.length, 1, "Should schedule verification timeout");
      assert.strictEqual(pendingTimeouts[0].ms, 800, "Timeout should be 800ms");
    }
  );

  await runTest(
    "triggerGoogleTranslate verification timeout reloads if not translated",
    async () => {
      translator._resetInternalState();
      mockDocument.cookie = "";
      global.clearTimeouts();
      window.location.reloadCalls = 0;

      // Reset document element classes
      mockDocument.documentElement = createMockElement("html");

      const combo = createMockElement("select");
      combo.className = "goog-te-combo";
      Object.defineProperty(combo, "value", {
        get: function () {
          return this._value || "";
        },
        set: function (v) {
          this._value = v;
        }
      });
      combo.value = "";
      combo.dispatchEvent = () => {};
      mockBody._children = [combo];

      translator.triggerGoogleTranslate("de", 0);

      assert.strictEqual(pendingTimeouts.length, 1, "Should schedule verification timeout");

      // Execute the timeout without adding translated class
      global.runPendingTimeouts();

      assert.strictEqual(
        window.location.reloadCalls,
        1,
        "Should reload if translated class not present"
      );
    }
  );

  await runTest(
    "triggerGoogleTranslate verification timeout does not reload if translated",
    async () => {
      translator._resetInternalState();
      mockDocument.cookie = "";
      global.clearTimeouts();
      window.location.reloadCalls = 0;

      mockDocument.documentElement = createMockElement("html");

      const combo = createMockElement("select");
      combo.className = "goog-te-combo";
      Object.defineProperty(combo, "value", {
        get: function () {
          return this._value || "";
        },
        set: function (v) {
          this._value = v;
        }
      });
      combo.value = "";
      combo.dispatchEvent = () => {};
      mockBody._children = [combo];

      translator.triggerGoogleTranslate("de", 0);

      assert.strictEqual(pendingTimeouts.length, 1, "Should schedule verification timeout");

      // Add translated class to simulate success
      mockDocument.documentElement.classList.add("translated-ltr");

      // Execute the timeout
      global.runPendingTimeouts();

      assert.strictEqual(
        window.location.reloadCalls,
        0,
        "Should NOT reload if translated class is present"
      );
    }
  );

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed.`);
  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests();
