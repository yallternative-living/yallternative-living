#!/usr/bin/env node
"use strict";

/**
 * @fileoverview Writes each workshop's id into assets/data/events.json once,
 * so it never changes again -- and keeps it from being lost or shared.
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
 * Two more jobs (red team, 2026-10-09):
 *
 *   DUPLICATES. A copied workshop -- or a market copied with its id -- keeps
 *   the id of the one it was copied from, and the field is read-only, so the
 *   build's "two events have the same id" could not be fixed by renaming.
 *   Among upcoming entries (markets and workshops) sharing an id, one keeps
 *   it -- the one that held it before, else the one whose own name and date
 *   make that very slug, else a workshop (its id is a ledger key), else the
 *   first in the list -- and every other gets its own unique slug.
 *
 *   A LOST ID. A save that drops a stored id (a stale editor tab, a hand
 *   edit), or a rename before the id was ever stored, re-derived a new id: a
 *   new ledger key with every spot on sale again, and dead shared links.
 *   Given the events.json from before the merge (`--previous <path>`), an
 *   id-less workshop takes the id of the one it was -- matched
 *   conservatively, and NEVER guessed: a match that is not unique fails with
 *   a message the owner can act on.
 *
 * Only `workshops` are stamped when blank: markets sell nothing, and their
 * ids are assigned by the build (ensureEventId) where a "-2" suffix is
 * allowed. A market's id is only ever rewritten to undo a duplicate.
 *
 * Run: node scripts/stamp-workshop-ids.js [--previous <events.json before the merge>]
 *      (exit 0, printing what it wrote; exit 1 on an ambiguous match)
 */

const fs = require("fs");
const path = require("path");
const { slugify } = require("./build-site-data.js");

const EVENTS_PATH = path.join(__dirname, "../assets/data/events.json");

/** Today in America/New_York, YYYY-MM-DD -- the calendar's own day. */
function easternToday(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(now));
}

/** A thrown refusal the owner can act on (printed as-is by the CLI). */
class StampError extends Error {
  constructor(message) {
    super(message);
    this.name = "StampError";
  }
}

function isEntry(e) {
  return Boolean(e) && typeof e === "object";
}

function storedId(e) {
  return isEntry(e) && typeof e.id === "string" && e.id.trim() ? e.id.trim() : "";
}

function slugOf(e) {
  return isEntry(e) ? slugify([e.name, e.date].filter(Boolean).join(" ")) : "";
}

/** The id an entry is known by: the stored one, else its slug (as tickets.js workshopIdOf). */
function effectiveId(e) {
  return storedId(e) || slugOf(e);
}

function sameName(a, b) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  return norm(a.name) !== "" && norm(a.name) === norm(b.name);
}

function describe(e) {
  return `"${(e && e.name) || "(no name)"}" (${(e && e.date) || "no date"})`;
}

/** Writes `id` as the entry's first key (where Sveltia shows it), in place in `list`. */
function writeId(list, index, id) {
  list[index] = Object.assign({ id: id }, list[index], { id: id });
}

/**
 * Stamps, carries forward and de-duplicates ids. Mutates `events`.
 *
 * @param {object} events Parsed events.json.
 * @param {{previous?: object, today?: string}} [options] `previous`: the
 *   events.json from before this publish's merge; `today`: YYYY-MM-DD.
 * @return {{stamped: string[], carried: Array<{id: string, name: string}>,
 *   restamped: Array<{from: string, to: string, name: string}>, written: string[]}}
 * @throws {StampError} when an id-less workshop matches more than one
 *   workshop published before, or two of them match the same one.
 */
