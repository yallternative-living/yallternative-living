/**
 * @fileoverview Empirical Adversarial Challenger Test Suite for Milestone 2.
 * Comprehensive fuzzing and stress testing for:
 * 1. RFC 5545 .ics generator (single day, multi-day, multi-month, leap days, Dec 31->Jan 1 rollovers)
 * 2. ICS text escaping (newlines, semicolons, commas, backslashes, emojis, HTML/XSS tags)
 * 3. Pickup market deep-linking (malicious query params, SQLi, XSS, prototype pollution, empty inputs)
 * 4. Google & Apple Maps directions URLs (malformed addresses, foreign characters, Unicode)
 *
 * Run: node scripts/m2-adversarial-challenger.test.js
 */

const fs = require("fs");
const path = require("path");

// Mock browser environment for Node.js test execution
const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const mockDocElements = new Map();

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  const eventListeners = new Map();
  let elementId = "";

  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    get id() {
      return elementId;
    },
    set id(val) {
      if (elementId && mockDocElements.get(elementId) === el) {
        mockDocElements.delete(elementId);
      }
      elementId = String(val);
      if (elementId) {
        mockDocElements.set(elementId, el);
      }
      attrs.set("id", String(val));
    },
    setAttribute: (name, val) => {
      attrs.set(name, String(val));
      if (name === "id") {
        el.id = val;
      }
    },
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => {
      attrs.delete(name);
      if (name === "id" && elementId) {
        mockDocElements.delete(elementId);
        elementId = "";
      }
    },
    hasAttribute: (name) => attrs.has(name),
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
    innerHTML: "",
    textContent: "",
    parentNode: null,
    children: children,
    options: [],
    selectedIndex: 0,
    checked: false,
    addEventListener: (evt, cb) => {
      if (!eventListeners.has(evt)) eventListeners.set(evt, []);
      eventListeners.get(evt).push(cb);
    },
    removeEventListener: (evt, cb) => {
      if (eventListeners.has(evt)) {
        const list = eventListeners.get(evt).filter((c) => c !== cb);
        eventListeners.set(evt, list);
      }
    },
    dispatchEvent: (event) => {
      const handlers = eventListeners.get(event.type) || [];
      handlers.forEach((h) => h(event));
      return true;
    },
    appendChild: (child) => {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    insertBefore: (newChild, refChild) => {
      newChild.parentNode = el;
      const idx = children.indexOf(refChild);
      if (idx !== -1) {
        children.splice(idx, 0, newChild);
      } else {
        children.push(newChild);
      }
      return newChild;
    },
    remove: () => {
      if (elementId && mockDocElements.get(elementId) === el) {
        mockDocElements.delete(elementId);
      }
      if (el.parentNode && el.parentNode.children) {
        const idx = el.parentNode.children.indexOf(el);
        if (idx !== -1) el.parentNode.children.splice(idx, 1);
      }
    },
    querySelector: (sel) => {
      if (sel && sel.startsWith("#")) {
        const id = sel.slice(1);
        if (elementId === id) return el;
        for (const c of children) {
          const res = c.querySelector ? c.querySelector(sel) : null;
          if (res) return res;
        }
        if (mockDocElements.has(id)) return mockDocElements.get(id);
      }
      return createMockElement("div");
    },
    querySelectorAll: () => [],
    scrollIntoView: () => {}
  };
  return el;
}

const mockDocument = {
  documentElement: createMockElement("html"),
  body: createMockElement("body"),
  getElementById: (id) => mockDocElements.get(id) || null,
  querySelector: (sel) => {
    if (sel && sel.startsWith("#")) {
      const id = sel.slice(1);
      return mockDocElements.get(id) || null;
    }
    return createMockElement("div");
  },
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  addEventListener: () => {}
};

// Setup root catalog element in body
const mockCatalog = createMockElement("section");
mockCatalog.id = "shop-catalog";
mockDocument.body.appendChild(mockCatalog);

const mockSelect = createMockElement("select");
mockSelect.id = "yl-cart-pickup-select";
mockSelect.options = [
  { value: "", text: "Choose a market..." },
  {
    value: "Summerville Punk Flea Market — Aug 15–16, 2026 (Ladson, SC)",
    text: "Summerville Punk Flea Market — Aug 15–16, 2026 (Ladson, SC)"
  },
  {
    value: "Gothic Punk Night Market — Aug 21, 2026 (Charlotte, NC)",
    text: "Gothic Punk Night Market — Aug 21, 2026 (Charlotte, NC)"
  }
];

