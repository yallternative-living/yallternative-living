#!/usr/bin/env node
"use strict";

/**
 * @fileoverview Evaluates whether any compiled upcoming event in assets/js/events-data.js
 * has an endDate or date strictly in the past (America/New_York timezone).
 *
 * Used by scheduled CI tasks and local checks to determine whether a rebuild
 * of site data is necessary, preventing unnecessary Netlify build credit spend.
 *
 * Exit codes:
 *   0 - One or more events have expired and need rollover.
 *   1 - All upcoming events are current (no rollover needed).
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const eventsDataPath = path.join(__dirname, "../assets/js/events-data.js");

if (!fs.existsSync(eventsDataPath)) {
  console.error("Error: assets/js/events-data.js does not exist.");
  process.exit(2);
}

const content = fs.readFileSync(eventsDataPath, "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(content, sandbox);

const events = sandbox.window.YL_EVENTS || { upcoming: [] };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const expired = (events.upcoming || []).filter(function (e) {
  const cutoff = e.endDate || (e.date ? e.date.slice(0, 10) : "");
  return cutoff && cutoff < today;
});

if (expired.length > 0) {
  console.log(`Event rollover needed as of ${today} (${expired.length} expired event(s)):`);
  expired.forEach(function (e) {
    console.log(`  - ${e.name} (cutoff: ${e.endDate || e.date})`);
  });
  process.exit(0);
} else {
  console.log(`No events need rollover today (${today}). All upcoming events are current.`);
  process.exit(1);
}