function stampEventIds(events, options = {}) {
  const today = options.today || easternToday();
  const workshops = events && Array.isArray(events.workshops) ? events.workshops : [];
  const markets = events && Array.isArray(events.upcoming) ? events.upcoming : [];
  const past = events && Array.isArray(events.past) ? events.past : [];
  const previous =
    options.previous && typeof options.previous === "object" ? options.previous : null;
  const report = { stamped: [], carried: [], restamped: [], written: [] };
  // Ids stored before this run: the strongest claim to an id in a duplicate.
  const heldBefore = new Set(workshops.concat(markets).filter((e) => storedId(e)));

  /* ---- A lost id: carry it forward from the version before the merge ---- */
  const carryTo = new Map(); // current workshop index -> previous entry
  if (previous) {
    const prevWorkshops = (Array.isArray(previous.workshops) ? previous.workshops : []).filter(
      (p) => isEntry(p) && effectiveId(p)
    );
    const prevIds = new Set(prevWorkshops.map(effectiveId));
    const storedNow = new Set(workshops.map(storedId).filter(Boolean));
    const idless = [];
    workshops.forEach((w, i) => {
      if (isEntry(w) && !storedId(w) && slugOf(w)) idless.push(i);
    });
    // Still in use: held by a current workshop, or the very slug an id-less one makes.
    const derivedNow = new Set(idless.map((i) => slugOf(workshops[i])));
    const orphans = prevWorkshops.filter(
      (p) => !storedNow.has(effectiveId(p)) && !derivedNow.has(effectiveId(p))
    );
    const claims = new Map(); // previous entry -> [current indexes]
    for (const i of idless) {
      const w = workshops[i];
      if (prevIds.has(slugOf(w))) continue; // unchanged: its slug IS its published id
      const exact = orphans.filter((p) => sameName(p, w) && p.date === w.date);
      let candidates = exact;
      if (!exact.length) {
        // Renamed (same date) or moved (same name) -- but only from a
        // workshop that has not happened yet: last month's class is not the
        // one this month's replaces.
        candidates = orphans.filter(
          (p) => String(p.endDate || p.date || "") >= today && (sameName(p, w) || p.date === w.date)
        );
      }
      if (candidates.length > 1) {
        throw new StampError(
          `Can't tell which workshop ${describe(w)} is. It has no Workshop ID, and it looks ` +
            `like more than one workshop that was already published: ` +
            candidates.map((p) => `${describe(p)}, ID "${effectiveId(p)}"`).join("; ") +
            `. A workshop's ID is the key its ticket count is kept under, so it is never ` +
            `guessed. To fix it, in the CMS put this workshop's name and date back to what ` +
            `they were when it was published, publish, and then make the change again.`
        );
      }
      if (candidates.length === 1) {
        const p = candidates[0];
        if (!claims.has(p)) claims.set(p, []);
        claims.get(p).push(i);
      }
    }
    for (const [p, indexes] of claims) {
      if (indexes.length > 1) {
        throw new StampError(
          `Can't tell which of ` +
            indexes.map((i) => describe(workshops[i])).join(" and ") +
            ` is the workshop published before as ${describe(p)} (ID "${effectiveId(p)}"): ` +
            `none of them has a Workshop ID, and each looks like it. A workshop's ID is the ` +
            `key its ticket count is kept under, so it is never guessed. To fix it, publish ` +
            `them one at a time, the original first.`
        );
      }
      carryTo.set(indexes[0], p);
    }
  }

  /* ---- Fill every blank workshop id ---- */
  workshops.forEach((w, i) => {
    if (!isEntry(w) || storedId(w)) return;
    if (carryTo.has(i)) {
      const id = effectiveId(carryTo.get(i));
      writeId(workshops, i, id);
      report.carried.push({ id: id, name: String(w.name || "") });
      report.written.push(id);
      return;
    }
    const id = slugOf(w);
    if (!id) return; // the build refuses this entry with a clear message
    writeId(workshops, i, id);
    report.stamped.push(id);
    report.written.push(id);
  });

  /* ---- Duplicates among upcoming entries (what the build refuses) ---- */
  const entries = [];
  workshops.forEach((e, i) => {
    if (storedId(e)) entries.push({ list: workshops, index: i, workshop: true });
  });
  markets.forEach((e, i) => {
    if (storedId(e)) entries.push({ list: markets, index: i, workshop: false });
  });
  const groups = new Map();
  for (const ref of entries) {
    const id = storedId(ref.list[ref.index]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(ref);
  }
  const taken = new Set(workshops.concat(markets, past).map(storedId).filter(Boolean));
  const prevHolder = new Map();
  if (previous) {
    for (const p of [].concat(previous.workshops || [], previous.upcoming || [])) {
      if (storedId(p) && !prevHolder.has(storedId(p))) prevHolder.set(storedId(p), p);
    }
  }
  for (const [id, refs] of groups) {
    if (refs.length < 2) continue;
    const entryOf = (ref) => ref.list[ref.index];
    let pool = refs;
    const narrow = (test) => {
      const kept = pool.filter(test);
      if (kept.length) pool = kept;
    };
    narrow((ref) => heldBefore.has(entryOf(ref)));
    const before = prevHolder.get(id);
    if (before)
      narrow((ref) => sameName(entryOf(ref), before) && entryOf(ref).date === before.date);
    narrow((ref) => slugOf(entryOf(ref)) === id);
    narrow((ref) => ref.workshop);
    const keeper = pool[0]; // entries are in list order: workshops, then markets
    for (const ref of refs) {
      if (ref === keeper) continue;
      const entry = entryOf(ref);
      const base = slugOf(entry) || "event";
      let next = base;
      for (let n = 2; taken.has(next); n++) next = `${base}-${n}`;
      taken.add(next);
      writeId(ref.list, ref.index, next);
      report.restamped.push({ from: id, to: next, name: String(entry.name || "") });
      report.written.push(next);
    }
  }
  return report;
}

/**
 * Gives every workshop without an id the slug of "<name> <date>" (or, with
 * `options.previous`, the id it was published under), as the first key, and
 * re-stamps duplicated ids. Mutates `events`.
 * @param {object} events Parsed events.json.
 * @param {{previous?: object, today?: string}} [options]
 * @return {string[]} The ids written.
 */
function stampWorkshopIds(events, options) {
  return stampEventIds(events, options).written;
}

/** `--previous <path>` or `--previous=<path>`, else null. */
function previousPathFrom(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--previous") {
      if (!argv[i + 1]) throw new StampError("--previous needs a path to an events.json file.");
      return argv[i + 1];
    }
    if (argv[i].startsWith("--previous=")) return argv[i].slice("--previous=".length);
  }
  return null;
}

if (require.main === module) {
  try {
    const previousPath = previousPathFrom(process.argv.slice(2));
    /* A path that was given must be read: a typo in the workflow must not
       quietly switch the lost-id protection off. */
    const previous = previousPath ? JSON.parse(fs.readFileSync(previousPath, "utf8")) : null;
    const text = fs.readFileSync(EVENTS_PATH, "utf8");
    const events = JSON.parse(text);
    const report = stampEventIds(events, { previous: previous });
    if (report.written.length) {
      fs.writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2) + "\n", "utf8");
    }
    if (report.stamped.length) console.log("Stamped workshop id(s): " + report.stamped.join(", "));
    for (const c of report.carried) {
      console.log(`Kept the published id "${c.id}" for the workshop "${c.name}".`);
    }
    for (const r of report.restamped) {
      console.log(`Gave the copy "${r.name}" its own id "${r.to}" (it shared "${r.from}").`);
    }
    if (!report.written.length) console.log("Every workshop already has an id.");
  } catch (err) {
    console.error(err && err.name === "StampError" ? err.message : err);
    process.exit(1);
  }
}

module.exports = { stampWorkshopIds, stampEventIds, StampError };
