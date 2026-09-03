/**
 * @fileoverview Unit tests for the shop's Umami analytics contract.
 * Run: node scripts/analytics.test.js
 *
 * Three things are pinned here, and each one is pinned because it was broken:
 *
 *  1. THE SCRUBBER (assets/js/main.js, window.ylAnalyticsBeforeSend). Umami
 *     reports the full page URL. This shop puts a Stripe Checkout Session id,
 *     a subscriber's email address and an adverse-reaction report reference in
 *     query strings, and all three were measured leaving the page in the
 *     pageview payload on 2026-09-02. The tracker's own data-exclude-search
 *     drops the query string; this hook puts back ONLY the utm_* campaign
 *     parameters. Anything not on that allow-list must not come back, and no
 *     event property may carry an address, an order reference or free text.
 *
 *  2. THE TAG. data-domains keeps localhost, deploy previews and the Puppeteer
 *     suites out of the production dataset (Umami's server-side bot filter is a
 *     User-Agent matcher and does not catch modern headless Chrome, so nothing
 *     upstream would have caught a test run). data-before-send names the hook.
 *     And on the generated product pages the tag has to sit in <head> BEFORE
 *     main.js: when it sat at the end of <body> instead, window.umami did not
 *     exist yet when the PDP fired "Product View", so the one event product
 *     pages exist to record was dropped on all twenty of them.
 *
 *  3. THE EVENTS. Every event this site sends, its exact property keys, and --
 *     the point of the whole file -- that not one of them carries personal
 *     data. An assertion here that stops examining anything is worse than no
 *     assertion, so every check below asserts its subject exists first.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

/* ------------------------------------------------------------------ 1. hook */

/**
 * Loads assets/js/main.js against a throwaway DOM whose location.search is
 * `search`, and hands back its exported analytics helpers. The scrubber reads
 * the query string ONCE at load time -- deliberately, because welcome.js,
 * safety.js and main.js itself all scrub window.location.search out of the
 * address bar before the tracker's pageview is sent -- so each case needs its
 * own load.
 */
function loadMain(search, extraDocument) {
  const storage = new Map();
  const el = () => ({
    tagName: "DIV",
    style: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false
    },
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    hasAttribute: () => false,
    addEventListener: () => {},
    /* Elements hand back further elements rather than null: main.js builds a
       few widgets with createElement() and then reaches into them, and a null
       there kills the module load before it can export anything. */
    querySelector: () => el(),
    querySelectorAll: () => [],
    appendChild: () => {},
    closest: () => null,
    children: [],
    hidden: false
  });
  const doc = Object.assign(
    {
      documentElement: el(),
      body: Object.assign(el(), { getAttribute: () => null }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => el(),
      addEventListener: () => {},
      readyState: "complete"
    },
    extraDocument || {}
  );
  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    location: {
      href: "https://yallternativeliving.com/shop.html" + search,
      hash: "",
      search,
      pathname: "/shop.html",
      hostname: "yallternativeliving.com",
      origin: "https://yallternativeliving.com"
    },
    addEventListener: () => {}
  };
  global.window = win;
  global.document = doc;
  global.localStorage = win.localStorage;
  global.navigator = { userAgent: "node" };
  delete require.cache[require.resolve("../assets/js/main.js")];
  const mod = require("../assets/js/main.js");
  return { mod, win };
}

const plain = loadMain("");
assert(
  plain.mod && typeof plain.mod.analyticsBeforeSend === "function",
  "main.js exports analyticsBeforeSend"
);
assert(
  typeof plain.mod.analyticsAllowedQuery === "function",
  "main.js exports analyticsAllowedQuery"
);
assert(
  plain.win.ylAnalyticsBeforeSend === plain.mod.analyticsBeforeSend,
  "the hook is published on window under the name the tracker tag asks for"
);

const allowed = plain.mod.analyticsAllowedQuery;

