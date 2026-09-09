/**
 * @fileoverview The inventory ledger -- the live, authoritative count behind a
 * product's `stock`, in D1.
 *
 * WHY THIS EXISTS
 * Audit finding "inventory is not authoritative and never decrements": `stock`
 * in assets/data/products.json was the only count. workers/checkout.js capped
 * quantities against it (allocateStock) but nothing wrote it back on a sale,
 * so a sell-out took effect only after a CMS save -> build -> CDN -> the
 * Worker's 300s catalog cache -- and until then the same last unit could be
 * sold to everyone who asked. This module counts DOWN, the way the gift-card
 * ledger counts a card down (workers/state/gift-card-ledger.js): reserve at
 * checkout, commit when the session is paid, release when it expires, restock
 * on a full refund.
 *
 * TWO NUMBERS, ONE OWNER
 * products.json stays the place the owner SETS a count -- the "Stock count"
 * field in the CMS. This table is what the count has become since. The rule
 * that joins them is `seed_stock`:
 *   - The first time a tracked product (a finite numeric `stock` in
 *     products.json) is seen with no row, a row is seeded: on_hand = stock,
 *     seed_stock = stock.
 *   - Whenever products.json's stock differs from the row's seed_stock, the
 *     owner has corrected the count: on_hand = new stock, seed_stock = new
 *     stock. Units held by an in-flight checkout stay held (reserved is not
 *     touched), and on_hand is never set below them, so the CHECK below holds.
 *   - Otherwise the row is left alone: a sale that took on_hand from 10 to 7
 *     is not undone by a rebuild that still says 10.
 * So editing the CMS field resets the live count, and NOT editing it leaves
 * the live count to run. The CMS hint says exactly that.
 *
 * WHY D1 AND NOT A DURABLE OBJECT
 * Two shoppers racing for the last unit is the whole problem, and D1 answers
 * it without a single-writer object: `reserved <= on_hand` is a CHECK
 * constraint, every reserve is one `db.batch` (a transaction in D1), and a
 * batch that trips the constraint is rolled back whole. Two racing batches
 * serialise at the database; the second finds no room and fails. No
 * read-check-then-write anywhere on the reserve path.
 *
 * NUMBERS
 *   on_hand   units on the shelf, INCLUDING the ones held for open sessions
 *   reserved  units held by active holds
 *   available = on_hand - reserved   (what the shop may still sell)
 *
 * HOLD STATE MACHINE (inventory_holds, one row per session and product)
 *   active    --commit-->   committed   (paid: on_hand -= qty, reserved -= qty)
 *   active    --release-->  released    (expired / failed / stale: reserved -= qty)
 *   committed --restock-->  restocked   (full refund: on_hand += qty)
 * Every transition is keyed on the current state, so a redelivered webhook
 * finds nothing in the state it wants and moves nothing. The exactly-once
 * claim in webhook-events.js is the first line; this is the second.
 *
 * FAIL OPEN
 * Nothing here may take checkout down. The callers (routes/inventory.js)
 * catch every error from this module, log it, and fall back to the static
 * `stock` in products.json -- the behaviour the shop had before this ledger
 * existed. A refusal for WANT of stock is different from a failure and is
 * thrown as InventoryError so callers can tell the two apart.
 */

/**
 * Checkout Sessions are created with `expires_at` 31 minutes out
 * (workers/checkout.js), so Stripe's `checkout.session.expired` releases an
 * unpaid hold at 31 minutes; this is the cron backstop for a lost webhook.
 * It was 25 hours against Stripe's 24-hour default, which let ONE unpaid
 * checkout hold a product's whole count for a day (red team, 2026-09-09).
 */
export const HOLD_TTL_MS = 35 * 60 * 1000;

/** Ceiling on a seeded count; anything larger is a typo, not a shelf. */
export const MAX_SEED_STOCK = 1000000;

/** seed_stock marker for a row whose product the owner stopped tracking. */
export const UNTRACKED_SEED = -1;

export const HOLD_STATES = ["active", "committed", "released", "restocked"];

/** Below D1's 100-parameter limit per statement, with room for the fixed binds. */
const BIND_CHUNK = 90;

/** A refusal the caller is expected to handle; never a bug, never a 500. */
export class InventoryError extends Error {
  constructor(code, message, productId) {
    super(message || code);
    this.name = "InventoryError";
    this.code = code;
    this.productId = productId || null;
  }
}

/** True when the catalog tracks a count for this entry (a finite numeric `stock`). */
export function isTracked(entry) {
  return Boolean(entry) && typeof entry.stock === "number" && Number.isFinite(entry.stock);
}

/**
 * `[{id, stock}]` for every tracked product in a list of catalog entries.
 * Accepts the raw `catalog.products` array or any iterable of entries with
 * `id` and `stock` (site-data.js's product index, say).
 */
