/**
 * @fileoverview Unit tests for scripts/check-events-rollover.js.
 * Validates that event rollover checks correctly identify when upcoming
 * market dates have passed, protecting Netlify build credits from blind runs,
 * and that the generated events-data.js is parsed as data -- never executed.
 *
 * Run: node scripts/check-events-rollover.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rollover = require("./check-events-rollover.js");
const { parseEventsData, findExpiredEvents } = rollover;

/** Builds a file body exactly the way scripts/build-site-data.js emits it. */
function generatedFile(events) {
  return (
    "/**\n" +
    " * @fileoverview Auto-generated events and markets appearances data.\n" +
    " * Wrap of assets/data/events.json into a global variable YL_EVENTS.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n" +
    "window.YL_EVENTS = " +
    JSON.stringify(events, null, 2) +
    ";\n"
  );
}

let passed = 0;

/* ---------- Expiry logic ---------- */

// Test 1: Future single-day event is NOT expired
{
  const events = [{ id: "market-1", date: "2026-10-15", name: "Autumn Market" }];
  const expired = findExpiredEvents(events, "2026-10-01");
  assert.strictEqual(expired.length, 0);
  passed++;
}

// Test 2: Past single-day event IS expired
{
  const events = [{ id: "market-1", date: "2026-09-12", name: "Renaissance Festival" }];
  const expired = findExpiredEvents(events, "2026-09-13");
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, "market-1");
  passed++;
}

// Test 3: Event on today is NOT expired (still active today)
{
  const events = [{ id: "market-1", date: "2026-09-13", name: "Today Market" }];
  const expired = findExpiredEvents(events, "2026-09-13");
  assert.strictEqual(expired.length, 0);
  passed++;
}

// Test 4: Multi-day event stays active through endDate
{
  const events = [
    {
      id: "market-fest",
      date: "2026-09-11",
      endDate: "2026-09-13",
      name: "Weekend Market"
    }
  ];
  // On the final day (2026-09-13), it is NOT expired
  assert.strictEqual(findExpiredEvents(events, "2026-09-13").length, 0);
  // The day after (2026-09-14), it IS expired
  const expired = findExpiredEvents(events, "2026-09-14");
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, "market-fest");
  passed++;
}

// Test 5: ISO timestamp date format is correctly sliced to YYYY-MM-DD
{
  const events = [{ id: "market-iso", date: "2026-10-17T09:00:00-04:00", name: "Morning Faire" }];
  assert.strictEqual(findExpiredEvents(events, "2026-10-16").length, 0);
  assert.strictEqual(findExpiredEvents(events, "2026-10-17").length, 0);
  assert.strictEqual(findExpiredEvents(events, "2026-10-18").length, 1);
  passed++;
}

// Test 6: Empty list handles gracefully
{
  assert.strictEqual(findExpiredEvents([], "2026-09-13").length, 0);
  assert.strictEqual(findExpiredEvents(null, "2026-09-13").length, 0);
  passed++;
}

/* ---------- Parsing events-data.js as data (never executing it) ---------- */

// Test 7: The exact generated format (doc comment + assignment + JSON + ";") parses
{
  const data = { upcoming: [{ id: "a", date: "2026-09-12", name: "A" }], past: [] };
  const parsed = parseEventsData(generatedFile(data));
  assert.deepStrictEqual(parsed, data);
  passed++;
}

// Test 8: The bare assignment with no leading comment also parses
{
  const parsed = parseEventsData('window.YL_EVENTS = {"upcoming":[]};');
  assert.deepStrictEqual(parsed, { upcoming: [] });
  passed++;
}

// Test 9: The real generated file in this repo parses and has an `upcoming` array
{
  const real = fs.readFileSync(path.join(__dirname, "../assets/js/events-data.js"), "utf8");
  const parsed = parseEventsData(real);
  assert.ok(Array.isArray(parsed.upcoming), "real events-data.js should expose upcoming[]");
  passed++;
}

// Test 10: A file whose payload is CODE is rejected, not executed
{
  // A global sentinel proves nothing ran: if the IIFE were evaluated it would flip it.
  global.__ylRolloverExecuted = false;
  const codeFile =
    "window.YL_EVENTS = (function(){ global.__ylRolloverExecuted = true; return []; })();";
  assert.throws(() => parseEventsData(codeFile), /not valid JSON|not in the generated/);
  assert.strictEqual(global.__ylRolloverExecuted, false, "payload must never be evaluated");
  delete global.__ylRolloverExecuted;
  passed++;
}

// Test 11: Code smuggled before or after the assignment is rejected by the anchors
{
  const before = 'require("child_process");\nwindow.YL_EVENTS = {"upcoming":[]};';
  const after = 'window.YL_EVENTS = {"upcoming":[]};\nrequire("child_process");';
  const secondComment =
    '/** a */ /** b */ window.YL_EVENTS = {"upcoming":[]}; /* c */ require("fs");';
  assert.throws(() => parseEventsData(before), /not in the generated/);
  assert.throws(() => parseEventsData(after), /not valid JSON|not in the generated/);
  assert.throws(() => parseEventsData(secondComment), /not valid JSON|not in the generated/);
  passed++;
}

// Test 12: A different global name, missing semicolon, or non-object payload is rejected
{
  assert.throws(() => parseEventsData('window.YL_PRODUCTS = {"upcoming":[]};'), /not in the/);
  assert.throws(() => parseEventsData('window.YL_EVENTS = {"upcoming":[]}'), /not in the/);
  assert.throws(() => parseEventsData("window.YL_EVENTS = [];"), /must be a JSON object/);
  assert.throws(() => parseEventsData("window.YL_EVENTS = null;"), /must be a JSON object/);
  assert.throws(() => parseEventsData(""), /not in the generated/);
  assert.throws(() => parseEventsData(undefined), /must be a string/);
  passed++;
}

// Test 13: JavaScript-but-not-JSON payloads (comments, unquoted keys, trailing commas) are rejected
{
  assert.throws(() => parseEventsData("window.YL_EVENTS = { upcoming: [] };"), /not valid JSON/);
  assert.throws(
    () => parseEventsData('window.YL_EVENTS = {"upcoming": [] /* x */};'),
    /not valid JSON/
  );
  assert.throws(() => parseEventsData('window.YL_EVENTS = {"upcoming": [],};'), /not valid JSON/);
  passed++;
}

console.log(`check-events-rollover.test.js: ${passed} passed, 0 failed`);
