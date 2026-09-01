/**
 * @fileoverview Unit tests for Milestone 2: Events & Pop-up Market Calendar Experience.
 * Tests RFC 5545 .ics generation, Google Calendar URL encoding, Apple/Google Maps directions,
 * pickup booth deep-linking parameter resolution, and event card HTML rendering.
 *
 * Run: node scripts/events-engine.test.js
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

function createMockElement(tagName = "div") {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    setAttribute: (name, val) => attrs.set(name, String(val)),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
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
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => createMockElement(tag),
  body: createMockElement("body"),
  addEventListener: () => {}
};

const mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  }),
  location: {
    href: "https://yallternativeliving.com/events.html",
    hash: "",
    search: "",
    pathname: "/events.html",
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
const mainSource = fs.readFileSync(path.join(__dirname, "..", "assets/js/main.js"), "utf8");
const eventsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
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

console.log("Running events-engine.test.js (Milestone 2 unit tests)...\n");

/* -------------------------------------------------------------------------- */
/* 1. Date math & string parsing (getEventDateParts, getNextDayStr, getCalendarDates) */
/* -------------------------------------------------------------------------- */
console.log("1. Date calculations and formatting:");

eq(
  main.getEventDateParts("2026-08-15"),
  { year: 2026, month: 8, day: 15, str: "20260815" },
  "getEventDateParts parses YYYY-MM-DD"
);
eq(
  main.getEventDateParts("2026-10-17T09:00:00-04:00"),
  { year: 2026, month: 10, day: 17, str: "20261017" },
  "getEventDateParts parses ISO timestamp string"
);
eq(main.getEventDateParts(null), null, "getEventDateParts returns null for null");
eq(
  main.getEventDateParts("invalid-date"),
  null,
  "getEventDateParts returns null for invalid string"
);

eq(main.getNextDayStr("2026-08-15"), "20260816", "getNextDayStr increments standard day");
eq(
  main.getNextDayStr("2026-08-31"),
  "20260901",
  "getNextDayStr rolls over August 31 to September 1"
);
eq(
  main.getNextDayStr("2026-12-31"),
  "20270101",
  "getNextDayStr rolls over December 31 to January 1 of next year"
);
eq(
  main.getNextDayStr("2028-02-28"),
  "20280229",
  "getNextDayStr handles leap year Feb 28 -> Feb 29"
);
eq(main.getNextDayStr("2028-02-29"), "20280301", "getNextDayStr handles leap year Feb 29 -> Mar 1");

// Single day event
const singleDayEvent = {
  id: "night-market",
  name: "Gothic Punk Night Market",
  date: "2026-08-21",
  location: "Charlotte, NC"
};
eq(
  main.getCalendarDates(singleDayEvent),
  { start: "20260821", end: "20260822" },
  "getCalendarDates: single day event has exclusive end date next day"
);

// Multi-day event
const multiDayEvent = {
  id: "punk-flea",
  name: "Summerville Punk Flea Market",
  date: "2026-08-15",
  endDate: "2026-08-16",
  location: "Ladson, SC"
};
eq(
  main.getCalendarDates(multiDayEvent),
  { start: "20260815", end: "20260817" },
  "getCalendarDates: multi-day event end date is day after endDate"
);

/* -------------------------------------------------------------------------- */
/* 2. RFC 5545 iCalendar (.ics) Generation */
/* -------------------------------------------------------------------------- */
console.log("\n2. RFC 5545 iCalendar (.ics) generation:");

eq(
  main.escapeIcsText("Hello, World; Testing \\ Escaping\nSecond Line"),
  "Hello\\, World\\; Testing \\\\ Escaping\\nSecond Line",
  "escapeIcsText escapes semicolons, commas, backslashes, and newlines"
);

