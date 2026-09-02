/**
 * @fileoverview The owner's daily order digest -- one email, once a day, with a
 * pick list she can work down at the bench.
 *
 * WHY IT EXISTS
 * Stripe emails a receipt per order and the Dashboard shows a list, but neither
 * answers the only question that matters at 7am: what has to go in a box today.
 * A bundle is ONE Stripe line ("Grit & Grace Starter Set x1") that is three
 * jars on the shelf, and a build-your-own box is one line whose contents live
 * only in session metadata. This job expands both, from the same
 * `assets/data/products.json` the shop pages render from, so the list in the
 * email is the list of physical things.
 *
 * WHAT IT NEVER PRINTS
 * The digest is a fulfilment aid, not a copy of the order: buyer FIRST NAME and
 * city/state only. No email addresses, no street addresses, no postcodes, no
 * card details, no gift-card codes, no money. Everything else is a click away
 * in Stripe, which is the system of record (docs/STATE-LAYER.md). A gift order
 * gets the signed print link from routes/gift-note.js instead of the note text.
 *
 * ONCE A DAY, AND ONLY FORWARD
 * The cron fires hourly, so the run is gated twice over:
 *   - `claimDaily` (state/job-state.js) records the New York calendar day, so
 *     24 ticks send one email;
 *   - the newest session id of each run is remembered in job_state under
 *     "order-digest-last", so the next run stops there and an order is never
 *     listed twice even though the query window (26h) deliberately overlaps.
 * The window is wider than a day on purpose: a missed or delayed tick must
 * still catch yesterday's late orders, and the id marker is what makes that
 * overlap free of duplicates.
 *
 * WHY IT LOADS THE CATALOGUE ITSELF
 * `state/site-data.js`'s `loadProductIndex` drops the two fields this job is
 * entirely about -- a bundle's `productIds` and a product's `variants` -- so it
 * would have to be widened for every consumer to serve one. Same fetch-and-
 * cache shape, different projection.
 */

import { escapeHtml } from "./http.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import { giftNoteLink, giftNotesOf } from "./gift-note.js";
import { STRIPE_API_BASE, STRIPE_API_VERSION } from "./stripe.js";
import { claimDaily, getJobState, nyClock, setJobState } from "../state/job-state.js";
import { loadSiteSettings } from "../state/site-data.js";

/** `site.automations.orderDigestHour` when the CMS field is empty. */
export const DEFAULT_DIGEST_HOUR = 7;
/** How far back each run looks. Wider than a day so a missed tick recovers. */
export const DIGEST_WINDOW_HOURS = 26;
export const DIGEST_JOB = "order-digest";
/** job_state key holding the newest session id already reported. */
export const DIGEST_CURSOR_JOB = "order-digest-last";
/** Stripe's list maximum; the shop will not fill one page for years. */
const PAGE_SIZE = 100;
/** A hard stop, so a bad cursor cannot walk the whole account. */
const MAX_PAGES = 10;

const REPLY_TO = "contact@yallternativeliving.com";
const DEFAULT_INTRO =
  "Your set is on the bench. One thing before it ships: a couple of the pieces " +
  "come in more than one size or scent, and we'd rather ask than guess.";

/** The line checkout.js writes for a build-your-own box. */
const BOX_LINE_RE = /^Build-Your-Own Box \(\d+ items?\)$/;
/** Products that are never handed over and never need a size choice. */
const NON_PHYSICAL_CATEGORIES = new Set(["gift-cards"]);

/* ------------------------------------------------------------- catalogue */

async function fetchSiteJson(env, ctx, pathname) {
  const origin = (env && env.SITE_ORIGIN) || "https://yallternativeliving.com";
  const url = `${origin}${pathname}`;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = typeof Request === "function" ? new Request(url) : url;
  let res = cache ? await cache.match(cacheKey) : null;
  if (!res) {
    res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res && res.ok && ctx && cache) {
      const toCache = new Response(res.clone().body, res);
      toCache.headers.set("Cache-Control", "max-age=300");
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
  }
  if (!res || !res.ok) return null;
  return res.json();
}