export function trackedProductsOf(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.id !== "string" || !isTracked(entry)) continue;
    out.push({
      id: entry.id,
      stock: Math.min(MAX_SEED_STOCK, Math.max(0, Math.floor(entry.stock)))
    });
  }
  return out;
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 255) {
    throw new InventoryError("invalid_session", "sessionId must be a non-empty string.");
  }
  return sessionId.trim();
}

function isConstraintError(err) {
  return /constraint/i.test(String((err && err.message) || err));
}

function isUniqueError(err) {
  return /UNIQUE|PRIMARY KEY/i.test(String((err && err.message) || err));
}

/**
 * Per-isolate memo of the catalog signature last synced, so the steady state
 * (same tracked ids and counts as last time) costs no queries. A string, not
 * a per-binding map: an isolate has one STATE_DB, and the env object that
 * carries it need not be the same object from one request to the next.
 */
let syncedSignature = null;

/** Test seam: forgets the memo so the next sync writes again. */
export function resetInventoryMemo() {
  syncedSignature = null;
}

/**
 * Seeds rows for tracked products that have none and re-seeds rows whose
 * seed_stock no longer matches products.json (an owner correction). One
 * batch, one statement per tracked product; steady state (same catalog as
 * last time on this isolate) costs nothing at all.
 *
 * @param {object} db D1 binding
 * @param {Array<{id: string, stock: number}>} tracked from trackedProductsOf()
 * @returns {Promise<{changed: number, tracked: number}>} rows written
 */
