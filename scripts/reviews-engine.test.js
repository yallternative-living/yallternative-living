"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");

// Mock browser environment for pure Node.js execution
var storage = new Map();
var mockLocalStorage = {
  getItem: function (key) {
    return storage.get(key) || null;
  },
  setItem: function (key, val) {
    storage.set(key, String(val));
  },
  removeItem: function (key) {
    storage.delete(key);
  },
  clear: function () {
    storage.clear();
  }
};

function createMockElement(tagName) {
  tagName = tagName || "div";
  var attrs = new Map();
  var children = [];
  var el = {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    setAttribute: function (name, val) {
      attrs.set(name, String(val));
    },
    getAttribute: function (name) {
      return attrs.get(name) || null;
    },
    removeAttribute: function (name) {
      attrs.delete(name);
    },
    hasAttribute: function (name) {
      return attrs.has(name);
    },
    style: {},
    classList: {
      _list: new Set(),
      add: function () {
        for (var i = 0; i < arguments.length; i++) this._list.add(arguments[i]);
      },
      remove: function () {
        for (var i = 0; i < arguments.length; i++) this._list.delete(arguments[i]);
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
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function (child) {
      children.push(child);
      return child;
    },
    querySelector: function () {
      return createMockElement("div");
    },
    querySelectorAll: function () {
      return [];
    }
  };
  return el;
}

var mockDocument = {
  documentElement: createMockElement("html"),
  getElementById: function () {
    return null;
  },
  querySelector: function () {
    return null;
  },
  querySelectorAll: function () {
    return [];
  },
  createElement: function (tag) {
    return createMockElement(tag);
  },
  body: createMockElement("body"),
  addEventListener: function () {},
  removeEventListener: function () {}
};

var mockWindow = {
  document: mockDocument,
  localStorage: mockLocalStorage,
  matchMedia: function () {
    return {
      matches: false,
      addEventListener: function () {},
      removeEventListener: function () {}
    };
  },
  addEventListener: function () {},
  removeEventListener: function () {},
  location: { search: "", pathname: "/reviews.html" }
};

global.window = mockWindow;
global.document = mockDocument;
global.localStorage = mockLocalStorage;

var main = require("../assets/js/main.js");

console.log("Running Reviews Engine Unit Tests (Milestone 5: Reviews Search & Filter)...\n");

var reviewsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/data/site-reviews.json"), "utf8")
);
var reviews = reviewsData.reviews;

var productsById = {
  "hand-scrub": { id: "hand-scrub", name: "Heavy Duty Hand Scrub", category: "body" },
  "bug-spray": { id: "bug-spray", name: "All-Natural Bug Spray", category: "potions" },
  "sleep-salve": {
    id: "sleep-salve",
    name: "Hush Y'all Magnesium Sleep Salve",
    category: "salves"
  },
  "beard-salve": { id: "beard-salve", name: "Cedar & Bourbon Beard Salve", category: "salves" },
  "miracle-balm": { id: "miracle-balm", name: "Y'allternative Miracle Balm", category: "salves" }
};

// 1. formatReviewDate
assert.strictEqual(main.formatReviewDate("2026-06-16"), "Jun 2026", "Formats ISO date to Mon Year");
assert.strictEqual(main.formatReviewDate("2026-03-05"), "Mar 2026", "Formats Mar date correctly");
assert.strictEqual(
  main.formatReviewDate("invalid-date"),
  "",
  "Returns empty string for invalid date"
);
assert.strictEqual(main.formatReviewDate(""), "", "Returns empty string for empty input");
assert.strictEqual(main.formatReviewDate(null), "", "Returns empty string for null input");
console.log("  ✓ formatReviewDate parses valid ISO dates and handles invalid inputs gracefully");

// 2. filterReviews - all ratings, empty query
var allRes = main.filterReviews(reviews, "", "all", productsById);
assert.strictEqual(allRes.length, reviews.length, "Returns all reviews when no filter applied");
console.log("  ✓ filterReviews returns all reviews when query is empty and rating is 'all'");

// 3. filterReviews - star rating filter
var fiveStar = main.filterReviews(reviews, "", "5", productsById);
assert.ok(fiveStar.length > 0, "Finds 5 star reviews");
fiveStar.forEach(function (r) {
  assert.strictEqual(Math.round(r.rating), 5, "Review rating must be 5");
});

var fourStar = main.filterReviews(reviews, "", "4", productsById);
assert.ok(fourStar.length > 0, "Finds 4 star reviews");
fourStar.forEach(function (r) {
  assert.strictEqual(Math.round(r.rating), 4, "Review rating must be 4");
});

var threeStar = main.filterReviews(reviews, "", "3", productsById);
assert.ok(threeStar.length > 0, "Finds 3 star reviews");
threeStar.forEach(function (r) {
  assert.strictEqual(Math.round(r.rating), 3, "Review rating must be 3");
});
console.log("  ✓ filterReviews accurately filters by discrete star ratings (5★, 4★, 3★)");

// 4. filterReviews - keyword search on review body
var scrubRes = main.filterReviews(reviews, "knuckles", "all", productsById);
assert.ok(scrubRes.length >= 1, "Matches text 'knuckles'");
assert.ok(
  scrubRes.some(function (r) {
    return r.id === "etsy-2026-06-eric";
  })
);
console.log("  ✓ filterReviews matches keywords in review body text");

// 5. filterReviews - keyword search on author name
var nameRes = main.filterReviews(reviews, "Leila", "all", productsById);
assert.strictEqual(nameRes.length, 1, "Matches reviewer name 'Leila'");
assert.strictEqual(nameRes[0].id, "etsy-2026-05-leila");
console.log("  ✓ filterReviews matches reviewer name");

// 6. filterReviews - keyword search on product name
var prodRes = main.filterReviews(reviews, "Sleep Salve", "all", productsById);
assert.ok(prodRes.length >= 1, "Matches product name 'Sleep Salve'");
assert.ok(
  prodRes.some(function (r) {
    return r.productId === "sleep-salve";
  })
);
console.log("  ✓ filterReviews matches product name via productId resolution");

// 7. filterReviews - keyword search on product category
var catRes = main.filterReviews(reviews, "salves", "all", productsById);
assert.ok(catRes.length >= 2, "Matches products in category 'salves'");
console.log("  ✓ filterReviews matches product category via productId resolution");

// 8. filterReviews - combining search query + rating filter
var comboRes = main.filterReviews(reviews, "salve", "5", productsById);
assert.ok(comboRes.length >= 1, "Finds 5 star reviews matching 'salve'");
comboRes.forEach(function (r) {
  assert.strictEqual(Math.round(r.rating), 5);
});
console.log("  ✓ filterReviews combines rating and search queries seamlessly");

// 9. renderReviewCardHtml - Verified buyer badge
var verifiedReview = {
  id: "test-1",
  name: "Morgan & Casey",
  rating: 5,
  text: 'Loved this <product> & "special" balm!',
  date: "2026-07-10",
  verifiedBuyer: true
};
var verifiedHtml = main.renderReviewCardHtml(verifiedReview, { name: "Test Salve" });
assert.ok(verifiedHtml.indexOf('class="badge badge-verified"') !== -1, "Contains verified badge");
assert.ok(verifiedHtml.indexOf("Verified Buyer") !== -1, "Contains Verified Buyer text");
assert.ok(verifiedHtml.indexOf("★★★★★") !== -1, "Contains 5 stars");
assert.ok(verifiedHtml.indexOf("&amp;") !== -1, "Escapes ampersand");
assert.ok(verifiedHtml.indexOf("&lt;product&gt;") !== -1, "Escapes angle brackets");
assert.ok(verifiedHtml.indexOf("&quot;special&quot;") !== -1, "Escapes quotes");
console.log("  ✓ renderReviewCardHtml renders verified buyer badge and safely escapes HTML");

// 10. renderReviewCardHtml - Unverified review
var unverifiedReview = {
  id: "test-2",
  name: "Jordan P.",
  rating: 4,
  text: "Great balm.",
  date: "2026-08-05",
  verifiedBuyer: false
};
var unverifiedHtml = main.renderReviewCardHtml(unverifiedReview, null);
assert.strictEqual(unverifiedHtml.indexOf("badge-verified"), -1, "Omits verified badge when false");
assert.ok(unverifiedHtml.indexOf("★★★★☆") !== -1, "Contains 4 stars and 1 empty star");
console.log("  ✓ renderReviewCardHtml omits verified buyer badge when false");

// 11. site-reviews.json Schema Assertions
reviews.forEach(function (r, idx) {
  assert.ok(r.id && typeof r.id === "string", "Review " + idx + " must have a string id");
  assert.ok(r.name && typeof r.name === "string", "Review " + idx + " must have a string name");
  assert.ok(
    typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5,
    "Review " + idx + " rating must be 1-5"
  );
  assert.ok(r.text && typeof r.text === "string", "Review " + idx + " must have non-empty text");
  assert.ok(
    typeof r.verifiedBuyer === "boolean",
    "Review " + idx + " must declare verifiedBuyer boolean"
  );
});
console.log(
  "  ✓ site-reviews.json passes schema assertions (all " +
    reviews.length +
    " reviews declare verifiedBuyer boolean)"
);

console.log("\nAll reviews-engine unit tests passed successfully!");
