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
 *  2b. THE TWO ROUTES. The page loads assets/js/porch-light.js, which injects
 *     the tracker from cloud.umami.is first and falls back to the first-party
 *     /porch-light/script.js only when that fails. Both routes have to work, so
 *     four files have to agree: the loader, the tag the build emits, the proxy
 *     rules in netlify.toml/vercel.json, and the CSP. A disagreement is silent
 *     in the worst way -- the fallback route quietly 404s, or the direct route
 *     is quietly blocked and EVERY visitor is demoted to the proxy, where their
 *     session id and country become Netlify's. So the pieces are compared
 *     against each other here rather than each being checked alone.
 *
 *  3. THE EVENTS. Every event this site sends, its exact property keys, and --
 *     the point of the whole file -- that not one of them carries personal
 *     data. An assertion here that stops examining anything is worse than no
 *     assertion, so every check below asserts its subject exists first.
 */

const fs = require("fs");
const path = require("path");
const {
  ANALYTICS_LOADER_PATH,
  ANALYTICS_SCRIPT_PATH,
  ANALYTICS_HOST_URL,
  ANALYTICS_SEND_PATH,
  UMAMI_SCRIPT_ORIGIN,
  UMAMI_SEND_ORIGIN,
  UMAMI_SCRIPT_URL,
  UMAMI_SEND_URL,
  FALLBACK_TAG,
  BLOCKLIST_BAIT_WORDS
} = require("./lib/analytics-proxy");

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
/* The shop's own landing filters come back: their values are a fixed
   vocabulary from the site's own nav, so they cannot carry anything a shopper
   typed, and without them every filtered landing collapses into one /shop row
   that says nothing about what people arrived looking for. */
eq(
  allowed("?category=apparel&concern=all"),
  "?category=apparel&concern=all",
  "the shop's own landing filters survive"
);
eq(
  allowed("?category=apparel&session_id=cs_live_deadbeefcafe"),
  "?category=apparel",
  "a filter next to an order token keeps the filter and drops the token"
);
eq(allowed("?subscribed=1"), "", "the newsletter return flag is dropped");
/* Owner decision 2026-09-02: the six click ids Umami's Attribution report
   reads automatically come back. fbclid in particular is appended by Facebook
   and Instagram to ORDINARY organic links, so dropping it was throwing away
   the attribution for this shop's biggest referrer. They do not fragment the
   Pages report -- Umami stores url_path and url_query in separate columns
   (umami-software/umami src/app/api/send/route.ts). They are the one thing on
   the allow-list that is per-click random, which is why the privacy page names
   them; nothing here ever calls umami.identify(), so they are never joined to
   a person. */
eq(
  allowed("?gclid=abc123&fbclid=xyz789"),
  "?gclid=abc123&fbclid=xyz789",
  "the ad-click ids Umami reads for Attribution survive"
);
eq(
  allowed("?msclkid=m1&ttclid=t1&li_fat_id=l1&twclid=w1"),
  "?msclkid=m1&ttclid=t1&li_fat_id=l1&twclid=w1",
  "...and so do the other four"
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
  /* The page references OUR loader, never a tracker directly. data-host-url is
     deliberately absent here: the loader adds it to the fallback copy only, so
     the direct copy posts to gateway.umami.is with the visitor's real IP. */
  'src="' + ANALYTICS_LOADER_PATH + '"',
  'data-website-id="' + websiteId + '"',
  'data-domains="yallternativeliving.com,www.yallternativeliving.com"',
  'data-exclude-search="true"',
  'data-exclude-hash="true"',
  /* Core Web Vitals from real visitors (tracker v3.1.0+). Costs one extra
     event per page load against the free tier's 100K/month -- see
     docs/ANALYTICS.md before turning it off to save quota. */
  'data-performance="true"',
  'data-before-send="ylAnalyticsBeforeSend"'
];

