/**
 * @fileoverview Workshop tickets: the page and the Worker must agree.
 *
 * The Buy Tickets button on an events-page workshop card adds a cart line
 * whose id the BUILD computes (scripts/build-site-data.js
 * mergeWorkshopsIntoUpcoming -> `ticketId`), and the Worker prices that id
 * from its own reading of events.json (workers/state/tickets.js
 * ticketEntriesOf). Two implementations of the same rule -- the slug, and
 * which workshops sell on the site -- are pinned together here, against the
 * real events.json and against cases that exercise the edges. If they drift,
 * a card offers a ticket checkout refuses as "Product not found".
 *
 * Run: node scripts/worker-tickets.test.js
 */

const fs = require("fs");
const path = require("path");
const build = require("./build-site-data.js");

let passed = 0;
let failed = 0;

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

  /* ---- The slug ---- */
  const realEvents = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/data/events.json"), "utf8")
  );
  const names = []
    .concat(realEvents.upcoming || [], realEvents.past || [], realEvents.workshops || [])
    .map((e) => [e.name, e.date].filter(Boolean).join(" "));
  assert(names.length > 0, "events.json has events to compare slugs on");
  names.push(
    "Potions & Pour Decisions 2026-11-06",
    "Y’all Means All: Pride Night!! 2027-06-01",
    "  Leading/Trailing  ",
    "Café Ñight 2026-12-12",
    ""
  );
  for (const n of names) {
    eq(tickets.slugify(n), build.slugify(n), `slugify agrees on ${JSON.stringify(n)}`);
  }

  /* ---- Which workshops sell on the site ---- */
  const cases = [
    { price: 60, spots: 12 },
    { price: 60, spots: 0 },
    { price: "60", spots: "12" },
    { price: 0, spots: 12 },
    { price: 60 },
    { spots: 12 },
    { price: 60, spots: 12.5 },
    { price: 60, spots: -1 },
    { price: 60, spots: 12, ticketUrl: "https://square.link/u/x" },
    { price: 60, spots: 12, ticketUrl: "   " },
    { price: -5, spots: 3 },
    null
  ];
  for (const c of cases) {
    eq(
      tickets.sellsTicketsOnSite(c),
      build.workshopSellsOnSite(c),
      `the page and the Worker agree whether ${JSON.stringify(c)} sells on the site`
    );
  }

  /* ---- Ids: what the build puts on the card is what the Worker prices ---- */
  const fixture = {
    upcoming: [],
    past: [],
    workshops: [
      { name: "Potions Night", date: "2099-11-06", price: 60, spots: 12 },
      { id: "custom-id", name: "Named", date: "2099-12-01", price: 45, spots: 8 },
      { name: "Square Night", date: "2099-12-02", price: 45, spots: 8, ticketUrl: "https://x.y" },
      { name: "No Price Yet", date: "2099-12-03" }
    ]
  };
  const built = build.mergeWorkshopsIntoUpcoming(JSON.parse(JSON.stringify(fixture)));
  const cardIds = built.upcoming.map((e) => e.ticketId).filter(Boolean);
  const workerIds = tickets.ticketEntriesOf(fixture, "2000-01-01").map((t) => t.id);
  eq(
    cardIds,
    ["ticket-potions-night-2099-11-06", "ticket-custom-id"],
    "the build gives a ticket id only to workshops selling on the site"
  );
  eq(workerIds, cardIds, "the Worker prices exactly the ticket ids the cards carry");
  assert(
    built.upcoming.every((e) => e.kind === "workshop") && !("workshops" in built),
    "workshops are folded into upcoming with kind 'workshop', and the list removed"
  );

  const realBuilt = build.mergeWorkshopsIntoUpcoming(JSON.parse(JSON.stringify(realEvents)));
  eq(
    realBuilt.upcoming.map((e) => e.ticketId).filter(Boolean),
    tickets.ticketEntriesOf(realEvents, "2000-01-01").map((t) => t.id),
    "on the real events.json, card ticket ids and Worker ticket ids match"
  );

  /* ---- Over is over ---- */
  eq(
    tickets.ticketEntriesOf(fixture, "2099-11-07").map((t) => t.id),
    ["ticket-custom-id"],
    "the day after a workshop, its tickets are off sale"
  );
  eq(
    tickets.ticketEntriesOf(fixture, "2099-11-06").map((t) => t.id),
    ["ticket-potions-night-2099-11-06", "ticket-custom-id"],
    "...but still on sale on the day itself"
  );

  /* ---- Two workshops cannot share an id ---- */
  let threw = null;
  try {
    build.mergeWorkshopsIntoUpcoming({
      upcoming: [],
      workshops: [
        { name: "Twice", date: "2099-01-01" },
        { name: "Twice", date: "2099-01-01" }
      ]
    });
  } catch (e) {
    threw = e;
  }
  assert(
    threw && /same name and date/.test(threw.message),
    "the build refuses two workshops with the same name and date"
  );

  console.log(`\nworker-tickets.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error("worker-tickets.test.js crashed:", err);
  process.exit(1);
});
