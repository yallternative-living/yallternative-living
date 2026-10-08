/**
 * @fileoverview scripts/stamp-workshop-ids.js: a workshop's id is written
 * once, as the very slug the build and the Worker already derive, and never
 * changes after -- so a rename cannot reset the ticket count.
 *
 * Run: node scripts/stamp-workshop-ids.test.js
 */

const fs = require("fs");
const path = require("path");
const { stampWorkshopIds } = require("./stamp-workshop-ids.js");
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
  const before = JSON.parse(JSON.stringify(events));
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
    build.mergeWorkshopsIntoUpcoming(
      JSON.parse(JSON.stringify({ upcoming: [], workshops: [before.workshops[0]] }))
    ).upcoming[0].ticketId ===
      build.mergeWorkshopsIntoUpcoming(
        JSON.parse(JSON.stringify({ upcoming: [], workshops: [events.workshops[0]] }))
      ).upcoming[0].ticketId,
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

  // The real file: running the script there must be a no-op or a pure fill.
  const real = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
  );
  const realIds = (real.workshops || []).map((w) => tickets.workshopIdOf(w));
  stampWorkshopIds(real);
  assert(
    JSON.stringify((real.workshops || []).map((w) => w.id)) === JSON.stringify(realIds),
    "on the real events.json, every stamped id equals the id already in use"
  );

  console.log(`\nstamp-workshop-ids.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error("stamp-workshop-ids.test.js crashed:", err);
  process.exit(1);
});
