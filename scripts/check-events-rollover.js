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
 *   2 - events-data.js is missing, not in the generated format, not valid JSON, or
 *       its data cannot be checked (`upcoming` not an array, an entry that is not an
 *       object, a date that is not YYYY-MM-DD). Any other unexpected error also exits
 *       2: CI reads 1 as "nothing expired", so a crash must never look like one.
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

/** A cutoff must start with a calendar date; a timestamp's time part is ignored. */
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

/** @param {*} value @return {string} "null", "array" or the typeof name. */
function typeName(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * The `upcoming` list of a parsed events object. A missing key is an empty
 * list; anything else that is not an array means the file cannot be checked.
 * @param {!Object} events As returned by parseEventsData.
 * @return {!Array<*>}
 */
function upcomingEvents(events) {
  if (events.upcoming === undefined) return [];
  if (!Array.isArray(events.upcoming)) {
    throw new Error(
      "assets/js/events-data.js: `upcoming` must be an array (got " +
        typeName(events.upcoming) +
        ")."
    );
  }
  return events.upcoming;
}

/**
 * The event's last day as YYYY-MM-DD: endDate when set, else date, else "".
 * Throws, naming the event, when the field used is not a YYYY-MM-DD string --
 * compared as text, "2026-9-5" would sort after "2026-09-22" and never expire.
 * @param {!Object} evt
 * @return {string}
 */
function eventCutoff(evt) {
  const field = evt.endDate ? "endDate" : evt.date ? "date" : "";
  if (!field) return "";
  const raw = evt[field];
  if (typeof raw !== "string" || !DATE_PREFIX_RE.test(raw)) {
    throw new Error(
      "Event " +
        JSON.stringify(evt.name || evt.id || "(unnamed)") +
        " has " +
        field +
        " " +
        JSON.stringify(raw) +
        ", which is not a YYYY-MM-DD date."
    );
  }
  return raw.slice(0, 10);
}

/**
 * @param {{date: (string|undefined), endDate: (string|undefined)}} evt
 * @param {string} todayStr YYYY-MM-DD.
 * @return {boolean} True when the event's last day is strictly before today.
 */
function isEventExpired(evt, todayStr) {
  const cutoff = eventCutoff(evt);
  return Boolean(cutoff && cutoff < todayStr);
}

/**
 * @param {?Array<!Object>} upcomingList null/undefined is an empty list.
 * @param {string} todayStr YYYY-MM-DD.
 * @return {!Array<!Object>} The events that have expired as of todayStr.
 */
function findExpiredEvents(upcomingList, todayStr) {
  if (upcomingList == null) return [];
  if (!Array.isArray(upcomingList)) {
    throw new Error("The upcoming events must be an array (got " + typeName(upcomingList) + ").");
  }
  return upcomingList.filter(function (e, i) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error("upcoming[" + i + "] must be an event object (got " + typeName(e) + ").");
    }
    return isEventExpired(e, todayStr);
  });
}

/**
 * Runs the check and returns the exit code (see the file header).
 * @param {string=} filePath Defaults to assets/js/events-data.js.
 * @return {number}
 */
function run(filePath) {
  const file = filePath || EVENTS_DATA_PATH;
  if (!fs.existsSync(file)) {
    console.error("Error: assets/js/events-data.js does not exist.");
    return 2;
  }

  let expired;
  let today;
  try {
    const events = parseEventsData(fs.readFileSync(file, "utf8"));
    today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expired = findExpiredEvents(upcomingEvents(events), today);
  } catch (err) {
    console.error("Error: " + err.message);
    return 2;
  }

  if (expired.length > 0) {
    console.log(`Event rollover needed as of ${today} (${expired.length} expired event(s)):`);
    expired.forEach(function (e) {
      console.log(`  - ${e.name} (cutoff: ${e.endDate || e.date})`);
    });
    return 0;
  }
  console.log(`No events need rollover today (${today}). All upcoming events are current.`);
  return 1;
}

if (require.main === module) {
  let code;
  try {
    code = run();
  } catch (err) {
    // Anything unforeseen is "could not check" (2), never Node's default 1.
    console.error("Error: " + (err && err.message ? err.message : String(err)));
    code = 2;
  }
  process.exit(code);
}

module.exports = {
  EVENTS_DATA_PATTERN: EVENTS_DATA_PATTERN,
  parseEventsData: parseEventsData,
  upcomingEvents: upcomingEvents,
  eventCutoff: eventCutoff,
  isEventExpired: isEventExpired,
  findExpiredEvents: findExpiredEvents,
  run: run
};
