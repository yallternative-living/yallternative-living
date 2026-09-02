/**
 * @fileoverview Unit test suite for the order status lookup (H-6).
 *
 * The page used to answer any plausible-looking string with a confirmed order,
 * a four-step fulfilment timeline, a hardcoded two-item order and a printable
 * packing slip -- none of it fetched from anywhere. It now asks a real
 * endpoint (POST /api/order-status, workers/routes/order-status.js) with the
 * Stripe session id AND the email used at checkout, and reports exactly what
 * comes back -- or hands the visitor to a person when it cannot.
 *
 * Tests:
 * 1. Email masking algorithm (maskEmail).
 * 2. Order query validation and parsing (parseOrderStatusQuery).
 * 3. Both fields are validated client-side before a request is spent.
 * 4. The request: URL, method, headers and {sessionId, email} payload.
 * 5. 200 rendering -- status words, tracking link, date, items, total, city.
 * 6. The 404 / 429 / 500 / network branches.
 * 7. The renderer writes no server string through innerHTML (source grep).
 * 8. A `javascript:` trackingUrl is never linked.
 * 9. The fabricated timeline, packing slip, sample items and reorder are gone.
 * 10. Only a well-formed ?session_id= pre-fills, and nothing auto-submits.
 * 11. content.json's enableOrderStatusLookup actually gates the page.
 * 12. Escaping of whatever the visitor typed.
 *
 * Run: node scripts/order-status-engine.test.js
 */

"use strict";

const assert = require("assert");

// Setup mock storage and elements
const storage = new Map();
const mockLocalStorage = {
  getItem: (k) => storage.get(k) || null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear()
};

/**
 * The success path builds real nodes (createElement + textContent + appendChild)
 * rather than assigning innerHTML, so the mock has to keep a child tree and be
 * able to flatten it back to text for assertions.
 */
function createMockElement(tagName) {
  tagName = tagName || "div";
  const attrs = new Map();
  const children = [];
  const eventListeners = {};
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    children: children,
    setAttribute: (name, val) => attrs.set(name, String(val)),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    style: {},
    className: "",
    classList: {
      _list: new Set(),
      add: function () {
        for (let i = 0; i < arguments.length; i++) this._list.add(arguments[i]);
      },
      remove: function () {
        for (let i = 0; i < arguments.length; i++) this._list.delete(arguments[i]);
      },
      contains: function (name) {
        return this._list.has(name);
      },
      toggle: function (name, force) {
        if (force === undefined) {
          if (this._list.has(name)) this._list.delete(name);
          else this._list.add(name);
        } else if (force) {
          this._list.add(name);
        } else {
          this._list.delete(name);
        }
      }
    },
    _textContent: "",
    get textContent() {
      if (children.length) return children.map((c) => c.textContent).join(" ");
      return this._textContent;
    },
    set textContent(val) {
      // Assigning textContent clears children, exactly as the DOM does --
      // which is how the renderer empties the container between lookups.
      children.length = 0;
      this._textContent = String(val);
    },
    _innerHTML: "",
    get innerHTML() {
      if (children.length) return children.map((c) => c.innerHTML || c.textContent).join("");
      return this._innerHTML;
    },
    set innerHTML(val) {
      children.length = 0;
      this._innerHTML = val;
      this._textContent = String(val).replace(/<[^>]*>/g, "");
    },
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    addEventListener: (evt, fn) => {
      if (!eventListeners[evt]) eventListeners[evt] = [];
      eventListeners[evt].push(fn);
    },
    dispatchEvent: function (evt) {
      if (evt.type === "click" && typeof this.onclick === "function") this.onclick(evt);
      if (evt.type === "submit" && typeof this.onsubmit === "function") this.onsubmit(evt);
      const fns = eventListeners[evt.type] || [];
      fns.forEach((fn) => fn(evt));
    },
    focus: function () {
      mockDocument.activeElement = this;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => [],
    hidden: false
  };
  return el;
}

/** Walks a rendered subtree and returns every element carrying `className`. */
function findByClass(root, className) {
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (node.className === className) out.push(node);
    (node.children || []).forEach(walk);
  })(root);
  return out;
}

/** Walks a rendered subtree and returns every element of a tag name. */
function findByTag(root, tagName) {
  const want = tagName.toUpperCase();
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (node.tagName === want) out.push(node);
    (node.children || []).forEach(walk);
  })(root);
  return out;
}

