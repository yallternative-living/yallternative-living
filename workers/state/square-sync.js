/**
 * @fileoverview The register's side of the inventory ledger, in D1: which
 * Square item is which product, and which Square orders have already been
 * counted off the shelf.
 *
 * WHY THIS EXISTS
 * The shop sells in two places -- the site, and a Square register at markets
 * and pop-ups -- off ONE shelf. Before this module the site's inventory ledger
 * (workers/state/inventory.js) only ever heard about the site's own sales, so
 * twelve balms sold on a Saturday at the market left the site still offering
 * twelve balms until the owner recounted by hand. This is the bookkeeping the
 * webhook route (workers/routes/square-webhook.js) needs to close that gap in
 * both directions: Square sales count the shelf down, and the shelf's live
 * count is pushed back to the register.
 *
 * THE MAP IS THE SKU
 * Square knows items by opaque variation ids; the site knows products by
 * their ids (`lavender-soak`). The join the owner can actually maintain is
 * the SKU field in the Square Dashboard, which is free text: set an item's
 * SKU to the product id and it is mapped. `resolveSku` also accepts
 * `<product id>/<anything>` (one SKU per size, all counting the same
 * product -- the site tracks stock per product, not per variant) and any
 * string listed under a product's `squareSkus` in the CMS, for a register
 * whose SKUs already exist and should not be retyped. Bundle ids resolve
 * too, and expand to their members like an online bundle does.
 *
 * ONE ROW PER ORDER, NOT PER EVENT
 * Square sends `payment.updated` per PAYMENT. A split tender (part card, part
 * cash) is two payments for one sale, and Square redelivers any event that
 * did not get a 2xx. webhook-events.js claims the event id; this table claims
 * the ORDER id, so however many payments and deliveries one sale produces, it
 * is deducted once. lines_json records what was deducted so a full refund
 * restores exactly that.
 *
 * THE STATE MACHINE (square_sales.state)
 *   pending   --apply-->    applied     (the shelf moved: on_hand -= qty)
 *   applied   --restock-->  restocked   (the whole order refunded: on_hand += qty)
 * The claim is the INSERT of the `pending` row; the deduction and the move
 * to `applied` are ONE batch, every inventory UPDATE guarded by the row still
 * being `pending` (inventory.js deductOnHand's guard/trailing contract). So a
 * crash between claim and deduction leaves a `pending` row that the next
 * delivery resumes, and two deliveries racing on it both run the batch but
 * only one finds the row `pending` -- the other's UPDATEs match nothing. The
 * first version wrote the claim and the deduction separately, which a dying
 * isolate could turn into a sale the shelf never heard about while every
 * retry was told "duplicate" (red team, 2026-09-10). Restock is the same
 * shape, keyed on `applied`.
 *
 * FAIL OPEN, LIKE THE LEDGER
 * Nothing here is on the money path -- a Square sale has already been paid --
 * but the callers still catch and log rather than let a mapping problem take
 * the Worker's webhook handler down: an unmapped item is an owner alert, not
 * an error.
 */

import { addOnHand, deductOnHand } from "./inventory.js";

/** square_sales rows older than this are swept; a refund later than that is a hand adjustment. */
export const SALES_RETENTION_DAYS = 90;

/** Below D1's 100-parameter limit per statement, with room for the fixed binds. */
const BIND_CHUNK = 90;

