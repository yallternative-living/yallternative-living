#!/usr/bin/env node
"use strict";

/**
 * @fileoverview Writes each workshop's id into assets/data/events.json once,
 * so it never changes again.
 *
 * A workshop's id is its ticket's key in the Worker's inventory ledger
 * (`ticket-<id>`, workers/state/tickets.js) and the anchor every shared link
 * points at (events.html#<id>). With no id stored, both derive it from the
 * slug of "<name> <date>" -- so fixing a typo in the name, or moving the
 * date, after tickets had sold made a NEW ledger row seeded from "Tickets
 * available" (selling the sold seats again) and broke every link already
 * shared (red team, 2026-10-08).
 *
 * The CMS's "Workshop ID" field is read-only, so the owner never types one;
 * this script fills a blank one with exactly the slug the build and the
 * Worker were already using, so stamping changes nothing that is live. From
 * then on Sveltia keeps the stored value on every save, and a rename or a new
 * date keeps the id. .github/workflows/cms-publish.yml runs it on every
 * publish, before the build, and commits the result with the build output.
 *
 * Only `workshops` is stamped: markets sell nothing, and their ids are
 * assigned by the build (ensureEventId) where a "-2" suffix is allowed.
 *
 * Run: node scripts/stamp-workshop-ids.js   (exit 0; prints what it stamped)
 */

const fs = require("fs");
const path = require("path");
const { slugify } = require("./build-site-data.js");

const EVENTS_PATH = path.join(__dirname, "../assets/data/events.json");

/**
 * Gives every workshop without an id the slug of "<name> <date>", as the
 * first key. Mutates `events`.
 * @param {object} events Parsed events.json.
 * @return {string[]} The ids stamped.
 */
function stampWorkshopIds(events) {
  const stamped = [];
  const list = events && Array.isArray(events.workshops) ? events.workshops : [];
  list.forEach(function (w, i) {
    if (!w || typeof w !== "object") return;
    if (typeof w.id === "string" && w.id.trim()) return;
    const id = slugify([w.name, w.date].filter(Boolean).join(" "));
    if (!id) return; // the build refuses this entry with a clear message
    list[i] = Object.assign({ id: id }, w, { id: id });
    stamped.push(id);
  });
  return stamped;
}

if (require.main === module) {
  const text = fs.readFileSync(EVENTS_PATH, "utf8");
  const events = JSON.parse(text);
  const stamped = stampWorkshopIds(events);
  if (stamped.length) {
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2) + "\n", "utf8");
    console.log("Stamped workshop id(s): " + stamped.join(", "));
  } else {
    console.log("Every workshop already has an id.");
  }
}

module.exports = { stampWorkshopIds };