const elementCache = {};

const mockDocument = {
  documentElement: createMockElement("html"),
  activeElement: null,
  getElementById: (id) => {
    if (!elementCache[id]) {
      elementCache[id] = createMockElement("div");
      elementCache[id].id = id;
    }
    return elementCache[id];
  },
  querySelector: () => createMockElement("div"),
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {},
  removeEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  location: { hash: "", search: "", href: "https://yallternativeliving.com/order-status.html" },
  addEventListener: () => {},
  removeEventListener: () => {},
  YL_PRODUCTS: {
    categories: ["all", "salves", "body"],
    products: [
      {
        id: "frankincense-salve",
        name: "Y'all Heal Now Miracle Frankincense Salve",
        price: 19.99,
        inStock: true
      },
      { id: "miracle-balm", name: "Y'allternative Miracle Balm", price: 8.0, inStock: true }
    ]
  },
  YLCart: {
    items: [],
    isOpen: false,
    addItem(it) {
      this.items.push(it);
    },
    addItems(its) {
      this.items.push(...its);
    },
    open() {
      this.isOpen = true;
    }
  }
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;

console.log("Running Order Status Engine Unit Tests (H-6)...\n");

const main = require("./../assets/js/main.js");

/** A fetch double that records every call and answers with a canned response. */
function stubFetch(response) {
  const calls = [];
  const fn = function (url, init) {
    calls.push({ url: url, init: init });
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve({
      status: response.status,
      json: () =>
        Object.prototype.hasOwnProperty.call(response, "body")
          ? Promise.resolve(response.body)
          : Promise.reject(new SyntaxError("not JSON"))
    });
  };
  fn.calls = calls;
  return fn;
}

/** A fresh set of the elements one lookup touches. */
function lookupContext(fetchImpl) {
  return {
    referenceInput: createMockElement("input"),
    emailInput: createMockElement("input"),
    errorEl: createMockElement("div"),
    resultContainer: createMockElement("div"),
    resultSection: createMockElement("div"),
    submitBtn: createMockElement("button"),
    submitLabel: "Look up this order",
    fetchImpl: fetchImpl
  };
}

const PAID_ORDER = {
  found: true,
  sessionId: "cs_live_abc123",
  status: "complete",
  paymentStatus: "paid",
  amountTotal: 4250,
  amountTotalCents: 4250,
  currency: "usd",
  // 2026-03-14T00:00:00Z, as Stripe reports `created`: Unix seconds.
  placedAt: 1773446400,
  items: [
    { name: "Y'all Heal Now Miracle Frankincense Salve", quantity: 2 },
    { name: "Backroad Soak", quantity: 1 }
  ],
  shipping: { city: "Landrum", state: "SC" },
  fulfillment: { status: "processing", trackingUrl: null, shippedAt: null }
};

// 1. Test maskEmail helper
console.log("  --- 1. Testing maskEmail Helper ---");
assert.strictEqual(typeof main.maskEmail, "function", "maskEmail helper must be exported");
assert.strictEqual(
  main.maskEmail("savanna@example.com"),
  "s***a@e***e.com",
  "Properly masks standard email"
);
assert.strictEqual(
  main.maskEmail("j@domain.org"),
  "j*@d***n.org",
  "Properly masks single letter username"
);
assert.strictEqual(
  main.maskEmail("invalid-email"),
  "invalid-email",
  "Handles malformed email gracefully"
);
console.log("  ✓ maskEmail masks user and domain while preserving TLD structure");

// 2. Test parseOrderStatusQuery
console.log("\n  --- 2. Testing parseOrderStatusQuery Helper ---");
assert.strictEqual(
  typeof main.parseOrderStatusQuery,
  "function",
  "parseOrderStatusQuery must be exported"
);

const sessionRes = main.parseOrderStatusQuery("cs_live_1234567890abcdef_secret");
assert.ok(sessionRes, "Session ID query must be recognized");
assert.strictEqual(sessionRes.isSessionId, true, "isSessionId flag is true");
assert.strictEqual(sessionRes.isEmail, false, "isEmail flag is false");

const emailRes = main.parseOrderStatusQuery("customer@test.com");
assert.ok(emailRes, "Email query must be recognized");
assert.strictEqual(emailRes.isEmail, true, "isEmail flag is true");
assert.strictEqual(emailRes.displayId, "c***r@t***t.com", "displayId is masked for emails");

const invalidRes = main.parseOrderStatusQuery("random_text_123");
assert.strictEqual(invalidRes, null, "Unrecognized strings return null");
assert.strictEqual(main.parseOrderStatusQuery(""), null, "Empty query returns null");
console.log("  ✓ parseOrderStatusQuery accurately validates and categorizes lookup tokens");

// 3. Both fields are validated before a request is spent
console.log("\n  --- 3. Testing client-side validation of BOTH fields ---");
assert.strictEqual(typeof main.validateOrderLookup, "function", "validateOrderLookup is exported");

// The reference: Stripe's own `cs_(live|test)_...` shape, nothing looser.
[
  ["cs_live_a1B2c3D4", true],
  ["cs_test_a1B2c3D4", true],
  ["  cs_live_a1B2c3D4  ", true],
  ["cs_live_", false],
  ["cs_prod_a1B2c3", false],
  ["cs_a1B2c3", false],
  ["YL-2026-0842", false],
  ["cs_live_abc-123", false],
  ["cs_live_abc def", false],
  ["", false]
].forEach(([value, expected]) => {
  assert.strictEqual(
    main.isStripeSessionId(value),
    expected,
    `isStripeSessionId(${JSON.stringify(value)}) === ${expected}`
  );
});

[
  ["savanna@example.com", true],
  ["  savanna@example.com ", true],
  ["savanna@example", false],
  ["savanna.example.com", false],
  ["a b@example.com", false],
  ["", false]
].forEach(([value, expected]) => {
  assert.strictEqual(
    main.isLookupEmail(value),
    expected,
    `isLookupEmail(${JSON.stringify(value)}) === ${expected}`
  );
});

const bothBlank = main.validateOrderLookup("", "");
assert.strictEqual(bothBlank.ok, false, "Both fields blank is refused");
assert.strictEqual(bothBlank.field, "reference", "...and focus goes to the reference");

const noEmail = main.validateOrderLookup("cs_live_abc123", "");
assert.strictEqual(noEmail.ok, false, "A reference on its own is not enough");
assert.strictEqual(noEmail.field, "email", "...and focus goes to the email");
assert.ok(/email/i.test(noEmail.message), "...with a message that names the email");

const noRef = main.validateOrderLookup("", "savanna@example.com");
assert.strictEqual(noRef.ok, false, "An email on its own is not enough");
assert.strictEqual(noRef.field, "reference", "...and focus goes to the reference");

const badRef = main.validateOrderLookup("YL-2026-0842", "savanna@example.com");
assert.strictEqual(badRef.ok, false, "An order-reference-looking string is refused");
assert.ok(/cs_/.test(badRef.message), "...and the message says what the reference looks like");

const badEmail = main.validateOrderLookup("cs_live_abc123", "not-an-email");
assert.strictEqual(badEmail.ok, false, "A malformed email is refused");
assert.strictEqual(badEmail.field, "email", "...pointing at the email field");

const good = main.validateOrderLookup("  cs_live_abc123 ", " Savanna@Example.com ");
assert.strictEqual(good.ok, true, "Both fields well-formed passes");
assert.strictEqual(good.sessionId, "cs_live_abc123", "The reference is trimmed");
assert.strictEqual(good.email, "Savanna@Example.com", "The email is trimmed (case left to Stripe)");

/* Nothing in the validation message may claim the email was checked here --
   it is checked by the Worker against the Stripe session. */
[bothBlank, noEmail, noRef, badRef, badEmail].forEach((res) => {
  assert.strictEqual(
    /verif/i.test(res.message),
    false,
    `Validation message must not imply verification: "${res.message}"`
  );
});
console.log("  ✓ Both the reference and the email are required and shape-checked");

// The invalid branch must not spend a request.
(async () => {
  const noFetch = stubFetch({ status: 200, body: PAID_ORDER });
  const ctx = lookupContext(noFetch);
  ctx.referenceInput.value = "YL-2026-0842";
  ctx.emailInput.value = "savanna@example.com";
  const branch = await main.runOrderStatusLookup(ctx);
  assert.strictEqual(branch, "invalid", "A malformed reference short-circuits");
  assert.strictEqual(noFetch.calls.length, 0, "...and never reaches the network");
  assert.strictEqual(ctx.errorEl.hidden, false, "...and the error is shown");
  assert.strictEqual(ctx.resultContainer.textContent, "", "...and nothing is rendered");

  // 4. The request
  console.log("\n  --- 4. Testing the request payload and URL ---");
  assert.strictEqual(
    main.ORDER_STATUS_ENDPOINT,
    "/api/order-status",
    "Same-origin through the Netlify /api/* proxy"
  );
  const okFetch = stubFetch({ status: 200, body: PAID_ORDER });
  const okCtx = lookupContext(okFetch);
  okCtx.referenceInput.value = "cs_live_abc123";
  okCtx.emailInput.value = "savanna@example.com";
  const okBranch = await main.runOrderStatusLookup(okCtx);
  assert.strictEqual(okBranch, "found", "A 200 {found:true} takes the found branch");
  assert.strictEqual(okFetch.calls.length, 1, "Exactly one request per submit");
  const call = okFetch.calls[0];
  assert.strictEqual(call.url, "/api/order-status", "POSTs to /api/order-status");
  assert.strictEqual(call.init.method, "POST", "Uses POST, so the reference stays out of the URL");
  assert.strictEqual(
    call.init.headers["Content-Type"],
    "application/json",
    "Sends a JSON content type"
  );
  assert.deepStrictEqual(
    JSON.parse(call.init.body),
    { sessionId: "cs_live_abc123", email: "savanna@example.com" },
    "Body is exactly {sessionId, email}"
  );
  console.log("  ✓ POST /api/order-status carries {sessionId, email} and nothing else");

  // 5. 200 rendering
  console.log("\n  --- 5. Testing the rendered order (mocked 200) ---");
  const rendered = okCtx.resultContainer;
  assert.strictEqual(okCtx.resultSection.hidden, false, "The result section is revealed");
  assert.strictEqual(rendered.hidden, false, "The result container is revealed");
  assert.strictEqual(okCtx.submitBtn.disabled, false, "The submit button is re-enabled");
  assert.strictEqual(
    okCtx.submitBtn.textContent,
    "Look up this order",
    "...with its label restored"
  );

  const heading = findByClass(rendered, "order-status-result-heading")[0];
  assert.ok(heading, "A status heading is rendered");
  assert.strictEqual(heading.textContent, "Paid, being packed", "Paid + unshipped reads plainly");

  const placed = findByClass(rendered, "order-status-placed")[0];
  assert.ok(placed, "The placed date is rendered");
  assert.ok(/2026/.test(placed.textContent), "placedAt renders as a local date");
  assert.strictEqual(
    /1773446400/.test(placed.textContent),
    false,
    "...not as a raw Unix timestamp"
  );

  const itemTexts = findByTag(findByClass(rendered, "order-status-items")[0], "li").map(
    (li) => li.textContent
  );
  assert.deepStrictEqual(
    itemTexts,
    ["Y'all Heal Now Miracle Frankincense Salve × 2", "Backroad Soak × 1"],
    "Each line item renders as name × quantity"
  );

  const total = findByClass(rendered, "order-status-total")[0];
  assert.ok(total, "The order total is rendered");
  assert.ok(/\$42\.50/.test(total.textContent), "4250 cents renders as $42.50");

  const shipping = findByClass(rendered, "order-status-shipping")[0];
  assert.ok(shipping, "The shipping line is rendered");
  assert.strictEqual(shipping.textContent, "Shipping to Landrum, SC", "City and state only");

  /* The Worker never sends a street or a phone, and the page must never
     echo the credentials the visitor typed back onto the screen. */
  const wholeRender = rendered.textContent;
  ["savanna@example.com", "cs_live_abc123"].forEach((secret) => {
    assert.strictEqual(
      wholeRender.includes(secret),
      false,
      `The rendered order must not repeat "${secret}"`
    );
  });
  console.log("  ✓ Status, date, items, total and city/state render from the Worker's answer");

  // 5b. The other three status mappings, plus the tracking link.
  const cases = [
    [{ status: "complete", paymentStatus: "paid", fulfillment: { status: "shipped" } }, "Shipped"],
    [
      { status: "complete", paymentStatus: "unpaid", fulfillment: { status: "processing" } },
      "Payment pending"
    ],
    [
      { status: "expired", paymentStatus: "unpaid", fulfillment: { status: "processing" } },
      "Expired / not completed"
    ],
    [
      {
        status: "open",
        paymentStatus: "no_payment_required",
        fulfillment: { status: "processing" }
      },
      "Paid, being packed"
    ]
  ];
  cases.forEach(([order, expected]) => {
    assert.strictEqual(
      main.orderStatusPlainWords(order),
      expected,
      `${order.status}/${order.paymentStatus}/${order.fulfillment.status} reads "${expected}"`
    );
  });

  const shippedFetch = stubFetch({
    status: 200,
    body: Object.assign({}, PAID_ORDER, {
      fulfillment: {
        status: "shipped",
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400123",
        shippedAt: "2026-03-16"
      }
    })
  });
  const shippedCtx = lookupContext(shippedFetch);
  shippedCtx.referenceInput.value = "cs_live_abc123";
  shippedCtx.emailInput.value = "savanna@example.com";
  await main.runOrderStatusLookup(shippedCtx);
  const shippedHeading = findByClass(shippedCtx.resultContainer, "order-status-result-heading")[0];
  assert.strictEqual(shippedHeading.textContent, "Shipped", "A shipped order says Shipped");
  const trackLinks = findByTag(shippedCtx.resultContainer, "A");
  assert.strictEqual(trackLinks.length, 1, "A tracking link is offered");
  assert.strictEqual(
    trackLinks[0].getAttribute("href"),
    "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400123",
    "...pointing at the Worker's trackingUrl"
  );
  assert.strictEqual(trackLinks[0].getAttribute("rel"), "noopener", "...with rel=noopener");
  console.log("  ✓ Status words map correctly and a tracking link is offered when present");

  // 6. Response branches
  console.log("\n  --- 6. Testing the 404 / 429 / 500 / network branches ---");

  const missCtx = lookupContext(
    stubFetch({ status: 404, body: { found: false, error: "not_found" } })
  );
  missCtx.referenceInput.value = "cs_test_zzz999";
  missCtx.emailInput.value = "someone@example.com";
  assert.strictEqual(await main.runOrderStatusLookup(missCtx), "not_found", "404 -> not_found");
  const missHtml = missCtx.resultContainer.innerHTML;
  const missText = missCtx.resultContainer.textContent;
  assert.ok(
    missText.includes("We couldn't find an order with that reference and email"),
    "404 says exactly that, and blames neither field"
  );
  assert.ok(missHtml.includes("order-lookup-help"), "404 still offers the contact hand-off");
  assert.ok(
    !missHtml.includes("order-lookup-unavailable") && !missText.includes("reach the order system"),
    "404 does not claim the order system was unreachable -- it answered"
  );
  assert.ok(
    missHtml.includes("mailto:y.allternative.living@gmail.com?subject="),
    "...with a pre-filled mail subject"
  );
  assert.strictEqual(
    missText.includes("someone@example.com"),
    false,
    "The email is never echoed back on a miss"
  );

  const rateCtx = lookupContext(
    stubFetch({ status: 429, body: { found: false, error: "rate_limited" } })
  );
  rateCtx.referenceInput.value = "cs_test_zzz999";
  rateCtx.emailInput.value = "someone@example.com";
  assert.strictEqual(
    await main.runOrderStatusLookup(rateCtx),
    "rate_limited",
    "429 -> rate_limited"
  );
  assert.strictEqual(
    rateCtx.resultContainer.textContent,
    "Too many lookups; try again in a minute.",
    "429 says how long to wait and asserts nothing about the order"
  );

  for (const [label, response] of [
    ["500", { status: 500, body: { error: "server_error" } }],
    ["503", { status: 503, body: { error: "unavailable" } }],
    ["a non-JSON body", { status: 502 }],
    ["a network failure", new Error("Failed to fetch")]
  ]) {
    const ctxN = lookupContext(stubFetch(response));
    ctxN.referenceInput.value = "cs_live_abc123";
    ctxN.emailInput.value = "savanna@example.com";
    assert.strictEqual(
      await main.runOrderStatusLookup(ctxN),
      "unavailable",
      `${label} -> unavailable`
    );
    assert.ok(
      ctxN.resultContainer.innerHTML.includes("order-lookup-unavailable"),
      `${label} renders the contact hand-off`
    );
    assert.ok(
      ctxN.resultContainer.innerHTML.includes("cs_live_abc123"),
      `${label} pre-fills the reference the visitor typed`
    );
    assert.strictEqual(
      ctxN.resultContainer.textContent.includes("savanna@example.com"),
      false,
      `${label} never echoes the email back`
    );
    assert.strictEqual(ctxN.submitBtn.disabled, false, `${label} re-enables the submit button`);
  }

  /* A 200 whose body does not say found:true is not an order. */
  const emptyCtx = lookupContext(stubFetch({ status: 200, body: { found: false } }));
  emptyCtx.referenceInput.value = "cs_live_abc123";
  emptyCtx.emailInput.value = "savanna@example.com";
  assert.strictEqual(
    await main.runOrderStatusLookup(emptyCtx),
    "unavailable",
    "A 200 without found:true asserts nothing about an order"
  );
  console.log("  ✓ 404, 429, 5xx and network failures each answer honestly");

  // 7. The renderer never puts a server string through innerHTML
  console.log("\n  --- 7. Testing that no server string is written as HTML ---");
  const renderSrc = main.renderOrderStatusResult.toString();
  assert.strictEqual(
    /innerHTML/.test(renderSrc),
    false,
    "renderOrderStatusResult must not mention innerHTML at all"
  );
  assert.strictEqual(
    /insertAdjacentHTML|outerHTML|document\.write/.test(renderSrc),
    false,
    "...nor any other markup-parsing sink"
  );
  assert.ok(/textContent/.test(renderSrc), "...and it does use textContent");
  assert.ok(/safeLinkUrl/.test(renderSrc), "...and it does vet the tracking href");

  /* A markup payload in a line item name, a city or a currency renders as
     text or not at all -- it never becomes an element. */
  const xssFetch = stubFetch({
    status: 200,
    body: Object.assign({}, PAID_ORDER, {
      items: [{ name: '<img src=x onerror="alert(1)">', quantity: 1 }],
      shipping: { city: "<script>alert(1)</script>", state: "SC" }
    })
  });
  const xssCtx = lookupContext(xssFetch);
  xssCtx.referenceInput.value = "cs_live_abc123";
  xssCtx.emailInput.value = "savanna@example.com";
  await main.runOrderStatusLookup(xssCtx);
  const payloadItem = findByTag(findByClass(xssCtx.resultContainer, "order-status-items")[0], "LI");
  assert.strictEqual(
    payloadItem[0].textContent,
    '<img src=x onerror="alert(1)"> × 1',
    "A markup payload in an item name stays inert text"
  );
  assert.strictEqual(payloadItem[0].children.length, 0, "...and creates no child elements");
  console.log("  ✓ Server strings reach the page only through textContent");

  // 8. A javascript: trackingUrl is never linked
  console.log("\n  --- 8. Testing that a javascript: trackingUrl is refused ---");
  for (const hostile of [
    "javascript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)"
  ]) {
    const hostileCtx = lookupContext(
      stubFetch({
        status: 200,
        body: Object.assign({}, PAID_ORDER, {
          fulfillment: { status: "shipped", trackingUrl: hostile, shippedAt: null }
        })
      })
    );
    hostileCtx.referenceInput.value = "cs_live_abc123";
    hostileCtx.emailInput.value = "savanna@example.com";
    await main.runOrderStatusLookup(hostileCtx);
    const links = findByTag(hostileCtx.resultContainer, "A");
    assert.strictEqual(links.length, 0, `"${hostile}" is not turned into a link`);
    assert.strictEqual(
      findByClass(hostileCtx.resultContainer, "order-status-result-heading")[0].textContent,
      "Shipped",
      `...though the order still reads Shipped for "${hostile}"`
    );
  }
  console.log("  ✓ Only an http(s) trackingUrl is ever linked");

  // 9. The fabricated order furniture is gone from main.js and the pages
  console.log("\n  --- 9. Testing removal of the invented order, slip and reorder ---");
  const fs = require("fs");
  const path = require("path");
  const repoRoot = path.resolve(__dirname, "..");
  const mainSrc = fs.readFileSync(path.join(repoRoot, "assets/js/main.js"), "utf8");
  ["sampleOrderItems", "slipItemsTableBody", "slipGiftMessageText", "reorderPastOrderBtn"].forEach(
    (needle) => {
      assert.strictEqual(
        mainSrc.includes(needle),
        false,
        `main.js must no longer reference ${needle}`
      );
    }
  );
  const orderStatusHtml = fs.readFileSync(path.join(repoRoot, "order-status.html"), "utf8");
  [
    "packingSlipContainer",
    "printPackingSlipBtn",
    "reorderPastOrderBtn",
    "orderVerifyInput"
  ].forEach((needle) => {
    assert.strictEqual(
      orderStatusHtml.includes(needle),
      false,
      `order-status.html must no longer contain ${needle}`
    );
  });
  assert.strictEqual(
    /onclick=/.test(orderStatusHtml),
    false,
    "order-status.html carries no inline event handler (the CSP blocks them)"
  );
  assert.strictEqual(
    (orderStatusHtml.match(/<!--YL:/g) || []).length,
    (orderStatusHtml.match(/<!--\/YL:/g) || []).length,
    "order-status.html build markers stay paired"
  );

  /* Both fields exist on the page and in the modal, and nothing left over
     claims the email is checked in the browser. */
  assert.ok(
    orderStatusHtml.includes('id="orderQueryInput"'),
    "order-status.html still carries the reference input"
  );
  assert.ok(
    orderStatusHtml.includes('id="orderEmailInput"'),
    "order-status.html carries the email input"
  );
  ["order-status.html", "thank-you.html", "shop.html"].forEach((page) => {
    const src = fs.readFileSync(path.join(repoRoot, page), "utf8");
    assert.strictEqual(
      /\bverif(y|ied|ication)\b/i.test(src.replace(/Verified Stripe Payment/g, "")),
      false,
      `${page} carries no wording implying the browser verifies the email`
    );
    assert.strictEqual(
      src.includes("reorderPastOrderBtn"),
      false,
      `${page} carries no reorder button for an order it did not fetch`
    );
  });
  ["thank-you.html", "shop.html"].forEach((page) => {
    const src = fs.readFileSync(path.join(repoRoot, page), "utf8");
    assert.ok(src.includes('id="order-id-input"'), `${page} modal carries the reference input`);
    assert.ok(src.includes('id="order-email-input"'), `${page} modal carries the email input`);
    assert.strictEqual(
      (src.match(/<!--YL:/g) || []).length,
      (src.match(/<!--\/YL:/g) || []).length,
      `${page} build markers stay paired`
    );
  });
  console.log("  ✓ Fabricated timeline, packing slip, sample items and reorder are gone");

  // 10. Query parameters: only session_id may pre-fill, and nothing auto-submits
  console.log("\n  --- 10. Testing URL parameter handling ---");
  const pageFetch = stubFetch({ status: 200, body: PAID_ORDER });
  mockWindow.fetch = pageFetch;

  function freshPageWith(search) {
    Object.keys(elementCache).forEach((k) => delete elementCache[k]);
    mockWindow.location.search = search;
    main.initOrderStatusPage();
    return {
      input: mockDocument.getElementById("orderQueryInput"),
      email: mockDocument.getElementById("orderEmailInput"),
      timeline: mockDocument.getElementById("orderTimelineContainer"),
      result: mockDocument.getElementById("orderStatusResultSection")
    };
  }

  let ctx2 = freshPageWith("?email=customer%40example.com");
  assert.strictEqual(ctx2.input.value, undefined, "?email= never reaches the reference input");
  assert.strictEqual(ctx2.email.value, undefined, "?email= never reaches the email input either");
  assert.strictEqual(ctx2.timeline.textContent, "", "?email= never runs a lookup");

  ctx2 = freshPageWith("?q=YL-2026-0842");
  assert.strictEqual(ctx2.input.value, undefined, "?q= does not pre-fill");
  assert.strictEqual(ctx2.timeline.textContent, "", "?q= never runs a lookup");

  ctx2 = freshPageWith("?session_id=cs_live_abc123");
  assert.strictEqual(ctx2.input.value, "cs_live_abc123", "?session_id= pre-fills the reference");
  assert.strictEqual(
    ctx2.email.value,
    undefined,
    "...and leaves the email for the visitor to type"
  );
  assert.strictEqual(
    ctx2.timeline.textContent,
    "",
    "?session_id= pre-fills but never auto-submits"
  );
  assert.strictEqual(pageFetch.calls.length, 0, "...and spends no request on load");

  ctx2 = freshPageWith("?session_id=%3Cimg%20src%3Dx%20onerror%3D1%3E");
  assert.strictEqual(ctx2.input.value, undefined, "A malformed session_id is refused outright");
  mockWindow.location.search = "";
  console.log("  ✓ Only a well-formed ?session_id= pre-fills, and nothing auto-submits");

  // 10b. The page form, once mounted, runs the real lookup on submit.
  Object.keys(elementCache).forEach((k) => delete elementCache[k]);
  const submitFetch = stubFetch({ status: 200, body: PAID_ORDER });
  mockWindow.fetch = submitFetch;
  main.initOrderStatusPage();
  mockDocument.getElementById("orderQueryInput").value = "cs_live_abc123";
  mockDocument.getElementById("orderEmailInput").value = "savanna@example.com";
  mockDocument
    .getElementById("orderStatusPageForm")
    .dispatchEvent({ type: "submit", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(submitFetch.calls.length, 1, "Submitting the page form calls the endpoint");
  assert.deepStrictEqual(
    JSON.parse(submitFetch.calls[0].init.body),
    { sessionId: "cs_live_abc123", email: "savanna@example.com" },
    "...with both fields from the page's own inputs"
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    mockDocument
      .getElementById("orderTimelineContainer")
      .textContent.includes("Paid, being packed"),
    "...and renders the answer into #orderTimelineContainer"
  );
  delete mockWindow.fetch;

  // 11. The CMS switch actually gates the page
  console.log("\n  --- 11. Testing enableOrderStatusLookup gate ---");
  assert.strictEqual(typeof main.siteFlagEnabled, "function", "siteFlagEnabled must be exported");
  assert.strictEqual(
    main.siteFlagEnabled("enableOrderStatusLookup"),
    true,
    "An absent flag defaults to on"
  );
  mockWindow.YL_CONTENT = { site: { enableOrderStatusLookup: false } };
  assert.strictEqual(
    main.siteFlagEnabled("enableOrderStatusLookup"),
    false,
    "siteFlagEnabled reads window.YL_CONTENT.site"
  );
  Object.keys(elementCache).forEach((k) => delete elementCache[k]);
  const gatedFetch = stubFetch({ status: 200, body: PAID_ORDER });
  mockWindow.fetch = gatedFetch;
  main.initOrderStatusPage();
  const gatedCard = mockDocument.getElementById("orderStatusLookupCard");
  const gatedTimeline = mockDocument.getElementById("orderTimelineContainer");
  const gatedForm = mockDocument.getElementById("orderStatusPageForm");
  assert.strictEqual(gatedCard.hidden, true, "Lookup form is hidden when the switch is off");
  assert.ok(
    gatedTimeline.innerHTML.includes("y.allternative.living@gmail.com"),
    "The contact route is shown in its place"
  );
  mockDocument.getElementById("orderQueryInput").value = "cs_live_abc123";
  mockDocument.getElementById("orderEmailInput").value = "savanna@example.com";
  gatedForm.dispatchEvent({ type: "submit", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(gatedFetch.calls.length, 0, "The form is not wired at all when it is off");
  delete mockWindow.fetch;
  mockWindow.YL_CONTENT = undefined;
  console.log("  ✓ enableOrderStatusLookup gates the page section");

  // 12. Escaping of whatever the visitor typed
  console.log("\n  --- 12. Testing escaping of the echoed reference ---");
  assert.ok(
    !main.orderStatusFallbackHTML('<img src=x onerror="alert(1)">').includes("<img"),
    "A markup payload in the reference is escaped, not rendered"
  );
  assert.ok(
    main.orderStatusFallbackHTML('<img src=x onerror="alert(1)">').includes("&lt;img"),
    "...and is shown escaped"
  );
  console.log("  ✓ The echoed reference is escaped");

  console.log("\nAll order-status-engine unit tests passed successfully!\n");
})().catch((err) => {
  console.error("\n✗ Order status engine test failed:\n");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