let taggedPages = 0;
const tagRe = new RegExp(
  '<script[^>]*src="' + ANALYTICS_LOADER_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>'
);
TRACKED.forEach((page) => {
  const src = read(page);
  const tag = tagRe.exec(src);
  if (!tag) {
    failed++;
    console.error(`  ✗ ${page} carries the analytics tracker tag`);
    return;
  }
  taggedPages++;
  REQUIRED_TAG_ATTRS.forEach((attr) => {
    assert(tag[0].indexOf(attr) !== -1, `${page} tracker tag carries ${attr.split("=")[0]}`);
  });
  /* data-do-not-track must stay OFF. Umami only consults the browser's Do Not
     Track header when this attribute is literally "true"; the owner's call
     (2026-09-02) is not to, because the browsers that shipped DNT retired it
     and it is not a consent signal for cookieless counting that stores nothing
     about a person. The privacy page says so in as many words -- if this
     assertion is ever flipped, that page has to be flipped with it. */
  assert(
    tag[0].indexOf("data-do-not-track") === -1,
    `${page} tracker tag does not set data-do-not-track (see privacy.html)`
  );
  assert(
    tag[0].indexOf("data-host-url") === -1,
    `${page} tracker tag sets no data-host-url -- the direct route must post to Umami itself`
  );
  assert(
    tag[0].indexOf("data-tag") === -1,
    `${page} tracker tag sets no data-tag -- "${FALLBACK_TAG}" belongs to the fallback copy only`
  );
  /* No page may NAME a Umami host in its own markup. Both routes are chosen at
     runtime by the loader, so a hardcoded tracker URL in a page is either a
     stale hand-edit or a second copy of the tracker. Comments and the privacy
     page's link to umami.is/privacy are fine, so comments are stripped first. */
  const markup = src.replace(/<!--[\s\S]*?-->/g, "");
  assert(
    markup.indexOf("cloud.umami.is") === -1 && markup.indexOf("gateway.umami.is") === -1,
    `${page} hardcodes no Umami host -- the loader picks the route at runtime`
  );
});
eq(taggedPages, TRACKED.length, "every tracked page actually has the tag");

assert(
  read("offline.html").indexOf(ANALYTICS_LOADER_PATH) === -1 &&
    read("offline.html").indexOf("umami.is") === -1,
  "offline.html loads no tracker -- it is the page you see with no network"
);

/* The ordering bug, pinned. A deferred tag after main.js means window.umami
   does not exist when main.js fires its load-time events. */
PDPS.concat(["index.html", "shop.html"]).forEach((page) => {
  const src = read(page);
  const tagAt = src.indexOf(ANALYTICS_LOADER_PATH);
  const mainAt = src.indexOf("assets/js/main.js");
  assert(tagAt !== -1 && mainAt !== -1, `${page} has both the analytics loader and main.js`);
  assert(
    tagAt < mainAt,
    `${page} runs the analytics loader BEFORE main.js, so the tracker request is already in flight`
  );
});

/* ------------------------------- 2b. the loader, and the two routes it picks */

/* The loader is the only analytics file the pages reference, so it is the one
   place both routes are actually decided. Everything asserted about it here was
   wrong in an earlier draft of this change and would have failed silently:
   loading both copies would double-count every visitor, loading the fallback
   first would throw away everyone's real IP, and forgetting the hostname gate
   would put the Puppeteer suites back in the production dataset. */