const mockCheckbox = createMockElement("input");
mockCheckbox.id = "yl-cart-pickup-checkbox";

const mockContainer = createMockElement("div");
mockContainer.id = "yl-cart-pickup-select-container";

class MockEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
}
global.Event = MockEvent;

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  location: {
    href: "https://yallternativeliving.com/shop.html?pickup_market=summerville-punk-flea-market",
    search: "?pickup_market=summerville-punk-flea-market",
    hash: "#shop-catalog",
    pathname: "/shop.html",
    hostname: "yallternativeliving.com",
    origin: "https://yallternativeliving.com"
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const main = require("../assets/js/main.js");
const eventsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
);

let passed = 0;
let failed = 0;

function assert(condition, label, details) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}${details ? ` -> ${details}` : ""}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("================================================================================");
console.log("EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 2");
console.log("================================================================================\n");

/* ========================================================================== */
/* CATEGORY 1: Fuzz RFC 5545 .ics Generator & Date Rollover Calculations       */
/* ========================================================================== */
console.log("--- Category 1: Fuzz RFC 5545 .ics Generator & Date Rollovers ---");

// 1.1 Fuzzing getEventDateParts with invalid/malicious inputs
const invalidDateInputs = [
  null,
  undefined,
  "",
  "   ",
  "invalid",
  "2026/08/15",
  "08-15-2026",
  "2026-8-5",
  "not-a-date",
  12345678,
  {},
  [],
  "<script>alert(1)</script>",
  "2026-99-99",
  "NaN-NaN-NaN"
];

invalidDateInputs.forEach((input, idx) => {
  const res = main.getEventDateParts(input);
  assert(
    res === null || (typeof res === "object" && typeof res.str === "string"),
    `getEventDateParts fuzz input #${idx + 1} (${JSON.stringify(input)}) does not crash`
  );
});

// 1.2 Month rollovers across all 12 calendar months (30-day, 31-day, 28/29-day)
const monthRollovers = [
  { input: "2026-01-31", expected: "20260201", desc: "Jan 31 -> Feb 1 (31-day month)" },
  { input: "2026-02-28", expected: "20260301", desc: "Feb 28 -> Mar 1 (Non-leap year)" },
  { input: "2026-03-31", expected: "20260401", desc: "Mar 31 -> Apr 1 (31-day month)" },
  { input: "2026-04-30", expected: "20260501", desc: "Apr 30 -> May 1 (30-day month)" },
  { input: "2026-05-31", expected: "20260601", desc: "May 31 -> Jun 1 (31-day month)" },
  { input: "2026-06-30", expected: "20260701", desc: "Jun 30 -> Jul 1 (30-day month)" },
  { input: "2026-07-31", expected: "20260801", desc: "Jul 31 -> Aug 1 (31-day month)" },
  { input: "2026-08-31", expected: "20260901", desc: "Aug 31 -> Sep 1 (31-day month)" },
  { input: "2026-09-30", expected: "20261001", desc: "Sep 30 -> Oct 1 (30-day month)" },
  { input: "2026-10-31", expected: "20261101", desc: "Oct 31 -> Nov 1 (31-day month)" },
  { input: "2026-11-30", expected: "20261201", desc: "Nov 30 -> Dec 1 (30-day month)" },
  { input: "2026-12-31", expected: "20270101", desc: "Dec 31 -> Jan 1 (Year rollover boundary)" }
];

monthRollovers.forEach((tc) => {
  eq(main.getNextDayStr(tc.input), tc.expected, `getNextDayStr: ${tc.desc}`);
});

