/**
 * @fileoverview scripts/stamp-workshop-ids.js: a workshop's id is written
 * once, as the very slug the build and the Worker already derive, and never
 * changes after -- so a rename cannot reset the ticket count. A copy cannot
 * keep the id of the entry it was copied from, and an id a save dropped is
 * carried forward from the version before the merge, or refused when that
 * cannot be done without guessing.
 *
 * Run: node scripts/stamp-workshop-ids.test.js
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { stampWorkshopIds, stampEventIds } = require("./stamp-workshop-ids.js");
const build = require("./build-site-data.js");

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** The error a call throws, or null. */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

/** Does the build accept this calendar? null when it does, else the error. */
function buildRefusal(events) {
  return thrown(() => build.assignEventIds(build.mergeWorkshopsIntoUpcoming(clone(events))));
}

async function run() {
  const tickets = await import("../workers/state/tickets.js");

  const events = {
    upcoming: [{ name: "A Market", date: "2099-05-01" }],
    workshops: [
      { name: "Potions & Pour Decisions", date: "2099-11-06", price: 60, spots: 12 },
      { id: "kept-id", name: "Renamed Later", date: "2099-12-01", price: 45, spots: 8 },
      { id: "  ", name: "Blank Id", date: "2099-12-02" },
      { price: 10 }
    ]
  };
  const before = clone(events);
  const derived = tickets.workshopIdOf(before.workshops[0]);
  const stamped = stampWorkshopIds(events);

  assert(
    stamped.length === 2 && stamped[0] === derived && stamped[1] === "blank-id-2099-12-02",
    "blank ids are stamped, and only those"
  );
  assert(
    events.workshops[0].id === derived && Object.keys(events.workshops[0])[0] === "id",
    "the stamped id is the slug the Worker already derives, written as the first key"
  );
  assert(events.workshops[1].id === "kept-id", "an id already stored is never changed");
  assert(
    !("id" in events.workshops[3]),
    "a workshop with no name or date is left for the build to refuse"
  );
  assert(!("id" in events.upcoming[0]), "markets are not stamped");
  assert(
    build.mergeWorkshopsIntoUpcoming(clone({ upcoming: [], workshops: [before.workshops[0]] }))
      .upcoming[0].ticketId ===
      build.mergeWorkshopsIntoUpcoming(clone({ upcoming: [], workshops: [events.workshops[0]] }))
        .upcoming[0].ticketId,
    "stamping changes nothing live: the card's ticket id is the same before and after"
  );

  // The point of it: after stamping, a rename keeps the ledger key.
  const renamed = Object.assign({}, events.workshops[0], {
    name: "Potions and Pour Decisions",
    date: "2099-11-07"
  });
  assert(
    tickets.workshopIdOf(renamed) === derived,
    "a stamped workshop renamed and moved keeps its id (and its ticket count)"
  );
  assert(stampWorkshopIds(events).length === 0, "a second run stamps nothing");

  /* ---- The real file (red team, 2026-10-09: this used to compare [] with []
     whenever events.json had no workshops, and pass having examined nothing).
     The subject is every real workshop AS STORED, every real market turned
     into an id-less workshop, and three fixtures with awkward names -- so it
     is never empty whatever the CMS holds (asserted), and each stamped id
     must be the one the Worker already derives. ---- */
  const real = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
  );
  const realWorkshops = clone(real.workshops || []);
  const seenSlugs = new Set(realWorkshops.map((w) => tickets.workshopIdOf(w)));
  const unique = (list) =>
    list.filter((w) => {
      const id = tickets.workshopIdOf(w);
      if (!id || seenSlugs.has(id)) return false;
      seenSlugs.add(id);
      return true;
    });
  const asWorkshops = unique(
    []
      .concat(real.upcoming || [], real.past || [])
      .filter((e) => e && e.name && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")))
      .map((e) => ({ name: e.name, date: e.date }))
  );
  const fixtures = unique([
    { name: "Potions & Pour Decisions", date: "2099-11-06" },
    { name: "Y’all Means All: Pride Night!!", date: "2099-06-01" },
    { name: "Café Ñight", date: "2099-12-12" }
  ]);
  const subject = { workshops: realWorkshops.concat(asWorkshops, fixtures) };
  const inUse = subject.workshops.map((w) => tickets.workshopIdOf(w));
  const idless = subject.workshops.filter((w) => !(typeof w.id === "string" && w.id.trim()));
  assert(
    idless.length >= 3,
    `there are id-less workshops to stamp (${idless.length}: ${asWorkshops.length} real markets, ` +
      `${fixtures.length} fixtures) beside ${realWorkshops.length} real workshop(s)`
  );
  stampWorkshopIds(subject, { today: "2000-01-01" });
  const after = subject.workshops.map((w) => w.id);
  assert(
    after.length === inUse.length &&
      after.every((id, i) => typeof id === "string" && id !== "" && id === inUse[i]),
    `on the real events.json, every stamped id equals the id already in use (${after.length})`
  );
  {
    const realCopy = clone(real);
    stampWorkshopIds(realCopy, { previous: clone(real) });
    eq(realCopy, real, "the real events.json, stamped against itself, is unchanged");
  }

  /* ---- Duplicates (red team, 2026-10-09). A copied workshop, or a market
     copied with an explicit id, keeps the id it was copied from; the CMS
     field is read-only, so renaming could not fix the build's refusal. ---- */
  {
    const copied = {
      upcoming: [],
      past: [],
      workshops: [
        { id: "candle-night-2099-11-06", name: "Candle Night", date: "2099-11-06", spots: 12 },
        { id: "candle-night-2099-11-06", name: "Candle Night II", date: "2099-12-04", spots: 8 }
      ]
    };
    assert(buildRefusal(copied) !== null, "a copied workshop's shared id fails the build...");
    const report = stampEventIds(copied);
    eq(
      copied.workshops.map((w) => w.id),
      ["candle-night-2099-11-06", "candle-night-ii-2099-12-04"],
      "...the stamp keeps the id on the original and gives the copy its own slug"
    );
    eq(
      report.restamped,
      [
        {
          from: "candle-night-2099-11-06",
          to: "candle-night-ii-2099-12-04",
          name: "Candle Night II"
        }
      ],
      "...and reports the change"
    );
    assert(buildRefusal(copied) === null, "...after which the build accepts the calendar");
  }
  {
    // The copy is first in the list, the original was renamed since its id
    // was stamped: the copy's own slug is the id, so the copy... would win on
    // the slug rule alone. The version before the merge says who held it.
    const previous = {
      workshops: [{ id: "potions-2099-11-06", name: "Potions Night", date: "2099-11-06" }]
    };
    const current = {
      upcoming: [],
      workshops: [
        { id: "potions-2099-11-06", name: "Potions", date: "2099-11-06" },
        { id: "potions-2099-11-06", name: "Potions Night", date: "2099-11-06" }
      ]
    };
    stampEventIds(current, { previous, today: "2099-01-01" });
    eq(
      current.workshops.map((w) => w.id),
      ["potions-2099-11-06-2", "potions-2099-11-06"],
      "the entry that held the id before the merge keeps it; the copy is re-stamped"
    );
    const noPrevious = clone({
      upcoming: [],
      workshops: [
        { id: "x-night-2099-11-06", name: "X Night Renamed", date: "2099-11-06" },
        { id: "x-night-2099-11-06", name: "X Night", date: "2099-11-06" }
      ]
    });
    stampEventIds(noPrevious);
    eq(
      noPrevious.workshops.map((w) => w.id),
      ["x-night-renamed-2099-11-06", "x-night-2099-11-06"],
      "without a previous version, the entry whose own name and date make the id keeps it"
    );
  }
  {
    const markets = {
      upcoming: [
        { id: "fall-fair-2099-10-01", name: "Fall Fair", date: "2099-10-01" },
        { id: "fall-fair-2099-10-01", name: "Fall Fair", date: "2099-10-08" }
      ],
      past: [{ id: "fall-fair-2099-10-08", name: "Fall Fair", date: "2099-10-08" }],
      workshops: []
    };
    assert(buildRefusal(markets) !== null, "a market copied with its id fails the build...");
    stampEventIds(markets);
    eq(
      markets.upcoming.map((e) => e.id),
      ["fall-fair-2099-10-01", "fall-fair-2099-10-08-2"],
      "...the copy gets its own slug, stepping around an id a past entry already holds"
    );
    assert(buildRefusal(markets) === null, "...and the build accepts it");

    const mixed = {
      upcoming: [{ id: "glow-2099-11-06", name: "Glow Market", date: "2099-11-06" }],
      workshops: [{ id: "glow-2099-11-06", name: "Glow Class", date: "2099-11-06", spots: 5 }]
    };
    stampEventIds(mixed);
    eq(
      [mixed.workshops[0].id, mixed.upcoming[0].id],
      ["glow-2099-11-06", "glow-market-2099-11-06"],
      "a market and a workshop sharing an id: the workshop keeps it (its ledger key)"
    );
  }
  {
    // A new workshop typed with the same name and date as one already
    // stamped: stamping it would write the duplicate, which no rename fixes.
    const twin = {
      upcoming: [],
      workshops: [
        { id: "twin-2099-11-06", name: "Twin", date: "2099-11-06" },
        { name: "Twin", date: "2099-11-06" }
      ]
    };
    stampEventIds(twin);
    eq(
      twin.workshops.map((w) => w.id),
      ["twin-2099-11-06", "twin-2099-11-06-2"],
      "a new workshop whose slug is taken gets a suffix; the stamped one keeps its id"
    );
    assert(buildRefusal(twin) === null, "...and the build accepts it");
  }

  /* ---- A lost id (red team, 2026-10-09): carried forward from the events.json
     before the merge, matched conservatively, never guessed. ---- */
  const today = "2099-01-01";
  {
    // Renamed in the same save that dropped the id (or before it was ever
    // stamped, while the slug was live): the date still matches.
    const previous = {
      workshops: [{ name: "Candle Nite", date: "2099-11-06", price: 40, spots: 12 }]
    };
    const current = {
      upcoming: [],
      workshops: [{ name: "Candle Night", date: "2099-11-06", price: 40, spots: 12 }]
    };
    const report = stampEventIds(current, { previous, today });
    eq(current.workshops[0].id, "candle-nite-2099-11-06", "a rename keeps the published id");
    eq(report.carried, [{ id: "candle-nite-2099-11-06", name: "Candle Night" }], "...reported");
    const withoutPrevious = clone({ workshops: [{ name: "Candle Night", date: "2099-11-06" }] });
    stampEventIds(withoutPrevious);
    eq(
      withoutPrevious.workshops[0].id,
      "candle-night-2099-11-06",
      "...where without --previous it would have become a new ledger key"
    );
  }
  {
    // A save that dropped a stored id that is not the current slug.
    const previous = {
      workshops: [{ id: "old-slug-2099-11-06", name: "Glow Night", date: "2099-11-06" }]
    };
    const current = { workshops: [{ name: "Glow Night", date: "2099-11-06" }] };
    stampEventIds(current, { previous, today });
    eq(
      current.workshops[0].id,
      "old-slug-2099-11-06",
      "a dropped id is put back (same name and date)"
    );

    const moved = { workshops: [{ name: "Glow Night", date: "2099-11-13" }] };
    stampEventIds(moved, { previous, today });
    eq(moved.workshops[0].id, "old-slug-2099-11-06", "...and kept when the date moved too");
  }
  {
    // Last month's class replaced by this month's, in one publish: NOT the
    // same workshop -- it must not inherit a sold-out count.
    const previous = {
      workshops: [{ id: "candle-night-2098-10-06", name: "Candle Night", date: "2098-10-06" }]
    };
    const current = { workshops: [{ name: "Candle Night", date: "2099-11-06" }] };
    stampEventIds(current, { previous, today });
    eq(
      current.workshops[0].id,
      "candle-night-2099-11-06",
      "a new date for a workshop that is already over is a new workshop, not a carried id"
    );

    const unrelated = { workshops: [{ name: "Brand New", date: "2099-12-24" }] };
    stampEventIds(unrelated, {
      previous: { workshops: [{ id: "gone-2099-11-06", name: "Gone", date: "2099-11-06" }] },
      today
    });
    eq(unrelated.workshops[0].id, "brand-new-2099-12-24", "nothing in common: a fresh slug");

    const kept = {
      workshops: [
        { id: "gone-2099-11-06", name: "Gone", date: "2099-11-06" },
        { name: "Other", date: "2099-11-06" }
      ]
    };
    stampEventIds(kept, {
      previous: { workshops: [{ id: "gone-2099-11-06", name: "Gone", date: "2099-11-06" }] },
      today
    });
    eq(
      kept.workshops.map((w) => w.id),
      ["gone-2099-11-06", "other-2099-11-06"],
      "an id still held by a current workshop is never carried to another"
    );
  }
  {
    // Ambiguous: two published workshops on that date, both gone.
    const previous = {
      workshops: [
        { id: "a-2099-11-06", name: "Alpha", date: "2099-11-06" },
        { id: "b-2099-11-06", name: "Beta", date: "2099-11-06" }
      ]
    };
    const current = { workshops: [{ name: "Gamma", date: "2099-11-06" }] };
    const original = clone(current);
    const err = thrown(() => stampEventIds(current, { previous, today }));
    assert(
      err &&
        err.name === "StampError" &&
        /"Gamma" \(2099-11-06\)/.test(err.message) &&
        /"a-2099-11-06"/.test(err.message) &&
        /"b-2099-11-06"/.test(err.message) &&
        /never guessed/.test(err.message),
      "an id-less workshop matching two published ones fails, naming all three"
    );
    eq(current, original, "...and writes nothing");

    const both = {
      workshops: [
        { name: "Delta", date: "2099-11-06" },
        { name: "Epsilon", date: "2099-11-06" }
      ]
    };
    const err2 = thrown(() =>
      stampEventIds(both, {
        previous: { workshops: [{ id: "z-2099-11-06", name: "Zeta", date: "2099-11-06" }] },
        today
      })
    );
    assert(
      err2 && err2.name === "StampError" && /"Delta".*"Epsilon"/.test(err2.message),
      "two id-less workshops matching the same published one fail too"
    );
  }

  /* ---- The command line: `--previous` is optional, and a path that is given
     must exist (a typo must not switch the protection off). Run against the
     real file, where it is a no-op, so the file is left as it was. ---- */
  {
    const script = path.join(__dirname, "stamp-workshop-ids.js");
    const eventsPath = path.join(__dirname, "../assets/data/events.json");
    const bytes = fs.readFileSync(eventsPath, "utf8");
    let missingCode = 0;
    try {
      execFileSync(process.execPath, [script, "--previous", "/nonexistent/events.json"], {
        stdio: "pipe"
      });
    } catch (err) {
      missingCode = err.status;
    }
    assert(missingCode === 1, "--previous with a path that does not exist exits 1");
    const out = execFileSync(process.execPath, [script, `--previous=${eventsPath}`], {
      encoding: "utf8"
    });
    assert(/already has an id/.test(out), "--previous=<the same file> is a no-op");
    assert(fs.readFileSync(eventsPath, "utf8") === bytes, "...and leaves events.json untouched");
  }

  console.log(`\nstamp-workshop-ids.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error("stamp-workshop-ids.test.js crashed:", err);
  process.exit(1);
});
