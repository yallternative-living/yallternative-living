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
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const rollover = require("./check-events-rollover.js");
const { parseEventsData, findExpiredEvents, upcomingEvents, eventCutoff } = rollover;

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

/* ---------- Shapes and dates the check cannot read fail loudly ---------- */

// Test 14: `upcoming` absent is an empty list; present but not an array throws
{
  assert.deepStrictEqual(upcomingEvents({}), []);
  assert.deepStrictEqual(upcomingEvents({ upcoming: [] }), []);
  [null, {}, "x", 5, true].forEach(function (bad) {
    assert.throws(() => upcomingEvents({ upcoming: bad }), /`upcoming` must be an array/);
  });
  assert.throws(() => findExpiredEvents({ a: 1 }, "2026-09-13"), /must be an array/);
  assert.throws(() => findExpiredEvents("x", "2026-09-13"), /must be an array/);
  passed++;
}

// Test 15: An entry that is not an object throws with its index (was a TypeError -> exit 1)
{
  [null, "x", 7, ["2026-09-01"]].forEach(function (bad) {
    assert.throws(
      () => findExpiredEvents([{ date: "2026-10-01" }, bad], "2026-09-13"),
      /upcoming\[1\] must be an event object/
    );
  });
  passed++;
}

// Test 16: A cutoff that is not YYYY-MM-DD throws naming the event; blank ones stay unchecked
{
  assert.throws(
    () => eventCutoff({ name: "Fall Market", date: "2026-09-01", endDate: "2026-9-5" }),
    /"Fall Market" has endDate "2026-9-5", which is not a YYYY-MM-DD date/
  );
  assert.throws(
    () => eventCutoff({ id: "numeric", date: 20260901 }),
    /"numeric" has date 20260901/
  );
  assert.throws(() => eventCutoff({ date: "September 5" }), /"\(unnamed\)" has date/);
  assert.throws(
    () => findExpiredEvents([{ name: "Slash", date: "09/05/2026" }], "2026-09-13"),
    /"Slash" has date "09\/05\/2026"/
  );
  // endDate null (what the real data carries) falls back to date; neither set = no cutoff.
  assert.strictEqual(eventCutoff({ date: "2026-09-26", endDate: null }), "2026-09-26");
  assert.strictEqual(eventCutoff({ endDate: "2026-09-13T23:00:00-04:00" }), "2026-09-13");
  assert.strictEqual(eventCutoff({ name: "TBA" }), "");
  passed++;
}

// Test 17: The repo's real data passes the stricter checks
{
  const real = parseEventsData(
    fs.readFileSync(path.join(__dirname, "../assets/js/events-data.js"), "utf8")
  );
  assert.doesNotThrow(() => findExpiredEvents(upcomingEvents(real), "2026-01-01"));
  const source = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
  );
  assert.doesNotThrow(() => findExpiredEvents(upcomingEvents(source), "2026-01-01"));
  passed++;
}

// Test 18: The CLI exits 2 -- never 1, which CI reads as "nothing expired" -- on bad data
{
  // A throwaway copy of the script in a scripts/ + assets/js/ tree, so the CLI
  // reads a fixture instead of the repo's events-data.js.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yl-rollover-"));
  try {
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.mkdirSync(path.join(tmp, "assets/js"), { recursive: true });
    const script = path.join(tmp, "scripts/check-events-rollover.js");
    fs.copyFileSync(path.join(__dirname, "check-events-rollover.js"), script);
    const dataFile = path.join(tmp, "assets/js/events-data.js");
    const cli = (args) => spawnSync(process.execPath, args || [script], { encoding: "utf8" });
    const statusFor = (events) => {
      fs.writeFileSync(dataFile, generatedFile(events));
      return cli().status;
    };

    assert.strictEqual(cli().status, 2, "missing file");
    [
      { upcoming: { a: 1 } },
      { upcoming: [null] },
      { upcoming: "x" },
      { upcoming: null },
      { upcoming: [{ name: "n", endDate: "2026-9-5" }] },
      { upcoming: [{ name: "n", date: 20260901 }] }
    ].forEach(function (events) {
      assert.strictEqual(statusFor(events), 2, JSON.stringify(events));
    });
    assert.strictEqual(statusFor({}), 1, "no upcoming key = nothing to roll over");
    assert.strictEqual(statusFor({ upcoming: [{ name: "Future", date: "2999-01-01" }] }), 1);
    assert.strictEqual(statusFor({ upcoming: [{ name: "Past", date: "2000-01-01" }] }), 0);

    // An error nothing above anticipated still exits 2 (the entry-point wrapper).
    const boom = path.join(tmp, "boom.js");
    fs.writeFileSync(boom, 'require("fs").existsSync = () => { throw new TypeError("boom"); };\n');
    const crashed = cli(["--require", boom, script]);
    assert.strictEqual(crashed.status, 2);
    assert.match(crashed.stderr, /boom/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  passed++;
}

console.log(`check-events-rollover.test.js: ${passed} passed, 0 failed`);