// 1.3 Leap year boundaries (2024, 2028, 2000, 1900, 2100)
const leapYearCases = [
  { input: "2024-02-28", expected: "20240229", desc: "2024 leap year Feb 28 -> Feb 29" },
  { input: "2024-02-29", expected: "20240301", desc: "2024 leap year Feb 29 -> Mar 01" },
  { input: "2028-02-28", expected: "20280229", desc: "2028 leap year Feb 28 -> Feb 29" },
  { input: "2028-02-29", expected: "20280301", desc: "2028 leap year Feb 29 -> Mar 01" },
  { input: "2000-02-28", expected: "20000229", desc: "2000 century leap year Feb 28 -> Feb 29" },
  { input: "2000-02-29", expected: "20000301", desc: "2000 century leap year Feb 29 -> Mar 01" },
  {
    input: "1900-02-28",
    expected: "19000301",
    desc: "1900 century non-leap year Feb 28 -> Mar 01"
  },
  { input: "2100-02-28", expected: "21000301", desc: "2100 century non-leap year Feb 28 -> Mar 01" }
];

leapYearCases.forEach((tc) => {
  eq(main.getNextDayStr(tc.input), tc.expected, `getNextDayStr: ${tc.desc}`);
});

// 1.4 Multi-day, Multi-month, and Year-crossing events in getCalendarDates & generateIcsContent
const complexDateEvents = [
  {
    name: "New Year's Eve Gothic Ball",
    date: "2026-12-31",
    endDate: "2027-01-02",
    location: "Asheville, NC",
    expectedStart: "20261231",
    expectedEnd: "20270103"
  },
  {
    name: "Late Summer Craft Fair",
    date: "2026-08-28",
    endDate: "2026-09-02",
    location: "Greenville, SC",
    expectedStart: "20260828",
    expectedEnd: "20260903"
  },
  {
    name: "Leap Weekend Festival",
    date: "2024-02-28",
    endDate: "2024-03-01",
    location: "Columbia, SC",
    expectedStart: "20240228",
    expectedEnd: "20240302"
  }
];

complexDateEvents.forEach((ev) => {
  const dates = main.getCalendarDates(ev);
  eq(dates.start, ev.expectedStart, `getCalendarDates start for ${ev.name}`);
  eq(dates.end, ev.expectedEnd, `getCalendarDates exclusive end for ${ev.name}`);

  const ics = main.generateIcsContent(ev);
  assert(
    ics.includes(`DTSTART;VALUE=DATE:${ev.expectedStart}`),
    `ICS contains DTSTART ${ev.expectedStart}`
  );
  assert(
    ics.includes(`DTEND;VALUE=DATE:${ev.expectedEnd}`),
    `ICS contains DTEND ${ev.expectedEnd}`
  );
  assert(ics.includes("\r\n"), `ICS uses strict CRLF formatting`);
});

// 1.5 Structural RFC 5545 conformance stress test
const rfcSample = main.generateIcsContent(complexDateEvents[0]);
const requiredRfcLines = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Y'allternative Living//Pop-Up Calendar//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "BEGIN:VEVENT",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "END:VCALENDAR"
];

requiredRfcLines.forEach((reqLine) => {
  assert(rfcSample.includes(reqLine), `RFC 5545 required structure includes: ${reqLine}`);
});

/* ========================================================================== */
/* CATEGORY 2: ICS Text Escaping with Adversarial Inputs                       */
/* ========================================================================== */
console.log("\n--- Category 2: ICS Text Escaping with Adversarial Inputs ---");

// 2.1 RFC 5545 Section 3.3.11 character escaping
eq(
  main.escapeIcsText("Line 1\nLine 2\r\nLine 3"),
  "Line 1\\nLine 2\\nLine 3",
  "escapeIcsText converts all newlines (\\n, \\r\\n) to \\n"
);
eq(
  main.escapeIcsText("Semi;Colon,Comma\\Backslash"),
  "Semi\\;Colon\\,Comma\\\\Backslash",
  "escapeIcsText escapes semicolons, commas, and backslashes"
);
eq(
  main.escapeIcsText("Complex: a;b,c\\d\n1;2,3\\4"),
  "Complex: a\\;b\\,c\\\\d\\n1\\;2\\,3\\\\4",
  "escapeIcsText correctly handles interleaved delimiters and newlines"
);

// 2.2 Unicode and Emojis preservation
const emojiText = "Y'allternative Living 🦇 Salves & Soaks 🖤🌿✨ 100% Queer-Owned 🏳️‍🌈";
eq(
  main.escapeIcsText(emojiText),
  "Y'allternative Living 🦇 Salves & Soaks 🖤🌿✨ 100% Queer-Owned 🏳️‍🌈",
  "escapeIcsText preserves multi-byte emojis and UTF-8 symbols"
);