/** Line names and metadata carry display names, so lookups are case-loose. */
function nameKey(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The options a shopper can still be offered. A sold-out option is dropped --
 * asking "S, M or L?" when S is gone only produces a second email -- unless
 * every option is sold out, in which case the honest answer is all of them.
 */
function optionLabels(entry) {
  const options =
    entry && entry.variants && Array.isArray(entry.variants.options) ? entry.variants.options : [];
  const labels = options
    .filter((o) => o && typeof o.label === "string" && o.label.trim())
    .map((o) => ({ label: o.label.trim(), soldOut: o.soldOut === true }));
  const available = labels.filter((o) => !o.soldOut).map((o) => o.label);
  return available.length ? available : labels.map((o) => o.label);
}

/**
 * `{ byId, byName }` over products AND bundles, carrying the fields the digest
 * needs: the variant option labels and, for a bundle, what is inside it.
 *
 * Degrades to empty maps when products.json is unreachable -- the digest then
 * lists the Stripe line names verbatim, which is worse but still sendable.
 *
 * @returns {Promise<{byId: Map<string,object>, byName: Map<string,object>}>}
 */
export async function loadOrderCatalog(env, ctx) {
  const catalog = { byId: new Map(), byName: new Map() };
  let raw = null;
  try {
    raw = await fetchSiteJson(env, ctx, "/assets/data/products.json");
  } catch (err) {
    console.warn("order-digest: products.json is unreachable:", err && err.message);
    return catalog;
  }
  if (!raw) return catalog;
  const add = (entry, isBundle) => {
    if (!entry || typeof entry.id !== "string") return;
    const record = {
      id: entry.id,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
      category: typeof entry.category === "string" ? entry.category : "",
      isBundle,
      productIds: isBundle && Array.isArray(entry.productIds) ? entry.productIds.slice() : [],
      options: isBundle ? [] : optionLabels(entry)
    };
    catalog.byId.set(record.id, record);
    // First writer wins: a product and a bundle sharing a display name is a
    // catalogue mistake, and silently preferring the later one would make the
    // pick list wrong in a way nobody would notice.
    if (!catalog.byName.has(nameKey(record.name))) catalog.byName.set(nameKey(record.name), record);
  };
  for (const entry of Array.isArray(raw.products) ? raw.products : []) add(entry, false);
  for (const entry of Array.isArray(raw.bundles) ? raw.bundles : []) add(entry, true);
  return catalog;
}

/** A gift card is not picked, packed or sized. */
function isPhysical(entry) {
  return Boolean(entry) && !NON_PHYSICAL_CATEGORIES.has(entry.category);
}

function needsChoice(entry) {
  return Boolean(entry) && isPhysical(entry) && entry.options.length > 0;
}

/* --------------------------------------------------------- session reading */

/** The build-your-own box contents checkout.js recorded, in line order. */
function customBoxContents(session) {
  const metadata = (session && session.metadata) || {};
  return Object.keys(metadata)
    .map((key) => /^custom_box_(\d+)$/.exec(key))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) =>
      String(metadata[m[0]] || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    );
}

