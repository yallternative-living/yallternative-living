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
 * FAIL OPEN, LIKE THE LEDGER
 * Nothing here is on the money path -- a Square sale has already been paid --
 * but the callers still catch and log rather than let a mapping problem take
 * the Worker's webhook handler down: an unmapped item is an owner alert, not
 * an error.
 */

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
 * Atomically claims a Square order as counted. True for the first caller,
 * false for every later payment on the same order and every redelivery. The
 * caller deducts AFTER a true claim and calls releaseSquareSale if that
 * deduction throws, so a transient failure is retried rather than lost.
 *
 * @param {object} db D1 binding
 * @param {string} orderId Square order id
 * @param {Array<{productId: string, qty: number}>} lines what will be deducted
 * @param {string|null} locationId Square location the sale happened at
 */
export async function claimSquareSale(db, orderId, lines, locationId, now = Date.now()) {
  const id = assertOrderId(orderId);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO square_sales (order_id, state, lines_json, location_id, sold_at, updated_at)
       VALUES (?, 'applied', ?, ?, ?, ?)`
    )
    .bind(
      id,
      JSON.stringify(mergeLines(lines)),
      typeof locationId === "string" ? locationId.slice(0, 64) : null,
      now,
      now
    )
    .run();
  return (res && res.meta && res.meta.changes) === 1;
}

/** Gives a claim back after a failed deduction so the next delivery retries. */
export async function releaseSquareSale(db, orderId) {
  const res = await db
    .prepare("DELETE FROM square_sales WHERE order_id = ? AND state = 'applied'")
    .bind(assertOrderId(orderId))
    .run();
  return (res && res.meta && res.meta.changes) > 0;
}

/**
 * Moves a counted sale to `restocked` and returns the lines to put back --
 * once. A second call (a redelivered refund event, or a second refund on the
 * same order) finds no 'applied' row and returns an empty list.
 *
 * @returns {Promise<Array<{productId: string, qty: number}>>}
 */
export async function restockSquareSale(db, orderId, now = Date.now()) {
  const id = assertOrderId(orderId);
  const row = await db
    .prepare("SELECT lines_json FROM square_sales WHERE order_id = ? AND state = 'applied'")
    .bind(id)
    .first();
  if (!row) return [];
  const res = await db
    .prepare(
      "UPDATE square_sales SET state = 'restocked', updated_at = ? WHERE order_id = ? AND state = 'applied'"
    )
    .bind(now, id)
    .run();
  if (!((res && res.meta && res.meta.changes) > 0)) return [];
  try {
    return mergeLines(JSON.parse(String(row.lines_json)));
  } catch {
    return [];
  }
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
