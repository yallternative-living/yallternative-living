# `workers/state/` — server-side state for the shop

Six small ES modules that give the Worker the things a static site plus Stripe
cannot provide on their own: a gift-card balance that cannot be spent twice, a
webhook that runs exactly once, a points ledger the customer does not own, a
rate limiter, single-use email tokens, and a real order lookup.

Nothing here is wired into `checkout.js` yet — that is phase B. See
[`docs/STATE-LAYER.md`](../../docs/STATE-LAYER.md) for the architecture, the
free-plan budget and the wiring plan. This file is the module contract.

Run the tests with `node scripts/worker-state.test.js` (no network, no
`wrangler`; D1 and Durable Object SQLite are emulated on `node:sqlite`).

---

## Ground rules

- **Stripe stays the system of record** for orders, sessions, coupons and
  promotion codes. This layer owns only what Stripe will not hold for us:
  balances, event claims and points.
- **No Workers KV anywhere.** KV is eventually consistent and the free plan
  allows 1,000 writes a day — both disqualifying for money.
- **ES modules, zero dependencies, raw `fetch` to Stripe.** Everything takes its
  storage handle as an argument, so every function is unit-testable.
- **Every module is free-plan-shaped.** Reads are indexed, writes are counted,
  and nothing grows without a sweeper.

---

## `gift-card-ledger.js` — Durable Object, one per code

```js
import {
  GiftCardLedger,
  giftCardLedger,
  normalizeCode,
  LedgerError
} from "./state/gift-card-ledger.js";

const card = giftCardLedger(env, "YALL-GIFT50"); // handles idFromName for you

await card.issue({ code, initialCents, recipientEmail, source, stripePromoId });
await card.getBalance(); // { balanceCents, pendingCents, spentCents, ... }
await card.reserve({ sessionId, cents }); // { reservationId, reservedCents, remainingCents, expiresAt }
await card.commit({ sessionId }); // { committed, alreadyCommitted, cents }
await card.release({ sessionId, reason }); // { released, reason?, remainingCents? }
await card.restore({ chargeId, cents }); // { restored, alreadyRestored, balanceCents }
await card.history(); // { card, reservations, ledger[] }
await card.audit(); // { ok, derivedCents, storedCents }
```

- Address the object with `idFromName(normalizeCode(code))`. `giftCardLedger()`
  does this; if you call the namespace yourself, normalise first or `yall-x` and
  `YALL-X` become two different cards.
- `reserve` is the whole point: it deducts the hold immediately, so a second tab
  reserving the same card sees the reduced balance. It refuses a second
  reservation for the same session, and refuses when the balance is short.
- `commit`, `release` and `restore` are **idempotent** — safe under Stripe's
  at-least-once webhook delivery. `release` on a committed reservation is a
  no-op that reports `reason: "committed"`; it never un-charges an order.