/** How a SKU is compared: trimmed, case-folded, inner whitespace collapsed. */
export function normalizeSku(sku) {
  return String(sku === null || sku === undefined ? "" : sku)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Which catalogue entry does this Square SKU mean?
 *
 *   1. the SKU is an entry's id                       -> that entry
 *   2. the SKU is `<id>/x`, `<id>:x`, `<id>|x`, `<id> x` -> that entry
 *   3. the SKU is listed in some entry's `squareSkus`  -> that entry
 *   4. otherwise                                        -> null
 *
 * `index` is site-data.js's product index (products AND bundles). Comparison
 * is case-insensitive and whitespace-tolerant on both sides, because the
 * Square Dashboard's SKU field is typed by hand at a market table.
 *
 * @returns {{ id: string, kind: "product"|"bundle" } | null}
 */
export function resolveSku(sku, index) {
  const wanted = normalizeSku(sku);
  if (!wanted || !index || typeof index.get !== "function") return null;
  const kindOf = (entry) =>
    Array.isArray(entry.productIds) && entry.productIds.length ? "bundle" : "product";

  const byId = new Map();
  for (const [id, entry] of index) byId.set(normalizeSku(id), { id, entry });

  const exact = byId.get(wanted);
  if (exact) return { id: exact.id, kind: kindOf(exact.entry) };

  const head = wanted.split(/[/:|\s]/, 1)[0];
  if (head && head !== wanted) {
    const prefixed = byId.get(head);
    if (prefixed) return { id: prefixed.id, kind: kindOf(prefixed.entry) };
  }

  for (const [id, entry] of index) {
    const aliases = Array.isArray(entry.squareSkus) ? entry.squareSkus : [];
    if (aliases.some((alias) => normalizeSku(alias) === wanted)) {
      return { id, kind: kindOf(entry) };
    }
  }
  return null;
}

/**
 * `[{productId, qty}]` for one resolved line: a product is itself; a bundle
 * is each member, `qty` times. Members the catalogue does not know are kept
 * (the ledger skips what it does not track) so the caller's record of what
 * was sold is complete.
 */
export function expandLine(resolved, qty, index) {
  const n = Math.floor(Number(qty));
  if (!resolved || !Number.isFinite(n) || n <= 0) return [];
  if (resolved.kind === "bundle") {
    const entry = index && index.get(resolved.id);
    const members = entry && Array.isArray(entry.productIds) ? entry.productIds : [];
    return members.map((productId) => ({ productId, qty: n }));
  }
  return [{ productId: resolved.id, qty: n }];
}

/** Sums duplicate product ids into one line each, dropping non-positive qty. */
export function mergeLines(lines) {
  const byProduct = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line.productId !== "string") continue;
    const qty = Math.floor(Number(line.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    byProduct.set(line.productId, (byProduct.get(line.productId) || 0) + qty);
  }
  return [...byProduct].map(([productId, qty]) => ({ productId, qty }));
}

function assertOrderId(orderId) {
  if (typeof orderId !== "string" || !orderId.trim() || orderId.length > 255) {
    throw new TypeError("square-sync: orderId must be a non-empty string.");
  }
  return orderId.trim();
}

/* ------------------------------------------------------------- square_sales */

/**
 * Claims a Square order: one `pending` row, INSERT OR IGNORE. `claimed` is
 * true for the first caller; every later payment on the same order and every
 * redelivery gets false plus the row's current `state`, so a caller that
 * finds it still `pending` knows a previous attempt died before applying and
 * resumes with applySquareSale (which reads the lines this row recorded).
 *
 * @param {object} db D1 binding
 * @param {string} orderId Square order id
 * @param {Array<{productId: string, qty: number}>} lines what will be deducted
 * @param {string|null} locationId Square location the sale happened at
 * @returns {Promise<{claimed: boolean, state: string}>}
 */
export async function claimSquareSale(db, orderId, lines, locationId, now = Date.now()) {
  const id = assertOrderId(orderId);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO square_sales (order_id, state, lines_json, location_id, sold_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      id,
      JSON.stringify(mergeLines(lines)),
      typeof locationId === "string" ? locationId.slice(0, 64) : null,
      now,
      now
    )
    .run();
  if ((res && res.meta && res.meta.changes) === 1) return { claimed: true, state: "pending" };
  const row = await db
    .prepare("SELECT state FROM square_sales WHERE order_id = ?")
    .bind(id)
    .first();
  return { claimed: false, state: row ? String(row.state) : "unknown" };
}

function parseLines(row) {
  try {
    return mergeLines(JSON.parse(String(row.lines_json)));
  } catch {
    return [];
  }
}

/**
 * Counts a `pending` sale off the shelf and marks it `applied`, in one
 * batch (see the file header). Returns null when the order has no `pending`
 * row (never claimed, or already applied), and `raced: true` when another
 * delivery moved it first -- in which case `applied` is empty and nothing
 * should be alerted on.
 *
 * @returns {Promise<{raced: boolean, lines: Array, applied: Array, soldOut: string[], untracked: string[]}|null>}
 */
export async function applySquareSale(db, orderId, now = Date.now()) {
  const id = assertOrderId(orderId);
  const row = await db
    .prepare("SELECT lines_json FROM square_sales WHERE order_id = ? AND state = 'pending'")
    .bind(id)
    .first();
  if (!row) return null;
  const lines = parseLines(row);
  const out = await deductOnHand(db, lines, now, {
    guard: {
      sql: "EXISTS (SELECT 1 FROM square_sales WHERE order_id = ? AND state = 'pending')",
      binds: [id]
    },
    trailing: [
      db
        .prepare(
          "UPDATE square_sales SET state = 'applied', updated_at = ? WHERE order_id = ? AND state = 'pending'"
        )
        .bind(now, id)
    ]
  });
  const flip = out.trailing[out.trailing.length - 1];
  const moved = Boolean(flip && flip.meta && Number(flip.meta.changes) > 0);
  if (!moved) return { raced: true, lines, applied: [], soldOut: [], untracked: out.untracked };
  return {
    raced: false,
    lines,
    applied: out.applied,
    soldOut: out.soldOut,
    untracked: out.untracked
  };
}

/**
 * Puts an `applied` sale's units back and marks it `restocked`, in one batch
 * guarded the same way. null when there is no `applied` row (a second refund
 * event on the same order, or an order this ledger never counted); `raced`
 * when another delivery restocked it first.
 *
 * @returns {Promise<{raced: boolean, lines: Array, returned: Array, untracked: string[]}|null>}
 */
export async function restockSquareSale(db, orderId, now = Date.now()) {
  const id = assertOrderId(orderId);
  const row = await db
    .prepare("SELECT lines_json FROM square_sales WHERE order_id = ? AND state = 'applied'")
    .bind(id)
    .first();
  if (!row) return null;
  const lines = parseLines(row);
  const out = await addOnHand(db, lines, now, {
    guard: {
      sql: "EXISTS (SELECT 1 FROM square_sales WHERE order_id = ? AND state = 'applied')",
      binds: [id]
    },
    trailing: [
      db
        .prepare(
          "UPDATE square_sales SET state = 'restocked', updated_at = ? WHERE order_id = ? AND state = 'applied'"
        )
        .bind(now, id)
    ]
  });
  const flip = out.trailing[out.trailing.length - 1];
  const moved = Boolean(flip && flip.meta && Number(flip.meta.changes) > 0);
  if (!moved) return { raced: true, lines, returned: [], untracked: out.untracked };
  return { raced: false, lines, returned: out.returned, untracked: out.untracked };
}

/** The raw row, for tests and hand audits. */
export async function getSquareSale(db, orderId) {
  return db
    .prepare("SELECT * FROM square_sales WHERE order_id = ?")
    .bind(assertOrderId(orderId))
    .first();
}

/**
 * Cron housekeeping. A sale older than SALES_RETENTION_DAYS can no longer be
 * refunded through the register in any way this Worker would hear about, so
 * its row has done its work.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepSquareSales(db, olderThanDays = SALES_RETENTION_DAYS, now = Date.now()) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new TypeError("square-sync: olderThanDays must be >= 1.");
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const res = await db.prepare("DELETE FROM square_sales WHERE sold_at < ?").bind(cutoff).run();
  return (res && res.meta && res.meta.changes) || 0;
}

/* ----------------------------------------------------------- square_catalog */

/**
 * Records what the register's items resolve to. `rows` is
 * `[{variationId, sku, itemName, variationName, productId}]`; productId may
 * be null (unmapped). The push bookkeeping (last_pushed_*) on an existing
 * row is kept unless the row now maps to a DIFFERENT product, in which case
 * it is cleared so the next push writes the new product's count.
 */
export async function upsertCatalogRows(db, rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && typeof r.variationId === "string" && r.variationId.trim()
  );
  if (!list.length) return 0;
  const statements = list.map((r) =>
    db
      .prepare(
        `INSERT INTO square_catalog (variation_id, sku, item_name, variation_name, product_id, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(variation_id) DO UPDATE SET
           sku               = excluded.sku,
           item_name         = excluded.item_name,
           variation_name    = excluded.variation_name,
           last_pushed_count = CASE WHEN square_catalog.product_id IS excluded.product_id
                                    THEN square_catalog.last_pushed_count ELSE NULL END,
           last_pushed_at    = CASE WHEN square_catalog.product_id IS excluded.product_id
                                    THEN square_catalog.last_pushed_at ELSE NULL END,
           product_id        = excluded.product_id,
           resolved_at       = excluded.resolved_at`
      )
      .bind(
        r.variationId.trim().slice(0, 128),
        typeof r.sku === "string" ? r.sku.slice(0, 255) : null,
        typeof r.itemName === "string" ? r.itemName.slice(0, 255) : null,
        typeof r.variationName === "string" ? r.variationName.slice(0, 255) : null,
        typeof r.productId === "string" ? r.productId : null,
        now
      )
  );
  await db.batch(statements);
  return list.length;
}