eq(allowed("?session_id=cs_live_a1b2c3d4e5f6&amount=42.50"), "", "a Stripe session id is dropped");
eq(allowed("?email=buyer%40example.com"), "", "a subscriber address is dropped");
eq(allowed("?report=received&ref=YL-SR-8842"), "", "a reaction-report reference is dropped");
eq(allowed("?cart=salve-2oz~2_soak~1"), "", "a shared-cart payload is dropped");
eq(allowed("?pickup_market=landrum-fall"), "", "a pickup market is dropped");
eq(allowed("?category=apparel&concern=all"), "", "shop filters are dropped");
eq(allowed("?subscribed=1"), "", "the newsletter return flag is dropped");
eq(
  allowed("?gclid=abc123&fbclid=xyz789"),
  "",
  "ad-click ids are dropped -- they identify one person's click, and this shop buys no ads"
);
eq(
  allowed("?utm_source=instagram&utm_medium=bio&utm_campaign=fall"),
  "?utm_source=instagram&utm_medium=bio&utm_campaign=fall",
  "utm_* campaign parameters survive, so channel attribution still works"
);
eq(
  allowed("?utm_source=market-qr&session_id=cs_live_deadbeefcafe"),
  "?utm_source=market-qr",
  "an allow-listed parameter next to a forbidden one keeps only the allow-listed half"
);
/* The rebuilt query string is in the allow-list's own order, not the incoming
   URL's, so two links that differ only in parameter order collapse to one row
   in the Pages report instead of two. */
eq(
  allowed("?utm_term=salve&utm_content=story-2"),
  "?utm_content=story-2&utm_term=salve",
  "utm_term and utm_content survive, in a canonical order"
);
eq(allowed(""), "", "no query string means no query string");
eq(allowed("?%ZZ=broken"), "", "an unparseable query string yields nothing rather than throwing");

/* The full hook, on the payload shape the live tracker actually builds. */
const withUtm = loadMain("?utm_source=instagram&utm_campaign=fall");
const utmHook = withUtm.mod.analyticsBeforeSend;
eq(
  utmHook("event", { url: "https://yallternativeliving.com/index.html" }).url,
  "https://yallternativeliving.com/index.html?utm_source=instagram&utm_campaign=fall",
  "the campaign parameters are put back on the recorded URL"
);
eq(
  utmHook("event", { url: "https://yallternativeliving.com/shop.html#apparel" }).url,
  "https://yallternativeliving.com/shop.html?utm_source=instagram&utm_campaign=fall#apparel",
  "a fragment stays after the query, not before it"
);

const dirty = loadMain("?session_id=cs_live_a1b2c3d4e5f6&amount=42.50");
const dirtyHook = dirty.mod.analyticsBeforeSend;
eq(
  dirtyHook("event", {
    url: "https://yallternativeliving.com/thank-you.html?session_id=cs_live_a1b2c3d4e5f6&amount=42.50"
  }).url,
  "https://yallternativeliving.com/thank-you.html",
  "a session id in the payload URL is removed even if the tracker somehow left it there"
);
eq(
  dirtyHook("event", { referrer: "/thank-you.html?session_id=cs_live_a1b2c3d4e5f6" }).referrer,
  "/thank-you.html",
  "and it is removed from the referrer, which is how it would leak onto the NEXT page"
);

/* Prerendering. Speculation Rules prerender a product page after ~200ms of
   hover; the tracker has no prerender awareness of its own, so without this a
   hovered link counts as a visit. */
const prerendering = loadMain("", { prerendering: true });
eq(
  prerendering.mod.analyticsBeforeSend("event", { url: "https://yallternativeliving.com/x.html" }),
  null,
  "nothing is sent while the page is only prerendered"
);
/* Reloaded rather than reusing `plain`: the hook reads document.prerendering
   off the global at call time, and the load above left a prerendering document
   in place. */