// 2.3 XSS, HTML tags, and Quote characters in ICS fields
const xssEvent = {
  id: "xss-market",
  name: '<script>alert("XSS")</script>;DROP TABLE events;',
  date: "2026-08-15",
  location: 'Downtown "Art" Walk, <img src=x onerror=alert(1)>',
  note: "Handmade items \\ \"quotes\" & 'single quotes'\nLine 2 <style>body{color:red}</style>"
};

/* RFC 5545 3.1 folds any content line over 75 octets with CRLF + a single
   space, so the escaped values these assertions look for are now split across
   physical lines. Unfold before matching -- what matters here is the escaping,
   which the folding must not disturb. */
function unfoldIcs(ics) {
  return String(ics).split("\r\n ").join("");
}

const xssIcsRaw = main.generateIcsContent(xssEvent);
xssIcsRaw.split("\r\n").forEach((line) => {
  assert(
    Buffer.byteLength(line, "utf8") <= 75,
    "every ICS content line stays within RFC 5545's 75-octet limit"
  );
});
const xssIcs = unfoldIcs(xssIcsRaw);
assert(
  xssIcs.includes(
    'SUMMARY:Y\'allternative Living at <script>alert("XSS")</script>\\;DROP TABLE events\\;'
  ),
  "ICS escapes semicolons in summary containing HTML/script tags"
);
assert(
  xssIcs.includes(
    'LOCATION:<script>alert("XSS")</script>\\;DROP TABLE events\\;\\, Downtown "Art" Walk\\, <img src=x onerror=alert(1)>'
  ),
  "ICS escapes commas and semicolons in location containing HTML img tag"
);
assert(
  xssIcs.includes(
    "DESCRIPTION:Handmade items \\\\ \"quotes\" & 'single quotes'\\nLine 2 <style>body{color:red}</style>"
  ),
  "ICS escapes backslashes and newlines in description containing HTML style tags"
);

// 2.4 Fuzzing escapeIcsText with non-string inputs
eq(main.escapeIcsText(null), "", "escapeIcsText handles null");
eq(main.escapeIcsText(undefined), "", "escapeIcsText handles undefined");
eq(main.escapeIcsText(""), "", "escapeIcsText handles empty string");
eq(main.escapeIcsText(12345), "12345", "escapeIcsText handles numbers");
eq(main.escapeIcsText(false), "", "escapeIcsText falsy boolean returns empty string");

/* ========================================================================== */
/* CATEGORY 3: Deep-Link Parameter Parsing & XSS / Injection Resilience        */
/* ========================================================================== */
console.log("\n--- Category 3: Deep-Link Parameter Parsing & Injection Resilience ---");

// 3.1 Legitimate lookups by ID, full name, location substring
const testUpcoming = eventsData.upcoming;
assert(testUpcoming.length > 0, "eventsData has upcoming events");

testUpcoming.forEach((ev) => {
  // Test by ID
  const byId = main.parsePickupMarketParam(ev.id, eventsData);
  assert(
    byId && byId.event && byId.event.id === ev.id,
    `parsePickupMarketParam resolves ID '${ev.id}'`
  );

  // Test by exact Name
  const byName = main.parsePickupMarketParam(ev.name, eventsData);
  assert(
    byName && byName.event && byName.event.name === ev.name,
    `parsePickupMarketParam resolves Name '${ev.name}'`
  );
});

// 3.2 Malicious and adversarial query inputs
const adversarialParams = [
  { input: "' OR '1'='1", desc: "Classic SQL injection string" },
  { input: "'; DROP TABLE events; --", desc: "Destructive SQL injection" },
  { input: "<script>alert('xss')</script>", desc: "XSS script payload" },
  { input: '"><img src=x onerror=alert(1)>', desc: "Attribute breakout XSS payload" },
  { input: "javascript:alert(document.cookie)", desc: "Pseudo-protocol URL payload" },
  { input: "__proto__", desc: "Prototype pollution key __proto__" },
  { input: "constructor", desc: "Prototype pollution key constructor" },
  { input: "prototype", desc: "Prototype pollution key prototype" },
  { input: "toString", desc: "Built-in method collision toString" },
  { input: "valueOf", desc: "Built-in method collision valueOf" },
  { input: "../../../../etc/passwd", desc: "Directory traversal payload" },
  { input: "%00", desc: "Null byte injection" },
  { input: "unknown-market-slug-9999", desc: "Non-existent market slug" }
];