function rowOut(row) {
  return {
    variationId: row.variation_id,
    sku: row.sku,
    itemName: row.item_name,
    variationName: row.variation_name,
    productId: row.product_id,
    lastPushedCount:
      row.last_pushed_count === null || row.last_pushed_count === undefined
        ? null
        : Number(row.last_pushed_count),
    lastPushedAt: row.last_pushed_at === null ? null : Number(row.last_pushed_at)
  };
}

/** The rows for these variation ids (absent ids are simply missing). */
export async function catalogRows(db, variationIds) {
  const ids = [...new Set((variationIds || []).filter((id) => typeof id === "string"))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += BIND_CHUNK) {
    const chunk = ids.slice(i, i + BIND_CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    const res = await db
      .prepare(`SELECT * FROM square_catalog WHERE variation_id IN (${marks})`)
      .bind(...chunk)
      .all();
    for (const row of (res && res.results) || []) out.set(row.variation_id, rowOut(row));
  }
  return out;
}

/**
 * Every mapped variation, optionally only those of the given products. This
 * is the list the push writes counts for.
 *
 * @returns {Promise<Array<ReturnType<typeof rowOut>>>}
 */
export async function mappedRows(db, productIds = null) {
  if (productIds === null || productIds === undefined) {
    const res = await db
      .prepare(
        "SELECT * FROM square_catalog WHERE product_id IS NOT NULL ORDER BY product_id, variation_id"
      )
      .all();
    return ((res && res.results) || []).map(rowOut);
  }
  const ids = [...new Set((productIds || []).filter((id) => typeof id === "string"))];
  const out = [];
  for (let i = 0; i < ids.length; i += BIND_CHUNK) {
    const chunk = ids.slice(i, i + BIND_CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    const res = await db
      .prepare(
        `SELECT * FROM square_catalog WHERE product_id IN (${marks}) ORDER BY product_id, variation_id`
      )
      .bind(...chunk)
      .all();
    for (const row of (res && res.results) || []) out.push(rowOut(row));
  }
  return out;
}

/**
 * The stamp for one listing of the register: the wall clock, unless a row in
 * the table already carries that instant or a later one, in which case one
 * millisecond past the newest. Strictly newer than every resolved_at already
 * written, always.
 *
 * unmapStale() below decides "the listing did not touch this row" by
 * resolved_at < stamp. Stamping with the bare clock made that a race: two
 * ticks in the same millisecond -- the hourly reconcile and a webhook's
 * resolve, or two ticks back to back in a test -- wrote the same resolved_at,
 * and a variation the second listing lacked looked freshly listed and stayed
 * mapped. The CI runner hit exactly that on 2026-09-10 (Node 24, QA run
 * #394) on a commit that had not touched this code. One SELECT MAX makes the
 * stamp a monotonic edge instead of a clock reading.
 */
export async function listingStamp(db, now = Date.now()) {
  const row = await db.prepare("SELECT MAX(resolved_at) AS latest FROM square_catalog").first();
  const latest = row && row.latest !== null && row.latest !== undefined ? Number(row.latest) : 0;
  const clock = Number(now);
  return Math.max(Number.isFinite(clock) ? clock : 0, Number.isFinite(latest) ? latest + 1 : 0);
}

/**
 * After a COMPLETE listing of the register's catalogue, every mapped row the
 * listing did not touch (resolved_at older than the listing's stamp) belongs
 * to a variation Square no longer has. Left mapped, it would be written to on
 * the next push and Square would refuse the whole batch -- so it is unmapped,
 * and its push memo cleared. Never called after a truncated listing, and
 * `listedAt` must be the listingStamp() the same listing was upserted with:
 * that is what makes "older than" mean "not in this listing" rather than
 * "earlier on a clock that can tie".
 *
 * @returns {Promise<number>} rows unmapped
 */
export async function unmapStale(db, listedAt) {
  const res = await db
    .prepare(
      `UPDATE square_catalog SET product_id = NULL, last_pushed_count = NULL, last_pushed_at = NULL
        WHERE product_id IS NOT NULL AND resolved_at < ?`
    )
    .bind(Number(listedAt) || 0)
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}

/** Records the count just written to Square for each variation. */
export async function markPushed(db, pushed, now = Date.now()) {
  const list = (Array.isArray(pushed) ? pushed : []).filter(
    (p) => p && typeof p.variationId === "string" && Number.isFinite(Number(p.count))
  );
  if (!list.length) return 0;
  await db.batch(
    list.map((p) =>
      db
        .prepare(
          "UPDATE square_catalog SET last_pushed_count = ?, last_pushed_at = ? WHERE variation_id = ?"
        )
        .bind(Math.floor(Number(p.count)), now, p.variationId)
    )
  );
  return list.length;
}