const normal = loadMain("");
eq(
  normal.mod.analyticsBeforeSend("event", { url: "https://yallternativeliving.com/x.html" }).url,
  "https://yallternativeliving.com/x.html",
  "...and a normally-rendered page is unaffected"
);

/* Event properties. */
const hook = normal.mod.analyticsBeforeSend;
function scrub(data) {
  const out = hook("event", { url: "https://yallternativeliving.com/x.html", data });
  return out ? out.data : null;
}
eq(scrub({ product: "sleep-salve" }), { product: "sleep-salve" }, "a product id is kept");
eq(
  scrub({ product: "Hush Y'all Magnesium Arnica Sleep Salve" }),
  { product: "Hush Y'all Magnesium Arnica Sleep Salve" },
  "a product name is kept"
);
eq(
  scrub({ revenue: 42.5, currency: "USD" }),
  { revenue: 42.5, currency: "USD" },
  "revenue and currency survive -- Umami's Revenue report reads exactly these two keys"
);
eq(
  scrub({ itemCount: 3, subtotalCents: 4299, isPickup: true }),
  { itemCount: 3, subtotalCents: 4299, isPickup: true },
  "the checkout properties survive"
);
eq(
  scrub({ length: 20, hasResults: true }),
  { length: 20, hasResults: true },
  "search shape survives"
);
eq(scrub({ email: "buyer@example.com" }), {}, "an email property is dropped by key");
eq(scrub({ subscriber: "buyer@example.com" }), {}, "...and by value, whatever the key is called");
eq(scrub({ sessionId: "cs_live_a1b2c3" }), {}, "a session property is dropped by key");
eq(scrub({ order: "1234" }), {}, "an order reference is dropped by key");
eq(scrub({ giftNote: "Happy birthday Mom" }), {}, "a gift note is dropped by key");
eq(scrub({ giftCardCode: "YL-XXXX" }), {}, "a gift card code is dropped by key");
eq(scrub({ address: "1 Main St" }), {}, "an address is dropped by key");
eq(scrub({ whatever: "cs_live_a1b2c3d4e5f6" }), {}, "a Stripe id is dropped by value");
eq(scrub({ whatever: "x".repeat(200) }), {}, "free text longer than the cap is dropped");
eq(
  scrub({ product: "sleep-salve", email: "a@b.com" }),
  { product: "sleep-salve" },
  "a mixed payload keeps the safe half and drops the rest"
);
eq(hook("event", null), null, "a null payload passes through untouched");

/* ------------------------------------------------------- 2. the tracker tag */

const contentJson = JSON.parse(read("assets/data/content.json"));
const websiteId = contentJson.site && contentJson.site.umamiWebsiteId;
assert(
  typeof websiteId === "string" && websiteId && websiteId.indexOf("YOUR_") !== 0,
  "content.json holds a real Umami website id (these tag checks are pointless without one)"
);

const TOP_LEVEL_PAGES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .sort();
assert(TOP_LEVEL_PAGES.length >= 14, `found ${TOP_LEVEL_PAGES.length} top-level pages to check`);