const loaderJs = read(ANALYTICS_LOADER_PATH.replace(/^\//, ""));

assert(loaderJs.indexOf(UMAMI_SCRIPT_URL) !== -1, "the loader knows the direct tracker URL");
assert(loaderJs.indexOf(ANALYTICS_SCRIPT_PATH) !== -1, "...and the first-party fallback path");
/* Direct FIRST. If the fallback were injected first, every visitor would be
   measured through the proxy and nobody's country or session id would be their
   own -- the exact cost this arrangement exists to avoid. */
assert(
  loaderJs.indexOf(UMAMI_SCRIPT_URL) < loaderJs.indexOf(ANALYTICS_SCRIPT_PATH),
  "the loader declares the DIRECT route before the fallback"
);
/* One copy, ever. Two would double every pageview and every event. */
assert(
  /var settled = false/.test(loaderJs) && /if \(settled\) return/.test(loaderJs),
  "the loader guards against injecting both copies"
);
/* The fallback is reached from the direct script's error event -- not a timer.
   A blocker cancels the request and a filtering resolver fails it; both fire
   error and neither fires load. */
assert(
  /addEventListener\("error"/.test(loaderJs),
  "the fallback is triggered by the direct script's error event"
);
/* data-host-url and data-tag go on the fallback copy ONLY. */
assert(
  loaderJs.indexOf('setAttribute("data-host-url", FALLBACK_HOST_URL)') !== -1,
  "the loader sets data-host-url on the fallback copy"
);
assert(
  loaderJs.indexOf('setAttribute("data-tag", FALLBACK_TAG)') !== -1,
  `the loader tags fallback sessions, so the dashboard can separate them`
);
assert(
  loaderJs.indexOf('var FALLBACK_TAG = "' + FALLBACK_TAG + '"') !== -1,
  `the loader's fallback tag is "${FALLBACK_TAG}", the value docs/ANALYTICS.md tells the owner to filter on`
);
/* Hostname gate BEFORE either request. Umami's own data-domains check disables
   the tracker after it has loaded; this stops localhost, 127.0.0.1 and
   *.netlify.app requesting it at all. */
assert(
  loaderJs.indexOf('getAttribute("data-domains")') !== -1 &&
    loaderJs.indexOf("domains.indexOf(host) === -1") !== -1,
  "the loader refuses to inject anything on a hostname outside data-domains"
);
assert(
  loaderJs.indexOf("domains.indexOf(host) === -1") < loaderJs.indexOf("function injectDirect"),
  "...and it does that check before either injection function runs"
);
/* Every data-* attribute is copied, rather than a hand-listed subset that a
   new attribute could silently fall out of. */
assert(
  /name\.indexOf\("data-"\) === 0/.test(loaderJs),
  "the loader copies every data-* attribute onto whichever copy it injects"
);
/* It must never grow tracking of its own. */
assert(
  loaderJs.indexOf("fetch(") === -1 && loaderJs.indexOf("XMLHttpRequest") === -1,
  "the loader sends nothing itself -- it only injects a script"
);

/* --------------------------------------------- 2c. the first-party fallback */

/* The paths must not carry a word a blocker's generic path rules key on --
   moving the tracker to /analytics/script.js would be defeated by the same
   lists a day later. */
BLOCKLIST_BAIT_WORDS.forEach((word) => {
  assert(
    ANALYTICS_SCRIPT_PATH.indexOf(word) === -1 && ANALYTICS_SEND_PATH.indexOf(word) === -1,
    `the proxy paths avoid the blocker-bait word "${word}"`
  );
});

/* The tracker hardcodes `<data-host-url>/api/send` (read out of the live
   cloud.umami.is/script.js on 2026-09-02:
     `${(x||"https://gateway.umami.is").replace(/\/$/,"")}/api/send`),
   so this is the path the browser will actually POST to. If it and the rule
   below ever disagree, every event 404s and nothing says so. */
eq(ANALYTICS_SEND_PATH, ANALYTICS_HOST_URL + "/api/send", "the send path is host-url + /api/send");

/* Relative, so www. and the apex each send to their own origin. An absolute
   URL would make one of them a cross-origin POST, which connect-src 'self'
   refuses -- the same class of bug that made this dashboard read zero. */
assert(
  ANALYTICS_HOST_URL.charAt(0) === "/" && ANALYTICS_HOST_URL.indexOf("//") === -1,
  "data-host-url is a relative path, so both www. and the apex stay same-origin"
);

const netlifyToml = read("netlify.toml");
const vercelJson = JSON.parse(read("vercel.json"));

[
  [ANALYTICS_SCRIPT_PATH, UMAMI_SCRIPT_URL],
  [ANALYTICS_SEND_PATH, UMAMI_SEND_URL]
].forEach(([from, to]) => {
  const block = new RegExp(
    '\\[\\[redirects\\]\\]\\s*\\n\\s*from = "' +
      from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      '"\\s*\\n\\s*to = "' +
      to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      '"\\s*\\n\\s*status = 200\\s*\\n\\s*force = true'
  );
  assert(block.test(netlifyToml), `netlify.toml proxies ${from} to ${to} (status 200, forced)`);

  const rewrite = (vercelJson.rewrites || []).find((r) => r.source === from);
  assert(rewrite && rewrite.destination === to, `vercel.json rewrites ${from} to ${to}`);
});

/* Ordering, not just presence. The clean-URL 301s further down netlify.toml
   are generated from the page list; if a proxy rule ever ended up after them
   and one of them grew a wildcard, the tracker's POST would be redirected and
   analytics would stop with no error anywhere. */
assert(
  netlifyToml.indexOf('from = "' + ANALYTICS_SEND_PATH + '"') <
    netlifyToml.indexOf('from = "/shop"'),
  "the analytics proxy rules sit above the clean-URL redirects in netlify.toml"
);

/* And they are explicit paths, never a splat: a wildcard here would proxy
   arbitrary paths of this site through to Umami. */
assert(
  ANALYTICS_SCRIPT_PATH.indexOf("*") === -1 && ANALYTICS_SEND_PATH.indexOf("*") === -1,
  "the proxy rules are explicit paths, not splats"
);

/* ------------------------------------------------------------------ 3. CSP */

/* BOTH ROUTES, in both directives. The page cannot know in advance which one
   it will take, so a policy that allows only one does not "prefer" that one --
   it silently disables the other.

   Missing https://cloud.umami.is in script-src demotes EVERY visitor to the
   proxy, where their session id and country become Netlify's edge, and nothing
   in the dashboard says so. Missing https://gateway.umami.is in connect-src is
   worse and has already happened here: the direct script loads perfectly and
   the browser refuses every pageview and every event it sends, which is how
   this shop's dashboard read zero for weeks. Missing 'self' breaks the loader
   and the fallback together.

   So all four are asserted, per file, and none of them is optional. */
["_headers", "netlify.toml", "vercel.json"].forEach((file) => {
  const src = read(file);
  const connect = /connect-src ([^;"]*)/.exec(src);
  assert(connect, `${file} declares a connect-src`);
  if (!connect) return;
  assert(
    connect[1].indexOf(UMAMI_SEND_ORIGIN) !== -1,
    `${file} connect-src allows ${UMAMI_SEND_ORIGIN} -- where the DIRECT route POSTs`
  );
  assert(
    connect[1].indexOf("'self'") !== -1,
    `${file} connect-src allows 'self' -- where the FALLBACK route POSTs (${ANALYTICS_SEND_PATH})`
  );
  const scriptSrc = /script-src ([^;"]*)/.exec(src);
  assert(
    scriptSrc && scriptSrc[1].indexOf(UMAMI_SCRIPT_ORIGIN) !== -1,
    `${file} script-src allows ${UMAMI_SCRIPT_ORIGIN} -- the DIRECT tracker copy`
  );
  assert(
    scriptSrc && scriptSrc[1].indexOf("'self'") !== -1,
    `${file} script-src allows 'self' -- the loader and the FALLBACK tracker copy`
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
  "Shared Cart Opened": [cartJs, ["itemCount"]],
  "Gift Card Applied": [cartJs, []],
  "Checkout Start": [cartJs, ["itemCount", "subtotalCents", "isPickup"]],
  "Checkout Failed": [cartJs, ["reason"]],
  /* No properties, and that is the assertion. Revenue is booked once by the
     Stripe webhook ("Order Paid", workers/routes/stripe-webhook.js) off the
     amount Stripe actually captured; sending it from the browser as well would
     double-count every order whose shopper makes it back to the thank-you
     page, and would miss every order whose shopper does not. Purchase is the
     funnel's last step and nothing more. */
  Purchase: [thankYouJs, []]
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
  /function confirmOrder\(\)/.test(thankYouJs),
  "Purchase is sent from confirmOrder(), not from page load"
);
/* ...and it takes no amount any more, because it books no amount. A
   confirmOrder that still accepted the Worker's figure would be one edit away
   from double-counting every order against the server-side "Order Paid". */
assert(
  !/window\.plausible\("Purchase",/.test(thankYouJs),
  "the client Purchase event carries no properties -- revenue is the webhook's job"
);
/* No `revenue:` or `currency:` PROPERTY anywhere in the file. The prose
   comment explaining why is expected and welcome; a property key is not. */
assert(
  !/[{,]\s*(revenue|currency)\s*:/.test(thankYouJs),
  "thank-you.js builds no revenue/currency property at all"
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
