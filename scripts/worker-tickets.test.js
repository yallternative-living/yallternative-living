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

/**
 * assets/js/main.js under just enough of a DOM to load: its card renderers
 * are pure string functions, the rest only has to not throw at load. Each
 * suite runs in its own process (scripts/run-unit-tests.js), so these
 * globals do not leak.
 */
function loadMainJs() {
  const el = () => ({
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    style: {},
    dataset: {},
    appendChild: (c) => c,
    insertBefore: (c) => c,
    querySelector: () => el(),
    querySelectorAll: () => []
  });
  const doc = {
    readyState: "loading",
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => el(),
    createElement: el,
    documentElement: el(),
    body: el(),
    head: el()
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.document = doc;
  global.localStorage = storage;
  global.window = {
    document: doc,
    localStorage: storage,
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: {
      href: "https://yallternativeliving.com/",
      search: "",
      hash: "",
      pathname: "/",
      hostname: "yallternativeliving.com",
      origin: "https://yallternativeliving.com"
    }
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    return require("../assets/js/main.js");
  } finally {
    console.warn = warn;
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
    // A blank "Tickets available" saves as null or "" -- not 0 spots.
    { price: 60, spots: null },
    { price: 60, spots: "" },
    { price: 60, spots: "   " },
    { price: 60, spots: true },
    { price: 60, spots: "0" },
    null
  ];
  for (const c of cases) {
    eq(
      tickets.sellsTicketsOnSite(c),
      build.workshopSellsOnSite(c),
      `the page and the Worker agree whether ${JSON.stringify(c)} sells on the site`
    );
  }

  /* ---- A blank spots field is "coming soon", everywhere (red team, 2026-10-09) ----
     Number(null) and Number("") are 0, so a workshop whose "Tickets
     available" was left blank used to show Sold Out on the card and be
     refused as sold out by the Worker, while the build warned "Tickets
     coming soon". Parity alone could not catch it: both sides agreed on the
     wrong answer. */
  for (const blank of [null, "", "  ", undefined]) {
    const w = { name: "Blank Spots", date: "2099-12-05", price: 40, spots: blank };
    const label = `spots ${JSON.stringify(blank === undefined ? "(absent)" : blank)}`;
    eq(tickets.sellsTicketsOnSite(w), false, `${label}: the Worker does not sell it`);
    eq(build.workshopSellsOnSite(w), false, `${label}: the build does not sell it`);
    eq(tickets.ticketEntriesOf({ workshops: [w] }, "2000-01-01"), [], `${label}: no ticket entry`);
    const merged = build.mergeWorkshopsIntoUpcoming({ upcoming: [], workshops: [{ ...w }] });
    assert(!("ticketId" in merged.upcoming[0]), `${label}: the card gets no ticket id`);
  }
  eq(
    tickets
      .ticketEntriesOf(
        { workshops: [{ name: "Zero", date: "2099-12-05", price: 40, spots: 0 }] },
        "2000-01-01"
      )
      .map((t) => t.stock),
    [0],
    "an explicit 0 is still a real count (sold out)"
  );
  {
    // The card itself (assets/js/main.js workshopTicketHTML), from what the
    // build hands it -- and from an entry that carries a ticketId anyway.
    const main = loadMainJs();
    const card = (w) => main.eventCardHTML(Object.assign({ id: "blank", kind: "workshop" }, w));
    const blankBuilt = build.mergeWorkshopsIntoUpcoming({
      upcoming: [],
      workshops: [{ name: "Blank", date: "2099-12-05", price: 40, spots: null }]
    }).upcoming[0];
    const built = card(blankBuilt);
    assert(
      built.includes("Tickets coming soon") && !/Sold Out|Buy Tickets/.test(built),
      "card, blank spots from the build: 'Tickets coming soon', not Sold Out"
    );
    const forced = card({ ...blankBuilt, ticketId: "ticket-blank-2099-12-05" });
    assert(
      forced.includes("Tickets coming soon") && !/Sold Out|Buy Tickets/.test(forced),
      "card, blank spots with a ticketId anyway: still 'Tickets coming soon'"
    );
    const zero = card({ ...blankBuilt, spots: 0, ticketId: "ticket-blank-2099-12-05" });
    assert(/Sold Out/.test(zero), "card, an explicit 0 spots: Sold Out");
    const twelve = card({ ...blankBuilt, spots: 12, ticketId: "ticket-blank-2099-12-05" });
    assert(twelve.includes("Buy Tickets"), "card, 12 spots: Buy Tickets");
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
  /* That comparison is [] vs [] whenever every real workshop links out (as
     the only one did on 2026-10-08), so it can examine nothing. The same
     real workshops, switched to selling on the site, must still agree -- and
     there must be some to compare. */
  const onSite = JSON.parse(JSON.stringify(realEvents));
  onSite.workshops = (onSite.workshops || []).map((w) =>
    Object.assign({}, w, { ticketUrl: "", price: Number(w.price) > 0 ? w.price : 25, spots: 10 })
  );
  const onSiteCards = build
    .mergeWorkshopsIntoUpcoming(JSON.parse(JSON.stringify(onSite)))
    .upcoming.map((e) => e.ticketId)
    .filter(Boolean);
  assert(
    onSiteCards.length === (realEvents.workshops || []).length && onSiteCards.length > 0,
    "the real workshops, sold on the site, all get a card ticket id (and there are some)"
  );
  eq(
    tickets.ticketEntriesOf(onSite, "2000-01-01").map((t) => t.id),
    onSiteCards,
    "...and the Worker prices exactly those ids"
  );

  /* ---- A card the Worker would refuse is a build error, not a dead button ---- */
  for (const [w, label] of [
    [{ date: "2099-11-20", price: 60, spots: 5 }, "no name"],
    [{ name: "Dateless", price: 60, spots: 5 }, "no date"],
    [{ name: "US date", date: "11/20/2099", price: 60, spots: 5 }, "a date not written YYYY-MM-DD"],
    [
      { name: "Bad end", date: "2099-11-20", endDate: "Nov 21", price: 60, spots: 5 },
      "an end date not written YYYY-MM-DD"
    ]
  ]) {
    let err = null;
    try {
      build.mergeWorkshopsIntoUpcoming({ upcoming: [], workshops: [w] });
    } catch (e) {
      err = e;
    }
    assert(
      err && /YYYY-MM-DD|name and a date/.test(err.message),
      `the build refuses a workshop with ${label}`
    );
  }

  /* ---- A market cannot take a workshop's id ---- */
  const clash = build.mergeWorkshopsIntoUpcoming({
    upcoming: [{ name: "Potions Night", date: "2099-11-06", type: "Market" }],
    past: [],
    workshops: [{ name: "Potions Night", date: "2099-11-06", price: 60, spots: 12 }]
  });
  build.assignEventIds(clash);
  const clashIds = clash.upcoming.map((e) => e.id);
  assert(
    new Set(clashIds).size === 2 && clashIds.includes("potions-night-2099-11-06"),
    "a market with no id is given one around the workshop's, never the same"
  );
  eq(
    clash.upcoming.find((e) => e.kind === "workshop").id,
    "potions-night-2099-11-06",
    "...and the workshop keeps its id (its ticket's ledger key)"
  );
  let dupErr = null;
  try {
    build.assignEventIds({
      upcoming: [
        { id: "same", name: "A", date: "2099-01-01" },
        { id: "same", name: "B", date: "2099-01-01" }
      ],
      past: []
    });
  } catch (e) {
    dupErr = e;
  }
  assert(
    dupErr && /have the same ID, "same"/.test(dupErr.message),
    "two upcoming events with one id fail the build"
  );
  /* ...and the message names the ID field as the cause and a fix that works:
     the field is read-only in the CMS, so "rename one of them" (what it used
     to say) could not fix a copied entry (red team, 2026-10-09). */
  assert(
    dupErr &&
      /"A" and "B"/.test(dupErr.message) &&
      /ID field causes this/.test(dupErr.message) &&
      /renaming will not fix it/.test(dupErr.message) &&
      /stamp-workshop-ids\.js/.test(dupErr.message),
    "...naming both events, the ID field as the cause, and the stamp script as the fix"
  );

  /* ---- The ticket image is a site path, or the logo ---- */
  const imgOf = (image) =>
    tickets.ticketEntriesOf(
      { workshops: [{ name: "Img", date: "2099-01-01", price: 5, spots: 1, image }] },
      "2000-01-01"
    )[0].image;
  eq(imgOf("/assets/img/potions.jpg"), "/assets/img/potions.jpg", "a site image path is kept");
  eq(imgOf("https://example.com/x.jpg"), null, "an outside image URL falls back to the logo");
  eq(imgOf("//example.com/x.jpg"), null, "a protocol-relative image URL falls back to the logo");
  eq(imgOf(""), null, "no image falls back to the logo");

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
  let copied = null;
  try {
    build.mergeWorkshopsIntoUpcoming({
      upcoming: [],
      workshops: [
        { id: "candle-night-2099-11-06", name: "Candle Night", date: "2099-11-06" },
        { id: "candle-night-2099-11-06", name: "Candle Night II", date: "2099-12-04" }
      ]
    });
  } catch (e) {
    copied = e;
  }
  assert(
    copied &&
      /same Workshop ID, "candle-night-2099-11-06"/.test(copied.message) &&
      /"Candle Night" and "Candle Night II"/.test(copied.message) &&
      /renaming will not fix it/.test(copied.message) &&
      /stamp-workshop-ids\.js/.test(copied.message),
    "a copied workshop's shared id fails the build naming the Workshop ID field and the fix"
  );

  console.log(`\nworker-tickets.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error("worker-tickets.test.js crashed:", err);
  process.exit(1);
});