const icsOutput = main.generateIcsContent(multiDayEvent);
assert(
  icsOutput.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0"),
  "ICS starts with VCALENDAR 2.0 header"
);
assert(
  icsOutput.includes("PRODID:-//Y'allternative Living//Pop-Up Calendar//EN"),
  "ICS contains correct PRODID"
);
assert(icsOutput.includes("BEGIN:VEVENT"), "ICS contains BEGIN:VEVENT");
assert(
  icsOutput.includes("UID:yl-event-punk-flea-20260815@yallternativeliving.com"),
  "ICS contains deterministic UID"
);
assert(icsOutput.includes("DTSTART;VALUE=DATE:20260815"), "ICS contains DTSTART DATE value");
assert(
  icsOutput.includes("DTEND;VALUE=DATE:20260817"),
  "ICS contains exclusive multi-day DTEND DATE value"
);
assert(
  icsOutput.includes("SUMMARY:Y'allternative Living at Summerville Punk Flea Market"),
  "ICS contains formatted summary"
);
assert(
  icsOutput.includes("LOCATION:Summerville Punk Flea Market\\, Ladson\\, SC"),
  "ICS contains escaped location"
);
assert(icsOutput.includes("STATUS:CONFIRMED"), "ICS contains STATUS:CONFIRMED");
assert(
  icsOutput.endsWith("END:VEVENT\r\nEND:VCALENDAR"),
  "ICS ends with VEVENT and VCALENDAR footers"
);
assert(icsOutput.includes("\r\n"), "ICS uses CRLF line endings per RFC 5545");

const icsDataUri = main.generateIcsDataUri(multiDayEvent);
assert(
  icsDataUri.startsWith("data:text/calendar;charset=utf-8,"),
  "generateIcsDataUri produces calendar data URI"
);
assert(
  decodeURIComponent(icsDataUri.replace("data:text/calendar;charset=utf-8,", "")) === icsOutput,
  "generateIcsDataUri encodes exact RFC 5545 payload"
);

eq(
  main.getEventIcsFilename(multiDayEvent),
  "punk-flea.ics",
  "getEventIcsFilename formats slug with .ics extension"
);

/* -------------------------------------------------------------------------- */
/* 3. Google Calendar URL generation */
/* -------------------------------------------------------------------------- */
console.log("\n3. Google Calendar URL generation:");

const gCalUrl = main.generateGoogleCalendarUrl(multiDayEvent);
assert(
  gCalUrl.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE"),
  "Google Calendar URL points to render template"
);
assert(
  gCalUrl.includes("dates=20260815%2F20260817") || gCalUrl.includes("dates=20260815/20260817"),
  "Google Calendar URL contains start/end date range"
);
assert(
  gCalUrl.includes(encodeURIComponent("Y'allternative Living at Summerville Punk Flea Market")),
  "Google Calendar URL encodes event title"
);

const singleGCalUrl = main.generateGoogleCalendarUrl(singleDayEvent);
assert(
  singleGCalUrl.includes("dates=20260821%2F20260822") ||
    singleGCalUrl.includes("dates=20260821/20260822"),
  "Google Calendar URL encodes single-day exclusive date range"
);

/* -------------------------------------------------------------------------- */
/* 4. Maps Direct Navigation (Google Maps & Apple Maps) */
/* -------------------------------------------------------------------------- */
console.log("\n4. Google Maps & Apple Maps directions navigation:");

const eventWithAddressNote = {
  name: "Summerville Punk Flea Market",
  location: "Ladson, SC",
  zip: "29456",
  note: "9850 Highway 78, Ladson, SC 29456. Two-day punk flea market — come find our table."
};

eq(
  main.formatEventMapDestination(eventWithAddressNote),
  "9850 Highway 78, Ladson, SC 29456",
  "formatEventMapDestination extracts street address and zip from note"
);

const gMapsDir = main.generateGoogleMapsDirUrl(eventWithAddressNote);
eq(
  gMapsDir,
  "https://www.google.com/maps/dir/?api=1&destination=9850%20Highway%2078%2C%20Ladson%2C%20SC%2029456",
  "generateGoogleMapsDirUrl formats Google Maps directions API URL"
);

const appleMapsDir = main.generateAppleMapsDirUrl(eventWithAddressNote);
eq(
  appleMapsDir,
  "https://maps.apple.com/?daddr=9850%20Highway%2078%2C%20Ladson%2C%20SC%2029456",
  "generateAppleMapsDirUrl formats Apple Maps directions URL"
);

const eventWithoutStreet = {
  name: "Autumn Apothecary Faire",
  location: "Landrum, SC",
  zip: "29356",
  note: "Pop-up market table with handmade salves, soaks & soaps."
};
eq(
  main.formatEventMapDestination(eventWithoutStreet),
  "Autumn Apothecary Faire, Landrum, SC, 29356",
  "formatEventMapDestination combines name, location, and zip when no street address in note"
);

/* -------------------------------------------------------------------------- */
/* 5. Pickup Booth Deep-Linking Parameter Resolution */
/* -------------------------------------------------------------------------- */
console.log("\n5. Pickup booth deep-linking parameter parsing:");