adversarialParams.forEach((tc) => {
  // An unknown market is ignored (null), never echoed back as a "market":
  // the old fallback object let a past or invented slug tick the pickup box
  // and promise free pickup at a booth the Worker would never honour.
  let result;
  let threw = null;
  try {
    result = main.parsePickupMarketParam(tc.input, eventsData);
  } catch (e) {
    threw = e;
  }
  assert(threw === null, `parsePickupMarketParam does not throw for ${tc.desc}`);
  assert(result === null, `parsePickupMarketParam ignores an unknown market for ${tc.desc}`);
  assert(
    !Object.prototype.hasOwnProperty.call(Object.prototype, "marketName"),
    `Global prototype was not polluted by ${tc.desc}`
  );
});

// Test null/empty inputs
assert(main.parsePickupMarketParam(null, eventsData) === null, "parsePickupMarketParam null input");
assert(
  main.parsePickupMarketParam(undefined, eventsData) === null,
  "parsePickupMarketParam undefined input"
);
assert(main.parsePickupMarketParam("", eventsData) === null, "parsePickupMarketParam empty string");

// 3.3 DOM Deep-Link Hydration & XSS banner injection test
mockWindow.location.search = "?pickup_market=%3Cscript%3Ealert(%22XSS%22)%3C%2Fscript%3E";
main.handlePickupMarketDeepLink();
assert(
  mockDocument.getElementById("pickupMarketBanner") === null,
  "handlePickupMarketDeepLink injects nothing for a market that is not on the calendar"
);

// A real upcoming market does hydrate the banner. The deep link reads the
// calendar from window.YL_EVENTS, the way events-data.js publishes it.
mockWindow.YL_EVENTS = eventsData;
const upcomingForBanner = eventsData.upcoming[0];
assert(upcomingForBanner && upcomingForBanner.id, "fixture has an upcoming event to deep-link to");
mockWindow.location.search = "?pickup_market=" + encodeURIComponent(upcomingForBanner.id);
main.handlePickupMarketDeepLink();

const banner = mockDocument.getElementById("pickupMarketBanner");
assert(banner !== null, "handlePickupMarketDeepLink injected pickupMarketBanner element");
assert(
  banner.getAttribute("role") === "status",
  "pickupMarketBanner has role='status' for accessibility"
);
assert(banner.getAttribute("aria-live") === "polite", "pickupMarketBanner has aria-live='polite'");
assert(
  banner.innerHTML.includes(
    main.attrEsc ? main.attrEsc(upcomingForBanner.name) : upcomingForBanner.name
  ) && !banner.innerHTML.includes("<script"),
  "pickupMarketBanner names the matched market and carries no script markup"
);

// Clean up banner
if (banner) banner.remove();

/* ========================================================================== */
/* CATEGORY 4: Google & Apple Maps Directions Formatting & Unicode Robustness  */
/* ========================================================================== */
console.log("\n--- Category 4: Google & Apple Maps Directions Formatting & Unicode ---");

// 4.1 Address extraction heuristics
const addressCases = [
  {
    event: {
      name: "Summerville Punk Flea Market",
      location: "Ladson, SC",
      zip: "29456",
      note: "9850 Highway 78, Ladson, SC 29456. Two-day punk flea market."
    },
    expected: "9850 Highway 78, Ladson, SC 29456",
    desc: "Street address note with matching zip"
  },
  {
    event: {
      name: "Fall Festival",
      location: "Landrum, SC",
      zip: "29356",
      note: "Come visit our outdoor booth at the town square!"
    },
    expected: "Fall Festival, Landrum, SC, 29356",
    desc: "Note without street address falls back to Name + Location + Zip"
  },
  {
    event: {
      name: "Gothic Night Market",
      location: "Charlotte, NC 28202"
    },
    expected: "Gothic Night Market, Charlotte, NC 28202",
    desc: "No note, zip already in location string"
  },
  {
    event: null,
    expected: "Landrum, SC",
    desc: "Null event defaults to Landrum, SC"
  }
];