const PDPS = fs
  .readdirSync(path.join(ROOT, "products"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => "products/" + f)
  .sort();
assert(PDPS.length >= 19, `found ${PDPS.length} product pages to check`);

/* offline.html is the service worker's fallback: it is shown when there is no
   network at all, so a tracker on it could only ever fail. It must stay bare. */
const TRACKED = TOP_LEVEL_PAGES.filter((f) => f !== "offline.html").concat(PDPS);

const REQUIRED_TAG_ATTRS = [
  'data-website-id="' + websiteId + '"',
  'data-domains="yallternativeliving.com,www.yallternativeliving.com"',
  'data-exclude-search="true"',
  'data-exclude-hash="true"',
  'data-do-not-track="true"',
  'data-before-send="ylAnalyticsBeforeSend"'
];

let taggedPages = 0;
TRACKED.forEach((page) => {
  const src = read(page);
  const tag = /<script[^>]*cloud\.umami\.is\/script\.js[^>]*><\/script>/.exec(src);
  if (!tag) {
    failed++;
    console.error(`  ✗ ${page} carries the Umami tracker tag`);
    return;
  }
  taggedPages++;
  REQUIRED_TAG_ATTRS.forEach((attr) => {
    assert(tag[0].indexOf(attr) !== -1, `${page} tracker tag carries ${attr.split("=")[0]}`);
  });
});
eq(taggedPages, TRACKED.length, "every tracked page actually has the tag");

assert(
  read("offline.html").indexOf("cloud.umami.is") === -1,
  "offline.html loads no tracker -- it is the page you see with no network"
);

/* The ordering bug, pinned. A deferred tag after main.js means window.umami
   does not exist when main.js fires its load-time events. */
PDPS.concat(["index.html", "shop.html"]).forEach((page) => {
  const src = read(page);
  const tagAt = src.indexOf("cloud.umami.is/script.js");
  const mainAt = src.indexOf("assets/js/main.js");
  assert(tagAt !== -1 && mainAt !== -1, `${page} has both a tracker tag and main.js`);
  assert(
    tagAt < mainAt,
    `${page} loads the tracker BEFORE main.js, so window.umami exists when main.js fires an event`
  );
});

/* ------------------------------------------------------------------ 3. CSP */

/* The tracker builds its collection URL as
   (data-host-url || "https://gateway.umami.is") + "/api/send". The site sets no
   data-host-url, so every pageview and event POSTs to gateway.umami.is. With
   only cloud.umami.is (the SCRIPT origin) in connect-src, the browser refused
   every one of them and the dashboard stayed empty. */
["_headers", "netlify.toml", "vercel.json"].forEach((file) => {
  const src = read(file);
  const connect = /connect-src ([^;"]*)/.exec(src);
  assert(connect, `${file} declares a connect-src`);
  if (!connect) return;
  assert(
    connect[1].indexOf("https://gateway.umami.is") !== -1,
    `${file} connect-src allows https://gateway.umami.is -- the host the tracker actually POSTs to`
  );
  const scriptSrc = /script-src ([^;"]*)/.exec(src);
  assert(
    scriptSrc && scriptSrc[1].indexOf("https://cloud.umami.is") !== -1,
    `${file} script-src still allows the origin the tracker is served from`
  );
});

/* --------------------------------------------------------------- 4. events */

const mainJs = read("assets/js/main.js");
const cartJs = read("assets/js/cart.js");
const thankYouJs = read("assets/js/thank-you.js");

/* name -> [file source, expected property keys]. An empty array means the event
   is deliberately sent with no properties at all. */
const EVENTS = {
  "Product View": [mainJs, ["product"]],
  "Add to Cart": [mainJs, ["product"]],
  "Variant Selected": [mainJs, ["product", "variant"]],
  "Wishlist Add": [mainJs, ["product"]],
  "Site Search": [mainJs, ["length", "hasResults"]],
  "Quiz Completed": [mainJs, ["result"]],
  "Newsletter Signup": [mainJs, []],
  "Restock Alert": [mainJs, ["product"]],
  "Market Alert Signup": [mainJs, []],
  "Outbound Click": [mainJs, ["destination"]],
  "PWA Installed": [mainJs, []],
  "App Updated": [mainJs, []],
  404: [mainJs, ["path"]],
  "Cart Opened": [cartJs, ["itemCount"]],
  "Cart Shared": [cartJs, ["itemCount"]],
  "Gift Card Applied": [cartJs, []],
  "Checkout Start": [cartJs, ["itemCount", "subtotalCents", "isPickup"]],
  "Checkout Failed": [cartJs, ["reason"]],
  Purchase: [thankYouJs, ["revenue", "currency"]]
};

Object.keys(EVENTS).forEach((name) => {
  const [src, expectedKeys] = EVENTS[name];
  const calls = src.split('"' + name + '"').length - 1;
  assert(calls >= 1, `"${name}" is sent from somewhere`);
  /* Grab the call and read the property keys straight out of the source, so a
     renamed or added property has to be acknowledged here. */
  const re = new RegExp(
    '(?:plausible|track)\\(\\s*"' +
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      '"([\\s\\S]{0,400}?)\\)\\s*;'
  );
  const m = re.exec(src);
  assert(m, `"${name}" call site is shaped the way this test can read`);
  if (!m) return;
  /* Only identifiers that open a property -- i.e. that follow a `{` or a `,`.
     A bare `name:` pattern also matches the middle of a ternary
     (`x ? y.value : "unknown"`), which reported a phantom property. */
  const keys = (m[1].match(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g) || [])
    .map((k) => k.replace(/[\s:{,]/g, ""))
    .filter((k) => k !== "props");
  eq(keys, expectedKeys, `"${name}" sends exactly the properties it is supposed to`);
});

/* Event names are capped at 50 characters by the collection API. */
Object.keys(EVENTS).forEach((name) => {
  assert(name.length <= 50, `"${name}" is within Umami's 50-character event-name limit`);
});

/* The blunt instrument: no analytics call site anywhere may mention a variable
   that holds personal data. This is the check that would have caught the raw
   search query when it used to be sent as a property. */
const FORBIDDEN_IN_CALLS =
  /\b(email|emailInput|typed|giftMessage|giftNote|recipient|sender|sessionId|session_id|normalized\.code|state\.giftMessage|searchInput\.value|value\.trim\(\)(?!\.length))\b/;
[
  ["assets/js/main.js", mainJs],
  ["assets/js/cart.js", cartJs],
  ["assets/js/thank-you.js", thankYouJs]
].forEach(([label, src]) => {
  const calls =
    src.match(/(?:window\.plausible|[^.\w]track)\(\s*"[^"]+"[\s\S]{0,400}?\)\s*;/g) || [];
  assert(calls.length > 0, `${label} has analytics call sites to inspect`);
  calls.forEach((call) => {
    const offender = FORBIDDEN_IN_CALLS.exec(call);
    assert(
      !offender,
      `${label}: an analytics call passes personal data (${offender && offender[0]}) -- ${call.slice(0, 80)}`
    );
  });
});

/* Site Search specifically: the raw query used to be a property. */
assert(
  /window\.plausible\("Site Search", \{\s*props: \{\s*length: value\.trim\(\)\.length,\s*hasResults:/.test(
    mainJs
  ),
  "Site Search reports the LENGTH of the query and whether it matched, never the query"
);

/* Purchase specifically: it may only be sent once the Worker has confirmed the
   order, and the revenue must be the Worker's figure rather than the URL's. */
assert(
  /function confirmOrder\(confirmedAmount\)/.test(thankYouJs),
  "Purchase is sent from confirmOrder(), not from page load"
);
assert(
  /summary\.status !== "complete"\) return showUnconfirmed\(\)/.test(thankYouJs),
  "confirmOrder is only reached once /api/order-summary reports a complete, paid session"
);
assert(
  /claimSession\(sessionId\)/.test(thankYouJs),
  "and it is claimed once per session id, so a refresh cannot double-count revenue"
);

/* Checkout Failed reports a class, never the server's message. */
const reasonFn = /function checkoutFailureReason\(err\)[\s\S]*?\n {2}\}/.exec(cartJs);
assert(reasonFn, "checkoutFailureReason exists");
if (reasonFn) {
  assert(
    reasonFn[0].indexOf("shopperMessage") === -1 && reasonFn[0].indexOf("data.error") === -1,
    "the failure reason is never the server's own message -- it can quote what the shopper typed"
  );
}

/* --------------------------------------------------------------- summary */

console.log(`\nanalytics.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