- Reservations expire after 24h (a Stripe session's maximum life) via
  `ctx.storage.setAlarm`. `reserve` also sweeps stale holds before judging the
  balance, so a missed alarm can only ever delay a release, never lose money.
- Errors are `LedgerError` with a stable `.code` (`insufficient_balance`,
  `reservation_exists`, `already_issued`, `not_issued`, …) and an HTTP `.status`.

**Transactions.** Mutations run inside `ctx.storage.transactionSync`. Isolation
is already guaranteed — a DO runs one turn at a time and none of the private
helpers `await` — so the transaction is there for _atomicity_: a mutation writes
`card`, `reservations` and `ledger` together or not at all, and a guard that
throws rolls the partial work back. `balance_cents` additionally carries
`CHECK (balance_cents >= 0)`, so a negative balance cannot be persisted even by
raw SQL. The `ledger` table is append-only; `audit()` re-derives the balance
from it and reports drift.

**Transport.** The class exposes `fetch()` and dispatches `POST /<method>` to
the method of that name (allowlisted). It is deliberately _not_ `extends
DurableObject`, because `cloudflare:workers` cannot be imported by the Node test
harness. If phase B prefers RPC, change the class declaration and drop the
`fetch` dispatcher — the method signatures are identical.

## `webhook-events.js` — D1, exactly-once

```js
if (!(await claimEvent(db, event.id, event.type))) return ok(); // already handled
try {
  await handle(event);
  await markEventDone(db, event.id);
} catch (err) {
  await releaseEvent(db, event.id); // MUST: otherwise the retry no-ops forever
  throw err;
}
await sweepOldEvents(db, 30); // from a cron trigger, not the hot path
```

`claimEvent` returns `true` only for the first delivery (`INSERT OR IGNORE` +
`meta.changes`). **A handler that fails must `releaseEvent`**, or Stripe's
retries will all be refused and the work is lost.

## `loyalty.js` — D1, append-only points

```js
await credit(db, { email, points, orderId }); // idempotent on orderId
await balance(db, email); // number
await debit(db, { email, points, reason, refId }); // { ok, reason?, balance }
await statement(db, email, 50); // { email, balance, entries }
```

Positive rows are credits, negative rows are debits, the balance is `SUM(points)`.
`debit` does its balance check _inside_ the INSERT (`INSERT … SELECT … WHERE
(SELECT SUM(points) …) >= ?`), so two simultaneous redemptions of the whole
balance produce exactly one success — a read-then-write pair would not. It also
refuses a repeated `refId`, reported as `reason: "duplicate"` rather than
`"insufficient"`.

Never credit or debit on the strength of a request body. Credits come from a
verified Stripe webhook; debits from a magic-link-authenticated caller.

## `rate-limit.js` — two backends

```js
const { success, source } = await checkRateLimit(env, ip, { limit: 30, period: 60 });
```

- Uses `env.RATE_LIMITER` (Cloudflare's Rate Limiting binding) when present:
  free, storage-free, but enforced **per Cloudflare location** and documented as
  best-effort. Its `limit`/`period` come from `wrangler.toml`, so the ones passed
  here are ignored on that path.
- Falls back to the `RateLimitCounter` Durable Object: **exact and global**,
  because every request for a key lands on one object — at the cost of one DO
  request per check against the free plan's 100k/day.
- With neither configured it fails **open** (`source: "none"`) so a
  misconfiguration cannot take checkout offline. Pass `failOpen: false` where
  refusing is safer.

Use the binding for high-volume public reads, the DO for anything that spends
money. A limiter slows an enumeration oracle down; it does not make a guessable
code safe.

## `magic-link.js` — stateless tokens, single-use burn

```js
const { token, tokenId, expiresAt } = await signToken(env.MAGIC_LINK_SECRET, {
  email,
  purpose: "points",
  ttlSeconds: 900
});
const check = await verifyToken(env.MAGIC_LINK_SECRET, token, { purpose: "points" });
if (check.valid && (await burnToken(db, check.tokenId, check.expiresAt))) {
  /* act */
}
```

`v1.<base64url payload>.<base64url HMAC-SHA-256>`. Verification recomputes the
HMAC and compares in constant time — zero storage reads, so the hot path costs
no D1 queries. `purpose` binds a token to one endpoint. `burnToken` is the only
stateful step and returns `true` exactly once. `sweepBurnedTokens` is cron
housekeeping. The secret is a Worker Secret; rotating it invalidates every
outstanding link, which is the intended emergency behaviour.

## `stripe-orders.js` — real, sanitised order lookup

```js
const order = await lookupOrder(env, { sessionId, email });
```

One Stripe request (`expand[]=line_items&expand[]=payment_intent`). Returns
status, payment status, total, line item names and quantities, shipping
**city/state/country only**, and the three fulfilment keys
(`fulfillment_status`, `tracking_url`, `shipped_at`) from the PaymentIntent
metadata. A `tracking_url` that is not http(s) is dropped.

Knowing a session id is not authorisation — the email must match
`customer_details.email`, case-insensitively. A mismatch returns exactly the same
`{ found: false, error: "not_found" }` as a missing session, so the endpoint is
not an enumeration oracle. **Rate-limit it by IP in the caller.**

## `migrations.js` — schema at first request

```js
await ensureSchema(env.STATE_DB); // top of any handler that touches D1
```

Applies `workers/schema.sql` (transcribed into `SCHEMA_STATEMENTS`, because a
Worker cannot read files at runtime). Guarded twice: a `schema_version` row and
an isolate-level memo, so the steady state is zero queries. Every statement is
`CREATE … IF NOT EXISTS`. `scripts/worker-state.test.js` fails if `schema.sql`
and `SCHEMA_STATEMENTS` ever declare different tables or indexes.

---

## Phase B checklist

1. Export the DO classes from the entrypoint (`workers/checkout.js`):
   ```js
   export { GiftCardLedger } from "./state/gift-card-ledger.js";
   export { RateLimitCounter } from "./state/rate-limit.js";
   ```
2. Uncomment the four blocks at the foot of `workers/wrangler.toml` **in the same
   commit** — a DO binding whose class the entrypoint does not export is a hard
   deploy failure.
3. `npx wrangler d1 create yallternative-state`, paste the id, then
   `npx wrangler d1 execute yallternative-state --remote --file=workers/schema.sql`.
4. Add the `MAGIC_LINK_SECRET` secret.
5. Route the four Netlify functions through the Worker as described in
   `docs/STATE-LAYER.md`.