export async function syncInventory(db, tracked, now = Date.now(), catalogFetchedAt = null) {
  const list = Array.isArray(tracked) ? tracked : [];
  const signature = list.map((p) => `${p.id}:${p.stock}`).join("|");
  if (syncedSignature === signature) return { changed: 0, tracked: list.length };
  /* When this catalog was fetched from the site, in the site's clock. A
     reseed records it as seed_at, and a later sync only reseeds when ITS
     catalog is newer than that: an isolate still holding the catalog from
     before an owner correction (the Worker caches products.json for 300s per
     colo) used to flip the row back to the old count and erase the sales in
     between (red team, 2026-09-09). Without a fetch time the sync stamps
     `now`, which keeps the guard strictly forward-moving. */
  const seenAt = Number.isFinite(catalogFetchedAt) ? Math.floor(catalogFetchedAt) : now;
  const statements = [];
  for (const p of list) {
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory (product_id, on_hand, reserved, seed_stock, seed_at, synced_at, updated_at)
           VALUES (?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(product_id) DO UPDATE SET
             on_hand    = MAX(excluded.on_hand, inventory.reserved),
             seed_stock = excluded.seed_stock,
             seed_at    = excluded.seed_at,
             updated_at = excluded.updated_at
           WHERE inventory.seed_stock <> excluded.seed_stock
             AND inventory.seed_at < excluded.seed_at`
        )
        .bind(p.id, p.stock, p.stock, seenAt, now, now)
    );
    statements.push(
      db.prepare(`UPDATE inventory SET synced_at = ? WHERE product_id = ?`).bind(now, p.id)
    );
  }
  /* Rows this sync did not touch belong to products the catalog no longer
     tracks. Mark them so that tracking the product again -- even at the
     very number it had before -- seeds fresh instead of silently resuming
     a count that went on changing while untracked (red team, 2026-09-09).
     seed_at goes to 0 so the guard above cannot block that reseed. */
  statements.push(
    db
      .prepare(
        `UPDATE inventory SET seed_stock = ?, seed_at = 0, updated_at = ?
         WHERE synced_at < ? AND seed_stock <> ?`
      )
      .bind(UNTRACKED_SEED, now, now, UNTRACKED_SEED)
  );
  const results = await db.batch(statements);
  // Count seeds/reseeds only (every other statement in the batch is a stamp).
  let changed = 0;
  for (let i = 0; i < list.length; i++) {
    const r = results[i * 2];
    changed += (r && r.meta && r.meta.changes) || 0;
  }
  syncedSignature = signature;
  return { changed, tracked: list.length };
}

/**
 * `Map<productId, {available, onHand, reserved}>` for the ids given. Products
 * with no row are absent from the map (the caller falls back to the catalog).
 */
export async function readAvailability(db, productIds) {
  const ids = [...new Set((productIds || []).filter((id) => typeof id === "string"))];
  const out = new Map();
  if (!ids.length) return out;
  // D1 binds at most 100 parameters per statement; read in chunks.
  for (let i = 0; i < ids.length; i += BIND_CHUNK) {
    const chunk = ids.slice(i, i + BIND_CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    const res = await db
      .prepare(`SELECT product_id, on_hand, reserved FROM inventory WHERE product_id IN (${marks})`)
      .bind(...chunk)
      .all();
    for (const row of (res && res.results) || []) {
      const onHand = Number(row.on_hand);
      const reserved = Number(row.reserved);
      out.set(row.product_id, { available: Math.max(0, onHand - reserved), onHand, reserved });
    }
  }
  return out;
}

/** `Map<productId, available>` -- the shape allocateStock consumes. */
export async function availableCounts(db, productIds) {
  const rows = await readAvailability(db, productIds);
  const out = new Map();
  for (const [id, row] of rows) out.set(id, row.available);
  return out;
}

function normalizeHolds(holds) {
  const byProduct = new Map();
  for (const hold of Array.isArray(holds) ? holds : []) {
    if (!hold || typeof hold.productId !== "string") continue;
    const qty = Math.floor(Number(hold.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    byProduct.set(hold.productId, (byProduct.get(hold.productId) || 0) + qty);
  }
  return [...byProduct].map(([productId, qty]) => ({ productId, qty }));
}

/**
 * Holds `qty` units of each product for one Checkout Session. Atomic across
 * the whole list: either every product has room and every hold is written,
 * or nothing is. Refuses (InventoryError "insufficient_stock", naming the
 * product) when another session took the last units first, and
 * ("hold_exists") when this session already holds something -- a second call
 * for the same session cannot stack a second hold.
 *
 * Products with no inventory row are skipped, not held: they are untracked
 * as far as this ledger knows, and holding them would leave a hold that no
 * count backs.
 *
 * @param {object} db D1 binding
 * @param {string} sessionId Stripe Checkout Session id
 * @param {Array<{productId: string, qty: number}>} holds
 * @returns {Promise<{reserved: boolean, holds: Array<{productId: string, qty: number}>}>}
 */
export async function reserveInventory(db, sessionId, holds, now = Date.now()) {
  const session = assertSessionId(sessionId);
  const wanted = normalizeHolds(holds);
  if (!wanted.length) return { reserved: false, holds: [] };

  const rows = await readAvailability(
    db,
    wanted.map((h) => h.productId)
  );
  const tracked = wanted.filter((h) => rows.has(h.productId));
  if (!tracked.length) return { reserved: false, holds: [] };
  // Name the product before the batch when the answer is already no: the
  // batch would refuse too, but a constraint message does not say which row.
  for (const hold of tracked) {
    if (rows.get(hold.productId).available < hold.qty) {
      throw new InventoryError(
        "insufficient_stock",
        `Not enough ${hold.productId} left.`,
        hold.productId
      );
    }
  }

  const statements = [];
  for (const hold of tracked) {
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_holds (session_id, product_id, qty, state, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`
        )
        .bind(session, hold.productId, hold.qty, now, now)
    );
    // The CHECK (reserved <= on_hand) is the real guard: a concurrent
    // session that took the room between the read above and this write makes
    // this statement fail, and D1 rolls the whole batch back.
    statements.push(
      db
        .prepare(
          "UPDATE inventory SET reserved = reserved + ?, updated_at = ? WHERE product_id = ?"
        )
        .bind(hold.qty, now, hold.productId)
    );
  }
  try {
    await db.batch(statements);
  } catch (err) {
    if (isUniqueError(err)) {
      throw new InventoryError("hold_exists", "This session already holds stock.");
    }
    if (isConstraintError(err)) {
      // Lost the race. Read again to say which product ran out.
      const after = await readAvailability(
        db,
        tracked.map((h) => h.productId)
      );
      const culprit =
        tracked.find((h) => (after.get(h.productId) || { available: 0 }).available < h.qty) ||
        tracked[0];
      throw new InventoryError(
        "insufficient_stock",
        `Not enough ${culprit.productId} left.`,
        culprit.productId
      );
    }
    throw err;
  }
  return { reserved: true, holds: tracked };
}

/**
 * Moves every hold of a session in state `from` to state `to`, applying
 * `apply` -- the SET clause for the inventory row, with `?` standing for the
 * hold's qty wherever it appears -- per product inside the same batch. The
 * inventory update is guarded by the hold still being in `from`, so two
 * deliveries of the same transition cannot both move the count.
 */
async function transitionHolds(db, sessionId, from, to, apply, now) {
  const session = assertSessionId(sessionId);
  const res = await db
    .prepare(
      "SELECT product_id, qty FROM inventory_holds WHERE session_id = ? AND state = ? ORDER BY product_id"
    )
    .bind(session, from)
    .all();
  const rows = (res && res.results) || [];
  if (!rows.length) return [];
  const statements = [];
  const qtyMarks = (apply.match(/\?/g) || []).length;
  for (const row of rows) {
    const qtyBinds = Array.from({ length: qtyMarks }, () => row.qty);
    statements.push(
      db
        .prepare(
          `UPDATE inventory SET ${apply}, updated_at = ?
            WHERE product_id = ?
              AND EXISTS (SELECT 1 FROM inventory_holds
                           WHERE session_id = ? AND product_id = ? AND state = ?)`
        )
        .bind(...qtyBinds, now, row.product_id, session, row.product_id, from)
    );
    statements.push(
      db
        .prepare(
          `UPDATE inventory_holds SET state = ?, updated_at = ?
            WHERE session_id = ? AND product_id = ? AND state = ?`
        )
        .bind(to, now, session, row.product_id, from)
    );
  }
  await db.batch(statements);
  return rows.map((row) => ({ productId: row.product_id, qty: Number(row.qty) }));
}

