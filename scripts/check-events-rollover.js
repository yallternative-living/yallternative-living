#!/usr/bin/env node
"use strict";

/**
 * @fileoverview Evaluates whether any compiled upcoming event in assets/js/events-data.js
 * has an endDate or date strictly in the past (America/New_York timezone).
 *
 * Used by scheduled CI tasks and local checks to determine whether a rebuild
 * of site data is necessary, preventing unnecessary Netlify build credit spend.
 *
 * SECURITY: assets/js/events-data.js is a generated file (scripts/build-site-data.js
 * writes `window.YL_EVENTS = <JSON>;` behind a fixed doc comment). It is parsed here
 * as DATA -- the assignment prefix is stripped with a strict, anchored regex and the
 * remainder goes through JSON.parse. The file is never executed (no `vm`, no `eval`),
 * so a tampered events-data.js containing code cannot run inside CI; it is rejected
 * with exit code 2 instead.
 *
 * Exit codes:
 *   0 - One or more events have expired and need rollover.
 *   1 - All upcoming events are current (no rollover needed).
 *   2 - events-data.js is missing, not in the generated format, or not valid JSON.
 */

const fs = require("fs");
const path = require("path");

const EVENTS_DATA_PATH = path.join(__dirname, "../assets/js/events-data.js");

/**
 * Matches exactly what scripts/build-site-data.js emits for events-data.js:
 * an optional leading block comment (slash-star ... star-slash), then
 * `window.YL_EVENTS = `, the JSON payload, a terminating `;` and optional
 * trailing whitespace. Anchored at both ends so nothing may appear before the
 * comment or after the semicolon, and the comment body may not contain a
 * star-slash (so a second, unexpected comment cannot smuggle code in after it).
 * @const {!RegExp}
 */
const EVENTS_DATA_PATTERN =
  /^\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/\s*)?window\.YL_EVENTS\s*=\s*([\s\S]*?)\s*;\s*$/;

/**
 * Extracts the YL_EVENTS payload from the generated events-data.js text without
 * executing it. Throws on any deviation from the generated format.
 * @param {string} content Raw contents of assets/js/events-data.js.
 * @return {!Object} The parsed events object (as written by build-site-data.js).
 */
function parseEventsData(content) {
  if (typeof content !== "string") {
    throw new Error("events-data.js content must be a string.");
  }
  const match = EVENTS_DATA_PATTERN.exec(content);
  if (!match) {
    throw new Error(
      "assets/js/events-data.js is not in the generated `window.YL_EVENTS = <JSON>;` format. " +
        "Refusing to evaluate it. Regenerate it with `node scripts/build-site-data.js`."
    );
  }
  let events;
  try {
    events = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(
      "assets/js/events-data.js payload is not valid JSON (" +
        err.message +
        "). Refusing to evaluate it. Regenerate it with `node scripts/build-site-data.js`."
    );
  }
  if (events === null || typeof events !== "object" || Array.isArray(events)) {
    throw new Error("assets/js/events-data.js payload must be a JSON object.");
  }
  return events;
}

/**
 * @param {{date: (string|undefined), endDate: (string|undefined)}} evt
 * @param {string} todayStr YYYY-MM-DD.
 * @return {boolean} True when the event's last day is strictly before today.
 */
function isEventExpired(evt, todayStr) {
  const cutoff = evt.endDate || (evt.date ? String(evt.date).slice(0, 10) : "");
  return Boolean(cutoff && cutoff < todayStr);
}

/**
 * @param {?Array<!Object>} upcomingList
 * @param {string} todayStr YYYY-MM-DD.
 * @return {!Array<!Object>} The events that have expired as of todayStr.
 */
function findExpiredEvents(upcomingList, todayStr) {
  return (upcomingList || []).filter(function (e) {
    return isEventExpired(e, todayStr);
  });
}

function main() {
  if (!fs.existsSync(EVENTS_DATA_PATH)) {
    console.error("Error: assets/js/events-data.js does not exist.");
    process.exit(2);
  }

  let events;
  try {
    events = parseEventsData(fs.readFileSync(EVENTS_DATA_PATH, "utf8"));
  } catch (err) {
    console.error("Error: " + err.message);
    process.exit(2);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const expired = findExpiredEvents(events.upcoming, today);

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
}

if (require.main === module) {
  main();
}

module.exports = {
  EVENTS_DATA_PATTERN: EVENTS_DATA_PATTERN,
  parseEventsData: parseEventsData,
  isEventExpired: isEventExpired,
  findExpiredEvents: findExpiredEvents
};
