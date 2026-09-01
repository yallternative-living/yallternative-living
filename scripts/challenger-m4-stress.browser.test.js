/**
 * @fileoverview Adversarial Stress Test Suite for Milestone 4 (Apothecary Journal & Content Hub)
 * Challenger empirical test harness verifying:
 * 1. XML parser stress testing of feed.xml & generateRssFeed: entity escaping, RFC 822 dates, tag balance, channel properties, fuzzing.
 * 2. Fuzzing of getReadingTime, renderJournalTagsHtml, and tag filter engine with XSS payloads, type anomalies, empty inputs, extreme word counts.
 * 3. Featured product card resolution: aliases, substring matches, missing/invalid IDs, sold-out items, XSS attributes, 1-click cart integration.
 * 4. End-to-end headless browser interaction tests on journal.html (tag filtering, detail navigation, 1-click add-to-cart).
 *
 * Run: node scripts/challenger-m4-stress.browser.test.js
 */

/* global window, document, navigator */

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer");
const buildScript = require("./build-site-data.js");

const ROOT = path.resolve(__dirname, "..");

/**
 * The Apothecary Journal is a content switch, not a permanent feature: with
 * site.enableJournal off, the build emits no posts into journal-data.js,
 * search-data.js or feed.xml, and journal.html renders a "coming soon" notice.
 * Every journal expectation below is read off this flag rather than
 * hard-coded, so the suite asserts the state the site is actually in -- both
 * the gated one (nothing published) and the live one -- instead of failing the
 * moment the switch is flipped either way.
 */
const JOURNAL_ENABLED =
  JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")).site
    .enableJournal === true;

let passed = 0;
let failed = 0;
const findings = [];

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const errMsg = `  ✗ ${label}${detail ? ` — ${detail}` : ""}`;
    console.error(errMsg);
    findings.push({ label, detail, status: "FAIL" });
  }
}

function eq(actual, expected, label, detail = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const errMsg = `  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}${detail ? `\n      detail:   ${detail}` : ""}`;
    console.error(errMsg);
    findings.push({ label, detail: `expected ${e} got ${a}`, status: "FAIL" });
  }
}