/**
 * The session was paid: its held units leave the shelf for good.
 * Idempotent -- a redelivered `checkout.session.completed` finds no active
 * hold and returns `alreadyCommitted`.
 *
 * @returns {Promise<{committed: Array<{productId, qty}>, alreadyCommitted: boolean,
 *   soldOut: string[]}>} `soldOut` names the products this order took to zero.
 */
export async function commitInventory(db, sessionId, now = Date.now()) {
  const committed = await transitionHolds(
    db,
    sessionId,
    "active",
    "committed",
    "on_hand = on_hand - ?, reserved = reserved - ?",
    now
  );
  if (!committed.length) {
    const prior = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM inventory_holds WHERE session_id = ? AND state = 'committed'"
      )
      .bind(assertSessionId(sessionId))
      .first();
    return { committed: [], alreadyCommitted: Number(prior && prior.n) > 0, soldOut: [] };
  }
  const after = await readAvailability(
    db,
    committed.map((h) => h.productId)
  );
  const soldOut = committed
    .map((h) => h.productId)
    .filter((id) => (after.get(id) || { available: 0 }).available <= 0);
  return { committed, alreadyCommitted: false, soldOut };
}

/**
 * The session died unpaid (expired, or its delayed payment failed): the held
 * units go back on sale. Idempotent and forgiving -- most expired sessions
 * never held anything tracked, and a committed hold is never un-sold here.
 *
 * @returns {Promise<{released: Array<{productId, qty}>}>}
 */
export async function releaseInventory(db, sessionId, now = Date.now()) {
  const released = await transitionHolds(
    db,
    sessionId,
    "active",
    "released",
    "reserved = reserved - ?",
    now
  );
  return { released };
}

/**
 * A full refund puts the order's units back on the shelf. Idempotent: only a
 * committed hold can be restocked, and it can be restocked once.
 *
 * @returns {Promise<{restocked: Array<{productId, qty}>}>}
 */
export async function restockInventory(db, sessionId, now = Date.now()) {
  const restocked = await transitionHolds(
    db,
    sessionId,
    "committed",
    "restocked",
    "on_hand = on_hand + ?",
    now
  );
  return { restocked };
}

/**
 * Cron backstop: releases active holds older than HOLD_TTL_MS. Stripe's
 * `checkout.session.expired` is the normal path; this catches a webhook that
 * never arrived, so a lost event cannot keep the last unit off the shelf
 * forever.
 *
 * @returns {Promise<number>} holds released
 */
export async function sweepStaleHolds(db, now = Date.now(), ttlMs = HOLD_TTL_MS) {
  const cutoff = now - ttlMs;
  const res = await db
    .prepare(
      "SELECT DISTINCT session_id FROM inventory_holds WHERE state = 'active' AND created_at < ?"
    )
    .bind(cutoff)
    .all();
  let released = 0;
  for (const row of (res && res.results) || []) {
    const out = await releaseInventory(db, row.session_id, now);
    released += out.released.length;
  }
  return released;
}

/** The raw rows, for tests and hand audits. */
export async function inventoryRows(db) {
  const res = await db.prepare("SELECT * FROM inventory ORDER BY product_id").all();
  return (res && res.results) || [];
}

export async function holdRows(db, sessionId) {
  const res = sessionId
    ? await db
        .prepare("SELECT * FROM inventory_holds WHERE session_id = ? ORDER BY product_id")
        .bind(assertSessionId(sessionId))
        .all()
    : await db.prepare("SELECT * FROM inventory_holds ORDER BY session_id, product_id").all();
  return (res && res.results) || [];
}

/**
 * The public answer: `{ products: { id: { available, tracked: true } } }`
 * for tracked products only. Syncs first so a product tracked since the last
 * build has a row to read.
 */
export async function inventorySnapshot(db, tracked, now = Date.now()) {
  await syncInventory(db, tracked, now);
  const rows = await readAvailability(
    db,
    tracked.map((p) => p.id)
  );
  const products = {};
  for (const p of tracked) {
    const row = rows.get(p.id);
    products[p.id] = { available: row ? row.available : p.stock, tracked: true };
  }
  return { products };
}
