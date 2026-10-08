/**
 * @fileoverview Workshop tickets, as catalogue entries.
 *
 * A workshop or class is a CMS entry in `assets/data/events.json`'s
 * `workshops` list (admin/config.yml, "Workshops & classes"). When it has a
 * price and a number of spots, and no outside ticket link, tickets are sold on
 * the site: the events page renders a Buy Tickets button whose cart line id is
 * `ticket-<workshop id>`, and this module turns the same entry into a catalogue
 * entry the Worker treats like any other tracked product -- priced server-side
 * from the CMS, capped by the inventory ledger (spots = `stock`), held while a
 * Stripe session is open and committed when it is paid.
 *
 * Both readers of the ledger MUST see the same tickets:
 *   - workers/checkout.js loadCatalog() (the money path), and
 *   - workers/state/site-data.js loadProductIndex() (/api/inventory).
 * syncInventory() marks any row the tracked list it is given does not name as
 * untracked, and an untracked row reseeds FROM SCRATCH the next time it is
 * tracked. One reader without tickets would therefore erase every ticket sold
 * the next time the other one synced. Hence one helper here, and both callers
 * refuse to sync at all when they could not read the calendar.
 *
 * The workshop id is the CMS `id` when set, else the same slug of
 * "<name> <date>" scripts/build-site-data.js ensureEventId() assigns, so the
 * id on the page and the id the Worker prices are one and the same without
 * the CMS having to store it. scripts/worker-tickets.test.js pins the two
 * slug functions together against the real events.json.
 */

export const TICKET_ID_PREFIX = "ticket-";
export const TICKET_CATEGORY = "workshops";

/** Mirror of scripts/build-site-data.js slugify(). Keep them identical. */
export function slugify(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The id a workshop is known by on the page and in the ledger. */
export function workshopIdOf(workshop) {
  if (!workshop || typeof workshop !== "object") return "";
  if (typeof workshop.id === "string" && workshop.id.trim()) return workshop.id.trim();
  return slugify([workshop.name, workshop.date].filter(Boolean).join(" "));
}

/** Today's calendar date in America/New_York, YYYY-MM-DD. */
export function easternToday(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(now));
}

/**
 * True when this workshop sells its tickets on the site: a positive price,
 * a whole number of spots, and no outside ticket link (a workshop sold on
 * Square or Eventbrite links out instead and is not sold here).
 */
export function sellsTicketsOnSite(workshop) {
  if (!workshop || typeof workshop !== "object") return false;
  if (typeof workshop.ticketUrl === "string" && workshop.ticketUrl.trim()) return false;
  const price = Number(workshop.price);
  const spots = Number(workshop.spots);
  return Number.isFinite(price) && price > 0 && Number.isInteger(spots) && spots >= 0;
}

function ticketName(workshop) {
  const when = workshop.dateLabel || workshop.date || "";
  const where = [workshop.venue, workshop.location].filter(Boolean).join(", ");
  const detail = [when, where].filter(Boolean).join(" · ");
  return `Ticket: ${workshop.name}${detail ? ` (${detail})` : ""}`;
}

/**
 * Catalogue entries for every workshop selling tickets on the site whose last
 * day has not passed (Eastern time -- the day after, it is gone from the
 * calendar and from here, and nobody can buy a ticket to it).
 *
 * @param {object} events events.json as published
 * @param {string} todayStr YYYY-MM-DD, Eastern
 * @returns {object[]} `{id, name, category, price, stock, image, isTicket, workshopId}`
 */
export function ticketEntriesOf(events, todayStr) {
  const list = events && Array.isArray(events.workshops) ? events.workshops : [];
  const out = [];
  const seen = new Set();
  for (const workshop of list) {
    if (!sellsTicketsOnSite(workshop) || !workshop.name) continue;
    const lastDay = String(workshop.endDate || workshop.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay) || lastDay < todayStr) continue;
    const workshopId = workshopIdOf(workshop);
    if (!workshopId || seen.has(workshopId)) continue;
    seen.add(workshopId);
    out.push({
      id: TICKET_ID_PREFIX + workshopId,
      name: ticketName(workshop),
      category: TICKET_CATEGORY,
      price: Math.round(Number(workshop.price) * 100) / 100,
      stock: Number(workshop.spots),
      image: typeof workshop.image === "string" && workshop.image ? workshop.image : null,
      isTicket: true,
      workshopId
    });
  }
  return out;
}
