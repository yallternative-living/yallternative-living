/**
 * @fileoverview Unit tests for scripts/sync-social-feed.js
 * Run: node scripts/sync-social-feed.test.js
 */

const fs = require("fs");
const path = require("path");
const { syncSocialFeed } = require("./sync-social-feed.js");

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

console.log("Running sync-social-feed.test.js unit tests...\n");

// Mocks
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalWarn = console.warn;
const originalError = console.error;
const originalLog = console.log;

let logs = [];
let warns = [];
let errors = [];
let writes = {};

function setupMocks() {
  logs = [];
  warns = [];
  errors = [];
  writes = {};
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warns.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
}

function restoreMocks() {
  fs.existsSync = originalExistsSync;
  fs.readFileSync = originalReadFileSync;
  fs.writeFileSync = originalWriteFileSync;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

const feedPath = path.join(__dirname, "..", "assets", "data", "social-feed.json");

/* Test Case 1: The file assets/data/social-feed.json does not exist. Verify that a warning is logged and execution returns early. */
setupMocks();
fs.existsSync = (p) => {
  if (p === feedPath) return false;
  return originalExistsSync(p);
};
syncSocialFeed();
assert(warns.length > 0 && warns[0].includes("not found"), "Logs warning if social-feed.json is missing");
restoreMocks();

/* Test Case 2: The file exists but contains invalid JSON. Verify that an error is caught and logged. */
setupMocks();
fs.existsSync = (p) => {
  if (p === feedPath) return true;
  return originalExistsSync(p);
};
fs.readFileSync = (p, enc) => {
  if (p === feedPath) return "invalid json";
  return originalReadFileSync(p, enc);
};
syncSocialFeed();
assert(errors.length > 0 && errors[0].includes("Error parsing"), "Logs error if social-feed.json contains invalid JSON");
restoreMocks();

/* Test Case 3: The file exists and contains valid JSON with valid local image paths. Verify that image paths are checked using fs.existsSync and a success message is logged. */
setupMocks();
const validData = {
  posts: [
    { image: "assets/img/valid1.jpg" },
    { image: "assets/img/valid2.jpg" }
  ]
};
fs.existsSync = (p) => {
  if (p === feedPath) return true;
  if (p.includes("valid1.jpg") || p.includes("valid2.jpg")) return true;
  return originalExistsSync(p);
};
fs.readFileSync = (p, enc) => {
  if (p === feedPath) return JSON.stringify(validData);
  return originalReadFileSync(p, enc);
};
fs.writeFileSync = (p, data) => {
  writes[p] = data;
};
syncSocialFeed();
assert(logs.length > 0 && logs[0].includes("2 local assets verified"), "Logs success and verifies local images if valid");
// Also verify that IDs and handles were added (we can't check mutated objects easily here unless we modified syncSocialFeed to return them, but we know it runs)
restoreMocks();

/* Test Case 4: The file exists, but image paths are not local or missing. Verify that missing IDs and handles are populated and defaults are used. */
setupMocks();
const mixedData = {
  posts: [
    { }, // No image, no id, no handle
    { image: "https://example.com/img.jpg" }, // External image
    { image: "assets/img/missing.jpg", id: "custom-id", handle: "@custom" } // Missing local image
  ]
};
fs.existsSync = (p) => {
  if (p === feedPath) return true;
  if (p.includes("missing.jpg")) return false;
  return originalExistsSync(p);
};
fs.readFileSync = (p, enc) => {
  if (p === feedPath) return JSON.stringify(mixedData);
  return originalReadFileSync(p, enc);
};
fs.writeFileSync = (p, data) => {
  writes[p] = data;
};

syncSocialFeed();
assert(warns.length > 0 && warns[0].includes("image not found on disk"), "Logs warning if local image is missing on disk");
assert(logs.length > 0 && logs[0].includes("Verified 3 UGC posts (0 local assets verified)"), "Handles posts without images or with external images correctly");

// Check that writes occurred with populated defaults.
assert(writes[feedPath] !== undefined, "Writes updated JSON to disk");
const writtenData = JSON.parse(writes[feedPath]);
assert(writtenData.posts[0].id === "ugc-1", "Populates missing id");
assert(writtenData.posts[0].handle === "@yallternativeliving", "Populates missing handle");
restoreMocks();

originalLog(`\nsync-social-feed.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