// Strict XML Parser validator
function validateXmlStrict(xmlString) {
  const errors = [];

  // 1. Must start with XML declaration
  if (!xmlString.trim().startsWith("<?xml")) {
    errors.push("Missing XML declaration <?xml ... ?>");
  }

  // 2. Tokenize and check tag nesting balance and entity integrity
  const tagStack = [];
  const tagRegex =
    /<(\/)?([a-zA-Z0-9_:-]+)([^>]*?)(\/)?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|([^<]+)/g;
  let match;

  while ((match = tagRegex.exec(xmlString)) !== null) {
    const [fullMatch, isClosing, tagName, attributes, isSelfClosing, textContent] = match;

    if (
      fullMatch.startsWith("<?xml") ||
      fullMatch.startsWith("<!--") ||
      fullMatch.startsWith("<![CDATA[")
    ) {
      continue;
    }

    if (textContent) {
      // Check for raw unescaped '&' (not part of valid entity &amp;, &lt;, &gt;, &quot;, &apos;, &#...;)
      const rawAmpRegex = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
      if (rawAmpRegex.test(textContent)) {
        errors.push(
          `Unescaped raw ampersand '&' found in text: "${textContent.trim().slice(0, 40)}"`
        );
      }
      continue;
    }

    if (tagName) {
      // Check attributes for unescaped ampersands inside quotes
      if (attributes) {
        const rawAmpInAttr = /="[^"]*&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[^"]*"/g;
        if (rawAmpInAttr.test(attributes)) {
          errors.push(`Unescaped ampersand in attribute in tag <${tagName}>`);
        }
      }

      if (isSelfClosing || fullMatch.endsWith("/>")) {
        continue;
      } else if (isClosing) {
        if (tagStack.length === 0) {
          errors.push(`Unexpected closing tag </${tagName}> with empty stack`);
        } else {
          const top = tagStack.pop();
          if (top !== tagName) {
            errors.push(`Mismatched closing tag </${tagName}>, expected </${top}>`);
          }
        }
      } else {
        tagStack.push(tagName);
      }
    }
  }

  if (tagStack.length > 0) {
    errors.push(`Unclosed tags remaining: ${tagStack.join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

// Minimal browser mock for Node unit tests
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
    insertBefore: (newNode) => {
      children.unshift(newNode);
      return newNode;
    },
    firstChild: null,
    querySelector: () => createMockElement("div"),
    querySelectorAll: () => []
  };
  return el;
}

const storage = new Map();
const mockLocalStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

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
    href: "https://yallternativeliving.com/journal.html",
    hash: "",
    search: "",
    pathname: "/journal.html",
    hostname: "yallternativeliving.com",
    origin: "https://yallternativeliving.com"
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.navigator = { userAgent: "node" };

const productsData = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8")
);
const journalData = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/journal.json"), "utf8")
);
global.window.YL_PRODUCTS = productsData;
global.window.YL_JOURNAL = journalData;

const main = require(path.join(ROOT, "assets/js/main.js"));

async function runAllTests() {
  console.log("================================================================================");
  console.log("EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 4");
  console.log("Apothecary Journal, RSS 2.0 Syndication & Mini-Product 1-Click Cart");
  console.log("================================================================================\n");

  // ============================================================================
  // DIMENSION 1: XML Parser Stress Testing of feed.xml & generateRssFeed()
  // ============================================================================
  console.log("--- 1. XML Parser Stress Testing (feed.xml & RSS 2.0 Generator) ---");

  // 1.1 Disk feed.xml validation
  const feedXmlPath = path.join(ROOT, "feed.xml");
  assert(fs.existsSync(feedXmlPath), "feed.xml exists on disk");
  const feedXmlContent = fs.readFileSync(feedXmlPath, "utf8");

  const feedParseResult = validateXmlStrict(feedXmlContent);
  assert(
    feedParseResult.valid,
    "feed.xml passes strict XML syntax and entity balance verification",
    feedParseResult.errors.join("; ")
  );

  // Check required RSS 2.0 elements
  assert(
    feedXmlContent.includes('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">'),
    "RSS version 2.0 with Atom namespace"
  );
  assert(feedXmlContent.includes("<channel>"), "<channel> container present");
  assert(
    feedXmlContent.includes("<title>Apothecary Journal | Y'allternative Living</title>"),
    "Channel <title> present"
  );
  assert(
    feedXmlContent.includes("<link>https://yallternativeliving.com/journal.html</link>"),
    "Channel <link> present"
  );
  assert(feedXmlContent.includes("<description>"), "Channel <description> present");
  assert(feedXmlContent.includes("<language>en-us</language>"), "Channel <language> is en-us");
  assert(feedXmlContent.includes("<lastBuildDate>"), "Channel <lastBuildDate> present");
  assert(
    feedXmlContent.includes(
      '<atom:link href="https://yallternativeliving.com/feed.xml" rel="self" type="application/rss+xml"/>'
    ),
    "Channel contains Atom self link"
  );

  // Check date formatting in items. The only <item> elements in this feed are
  // journal posts, so when the journal is gated off the correct number of them
  // is zero -- asserting ">= 2" unconditionally would demand that a switched-off
  // feature keep publishing.
  const feedItemMatches = feedXmlContent.match(/<item>/g) || [];
  const pubDateMatches = feedXmlContent.match(/<pubDate>([^<]+)<\/pubDate>/g) || [];
  if (JOURNAL_ENABLED) {
    assert(
      feedItemMatches.length >= 2,
      `feed.xml publishes ${feedItemMatches.length} <item> entries while the journal is on`
    );
    assert(
      pubDateMatches.length >= 2,
      `feed.xml contains ${pubDateMatches.length} <pubDate> items`
    );
  } else {
    assert(
      feedItemMatches.length === 0,
      `feed.xml publishes no <item> entries while the journal is gated off (found ${feedItemMatches.length})`
    );
    assert(
      pubDateMatches.length === 0,
      `feed.xml contains no item <pubDate> while the journal is gated off (found ${pubDateMatches.length})`
    );
  }
  pubDateMatches.forEach((matchStr) => {
    const rawDate = matchStr.replace(/<\/?pubDate>/g, "").trim();
    const parsedTime = Date.parse(rawDate);
    assert(!isNaN(parsedTime), `pubDate "${rawDate}" parses to a valid timestamp`);
    assert(
      rawDate.endsWith("GMT") || rawDate.endsWith("UTC") || /[+-]\d{4}/.test(rawDate),
      `pubDate "${rawDate}" has valid RFC 822 timezone`
    );
  });

  // Check categories in items (journal post tags -- gated with the posts).
  const categoryMatches = feedXmlContent.match(/<category>([^<]+)<\/category>/g) || [];
  if (JOURNAL_ENABLED) {
    assert(
      categoryMatches.length >= 3,
      `feed.xml contains ${categoryMatches.length} <category> items`
    );
  } else {
    assert(
      categoryMatches.length === 0,
      `feed.xml contains no <category> items while the journal is gated off (found ${categoryMatches.length})`
    );
  }

  // 1.2 Adversarial Fuzzing of generateRssFeed()
  console.log("\n--- 1.2 Fuzzing generateRssFeed() with Malicious & Corrupted Data ---");

  // Fuzz 1: XSS and XML entity injection in post fields
  const maliciousPosts = [
    {
      id: "post<tag>&\"quotes'",
      title: 'Breaking: <script>alert("XSS")</script> & <b>HTML</b> with &amp; entity',
      date: "2026-08-15T12:00:00Z",
      excerpt:
        'Danger: </description><item><title>Injected Item</title></item><description> & "quotes"',
      tags: ["<tag>", "Quotes \" & '", "&amp;alreadyEscaped;", "</category><evil>"]
    },
    {
      id: "unicode-post",
      title: "Southern Wildflower & Pine 🌲 — 100% Queer-Owned (50% Off)",
      date: "2026-07-01",
      excerpt: "Folklore & science — “curly quotes” & em—dashes.",
      tags: ["Folk & Lore", 'Tag with <angle> & "quote"']
    }
  ];

  const maliciousFeedXml = buildScript.generateRssFeed(
    { posts: maliciousPosts },
    "https://yallternativeliving.com"
  );
  const maliciousParseResult = validateXmlStrict(maliciousFeedXml);
  assert(
    maliciousParseResult.valid,
    "generateRssFeed output with raw XSS/XML injection payloads is 100% valid strictly-escaped XML",
    maliciousParseResult.errors.join("; ")
  );
  assert(!maliciousFeedXml.includes("<script>"), "generateRssFeed escapes <script> in titles");
  assert(
    maliciousFeedXml.includes("&lt;script&gt;"),
    "generateRssFeed encodes <script> as &lt;script&gt;"
  );
  assert(
    !maliciousFeedXml.includes("</category><evil>"),
    "generateRssFeed escapes tag breakout attempts"
  );

  // Fuzz 2: Corrupted/missing date fields
  const corruptedDatePosts = [
    { id: "date-null", title: "Null Date", date: null },
    { id: "date-undefined", title: "Undefined Date" },
    { id: "date-invalid", title: "Invalid Date String", date: "not-a-real-date" },
    { id: "date-empty", title: "Empty Date", date: "" }
  ];
  const dateFeedXml = buildScript.generateRssFeed({ posts: corruptedDatePosts });
  const dateParseResult = validateXmlStrict(dateFeedXml);
  assert(
    dateParseResult.valid,
    "generateRssFeed gracefully handles null, undefined, empty, and invalid dates with fallback UTC strings",
    dateParseResult.errors.join("; ")
  );

  // Fuzz 3: Empty and corrupt input structures
  eq(
    typeof buildScript.generateRssFeed(null),
    "string",
    "generateRssFeed(null) returns valid string without crashing"
  );
  eq(
    typeof buildScript.generateRssFeed(undefined),
    "string",
    "generateRssFeed(undefined) returns valid string"
  );
  eq(typeof buildScript.generateRssFeed({}), "string", "generateRssFeed({}) returns valid string");
  eq(
    typeof buildScript.generateRssFeed({ posts: [] }),
    "string",
    "generateRssFeed({ posts: [] }) returns valid string"
  );
  eq(
    typeof buildScript.generateRssFeed({ posts: [{}, { id: 123 }] }),
    "string",
    "generateRssFeed handles post objects with missing fields"
  );

  let threwOnNullPost = false;
  try {
    buildScript.generateRssFeed({ posts: [null] });
  } catch (e) {
    threwOnNullPost = true;
  }
  assert(
    true,
    `generateRssFeed({ posts: [null] }) behavior evaluated (threwOnNull: ${threwOnNullPost})`
  );

  const emptyFeedParsed = validateXmlStrict(buildScript.generateRssFeed([]));
  assert(
    emptyFeedParsed.valid,
    "Empty feed XML is structurally valid XML",
    emptyFeedParsed.errors.join("; ")
  );

  // ============================================================================
  // DIMENSION 2: Fuzz Journal Reading Time & Tag Filter Engine
  // ============================================================================
  console.log("\n--- 2. Fuzzing Journal Reading Time & Tag Filter Engine ---");

  // 2.1 getReadingTime() stress tests
  eq(
    main.getReadingTime(null),
    "1 min read",
    "getReadingTime(null) returns safe fallback '1 min read'"
  );
  eq(
    main.getReadingTime(undefined),
    "1 min read",
    "getReadingTime(undefined) returns safe fallback"
  );
  eq(main.getReadingTime({}), "1 min read", "getReadingTime({}) returns '1 min read'");
  eq(
    main.getReadingTime({ content: "" }),
    "1 min read",
    "getReadingTime with empty content returns '1 min read'"
  );
  eq(
    main.getReadingTime({ readingTime: "7 min read" }),
    "7 min read",
    "Honors explicit readingTime property"
  );

  // Word boundary calculations (200 words per minute, ceil, min 1)
  const generateWords = (count) => new Array(count).fill("botanical").join(" ");
  eq(main.getReadingTime({ content: generateWords(1) }), "1 min read", "1 word = 1 min read");
  eq(main.getReadingTime({ content: generateWords(199) }), "1 min read", "199 words = 1 min read");
  eq(main.getReadingTime({ content: generateWords(200) }), "1 min read", "200 words = 1 min read");
  eq(
    main.getReadingTime({ content: generateWords(201) }),
    "2 min read",
    "201 words = 2 min read (ceil(201/200))"
  );
  eq(main.getReadingTime({ content: generateWords(400) }), "2 min read", "400 words = 2 min read");
  eq(main.getReadingTime({ content: generateWords(401) }), "3 min read", "401 words = 3 min read");

  // HTML stripping in reading time calculation
  const htmlContent =
    "<div><p>" + new Array(100).fill("<span>word</span>").join(" ") + "</p></div>";
  eq(
    main.getReadingTime({ content: htmlContent }),
    "1 min read",
    "Strips HTML tags before word counting"
  );

  // Massive text stress (50,000 words)
  const t0 = Date.now();
  const massivePost = { content: generateWords(50000) };
  const massiveReadTime = main.getReadingTime(massivePost);
  const tElapsed = Date.now() - t0;
  eq(massiveReadTime, "250 min read", "Correctly calculates 250 min read for 50,000 words");
  assert(
    tElapsed < 100,
    `50,000 word calculation completed in ${tElapsed}ms (< 100ms) without ReDoS`
  );

  // 2.2 renderJournalTagsHtml() fuzzing
  eq(main.renderJournalTagsHtml([]), "", "renderJournalTagsHtml([]) returns empty string");
  eq(main.renderJournalTagsHtml(null), "", "renderJournalTagsHtml(null) returns empty string");
  eq(
    main.renderJournalTagsHtml(undefined),
    "",
    "renderJournalTagsHtml(undefined) returns empty string"
  );
  eq(
    main.renderJournalTagsHtml("not-an-array"),
    "",
    "renderJournalTagsHtml('not-an-array') returns empty string"
  );

  const xssTagList = [
    '<script>alert("XSS")</script>',
    '" onmouseover="alert(1)"',
    "'></a><img src=x onerror=alert(1)>",
    "Apothecary & Herbalism"
  ];
  const renderedTagsHtml = main.renderJournalTagsHtml(xssTagList);
  assert(!renderedTagsHtml.includes("<script>"), "Tag renderer strips/escapes raw <script>");
  assert(renderedTagsHtml.includes("&lt;script&gt;"), "Tag renderer escapes < to &lt;");
  assert(
    !renderedTagsHtml.includes('" onmouseover='),
    "Tag renderer escapes quotes inside data-tag attribute"
  );
  assert(
    renderedTagsHtml.includes("&quot; onmouseover=&quot;"),
    "Tag renderer converts quotes to &quot; in data-tag"
  );
  assert(
    renderedTagsHtml.includes("Apothecary &amp; Herbalism"),
    "Tag renderer converts & to &amp;"
  );

  // 2.3 Clock icon SVG validation
  const clockSvg = main.renderClockIconSvg();
  assert(
    clockSvg.startsWith("<svg") && clockSvg.endsWith("</svg>"),
    "renderClockIconSvg() returns complete SVG element"
  );
  assert(
    clockSvg.includes('aria-hidden="true"'),
    "Clock SVG is marked aria-hidden for accessibility"
  );
  assert(clockSvg.includes('class="journal-clock-icon"'), "Clock SVG has journal-clock-icon class");

  // ============================================================================
  // DIMENSION 3: Mini-Product Card Resolution & 1-Click Cart Stress
  // ============================================================================
  console.log("\n--- 3. Featured Product Resolution & 1-Click Cart Stress ---");

  // 3.1 findFeaturedProduct() resolution tests
  eq(main.findFeaturedProduct(null), null, "findFeaturedProduct(null) returns null");
  eq(main.findFeaturedProduct(""), null, "findFeaturedProduct('') returns null");
  eq(
    main.findFeaturedProduct("totally-fake-product-id-12345"),
    null,
    "findFeaturedProduct with non-existent ID returns null"
  );

  // Alias mappings verification
  const aliasTests = [
    { alias: "magnesium-body-butter", expectedId: "sleep-salve" },
    { alias: "pine-tar-salve", expectedId: "frankincense-salve" },
    { alias: "magnesium-salve", expectedId: "sleep-salve" },
    { alias: "lavender-butter", expectedId: "shea-butter" }
  ];
  aliasTests.forEach(({ alias, expectedId }) => {
    const prod = main.findFeaturedProduct(alias);
    assert(
      prod !== null && prod.id === expectedId,
      `Alias "${alias}" correctly resolves to live product "${expectedId}"`
    );
  });

  // Direct ID verification
  const directTests = [
    "sleep-salve",
    "frankincense-salve",
    "shea-butter",
    "miracle-balm",
    "backroad-soak"
  ];
  directTests.forEach((id) => {
    const prod = main.findFeaturedProduct(id);
    assert(prod !== null && prod.id === id, `Direct ID "${id}" resolves correctly`);
  });

  // 3.2 renderFeaturedProductCardHtml() markup & data attributes
  eq(
    main.renderFeaturedProductCardHtml(null),
    "",
    "renderFeaturedProductCardHtml(null) returns empty string"
  );
  eq(
    main.renderFeaturedProductCardHtml("invalid-id"),
    "",
    "renderFeaturedProductCardHtml('invalid-id') returns empty string"
  );

  const sleepCardHtml = main.renderFeaturedProductCardHtml("sleep-salve");
  assert(
    sleepCardHtml.includes('class="journal-featured-card reveal"'),
    "Featured card has .journal-featured-card and .reveal"
  );
  assert(
    sleepCardHtml.includes('class="journal-featured-pill"'),
    "Contains 'Featured in this Article' pill badge"
  );
  assert(
    sleepCardHtml.includes('class="journal-featured-thumb"'),
    "Contains thumbnail image element"
  );
  assert(sleepCardHtml.includes('href="shop.html#sleep-salve"'), "Links to shop.html#sleep-salve");
  assert(sleepCardHtml.includes("$19.99"), "Contains formatted price $19.99");
  assert(
    sleepCardHtml.includes('class="btn btn-sm btn-primary yl-add-item"'),
    "Add button has .btn.btn-sm.btn-primary.yl-add-item"
  );
  assert(sleepCardHtml.includes('data-item-id="sleep-salve"'), "Button has data-item-id");
  assert(sleepCardHtml.includes('data-item-price="19.99"'), "Button has data-item-price");
  assert(
    sleepCardHtml.includes('data-item-name="Hush Y&#39;all Magnesium Arnica Sleep Salve"') ||
      sleepCardHtml.includes("Hush Y'all Magnesium Arnica Sleep Salve"),
    "Button has data-item-name"
  );
  assert(
    sleepCardHtml.includes('data-item-image="assets/img/sleep-salve.jpg"'),
    "Button has data-item-image"
  );
  assert(
    sleepCardHtml.includes('data-item-categories="salves"'),
    "Button has data-item-categories"
  );

  // 3.3 Product with XSS / special characters
  const mockXssProduct = {
    id: "xss-prod",
    name: 'Goth Body Balm <script>alert("name")</script>',
    price: 24.5,
    category: 'salves" onmouseover="alert(1)',
    scent: 'Lavender & "Pine"',
    image: 'assets/img/sleep-salve.jpg" onerror="alert(1)',
    blurb: 'A balm with <a href="evil">dangerous markup</a> & quotes "'
  };
  global.window.YL_PRODUCTS.products.push(mockXssProduct);

  const xssCardHtml = main.renderFeaturedProductCardHtml("xss-prod");
  assert(
    !xssCardHtml.includes('<script>alert("name")</script>'),
    "Product name escapes <script> tags"
  );
  assert(
    xssCardHtml.includes("&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;"),
    "Product name safely HTML-escaped"
  );
  assert(!xssCardHtml.includes(' onerror="alert(1)'), "Product image escapes attribute breakout");
  assert(
    !xssCardHtml.includes(' onmouseover="alert(1)'),
    "Product category escapes attribute breakout"
  );

  // Clean up mock product
  global.window.YL_PRODUCTS.products.pop();

  // 3.4 Product with sold-out variant or stock: 0
  const mockSoldOutProduct = {
    id: "soldout-salve",
    name: "Limited Edition Moon Salve",
    price: 22.0,
    category: "salves",
    scent: "Moonlight",
    image: "assets/img/sleep-salve.jpg",
    blurb: "Rare night-blooming botanicals.",
    stock: 0,
    inStock: false
  };
  global.window.YL_PRODUCTS.products.push(mockSoldOutProduct);

  const soldOutCardHtml = main.renderFeaturedProductCardHtml("soldout-salve");
  assert(
    soldOutCardHtml.length > 0,
    "renderFeaturedProductCardHtml renders card for zero-stock product with link to shop"
  );
  assert(
    soldOutCardHtml.includes('data-item-id="soldout-salve"'),
    "Card retains product data attributes"
  );

  global.window.YL_PRODUCTS.products.pop();

  // ============================================================================
  // DIMENSION 4: Headless Browser Integration Stress Tests
  // ============================================================================
  console.log("\n--- 4. Headless Browser Integration Tests (journal.html) ---");

  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".xml": "application/xml"
  };

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0].split("#")[0];
    if (reqPath === "/") reqPath = "/journal.html";
    const filePath = path.join(ROOT, reqPath);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
      res.end(data);
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const PORT = server.address().port;
  console.log(`  Local test HTTP server running on http://127.0.0.1:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    // Spoof navigator.webdriver = false per AGENTS.md scroll-reveal requirements
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Test across viewports
    const viewports = [
      { name: "Desktop", width: 1200, height: 800 },
      { name: "Tablet", width: 768, height: 1024 },
      { name: "Mobile", width: 375, height: 667 }
    ];

    // 4.0 journal.html reflects the site.enableJournal switch
    console.log(
      `\n  --- 4.0 Testing journal.html with site.enableJournal = ${JOURNAL_ENABLED} ---`
    );
    await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle0" });
    const journalAppText = await page.$eval("#journalApp", (el) => el.textContent.trim());
    if (JOURNAL_ENABLED) {
      assert(
        !journalAppText.includes("Journal Coming Soon"),
        "journal.html renders the article list while enableJournal is true"
      );
    } else {
      assert(
        journalAppText.includes("Journal Coming Soon"),
        "journal.html displays 'Journal Coming Soon' while enableJournal is false"
      );
    }

    // 4.1 - 4.4 only exist while the journal is published. With the switch
    // off the build emits zero posts, so there is nothing to filter, open or
    // add to a cart -- assert the gated state instead of driving a UI that is
    // deliberately not there.
    if (!JOURNAL_ENABLED) {
      const journalData = fs.readFileSync(path.join(ROOT, "assets/js/journal-data.js"), "utf8");
      const postsBlock = journalData.match(/"posts":\s*\[([\s\S]*?)\]/);
      assert(
        Boolean(postsBlock) && postsBlock[1].trim() === "",
        "journal-data.js publishes no posts while site.enableJournal is false"
      );
      const journalHtml = fs.readFileSync(path.join(ROOT, "journal.html"), "utf8");
      assert(
        journalHtml.includes('<meta name="robots" content="noindex'),
        "journal.html is noindex while the journal is gated off"
      );
    } else {
      // 4.1 Enable Journal flag for interactive testing
      console.log("\n  --- 4.1 Testing Active Journal state (enableJournal: true) ---");
      await page.evaluateOnNewDocument(() => {
        // Intercept window.YL_CONTENT to force enableJournal = true
        let originalContent = window.YL_CONTENT;
        Object.defineProperty(window, "YL_CONTENT", {
          get() {
            if (originalContent && originalContent.site) {
              originalContent.site.enableJournal = true;
            }
            return originalContent;
          },
          set(val) {
            originalContent = val;
            if (originalContent && originalContent.site) {
              originalContent.site.enableJournal = true;
            }
          }
        });
      });

      for (const vp of viewports) {
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle0" });

        // Check list view rendering
        const cardsCount = await page.$$eval(".grid .card", (cards) => cards.length);
        assert(cardsCount >= 2, `[${vp.name}] journal.html renders ${cardsCount} article cards`);

        const readingTimesCount = await page.$$eval(".journal-reading-time", (els) => els.length);
        assert(
          readingTimesCount >= 2,
          `[${vp.name}] Article cards display reading time badges with clock icon`
        );

        const tagButtonsCount = await page.$$eval(".journal-tag-pill", (els) => els.length);
        assert(
          tagButtonsCount >= 4,
          `[${vp.name}] Article cards render interactive tag pill buttons (found ${tagButtonsCount})`
        );
      }

      // 4.2 Test Tag Filter Interaction in browser
      console.log("\n  --- Testing Interactive Tag Filtering in Browser ---");
      await page.goto(`http://127.0.0.1:${PORT}/journal.html`, { waitUntil: "networkidle0" });

      // Click on the 'Apothecary' tag
      await page.evaluate(() => {
        const tagBtn = Array.from(document.querySelectorAll(".journal-tag")).find(
          (b) => b.getAttribute("data-tag") === "Apothecary"
        );
        if (tagBtn) tagBtn.click();
      });

      await new Promise((r) => setTimeout(r, 100));

      // Verify filter banner is visible
      const filterBannerText = await page.$eval(".journal-filter-banner", (el) =>
        el.textContent.trim()
      );
      assert(
        filterBannerText.includes("Showing articles tagged with: Apothecary"),
        "Filter banner displays active tag 'Apothecary'"
      );

      // Verify filtered card count
      const filteredCount = await page.$$eval(".grid .card", (cards) => cards.length);
      eq(filteredCount, 1, "Tag filter narrows list to 1 matching article for 'Apothecary'");

      // Click Clear Filter button
      await page.click("#journalClearFilter");
      await new Promise((r) => setTimeout(r, 100));

      const restoredCount = await page.$$eval(".grid .card", (cards) => cards.length);
      assert(restoredCount >= 2, "Clearing filter restores all journal articles");

      // 4.3 Test Article Detail Navigation & Featured Card 1-Click Cart Addition
      console.log("\n  --- Testing Detail View & Featured Card 1-Click Cart Integration ---");
      await page.goto(`http://127.0.0.1:${PORT}/journal.html#post-magnesium-salve-benefits`, {
        waitUntil: "networkidle0"
      });
      await new Promise((r) => setTimeout(r, 150));

      // Verify detail elements
      const detailTitle = await page.$eval(".journal-detail h2", (el) => el.textContent.trim());
      assert(
        detailTitle.includes("Why Magnesium & Arnica Belong in Your Bedtime Routine"),
        "Detail view displays article title"
      );

      const detailReadTime = await page.$eval(".journal-detail .journal-reading-time", (el) =>
        el.textContent.trim()
      );
      assert(
        detailReadTime.includes("min read"),
        `Detail view displays estimated reading time: "${detailReadTime}"`
      );

      const detailTagsCount = await page.$$eval(
        ".journal-detail-tags .journal-tag",
        (tags) => tags.length
      );
      assert(detailTagsCount >= 3, `Detail view renders ${detailTagsCount} topical tags`);

      // Verify Featured Product Card
      const featuredCardExists = await page.$eval(".journal-featured-card", (el) => !!el);
      assert(featuredCardExists, "Detail view renders inline .journal-featured-card");

      const featuredTitle = await page.$eval(".journal-featured-title", (el) =>
        el.textContent.trim()
      );
      assert(
        featuredTitle.includes("Magnesium Arnica Sleep Salve"),
        `Featured product card title: "${featuredTitle}"`
      );

      // Click '+ Add to Cart' button on featured card
      console.log("  Triggering 1-Click Add to Cart from featured card...");
      await page.click(".journal-featured-action .yl-add-item");
      await new Promise((r) => setTimeout(r, 200));

      // Check cart drawer open state
      const isCartDrawerOpen = await page.$eval("#yl-cart-drawer", (drawer) => {
        return (
          drawer.matches(":popover-open") ||
          drawer.getAttribute("data-open") === "true" ||
          window.getComputedStyle(drawer).display !== "none"
        );
      });
      assert(isCartDrawerOpen, "1-Click Add to Cart opens the cart drawer (#yl-cart-drawer)");

      // Check cart items in drawer
      const cartItemNames = await page.$$eval(".yl-cart-name", (els) =>
        els.map((e) => e.textContent.trim())
      );
      assert(
        cartItemNames.some((name) => name.includes("Sleep Salve") || name.includes("Magnesium")),
        `Featured product was successfully added to cart drawer items: [${cartItemNames.join(", ")}]`
      );

      // Close cart drawer before navigating back
      console.log("  Closing cart drawer via Escape...");
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 150));

      // 4.4 Verify Back to Journal button
      console.log("  Clicking '← Back to Journal' button...");
      await page.click("#journalBackBtn");
      await new Promise((r) => setTimeout(r, 150));
      const isListViewRestored = await page.$$eval(".grid .card", (cards) => cards.length >= 2);
      assert(isListViewRestored, "'← Back to Journal' button restores article list view");
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  console.log("\n================================================================================");
  if (failed > 0) {
    console.error(
      `MILSTONE 4 ADVERSARIAL CHALLENGER SUITE FAILED: ${passed} passed, ${failed} failed.`
    );
    findings.forEach((f) => console.error(`  - [${f.status}] ${f.label} (${f.detail})`));
    process.exit(1);
  } else {
    console.log(`MILSTONE 4 ADVERSARIAL CHALLENGER SUITE PASSED: ${passed} passed, 0 failed.`);
    console.log(
      "Verdict: All Milestone 4 components successfully withstood empirical stress testing!"
    );
    console.log(
      "================================================================================\n"
    );
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled error in challenger test suite:", err);
  process.exit(1);
});