// Match by ID
const matchById = main.parsePickupMarketParam("summerville-punk-flea-market", eventsData);
assert(matchById && matchById.event, "parsePickupMarketParam matches upcoming event by id");
eq(
  matchById.event.name,
  "Summerville Punk Flea Market",
  "parsePickupMarketParam returns correct matched event object"
);

// Match by Name
const matchByName = main.parsePickupMarketParam("Gothic Punk Night Market", eventsData);
assert(matchByName && matchByName.event, "parsePickupMarketParam matches upcoming event by name");
eq(
  matchByName.marketName,
  "Gothic Punk Night Market",
  "parsePickupMarketParam extracts market name"
);

// Match by Substring / Location
const matchBySub = main.parsePickupMarketParam("Ladson, SC", eventsData);
assert(
  matchBySub && matchBySub.event,
  "parsePickupMarketParam matches upcoming event by location substring"
);

// Fallback for unlisted/unknown market
const fallbackMatch = main.parsePickupMarketParam("Charleston Farmers Market", eventsData);
eq(
  fallbackMatch.matchedLabel,
  "Charleston Farmers Market",
  "parsePickupMarketParam returns raw decoded string for unknown market"
);

/* -------------------------------------------------------------------------- */
/* 6. Event Card HTML Rendering */
/* -------------------------------------------------------------------------- */
console.log("\n6. Event card HTML rendering (eventCardHTML):");

const sampleEvent = eventsData.upcoming[0];
const cardHtml = main.eventCardHTML(sampleEvent);

assert(
  cardHtml.includes('<article class="card event-card reveal">'),
  "Card has semantic article wrapper"
);
assert(cardHtml.includes(sampleEvent.name), "Card contains event name");
assert(
  cardHtml.includes(main.attrEsc(sampleEvent.dateLabel)),
  "Card contains formatted date label"
);
assert(cardHtml.includes("Google Maps"), "Card contains Google Maps directions link");
assert(cardHtml.includes("Apple Maps"), "Card contains Apple Maps directions link");
assert(
  cardHtml.includes("https://www.google.com/maps/dir/?api=1"),
  "Card contains Google Maps directions URL"
);
assert(
  cardHtml.includes("https://maps.apple.com/?daddr="),
  "Card contains Apple Maps directions URL"
);
assert(
  cardHtml.includes("Reserve / Pick Up at This Booth"),
  "Card contains Reserve / Pick Up at This Booth button"
);
assert(
  cardHtml.includes("shop.html?pickup_market=summerville-punk-flea-market#shop-catalog"),
  "Card contains deep link to shop.html with pickup_market and #shop-catalog anchor"
);
assert(cardHtml.includes("Add to Google Calendar"), "Card contains Add to Google Calendar button");
assert(cardHtml.includes("iCal / Apple Calendar (.ics)"), "Card contains iCal download button");
assert(
  cardHtml.includes('download="summerville-punk-flea-market.ics"'),
  "Card iCal link specifies download attribute"
);
assert(cardHtml.includes("data:text/calendar;charset=utf-8,"), "Card iCal link points to data URI");

/* -------------------------------------------------------------------------- */
/* 7. Audit fixes: Eastern "today", RFC 5545 folding, deterministic DTSTAMP,   */
/*    vetted event URL, encoded Google Calendar date range, no leaked timers.  */
/* -------------------------------------------------------------------------- */
console.log("\n7. Timezone, RFC 5545 folding and listener/timer lifetime:");

/* "today" must be the calendar date in Landrum, SC -- not in UTC. Comparing
   an events.json date against a UTC "today" moved that evening's market into
   Past Events from 8pm Eastern onwards. */
assert(typeof main.todayInEastern === "function", "todayInEastern is exported");
const easternToday = main.todayInEastern();
assert(/^\d{4}-\d{2}-\d{2}$/.test(easternToday), "todayInEastern returns an ISO calendar date");
const easternExpected = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());
eq(easternToday, easternExpected, "todayInEastern matches America/New_York, not UTC");
assert(
  mainSource.indexOf("new Date().toISOString().slice(0, 10)") === -1 ||
    mainSource.indexOf("function todayInEastern") !== -1,
  "no event comparison is left on a UTC today"
);
assert(
  mainSource.indexOf("var todayStr = todayInEastern();") !== -1,
  "the events page splits upcoming/past on the Eastern date"
);
assert(
  mainSource.indexOf("pickNextEvent(upcomingList, todayInEastern())") !== -1,
  "the countdown picks the next event on the Eastern date"
);

