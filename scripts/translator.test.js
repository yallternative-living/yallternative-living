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
    querySelector: () => null,
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
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: mockBody,
  addEventListener: () => {},
  cookie: ""
};

// Fix up mockBody to store children
mockBody._children = [];
mockBody.appendChild = (child) => {
  mockBody._children.push(child);
  return child;
};

// Expose globals
global.document = mockDocument;
global.window = {
  document: mockDocument,
  location: {
    hostname: "yallternativeliving.com",
    reload: () => {}
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

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed.`);
  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests();
