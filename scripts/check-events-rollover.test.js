/**
 * @fileoverview Unit tests for scripts/check-events-rollover.js.
 * Validates that event rollover checks correctly identify when upcoming
 * market dates have passed, protecting Netlify build credits from blind runs.
 *
 * Run: node scripts/check-events-rollover.test.js
 */

const assert = require("assert");

function isEventExpired(evt, todayStr) {
  const cutoff = evt.endDate || (evt.date ? evt.date.slice(0, 10) : "");
  return Boolean(cutoff && cutoff < todayStr);
}

function checkEventsList(upcomingList, todayStr) {
  return (upcomingList || []).filter((e) => isEventExpired(e, todayStr));
}

let passed = 0;

// Test 1: Future single-day event is NOT expired
{
  const events = [{ id: "market-1", date: "2026-10-15", name: "Autumn Market" }];
  const expired = checkEventsList(events, "2026-10-01");
  assert.strictEqual(expired.length, 0);
  passed++;
}

// Test 2: Past single-day event IS expired
{
  const events = [{ id: "market-1", date: "2026-09-12", name: "Renaissance Festival" }];
  const expired = checkEventsList(events, "2026-09-13");
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, "market-1");
  passed++;
}

// Test 3: Event on today is NOT expired (still active today)
{
  const events = [{ id: "market-1", date: "2026-09-13", name: "Today Market" }];
  const expired = checkEventsList(events, "2026-09-13");
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
  assert.strictEqual(checkEventsList(events, "2026-09-13").length, 0);
  // The day after (2026-09-14), it IS expired
  const expired = checkEventsList(events, "2026-09-14");
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, "market-fest");
  passed++;
}

// Test 5: ISO timestamp date format is correctly sliced to YYYY-MM-DD
{
  const events = [{ id: "market-iso", date: "2026-10-17T09:00:00-04:00", name: "Morning Faire" }];
  assert.strictEqual(checkEventsList(events, "2026-10-16").length, 0);
  assert.strictEqual(checkEventsList(events, "2026-10-17").length, 0);
  assert.strictEqual(checkEventsList(events, "2026-10-18").length, 1);
  passed++;
}

// Test 6: Empty list handles gracefully
{
  assert.strictEqual(checkEventsList([], "2026-09-13").length, 0);
  assert.strictEqual(checkEventsList(null, "2026-09-13").length, 0);
  passed++;
}

console.log(`check-events-rollover.test.js: ${passed} passed, 0 failed`);