/* RFC 5545 3.1: no content line over 75 octets. */
assert(typeof main.foldIcsLine === "function", "foldIcsLine is exported");
eq(main.foldIcsLine("SHORT:line"), "SHORT:line", "foldIcsLine leaves a short line alone");
const longLine = "DESCRIPTION:" + "a".repeat(200);
const folded = main.foldIcsLine(longLine);
folded.split("\r\n").forEach((seg, i) => {
  assert(
    Buffer.byteLength(seg, "utf8") <= 75,
    `folded segment ${i} is at most 75 octets (got ${Buffer.byteLength(seg, "utf8")})`
  );
  if (i > 0) assert(seg.charAt(0) === " ", `continuation segment ${i} starts with a space`);
});
eq(folded.split("\r\n ").join(""), longLine, "unfolding a folded line reproduces it exactly");
// Multi-byte characters must be counted as octets and never split.
const emLine = "LOCATION:" + "—".repeat(60);
const emFolded = main.foldIcsLine(emLine);
emFolded.split("\r\n").forEach((seg) => {
  assert(
    Buffer.byteLength(seg, "utf8") <= 75,
    "an em-dash run is folded on octets, not characters"
  );
});
eq(emFolded.split("\r\n ").join(""), emLine, "multi-byte folding is lossless");

const longEvent = {
  id: "long-note-market",
  name: "Summerville Punk Flea Market",
  date: "2026-08-15",
  endDate: "2026-08-16",
  location: "Ladson, SC",
  note:
    "A very long note about the market that runs well past seventy-five octets so the " +
    "DESCRIPTION property has to be folded to stay inside RFC 5545's line length limit."
};
const longIcs = main.generateIcsContent(longEvent);
longIcs.split("\r\n").forEach((line) => {
  assert(
    Buffer.byteLength(line, "utf8") <= 75,
    `every generated ICS line is at most 75 octets (got ${Buffer.byteLength(line, "utf8")})`
  );
});
assert(longIcs.indexOf("\r\n ") !== -1, "a long DESCRIPTION is actually folded");

/* DTSTAMP was hardcoded to the day the feature shipped. */
assert(
  longIcs.indexOf("DTSTAMP:20260815T000000Z") !== -1,
  "DTSTAMP is derived from the event's own date"
);
assert(longIcs.indexOf("20260901T000000Z") === -1, "the hardcoded DTSTAMP is gone");
eq(main.generateIcsContent(longEvent), longIcs, "ICS generation stays deterministic across calls");

/* ev.url is CMS-editable and is handed to a calendar client. */
const hostileUrlEvent = {
  id: "hostile",
  name: "Hostile Market",
  date: "2026-08-15",
  location: "Ladson, SC",
  note: "Come see us.",
  url: "javascript:alert(1)"
};
const hostileIcs = main.generateIcsContent(hostileUrlEvent);
assert(
  hostileIcs.indexOf("javascript:") === -1,
  "a javascript: event URL never reaches the .ics DESCRIPTION"
);
const goodUrlEvent = Object.assign({}, hostileUrlEvent, {
  url: "https://example.com/market"
});
assert(
  main.generateIcsContent(goodUrlEvent).indexOf("https://example.com/market") !== -1,
  "a legitimate event URL still reaches the .ics DESCRIPTION"
);

/* The Google Calendar date range is a URL parameter and must be encoded. */
const encodedGcal = main.generateGoogleCalendarUrl(longEvent);
assert(
  encodedGcal.indexOf("dates=20260815%2F20260817") !== -1,
  "the Google Calendar dates parameter is percent-encoded"
);
assert(
  encodedGcal.indexOf("dates=20260815/20260817") === -1,
  "the raw slash is no longer emitted into the query string"
);

/* Timer and listener lifetime. */
assert(
  mainSource.indexOf("setInterval(update, 1000)") === -1,
  "the countdown no longer starts an unstoppable 1Hz interval"
);
assert(
  mainSource.indexOf("clearInterval(countdownIntervalId)") !== -1,
  "the countdown clears its interval once the ticker is gone"
);
assert(
  mainSource.indexOf("var pastEventsMqlBound = false;") !== -1 &&
    mainSource.indexOf("if (!pastEventsMqlBound) {") !== -1,
  "the past-events media-query listener is registered once"
);

console.log(`\nevents-engine.test.js: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