addressCases.forEach((tc) => {
  eq(
    main.formatEventMapDestination(tc.event),
    tc.expected,
    `formatEventMapDestination: ${tc.desc}`
  );
});

// 4.2 Foreign Characters & Unicode Addresses in Maps URLs
const foreignEvents = [
  {
    name: "Münchener Kunsthandwerkermarkt",
    location: "München, Deutschland",
    zip: "80331",
    note: "Marienplatz 8, 80331 München. Handgemachte Seifen."
  },
  {
    name: "Marché Artisanal de Paris",
    location: "Paris, France",
    zip: "75004",
    note: "8 Rue de l'Hôtel de Ville, 75004 Paris. Soins naturels."
  },
  {
    name: "東京ハンドメイドフェスタ 🌸",
    location: "東京都千代田区",
    zip: "100-0001",
    note: "千代田1-1 100-0001 東京都. ナチュラルコスメ"
  }
];

foreignEvents.forEach((fe) => {
  const gUrl = main.generateGoogleMapsDirUrl(fe);
  const aUrl = main.generateAppleMapsDirUrl(fe);

  assert(
    gUrl.startsWith("https://www.google.com/maps/dir/?api=1&destination="),
    `Google Maps URL format valid for ${fe.name}`
  );
  assert(
    aUrl.startsWith("https://maps.apple.com/?daddr="),
    `Apple Maps URL format valid for ${fe.name}`
  );

  // Validate URL is well-formed according to WHATWG URL standard
  let gUrlParsed, aUrlParsed;
  try {
    gUrlParsed = new URL(gUrl);
    aUrlParsed = new URL(aUrl);
  } catch (e) {
    gUrlParsed = null;
    aUrlParsed = null;
  }
  assert(gUrlParsed !== null, `Google Maps URL parsed cleanly for ${fe.name}`);
  assert(aUrlParsed !== null, `Apple Maps URL parsed cleanly for ${fe.name}`);
});

// 4.3 Malformed characters in directions URLs (#, ?, &, quotes, angle brackets)
const weirdEventWithZip = {
  name: 'Odd <Market> & "Faire" #1',
  location: "Greenville / Spartanburg, SC",
  zip: "29301",
  note: '123 Main St #4B & Suite "C", Spartanburg, SC 29301. Enter back door!'
};

const gWeirdWithZip = main.generateGoogleMapsDirUrl(weirdEventWithZip);
const aWeirdWithZip = main.generateAppleMapsDirUrl(weirdEventWithZip);

assert(
  gWeirdWithZip.includes(
    "destination=123%20Main%20St%20%234B%20%26%20Suite%20%22C%22%2C%20Spartanburg%2C%20SC%2029301"
  ),
  "Google Maps properly extracts and encodes #, &, and quotes from note"
);
assert(
  aWeirdWithZip.includes(
    "daddr=123%20Main%20St%20%234B%20%26%20Suite%20%22C%22%2C%20Spartanburg%2C%20SC%2029301"
  ),
  "Apple Maps properly extracts and encodes #, &, and quotes from note"
);

const weirdEventFallback = {
  name: 'Odd <Market> & "Faire" #1',
  location: "Spartanburg, SC <Special> ? 100%"
};

const gWeirdFallback = main.generateGoogleMapsDirUrl(weirdEventFallback);
const aWeirdFallback = main.generateAppleMapsDirUrl(weirdEventFallback);

assert(
  gWeirdFallback.includes(
    "destination=Odd%20%3CMarket%3E%20%26%20%22Faire%22%20%231%2C%20Spartanburg%2C%20SC%20%3CSpecial%3E%20%3F%20100%25"
  ),
  "Google Maps properly encodes angle brackets, percent, quotes, and question mark in fallback"
);
assert(
  aWeirdFallback.includes(
    "daddr=Odd%20%3CMarket%3E%20%26%20%22Faire%22%20%231%2C%20Spartanburg%2C%20SC%20%3CSpecial%3E%20%3F%20100%25"
  ),
  "Apple Maps properly encodes angle brackets, percent, quotes, and question mark in fallback"
);

console.log("\n================================================================================");
console.log(`Empirical Adversarial Challenger Suite: ${passed} passed, ${failed} failed.`);
console.log("================================================================================");

process.exit(failed ? 1 : 0);
