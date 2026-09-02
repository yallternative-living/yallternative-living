/* eslint-env node, browser */
/**
 * @fileoverview Empirical Adversarial Challenger Test Suite for Milestone 2.
 *
 * Executes full browser automation (Puppeteer & Playwright) and unit engine verification:
 * 1. DOM interactions on events.html & shop.html across Desktop, Tablet, and Mobile viewports.
 * 2. Calendar download triggers (.ics RFC 5545, MIME, filename, Google Calendar URLs, date math).
 * 3. Pickup selection synchronization between main.js and cart.js across page navigations.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { chromium, firefox, webkit } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
// Ephemeral port: this suite now runs inside run-integration-tests.js's worker
// pool alongside test-m2-ugc-strip.js, which owns the fixed port 8085.
const PORT = 0;

function createServer(port = PORT) {
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".avif": "image/avif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".xml": "application/xml"
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

let passed = 0;
let failed = 0;
const errors = [];

function check(desc, ok, extra = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ PASS: ${desc}`);
  } else {
    failed++;
    const msg = `  ✗ FAIL: ${desc} ${extra ? "— " + extra : ""}`;
    console.error(msg);
    errors.push(msg);
  }
}

// Setup Node mock environment before requiring main.js
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

const mainJs = require(path.join(ROOT, "assets/js/main.js"));

async function runAdversarialSuite() {
  console.log("================================================================================");
  console.log("STARTING EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 2");
  console.log("================================================================================\n");

  const server = await createServer(PORT);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const viewports = [
      { name: "Desktop", width: 1200, height: 800 },
      { name: "Tablet", width: 768, height: 1024 },
      { name: "Mobile", width: 375, height: 667 }
    ];

    // =========================================================================
    // CATEGORY 1: DOM INTERACTIONS ON events.html & shop.html ACROSS VIEWPORTS
    // =========================================================================
    console.log("--- CATEGORY 1: DOM INTERACTIONS ACROSS VIEWPORTS ---");

    for (const vp of viewports) {
      console.log(`\n  [Viewport: ${vp.name} (${vp.width}x${vp.height})]`);
      const page = await browser.newPage();
      await page.setViewport(vp);

      // 1.1 events.html
      await page.goto(`${baseUrl}/events.html`, { waitUntil: "networkidle0" });

      // Check event cards
      const eventCardsCount = await page.$$eval(".event-card", (cards) => cards.length);
      check(
        `[${vp.name}] events.html renders event cards`,
        eventCardsCount >= 1,
        `found ${eventCardsCount}`
      );

      // Check countdown banner
      const countdownExists = await page.$eval("#eventsCountdownBanner", (el) => !!el);
      check(
        `[${vp.name}] events.html displays countdown banner #eventsCountdownBanner`,
        countdownExists
      );

      // Check action buttons in each card
      const cardButtons = await page.$$eval(".event-card", (cards) => {
        return cards.map((card) => {
          const pickupBtn = card.querySelector('a[href*="pickup_market="]');
          const gcalBtn = card.querySelector('a[href*="calendar.google.com"]');
          const icsBtn = card.querySelector('a[download$=".ics"]');
          const gmapsLink = card.querySelector('a.event-map-link[href*="google.com/maps"]');
          const appleMapsLink = card.querySelector('a.event-map-link[href*="maps.apple.com"]');
          return {
            // Past markets are a record, not a call to action: no pickup,
            // calendar, RSVP or directions on those cards.
            isPast: !!card.closest("#pastEvents"),
            hasPickupBtn: !!pickupBtn,
            pickupHref: pickupBtn ? pickupBtn.getAttribute("href") : null,
            hasGcalBtn: !!gcalBtn,
            gcalHref: gcalBtn ? gcalBtn.getAttribute("href") : null,
            hasIcsBtn: !!icsBtn,
            icsHref: icsBtn ? icsBtn.getAttribute("href") : null,
            icsDownload: icsBtn ? icsBtn.getAttribute("download") : null,
            hasGmapsLink: !!gmapsLink,
            gmapsHref: gmapsLink ? gmapsLink.getAttribute("href") : null,
            hasAppleMapsLink: !!appleMapsLink,
            appleMapsHref: appleMapsLink ? appleMapsLink.getAttribute("href") : null
          };
        });
      });

      // Every `.every()` below is guarded by a count assertion: on an empty
      // array `.every()` returns true, so a page that renders no event cards
      // at all used to pass all four of these checks (audit "vacuous passes").
      const upcomingCards = cardButtons.filter((c) => !c.isPast);
      const pastCards = cardButtons.filter((c) => c.isPast);
      check(
        `[${vp.name}] Past event cards carry no pickup, calendar or directions actions`,
        pastCards.length >= 1 &&
          pastCards.every(
            (c) =>
              !c.hasPickupBtn &&
              !c.hasGcalBtn &&
              !c.hasIcsBtn &&
              !c.hasGmapsLink &&
              !c.hasAppleMapsLink
          ),
        `${pastCards.length} past cards`
      );
      check(
        `[${vp.name}] All upcoming event cards have Reserve/Pickup deep-link buttons with #shop-catalog anchor`,
        upcomingCards.length >= 1 &&
          upcomingCards.every(
            (c) =>
              c.hasPickupBtn &&
              c.pickupHref.includes("shop.html?pickup_market=") &&
              c.pickupHref.endsWith("#shop-catalog")
          )
      );

      check(
        `[${vp.name}] All upcoming event cards have Add to Google Calendar buttons with TEMPLATE action`,
        upcomingCards.length >= 1 &&
          upcomingCards.every(
            (c) =>
              c.hasGcalBtn &&
              c.gcalHref.includes("calendar.google.com") &&
              c.gcalHref.includes("action=TEMPLATE")
          )
      );

      check(
        `[${vp.name}] All upcoming event cards have iCal / Apple Calendar (.ics) data URI links with download attributes`,
        upcomingCards.length >= 1 &&
          upcomingCards.every(
            (c) =>
              c.hasIcsBtn &&
              c.icsHref.startsWith("data:text/calendar;charset=utf-8,") &&
              c.icsDownload.endsWith(".ics")
          )
      );

      check(
        `[${vp.name}] All upcoming event cards render Google Maps and Apple Maps direction links`,
        upcomingCards.length >= 1 &&
          upcomingCards.every(
            (c) =>
              c.hasGmapsLink &&
              c.hasAppleMapsLink &&
              c.gmapsHref.includes("destination=") &&
              c.appleMapsHref.includes("daddr=")
          )
      );

      // Check no horizontal scroll overflow
      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      check(`[${vp.name}] events.html has no horizontal layout overflow`, !hasHorizontalOverflow);

      // 1.2 shop.html
      await page.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });

      const catalogSectionExists = await page.$eval("#shop-catalog", (el) => !!el);
      check(`[${vp.name}] shop.html has targetable #shop-catalog section`, catalogSectionExists);

      const categoryPillsCount = await page.$$eval(".filter-pill", (pills) => pills.length);
      check(
        `[${vp.name}] shop.html renders category filter pills`,
        categoryPillsCount >= 4,
        `found ${categoryPillsCount}`
      );

      const concernPillsCount = await page.$$eval(".concern-pill", (pills) => pills.length);
      check(
        `[${vp.name}] shop.html renders skin concern filter pills`,
        concernPillsCount >= 5,
        `found ${concernPillsCount}`
      );

      await page.close();
    }

    // =========================================================================
    // CATEGORY 2: CALENDAR DOWNLOAD TRIGGERS & RFC 5545 / URL FORMATTING
    // =========================================================================
    console.log("\n--- CATEGORY 2: CALENDAR DOWNLOAD TRIGGERS & FORMATTING ---");

    const eventsData = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/events.json"), "utf8")
    );
    const allEvents = (eventsData.upcoming || []).concat(eventsData.past || []);

    // Test each event's RFC 5545 ICS payload
    for (const ev of allEvents) {
      const ics = mainJs.generateIcsContent(ev);
      const uri = mainJs.generateIcsDataUri(ev);
      const filename = mainJs.getEventIcsFilename(ev);
      const gcalUrl = mainJs.generateGoogleCalendarUrl(ev);

      // 2.1 RFC 5545 structural validation
      check(
        `ICS for "${ev.name}" starts with BEGIN:VCALENDAR`,
        ics.startsWith("BEGIN:VCALENDAR\r\n")
      );
      check(`ICS for "${ev.name}" ends with END:VCALENDAR`, ics.endsWith("END:VCALENDAR"));
      check(
        `ICS for "${ev.name}" uses CRLF line endings`,
        ics.includes("\r\n") && !ics.replace(/\r\n/g, "").includes("\n")
      );
      check(`ICS for "${ev.name}" contains VERSION:2.0`, ics.includes("VERSION:2.0"));
      check(
        `ICS for "${ev.name}" contains PRODID`,
        ics.includes("PRODID:-//Y'allternative Living//Pop-Up Calendar//EN")
      );
      check(`ICS for "${ev.name}" contains CALSCALE:GREGORIAN`, ics.includes("CALSCALE:GREGORIAN"));
      check(`ICS for "${ev.name}" contains METHOD:PUBLISH`, ics.includes("METHOD:PUBLISH"));
      check(`ICS for "${ev.name}" contains STATUS:CONFIRMED`, ics.includes("STATUS:CONFIRMED"));
      // RFC 5545 folds lines longer than 75 octets (CRLF + space), and a long
      // event name folds the UID line, so unfold before matching.
      const unfoldedIcs = ics.replace(/\r?\n[ \t]/g, "");
      check(
        `ICS for "${ev.name}" contains UID with domain`,
        /UID:yl-event-.*@yallternativeliving\.com/.test(unfoldedIcs)
      );

      // 2.2 Date values & RFC 5545 exclusive end date
      const dates = mainJs.getCalendarDates(ev);
      check(`ICS for "${ev.name}" has valid 8-digit DTSTART`, /DTSTART;VALUE=DATE:\d{8}/.test(ics));
      check(`ICS for "${ev.name}" has valid 8-digit DTEND`, /DTEND;VALUE=DATE:\d{8}/.test(ics));
      check(
        `ICS for "${ev.name}" DTEND is strictly greater than DTSTART (exclusive end date)`,
        parseInt(dates.end, 10) > parseInt(dates.start, 10)
      );

      // 2.3 Data URI format
      check(
        `ICS Data URI for "${ev.name}" has valid MIME type`,
        uri.startsWith("data:text/calendar;charset=utf-8,")
      );
      check(
        `ICS Filename for "${ev.name}" ends in .ics without illegal characters`,
        /^[a-z0-9-]+\.ics$/.test(filename)
      );

      // 2.4 Google Calendar URL format
      check(
        `Google Calendar URL for "${ev.name}" targets calendar.google.com`,
        gcalUrl.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE")
      );
      // The dates value is URL-encoded like every other query value, so the
      // separator arrives as %2F; Google accepts either form.
      check(
        `Google Calendar URL for "${ev.name}" contains valid dates param`,
        gcalUrl.includes(`dates=${dates.start}/${dates.end}`) ||
          gcalUrl.includes(`dates=${dates.start}%2F${dates.end}`)
      );
      check(
        `Google Calendar URL for "${ev.name}" encodes title and location`,
        gcalUrl.includes("text=") && gcalUrl.includes("location=")
      );
    }

    // 2.5 Multi-day and rollover edge cases
    console.log("\n  [Adversarial Date Math Stress Testing]");
    const edgeCases = [
      {
        name: "Single Day Standard",
        date: "2026-08-21",
        expectedStart: "20260821",
        expectedEnd: "20260822"
      },
      {
        name: "Multi-Day Same Month",
        date: "2026-08-15",
        endDate: "2026-08-16",
        expectedStart: "20260815",
        expectedEnd: "20260817"
      },
      {
        name: "Month End Rollover (31-day month)",
        date: "2026-08-31",
        expectedStart: "20260831",
        expectedEnd: "20260901"
      },
      {
        name: "Month End Rollover (30-day month)",
        date: "2026-09-30",
        expectedStart: "20260930",
        expectedEnd: "20261001"
      },
      {
        name: "Year End Rollover",
        date: "2026-12-31",
        expectedStart: "20261231",
        expectedEnd: "20270101"
      },
      {
        name: "Leap Year Feb 28 Rollover (2024)",
        date: "2024-02-28",
        expectedStart: "20240228",
        expectedEnd: "20240229"
      },
      {
        name: "Non-Leap Year Feb 28 Rollover (2026)",
        date: "2026-02-28",
        expectedStart: "20260228",
        expectedEnd: "20260301"
      },
      {
        name: "Multi-Day Cross-Month Span",
        date: "2026-08-30",
        endDate: "2026-09-02",
        expectedStart: "20260830",
        expectedEnd: "20260903"
      }
    ];

    for (const ec of edgeCases) {
      const res = mainJs.getCalendarDates({ date: ec.date, endDate: ec.endDate });
      check(
        `Date Math: ${ec.name} (${ec.date}${ec.endDate ? " to " + ec.endDate : ""}) -> ${res.start}/${res.end}`,
        res.start === ec.expectedStart && res.end === ec.expectedEnd,
        `expected ${ec.expectedStart}/${ec.expectedEnd}, got ${res.start}/${res.end}`
      );
    }

    // 2.6 ICS Text Escaping Fuzzing
    console.log("\n  [ICS Text Escaping Fuzzing]");
    check(
      "escapeIcsText escapes semicolons",
      mainJs.escapeIcsText("Part 1; Part 2") === "Part 1\\; Part 2"
    );
    check("escapeIcsText escapes commas", mainJs.escapeIcsText("Landrum, SC") === "Landrum\\, SC");
    check(
      "escapeIcsText escapes backslashes",
      mainJs.escapeIcsText("Back\\slash") === "Back\\\\slash"
    );
    check(
      "escapeIcsText escapes newlines",
      mainJs.escapeIcsText("Line 1\nLine 2\r\nLine 3") === "Line 1\\nLine 2\\nLine 3"
    );
    check(
      "escapeIcsText handles null/undefined safely",
      mainJs.escapeIcsText(null) === "" && mainJs.escapeIcsText(undefined) === ""
    );

    // =========================================================================
    // CATEGORY 3: PICKUP SELECTION SYNCHRONIZATION ACROSS PAGES & CART
    // =========================================================================
    console.log("\n--- CATEGORY 3: PICKUP SELECTION SYNCHRONIZATION ACROSS PAGES ---");

    // Fetch available upcoming events directly from the page
    const probePage = await browser.newPage();
    await probePage.goto(`${baseUrl}/shop.html`, { waitUntil: "networkidle0" });
    const availableUpcomingEvents = await probePage.evaluate(() => {
      return (window.YL_EVENTS && window.YL_EVENTS.upcoming) || [];
    });
    await probePage.close();

    console.log(
      `  Found ${availableUpcomingEvents.length} active upcoming event(s) in window.YL_EVENTS.upcoming`
    );

    for (const targetEvent of availableUpcomingEvents) {
      const testPage = await browser.newPage();
      await testPage.setViewport({ width: 1200, height: 800 });

      // Navigate with pickup_market query param
      const targetParam = targetEvent.id || targetEvent.name;
      const url = `${baseUrl}/shop.html?pickup_market=${encodeURIComponent(targetParam)}#shop-catalog`;
      await testPage.goto(url, { waitUntil: "networkidle0" });

      // 3.1 Banner Verification
      const banner = await testPage.$("#pickupMarketBanner");
      check(`Deep link to ${targetEvent.name}: renders #pickupMarketBanner`, !!banner);

      if (banner) {
        const bannerText = await testPage.$eval("#pickupMarketBanner", (el) => el.textContent);
        check(
          `Deep link to ${targetEvent.name}: banner contains market name`,
          bannerText.includes(targetEvent.name),
          `got "${bannerText}"`
        );
        const bannerRole = await testPage.$eval("#pickupMarketBanner", (el) =>
          el.getAttribute("role")
        );
        check(
          `Deep link to ${targetEvent.name}: banner has role="status"`,
          bannerRole === "status"
        );
        const bannerLive = await testPage.$eval("#pickupMarketBanner", (el) =>
          el.getAttribute("aria-live")
        );
        check(
          `Deep link to ${targetEvent.name}: banner has aria-live="polite"`,
          bannerLive === "polite"
        );

        // Dismiss banner
        await testPage.click("#dismissPickupNotice");
        const bannerStillExists = await testPage.$("#pickupMarketBanner");
        check(
          `Deep link to ${targetEvent.name}: dismiss button removes banner`,
          bannerStillExists === null
        );
      }

      // 3.2 Add product to cart to populate cart drawer footer and verify state
      await testPage.click(".yl-add-item");
      await testPage.waitForSelector(
        ".yl-cart-drawer:popover-open, .yl-cart-drawer[data-open='true']",
        { timeout: 3000 }
      );

      const isCheckboxChecked = await testPage.$eval(
        "#yl-cart-pickup-checkbox",
        (el) => el.checked
      );
      check(
        `Deep link to ${targetEvent.name}: pickup checkbox is checked`,
        isCheckboxChecked === true
      );

      const isContainerVisible = await testPage.$eval("#yl-cart-pickup-select-container", (el) => {
        return window.getComputedStyle(el).display !== "none";
      });
      check(
        `Deep link to ${targetEvent.name}: pickup select container is visible`,
        isContainerVisible === true
      );

      const selectedOptionText = await testPage.$eval("#yl-cart-pickup-select", (el) => {
        return el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "";
      });
      check(
        `Deep link to ${targetEvent.name}: cart select has matching option selected`,
        selectedOptionText.includes(targetEvent.name),
        `got "${selectedOptionText}"`
      );

      // Verify cart state object via window.YLCart
      const cartState = await testPage.evaluate(() => {
        if (!window.YLCart || !window.YLCart.getState) return null;
        return window.YLCart.getState();
      });

      if (cartState) {
        check(
          `Deep link to ${targetEvent.name}: window.YLCart state.isPickup is true`,
          cartState.isPickup === true
        );
        check(
          `Deep link to ${targetEvent.name}: window.YLCart state.pickupMarket matches`,
          cartState.pickupMarket &&
            (cartState.pickupMarket.includes(targetEvent.name) ||
              cartState.pickupMarket === targetParam),
          `state.pickupMarket = "${cartState.pickupMarket}"`
        );
      }

      // 3.3 Multi-page navigation persistence check
      // Navigate to about.html and check if cart retains items
      await testPage.goto(`${baseUrl}/about.html`, { waitUntil: "networkidle0" });
      await testPage.evaluate(() => {
        if (window.YLCart && window.YLCart.open) window.YLCart.open();
        else document.querySelector(".cart-toggle").click();
      });
      await testPage.waitForSelector(
        ".yl-cart-drawer:popover-open, .yl-cart-drawer[data-open='true']",
        { timeout: 3000 }
      );

      const aboutItemCount = await testPage.$$eval(".yl-cart-item", (items) => items.length);
      check(`Navigating to about.html retains cart items`, aboutItemCount >= 1);

      await testPage.close();
    }

    // 3.4 Fallback / Unknown parameter deep link test
    console.log("\n  [Fallback / Unknown Market Deep Link Test]");
    // A fresh context: the cart persists in localStorage, and the valid
    // deep-link test above legitimately left pickup switched on.
    const fallbackContext = await browser.createBrowserContext();
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(
      `${baseUrl}/shop.html?pickup_market=custom-pop-up-market#shop-catalog`,
      { waitUntil: "networkidle0" }
    );
    // An unlisted market must be ignored outright. The banner used to render
    // for ANY slug ("Pre-order booth pickup activated: custom-pop-up-market")
    // and tick the pickup box, promising free pickup at a booth the Worker
    // would never honour (findPickupEvent only matches upcoming markets).
    const fallbackBanner = await fallbackPage.$("#pickupMarketBanner");
    check("Deep link with an unlisted market renders no pickup banner", fallbackBanner === null);
    const fallbackPickup = await fallbackPage.evaluate(() => {
      const cb = document.getElementById("yl-cart-pickup-checkbox");
      const state = window.YLCart && window.YLCart.getState ? window.YLCart.getState() : null;
      return {
        checked: cb ? cb.checked === true : false,
        isPickup: state ? state.isPickup === true : false
      };
    });
    check(
      "Deep link with an unlisted market does not pre-select pickup",
      !fallbackPickup.checked && !fallbackPickup.isPickup
    );
    await fallbackPage.close();
    await fallbackContext.close();

    // 3.5 Uncheck Pickup & Re-Navigation Flow
    console.log("\n  [Adversarial Pickup Toggle & Navigation Flow]");
    const navPage = await browser.newPage();
    await navPage.goto(`${baseUrl}/shop.html?pickup_market=autumn-apothecary-faire`, {
      waitUntil: "networkidle0"
    });

    // Add item so footer exists
    await navPage.click(".yl-add-item");
    await navPage.waitForSelector(
      ".yl-cart-drawer:popover-open, .yl-cart-drawer[data-open='true']",
      { timeout: 3000 }
    );

    // Uncheck pickup checkbox
    await navPage.click("#yl-cart-pickup-checkbox");
    const isNowUnchecked = await navPage.$eval("#yl-cart-pickup-checkbox", (el) => el.checked);
    check(
      "Unchecking pickup checkbox updates DOM checked state to false",
      isNowUnchecked === false
    );

    const isContainerHidden = await navPage.$eval("#yl-cart-pickup-select-container", (el) => {
      return window.getComputedStyle(el).display === "none";
    });
    check("Unchecking pickup checkbox hides select container", isContainerHidden === true);

    // Navigate to events.html and click the pickup button on the upcoming event card
    await navPage.goto(`${baseUrl}/events.html`, { waitUntil: "networkidle0" });
    const pickupLinks = await navPage.$$eval('.event-card a[href*="pickup_market="]', (links) => {
      return links.map((l) => l.getAttribute("href"));
    });
    check("events.html contains clickable pickup links", pickupLinks.length >= 1);

    // Click the upcoming event pickup link
    await Promise.all([
      navPage.waitForNavigation({ waitUntil: "networkidle0" }),
      navPage.evaluate(() => {
        const link = document.querySelector('.event-card a[href*="pickup_market="]');
        link.click();
      })
    ]);

    check(
      "Clicking pickup link on events.html navigates to shop.html",
      navPage.url().includes("shop.html?pickup_market=")
    );
    const navBanner = await navPage.$("#pickupMarketBanner");
    check("Navigated shop page displays banner for selected event", !!navBanner);

    await navPage.close();

    // =========================================================================
    // CATEGORY 4: PLAYWRIGHT MULTI-ENGINE VERIFICATION (Chromium, Firefox, WebKit)
    // =========================================================================
    console.log("\n--- CATEGORY 4: CROSS-BROWSER PLAYWRIGHT VERIFICATION ---");

    const engines = [
      { name: "Chromium", type: chromium },
      { name: "Firefox", type: firefox },
      { name: "WebKit (Safari)", type: webkit }
    ];

    for (const eng of engines) {
      console.log(`\n  [Engine: ${eng.name}]`);
      const pwBrowser = await eng.type.launch();
      const pwContext = await pwBrowser.newContext();
      const pwPage = await pwContext.newPage();

      // Load events.html
      await pwPage.goto(`${baseUrl}/events.html`);
      const pwEventCards = await pwPage.locator(".event-card").count();
      check(`[${eng.name}] events.html renders event cards`, pwEventCards >= 1);

      // Verify Google Calendar link
      const pwGcalHref = await pwPage
        .locator('.event-card a[href*="calendar.google.com"]')
        .first()
        .getAttribute("href");
      check(
        `[${eng.name}] Google Calendar link is well-formed`,
        pwGcalHref.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE")
      );

      // Verify .ics download link
      const pwIcsHref = await pwPage
        .locator('.event-card a[download$=".ics"]')
        .first()
        .getAttribute("href");
      check(
        `[${eng.name}] .ics data URI is well-formed`,
        pwIcsHref.startsWith("data:text/calendar;charset=utf-8,")
      );

      // Navigate to shop.html with deep link
      await pwPage.goto(`${baseUrl}/shop.html?pickup_market=autumn-apothecary-faire#shop-catalog`);
      const pwBanner = pwPage.locator("#pickupMarketBanner");
      await pwBanner.waitFor({ state: "visible", timeout: 4000 });
      const pwBannerText = await pwBanner.textContent();
      check(
        `[${eng.name}] Deep-link banner displays correctly`,
        pwBannerText.includes("Autumn Apothecary Faire")
      );

      // Dismiss banner
      await pwPage.locator("#dismissPickupNotice").click();
      await pwBanner.waitFor({ state: "detached", timeout: 4000 });
      check(`[${eng.name}] Banner dismiss works cleanly`, true);

      await pwBrowser.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n================================================================================");
  console.log(`VERIFICATION COMPLETE: ${passed} passed, ${failed} failed.`);
  console.log("================================================================================");

  if (failed > 0) {
    console.error("\nFAILURES ENCOUNTERED:");
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }
}

runAdversarialSuite().catch((err) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  process.exit(1);
});