function metadataList(session, key) {
  return String(((session && session.metadata) || {})[key] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The products on this order that come in more than one size or scent and had
 * NO option recorded at checkout -- i.e. the things that cannot be packed
 * without asking the buyer.
 *
 * METADATA ONLY, deliberately: the Stripe webhook is handed a session with no
 * `line_items`, and fetching them would put a second Stripe call on the money
 * path. checkout.js records a chosen option only for a plain product line (it
 * goes in the line name), so by construction a product reached through a bundle
 * or a build-your-own box never has one -- which is exactly the case this
 * finds. `retention_product_ids` carries the bundle's own id; the box carries
 * its contents by name in `custom_box_N`.
 *
 * @returns {Array<{id: string, name: string, options: string[], source: string, via: string}>}
 */
export function productsNeedingChoice(session, catalog) {
  const found = new Map();
  const remember = (entry, source, via) => {
    if (!needsChoice(entry) || found.has(entry.id)) return;
    found.set(entry.id, { id: entry.id, name: entry.name, options: entry.options, source, via });
  };

  for (const id of metadataList(session, "retention_product_ids")) {
    const bundle = catalog.byId.get(id);
    if (!bundle || !bundle.isBundle) continue;
    for (const childId of bundle.productIds) {
      remember(catalog.byId.get(childId), "bundle", bundle.name);
    }
  }
  for (const contents of customBoxContents(session)) {
    for (const name of contents) {
      remember(catalog.byName.get(nameKey(name)), "custom-box", "Build-Your-Own Box");
    }
  }
  return Array.from(found.values());
}

/**
 * One Stripe line, split into the entry it names and the option (if any) the
 * shopper picked. checkout.js writes `"<name> (<option>)"` for a chosen
 * variant, `"<name> ($25.00)"` for a gift card and `"Build-Your-Own Box (N
 * items)"` for a box, so the parenthetical is stripped only when the bare name
 * does not itself match the catalogue.
 */
function readLine(description, catalog) {
  const raw = String(description === null || description === undefined ? "" : description).trim();
  if (BOX_LINE_RE.test(raw)) return { raw, entry: null, option: "", isBox: true };
  const direct = catalog.byName.get(nameKey(raw));
  if (direct) return { raw, entry: direct, option: "", isBox: false };
  const m = /^(.*)\s+\(([^()]*)\)$/.exec(raw);
  if (m) {
    const entry = catalog.byName.get(nameKey(m[1]));
    if (entry) return { raw, entry, option: m[2].trim(), isBox: false };
  }
  return { raw, entry: null, option: "", isBox: false };
}

function lineItemsOf(session) {
  const li = session && session.line_items;
  return li && Array.isArray(li.data) ? li.data : [];
}

function firstNameOf(session) {
  const name = String(((session || {}).customer_details || {}).name || "").trim();
  return name ? name.split(/\s+/)[0] : "";
}

/** City and state ONLY. Never line1, never the postcode. */
function placeOf(session) {
  const address = ((session || {}).customer_details || {}).address || {};
  const city = String(address.city || "").trim();
  const state = String(address.state || "").trim();
  return [city, state].filter(Boolean).join(", ");
}

/**
 * One order, reduced to what has to be picked and packed.
 *
 * The variant flag here is wider than `productsNeedingChoice`: with the line
 * items in hand the digest can also see a PLAIN line whose product has options
 * and whose name carries none -- an unsized tank top is just as unpackable as
 * an unsized one inside a bundle, and the owner should see it on the same list.
 * The buyer email (routes/stripe-webhook.js) deliberately stays narrower.
 */
export function describeOrder(session, catalog) {
  const metadata = (session || {}).metadata || {};
  const boxes = customBoxContents(session);
  let boxIndex = 0;
  const lines = [];
  const flagged = new Map();
  const flag = (entry, via) => {
    if (!needsChoice(entry) || flagged.has(entry.id)) return;
    flagged.set(entry.id, { id: entry.id, name: entry.name, options: entry.options, via });
  };

  for (const item of lineItemsOf(session)) {
    const qty = Number(item && item.quantity);
    const parsed = readLine(item && item.description, catalog);
    const line = {
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
      label: parsed.raw || "(unnamed line)",
      contents: []
    };
    if (parsed.isBox) {
      const contents = boxes[boxIndex] || [];
      boxIndex += 1;
      for (const name of contents) {
        const entry = catalog.byName.get(nameKey(name));
        line.contents.push(entry ? entry.name : name);
        flag(entry, "Build-Your-Own Box");
      }
    } else if (parsed.entry && parsed.entry.isBundle) {
      for (const childId of parsed.entry.productIds) {
        const entry = catalog.byId.get(childId);
        line.contents.push(entry ? entry.name : childId);
        flag(entry, parsed.entry.name);
      }
    } else if (parsed.entry && !parsed.option) {
      flag(parsed.entry, parsed.entry.name);
    }
    lines.push(line);
  }

  // A bundle bought in an order whose line items could not be expanded (an old
  // session, or a Stripe response without them) is still caught, from metadata.
  for (const pending of productsNeedingChoice(session, catalog)) {
    flag(catalog.byId.get(pending.id), pending.via);
  }

  const notes = giftNotesOf(session);
  return {
    id: String((session && session.id) || ""),
    firstName: firstNameOf(session),
    place: placeOf(session),
    lines,
    isGift: metadata.is_gift_order === "true" || notes.length > 0,
    giftNoteCount: notes.length,
    pickupMarket: String(metadata.pickup_market || "").trim(),
    needsConfirmation: Array.from(flagged.values())
  };
}

/* ------------------------------------------------------------------ email */

function orderHeading(order) {
  const who = [order.firstName, order.place].filter(Boolean).join(" -- ");
  return who ? `${who} (${order.id})` : order.id;
}

/** The owner's email. Plain text is the real one; the HTML mirrors it. */
export function digestEmail(orders, day) {
  const count = orders.length;
  const subject = count
    ? `${count} order${count === 1 ? "" : "s"} to pack -- ${day}`
    : `No new orders -- ${day}`;

  const textBlocks = orders.map((order) => {
    const rows = order.lines.map((line) => {
      const contents = line.contents.length
        ? line.contents.map((name) => `\n      - ${name}`).join("")
        : "";
      return `  ${line.qty} x ${line.label}${contents}`;
    });
    if (order.pickupMarket) rows.push(`  PICKUP: ${order.pickupMarket}`);
    if (order.isGift) {
      rows.push(
        order.giftNoteLink
          ? `  GIFT -- print the note: ${order.giftNoteLink}`
          : "  GIFT -- no note text on this one"
      );
    }
    if (order.needsConfirmation.length) {
      rows.push(
        "  NEEDS SIZE/SCENT CONFIRMATION: " +
          order.needsConfirmation.map((p) => `${p.name} (${p.options.join(" / ")})`).join("; ")
      );
    }
    return `${orderHeading(order)}\n${rows.join("\n")}`;
  });

  const text = count
    ? `${count} order${count === 1 ? "" : "s"} since the last digest.\n\n` +
      textBlocks.join("\n\n") +
      "\n\nAddresses, totals and everything else are on the orders in Stripe.\n"
    : "No new orders since the last digest.\n";

  const htmlBlocks = orders.map((order) => {
    const rows = order.lines
      .map((line) => {
        const contents = line.contents.length
          ? '<ul style="margin:4px 0 0 18px;padding:0;">' +
            line.contents.map((name) => `<li>${escapeHtml(name)}</li>`).join("") +
            "</ul>"
          : "";
        return `<li>${escapeHtml(`${line.qty} x ${line.label}`)}${contents}</li>`;
      })
      .join("");
    const notes = [];
    if (order.pickupMarket) {
      notes.push(
        `<p style="margin:6px 0;"><strong>Pickup:</strong> ${escapeHtml(order.pickupMarket)}</p>`
      );
    }
    if (order.isGift) {
      notes.push(
        order.giftNoteLink
          ? `<p style="margin:6px 0;"><strong>Gift</strong> -- <a href="${escapeHtml(order.giftNoteLink)}">print the note</a></p>`
          : '<p style="margin:6px 0;"><strong>Gift</strong> -- no note text on this one</p>'
      );
    }
    if (order.needsConfirmation.length) {
      notes.push(
        '<p style="margin:6px 0;color:#8a3b12;"><strong>Needs size/scent confirmation:</strong> ' +
          order.needsConfirmation
            .map((p) => escapeHtml(`${p.name} (${p.options.join(" / ")})`))
            .join("; ") +
          "</p>"
      );
    }
    return (
      '<section style="margin:0 0 22px;padding:0 0 14px;border-bottom:1px solid #e0d8c8;">' +
      `<h2 style="font-size:16px;margin:0 0 6px;">${escapeHtml(orderHeading(order))}</h2>` +
      `<ul style="margin:0;padding-left:18px;">${rows}</ul>` +
      notes.join("") +
      "</section>"
    );
  });

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1b1712;">' +
    `<h1 style="font-size:19px;">${escapeHtml(subject)}</h1>` +
    (count
      ? htmlBlocks.join("") +
        '<p style="font-size:13px;color:#6b5f52;">Addresses, totals and everything else are on the orders in Stripe.</p>'
      : "<p>No new orders since the last digest.</p>") +
    "</div>";

  return { subject, text, html };
}

/**
 * The buyer's "which size?" email. Transactional -- it is a question about an
 * order that has been paid for -- so it carries NO unsubscribe link, and the
 * reply-to is the shop address so an answer lands where a human reads it.
 */
export function sizeConfirmationEmail(products, intro) {
  const lead = String(intro || "").trim() || DEFAULT_INTRO;
  const rows = products.map((p) => ({ name: p.name, options: p.options.join(" / ") }));

  const html =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; ' +
    'background: #17130f; color: #fff; padding: 32px; border-radius: 12px; border: 2px solid #d69b5c;">' +
    '<h1 style="color:#d69b5c;">One quick question about your order</h1>' +
    `<p>${escapeHtml(lead)}</p>` +
    '<ul style="padding-left:18px;">' +
    rows
      .map(
        (row) =>
          `<li style="margin:0 0 8px;"><strong>${escapeHtml(row.name)}</strong> -- ${escapeHtml(row.options)}</li>`
      )
      .join("") +
    "</ul>" +
    "<p>Just hit reply and tell us which you want. Nothing ships until we hear back, " +
    "and a real person reads it.</p>" +
    "</div>";

  const text =
    `${lead}\n\n` +
    rows.map((row) => `  - ${row.name}: ${row.options}`).join("\n") +
    "\n\nJust hit reply and tell us which you want. Nothing ships until we hear " +
    "back, and a real person reads it.\n";

  return { subject: "Quick question before we pack your order", html, text };
}

/* -------------------------------------------------------------------- job */

/** Where the digest goes. Same ladder the gift-note email walks. */
export function digestRecipient(env) {
  return (env && (env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL)) || REPLY_TO;
}

/**
 * One page of completed Checkout Sessions, newest first, with line items.
 */
async function listSessions(env, createdGte, startingAfter) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    status: "complete",
    "created[gte]": String(createdGte)
  });
  params.append("expand[]", "data.line_items");
  if (startingAfter) params.set("starting_after", startingAfter);
  const doFetch = (env && env.fetchImpl) || fetch;
  const res = await doFetch(`${STRIPE_API_BASE}/checkout/sessions?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION
    }
  });
  if (!res || !res.ok) {
    throw new Error(`order-digest: Stripe returned ${res ? res.status : "no response"}.`);
  }
  return res.json();
}

function isPaid(session) {
  return (
    session &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required")
  );
}

/**
 * Every paid session since `createdGte`, stopping at `lastSeenId`.
 *
 * Stripe lists newest first, so the id remembered from the previous run is a
 * hard floor: once it appears, everything after it has already been reported
 * and pagination stops. Unpaid sessions are skipped but do NOT stop the walk.
 */
export async function collectSessions(env, createdGte, lastSeenId) {
  const orders = [];
  let startingAfter = null;
  let newestId = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await listSessions(env, createdGte, startingAfter);
    const data = list && Array.isArray(list.data) ? list.data : [];
    if (!data.length) return { orders, newestId };
    for (const session of data) {
      if (!session || typeof session.id !== "string") continue;
      if (!newestId) newestId = session.id;
      if (lastSeenId && session.id === lastSeenId) return { orders, newestId };
      if (isPaid(session)) orders.push(session);
    }
    if (!list.has_more) return { orders, newestId };
    startingAfter = data[data.length - 1].id;
  }
  console.warn("order-digest: stopped after", MAX_PAGES, "pages of Checkout Sessions");
  return { orders, newestId };
}

/**
 * The cron entry point. Called hourly from `scheduled` in workers/checkout.js;
 * sends at most one email per New York calendar day.
 *
 * @returns {Promise<object>} what it did, for the cron's log
 */
export async function runOrderDigest(env, ctx, now = Date.now()) {
  if (!env || !env.STATE_DB) return { skipped: "no-state-db" };
  if (!env.STRIPE_SECRET_KEY) {
    console.error("order-digest: STRIPE_SECRET_KEY is not configured; no digest sent");
    return { skipped: "no-stripe-key" };
  }
  if (!env.RESEND_API_KEY) {
    console.error("order-digest: RESEND_API_KEY is not configured; no digest sent");
    return { skipped: "no-resend-key" };
  }

  const site = await loadSiteSettings(env, ctx);
  if (site.enableOrderDigest === false) return { skipped: "disabled" };
  const automations =
    (site.automations && typeof site.automations === "object" && site.automations) || {};
  const configuredHour = Number(automations.orderDigestHour);
  const hour =
    Number.isFinite(configuredHour) && configuredHour >= 0 && configuredHour <= 23
      ? Math.floor(configuredHour)
      : DEFAULT_DIGEST_HOUR;

  // Claims the day BEFORE the work, like every other daily job here: a job that
  // claimed afterwards would send the digest again on the next tick whenever
  // Stripe or Resend was slow enough to overlap two crons.
  // `claimDaily` is false both before the configured hour and after the day has
  // already been claimed -- from here they are the same answer: not today.
  if (!(await claimDaily(env.STATE_DB, DIGEST_JOB, hour, now))) return { skipped: "not-claimed" };

  const lastSeenId = await getJobState(env.STATE_DB, DIGEST_CURSOR_JOB);
  const createdGte = Math.floor((now - DIGEST_WINDOW_HOURS * 3600 * 1000) / 1000);
  const { orders: sessions, newestId } = await collectSessions(env, createdGte, lastSeenId);

  // The cursor moves even when nothing is sent: the point of it is "everything
  // up to here has been considered", not "has been emailed".
  if (newestId) await setJobState(env.STATE_DB, DIGEST_CURSOR_JOB, newestId, now);

  const sendWhenEmpty = String(env.ORDER_DIGEST_WHEN_EMPTY || "") === "true";
  if (!sessions.length && !sendWhenEmpty) return { sent: false, orders: 0 };

  const catalog = await loadOrderCatalog(env, ctx);
  const orders = [];
  for (const session of sessions) {
    const order = describeOrder(session, catalog);
    if (order.giftNoteCount && env.MAGIC_LINK_SECRET) {
      try {
        order.giftNoteLink = await giftNoteLink(
          env.MAGIC_LINK_SECRET,
          order.id,
          env.SITE_ORIGIN || "https://yallternativeliving.com",
          { now }
        );
      } catch (err) {
        // A note that cannot be signed is still readable on the order in
        // Stripe; losing the link must not lose the whole digest.
        console.warn("order-digest: could not mint a gift-note link:", err && err.message);
      }
    }
    orders.push(order);
  }

  const day = nyClock(now).day;
  const body = digestEmail(orders, day);
  const delivery = await sendEmail(
    env,
    { from: fromAddress(env), to: digestRecipient(env), reply_to: REPLY_TO, ...body },
    `order-digest-${day}`
  );
  return { sent: delivery.ok, status: delivery.status, orders: orders.length, day };
}
